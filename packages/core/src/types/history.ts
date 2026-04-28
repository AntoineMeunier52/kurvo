import type { TreeOperation } from './operations'

/**
 * Entree d'historique: une operation + son inverse.
 *
 * Approche **command-pattern** (vs full-snapshot) — voir
 * cms-project-docs/04-architecture/Patterns repris de Puck.md §6.
 *
 * Cible: `undo()` applique `inverse`, `redo()` re-applique `op`.
 * Cout memoire ~O(1) par entree (vs O(N) blocks pour un snapshot).
 */
export interface HistoryEntry {
  op: TreeOperation
  inverse: TreeOperation
  timestamp: number
  description?: string
}
