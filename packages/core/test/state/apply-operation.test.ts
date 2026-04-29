import { describe, expect, it } from 'vitest'

import { applyOperation } from '../../src/state/apply-operation'
import type { Block, TreeOperation } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/** Index access that throws under noUncheckedIndexedAccess instead of returning undefined. */
const at = <T>(arr: readonly T[], i: number): T => {
  const item = arr[i]
  if (item === undefined) throw new Error(`expected array index ${i} to be defined`)
  return item
}

/** Reach into a block's slot, throwing if the slot is missing. */
const slot = (block: Block, name: string): Block[] => {
  const children = block.slots?.[name]
  if (children === undefined) {
    throw new Error(`expected slot "${name}" to be defined on block "${block.id}"`)
  }
  return children
}

/** Apply op then its inverse — should round-trip back to the original tree. */
const roundTrip = (blocks: Block[], op: TreeOperation): Block[] => {
  const { blocks: next, inverse } = applyOperation(blocks, op)
  return applyOperation(next, inverse).blocks
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('applyOperation', () => {
  // ════════════════════════════════════════════════════════════════════════
  describe('updateFields', () => {
    describe('happy path', () => {
      it('sets an existing key', () => {
        const tree = [blk('a', { title: 'old', size: 'lg' })]
        const { blocks } = applyOperation(tree, {
          op: 'updateFields',
          id: 'a',
          set: { title: 'new' },
        })
        expect(at(blocks, 0).fields).toEqual({ title: 'new', size: 'lg' })
      })

      it('adds a new key', () => {
        const tree = [blk('a', { title: 'hi' })]
        const { blocks } = applyOperation(tree, {
          op: 'updateFields',
          id: 'a',
          set: { newField: 42 },
        })
        expect(at(blocks, 0).fields).toEqual({ title: 'hi', newField: 42 })
      })

      it('removes an existing key via unset', () => {
        const tree = [blk('a', { title: 'hi', toRemove: 'x' })]
        const { blocks } = applyOperation(tree, {
          op: 'updateFields',
          id: 'a',
          unset: ['toRemove'],
        })
        expect(at(blocks, 0).fields).toEqual({ title: 'hi' })
      })

      it('combines set and unset in one op', () => {
        const tree = [blk('a', { x: 1, y: 2, z: 3 })]
        const { blocks } = applyOperation(tree, {
          op: 'updateFields',
          id: 'a',
          set: { x: 99, w: 'new' },
          unset: ['z'],
        })
        expect(at(blocks, 0).fields).toEqual({ x: 99, y: 2, w: 'new' })
      })

      it('finds a deeply nested block', () => {
        const tree = [blk('a', {}, { cta: [blk('b', {}, { inner: [blk('c', { val: 1 })] })] })]
        const { blocks } = applyOperation(tree, {
          op: 'updateFields',
          id: 'c',
          set: { val: 99 },
        })
        const b = at(slot(at(blocks, 0), 'cta'), 0)
        const c = at(slot(b, 'inner'), 0)
        expect(c.fields).toEqual({ val: 99 })
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse restores after set on existing key', () => {
        const tree = [blk('a', { title: 'old' })]
        const op: TreeOperation = { op: 'updateFields', id: 'a', set: { title: 'new' } }
        const { inverse } = applyOperation(tree, op)
        expect(inverse).toEqual({
          op: 'updateFields',
          id: 'a',
          set: { title: 'old' },
          unset: [],
        })
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('inverse uses unset to undo a key addition', () => {
        const tree = [blk('a', {})]
        const op: TreeOperation = { op: 'updateFields', id: 'a', set: { newKey: 1 } }
        const { inverse } = applyOperation(tree, op)
        expect(inverse).toEqual({
          op: 'updateFields',
          id: 'a',
          set: {},
          unset: ['newKey'],
        })
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('inverse re-adds a key removed via unset', () => {
        const tree = [blk('a', { x: 'value' })]
        const op: TreeOperation = { op: 'updateFields', id: 'a', unset: ['x'] }
        const { inverse } = applyOperation(tree, op)
        expect(inverse).toEqual({
          op: 'updateFields',
          id: 'a',
          set: { x: 'value' },
          unset: [],
        })
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip works with mixed set + unset', () => {
        const tree = [blk('a', { keep: 1, change: 'old', remove: 'gone' })]
        const op: TreeOperation = {
          op: 'updateFields',
          id: 'a',
          set: { change: 'new', add: 'fresh' },
          unset: ['remove'],
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases', () => {
      it('handles empty op (no set, no unset) as a no-op', () => {
        const tree = [blk('a', { x: 1 })]
        const { blocks } = applyOperation(tree, { op: 'updateFields', id: 'a' })
        expect(blocks).toEqual(tree)
      })

      it('dedupes same key in set and unset (set wins)', () => {
        const tree = [blk('a', { x: 'orig' })]
        const op: TreeOperation = {
          op: 'updateFields',
          id: 'a',
          set: { x: 'winner' },
          unset: ['x'],
        }
        const { blocks, inverse } = applyOperation(tree, op)
        expect(at(blocks, 0).fields).toEqual({ x: 'winner' })
        // inverse should NOT contain 'x' twice (set+unset overlap dedupe)
        const invSet = (inverse as Extract<TreeOperation, { op: 'updateFields' }>).set ?? {}
        const invUnset = (inverse as Extract<TreeOperation, { op: 'updateFields' }>).unset ?? []
        expect(Object.keys(invSet)).toContain('x')
        expect(invUnset).not.toContain('x')
        // and round-trip still works
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('unsetting a non-existing key is a silent no-op', () => {
        const tree = [blk('a', { x: 1 })]
        const op: TreeOperation = { op: 'updateFields', id: 'a', unset: ['neverExisted'] }
        const { blocks, inverse } = applyOperation(tree, op)
        expect(at(blocks, 0).fields).toEqual({ x: 1 })
        // inverse should NOT try to re-add the absent key
        const invSet = (inverse as Extract<TreeOperation, { op: 'updateFields' }>).set ?? {}
        expect(invSet).toEqual({})
      })

      it('throws when block id not found', () => {
        const tree = [blk('a', {})]
        expect(() =>
          applyOperation(tree, { op: 'updateFields', id: 'ghost', set: { x: 1 } }),
        ).toThrow(/block "ghost" not found/)
      })

      it('throws when set contains an undefined value (JSON-safety guard)', () => {
        const tree = [blk('a', { x: 1 })]
        expect(() =>
          applyOperation(tree, {
            op: 'updateFields',
            id: 'a',
            set: { x: undefined },
          }),
        ).toThrow(/set\["x"\] is undefined; use `unset`/)
      })

      it('ignores prototype keys when checking existence', () => {
        const fields: Record<string, unknown> = {}
        Object.setPrototypeOf(fields, { inherited: 'from-proto' })
        const tree = [{ id: 'a', type: 'Box', fields }]
        const op: TreeOperation = { op: 'updateFields', id: 'a', set: { inherited: 'override' } }
        const { inverse } = applyOperation(tree, op)
        // inverse should treat 'inherited' as new (unset), not as existing
        expect((inverse as Extract<TreeOperation, { op: 'updateFields' }>).unset).toEqual([
          'inherited',
        ])
      })
    })

    describe('immutability', () => {
      it('does not mutate the input tree', () => {
        const tree = [blk('a', { x: 1 })]
        const snapshot = JSON.parse(JSON.stringify(tree)) as Block[]
        applyOperation(tree, { op: 'updateFields', id: 'a', set: { x: 999 } })
        expect(tree).toEqual(snapshot)
      })

      it('preserves untouched sibling references (structural sharing)', () => {
        const sibling = blk('b', { x: 1 })
        const tree = [blk('a', {}), sibling]
        const { blocks } = applyOperation(tree, { op: 'updateFields', id: 'a', set: { y: 1 } })
        expect(at(blocks, 1)).toBe(sibling)
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('reorder', () => {
    describe('happy path', () => {
      it('moves first element to last in root', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { blocks } = applyOperation(tree, {
          op: 'reorder',
          slot: ROOT_SLOT_KEY,
          from: 0,
          to: 2,
        })
        expect(blocks.map((b) => b.id)).toEqual(['b', 'c', 'a'])
      })

      it('moves last to first in root', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { blocks } = applyOperation(tree, {
          op: 'reorder',
          slot: ROOT_SLOT_KEY,
          from: 2,
          to: 0,
        })
        expect(blocks.map((b) => b.id)).toEqual(['c', 'a', 'b'])
      })

      it('reorders inside a nested slot', () => {
        const tree = [blk('parent', {}, { cells: [blk('x'), blk('y'), blk('z')] })]
        const { blocks } = applyOperation(tree, {
          op: 'reorder',
          slot: 'parent:cells',
          from: 0,
          to: 1,
        })
        expect(slot(at(blocks, 0), 'cells').map((b) => b.id)).toEqual(['y', 'x', 'z'])
      })

      it('returns same tree on no-op (from === to within bounds)', () => {
        const tree = [blk('a'), blk('b')]
        const { blocks } = applyOperation(tree, {
          op: 'reorder',
          slot: ROOT_SLOT_KEY,
          from: 0,
          to: 0,
        })
        expect(blocks).toBe(tree)
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse swaps from/to', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { inverse } = applyOperation(tree, {
          op: 'reorder',
          slot: ROOT_SLOT_KEY,
          from: 0,
          to: 2,
        })
        expect(inverse).toEqual({ op: 'reorder', slot: ROOT_SLOT_KEY, from: 2, to: 0 })
      })

      it('round-trip restores root order', () => {
        const tree = [blk('a'), blk('b'), blk('c'), blk('d')]
        const op: TreeOperation = { op: 'reorder', slot: ROOT_SLOT_KEY, from: 1, to: 3 }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip restores nested slot order', () => {
        const tree = [blk('p', {}, { cells: [blk('x'), blk('y'), blk('z')] })]
        const op: TreeOperation = { op: 'reorder', slot: 'p:cells', from: 2, to: 0 }
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases', () => {
      it('throws on negative from', () => {
        const tree = [blk('a'), blk('b')]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: ROOT_SLOT_KEY, from: -1, to: 0 }),
        ).toThrow(/from=-1 out of bounds/)
      })

      it('throws on out-of-bounds to', () => {
        const tree = [blk('a'), blk('b')]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: ROOT_SLOT_KEY, from: 0, to: 5 }),
        ).toThrow(/to=5 out of bounds/)
      })

      it('throws on no-op against an empty slot (length 0)', () => {
        const tree = [blk('p', {}, { cells: [] })]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: 'p:cells', from: 0, to: 0 }),
        ).toThrow(/out of bounds/)
      })

      it('throws on root with non-default slotName', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: 'root:somethingElse', from: 0, to: 0 }),
        ).toThrow(/invalid root slot/)
      })

      it('throws when target block (parent) not found', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: 'ghost:cells', from: 0, to: 1 }),
        ).toThrow(/block "ghost" not found/)
      })

      it('throws when slot does not exist on the parent block', () => {
        const tree = [blk('p')]
        expect(() =>
          applyOperation(tree, { op: 'reorder', slot: 'p:absent', from: 0, to: 0 }),
        ).toThrow(/slot "p:absent" not found/)
      })
    })

    describe('immutability', () => {
      it('does not mutate input tree', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const snapshot = JSON.parse(JSON.stringify(tree)) as Block[]
        applyOperation(tree, { op: 'reorder', slot: ROOT_SLOT_KEY, from: 0, to: 2 })
        expect(tree).toEqual(snapshot)
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('replace', () => {
    describe('happy path', () => {
      it('replaces a block at root (no keepChildren)', () => {
        const tree = [blk('a', { x: 1 })]
        const { blocks } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', { y: 2 }),
        })
        expect(at(blocks, 0).fields).toEqual({ y: 2 })
      })

      it('replaces a block in a nested slot', () => {
        const tree = [blk('p', {}, { cta: [blk('child', { v: 1 })] })]
        const { blocks } = applyOperation(tree, {
          op: 'replace',
          id: 'child',
          block: blk('child', { v: 2 }),
        })
        expect(at(slot(at(blocks, 0), 'cta'), 0).fields).toEqual({ v: 2 })
      })

      it('preserves existing slots when keepChildren=true', () => {
        const tree = [blk('a', { x: 1 }, { cta: [blk('child', { v: 'old' })] })]
        const { blocks } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 999 }),
          keepChildren: true,
        })
        const replaced = at(blocks, 0)
        expect(replaced.fields).toEqual({ x: 999 })
        expect(replaced.slots?.cta).toBeDefined()
        expect(at(slot(replaced, 'cta'), 0).fields).toEqual({ v: 'old' })
      })

      it('discards op.block.slots when keepChildren=true and existing had none', () => {
        const tree = [blk('a', {})]
        const { blocks } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', {}, { cta: [blk('newChild')] }),
          keepChildren: true,
        })
        // existing had no slots, op.block.slots is dropped (not invented)
        expect(at(blocks, 0).slots).toBeUndefined()
      })

      it('uses op.block.slots verbatim when keepChildren is falsy', () => {
        const tree = [blk('a', {}, { old: [blk('oldChild')] })]
        const { blocks } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', {}, { fresh: [blk('newChild')] }),
        })
        expect(at(blocks, 0).slots).toEqual({ fresh: [blk('newChild')] })
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse always uses keepChildren=false (cloned old block carries its own slots)', () => {
        const tree = [blk('a', { x: 1 }, { cta: [blk('child')] })]
        const { inverse } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 2 }),
          keepChildren: true,
        })
        expect(inverse).toMatchObject({
          op: 'replace',
          id: 'a',
          keepChildren: false,
        })
      })

      it('round-trip restores after no-keepChildren replace', () => {
        const tree = [blk('a', { x: 1 }, { cta: [blk('child', { v: 'orig' })] })]
        const op: TreeOperation = {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 2 }),
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip restores after keepChildren replace', () => {
        const tree = [blk('a', { x: 1 }, { cta: [blk('child', { v: 'orig' })] })]
        const op: TreeOperation = {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 2 }),
          keepChildren: true,
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip when both sides have slots and keepChildren=true (op.block.slots discarded)', () => {
        const tree = [blk('a', { x: 1 }, { cta: [blk('original')] })]
        const op: TreeOperation = {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 2 }, { cta: [blk('newOne')], extra: [blk('extraOne')] }),
          keepChildren: true,
        }
        const { blocks } = applyOperation(tree, op)
        // op.block.slots fully discarded, existing.slots verbatim
        expect(at(blocks, 0).slots).toEqual({ cta: [blk('original')] })
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases', () => {
      it('throws when op.block.id !== op.id', () => {
        const tree = [blk('a', {})]
        expect(() =>
          applyOperation(tree, { op: 'replace', id: 'a', block: blk('mismatch') }),
        ).toThrow(/must equal op.id/)
      })

      it('throws when block not found', () => {
        const tree = [blk('a', {})]
        expect(() =>
          applyOperation(tree, { op: 'replace', id: 'ghost', block: blk('ghost') }),
        ).toThrow(/block "ghost" not found/)
      })

      it('inverse is independent from later mutation of the live tree', () => {
        const tree = [blk('a', { x: 1 })]
        const { blocks: next, inverse } = applyOperation(tree, {
          op: 'replace',
          id: 'a',
          block: blk('a', { x: 999 }),
        })
        // mutate the live tree's replaced block
        ;(at(next, 0).fields as Record<string, unknown>).mutated = 'corrupt'
        // inverse must still hold the original 'x: 1' block, untouched
        expect((inverse as Extract<TreeOperation, { op: 'replace' }>).block).toEqual(
          blk('a', { x: 1 }),
        )
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('insert', () => {
    describe('happy path', () => {
      it('inserts at root with explicit index', () => {
        const tree = [blk('a'), blk('c')]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('b'),
          target: { slot: ROOT_SLOT_KEY, index: 1 },
        })
        expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
      })

      it('appends at root when index is omitted', () => {
        const tree = [blk('a'), blk('b')]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('c'),
          target: { slot: ROOT_SLOT_KEY },
        })
        expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
      })

      it('prepends at root when index is 0', () => {
        const tree = [blk('a'), blk('b')]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('z'),
          target: { slot: ROOT_SLOT_KEY, index: 0 },
        })
        expect(blocks.map((b) => b.id)).toEqual(['z', 'a', 'b'])
      })

      it('inserts in an existing nested slot', () => {
        const tree = [blk('p', {}, { cells: [blk('x')] })]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('y'),
          target: { slot: 'p:cells', index: 0 },
        })
        expect(slot(at(blocks, 0), 'cells').map((b) => b.id)).toEqual(['y', 'x'])
      })

      it('auto-creates the slot entry if the parent had no slots at all', () => {
        const tree = [blk('p', {})]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('y'),
          target: { slot: 'p:fresh' },
        })
        expect(at(blocks, 0).slots).toEqual({ fresh: [blk('y')] })
      })

      it('auto-creates a slot key when the parent has other slots but not this one', () => {
        const tree = [blk('p', {}, { other: [blk('o')] })]
        const { blocks } = applyOperation(tree, {
          op: 'insert',
          block: blk('y'),
          target: { slot: 'p:fresh' },
        })
        const parent = at(blocks, 0)
        expect(parent.slots?.other).toBeDefined()
        expect(parent.slots?.fresh).toEqual([blk('y')])
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse is a remove of the inserted id', () => {
        const tree = [blk('a')]
        const op: TreeOperation = {
          op: 'insert',
          block: blk('b'),
          target: { slot: ROOT_SLOT_KEY },
        }
        const { inverse } = applyOperation(tree, op)
        expect(inverse).toEqual({ op: 'remove', id: 'b' })
      })

      it('round-trip restores root', () => {
        const tree = [blk('a'), blk('c')]
        const op: TreeOperation = {
          op: 'insert',
          block: blk('b'),
          target: { slot: ROOT_SLOT_KEY, index: 1 },
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip restores nested', () => {
        const tree = [blk('p', {}, { cta: [blk('x')] })]
        const op: TreeOperation = {
          op: 'insert',
          block: blk('y'),
          target: { slot: 'p:cta', index: 1 },
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases', () => {
      it('throws on negative index', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, {
            op: 'insert',
            block: blk('b'),
            target: { slot: ROOT_SLOT_KEY, index: -1 },
          }),
        ).toThrow(/out of bounds/)
      })

      it('throws on index > length', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, {
            op: 'insert',
            block: blk('b'),
            target: { slot: ROOT_SLOT_KEY, index: 5 },
          }),
        ).toThrow(/out of bounds/)
      })

      it('throws on root with non-default slotName', () => {
        const tree: Block[] = []
        expect(() =>
          applyOperation(tree, {
            op: 'insert',
            block: blk('b'),
            target: { slot: 'root:custom' },
          }),
        ).toThrow(/invalid root slot/)
      })

      it('throws when parent block does not exist', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, {
            op: 'insert',
            block: blk('b'),
            target: { slot: 'ghost:slot' },
          }),
        ).toThrow(/parent block "ghost" not found/)
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('remove', () => {
    describe('happy path', () => {
      it('removes a block from root', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { blocks } = applyOperation(tree, { op: 'remove', id: 'b' })
        expect(blocks.map((b) => b.id)).toEqual(['a', 'c'])
      })

      it('removes a block from a nested slot', () => {
        const tree = [blk('p', {}, { cta: [blk('x'), blk('y')] })]
        const { blocks } = applyOperation(tree, { op: 'remove', id: 'x' })
        expect(slot(at(blocks, 0), 'cta').map((b) => b.id)).toEqual(['y'])
      })

      it('removes a block with descendants (entire subtree gone)', () => {
        const tree = [blk('a', {}, { cta: [blk('a1', {}, { inner: [blk('a1a')] })] }), blk('b')]
        const { blocks } = applyOperation(tree, { op: 'remove', id: 'a' })
        expect(blocks.map((b) => b.id)).toEqual(['b'])
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse is an insert at the original position', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { inverse } = applyOperation(tree, { op: 'remove', id: 'b' })
        expect(inverse).toMatchObject({
          op: 'insert',
          target: { slot: ROOT_SLOT_KEY, index: 1 },
        })
      })

      it('inverse captures the entire subtree (deep restore)', () => {
        const tree = [blk('a', { v: 1 }, { cta: [blk('child', { c: 2 })] })]
        const op: TreeOperation = { op: 'remove', id: 'a' }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip from a nested slot', () => {
        const tree = [blk('p', {}, { cta: [blk('x'), blk('y'), blk('z')] })]
        const op: TreeOperation = { op: 'remove', id: 'y' }
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases', () => {
      it('throws when block not found', () => {
        const tree = [blk('a')]
        expect(() => applyOperation(tree, { op: 'remove', id: 'ghost' })).toThrow(
          /block "ghost" not found/,
        )
      })

      it('inverse is detached from later mutation of the live tree', () => {
        const original = blk('a', { v: 'orig' })
        const tree = [original, blk('b')]
        const { inverse } = applyOperation(tree, { op: 'remove', id: 'a' })
        // mutate the original block reference
        ;(original.fields as Record<string, unknown>).v = 'mutated'
        // inverse should still carry the orig snapshot
        expect((inverse as Extract<TreeOperation, { op: 'insert' }>).block.fields).toEqual({
          v: 'orig',
        })
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('move', () => {
    describe('happy path', () => {
      it('moves a block within the same parent slot', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { blocks } = applyOperation(tree, {
          op: 'move',
          id: 'a',
          target: { slot: ROOT_SLOT_KEY, index: 2 },
        })
        expect(blocks.map((b) => b.id)).toEqual(['b', 'c', 'a'])
      })

      it('moves a block from one parent to another', () => {
        const tree = [
          blk('p1', {}, { cta: [blk('x'), blk('y')] }),
          blk('p2', {}, { cta: [blk('z')] }),
        ]
        const { blocks } = applyOperation(tree, {
          op: 'move',
          id: 'x',
          target: { slot: 'p2:cta', index: 0 },
        })
        expect(slot(at(blocks, 0), 'cta').map((b) => b.id)).toEqual(['y'])
        expect(slot(at(blocks, 1), 'cta').map((b) => b.id)).toEqual(['x', 'z'])
      })

      it('moves from nested slot up to root', () => {
        const tree = [blk('p', {}, { cta: [blk('child')] })]
        const { blocks } = applyOperation(tree, {
          op: 'move',
          id: 'child',
          target: { slot: ROOT_SLOT_KEY },
        })
        expect(blocks.map((b) => b.id)).toEqual(['p', 'child'])
        expect(slot(at(blocks, 0), 'cta')).toEqual([])
      })

      it('moves from root down into a nested slot', () => {
        const tree = [blk('p', {}, { cta: [] }), blk('floating')]
        const { blocks } = applyOperation(tree, {
          op: 'move',
          id: 'floating',
          target: { slot: 'p:cta' },
        })
        expect(blocks.map((b) => b.id)).toEqual(['p'])
        expect(slot(at(blocks, 0), 'cta').map((b) => b.id)).toEqual(['floating'])
      })

      it('handles a no-op move (same slot, same index after remove)', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        // Moving 'b' to (root, 1): remove → [a,c], insert at 1 → [a,b,c] (unchanged)
        const { blocks, inverse } = applyOperation(tree, {
          op: 'move',
          id: 'b',
          target: { slot: ROOT_SLOT_KEY, index: 1 },
        })
        expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
        // Inverse moves 'b' back to its captured original index (also 1).
        expect(inverse).toEqual({
          op: 'move',
          id: 'b',
          target: { slot: ROOT_SLOT_KEY, index: 1 },
        })
      })
    })

    describe('inverse + round-trip', () => {
      it('inverse moves back to the original (slot, index)', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const { inverse } = applyOperation(tree, {
          op: 'move',
          id: 'a',
          target: { slot: ROOT_SLOT_KEY, index: 2 },
        })
        expect(inverse).toEqual({
          op: 'move',
          id: 'a',
          target: { slot: ROOT_SLOT_KEY, index: 0 },
        })
      })

      it('round-trip restores cross-parent move', () => {
        const tree = [
          blk('p1', {}, { cta: [blk('x'), blk('y')] }),
          blk('p2', {}, { cta: [blk('z')] }),
        ]
        const op: TreeOperation = {
          op: 'move',
          id: 'x',
          target: { slot: 'p2:cta', index: 1 },
        }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trip restores nested-to-root move', () => {
        const tree = [blk('p', {}, { cta: [blk('child', { v: 'data' })] })]
        const op: TreeOperation = { op: 'move', id: 'child', target: { slot: ROOT_SLOT_KEY } }
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trips a same-slot forward move (index drift up)', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const op: TreeOperation = {
          op: 'move',
          id: 'a',
          target: { slot: ROOT_SLOT_KEY, index: 2 },
        }
        const { blocks: forward } = applyOperation(tree, op)
        expect(forward.map((b) => b.id)).toEqual(['b', 'c', 'a'])
        expect(roundTrip(tree, op)).toEqual(tree)
      })

      it('round-trips a same-slot backward move (index drift down)', () => {
        const tree = [blk('a'), blk('b'), blk('c')]
        const op: TreeOperation = {
          op: 'move',
          id: 'c',
          target: { slot: ROOT_SLOT_KEY, index: 0 },
        }
        const { blocks: forward } = applyOperation(tree, op)
        expect(forward.map((b) => b.id)).toEqual(['c', 'a', 'b'])
        expect(roundTrip(tree, op)).toEqual(tree)
      })
    })

    describe('edge cases / cycle detection', () => {
      it('throws when moving a block into itself', () => {
        const tree = [blk('a', {}, { inner: [] })]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'a', target: { slot: 'a:inner' } }),
        ).toThrow(/cannot move block "a" into its own descendant/)
      })

      it('throws when moving a block into a direct descendant', () => {
        const tree = [blk('a', {}, { inner: [blk('child', {}, { deep: [] })] })]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'a', target: { slot: 'child:deep' } }),
        ).toThrow(/cannot move block "a" into its own descendant/)
      })

      it('throws when moving a block into a deeply nested descendant', () => {
        const tree = [blk('a', {}, { l1: [blk('b', {}, { l2: [blk('c', {}, { l3: [] })] })] })]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'a', target: { slot: 'c:l3' } }),
        ).toThrow(/cannot move block "a" into its own descendant/)
      })

      it('throws when block to move not found', () => {
        const tree = [blk('a')]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'ghost', target: { slot: ROOT_SLOT_KEY } }),
        ).toThrow(/block "ghost" not found/)
      })

      it('throws when target parent does not exist (after remove)', () => {
        const tree = [blk('a'), blk('b')]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'a', target: { slot: 'ghost:slot' } }),
        ).toThrow(/parent block "ghost" not found/)
      })

      it('does not mutate input tree even when throwing', () => {
        const tree = [blk('a', {}, { inner: [] })]
        const snapshot = JSON.parse(JSON.stringify(tree)) as Block[]
        expect(() =>
          applyOperation(tree, { op: 'move', id: 'a', target: { slot: 'a:inner' } }),
        ).toThrow()
        expect(tree).toEqual(snapshot)
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // History-level invariants
  // Properties that must hold for the command-pattern history to behave correctly.
  // ════════════════════════════════════════════════════════════════════════
  describe('history invariants', () => {
    describe('stacked op sequences (undo/redo chains)', () => {
      it('round-trips a chain of mixed operations through full undo then full redo', () => {
        // Initial tree
        const initial: Block[] = [
          blk('hero', { title: 'Hi' }, { cta: [blk('btn', { label: 'Click' })] }),
          blk('grid', {}, { cells: [blk('c1'), blk('c2')] }),
        ]

        // A realistic chain of edits: edit field, insert, reorder, replace, move, remove.
        const ops: TreeOperation[] = [
          { op: 'updateFields', id: 'hero', set: { title: 'Hello' } },
          {
            op: 'insert',
            block: blk('newBlock', { v: 1 }),
            target: { slot: ROOT_SLOT_KEY, index: 1 },
          },
          { op: 'reorder', slot: 'grid:cells', from: 0, to: 1 },
          {
            op: 'replace',
            id: 'btn',
            block: blk('btn', { label: 'Go!' }),
            keepChildren: false,
          },
          { op: 'move', id: 'newBlock', target: { slot: 'hero:cta' } },
          { op: 'remove', id: 'c1' },
        ]

        // Apply forward, capturing each intermediate state and inverse.
        const states: Block[][] = [initial]
        const inverses: TreeOperation[] = []
        let current: Block[] = initial
        for (const op of ops) {
          const { blocks, inverse } = applyOperation(current, op)
          states.push(blocks)
          inverses.push(inverse)
          current = blocks
        }
        // Sanity: forward chain produced 6 distinct states.
        expect(states).toHaveLength(ops.length + 1)

        // Undo all the way back, asserting every intermediate state.
        for (let i = ops.length - 1; i >= 0; i--) {
          const inv = inverses[i]
          if (inv === undefined) throw new Error(`missing inverse at ${i}`)
          current = applyOperation(current, inv).blocks
          expect(current).toEqual(states[i])
        }
        // After undoing all ops, we are back at the initial tree.
        expect(current).toEqual(initial)

        // Redo all the way forward, asserting every state.
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]
          if (op === undefined) throw new Error(`missing op at ${i}`)
          current = applyOperation(current, op).blocks
          expect(current).toEqual(states[i + 1])
        }
      })

      it('partial undo then redo lands on the correct intermediate state', () => {
        const initial = [blk('a', { x: 1 })]
        const op1: TreeOperation = { op: 'updateFields', id: 'a', set: { x: 2 } }
        const op2: TreeOperation = { op: 'updateFields', id: 'a', set: { x: 3 } }

        const r1 = applyOperation(initial, op1)
        const r2 = applyOperation(r1.blocks, op2)
        // Undo op2 only (back to state after op1).
        const undone = applyOperation(r2.blocks, r2.inverse).blocks
        expect(undone).toEqual(r1.blocks)
        // Redo op2.
        const redone = applyOperation(undone, op2).blocks
        expect(redone).toEqual(r2.blocks)
      })
    })

    describe('JSON round-trip of inverses (persistence-safety)', () => {
      // For each op kind, the inverse must survive a JSON.stringify/parse roundtrip
      // without loss of meaning. This is critical if history ever transits through
      // postMessage, BroadcastChannel, localStorage, etc.
      const cases: Array<{ name: string; tree: Block[]; op: TreeOperation }> = [
        {
          name: 'updateFields (set)',
          tree: [blk('a', { x: 1 })],
          op: { op: 'updateFields', id: 'a', set: { x: 2 } },
        },
        {
          name: 'updateFields (unset)',
          tree: [blk('a', { x: 1, y: 2 })],
          op: { op: 'updateFields', id: 'a', unset: ['y'] },
        },
        {
          name: 'updateFields (set adding new key)',
          tree: [blk('a', {})],
          op: { op: 'updateFields', id: 'a', set: { newKey: 'v' } },
        },
        {
          name: 'reorder root',
          tree: [blk('a'), blk('b'), blk('c')],
          op: { op: 'reorder', slot: ROOT_SLOT_KEY, from: 0, to: 2 },
        },
        {
          name: 'insert root',
          tree: [blk('a')],
          op: { op: 'insert', block: blk('b'), target: { slot: ROOT_SLOT_KEY, index: 0 } },
        },
        {
          name: 'remove with deep subtree',
          tree: [blk('a', { v: 1 }, { cta: [blk('child', { c: 2 })] })],
          op: { op: 'remove', id: 'a' },
        },
        {
          name: 'replace (keepChildren)',
          tree: [blk('a', { x: 1 }, { cta: [blk('child')] })],
          op: { op: 'replace', id: 'a', block: blk('a', { x: 9 }), keepChildren: true },
        },
        {
          name: 'move cross-parent',
          tree: [blk('p1', {}, { cta: [blk('x'), blk('y')] }), blk('p2', {}, { cta: [] })],
          op: { op: 'move', id: 'x', target: { slot: 'p2:cta' } },
        },
      ]

      for (const { name, tree, op } of cases) {
        it(`inverse of ${name} survives JSON serialization`, () => {
          const { blocks: afterOp, inverse } = applyOperation(tree, op)
          const serialized = JSON.parse(JSON.stringify(inverse)) as TreeOperation
          // Apply the deserialized inverse — must restore the original tree.
          const restored = applyOperation(afterOp, serialized).blocks
          expect(restored).toEqual(tree)
        })
      }
    })
  })
})
