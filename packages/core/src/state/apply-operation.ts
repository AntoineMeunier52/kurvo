import type {
  AffectedBlocks,
  ApplyResult,
  Block,
  BlockId,
  Locator,
  SlotKey,
  Target,
  TreeOperation,
} from '../types'
import { ROOT_BLOCK_ID, ROOT_SLOT_KEY, ROOT_SLOT_NAME } from '../types'
import type { RootBlockId } from '../types'

/**
 * Apply a {@link TreeOperation} to a tree of blocks immutably.
 *
 * Pure function: no mutation of the input, returns a fresh tree plus the inverse operation
 * (used to seed history entries) and the set of {@link AffectedBlocks} (used by callers
 * to perform incremental reindexing and targeted reactive notifications).
 *
 * If a {@link Locator} is provided, ops that locate a block by id use the **spine-rebuild**
 * path (O(depth)) instead of recursive tree walks (O(N)). Without a locator, behavior is
 * identical to a pure walk-based implementation. A locator that returns `null` for an id
 * causes a "block not found" throw — the function does NOT fall back to a walk.
 *
 * @remarks
 * Block id uniqueness across the tree is the **caller's responsibility** (typically `BlockTree`).
 * `applyOperation` does not validate that an inserted/replaced block has a unique id; passing
 * a duplicate will silently corrupt the tree.
 *
 * @throws if the operation is malformed (block id not found, slot inexistant, cycle, etc.).
 */
export const applyOperation = (
  blocks: Block[],
  op: TreeOperation,
  locator?: Locator,
): ApplyResult => {
  switch (op.op) {
    case 'updateFields':
      return applyUpdateFields(blocks, op, locator)
    case 'reorder':
      return applyReorder(blocks, op, locator)
    case 'replace':
      return applyReplace(blocks, op, locator)
    case 'insert':
      return applyInsert(blocks, op, locator)
    case 'remove':
      return applyRemove(blocks, op, locator)
    case 'move':
      return applyMove(blocks, op, locator)
  }
}

// ─── Affected helpers ─────────────────────────────────────────────────────

const emptyAffected = (): AffectedBlocks => ({
  created: [],
  removed: [],
  updated: [],
  moved: [],
})

/**
 * Collect every block id in a subtree (root included), in pre-order.
 * Used to build `created`/`removed` lists for ops that touch entire subtrees
 * (`insert`, `remove`, `replace !keepChildren`).
 */
const collectIds = (block: Block): BlockId[] => {
  const ids: BlockId[] = []
  const walk = (b: Block): void => {
    ids.push(b.id)
    if (b.slots) {
      for (const children of Object.values(b.slots)) {
        for (const child of children) walk(child)
      }
    }
  }
  walk(block)
  return ids
}

// ─── Op handlers ──────────────────────────────────────────────────────────

const applyUpdateFields = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'updateFields' }>,
  locator?: Locator,
): ApplyResult => {
  const set = op.set ?? {}
  // `undefined` values in `set` would be lost across JSON serialization and break the
  // inverse symmetry. Reject explicitly: callers must use `unset` to remove keys.
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined) {
      throw new Error(
        `applyOperation/updateFields: set["${key}"] is undefined; use \`unset\` to remove keys`,
      )
    }
  }
  // Dedupe: if a key appears in both, `set` wins. Strip those keys from `unset`
  // upfront so the loops below cannot interact through coincidental ordering.
  const unset = (op.unset ?? []).filter((k) => !Object.hasOwn(set, k))

  const updater = (block: Block): Block => {
    const newFields: Record<string, unknown> = { ...block.fields }
    for (const key of unset) {
      Reflect.deleteProperty(newFields, key)
    }
    for (const [key, value] of Object.entries(set)) {
      newFields[key] = value
    }
    return { ...block, fields: newFields }
  }

  const { blocks: next, oldBlock } = locator
    ? mapBlockSpine(blocks, op.id, updater, locator)
    : mapBlock(blocks, op.id, updater)

  if (oldBlock === null) {
    throw new Error(`applyOperation/updateFields: block "${op.id}" not found`)
  }

  // Build the inverse: for each touched key, either restore its old value (set)
  // or remove it (unset). `Object.hasOwn` ignores inherited prototype keys.
  // After dedupe, `set` and `unset` keys are disjoint, so each key is handled exactly once.
  const inverseSet: Record<string, unknown> = {}
  const inverseUnset: string[] = []

  for (const key of Object.keys(set)) {
    if (Object.hasOwn(oldBlock.fields, key)) {
      inverseSet[key] = oldBlock.fields[key]
    } else {
      inverseUnset.push(key)
    }
  }
  for (const key of unset) {
    if (Object.hasOwn(oldBlock.fields, key)) {
      inverseSet[key] = oldBlock.fields[key]
    }
    // Key didn't exist before → unset was a no-op, nothing to undo.
  }

  return {
    blocks: next,
    inverse: { op: 'updateFields', id: op.id, set: inverseSet, unset: inverseUnset },
    affected: { ...emptyAffected(), updated: [op.id] },
  }
}

