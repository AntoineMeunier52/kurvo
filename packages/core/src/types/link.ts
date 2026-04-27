export type Link =
  | { type: 'internal'; translationGroupId: string; anchor?: string }
  | { type: 'external'; url: string }
  | { type: 'anchor'; anchor: string }
  | { type: 'asset'; assetId: string }
  | null
