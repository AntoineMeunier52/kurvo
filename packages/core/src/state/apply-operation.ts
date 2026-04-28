import type { Block, BlockId, SlotKey } from '../types'
import type { TreeOperation } from '../types'
import { ROOT_SLOT_NAME } from '../types'

/**
 * Apply a {@link TreeOperation} to a tree of blocks immutably.
 *
 * Pure function: no mutation of the input, returns a fresh tree plus the inverse operation
 * (used to seed history entries).
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
  const unset = op.unset ?? []

  const { blocks: next, oldBlock } = mapBlock(blocks, op.id, (block) => {
    // Apply unset first, then set (so `set` wins on key overlap).
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
    // If the key didn't exist before, the unset was a no-op, nothing to undo.
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
  _blocks: Block[],
  _op: Extract<TreeOperation, { op: 'replace' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  throw new Error('applyReplace: not implemented')
}

const applyInsert = (
  _blocks: Block[],
  _op: Extract<TreeOperation, { op: 'insert' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  throw new Error('applyInsert: not implemented')
}

const applyRemove = (
  _blocks: Block[],
  _op: Extract<TreeOperation, { op: 'remove' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  throw new Error('applyRemove: not implemented')
}

const applyMove = (
  _blocks: Block[],
  _op: Extract<TreeOperation, { op: 'move' }>,
): { blocks: Block[]; inverse: TreeOperation } => {
  throw new Error('applyMove: not implemented')
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

    if (!block) return { blocks, oldBlock: null }

    if (block.id === id) {
      const next = [...blocks]
      next[i] = updater(block)
      return { blocks: next, oldBlock: block }
    }

    if (block.slots) {
      for (const [slotName, children] of Object.entries(block.slots)) {
        const result = mapBlock(children, id, updater)
        if (result.oldBlock !== null) {
          const next = [...blocks]
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
