import type { Block } from './block'

/** Unique identifier of a Layout. */
export type LayoutId = string

/**
 * A **Layout** is the editable structure shared across pages — typically the
 * header, footer, navbar, sidebar, sticky banners, etc. It contains a tree of
 * blocks with **at least one** `PageSlot` block (placeholder for the page
 * content).
 *
 * Pages reference a Layout via `Page.layoutId`. At render, the layout's tree is
 * walked, and each `PageSlot` is replaced by `page.blocks[pageSlot.fields.name]`.
 *
 * See [[Modele Layout]] for the full architecture.
 */
export interface Layout {
  id: LayoutId
  name: string
  blocks: Block[]

  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** Built-in default Layout id, used when a Page is created without choosing a custom layout. */
export const DEFAULT_LAYOUT_ID: LayoutId = 'default'

/** Built-in default PageSlot name, used by the default Layout. */
export const DEFAULT_PAGE_SLOT_NAME = 'default'
