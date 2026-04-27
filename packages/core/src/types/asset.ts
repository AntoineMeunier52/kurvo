export interface Asset {
  id: string
  filename: string
  mime: string
  size: number
  url: string
  storageKey: string
  alt: string | null
  width: number | null
  height: number | null
  duration: number | null
  createdAt: number
  uploadedBy: string | null
}

export type AssetRef = { assetId: string } | null
