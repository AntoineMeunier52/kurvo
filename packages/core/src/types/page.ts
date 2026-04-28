import type { Block } from './block'
import type { PageMeta } from './meta'

export type PageStatus = 'draft' | 'published'

/**
 * A **Page** is the V1 editable unit.
 *
 * Flat surface (no `Document<TData>` wrapper in V1). The generic Document/Collection structure
 * exists internally (see `document.ts`) to prepare V2 headless but is not exposed.
 */
export interface Page {
  id: string
  slug: string

  blocks: Block[]
  meta?: PageMeta

  locale?: string
  translationGroupId?: string
  isSource?: boolean

  status: PageStatus
  createdAt: number
  updatedAt: number
  publishedAt?: number
  lastPublishedAt?: number
  deletedAt?: number
  authorId?: string
  template?: string
}
