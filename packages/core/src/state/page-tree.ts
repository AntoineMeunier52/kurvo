import type { Block, BlockId, SlotKey, Target, TreeOperation } from '../types'
import { BlockTree } from './block-tree'
import type { ShallowRef } from './reactive'

/**
 * Multi-PageSlot orchestrator for one editable Page. A `PageTree` holds one
 * {@link BlockTree} per PageSlot (e.g. `header`, `main`, `footer`) and
 * provides a unified API on top of them:
 *
 *  - **Global id space**: enforces that block ids are unique across every
 *    slot. The constructor validates the initial state; mutations validate
 *    each new block before delegating to the relevant slot tree.
 *  - **Cross-slot reads**: `has` / `get` / `signal` / `findSlot` find a
 *    block regardless of which slot it lives in.
 *  - **Per-slot writes**: `insert` / `reorder` take an explicit slot name;
 *    `remove` / `updateFields` / `replace` / `move` resolve the slot from
 *    the id's current location.
 *
 * Cross-slot moves (taking a block from one PageSlot to another) are NOT
 * supported as a single atomic op in V1 — `move` only handles within-slot
 * targets. Callers who need to relocate a block across slots issue an
 * explicit `remove` from the source slot followed by an `insert` into the
 * target slot, and reconcile the two inverse ops on their own (typically
 * by collapsing them into a single history entry at the editor layer).
 */
export class PageTree {
  private _slots: Map<string, BlockTree>

  constructor(initial: Record<string, Block[]> = {}) {
    this._slots = new Map()
    for (const [slotName, blocks] of Object.entries(initial)) {
      this._slots.set(slotName, new BlockTree(blocks))
    }
    this.assertGloballyUniqueIds()
  }

  // ─── Slot management ────────────────────────────────────────────────────

  /** Names of every PageSlot this document is composed of. Stable ordering. */
  slotNames(): string[] {
    return [...this._slots.keys()]
  }

  /** Direct access to a single slot's BlockTree. `null` if the slot is unknown. */
  slot(name: string): BlockTree | null {
    return this._slots.get(name) ?? null
  }

  /**
   * Slot in which the block carrying `id` currently lives, or `null` if no
   * slot contains it. O(slots × index_lookup) — fine for V1 layouts which
   * have a handful of slots.
   */
  findSlot(id: BlockId): string | null {
    for (const [name, tree] of this._slots) {
      if (tree.has(id)) return name
    }
    return null
  }

  // ─── Read (cross-slot) ───────────────────────────────────────────────────

  has(id: BlockId): boolean {
    return this.findSlot(id) !== null
  }

  get(id: BlockId): Block | null {
    for (const tree of this._slots.values()) {
      const block = tree.get(id)
      if (block !== null) return block
    }
    return null
  }

  /**
   * Reactive ref to the block carrying `id`, looked up in whichever slot
   * currently holds it. The ref delegates to the underlying slot tree's
   * `signal`, so it integrates with that tree's notification routine.
   *
   * If `id` is not present anywhere, returns a null-initialized signal from
   * the first slot (so the caller still gets a stable ref that can later
   * fire if the id is inserted into that slot).
   *
   * Caveat: per-id signals are NOT stable across cross-slot moves in V1
   * because each slot tree has its own `_signals` map. Since cross-slot
   * moves are not supported at the Document API, this caveat does not
   * affect normal V1 usage.
   */
  signal(id: BlockId): ShallowRef<Block | null> {
    for (const tree of this._slots.values()) {
      if (tree.has(id)) return tree.signal(id)
    }
    // No slot has it — fall back to the first slot's signal so the caller
    // still gets a stable ref. If the block is later inserted into that
    // slot, the ref will fire normally.
    const first = this._slots.values().next().value
    if (!first) {
      throw new Error('PageTree.signal: document has no slots')
    }
    return first.signal(id)
  }

  /** Plain-JSON snapshot of the whole document, keyed by slot name. */
  serialize(): Record<string, Block[]> {
    const out: Record<string, Block[]> = {}
    for (const [name, tree] of this._slots) {
      out[name] = tree.serialize()
    }
    return out
  }

  // ─── Mutations (return inverse op for History) ──────────────────────────

  insert(slotName: string, block: Block, target: Target): TreeOperation {
    const tree = this.requireSlot(slotName, 'insert')
    this.assertNoGlobalCollision(block, slotName)
    return tree.insert(block, target)
  }

  remove(id: BlockId): TreeOperation {
    const tree = this.requireSlotForId(id, 'remove')
    return tree.remove(id)
  }

