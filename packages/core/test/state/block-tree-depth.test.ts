import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import { PageTree } from '../../src/state/page-tree'
import type { Block, BlockId, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/**
 * Walk the canonical tree to compute depth from scratch — used as the
 * source of truth in invariant assertions.
 */
const computeDepths = (blocks: Block[]): Map<BlockId, number> => {
  const out = new Map<BlockId, number>()
  const walk = (arr: Block[], depth: number): void => {
    for (const b of arr) {
      out.set(b.id, depth)
      if (b.slots) {
        for (const children of Object.values(b.slots)) walk(children, depth + 1)
      }
    }
  }
  walk(blocks, 0)
  return out
}

const expectDepthsMatchTree = (tree: BlockTree): void => {
  const expected = computeDepths(tree.serialize())
  for (const [id, expectedDepth] of expected) {
    expect(tree.depth(id)).toBe(expectedDepth)
  }
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('BlockTree.depth', () => {
  describe('initial indexing', () => {
    it('returns 0 for a root-level block', () => {
      const tree = new BlockTree([blk('a')])
      expect(tree.depth('a')).toBe(0)
    })

    it('returns parent.depth + 1 for nested blocks', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('child')] })])
      expect(tree.depth('p')).toBe(0)
      expect(tree.depth('child')).toBe(1)
    })

    it('returns null for unknown ids', () => {
      const tree = new BlockTree([blk('a')])
      expect(tree.depth('ghost')).toBeNull()
    })

    it('counts five levels correctly on a deeply nested tree', () => {
      const deep = blk(
        'lvl0',
        {},
        {
          x: [
            blk(
              'lvl1',
              {},
              {
                x: [
                  blk(
                    'lvl2',
                    {},
                    {
                      x: [
                        blk(
                          'lvl3',
                          {},
                          {
                            x: [blk('lvl4')],
                          },
                        ),
                      ],
                    },
                  ),
                ],
              },
            ),
          ],
        },
      )
      const tree = new BlockTree([deep])
      expect(tree.depth('lvl0')).toBe(0)
      expect(tree.depth('lvl1')).toBe(1)
      expect(tree.depth('lvl2')).toBe(2)
      expect(tree.depth('lvl3')).toBe(3)
      expect(tree.depth('lvl4')).toBe(4)
    })
  })

  describe('depth maintenance after each mutation', () => {
    it('insert at root: new block has depth 0', () => {
      const tree = new BlockTree([blk('a')])
      tree.insert(blk('b'), { slot: ROOT_SLOT_KEY })
      expect(tree.depth('b')).toBe(0)
    })

    it('insert nested: new block has parent.depth + 1', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [] })])
      tree.insert(blk('child'), { slot: 'p:cta' as SlotKey })
      expect(tree.depth('child')).toBe(1)
    })

    it('insert with descendants: every descendant gets the right depth', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [] })])
      tree.insert(blk('outer', {}, { inner: [blk('a'), blk('b', {}, { z: [blk('deep')] })] }), {
        slot: 'p:cta' as SlotKey,
      })
      expect(tree.depth('outer')).toBe(1)
      expect(tree.depth('a')).toBe(2)
      expect(tree.depth('b')).toBe(2)
      expect(tree.depth('deep')).toBe(3)
    })

    it('remove drops the depth entry', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('a')] })])
      tree.remove('a')
      expect(tree.depth('a')).toBeNull()
    })

    it('move cross-parent updates depth to match the new parent', () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('x')] }),
        blk('p2', {}, { wrap: [blk('inner', {}, { cells: [] })] }),
      ])
      // p2 = depth 0, inner = 1, inner.cells children = depth 2.
      // x was at depth 1 (inside p1.cta); after move into inner.cells → depth 2.
      tree.move('x', { slot: 'inner:cells' as SlotKey, index: 0 })
      expect(tree.depth('x')).toBe(2)
    })

    it('move from nested to root: depth becomes 0', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('a')] })])
      tree.move('a', { slot: ROOT_SLOT_KEY })
      expect(tree.depth('a')).toBe(0)
    })

    it("move preserves descendants' relative depths (no manual update needed)", () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('m', {}, { inner: [blk('m1', {}, { x: [blk('m1a')] })] })] }),
        blk('p2', {}, { wrap: [] }),
      ])
      // Before move: m=1, m1=2, m1a=3.
      // After move(m → p2.wrap): m=1 (depth of p2 + 1), m1=2, m1a=3. Same relative depths.
      tree.move('m', { slot: 'p2:wrap' as SlotKey })
      expect(tree.depth('m')).toBe(1)
      expect(tree.depth('m1')).toBe(2)
      expect(tree.depth('m1a')).toBe(3)
    })

    it('reorder does not change depths', () => {
      const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b'), blk('c')] })])
      tree.reorder('p:cells' as SlotKey, 0, 2)
      expect(tree.depth('a')).toBe(1)
      expect(tree.depth('b')).toBe(1)
      expect(tree.depth('c')).toBe(1)
    })

    it('replace keepChildren: depth of replaced + descendants unchanged', () => {
      const tree = new BlockTree([
        blk('p', {}, { cta: [blk('a', { v: 'old' }, { inner: [blk('a1')] })] }),
      ])
      tree.replace('a', blk('a', { v: 'new' }), { keepChildren: true })
      expect(tree.depth('a')).toBe(1)
      expect(tree.depth('a1')).toBe(2)
    })

    it('replace !keepChildren: new descendants get correct depths', () => {
      const tree = new BlockTree([
        blk('p', {}, { cta: [blk('a', {}, { inner: [blk('oldChild')] })] }),
      ])
      tree.replace('a', blk('a', {}, { fresh: [blk('newChild', {}, { x: [blk('deepNew')] })] }))
      expect(tree.depth('a')).toBe(1)
      expect(tree.depth('newChild')).toBe(2)
      expect(tree.depth('deepNew')).toBe(3)
      expect(tree.depth('oldChild')).toBeNull()
    })

    it('updateFields does not perturb depths', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('a', {}, { inner: [blk('a1')] })] })])
      tree.updateFields('a1', { set: { v: 1 } })
      expect(tree.depth('a')).toBe(1)
      expect(tree.depth('a1')).toBe(2)
    })
  })

  describe('depth stays coherent across long op sequences', () => {
    it('matches a fresh full-walk depth computation after every op', () => {
      const tree = new BlockTree([
        blk('A', {}, { x: [blk('A1'), blk('A2', {}, { y: [blk('A2a'), blk('A2b')] })] }),
        blk('B'),
        blk('C', {}, { z: [blk('C1')] }),
      ])

      // Run a deterministic mix of ops, checking the invariant after each.
      tree.insert(blk('D'), { slot: ROOT_SLOT_KEY })
      expectDepthsMatchTree(tree)

      tree.insert(blk('A2c', {}, { i: [blk('A2cI')] }), { slot: 'A2:y' as SlotKey })
      expectDepthsMatchTree(tree)

      tree.move('A1', { slot: 'A2:y' as SlotKey, index: 0 })
      expectDepthsMatchTree(tree)

      tree.replace('B', blk('B', {}, { sec: [blk('B1'), blk('B2')] }))
      expectDepthsMatchTree(tree)

      tree.reorder('A2:y' as SlotKey, 0, 2)
      expectDepthsMatchTree(tree)

      tree.remove('C')
      expectDepthsMatchTree(tree)

      tree.updateFields('A2cI', { set: { x: 1 } })
      expectDepthsMatchTree(tree)
    })
  })
})

describe('PageTree.depth', () => {
  it('returns the depth in whichever slot the id lives', () => {
    const page = new PageTree({
      header: [blk('h1')],
      main: [blk('p', {}, { cta: [blk('m1')] })],
    })
    expect(page.depth('h1')).toBe(0)
    expect(page.depth('p')).toBe(0)
    expect(page.depth('m1')).toBe(1)
  })

  it('returns null for ids not in any slot', () => {
    const page = new PageTree({ main: [blk('a')] })
    expect(page.depth('ghost')).toBeNull()
  })

  it('updates after mutations dispatched through PageTree', () => {
    const page = new PageTree({
      main: [blk('p', {}, { cta: [] })],
    })
    page.insert('main', blk('child'), { slot: 'p:cta' as SlotKey })
    expect(page.depth('child')).toBe(1)
    page.remove('child')
    expect(page.depth('child')).toBeNull()
  })
})
