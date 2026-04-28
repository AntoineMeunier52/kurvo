import type { AssetRef } from './asset'

export interface SeoMeta {
  metaTitle?: string
  metaDescription?: string
  canonical?: string
  robots?: 'index,follow' | 'noindex' | 'noindex,nofollow'
}

export interface OgMeta {
  ogTitle?: string
  ogDescription?: string
  ogImage?: AssetRef
  ogType?: 'website' | 'article'
}

export interface PageMeta {
  seo?: SeoMeta
  og?: OgMeta
}
