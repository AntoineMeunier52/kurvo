import type { TreeOperation } from './operations'

/**
 * History entry: an operation + its inverse.
 *
 * **Command-pattern** approach (vs full-snapshot) — see
 * cms-project-docs/04-architecture/Patterns repris de Puck.md §6.
 *
 * Goal: `undo()` applies `inverse`, `redo()` re-applies `op`.
 * Memory cost ~O(1) per entry (vs O(N) blocks for a snapshot).
 */
export interface HistoryEntry {
  op: TreeOperation
  inverse: TreeOperation
  timestamp: number
  description?: string
}
