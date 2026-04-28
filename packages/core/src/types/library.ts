/**
 * Definition d'une Library: un groupe nomme de Blocks pour la categorisation dans la Palette
 * de l'editor.
 *
 * Voir cms-project-docs/04-architecture/Refonte API V1.md §Library.
 */

// `BlockDefinition` n'est pas encore implemente (Phase 1, sous-tache `defineBlock`). On le declare
// en placeholder ici via `unknown` pour eviter une dep circulaire prematuree. Sera retypee en
// `BlockDefinition` once that exists.

export interface LibraryDefinition {
  name: string
  label?: string
  icon?: string
  description?: string
  blocks: ReadonlyArray<unknown>
}
