export type RedirectStatusCode = 301 | 302 | 307 | 308

export interface Redirect {
  id: string
  fromSlug: string
  toSlug: string
  statusCode: RedirectStatusCode
  createdAt: number
  reason: 'auto' | 'manual'
}
