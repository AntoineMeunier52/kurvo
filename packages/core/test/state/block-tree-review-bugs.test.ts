import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import { effect } from '../../src/state/reactive'
import type { Block, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

// ─── Bug 1 — signal(parent).value must be live after a descendant update ──

describe('signal value freshness across the tree', () => {
  // The issue (flagged by review): updateFields on a leaf produces a fresh
  // ref for every ancestor via spine rebuild. The leaf's signal is updated,
  // but ancestor signals keep their OLD ref. A consumer reading
  // `tree.signal(ancestorId).value` then sees a stale Block whose
  // `slots[X][i]` still points to the OLD leaf ref.
  //
  // Two requirements to validate independently:
  //  a) `signal(ancestor).value` must read the LIVE ancestor block
  //     (consistent with `tree.get(ancestor)`).
  //  b) the signal does NOT TRIGGER on descendant-only changes (otherwise
  //     fine-grained reactivity is gone — the whole point of step 5).

  it('signal(ancestor).value reflects the new descendant after updateFields', () => {
    const tree = new BlockTree([
      blk('A', {}, { x: [blk('B', {}, { y: [blk('C', { v: 'old' })] })] }),
    ])
    const aSig = tree.signal('A')
    const bSig = tree.signal('B')

    tree.updateFields('C', { set: { v: 'new' } })

    // Reads through every ancestor must surface the new leaf, not a stale ref.
    expect(aSig.value?.slots?.x?.[0]?.slots?.y?.[0]?.fields).toEqual({ v: 'new' })
    expect(bSig.value?.slots?.y?.[0]?.fields).toEqual({ v: 'new' })
    // And consistent with tree.get
    expect(aSig.value).toBe(tree.get('A'))
    expect(bSig.value).toBe(tree.get('B'))
  })

  it('ancestor signals do NOT trigger their effect on descendant updateFields', () => {
    const tree = new BlockTree([
      blk('A', {}, { x: [blk('B', {}, { y: [blk('C', { v: 'old' })] })] }),
    ])
    let aFires = 0
    let bFires = 0
    let cFires = 0
    effect(() => {
      void tree.signal('A').value
      aFires++
    })
    effect(() => {
      void tree.signal('B').value
      bFires++
    })
    effect(() => {
      void tree.signal('C').value
      cFires++
    })
    const initialA = aFires
    const initialB = bFires
    const initialC = cFires

    tree.updateFields('C', { set: { v: 'new' } })

    expect(aFires - initialA).toBe(0)
    expect(bFires - initialB).toBe(0)
    expect(cFires - initialC).toBe(1)
  })
})

// ─── Bug 2 — reorder { from: i, to: i } must be a true no-op ─────────────

describe('reorder no-op preserves tree reference', () => {
  it('root from === to leaves blocks reference unchanged', () => {
    const tree = new BlockTree([blk('a'), blk('b'), blk('c')])
    const before = tree.blocks
    tree.reorder(ROOT_SLOT_KEY, 1, 1)
    expect(tree.blocks).toBe(before)
  })

  it('nested from === to leaves blocks reference unchanged', () => {
    const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b')] })])
    const before = tree.blocks
    tree.reorder('p:cells' as SlotKey, 0, 0)
    expect(tree.blocks).toBe(before)
  })

  it('nested from === to does not fire any signal', () => {
    const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b')] })])
    let pFires = 0
    let aFires = 0
    effect(() => {
      void tree.signal('p').value
      pFires++
    })
    effect(() => {
      void tree.signal('a').value
      aFires++
    })
    const initialP = pFires
    const initialA = aFires

    tree.reorder('p:cells' as SlotKey, 0, 0)

    expect(pFires - initialP).toBe(0)
    expect(aFires - initialA).toBe(0)
  })

  it('still validates bounds when from === to (out-of-bounds throws)', () => {
    const tree = new BlockTree([blk('p', {}, { cells: [] })])
    expect(() => tree.reorder('p:cells' as SlotKey, 0, 0)).toThrow(/out of bounds/)
  })

  it('still validates that the slot exists when from === to', () => {
    const tree = new BlockTree([blk('p')])
    expect(() => tree.reorder('p:nonexistent' as SlotKey, 0, 0)).toThrow(/not found|out of bounds/)
  })
})

// ─── Bug 3 — move within the same slot reorders correctly ────────────────

describe('move within the same slot', () => {
  it('move from index 0 to index 2 at root produces [B, C, A]', () => {
    const tree = new BlockTree([blk('A'), blk('B'), blk('C')])
    tree.move('A', { slot: ROOT_SLOT_KEY, index: 2 })
    expect(tree.blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
  })

  it('move from index 2 to index 0 at root produces [C, A, B]', () => {
    const tree = new BlockTree([blk('A'), blk('B'), blk('C')])
    tree.move('C', { slot: ROOT_SLOT_KEY, index: 0 })
    expect(tree.blocks.map((b) => b.id)).toEqual(['C', 'A', 'B'])
  })

  it('move within a nested slot reorders correctly', () => {
    const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b'), blk('c')] })])
    tree.move('a', { slot: 'p:cells' as SlotKey, index: 2 })
    expect(tree.get('p')?.slots?.cells?.map((b) => b.id)).toEqual(['b', 'c', 'a'])
  })

  it('inverse of intra-slot move restores the original order', () => {
    const tree = new BlockTree([blk('A'), blk('B'), blk('C')])
    const inverse = tree.move('A', { slot: ROOT_SLOT_KEY, index: 2 })
    expect(tree.blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
    tree.applyOp(inverse)
    expect(tree.blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
  })
})
