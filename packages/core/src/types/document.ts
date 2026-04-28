import type { PageMeta } from './meta'

/**
 * @internal
 *
 * V1 ne traite que la collection `pages` (cf {@link Page}). Le concept de Document/Collection generique
 * est conserve dans le code prive pour preparer le mode headless V2 (cf
 * cms-project-docs/04-architecture/Surface partagee V1 V2.md), mais n'est jamais expose dans la surface
 * publique V1.
 */
export type DocumentStatus = 'draft' | 'published'

/**
 * @internal Voir note ci-dessus. Ne pas re-exporter depuis `index.ts`.
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
