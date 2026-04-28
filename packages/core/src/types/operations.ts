import type { Block, BlockId } from './block'

/**
 * Unique identifier for a slot inside a Page.
 *
 * Format: `${BlockId | 'root'}:${slotName}`.
 * The pseudo-block `'root'` represents the Page root (the `Page.blocks` array).
 * Convention: `'root'` exposes a single slot, named by {@link ROOT_SLOT_NAME}.
 *
 * Examples:
 *   - `'root:default'`     — Page root
 *   - `'blk_8f3k:cta'`     — slot `cta` of Block `blk_8f3k`
 */
export type SlotKey = `${BlockId | 'root'}:${string}`

/** Conventional name of the root slot, exposed only by the pseudo-block `'root'`. */
export const ROOT_SLOT_NAME = 'default'

/** Root SlotKey of the Page. */
export const ROOT_SLOT_KEY: SlotKey = `root:${ROOT_SLOT_NAME}`

/**
 * Insertion target: `{ slot, index }`.
 * If `index` is omitted, insertion happens at the end of the slot.
 */
export interface Target {
  slot: SlotKey
  index?: number
}

/**
 * Atomic operations applicable to the Block tree.
 *
 * Discriminated by `op`. Each operation is fully reversible: applying its inverse transformation
 * (see {@link HistoryEntry}) restores the previous state.
 *
 * Contracts:
 *   - `insert`: `block.id` must be globally unique within the Document.
 *   - `move`: moves an existing block. Forbidden if `target` is a descendant of `id` (cycle).
 *   - `remove`: removes the block and its entire subtree.
 *   - `reorder`: changes the order within an existing slot.
 *   - `replace`: replaces a block (same id) with another. Keeps children if `keepChildren`.
 *   - `updateFields`: shallow patch of fields. `set` writes/overwrites keys, `unset` deletes keys.
 *     Both are optional. If a key appears in both, `set` wins (defined behavior, not validated).
 *     This shape is JSON-safe (no `undefined` sentinels), so ops can transit through
 *     `postMessage`, `BroadcastChannel`, or persistence layers without losing information.
 */
export type TreeOperation =
  | { op: 'insert'; block: Block; target: Target }
  | { op: 'move'; id: BlockId; target: Target }
  | { op: 'remove'; id: BlockId }
  | { op: 'reorder'; slot: SlotKey; from: number; to: number }
  | { op: 'replace'; id: BlockId; block: Block; keepChildren?: boolean }
  | {
      op: 'updateFields'
      id: BlockId
      set?: Record<string, unknown>
      unset?: readonly string[]
    }
