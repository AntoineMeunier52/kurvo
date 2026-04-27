export type BlockId = string

export interface Block {
  id: BlockId
  type: string
  props: Record<string, unknown>
  slots?: Record<string, Block[]>
}
