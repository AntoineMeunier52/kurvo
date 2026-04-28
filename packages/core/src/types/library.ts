/**
 * Definition of a Library: a named group of Blocks for categorization in the editor's Palette.
 *
 * See cms-project-docs/04-architecture/Refonte API V1.md §Library.
 */

// `BlockDefinition` is not yet implemented (Phase 1, sub-task `defineBlock`). Declared as a
// placeholder via `unknown` to avoid a premature circular dep. Will be retyped to
// `BlockDefinition` once that exists.

export interface LibraryDefinition {
  name: string
  label?: string
  icon?: string
  description?: string
  blocks: ReadonlyArray<unknown>
}
