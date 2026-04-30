import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import type { Block, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/**
 * Probe the index by attempting another op that depends on the index being
 * correct (the locator is bound to `_nodes`). If indices are wrong, follow-up
 * ops corrupt the tree or throw — both detectable.
 */
const triggerLocatorPath = (tree: BlockTree, id: string): void => {
  // updateFields uses the locator → spine rebuild → asserts chain consistency.
  tree.updateFields(id, { set: { __probe: 1 } })
  tree.updateFields(id, { unset: ['__probe'] })
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('BlockTree: incremental index after each op', () => {
  describe('insert', () => {
    it('shifts existing siblings correctly when inserting at the front', () => {
      const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b'), blk('c')] })])
      tree.insert(blk('z'), { slot: 'p:cells', index: 0 })

      // Indices should now be: z=0, a=1, b=2, c=3.
      // The locator is the only consumer of `index` we can probe externally —
      // any subsequent op that walks the spine of these siblings will throw
      // "locator inconsistent" if the indices are stale.
      triggerLocatorPath(tree, 'a')
      triggerLocatorPath(tree, 'b')
      triggerLocatorPath(tree, 'c')
      triggerLocatorPath(tree, 'z')

      // And the canonical tree shape is correct.
      const cells = tree.serialize()[0]?.slots?.cells ?? []
      expect(cells.map((b) => b.id)).toEqual(['z', 'a', 'b', 'c'])
    })

    it('indexes new descendants of an inserted subtree', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [] })])
      tree.insert(blk('parent', {}, { inner: [blk('child1'), blk('child2')] }), {
        slot: 'p:cta',
      })

      expect(tree.has('parent')).toBe(true)
      expect(tree.has('child1')).toBe(true)
      expect(tree.has('child2')).toBe(true)
      expect(tree.getParent('child1')?.id).toBe('parent')
      expect(tree.getPath('child2')).toEqual([
        ROOT_SLOT_KEY,
        'p:cta' as SlotKey,
        'parent:inner' as SlotKey,
      ])

      triggerLocatorPath(tree, 'child1')
      triggerLocatorPath(tree, 'child2')
    })
  })

  describe('remove', () => {
    it('shifts surviving siblings correctly', () => {
      const tree = new BlockTree([
        blk('p', {}, { cells: [blk('a'), blk('b'), blk('c'), blk('d')] }),
      ])
      tree.remove('b')

      // Indices should now be: a=0, c=1, d=2.
      triggerLocatorPath(tree, 'a')
      triggerLocatorPath(tree, 'c')
      triggerLocatorPath(tree, 'd')
      expect(tree.has('b')).toBe(false)
    })

    it('drops every descendant of the removed subtree from the index', () => {
      const tree = new BlockTree([
        blk('p', {}, { cells: [blk('a', {}, { inner: [blk('a1'), blk('a2')] })] }),
      ])
      tree.remove('a')
      expect(tree.has('a')).toBe(false)
      expect(tree.has('a1')).toBe(false)
      expect(tree.has('a2')).toBe(false)
      expect(tree.size).toBe(1) // only `p` remains
    })
  })

  describe('reorder', () => {
    it('updates indices for every block in [min(from,to), max(from,to)]', () => {
      const tree = new BlockTree([
        blk('p', {}, { cells: [blk('a'), blk('b'), blk('c'), blk('d')] }),
      ])
      tree.reorder('p:cells' as SlotKey, 0, 2)
      // After reorder: b=0, c=1, a=2, d=3.
      const cells = tree.serialize()[0]?.slots?.cells ?? []
      expect(cells.map((b) => b.id)).toEqual(['b', 'c', 'a', 'd'])
      // Locator round-trip on each of the affected ids.
      triggerLocatorPath(tree, 'a')
      triggerLocatorPath(tree, 'b')
      triggerLocatorPath(tree, 'c')
      triggerLocatorPath(tree, 'd')
    })
  })

  describe('move', () => {
    it('updates the moved block + both parents on cross-parent move', () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('x'), blk('y')] }),
        blk('p2', {}, { cta: [blk('z')] }),
      ])
      tree.move('x', { slot: 'p2:cta' as SlotKey, index: 0 })

      expect(tree.getParent('x')?.id).toBe('p2')
      expect(tree.getPath('x')).toEqual([ROOT_SLOT_KEY, 'p2:cta' as SlotKey])
      // p1's surviving child `y` shifted from index 1 to 0.
      triggerLocatorPath(tree, 'y')
      // p2's existing child `z` shifted from index 0 to 1.
      triggerLocatorPath(tree, 'z')
    })

    it('descendants of a moved block stay in the index with stable parentId', () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('m', {}, { inner: [blk('m1')] })] }),
        blk('p2', {}, { cta: [] }),
      ])
      tree.move('m', { slot: 'p2:cta' as SlotKey })

      expect(tree.has('m1')).toBe(true)
      expect(tree.getParent('m1')?.id).toBe('m')
      // m1 is still reachable via the locator path (its chain root → p2 → m → m1
      // must be coherent).
      triggerLocatorPath(tree, 'm1')
    })
  })

  describe('replace', () => {
    it('keepChildren: keeps descendants in the index', () => {
      const tree = new BlockTree([
        blk('p', {}, { cta: [blk('a', { v: 'old' }, { inner: [blk('a1')] })] }),
      ])
      tree.replace('a', blk('a', { v: 'new' }), { keepChildren: true })

      expect(tree.has('a1')).toBe(true)
      expect(tree.getParent('a1')?.id).toBe('a')
      expect(tree.get('a')?.fields).toEqual({ v: 'new' })
    })

    it('!keepChildren: drops old descendants, indexes new ones', () => {
      const tree = new BlockTree([
        blk('p', {}, { cta: [blk('a', {}, { inner: [blk('oldChild')] })] }),
      ])
      tree.replace('a', blk('a', {}, { inner: [blk('newChild1'), blk('newChild2')] }))

      expect(tree.has('oldChild')).toBe(false)
      expect(tree.has('newChild1')).toBe(true)
      expect(tree.has('newChild2')).toBe(true)
      expect(tree.getParent('newChild1')?.id).toBe('a')
      triggerLocatorPath(tree, 'newChild2')
    })

    it('!keepChildren with disjoint slot maps: cleans up old slots', () => {
      const tree = new BlockTree([
        blk('a', {}, { gone: [blk('willGo')], shared: [blk('alsoGone')] }),
      ])
      tree.replace('a', blk('a', {}, { fresh: [blk('willStay')] }))

      expect(tree.has('willGo')).toBe(false)
      expect(tree.has('alsoGone')).toBe(false)
      expect(tree.has('willStay')).toBe(true)
    })

    it('!keepChildren with completely renamed slots: new descendants get correct path', () => {
      // Old block has `items`, new block has `sections`. The patch routine
      // must (a) drop ids from the old slot via `affected.removed` and
      // (b) reindex only the new slot — getPath of new descendants must
      // reflect the new slot name, not the old one.
      const tree = new BlockTree([blk('X', {}, { items: [blk('a'), blk('b')] })])
      tree.replace('X', blk('X', {}, { sections: [blk('c')] }))
      expect(tree.has('a')).toBe(false)
      expect(tree.has('b')).toBe(false)
      expect(tree.has('c')).toBe(true)
      expect(tree.getPath('c')).toEqual([ROOT_SLOT_KEY, 'X:sections' as SlotKey])
    })
  })

  describe('updateFields', () => {
    it('does not perturb sibling indices', () => {
      const tree = new BlockTree([blk('p', {}, { cells: [blk('a'), blk('b'), blk('c')] })])
      tree.updateFields('b', { set: { v: 1 } })
      triggerLocatorPath(tree, 'a')
      triggerLocatorPath(tree, 'b')
      triggerLocatorPath(tree, 'c')
    })

    it('reflects the new fields content via get()', () => {
      const tree = new BlockTree([blk('a', { x: 1 })])
      tree.updateFields('a', { set: { x: 2, y: 'hi' } })
      expect(tree.get('a')?.fields).toEqual({ x: 2, y: 'hi' })
    })
  })

  describe('chained ops keep the index consistent', () => {
    it('survives a long sequence mixing every op type', () => {
      const tree = new BlockTree([
        blk('p1', {}, { cells: [blk('a'), blk('b')] }),
        blk('p2', {}, { cells: [] }),
      ])
      tree.insert(blk('c'), { slot: 'p1:cells' as SlotKey })
      tree.move('a', { slot: 'p2:cells' as SlotKey })
      tree.reorder('p1:cells' as SlotKey, 0, 1)
      tree.updateFields('c', { set: { x: 1 } })
      tree.replace('b', blk('b', { renamed: true }), { keepChildren: false })
      tree.remove('p2')

      // p2 and its content gone.
      expect(tree.has('p2')).toBe(false)
      expect(tree.has('a')).toBe(false)
      // Remaining state is coherent.
      expect(tree.has('p1')).toBe(true)
      expect(tree.has('b')).toBe(true)
      expect(tree.has('c')).toBe(true)
      triggerLocatorPath(tree, 'b')
      triggerLocatorPath(tree, 'c')
    })
  })

  describe('reads stay in sync with the canonical tree', () => {
    // Regression: the previous implementation cached `block` refs in BlockNode
    // and only refreshed them for ids in `affected.updated` — which excluded
    // ancestors above the immediate parent. Reading a parent's slots after
    // a spine-rebuild op (replace, updateFields, reorder, …) returned stale
    // children. Now that reads walk the live tree, every read is fresh.

    it('replace: reading the parent gives the new replaced child', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('a', { v: 'old' })] })])
      tree.replace('a', blk('a', { v: 'new' }))
      const parent = tree.get('p')
      expect(parent?.slots?.cta?.[0]?.fields).toEqual({ v: 'new' })
    })

    it('updateFields on a deeply nested leaf: every ancestor read is fresh', () => {
      const tree = new BlockTree([
        blk('gp', {}, { x: [blk('p', {}, { y: [blk('child', { v: 'old' })] })] }),
      ])
      tree.updateFields('child', { set: { v: 'new' } })
      // Reading any ancestor's slot must surface the new leaf, not a stale ref.
      expect(tree.get('p')?.slots?.y?.[0]?.fields).toEqual({ v: 'new' })
      expect(tree.get('gp')?.slots?.x?.[0]?.slots?.y?.[0]?.fields).toEqual({
        v: 'new',
      })
    })

    it('reorder: reading the parent surfaces the new order', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('a'), blk('b'), blk('c')] })])
      tree.reorder('p:cta' as SlotKey, 0, 2)
      expect(tree.get('p')?.slots?.cta?.map((b) => b.id)).toEqual(['b', 'c', 'a'])
    })
  })
})
