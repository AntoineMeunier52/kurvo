import type { DocumentMeta } from './meta'

export interface TemplateDefinition<TData = unknown> {
  name: string
  label: string
  description?: string
  category?: string
  icon?: string
  preview?: string
  collection?: string
  defaultData: TData
  defaultMeta?: DocumentMeta
}
