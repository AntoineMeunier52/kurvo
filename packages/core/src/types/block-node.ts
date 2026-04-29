import type { Block, BlockId } from './block'

/**
 * @internal
 *
 * Indexed view of a Block within the tree, used as the value of the
 * `Map<BlockId, BlockNode>` maintained by `BlockTree`. Enables O(1) for:
 *   - Lookup of a block by id
 *   - Parent resolution (walk up via `parentId`)
 *   - Slot + index identification within the parent
 *   - Path-to-root computation
 *
 * `null` on `parentId` and `slot` marks the block as living at the document root
 * (i.e. directly inside `Page.blocks`). For nested blocks both fields are non-null.
 *
 * The full `SlotKey` (`${parentId|'root'}:${slotName}`) is reconstructed on demand
 * rather than stored, so a single source of truth is kept.
 *
 * Not exposed in the public surface: user code only manipulates `Block` (JSON form).
 */
export interface BlockNode {
  block: Block
  /** `null` if the block is at the document root. */
  parentId: BlockId | null
  /** Slot name on the parent (without the `parentId:` prefix). `null` if at the root. */
  slot: string | null
  /** Position of the block inside its parent slot (or root array). */
  index: number
}
