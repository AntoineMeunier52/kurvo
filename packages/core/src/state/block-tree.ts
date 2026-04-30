import type {
  AffectedBlocks,
  Block,
  BlockId,
  Locator,
  SlotKey,
  Target,
  TreeOperation,
} from '../types'
import { ROOT_BLOCK_ID, ROOT_SLOT_KEY } from '../types'
import type { BlockNode } from '../types/block-node'
import { applyOperation } from './apply-operation'
import { customRef, shallowRef, untracked, type Reactive, type Ref } from './reactive'

/**
 * Reactive wrapper around an immutable block tree, with a manually-maintained
 * `Map<BlockId, BlockNode>` index (parent pointers + position) for O(1) lookups
 * of "is this id present" and O(depth) reads of the live block via chain walk.
 *
 * Pure orchestrator: delegates to {@link applyOperation} for the algebra,
 * incrementally patches the index using the {@link AffectedBlocks} returned
 * by `applyOperation`, and validates id uniqueness on insert/replace (which
 * `applyOperation` does not enforce).
 *
 * Reads (`get` / `getParent`) walk `_blocks` from root through the recorded
 * parent chain — no per-node `Block` cache is kept. This guarantees reads are
 * always coherent with the canonical tree, even when a mutation rebuilds the
 * spine and produces fresh refs for several ancestors.
 *
 * History is intentionally NOT owned by this class — see Phase M4 for the
 * `History` companion. Each mutation method returns the inverse op so the
 * caller (or History) can stack it.
 */
export class BlockTree {
  private _blocks = shallowRef<Block[]>([])
  private _nodes: Map<BlockId, BlockNode> = new Map()
  /**
   * Per-id reactive signals, lazily created by {@link signal}. The value of
   * each signal is computed on read (via {@link findInTree}) so it is always
   * coherent with `_blocks.value` — even for ancestors of a leaf that was
   * just updated (whose Block ref changed via spine rebuild but whose own
   * signal would otherwise stay stale). Triggers are fired explicitly by
   * {@link notifyAffected}; we don't rely on value-equality comparison.
   */
  private _signals: Map<BlockId, Ref<Block | null>> = new Map()
  /** Trigger callbacks paired with the customRefs above, keyed by the same id. */
  private _signalTriggers: Map<BlockId, () => void> = new Map()

