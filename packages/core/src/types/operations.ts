import type { Block, BlockId } from './block'

/**
 * Identifiant unique d'un slot dans un Document.
 *
 * Format: `${BlockId | 'root'}:${slotName}`.
 * Le pseudo-block `'root'` represente la racine du Document (le tableau `Page.blocks`).
 * Convention: `'root'` n'expose qu'un seul slot, nomme par {@link ROOT_SLOT_NAME}.
 *
 * Exemples:
 *   - `'root:default'`     — racine du Document
 *   - `'blk_8f3k:cta'`     — slot `cta` du Block `blk_8f3k`
 */
export type SlotKey = `${BlockId | 'root'}:${string}`

/** Nom conventionnel du slot racine, expose uniquement par le pseudo-block `'root'`. */
export const ROOT_SLOT_NAME = 'default'

/** SlotKey racine du Document. */
export const ROOT_SLOT_KEY: SlotKey = `root:${ROOT_SLOT_NAME}`

/**
 * Cible d'insertion: `{ slot, index }`.
 * Si `index` est omis, insertion en fin de slot.
 */
export interface Target {
  slot: SlotKey
  index?: number
}

/**
 * Operations atomiques applicables a l'arbre de Blocks.
 *
 * Discrimine par `op`. Chaque operation est completement reversible: appliquer sa transformation
 * inverse (cf {@link HistoryEntry}) restaure l'etat precedent.
 *
 * Contrats:
 *   - `insert`: `block.id` doit etre globalement unique dans le Document.
 *   - `move`: deplace un block existant. Interdit si `target` est descendant de `id` (cycle).
 *   - `remove`: supprime le block et tout son sous-arbre.
 *   - `reorder`: change l'ordre dans un slot existant.
 *   - `replace`: remplace un block (meme id) par un autre. Conserve les enfants si `keepChildren`.
 *   - `updateProps`: patch shallow des props.
 */
export type TreeOperation =
  | { op: 'insert'; block: Block; target: Target }
  | { op: 'move'; id: BlockId; target: Target }
  | { op: 'remove'; id: BlockId }
  | { op: 'reorder'; slot: SlotKey; from: number; to: number }
  | { op: 'replace'; id: BlockId; block: Block; keepChildren?: boolean }
  | { op: 'updateProps'; id: BlockId; props: Record<string, unknown> }
