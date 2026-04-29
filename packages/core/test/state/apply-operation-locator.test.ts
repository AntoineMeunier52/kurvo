import { describe, expect, it } from 'vitest'

import { applyOperation } from '../../src/state/apply-operation'
import type { Block, Locator, LocatorInfo, TreeOperation } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

const at = <T>(arr: readonly T[], i: number): T => {
  const item = arr[i]
  if (item === undefined) throw new Error(`expected array index ${i} to be defined`)
  return item
}

/**
 * Build a locator by walking the tree and indexing every block. Mimics what BlockTree does.
 */
const buildLocator = (blocks: Block[]): Locator => {
  const index = new Map<string, LocatorInfo>()
  const walk = (arr: Block[], parentId: string | null, slot: string | null): void => {
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i]
      if (!b) continue
      index.set(b.id, { parentId, slot, index: i })
      if (b.slots) {
        for (const [name, children] of Object.entries(b.slots)) {
          walk(children, b.id, name)
        }
      }
    }
  }
  walk(blocks, null, null)
  return (id) => index.get(id) ?? null
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('applyOperation with Locator', () => {
  describe('parity with walk-based path', () => {
    // For each op, verify that applyOperation(blocks, op, locator) produces an output
    // deeply equal to applyOperation(blocks, op) — locator is a perf optimization, not
    // a behavioral change.

    it('updateFields: same result with and without locator', () => {
      const tree = [blk('a', { x: 1 }, { cta: [blk('b', { y: 'old' })] })]
      const op: TreeOperation = { op: 'updateFields', id: 'b', set: { y: 'new' } }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('replace: same result with and without locator', () => {
      const tree = [blk('a', { x: 1 }, { cta: [blk('b', { y: 'old' })] })]
      const op: TreeOperation = {
        op: 'replace',
        id: 'b',
        block: blk('b', { y: 'replaced' }),
      }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('remove: same result with and without locator', () => {
      const tree = [blk('a', {}, { cta: [blk('b'), blk('c')] })]
      const op: TreeOperation = { op: 'remove', id: 'b' }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('insert nested: same result with and without locator', () => {
      const tree = [blk('p', {}, { cells: [blk('x')] })]
      const op: TreeOperation = {
        op: 'insert',
        block: blk('y'),
        target: { slot: 'p:cells', index: 1 },
      }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('insert at root with locator: behaves identically (locator unused for root)', () => {
      const tree = [blk('a')]
      const op: TreeOperation = {
        op: 'insert',
        block: blk('b'),
        target: { slot: ROOT_SLOT_KEY },
      }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('reorder nested: same result with and without locator', () => {
      const tree = [blk('p', {}, { cells: [blk('x'), blk('y'), blk('z')] })]
      const op: TreeOperation = { op: 'reorder', slot: 'p:cells', from: 0, to: 2 }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })

    it('move cross-parent: same result with and without locator', () => {
      const tree = [
        blk('p1', {}, { cta: [blk('x'), blk('y')] }),
        blk('p2', {}, { cta: [blk('z')] }),
      ]
      const op: TreeOperation = {
        op: 'move',
        id: 'x',
        target: { slot: 'p2:cta', index: 0 },
      }

      const walk = applyOperation(tree, op)
      const spine = applyOperation(tree, op, buildLocator(tree))

      expect(spine.blocks).toEqual(walk.blocks)
      expect(spine.inverse).toEqual(walk.inverse)
    })
  })

  describe('locator drives behavior on missing ids', () => {
    it('throws "block not found" when locator returns null (does NOT fall back to walk)', () => {
      const tree = [blk('a')]
      // A locator that never finds anything — even though the block IS in the tree,
      // applyOperation must trust the locator and throw.
      const blindLocator: Locator = () => null

      expect(() =>
        applyOperation(tree, { op: 'updateFields', id: 'a', set: { x: 1 } }, blindLocator),
      ).toThrow(/block "a" not found/)
    })

    it('throws on remove when locator returns null', () => {
      const tree = [blk('a'), blk('b')]
      const blindLocator: Locator = () => null
      expect(() => applyOperation(tree, { op: 'remove', id: 'a' }, blindLocator)).toThrow(
        /block "a" not found/,
      )
    })

    it('throws on move when source not located', () => {
      const tree = [blk('a'), blk('b')]
      const blindLocator: Locator = () => null
      expect(() =>
        applyOperation(
          tree,
          { op: 'move', id: 'a', target: { slot: ROOT_SLOT_KEY, index: 1 } },
          blindLocator,
        ),
      ).toThrow(/block "a" not found/)
    })
  })

  describe('inconsistent locator detection', () => {
    it('detects when locator points to wrong index', () => {
      const tree = [blk('a'), blk('b'), blk('c')]
      // Locator says 'a' is at index 2 but it's actually at 0.
      const wrongLocator: Locator = (id) => {
        if (id === 'a') return { parentId: null, slot: null, index: 2 }
        return null
      }

      expect(() =>
        applyOperation(tree, { op: 'updateFields', id: 'a', set: { x: 1 } }, wrongLocator),
      ).toThrow(/locator inconsistent/)
    })

    it('detects when locator points to wrong slot', () => {
      const tree = [blk('p', {}, { cta: [blk('child')] })]
      // Locator says 'child' is in 'wrongSlot' but it's actually in 'cta'.
      const wrongLocator: Locator = (id) => {
        if (id === 'child') return { parentId: 'p', slot: 'wrongSlot', index: 0 }
        if (id === 'p') return { parentId: null, slot: null, index: 0 }
        return null
      }

      expect(() =>
        applyOperation(tree, { op: 'updateFields', id: 'child', set: { v: 1 } }, wrongLocator),
      ).toThrow(/locator inconsistent|has no slot/)
    })

    it('detects when locator chain is broken (parent not found)', () => {
      const tree = [blk('p', {}, { cta: [blk('child')] })]
      // 'child' has parent 'p' but locator returns null for 'p'.
      const brokenLocator: Locator = (id) => {
        if (id === 'child') return { parentId: 'p', slot: 'cta', index: 0 }
        return null
      }

      expect(() =>
        applyOperation(tree, { op: 'updateFields', id: 'child', set: { v: 1 } }, brokenLocator),
      ).toThrow(/block "child" not found/)
    })
  })

  describe('round-trip with locator', () => {
    it('applies op + inverse through the locator path and gets the original tree', () => {
      const tree = [blk('a', { v: 1 }, { cta: [blk('child', { c: 2 })] }), blk('b')]
      const locator = buildLocator(tree)
      const op: TreeOperation = { op: 'remove', id: 'a' }

      const { blocks: afterOp, inverse } = applyOperation(tree, op, locator)
      // For the inverse (insert), we need a fresh locator since 'a' is gone — but
      // insert at a root SlotKey doesn't use the locator anyway, so any locator works.
      const restored = applyOperation(afterOp, inverse, buildLocator(afterOp)).blocks
      expect(restored).toEqual(tree)
    })
  })

  describe('depth: locator builds correct chain for deeply nested blocks', () => {
    it('updates a 5-level deep block via spine rebuild', () => {
      const deep = blk(
        'lvl0',
        {},
        {
          inner: [
            blk(
              'lvl1',
              {},
              {
                inner: [
                  blk(
                    'lvl2',
                    {},
                    {
                      inner: [
                        blk(
                          'lvl3',
                          {},
                          {
                            inner: [blk('lvl4', { v: 'old' })],
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
      const tree = [deep]
      const locator = buildLocator(tree)

      const { blocks } = applyOperation(
        tree,
        { op: 'updateFields', id: 'lvl4', set: { v: 'new' } },
        locator,
      )

      // Walk back down to verify
      const find = (b: Block, id: string): Block | null => {
        if (b.id === id) return b
        if (!b.slots) return null
        for (const children of Object.values(b.slots)) {
          for (const child of children) {
            const found = find(child, id)
            if (found) return found
          }
        }
        return null
      }
      const updated = find(at(blocks, 0), 'lvl4')
      expect(updated?.fields).toEqual({ v: 'new' })
    })
  })
})
