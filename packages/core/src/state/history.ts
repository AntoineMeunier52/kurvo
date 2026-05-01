import type { Block, BlockId, HistoryEntry, SlotKey, Target, TreeOperation } from '../types'
import type { BlockTree } from './block-tree'
import { shallowRef, type ShallowRef } from './reactive'

/**
 * Linear undo/redo stack on top of a {@link BlockTree}.
 *
 * Owner relationship: a `History` is constructed around an existing `BlockTree`
 * and **wraps** its mutation API. To enable undo, callers should mutate via the
 * `History` wrapper (`history.insert(...)`) rather than the bare tree
 * (`tree.insert(...)`). Direct calls to `tree.applyOp` still work but bypass
 * the history — recommended only for non-editorial paths (import, replay).
 *
 * Memory model: command-pattern. Each entry stores `{ op, inverse }` (single)
 * or `{ ops[], inverses[] }` (composite). Memory is O(N ops), not O(N blocks).
 *
 * History is intentionally NOT bundled into `BlockTree` so headless users (CI
 * scripts, server-side renders, batch imports) can mutate the tree without
 * paying for an undo stack.
 *
 * Step 1 surface: stack + undo/redo + reactive read API + maxEntries eviction.
 * Coalescing (`updateFields` debounce) and `transact()` will land in step 2/3.
 */
export class History {
  private readonly tree: BlockTree
  private readonly maxEntries: number

  /** The actual stack — entries[0..cursorIdx] are reachable via undo. */
  private entries: HistoryEntry[] = []
  /**
   * Number of entries on the "undo side". `cursorIdx === entries.length` means
   * the cursor sits at the top of the stack (nothing to redo). `cursorIdx <
   * entries.length` means undo has been called and a redo branch is alive.
   */
  private cursorIdx = 0

  // Reactive surface — `ShallowRef` for primitives is enough; consumers do
  // `history.canUndo.value` directly. All four are kept in sync by `notify()`.
  private readonly _canUndo = shallowRef(false)
  private readonly _canRedo = shallowRef(false)
  private readonly _size = shallowRef(0)
  private readonly _cursor = shallowRef(0)

  constructor(tree: BlockTree, opts?: { maxEntries?: number; debounceMs?: number }) {
    this.tree = tree
    this.maxEntries = opts?.maxEntries ?? 50
    void opts?.debounceMs // wired in step 2 (coalescing)
  }

  // ─── Reactive read surface ──────────────────────────────────────────────

  get canUndo(): ShallowRef<boolean> {
    return this._canUndo
  }

  get canRedo(): ShallowRef<boolean> {
    return this._canRedo
  }

  get size(): ShallowRef<number> {
    return this._size
  }

  get cursor(): ShallowRef<number> {
    return this._cursor
  }

  // ─── Mutations (wrappers, symmetrical with BlockTree) ───────────────────

  insert(block: Block, target: Target): TreeOperation {
    return this.applyInternal({ op: 'insert', block, target })
  }

  remove(id: BlockId): TreeOperation {
    return this.applyInternal({ op: 'remove', id })
  }

  move(id: BlockId, target: Target): TreeOperation {
    return this.applyInternal({ op: 'move', id, target })
  }

  reorder(slot: SlotKey, from: number, to: number): TreeOperation {
    return this.applyInternal({ op: 'reorder', slot, from, to })
  }

  replace(id: BlockId, block: Block, opts?: { keepChildren?: boolean }): TreeOperation {
    return this.applyInternal({
      op: 'replace',
      id,
      block,
      keepChildren: opts?.keepChildren,
    })
  }

  updateFields(
    id: BlockId,
    fields: { set?: Record<string, unknown>; unset?: readonly string[] },
  ): TreeOperation {
    return this.applyInternal({
      op: 'updateFields',
      id,
      set: fields.set,
      unset: fields.unset,
    })
  }

  // ─── Navigation ─────────────────────────────────────────────────────────

  undo(): HistoryEntry | null {
    if (this.cursorIdx === 0) return null
    const entry = this.entries[this.cursorIdx - 1]
    if (entry === undefined) return null
    this.applyEntryInverse(entry)
    this.cursorIdx -= 1
    this.notify()
    return entry
  }

  redo(): HistoryEntry | null {
    if (this.cursorIdx >= this.entries.length) return null
    const entry = this.entries[this.cursorIdx]
    if (entry === undefined) return null
    this.applyEntryForward(entry)
    this.cursorIdx += 1
    this.notify()
    return entry
  }

  // ─── Inspection / control ───────────────────────────────────────────────

  /**
   * Closest entries on either side of the cursor. Useful for previews
   * ("Undo: rename block X") and devtools.
   */
  peek(): { undo: HistoryEntry | null; redo: HistoryEntry | null } {
    return {
      undo: this.cursorIdx > 0 ? (this.entries[this.cursorIdx - 1] ?? null) : null,
      redo: this.cursorIdx < this.entries.length ? (this.entries[this.cursorIdx] ?? null) : null,
    }
  }

  /** Drop every entry. Does NOT touch the tree. */
  clear(): void {
    this.entries = []
    this.cursorIdx = 0
    this.notify()
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Apply an op to the tree, push the resulting entry, truncate any redo
   * branch beyond the cursor, evict the oldest entry if `maxEntries` is hit,
   * and notify reactive subscribers — exactly once.
   */
  private applyInternal(op: TreeOperation): TreeOperation {
    const inverse = this.tree.applyOp(op)
    this.pushEntry({
      kind: 'single',
      op,
      inverse,
      timestamp: Date.now(),
    })
    return inverse
  }

  /**
   * Insert `entry` at the cursor, dropping any redo branch beyond it, and
   * apply maxEntries eviction. Mutates `entries` and `cursorIdx`, then
   * `notify()`s once.
   */
  private pushEntry(entry: HistoryEntry): void {
    // Truncate any pending redo branch — a new commit overwrites it.
    if (this.cursorIdx < this.entries.length) {
      this.entries.length = this.cursorIdx
    }
    this.entries.push(entry)
    this.cursorIdx = this.entries.length

    // Evict from the front if we exceed the cap. Cursor follows.
    while (this.entries.length > this.maxEntries) {
      this.entries.shift()
      this.cursorIdx -= 1
    }

    this.notify()
  }

  /** Replay an entry's inverse(s) to roll the tree back. */
  private applyEntryInverse(entry: HistoryEntry): void {
    if (entry.kind === 'single') {
      this.tree.applyOp(entry.inverse)
      return
    }
    // Composite: inverses are already stored last-op-first.
    for (const inv of entry.inverses) {
      this.tree.applyOp(inv)
    }
  }

  /** Replay an entry's op(s) to roll the tree forward. */
  private applyEntryForward(entry: HistoryEntry): void {
    if (entry.kind === 'single') {
      this.tree.applyOp(entry.op)
      return
    }
    for (const op of entry.ops) {
      this.tree.applyOp(op)
    }
  }

  /**
   * Push the four reactive primitives to match the current state in one go.
   * Called by every mutation point — and only after `entries`/`cursorIdx` are
   * already in their final state — so a Vue effect that reads multiple of
   * these refs sees a coherent snapshot.
   */
  private notify(): void {
    this._size.value = this.entries.length
    this._cursor.value = this.cursorIdx
    this._canUndo.value = this.cursorIdx > 0
    this._canRedo.value = this.cursorIdx < this.entries.length
  }
}
