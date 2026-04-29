import type { Block, BlockId, SlotKey, Target } from '../types'
import type { TreeOperation } from '../types'
import { ROOT_SLOT_KEY, ROOT_SLOT_NAME } from '../types'

/**
 * Apply a {@link TreeOperation} to a tree of blocks immutably.
 *
 * Pure function: no mutation of the input, returns a fresh tree plus the inverse operation
 * (used to seed history entries).
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
): { blocks: Block[]; inverse: TreeOperation } => {
  switch (op.op) {
    case 'updateFields':
      return applyUpdateFields(blocks, op)
    case 'reorder':
      return applyReorder(blocks, op)
    case 'replace':
      return applyReplace(blocks, op)
    case 'insert':
      return applyInsert(blocks, op)
    case 'remove':
      return applyRemove(blocks, op)
    case 'move':
      return applyMove(blocks, op)
  }
}

const applyUpdateFields = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'updateFields' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
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

  const { blocks: next, oldBlock } = mapBlock(blocks, op.id, (block) => {
    const newFields: Record<string, unknown> = { ...block.fields }
    for (const key of unset) {
      Reflect.deleteProperty(newFields, key)
    }
    for (const [key, value] of Object.entries(set)) {
      newFields[key] = value
    }
    return { ...block, fields: newFields }
  })

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
  }
}

const applyReorder = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'reorder' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
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
  // Spread keeps the splice typesafe under noUncheckedIndexedAccess
  // (a destructured `[removed]` would be `Block | undefined`).
  const reorderArray = (arr: Block[]): Block[] => {
    checkBounds(arr, from, 'from')
    checkBounds(arr, to, 'to')
    const next = arr.slice()
    const removed = next.splice(from, 1)
    next.splice(to, 0, ...removed)
    return next
  }

  const { blockId, slotName } = resolveSlotKey(slot)

  // Root slot: splice the root array directly.
  if (blockId === 'root') {
    if (slotName !== ROOT_SLOT_NAME) {
      throw new Error(
        `applyOperation/reorder: invalid root slot "${slotName}" (expected "${ROOT_SLOT_NAME}")`,
      )
    }
    // Bounds-validate even on no-op to catch malformed input early.
    checkBounds(blocks, from, 'from')
    checkBounds(blocks, to, 'to')
    if (from === to) return { blocks, inverse }
    return { blocks: reorderArray(blocks), inverse }
  }

  // Nested slot: navigate to the parent block, transform its slot.
  const { blocks: next, oldBlock } = mapBlock(blocks, blockId, (block) => {
    const children = block.slots?.[slotName]
    if (!children) {
      throw new Error(`applyOperation/reorder: slot "${slot}" not found on block "${blockId}"`)
    }
    // Bounds-validate even on no-op to catch malformed input early.
    checkBounds(children, from, 'from')
    checkBounds(children, to, 'to')
    if (from === to) return block
    return {
      ...block,
      slots: { ...block.slots, [slotName]: reorderArray(children) },
    }
  })

  if (oldBlock === null) {
    throw new Error(`applyOperation/reorder: block "${blockId}" not found`)
  }

  return { blocks: next, inverse }
}

const applyReplace = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'replace' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  if (op.block.id !== op.id) {
    throw new Error(
      `applyOperation/replace: op.block.id "${op.block.id}" must equal op.id "${op.id}"`,
    )
  }

  const { blocks: next, oldBlock } = mapBlock(blocks, op.id, (existing) => {
    // keepChildren preserves `existing.slots` verbatim. If existing had no slots and
    // op.block provided some, those are discarded — children are not invented out
    // of nowhere. The flag means "keep what was there", not "merge".
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
  })

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

  return { blocks: next, inverse }
}

const applyInsert = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'insert' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  const next = insertBlockInTree(blocks, op.block, op.target)
  const inverse: TreeOperation = { op: 'remove', id: op.block.id }
  return { blocks: next, inverse }
}

const applyRemove = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'remove' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  const { blocks: next, removed } = removeBlockFromTree(blocks, op.id)
  if (removed === null) {
    throw new Error(`applyOperation/remove: block "${op.id}" not found`)
  }

  // structuredClone so the inverse is independent from the live tree
  // (re-inserting a stale ref then mutating it would corrupt history).
  const inverse: TreeOperation = {
    op: 'insert',
    block: structuredClone(removed.block),
    target: { slot: removed.parentSlot, index: removed.index },
  }

  return { blocks: next, inverse }
}

const applyMove = (
  blocks: Block[],
  op: Extract<TreeOperation, { op: 'move' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  const { blocks: afterRemove, removed } = removeBlockFromTree(blocks, op.id)
  if (removed === null) {
    throw new Error(`applyOperation/move: block "${op.id}" not found`)
  }

  // Cycle check: the target slot must not live inside the moved subtree.
  const { blockId: targetBlockId } = resolveSlotKey(op.target.slot)
  if (targetBlockId !== 'root' && subtreeContainsId(removed.block, targetBlockId)) {
    throw new Error(
      `applyOperation/move: cannot move block "${op.id}" into its own descendant "${targetBlockId}"`,
    )
  }

  const next = insertBlockInTree(afterRemove, removed.block, op.target)

  const inverse: TreeOperation = {
    op: 'move',
    id: op.id,
    target: { slot: removed.parentSlot, index: removed.index },
  }

  return { blocks: next, inverse }
}

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

    // Skip array holes (defensive: noUncheckedIndexedAccess narrowing only).
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

const resolveSlotKey = (slotKey: SlotKey): { blockId: BlockId | 'root'; slotName: string } => {
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
 * Insert `block` at `target` immutably. Throws if the parent block does not exist
 * or the index is out of bounds. Auto-creates the slot entry if the parent had none.
 */
const insertBlockInTree = (blocks: Block[], block: Block, target: Target): Block[] => {
  const { slot, index } = target
  const { blockId, slotName } = resolveSlotKey(slot)

  // Insert range is [0, length] inclusive (length = append).
  const checkInsertBounds = (arr: Block[], idx: number, ctx: string): void => {
    if (idx < 0 || idx > arr.length) {
      throw new Error(
        `applyOperation/insert: index=${idx} out of bounds (${ctx}, length ${arr.length})`,
      )
    }
  }

  if (blockId === 'root') {
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

    // Skip array holes (defensive: noUncheckedIndexedAccess narrowing only).
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
