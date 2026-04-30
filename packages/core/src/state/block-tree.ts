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
import { shallowRef, triggerRef, untracked, type Reactive, type ShallowRef } from './reactive'

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
   * Per-id reactive signals, lazily created by {@link signal}. Stored as
   * `ShallowRef<Block | null>` because Block is a tree of plain objects we
   * want to compare by reference, not deep-track field-by-field. The shallow
   * trigger fires whenever we replace `.value` with a new ref produced by
   * `applyOperation`'s spine rebuild.
   */
  private _signals: Map<BlockId, ShallowRef<Block | null>> = new Map()

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
  signal(id: BlockId): ShallowRef<Block | null> {
    let ref = this._signals.get(id)
    if (!ref) {
      // Reading `_blocks.value` here would otherwise track the calling effect
      // against the global blocks ref — defeating the per-id granularity (every
      // op flips `_blocks.value` and would re-trigger every signal subscriber).
      // Wrap the lookup in `untracked` so signal creation registers no deps.
      const initial = untracked(() => this.findInTree(id, this._blocks.value))
      ref = shallowRef<Block | null>(initial)
      this._signals.set(id, ref)
    }
    return ref
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
  private notifyAffected(affected: AffectedBlocks, next: Block[]): void {
    // `created` / `updated` produce a fresh Block reference for the watched
    // id (spine rebuild + new fields/slots), so a plain assignment is enough
    // to fire `ShallowRef`'s strict-equality trigger.
    for (const id of [...affected.created, ...affected.updated]) {
      const ref = this._signals.get(id)
      if (!ref) continue
      ref.value = this.findInTree(id, next)
    }

    // `moved` preserves the Block's identity (the spine just splices the same
    // ref into a new slot) — `ref.value = sameRef` would be a no-op for the
    // `ShallowRef` trigger. Force a fire via `triggerRef` so subscribers that
    // rely on position (e.g. re-reading `getParent` / `getPath`) still update.
    for (const id of affected.moved) {
      const ref = this._signals.get(id)
      if (!ref) continue
      ref.value = this.findInTree(id, next)
      triggerRef(ref)
    }

    // `removed` flips the value to null. The ref stays in `_signals` so any
    // component still holding it observes a stable `null`. If the same id
    // were ever re-introduced (rare — ids are nanoid-unique in practice),
    // the existing ref would simply be reused with the new block as its value.
    for (const id of affected.removed) {
      const ref = this._signals.get(id)
      if (ref) ref.value = null
    }
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

    if (parentId === ROOT_BLOCK_ID) {
      slotChildren = next
      nodeParentId = null
      nodeSlot = null
    } else {
      const parentBlock = this.findInTree(parentId, next)
      if (parentBlock === null) return
      slotChildren = parentBlock.slots?.[slotName] ?? []
      nodeParentId = parentId
      nodeSlot = slotName
    }

    for (let i = 0; i < slotChildren.length; i++) {
      const child = slotChildren[i]
      if (!child) continue
      this._nodes.set(child.id, {
        parentId: nodeParentId,
        slot: nodeSlot,
        index: i,
      })
      if (child.slots) {
        for (const [innerSlotName, innerChildren] of Object.entries(child.slots)) {
          this.indexBlocks(innerChildren, child.id, innerSlotName)
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

  private indexBlocks(blocks: Block[], parentId: BlockId | null, slot: string | null): void {
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
      this._nodes.set(block.id, { parentId, slot, index: i })
      if (block.slots) {
        for (const [slotName, children] of Object.entries(block.slots)) {
          this.indexBlocks(children, block.id, slotName)
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
      const slots: SlotKey[] = [op.target.slot]
      if (inverse.op === 'move' && inverse.target.slot !== op.target.slot) {
        slots.push(inverse.target.slot)
      }
      return slots
    }
    case 'replace':
      if (op.keepChildren) return []
      return Object.keys(op.block.slots ?? {}).map((s) => `${op.id}:${s}` as SlotKey)
  }
}