  constructor(initial: Block[] = []) {
    this._blocks.value = structuredClone(initial)
    this.rebuildIndex()
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /**
   * Live, reactive view of the canonical tree. Typed `readonly` so callers
   * cannot mutate it in place (`push`, `splice`, …) — those would bypass the
   * reactive `shallowRef` trigger and the index patch routine, leaving the
   * tree and the index out of sync. Mutate via {@link applyOp} (or the
   * dedicated `insert` / `move` / etc. methods).
   */
  get blocks(): Reactive<readonly Block[]> {
    return this._blocks.value
  }

  get size(): number {
    void this._blocks.value
    return this._nodes.size
  }

  get(id: BlockId): Block | null {
    return this.findInTree(id, this._blocks.value)
  }

  has(id: BlockId): boolean {
    void this._blocks.value
    return this._nodes.has(id)
  }

  getParent(id: BlockId): Block | null {
    const node = this._nodes.get(id)
    if (!node || node.parentId === null) return null
    return this.findInTree(node.parentId, this._blocks.value)
  }

  /**
   * Stable reactive ref to the block carrying `id`. The returned ref's
   * `.value` tracks the live block and is updated only when `id` is touched
   * by a mutation:
   *   - block becomes part of the tree (`affected.created`) → `value` swaps
   *     from `null` (or absent) to the new block ref;
   *   - content changes (`affected.updated`) → `value` swaps to the fresh
   *     block ref produced by the spine rebuild;
   *   - position changes (`affected.moved`) → `value` swaps to the new ref;
   *   - block leaves the tree (`affected.removed`) → `value` becomes `null`.
   *
   * Same `id` always returns the same ref instance (memoized) so a Vue
   * component can keep a stable reference across renders.
   *
   * Use this for fine-grained editor reactivity: typing in one block's
   * fields fires only the signals of blocks listed in `affected`, leaving
   * the other 999-of-1000 components in a large page untouched.
   */
  signal(id: BlockId): Ref<Block | null> {
    let ref = this._signals.get(id)
    if (!ref) {
      // `customRef` decouples value freshness from trigger semantics:
      //  - `.get()` walks the live tree on every read → ancestors of a
      //    just-updated descendant (whose Block ref changed via spine
      //    rebuild) surface the new content, never a stale cached ref.
      //  - `.track()` registers the calling effect against this signal only,
      //    so consumers don't accidentally re-render on unrelated mutations.
      //  - `notifyAffected` calls the captured `trigger` exactly for ids in
      //    `affected.{created, updated, moved, removed}` — that's where
      //    fine-grained re-rendering is decided.
      // The inner `findInTree` is wrapped in `untracked` so reading
      // `_blocks.value` does NOT register a dep on the global ref (otherwise
      // every op would re-trigger every signal subscriber).
      ref = customRef<Block | null>((track, trigger) => {
        this._signalTriggers.set(id, trigger)
        return {
          get: () => {
            track()
            return untracked(() => this.findInTree(id, this._blocks.value))
          },
          set: () => {
            throw new Error(
              `BlockTree.signal: refs returned by signal() are read-only (id="${id}")`,
            )
          },
        }
      })
      this._signals.set(id, ref)
    }
    return ref
  }

  /**
   * Nesting depth of `id`, measured from the page root. `0` for blocks
   * sitting directly at the root, `parent.depth + 1` for nested ones.
   * `null` if the id is not in the tree.
   *
   * Maintained by every mutation (cached on `BlockNode.depth`) so this is
   * O(1) — no parent-chain walk.
   */
  depth(id: BlockId): number | null {
    void this._blocks.value
    const node = this._nodes.get(id)
    return node?.depth ?? null
  }

  /**
   * Slot path from the document root down to `id`, e.g.
   * `['root:default', 'p:cta', 'a:inner']` for a block nested two levels deep.
   *
   * Returns `[]` for unknown ids — `[]` is reserved for "id not in the tree",
   * because a real path always includes at least `[ROOT_SLOT_KEY]`. Use
   * {@link has} to disambiguate if needed; in practice, the empty path falls
   * through naturally in iteration-style code.
   */
  getPath(id: BlockId): SlotKey[] {
    void this._blocks.value
    if (!this._nodes.has(id)) return []

    const path: SlotKey[] = []
    let current = this._nodes.get(id)
    while (current) {
      if (current.parentId === null) {
        path.unshift(ROOT_SLOT_KEY)
        break
      }
      path.unshift(`${current.parentId}:${current.slot}` as SlotKey)
      current = this._nodes.get(current.parentId)
    }
    return path
  }

  // ─── Mutation (returns inverse op for History) ───────────────────────────

  insert(block: Block, target: Target): TreeOperation {
    return this.applyOp({ op: 'insert', block, target })
  }

  move(id: BlockId, target: Target): TreeOperation {
    return this.applyOp({ op: 'move', id, target })
  }

  remove(id: BlockId): TreeOperation {
    return this.applyOp({ op: 'remove', id })
  }

  replace(id: BlockId, block: Block, opts?: { keepChildren?: boolean }): TreeOperation {
    return this.applyOp({
      op: 'replace',
      id,
      block,
      keepChildren: opts?.keepChildren,
    })
  }

  reorder(slot: SlotKey, from: number, to: number): TreeOperation {
    return this.applyOp({ op: 'reorder', slot, from, to })
  }

  updateFields(
    id: BlockId,
    fields: { set?: Record<string, unknown>; unset?: readonly string[] },
  ): TreeOperation {
    return this.applyOp({
      op: 'updateFields',
      id,
      set: fields.set,
      unset: fields.unset,
    })
  }

  /**
   * Generic op application — useful to replay ops from history (undo/redo).
   *
   * Validates id uniqueness for `insert` and `replace` before delegating to
   * `applyOperation` (which assumes the caller has already enforced this).
   */
  applyOp(op: TreeOperation): TreeOperation {
    if (op.op === 'insert') {
      this.assertNoCollision(op.block)
    } else if (op.op === 'replace' && !op.keepChildren) {
      const oldBlock = this.findInTree(op.id, this._blocks.value)
      const exclude = oldBlock ? collectIds(oldBlock) : undefined
      this.assertNoCollision(op.block, exclude)
    }

    // Pass a locator built from the live index so applyOperation uses the
    // O(depth) spine-rebuild path instead of a recursive O(N) walk.
    const { blocks: next, inverse, affected } = applyOperation(this._blocks.value, op, this.locator)
    // True no-op fast path: `applyOperation` returned the same blocks array
    // (e.g. `reorder` with `from === to`). Skip the index patch, the global
    // trigger, and per-id signal triggers. The inverse op is still returned
    // for history symmetry — callers may choose to drop it.
    if (next === this._blocks.value) {
      return inverse
    }
    // Patch the index BEFORE flipping the reactive ref so that any effect
    // re-running synchronously on the trigger sees a coherent (tree, index) pair.
    this.applyAffectedToIndex(op, inverse, next, affected)
    this._blocks.value = next
    // Per-id signals fire LAST so subscribers that read `tree.blocks` /
    // `tree.get(id)` from inside their effect see fully-updated state.
    this.notifyAffected(affected, next)
    return inverse
  }

  /**
   * Stable locator function bound to this instance's index.
   *
   * Non-serializable: this is a closure over `_nodes`. Use {@link serialize} to
   * snapshot the tree as plain JSON.
   */
  private readonly locator: Locator = (id) => {
    const node = this._nodes.get(id)
    if (!node) return null
    return { parentId: node.parentId, slot: node.slot, index: node.index }
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────

  serialize(): Block[] {
    return structuredClone(this._blocks.value)
  }

  // ─── private ─────────────────────────────────────────────────────────────

  /**
   * Incrementally patch the index in response to a single op, using the
   * `affected` set computed by {@link applyOperation}.
   *
   * Strategy:
   *  1. Drop entries for any id in `affected.removed` (subtree no longer in tree).
   *  2. Re-walk dirty slots (slots whose child array reference changed in `next`).
   *     This single pass handles `created` (newly indexed entries), `moved`
   *     (parent/slot/index updated for the moved id) and sibling index shifts
   *     induced by insert/remove/move/reorder. Pre-existing entries inside the
   *     dirty subtree are simply re-set to identical values — wasteful but
   *     correct, and bounded by the dirty subtree size, not the whole tree.
   *
   * `affected.updated` is intentionally **not** consumed here: the index stores
   * positions only, not block refs, so a content-only change has no effect on
   * `_nodes`.
   */
  /**
   * Refresh per-id reactive signals after an op. Drives fine-grained editor
   * re-renders: a Vue effect that reads `tree.signal(id).value` re-runs only
   * when `id` is touched by `affected.{created, updated, moved, removed}`.
   *
   * Ordering note: this runs AFTER `_blocks.value = next` (the global trigger)
   * so any effect that reads both the global blocks list and the per-id ref
   * sees consistent state.
   */
  private notifyAffected(affected: AffectedBlocks, _next: Block[]): void {
    // Fire each touched id's trigger exactly once. The customRef's `.get()`
    // walks the live tree on read, so we don't have to swap a cached value —
    // we only have to invalidate the dep so consumer effects re-run.
    // Set-dedup so an id appearing in two categories (defensive — current
    // ops keep them mutually exclusive) doesn't trigger twice.
    const fired = new Set<BlockId>()
    const fire = (id: BlockId): void => {
      if (fired.has(id)) return
      fired.add(id)
      const trigger = this._signalTriggers.get(id)
      if (trigger) trigger()
    }
    for (const id of affected.created) fire(id)
    for (const id of affected.updated) fire(id)
    for (const id of affected.moved) fire(id)
    for (const id of affected.removed) fire(id)
  }

  private applyAffectedToIndex(
    op: TreeOperation,
    inverse: TreeOperation,
    next: Block[],
    _affected: AffectedBlocks,
  ): void {
    for (const id of _affected.removed) {
      this._nodes.delete(id)
    }

    for (const slotKey of computeDirtySlots(op, inverse)) {
      this.reindexSlot(slotKey, next)
    }
  }

  /**
   * Re-walk a single slot in `next` and update entries for every block found
   * inside it (including descendants). Used by {@link applyAffectedToIndex}
   * after an op that changed the slot's child array.
   */
  private reindexSlot(slotKey: SlotKey, next: Block[]): void {
    const parsed = parseSlotKey(slotKey)
    if (parsed === null) return
    const { blockId: parentId, slotName } = parsed

    let slotChildren: Block[]
    let nodeParentId: BlockId | null
    let nodeSlot: string | null
    let depth: number

    if (parentId === ROOT_BLOCK_ID) {
      slotChildren = next
      nodeParentId = null
      nodeSlot = null
      depth = 0
    } else {
      const parentBlock = this.findInTree(parentId, next)
      if (parentBlock === null) return
      const parentNode = this._nodes.get(parentId)
      if (parentNode === undefined) return
      slotChildren = parentBlock.slots?.[slotName] ?? []
      nodeParentId = parentId
      nodeSlot = slotName
      depth = parentNode.depth + 1
    }

    for (let i = 0; i < slotChildren.length; i++) {
      const child = slotChildren[i]
      if (!child) continue
      this._nodes.set(child.id, {
        parentId: nodeParentId,
        slot: nodeSlot,
        index: i,
        depth,
      })
      if (child.slots) {
        for (const [innerSlotName, innerChildren] of Object.entries(child.slots)) {
          this.indexBlocks(innerChildren, child.id, innerSlotName, depth + 1)
        }
      }
    }
  }

  /**
   * Resolve `id` to its current Block by descending from the root of `tree`
   * through the parent chain stored in `_nodes`.
   *
   * Returns `null` if `id` is not in the index — this is the legitimate
   * "not present" case. Throws if `id` IS in the index but the chain does
   * not match `tree`: that means the index has drifted from the canonical
   * tree, which is a programmer error in `BlockTree`'s patch routine and
   * cannot be silently masked (a stale read here would propagate through
   * `tree.get` / `tree.getParent` and produce subtle bugs downstream).
   */
  private findInTree(id: BlockId, tree: Block[]): Block | null {
    if (!this._nodes.has(id)) return null

    const drift = (reason: string): never => {
      throw new Error(`BlockTree.findInTree: index drift on "${id}" (${reason})`)
    }

    const chain: { slot: string | null; index: number }[] = []
    let currentId: BlockId | null = id
    while (currentId !== null) {
      const n = this._nodes.get(currentId)
      if (!n) drift(`missing chain entry "${currentId}"`)
      // After `drift` throws, TS still wants the narrowing — guard explicitly.
      if (!n) return null
      chain.push({ slot: n.slot, index: n.index })
      currentId = n.parentId
    }
    chain.reverse()

    let currentArray: Block[] = tree
    let result: Block | null = null
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]
      if (!entry) drift(`empty chain at depth ${i}`)
      if (!entry) return null
      const block = currentArray[entry.index]
      if (!block) drift(`no block at index ${entry.index} (depth ${i})`)
      if (!block) return null
      result = block
      const childEntry = chain[i + 1]
      if (childEntry === undefined) break
      if (childEntry.slot === null) drift(`null slot at depth ${i + 1}`)
      if (childEntry.slot === null) return null
      const innerSlot = block.slots?.[childEntry.slot]
      if (innerSlot === undefined) drift(`missing slot "${childEntry.slot}" on "${block.id}"`)
      if (innerSlot === undefined) return null
      currentArray = innerSlot
    }
    return result
  }

