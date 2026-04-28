export type BlockId = string

export interface Block {
  id: BlockId
  type: string
  fields: Record<string, unknown>
  slots?: Record<string, Block[]>
}