const applyReorder = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'reorder' }>,
  locator?: Locator,
): ApplyResult => {
  const { from, to, slot } = op
  const inverse: TreeOperation = { op: 'reorder', slot, from: to, to: from }

  const checkBounds = (arr: Block[], idx: number, label: string): void => {
    if (idx < 0 || idx >= arr.length) {
      throw new Error(
        `applyOperation/reorder: ${label}=${idx} out of bounds (slot "${slot}", length ${arr.length})`,
      )
    }
  }

  // Move-style: splice out at `from`, splice in at `to`.
  const reorderArray = (arr: Block[]): Block[] => {
    checkBounds(arr, from, 'from')
    checkBounds(arr, to, 'to')
    const next = arr.slice()
    const removed = next.splice(from, 1)
    next.splice(to, 0, ...removed)
    return next
  }

  // Every id in [min(from,to), max(from,to)] sees its index change → all "moved".
  const collectMoved = (arr: Block[]): BlockId[] => {
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const moved: BlockId[] = []
    for (let i = lo; i <= hi; i++) {
      const b = arr[i]
      if (b) moved.push(b.id)
    }
    return moved
  }

  const { blockId, slotName } = resolveSlotKey(slot)

  // Root slot: splice the root array directly. No locator needed.
  if (blockId === ROOT_BLOCK_ID) {
    if (slotName !== ROOT_SLOT_NAME) {
      throw new Error(
        `applyOperation/reorder: invalid root slot "${slotName}" (expected "${ROOT_SLOT_NAME}")`,
      )
    }
    checkBounds(blocks, from, 'from')
    checkBounds(blocks, to, 'to')
    if (from === to) return { blocks, inverse, affected: emptyAffected() }
    return {
      blocks: reorderArray(blocks),
      inverse,
      // No parent at root → nothing to mark `updated`.
      affected: { ...emptyAffected(), moved: collectMoved(blocks) },
    }
  }

  // Nested slot: navigate to the parent block, transform its slot.
  const updater = (block: Block): Block => {
    const children = block.slots?.[slotName]
    if (!children) {
      throw new Error(`applyOperation/reorder: slot "${slot}" not found on block "${blockId}"`)
    }
    checkBounds(children, from, 'from')
    checkBounds(children, to, 'to')
    if (from === to) return block
    return {
      ...block,
      slots: { ...block.slots, [slotName]: reorderArray(children) },
    }
  }

  const { blocks: next, oldBlock } = locator
    ? mapBlockSpine(blocks, blockId, updater, locator)
    : mapBlock(blocks, blockId, updater)

  if (oldBlock === null) {
    throw new Error(`applyOperation/reorder: block "${blockId}" not found`)
  }

  if (from === to) {
    return { blocks: next, inverse, affected: emptyAffected() }
  }

  // `oldBlock.slots[slotName]` is the pre-reorder array — safe to read positions from it.
  const oldChildren = oldBlock.slots?.[slotName] ?? []
  return {
    blocks: next,
    inverse,
    affected: {
      ...emptyAffected(),
      updated: [blockId],
      moved: collectMoved(oldChildren),
    },
  }
}