  private rebuildIndex(blocks: Block[] = this._blocks.value): void {
    this._nodes.clear()
    this.indexBlocks(blocks, null, null)
  }

  private indexBlocks(
    blocks: Block[],
    parentId: BlockId | null,
    slot: string | null,
    depth = 0,
  ): void {
    // Invariant: a block lives at the document root (parentId === null) iff it has no slot
    // (slot === null). The spine helpers in applyOperation rely on this invariant to
    // reconstruct SlotKeys from LocatorInfo without an extra branch.
    if ((parentId === null) !== (slot === null)) {
      throw new Error(
        'BlockTree.indexBlocks: invariant violated — parentId and slot must be both null or both non-null',
      )
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!block) continue
      this._nodes.set(block.id, { parentId, slot, index: i, depth })
      if (block.slots) {
        for (const [slotName, children] of Object.entries(block.slots)) {
          this.indexBlocks(children, block.id, slotName, depth + 1)
        }
      }
    }
  }

  /**
   * Assert that none of the ids carried by `block` (and its subtree) collide with
   * an existing id in the tree, except for ids in the optional `exclude` set
   * (used for `replace` to whitelist the old block's subtree which is being removed).
   */
  private assertNoCollision(block: Block, exclude?: Set<BlockId>): void {
    const ids = collectIds(block)
    for (const id of ids) {
      if (this._nodes.has(id) && (exclude === undefined || !exclude.has(id))) {
        throw new Error(`BlockTree: id "${id}" already exists in the tree`)
      }
    }
  }
}

