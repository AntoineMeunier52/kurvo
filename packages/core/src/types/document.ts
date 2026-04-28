import type { PageMeta } from './meta'

/**
 * @internal
 *
 * V1 only handles the `pages` collection (see {@link Page}). The generic Document/Collection concept
 * is kept in private code to prepare V2 headless mode (see
 * cms-project-docs/04-architecture/Surface partagee V1 V2.md), but is never exposed in the
 * V1 public surface.
 */
export type DocumentStatus = 'draft' | 'published'

/**
 * @internal See note above. Do not re-export from `index.ts`.
 */
export interface Document<TData = Record<string, unknown>> {
  id: string
  collection: string
  data: TData

  meta?: PageMeta

  locale?: string
  translationGroupId?: string
  isSource?: boolean

  sourceUpdatedAt?: number
  translatedFromVersion?: string

  status: DocumentStatus
  createdAt: number
  updatedAt: number
  publishedAt?: number
  lastPublishedAt?: number
  deletedAt?: number
  authorId?: string
  template?: string
}