const applyReplace = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'replace' }>,
  locator?: Locator,
): ApplyResult => {
  if (op.block.id !== op.id) {
    throw new Error(
      `applyOperation/replace: op.block.id "${op.block.id}" must equal op.id "${op.id}"`,
    )
  }

  const updater = (existing: Block): Block => {
    if (op.keepChildren) {
      const result: Block = { ...op.block }
      if (existing.slots) {
        result.slots = existing.slots
      } else {
        Reflect.deleteProperty(result, 'slots')
      }
      return result
    }
    return op.block
  }

  const { blocks: next, oldBlock } = locator
    ? mapBlockSpine(blocks, op.id, updater, locator)
    : mapBlock(blocks, op.id, updater)

  if (oldBlock === null) {
    throw new Error(`applyOperation/replace: block "${op.id}" not found`)
  }

  // structuredClone to detach the captured block from any subsequent mutation.
  // Inverse is always keepChildren=false: the cloned old block already carries its
  // own original slots, so we replace wholesale.
  const inverse: TreeOperation = {
    op: 'replace',
    id: op.id,
    block: structuredClone(oldBlock),
    keepChildren: false,
  }

  // The block itself is always `updated` (same id, new content).
  // When children are dropped (!keepChildren), the old descendants are `removed`
  // and the new descendants from `op.block` are `created`. The block's own id is
  // excluded from both lists since it persists.
  const affected: AffectedBlocks = { ...emptyAffected(), updated: [op.id] }
  if (!op.keepChildren) {
    affected.removed = collectIds(oldBlock).filter((id) => id !== op.id)
    affected.created = collectIds(op.block).filter((id) => id !== op.id)
  }

  return { blocks: next, inverse, affected }
}

const applyInsert = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'insert' }>,
  locator?: Locator,
): ApplyResult => {
  const next = locator
    ? insertBlockInTreeSpine(blocks, op.block, op.target, locator)
    : insertBlockInTree(blocks, op.block, op.target)
  const inverse: TreeOperation = { op: 'remove', id: op.block.id }

  // The inserted block + its subtree are `created`. The parent's slot reference
  // changes, so the parent block is `updated` — except for root inserts, where
  // there is no parent block to track.
  const { blockId: parentId } = resolveSlotKey(op.target.slot)
  const affected: AffectedBlocks = {
    ...emptyAffected(),
    created: collectIds(op.block),
    updated: parentId === ROOT_BLOCK_ID ? [] : [parentId],
  }

  return { blocks: next, inverse, affected }
}

const applyRemove = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'remove' }>,
  locator?: Locator,
): ApplyResult => {
  const { blocks: next, removed } = locator
    ? removeBlockFromTreeSpine(blocks, op.id, locator)
    : removeBlockFromTree(blocks, op.id)

  if (removed === null) {
    throw new Error(`applyOperation/remove: block "${op.id}" not found`)
  }

  const inverse: TreeOperation = {
    op: 'insert',
    block: structuredClone(removed.block),
    target: { slot: removed.parentSlot, index: removed.index },
  }

  // The removed block + its subtree are `removed`. The parent's slot reference
  // changes, so the parent block is `updated` — except when removed from root.
  const { blockId: parentId } = resolveSlotKey(removed.parentSlot)
  const affected: AffectedBlocks = {
    ...emptyAffected(),
    removed: collectIds(removed.block),
    updated: parentId === ROOT_BLOCK_ID ? [] : [parentId],
  }

  return { blocks: next, inverse, affected }
}

