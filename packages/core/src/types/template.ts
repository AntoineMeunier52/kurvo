import type { PageMeta } from './meta'

export interface TemplateDefinition<TData = unknown> {
  name: string
  label: string
  description?: string
  category?: string
  icon?: string
  preview?: string
  defaultData: TData
  defaultMeta?: PageMeta
}