  updateFields(
    id: BlockId,
    fields: { set?: Record<string, unknown>; unset?: readonly string[] },
  ): TreeOperation {
    const tree = this.requireSlotForId(id, 'updateFields')
    return tree.updateFields(id, fields)
  }

  replace(id: BlockId, block: Block, opts?: { keepChildren?: boolean }): TreeOperation {
    const tree = this.requireSlotForId(id, 'replace')
    // For !keepChildren, the old subtree's ids will be freed; for keepChildren
    // they stay. Either way we need to validate the new block's ids don't
    // collide with anything OUTSIDE the current slot.
    this.assertNoGlobalCollision(block, this.findSlot(id) as string, {
      excludeOldSubtreeOf: id,
      keepChildren: opts?.keepChildren ?? false,
    })
    return tree.replace(id, block, opts)
  }

  reorder(slotName: string, slot: SlotKey, from: number, to: number): TreeOperation {
    const tree = this.requireSlot(slotName, 'reorder')
    return tree.reorder(slot, from, to)
  }

  /**
   * Move within a single PageSlot. Cross-slot moves are NOT supported in
   * V1 — pass a `target.slot` that lives in the same slot tree as `id`.
   * Throws if `target.slot` would resolve to a different slot tree.
   */
  move(id: BlockId, target: Target): TreeOperation {
    const slotName = this.findSlot(id)
    if (slotName === null) {
      throw new Error(`PageTree.move: block "${id}" not found`)
    }
    const tree = this.requireSlot(slotName, 'move')
    return tree.move(id, target)
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private requireSlot(slotName: string, op: string): BlockTree {
    const tree = this._slots.get(slotName)
    if (!tree) {
      throw new Error(`PageTree.${op}: slot "${slotName}" not found`)
    }
    return tree
  }

  private requireSlotForId(id: BlockId, op: string): BlockTree {
    const slotName = this.findSlot(id)
    if (slotName === null) {
      throw new Error(`PageTree.${op}: block "${id}" not found in any slot`)
    }
    return this._slots.get(slotName) as BlockTree
  }

  /**
   * On construction, validate that the initial input has no duplicated id
   * across slots. BlockTree validates per-slot uniqueness on its own; this
   * adds the cross-slot guarantee.
   */
  private assertGloballyUniqueIds(): void {
    const seen = new Map<BlockId, string>() // id → slotName
    for (const [slotName, tree] of this._slots) {
      const ids = collectIdsFromBlocks(tree.serialize())
      for (const id of ids) {
        const previous = seen.get(id)
        if (previous !== undefined) {
          throw new Error(`PageTree: id "${id}" appears in both "${previous}" and "${slotName}"`)
        }
        seen.set(id, slotName)
      }
    }
  }

  /**
   * Validate that every id in `block`'s subtree is unused, except for ids
   * that live in the current slot (`exceptInSlot`) — since BlockTree's own
   * collision check already covers those. For `replace`, additionally allow
   * ids from the old block's subtree (to be removed by the op) when
   * `keepChildren` is false.
   */
  private assertNoGlobalCollision(
    block: Block,
    exceptInSlot: string,
    replaceCtx?: { excludeOldSubtreeOf: BlockId; keepChildren: boolean },
  ): void {
    const candidateIds = collectIdsFromBlocks([block])
    const oldSubtreeIds =
      replaceCtx && !replaceCtx.keepChildren
        ? this.collectSubtreeIds(replaceCtx.excludeOldSubtreeOf)
        : new Set<BlockId>()

    for (const [slotName, tree] of this._slots) {
      if (slotName === exceptInSlot) continue // BlockTree handles in-slot.
      for (const id of candidateIds) {
        if (oldSubtreeIds.has(id)) continue
        if (tree.has(id)) {
          throw new Error(`PageTree: id "${id}" already exists in slot "${slotName}"`)
        }
      }
    }
  }

  private collectSubtreeIds(rootId: BlockId): Set<BlockId> {
    const block = this.get(rootId)
    if (!block) return new Set()
    return collectIdsFromBlocks([block])
  }
}

/** Collect every id from a tree of blocks (subtree-walk, root included). */
const collectIdsFromBlocks = (blocks: Block[]): Set<BlockId> => {
  const out = new Set<BlockId>()
  const walk = (b: Block): void => {
    out.add(b.id)
    if (b.slots) {
      for (const children of Object.values(b.slots)) {
        for (const child of children) walk(child)
      }
    }
  }
  for (const b of blocks) walk(b)
  return out
}