const applyMove = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'move' }>,
  locator?: Locator,
): ApplyResult => {
  const removeResult = locator
    ? removeBlockFromTreeSpine(blocks, op.id, locator)
    : removeBlockFromTree(blocks, op.id)

  const { blocks: afterRemove, removed } = removeResult
  if (removed === null) {
    throw new Error(`applyOperation/move: block "${op.id}" not found`)
  }

  // Cycle check: the target slot must not live inside the moved subtree.
  const { blockId: targetBlockId } = resolveSlotKey(op.target.slot)
  if (targetBlockId !== ROOT_BLOCK_ID && subtreeContainsId(removed.block, targetBlockId)) {
    throw new Error(
      `applyOperation/move: cannot move block "${op.id}" into its own descendant "${targetBlockId}"`,
    )
  }

  // The locator was built from the OLD tree. After remove, the position of every
  // block OUTSIDE the removed subtree is unchanged (parentId/slot/index are stable
  // because we only spliced one element from the source's parent slot, and the
  // source's parent isn't a descendant of the source). The cycle check above
  // guarantees target.blockId is outside the removed subtree, so the locator
  // remains valid for it.
  const next = locator
    ? insertBlockInTreeSpine(afterRemove, removed.block, op.target, locator)
    : insertBlockInTree(afterRemove, removed.block, op.target)

  const inverse: TreeOperation = {
    op: 'move',
    id: op.id,
    target: { slot: removed.parentSlot, index: removed.index },
  }

  // The moved block: `moved`. Both source and target parent see their slot
  // reference change, so they're `updated` — but only count each non-root parent
  // once (and skip if the move is intra-slot: same parent appears once).
  const { blockId: oldParentId } = resolveSlotKey(removed.parentSlot)
  const updated: BlockId[] = []
  if (oldParentId !== ROOT_BLOCK_ID) updated.push(oldParentId)
  if (targetBlockId !== ROOT_BLOCK_ID && targetBlockId !== oldParentId) {
    updated.push(targetBlockId)
  }

  return {
    blocks: next,
    inverse,
    affected: { ...emptyAffected(), moved: [op.id], updated },
  }
}

// ─── Walk-based helpers (fallback when no locator is provided) ───────────

/**
 * Recursively traverse the tree and replace the block matching `id` via `updater`.
 * Untouched branches keep their references (structural sharing).
 *
 * @returns the new tree (referentially equal to `blocks` if `id` not found) plus the
 *          original block (`null` if `id` not found in the tree).
 */
const mapBlock = (
  blocks: Block[],
  id: BlockId,
  updater: (block: Block) => Block,
): { blocks: Block[]; oldBlock: Block | null } => {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue

    if (block.id === id) {
      const next = blocks.slice()
      next[i] = updater(block)
      return { blocks: next, oldBlock: block }
    }

    if (block.slots) {
      for (const [slotName, children] of Object.entries(block.slots)) {
        const result = mapBlock(children, id, updater)
        if (result.oldBlock !== null) {
          const next = blocks.slice()
          next[i] = {
            ...block,
            slots: { ...block.slots, [slotName]: result.blocks },
          }
          return { blocks: next, oldBlock: result.oldBlock }
        }
      }
    }
  }

  return { blocks, oldBlock: null }
}

const resolveSlotKey = (slotKey: SlotKey): { blockId: BlockId | RootBlockId; slotName: string } => {
  const idx = slotKey.indexOf(':')
  if (idx === -1) {
    throw new Error(`resolveSlotKey: invalid SlotKey "${slotKey}"`)
  }

  const blockId = slotKey.substring(0, idx)
  const slotName = slotKey.substring(idx + 1)

  if (!blockId || !slotName) {
    throw new Error(`resolveSlotKey: invalid SlotKey "${slotKey}"`)
  }

  return { blockId, slotName }
}

/**
 * Insert `block` at `target` immutably (walk-based). Throws if the parent block does not
 * exist or the index is out of bounds. Auto-creates the slot entry if the parent had none.
 */
