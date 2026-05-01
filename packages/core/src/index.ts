// @kurvo/core — public API surface
// TypeScript pure, zero Vue/DOM/Node deps.

export const VERSION = '0.1.0'

export type * from './types'
export {
  ROOT_BLOCK_ID,
  ROOT_SLOT_KEY,
  ROOT_SLOT_NAME,
  DEFAULT_LAYOUT_ID,
  DEFAULT_PAGE_SLOT_NAME,
  PAGE_SLOT_BLOCK_TYPE,
} from './types'

export { BlockTree } from './state/block-tree'
export { PageTree } from './state/page-tree'
export { History } from './state/history'
