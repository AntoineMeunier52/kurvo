import type { Block } from './block'
import type { LayoutId } from './layout'
import type { PageMeta } from './meta'

export type PageStatus = 'draft' | 'published'

/**
 * A **Page** is the V1 editable unit. Each Page is rendered into a {@link Layout},
 * which provides the surrounding structure (header/footer/banners) and exposes
 * one or more `PageSlot` blocks where the Page's own content gets injected.
 *
 * `blocks` is therefore **keyed by PageSlot name** (defined in the assigned
 * Layout). The default Layout exposes a single PageSlot named `'default'`,
 * so a Page created without a custom layout has `blocks: { default: [] }`.
 *
 * Flat surface (no `Document<TData>` wrapper in V1). The generic Document/Collection
 * structure exists internally (see `document.ts`) to prepare V2 headless but is
 * not exposed.
 */
export interface Page {
  id: string
  slug: string

  layoutId: LayoutId
  blocks: Record<string, Block[]>

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