const insertBlockInTree = (blocks: Block[], block: Block, target: Target): Block[] => {
  const { slot, index } = target
  const { blockId, slotName } = resolveSlotKey(slot)

  if (blockId === ROOT_BLOCK_ID) {
    if (slotName !== ROOT_SLOT_NAME) {
      throw new Error(
        `applyOperation/insert: invalid root slot "${slotName}" (expected "${ROOT_SLOT_NAME}")`,
      )
    }
    const idx = index ?? blocks.length
    checkInsertBounds(blocks, idx, `slot "${slot}"`)
    const next = blocks.slice()
    next.splice(idx, 0, block)
    return next
  }

  const { blocks: next, oldBlock } = mapBlock(blocks, blockId, (parent) => {
    const children = parent.slots?.[slotName] ?? []
    const idx = index ?? children.length
    checkInsertBounds(children, idx, `slot "${slot}"`)
    const newChildren = children.slice()
    newChildren.splice(idx, 0, block)
    return {
      ...parent,
      slots: { ...parent.slots, [slotName]: newChildren },
    }
  })

  if (oldBlock === null) {
    throw new Error(`applyOperation/insert: parent block "${blockId}" not found`)
  }

  return next
}

/**
 * Recursively traverse the tree, remove the block matching `id`, and capture its
 * original position. Untouched branches keep their references.
 *
 * @returns the new tree plus the captured block + its original parent slot and index.
 *          `removed` is `null` if `id` was not found anywhere in the tree.
 */
const removeBlockFromTree = (
  blocks: Block[],
  id: BlockId,
  parentSlot: SlotKey = ROOT_SLOT_KEY,
): {
  blocks: Block[]
  removed: { block: Block; parentSlot: SlotKey; index: number } | null
} => {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue

    if (block.id === id) {
      const next = blocks.slice()
      next.splice(i, 1)
      return { blocks: next, removed: { block, parentSlot, index: i } }
    }

    if (block.slots) {
      for (const [slotName, children] of Object.entries(block.slots)) {
        const childSlotKey: SlotKey = `${block.id}:${slotName}`
        const result = removeBlockFromTree(children, id, childSlotKey)
        if (result.removed !== null) {
          const next = blocks.slice()
          next[i] = {
            ...block,
            slots: { ...block.slots, [slotName]: result.blocks },
          }
          return { blocks: next, removed: result.removed }
        }
      }
    }
  }

  return { blocks, removed: null }
}

/**
 * Whether the subtree rooted at `block` (block included) contains a node with the given `id`.
 * Short-circuits on first match — O(depth-to-match) instead of O(subtree size).
 */
const subtreeContainsId = (block: Block, id: BlockId): boolean => {
  if (block.id === id) return true
  if (!block.slots) return false
  for (const children of Object.values(block.slots)) {
    for (const child of children) {
      if (subtreeContainsId(child, id)) return true
    }
  }
  return false
}

const checkInsertBounds = (arr: Block[], idx: number, ctx: string): void => {
  if (idx < 0 || idx > arr.length) {
    throw new Error(
      `applyOperation/insert: index=${idx} out of bounds (${ctx}, length ${arr.length})`,
    )
  }
}

// ─── Spine-based helpers (used when a Locator is provided) ───────────────

interface ChainEntry {
  blockId: BlockId
  parentId: BlockId | null
  slot: string | null
  index: number
}

/**
 * Assert that the block at `entry.index` in `blocks` matches `entry.blockId`.
 * Returns the block when the locator is consistent, throws otherwise. Centralizes
 * the drift-detection error message used by every spine helper.
 */
const assertChainConsistent = (blocks: Block[], entry: ChainEntry, context: string): Block => {
  const block = blocks[entry.index]
  if (!block || block.id !== entry.blockId) {
    throw new Error(
      `${context}: locator inconsistent — expected "${entry.blockId}" at index ${entry.index}, got "${block?.id ?? 'undefined'}"`,
    )
  }
  return block
}

/**
 * Resolve the child slot named by `childEntry.slot` on `block`. Used by every spine
 * helper at inner depths: the chain guarantees the child block lives in this slot,
 * so the slot must exist (even if empty arrays are valid in general).
 *
 * Uses `=== undefined` rather than truthiness to distinguish "slot inexistant" (bug)
 * from "slot is an empty array" (valid in other contexts, but unreachable here).
 */
