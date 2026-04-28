import type { Block, BlockId } from './block'
import type { SlotKey } from './operations'

/**
 * @internal
 *
 * Vue indexee d'un Block dans l'arbre. Conserve dans la `Map<BlockId, BlockNode>` maintenue par
 * `BlockTree`. Permet:
 *   - lookup O(1) d'un block par id
 *   - resolution O(1) du parent
 *   - calcul de path en remontant les `parent`
 *
 * Pas exposee dans la surface publique: l'API user ne manipule que `Block` (forme JSON).
 */
export interface BlockNode {
  block: Block
  parentId: BlockId | 'root'
  parentSlot: SlotKey
  index: number
}
