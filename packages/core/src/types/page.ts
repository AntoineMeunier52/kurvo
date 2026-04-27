import type { Block } from './block'
import type { Document } from './document'

export interface PageData {
  slug: string
  root: { props: Record<string, unknown> }
  blocks: Block[]
}

export type Page = Document<PageData>