const resolveChildSlot = (
  block: Block,
  childEntry: ChainEntry,
  context: string,
): { childSlotName: string; childArray: Block[] } => {
  if (childEntry.slot === null) {
    throw new Error(`${context}: invalid child chain entry (slot is null)`)
  }
  const childSlotName = childEntry.slot
  const childArray = block.slots?.[childSlotName]
  if (childArray === undefined) {
    throw new Error(
      `${context}: locator inconsistent — block "${block.id}" has no slot "${childSlotName}"`,
    )
  }
  return { childSlotName, childArray }
}

/**
 * Walk UP from `id` to root via the locator, collecting one entry per ancestor.
 * Returns the chain ordered root-first → leaf-last (so `chain[0]` is the
 * root-level ancestor, `chain[N-1]` is the target block itself).
 *
 * Returns `null` if the locator returns `null` for any id along the chain.
 *
 * Implementation note: push + single reverse (O(N)) instead of unshift per step
 * (O(N²) due to per-step reallocation). Matters for deep trees.
 */
const buildAncestorChain = (id: BlockId, locator: Locator): ChainEntry[] | null => {
  const chain: ChainEntry[] = []
  let currentId: BlockId | null = id

  while (currentId !== null) {
    const info = locator(currentId)
    if (info === null) return null
    chain.push({
      blockId: currentId,
      parentId: info.parentId,
      slot: info.slot,
      index: info.index,
    })
    currentId = info.parentId
  }

  return chain.reverse()
}

/**
 * Locator-based replacement of `mapBlock`: rebuilds only the spine from root to leaf
 * using the chain returned by the locator. O(depth) allocations vs O(N) for `mapBlock`.
 *
 * Throws on locator inconsistency (chain points to a block whose id differs from the
 * tree's content at that position) — this catches stale-index bugs early.
 */
const mapBlockSpine = (
  blocks: Block[],
  id: BlockId,
  updater: (block: Block) => Block,
  locator: Locator,
): { blocks: Block[]; oldBlock: Block | null } => {
  const chain = buildAncestorChain(id, locator)
  if (chain === null) return { blocks, oldBlock: null }

  const rebuild = (currentBlocks: Block[], depth: number): { blocks: Block[]; oldBlock: Block } => {
    const entry = chain[depth]
    if (!entry) {
      throw new Error(`mapBlockSpine: missing chain entry at depth ${depth}`)
    }
    const block = assertChainConsistent(currentBlocks, entry, 'mapBlockSpine')

    if (depth === chain.length - 1) {
      // Leaf — apply updater.
      const next = currentBlocks.slice()
      next[entry.index] = updater(block)
      return { blocks: next, oldBlock: block }
    }

    // Inner — descend into the next chain entry's slot.
    const childEntry = chain[depth + 1]
    if (!childEntry) {
      throw new Error(`mapBlockSpine: missing chain entry at depth ${depth + 1}`)
    }
    const { childSlotName, childArray } = resolveChildSlot(block, childEntry, 'mapBlockSpine')
    const result = rebuild(childArray, depth + 1)
    const next = currentBlocks.slice()
    next[entry.index] = {
      ...block,
      slots: { ...block.slots, [childSlotName]: result.blocks },
    }
    return { blocks: next, oldBlock: result.oldBlock }
  }

  return rebuild(blocks, 0)
}

/**
 * Locator-based replacement of `removeBlockFromTree`. Same contract, O(depth) allocs.
 */
