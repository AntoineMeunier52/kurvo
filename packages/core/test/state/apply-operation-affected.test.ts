import { describe, expect, it } from 'vitest'

import { applyOperation } from '../../src/state/apply-operation'
import type { AffectedBlocks, Block, TreeOperation } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/**
 * Compare two AffectedBlocks ignoring order within each category.
 * Each category is a set: ordering is not part of the contract.
 */
const expectAffected = (actual: AffectedBlocks, expected: Partial<AffectedBlocks>): void => {
  const sortKey = (a: string, b: string): number => a.localeCompare(b)
  const defaults: AffectedBlocks = { created: [], removed: [], updated: [], moved: [] }
  const merged = { ...defaults, ...expected }
  expect([...actual.created].sort(sortKey)).toEqual([...merged.created].sort(sortKey))
  expect([...actual.removed].sort(sortKey)).toEqual([...merged.removed].sort(sortKey))
  expect([...actual.updated].sort(sortKey)).toEqual([...merged.updated].sort(sortKey))
  expect([...actual.moved].sort(sortKey)).toEqual([...merged.moved].sort(sortKey))
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('applyOperation: affected', () => {
  describe('updateFields', () => {
    it('marks the block as updated, nothing else', () => {
      const tree = [blk('a', { v: 1 })]
      const { affected } = applyOperation(tree, {
        op: 'updateFields',
        id: 'a',
        set: { v: 2 },
      })
      expectAffected(affected, { updated: ['a'] })
    })

    it('marks updated even when the patch is empty (no set/no unset)', () => {
      // No-op semantically, but the block reference still gets re-allocated by
      // the updater (a fresh `{ ...block, fields: {...} }` is produced).
      const tree = [blk('a', { v: 1 })]
      const { affected } = applyOperation(tree, { op: 'updateFields', id: 'a' })
      expectAffected(affected, { updated: ['a'] })
    })

    it('does not include parent or descendants', () => {
      const tree = [blk('p', {}, { cta: [blk('a', { v: 1 }, { inner: [blk('a1')] })] })]
      const { affected } = applyOperation(tree, {
        op: 'updateFields',
        id: 'a',
        set: { v: 2 },
      })
      expectAffected(affected, { updated: ['a'] })
    })
  })

  describe('insert', () => {
    it('marks the inserted block as created (root insert: no parent updated)', () => {
      const tree = [blk('a')]
      const { affected } = applyOperation(tree, {
        op: 'insert',
        block: blk('b'),
        target: { slot: ROOT_SLOT_KEY },
      })
      expectAffected(affected, { created: ['b'] })
    })

    it('marks the inserted subtree as created and the parent as updated', () => {
      const tree = [blk('p', {}, { cta: [] })]
      const inserted = blk('new', {}, { inner: [blk('child1'), blk('child2')] })
      const { affected } = applyOperation(tree, {
        op: 'insert',
        block: inserted,
        target: { slot: 'p:cta' },
      })
      expectAffected(affected, {
        created: ['new', 'child1', 'child2'],
        updated: ['p'],
      })
    })

    it('flat insert into nested slot: created has just the inserted id', () => {
      const tree = [blk('p', {}, { cta: [] })]
      const { affected } = applyOperation(tree, {
        op: 'insert',
        block: blk('x'),
        target: { slot: 'p:cta' },
      })
      expectAffected(affected, { created: ['x'], updated: ['p'] })
    })
  })

  describe('remove', () => {
    it('marks the removed block as removed (root remove: no parent updated)', () => {
      const tree = [blk('a'), blk('b')]
      const { affected } = applyOperation(tree, { op: 'remove', id: 'a' })
      expectAffected(affected, { removed: ['a'] })
    })

    it('marks the entire removed subtree as removed and the parent as updated', () => {
      const tree = [blk('p', {}, { cta: [blk('a', {}, { inner: [blk('a1'), blk('a2')] })] })]
      const { affected } = applyOperation(tree, { op: 'remove', id: 'a' })
      expectAffected(affected, {
        removed: ['a', 'a1', 'a2'],
        updated: ['p'],
      })
    })
  })

  describe('reorder', () => {
    it('root reorder: moves contains every id between from and to, no updated', () => {
      const tree = [blk('a'), blk('b'), blk('c'), blk('d')]
      const { affected } = applyOperation(tree, {
        op: 'reorder',
        slot: ROOT_SLOT_KEY,
        from: 0,
        to: 2,
      })
      // Indices 0..2 all see their position change → a, b, c moved. d unchanged.
      expectAffected(affected, { moved: ['a', 'b', 'c'] })
    })

    it('nested reorder: marks parent updated and the affected ids as moved', () => {
      const tree = [blk('p', {}, { cells: [blk('x'), blk('y'), blk('z')] })]
      const { affected } = applyOperation(tree, {
        op: 'reorder',
        slot: 'p:cells',
        from: 0,
        to: 2,
      })
      expectAffected(affected, {
        updated: ['p'],
        moved: ['x', 'y', 'z'],
      })
    })

    it('from === to is a true no-op: empty affected', () => {
      const tree = [blk('p', {}, { cells: [blk('x'), blk('y')] })]
      const { affected } = applyOperation(tree, {
        op: 'reorder',
        slot: 'p:cells',
        from: 1,
        to: 1,
      })
      expectAffected(affected, {})
    })

    it('reorder of adjacent neighbours: only the two swapped ids are moved', () => {
      const tree = [blk('p', {}, { cells: [blk('x'), blk('y'), blk('z')] })]
      const { affected } = applyOperation(tree, {
        op: 'reorder',
        slot: 'p:cells',
        from: 0,
        to: 1,
      })
      expectAffected(affected, { updated: ['p'], moved: ['x', 'y'] })
    })
  })

  describe('replace', () => {
    it('keepChildren: only the block id is updated, no created/removed', () => {
      const tree = [blk('a', { v: 'old' }, { cta: [blk('child')] })]
      const { affected } = applyOperation(tree, {
        op: 'replace',
        id: 'a',
        block: blk('a', { v: 'new' }),
        keepChildren: true,
      })
      expectAffected(affected, { updated: ['a'] })
    })

    it('!keepChildren: old subtree removed, new subtree created, block updated', () => {
      const tree = [blk('a', {}, { cta: [blk('oldChild1'), blk('oldChild2')] })]
      const { affected } = applyOperation(tree, {
        op: 'replace',
        id: 'a',
        block: blk('a', {}, { cta: [blk('newChild1')] }),
      })
      expectAffected(affected, {
        updated: ['a'],
        removed: ['oldChild1', 'oldChild2'],
        created: ['newChild1'],
      })
    })

    it('!keepChildren with no old children and no new children: just updated', () => {
      const tree = [blk('a', { v: 'old' })]
      const { affected } = applyOperation(tree, {
        op: 'replace',
        id: 'a',
        block: blk('a', { v: 'new' }),
      })
      expectAffected(affected, { updated: ['a'] })
    })

    it("!keepChildren never lists the block's own id in created or removed", () => {
      const tree = [blk('a', {}, { cta: [blk('c1')] })]
      const { affected } = applyOperation(tree, {
        op: 'replace',
        id: 'a',
        block: blk('a', {}, { cta: [blk('c2')] }),
      })
      expect(affected.created).not.toContain('a')
      expect(affected.removed).not.toContain('a')
      expect(affected.updated).toContain('a')
    })
  })

  describe('move', () => {
    it('intra-slot move: id moved, parent updated once', () => {
      const tree = [blk('p', {}, { cta: [blk('x'), blk('y'), blk('z')] })]
      const { affected } = applyOperation(tree, {
        op: 'move',
        id: 'x',
        target: { slot: 'p:cta', index: 2 },
      })
      expectAffected(affected, { moved: ['x'], updated: ['p'] })
    })

    it('cross-parent move: id moved, both old and new parents updated', () => {
      const tree = [
        blk('p1', {}, { cta: [blk('x'), blk('y')] }),
        blk('p2', {}, { cta: [blk('z')] }),
      ]
      const { affected } = applyOperation(tree, {
        op: 'move',
        id: 'x',
        target: { slot: 'p2:cta', index: 0 },
      })
      expectAffected(affected, { moved: ['x'], updated: ['p1', 'p2'] })
    })

    it('move from root to nested: id moved, only new parent updated', () => {
      const tree = [blk('a'), blk('p', {}, { cta: [] })]
      const { affected } = applyOperation(tree, {
        op: 'move',
        id: 'a',
        target: { slot: 'p:cta', index: 0 },
      })
      expectAffected(affected, { moved: ['a'], updated: ['p'] })
    })

    it('move from nested to root: id moved, only old parent updated', () => {
      const tree = [blk('p', {}, { cta: [blk('a')] })]
      const { affected } = applyOperation(tree, {
        op: 'move',
        id: 'a',
        target: { slot: ROOT_SLOT_KEY, index: 0 },
      })
      expectAffected(affected, { moved: ['a'], updated: ['p'] })
    })

    it('root → root reorder via move: id moved, no parent updated', () => {
      const tree = [blk('a'), blk('b'), blk('c')]
      const { affected } = applyOperation(tree, {
        op: 'move',
        id: 'a',
        target: { slot: ROOT_SLOT_KEY, index: 2 },
      })
      expectAffected(affected, { moved: ['a'] })
    })
  })

  describe('shape contract', () => {
    it('every op returns an AffectedBlocks with all four arrays defined', () => {
      const ops: TreeOperation[] = [
        { op: 'updateFields', id: 'a', set: { v: 1 } },
        { op: 'insert', block: blk('z'), target: { slot: ROOT_SLOT_KEY } },
        { op: 'remove', id: 'a' },
        { op: 'reorder', slot: ROOT_SLOT_KEY, from: 0, to: 1 },
        { op: 'replace', id: 'a', block: blk('a', { v: 2 }) },
        { op: 'move', id: 'a', target: { slot: ROOT_SLOT_KEY, index: 1 } },
      ]
      for (const op of ops) {
        const tree = [blk('a'), blk('b')]
        const { affected } = applyOperation(tree, op)
        expect(Array.isArray(affected.created)).toBe(true)
        expect(Array.isArray(affected.removed)).toBe(true)
        expect(Array.isArray(affected.updated)).toBe(true)
        expect(Array.isArray(affected.moved)).toBe(true)
      }
    })
  })
})
