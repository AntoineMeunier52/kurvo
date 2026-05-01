import type { TreeOperation } from './operations'

/**
 * History entry: a single op + its inverse, OR a composite of N ops grouped
 * as a single undoable unit (cf. `History.transact()`).
 *
 * **Command-pattern** approach (vs full-snapshot) — see
 * cms-project-docs/04-architecture/Patterns repris de Puck.md §6.
 *
 * Goal: `undo()` applies the inverse(s), `redo()` re-applies the op(s).
 * Memory cost ~O(N ops) per entry (vs O(N blocks) for a snapshot).
 *
 * For `composite` entries, `inverses` are stored in REVERSE order relative to
 * `ops`: undoing rolls back the last op first, then the second-to-last, etc.,
 * which is the only correct order when ops have non-commuting effects.
 */
export type HistoryEntry =
  | {
      kind: 'single'
      op: TreeOperation
      inverse: TreeOperation
      timestamp: number
      label?: string
    }
  | {
      kind: 'composite'
      ops: TreeOperation[]
      /** Inverses ordered last-op-first, ready to apply in sequence to undo. */
      inverses: TreeOperation[]
      timestamp: number
      label?: string
    }