const removeBlockFromTreeSpine = (
  blocks: Block[],
  id: BlockId,
  locator: Locator,
): {
  blocks: Block[]
  removed: { block: Block; parentSlot: SlotKey; index: number } | null
} => {
  const chain = buildAncestorChain(id, locator)
  if (chain === null) return { blocks, removed: null }

  const leaf = chain[chain.length - 1]
  if (!leaf) {
    throw new Error('removeBlockFromTreeSpine: empty chain')
  }

  // Invariant maintained by BlockTree.indexBlocks: parentId === null iff slot === null.
  const parentSlot: SlotKey =
    leaf.parentId === null ? ROOT_SLOT_KEY : `${leaf.parentId}:${leaf.slot}`

  // Recursive rebuild that, at the leaf, splices out the index instead of replacing.
  const rebuild = (currentBlocks: Block[], depth: number): { blocks: Block[]; removed: Block } => {
    const entry = chain[depth]
    if (!entry) {
      throw new Error(`removeBlockFromTreeSpine: missing chain entry at depth ${depth}`)
    }
    const block = assertChainConsistent(currentBlocks, entry, 'removeBlockFromTreeSpine')

    if (depth === chain.length - 1) {
      // Leaf — splice it out.
      const next = currentBlocks.slice()
      next.splice(entry.index, 1)
      return { blocks: next, removed: block }
    }

    const childEntry = chain[depth + 1]
    if (!childEntry) {
      throw new Error('removeBlockFromTreeSpine: missing child chain entry')
    }
    const { childSlotName, childArray } = resolveChildSlot(
      block,
      childEntry,
      'removeBlockFromTreeSpine',
    )
    const result = rebuild(childArray, depth + 1)
    const next = currentBlocks.slice()
    next[entry.index] = {
      ...block,
      slots: { ...block.slots, [childSlotName]: result.blocks },
    }
    return { blocks: next, removed: result.removed }
  }

  const { blocks: next, removed } = rebuild(blocks, 0)
  return { blocks: next, removed: { block: removed, parentSlot, index: leaf.index } }
}

/**
 * Locator-based replacement of `insertBlockInTree`.
 * Root insert is O(1) and skips the locator. Nested insert uses the chain to the parent.
 */
const insertBlockInTreeSpine = (
  blocks: Block[],
  block: Block,
  target: Target,
  locator: Locator,
): Block[] => {
  const { slot, index } = target
  const { blockId, slotName } = resolveSlotKey(slot)

  if (blockId === ROOT_BLOCK_ID) {
    if (slotName !== ROOT_SLOT_NAME) {
      throw new Error(
        `applyOperation/insert: invalid root slot "${slotName}" (expected "${ROOT_SLOT_NAME}")`,
      )
    }
    const idx = index ?? blocks.length
    checkInsertBounds(blocks, idx, `slot "${slot}"`)
    const next = blocks.slice()
    next.splice(idx, 0, block)
    return next
  }

  const chain = buildAncestorChain(blockId, locator)
  if (chain === null) {
    throw new Error(`applyOperation/insert: parent block "${blockId}" not found`)
  }

  const rebuild = (currentBlocks: Block[], depth: number): Block[] => {
    const entry = chain[depth]
    if (!entry) {
      throw new Error(`insertBlockInTreeSpine: missing chain entry at depth ${depth}`)
    }
    const parent = assertChainConsistent(currentBlocks, entry, 'insertBlockInTreeSpine')

    if (depth === chain.length - 1) {
      // Leaf — this is the target parent block, splice into its slot.
      // Auto-create the slot if absent: at the leaf, the slot named by `target.slot`
      // is the destination chosen by the caller, not a slot the chain navigates through —
      // so it may legitimately not exist yet on this parent.
      const children = parent.slots?.[slotName] ?? []
      const idx = index ?? children.length
      checkInsertBounds(children, idx, `slot "${slot}"`)
      const newChildren = children.slice()
      newChildren.splice(idx, 0, block)
      const next = currentBlocks.slice()
      next[entry.index] = {
        ...parent,
        slots: { ...parent.slots, [slotName]: newChildren },
      }
      return next
    }

    // Inner depth: chain navigates through this parent's slots, so the slot MUST exist.
    const childEntry = chain[depth + 1]
    if (!childEntry) {
      throw new Error('insertBlockInTreeSpine: missing child chain entry')
    }
    const { childSlotName, childArray } = resolveChildSlot(
      parent,
      childEntry,
      'insertBlockInTreeSpine',
    )
    const newChildren = rebuild(childArray, depth + 1)
    const next = currentBlocks.slice()
    next[entry.index] = {
      ...parent,
      slots: { ...parent.slots, [childSlotName]: newChildren },
    }
    return next
  }

  return rebuild(blocks, 0)
}
