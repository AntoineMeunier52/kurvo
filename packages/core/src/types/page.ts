import type { Block } from './block'
import type { PageMeta } from './meta'

export type PageStatus = 'draft' | 'published'

/**
 * Une **Page** est l'unite editable V1.
 *
 * Surface plate (pas de wrapper `Document<TData>` en V1). La structure Document/Collection generique
 * existe en interne (cf `document.ts`) pour preparer V2 headless mais n'est pas exposee.
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
