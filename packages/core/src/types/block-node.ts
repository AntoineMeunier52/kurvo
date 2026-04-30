import type { BlockId } from './block'

/**
 * @internal
 *
 * Positional entry of a Block within the tree, used as the value of the
 * `Map<BlockId, BlockNode>` maintained by `BlockTree`. Enables O(1):
 *   - Lookup of "is this id present"
 *   - Parent resolution (walk up via `parentId`)
 *   - Slot + index identification within the parent
 *   - Path-to-root computation
 *
 * `null` on `parentId` and `slot` marks the block as living at the document root
 * (i.e. directly inside `Page.blocks`). For nested blocks both fields are non-null.
 *
 * The full `SlotKey` (`${parentId|ROOT_BLOCK_ID}:${slotName}`) is reconstructed
 * on demand rather than stored, so a single source of truth is kept.
 *
 * Intentionally **does not** carry a `block: Block` reference: `BlockTree` walks
 * the live `_blocks` array via the parent chain to resolve a block on demand.
 * That keeps reads always consistent with the canonical tree, even when a
 * mutation rebuilds the spine and produces a new ref for several ancestors.
 *
 * Not exposed in the public surface: user code only manipulates `Block` (JSON form).
 */
export interface BlockNode {
  /** `null` if the block is at the document root. */
  parentId: BlockId | null
  /** Slot name on the parent (without the `parentId:` prefix). `null` if at the root. */
  slot: string | null
  /** Position of the block inside its parent slot (or root array). */
  index: number
  /**
   * Distance from the document root, measured in nesting levels.
   *  - `0` for blocks living at the page root (direct children of the
   *    virtual root, i.e. `parentId === null`).
   *  - `parent.depth + 1` for nested blocks.
   *
   * Cached during indexing so consumers don't have to walk the parent chain
   * to answer "how deep is this block". Maintained by every BlockTree
   * mutation (insert / remove / move / reorder / replace).
   */
  depth: number
}
