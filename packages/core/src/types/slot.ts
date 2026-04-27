import type { Block } from './block'

export interface SlotDefinition {
  accepts?: readonly string[]
  min?: number
  max?: number
  emptyState?: string
}

export type Slot = Block[]
