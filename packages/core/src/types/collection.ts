import type { FieldDefinition } from './field'

/**
 * @internal V1 — public V2 (cf cms-project-docs/04-architecture/Surface partagee V1 V2.md decision #3).
 * The type is exposed V1 (consumed by `definePageCollection`'s return type),
 * but the `defineCollection()` function will not be re-exported from the public surface until V2.
 */
export interface CollectionDefinition<TData = unknown> {
  name: string
  fields?: Record<string, FieldDefinition>
  __dataType?: TData
}
