import type { FieldDefinition } from './field'

/**
 * @internal
 *
 * The Collection concept is strictly internal in V1. The only handled collection is `pages`,
 * implicitly, with no public surface. The type is kept to prepare V2 headless
 * (see cms-project-docs/04-architecture/Surface partagee V1 V2.md). Do not re-export from `index.ts`.
 */
export interface CollectionDefinition<TData = unknown> {
  name: string
  fields?: Record<string, FieldDefinition>
  __dataType?: TData
}
