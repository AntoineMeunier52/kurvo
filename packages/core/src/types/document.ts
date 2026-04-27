import type { DocumentMeta } from './meta'

export type DocumentStatus = 'draft' | 'published'

export interface Document<TData = Record<string, unknown>> {
  id: string
  collection: string
  data: TData

  meta?: DocumentMeta

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
