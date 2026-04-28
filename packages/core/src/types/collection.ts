import type { FieldDefinition } from './field'

/**
 * @internal
 *
 * Le concept de Collection est strictement interne en V1. La seule collection geree est `pages`,
 * implicitement, sans surface publique. Conservation du type pour preparer V2 headless
 * (cf cms-project-docs/04-architecture/Surface partagee V1 V2.md). Ne pas re-exporter depuis `index.ts`.
 */
export interface CollectionDefinition<TData = unknown> {
  name: string
  fields?: Record<string, FieldDefinition>
  __dataType?: TData
}
