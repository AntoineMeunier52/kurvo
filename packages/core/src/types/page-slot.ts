/**
 * `PageSlot` is a built-in block type that lives inside a {@link Layout}'s tree.
 * It is a marker / placeholder — at render time, its position is replaced by
 * the corresponding `Page.blocks[name]` content.
 *
 * Constraints (enforced at the editor / save validation layer, not here):
 *   - A Layout must contain at least one `PageSlot`.
 *   - Each `name` must be unique within a Layout.
 *   - A `PageSlot` cannot be nested inside another `PageSlot`.
 *   - The user can only edit `PageSlot` blocks from the Layouts editor section,
 *     never from a Page's content edition.
 *
 * See [[Modele Layout]].
 */

/** Reserved `Block.type` value identifying a PageSlot marker block. */
export const PAGE_SLOT_BLOCK_TYPE = 'PageSlot'

/**
 * Shape of the `fields` object on a `PageSlot` block instance.
 *
 * Only `name` is meaningful — it links a position in a Layout's tree to a
 * keyed entry in a Page's `blocks: Record<string, Block[]>`.
 */
export interface PageSlotFields {
  name: string
}