/** Collect all block ids in a subtree (root included). Local helper. */
const collectIds = (block: Block): Set<BlockId> => {
  const ids = new Set<BlockId>()
  const walk = (b: Block): void => {
    ids.add(b.id)
    if (b.slots) {
      for (const children of Object.values(b.slots)) {
        for (const child of children) walk(child)
      }
    }
  }
  walk(block)
  return ids
}

/**
 * Split a `SlotKey` into `{ blockId, slotName }`. `blockId` is either a
 * concrete `BlockId` or `ROOT_BLOCK_ID` (the pseudo-block representing the
 * document root). Returns `null` for malformed keys (defensive — should not
 * happen with values produced by the type system).
 */
const parseSlotKey = (
  slotKey: SlotKey,
): { blockId: BlockId | typeof ROOT_BLOCK_ID; slotName: string } | null => {
  const colon = slotKey.indexOf(':')
  if (colon === -1) return null
  return { blockId: slotKey.substring(0, colon), slotName: slotKey.substring(colon + 1) }
}

/**
 * Slots whose child array reference is different in `next` vs the previous tree.
 * Re-walking these (and these only) is enough to bring the index in sync.
 *
 * - `updateFields` / `replace keepChildren` — no slot array changed.
 * - `insert` — the target slot got a new array.
 * - `remove` — the parent slot of the removed block got a new array. We read
 *   its SlotKey from the inverse op (which is an `insert` carrying the original
 *   target slot).
 * - `reorder` — the reordered slot got a new array.
 * - `move` — both source slot (from the inverse) and target slot got new
 *   arrays. Deduped if equal (intra-slot move).
 * - `replace !keepChildren` — every slot of the new block carries new children.
 */
const computeDirtySlots = (op: TreeOperation, inverse: TreeOperation): SlotKey[] => {
  switch (op.op) {
    case 'updateFields':
      return []
    case 'insert':
      return [op.target.slot]
    case 'remove':
      return inverse.op === 'insert' ? [inverse.target.slot] : []
    case 'reorder':
      return [op.slot]
    case 'move': {
      // Source FIRST, then target. Removing the source shifts the indices of
      // its later siblings in the source slot. If the target's ancestor chain
      // passes through one of those shifted siblings, reindexing the target
      // slot first would have `findInTree` walk via still-stale indices and
      // throw "index drift". Reindexing the source slot first refreshes those
      // indices in `_nodes`, so the target-side walk sees fresh positions.
      const sourceSlot = inverse.op === 'move' ? inverse.target.slot : undefined
      if (sourceSlot !== undefined && sourceSlot !== op.target.slot) {
        return [sourceSlot, op.target.slot]
      }
      return [op.target.slot]
    }
    case 'replace':
      if (op.keepChildren) return []
      return Object.keys(op.block.slots ?? {}).map((s) => `${op.id}:${s}` as SlotKey)
  }
}
