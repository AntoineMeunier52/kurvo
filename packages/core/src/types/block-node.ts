import type { Block, BlockId } from './block'
import type { SlotKey } from './operations'

/**
 * @internal
 *
 * Indexed view of a Block within the tree. Stored in the `Map<BlockId, BlockNode>` maintained by
 * `BlockTree`. Enables:
 *   - O(1) lookup of a block by id
 *   - O(1) parent resolution
 *   - path computation by walking up `parent`
 *
 * Not exposed in the public surface: the user API only manipulates `Block` (JSON form).
 */
export interface BlockNode {
  block: Block
  parentId: BlockId | 'root'
  parentSlot: SlotKey
  index: number
}
