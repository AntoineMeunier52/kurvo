import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import { effect } from '../../src/state/reactive'
import type { Block, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/**
 * Set up a Vue effect that reads `tree.signal(id).value` and counts re-runs.
 * The first invocation is the initial setup → not counted toward "triggered
 * by mutation" assertions. We expose `runs` (total) and `triggered` (post-init).
 */
const trackSignal = (
  tree: BlockTree,
  id: string,
): { runs: () => number; triggered: () => number; lastValue: () => Block | null } => {
  let runs = 0
  let lastValue: Block | null = null
  effect(() => {
    runs++
    lastValue = tree.signal(id).value
  })
  const initial = runs
  return {
    runs: () => runs,
    triggered: () => runs - initial,
    lastValue: () => lastValue,
  }
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('BlockTree.signal: per-id reactive subscription', () => {
  describe('memoization', () => {
    it('returns the same ref instance for the same id', () => {
      const tree = new BlockTree([blk('a')])
      const ref1 = tree.signal('a')
      const ref2 = tree.signal('a')
      expect(ref1).toBe(ref2)
    })

    it('different ids get different refs', () => {
      const tree = new BlockTree([blk('a'), blk('b')])
      expect(tree.signal('a')).not.toBe(tree.signal('b'))
    })

    it('signal for an unknown id returns a ref initialized to null', () => {
      const tree = new BlockTree([blk('a')])
      const ref = tree.signal('ghost')
      expect(ref.value).toBeNull()
    })
  })

  describe('initial value', () => {
    it('reflects the live block at signal-creation time', () => {
      const tree = new BlockTree([blk('a', { x: 1 })])
      const ref = tree.signal('a')
      expect(ref.value?.fields).toEqual({ x: 1 })
    })

    it('reflects nested blocks too', () => {
      const tree = new BlockTree([blk('p', {}, { cta: [blk('child', { v: 'x' })] })])
      expect(tree.signal('child').value?.fields).toEqual({ v: 'x' })
    })
  })

  describe('triggers on `updated`', () => {
    it("fires the signal when the block's own fields change", () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const probe = trackSignal(tree, 'a')

      tree.updateFields('a', { set: { v: 2 } })
      expect(probe.triggered()).toBe(1)
      expect(probe.lastValue()?.fields).toEqual({ v: 2 })
    })

    it('fires on replace keepChildren', () => {
      const tree = new BlockTree([blk('a', { v: 'old' })])
      const probe = trackSignal(tree, 'a')

      tree.replace('a', blk('a', { v: 'new' }), { keepChildren: true })
      expect(probe.triggered()).toBe(1)
      expect(probe.lastValue()?.fields).toEqual({ v: 'new' })
    })

    it('fires on replace !keepChildren', () => {
      const tree = new BlockTree([blk('a', {}, { cta: [blk('old')] })])
      const probe = trackSignal(tree, 'a')

      tree.replace('a', blk('a', {}, { cta: [blk('fresh')] }))
      expect(probe.triggered()).toBe(1)
    })
  })

  describe('triggers on `created` / `removed`', () => {
    it('does not fire on insert of an unrelated block', () => {
      const tree = new BlockTree([blk('a')])
      const probe = trackSignal(tree, 'a')
      tree.insert(blk('b'), { slot: ROOT_SLOT_KEY })
      expect(probe.triggered()).toBe(0)
    })

    it('fires when the watched id is the inserted block', () => {
      const tree = new BlockTree([blk('a')])
      const probe = trackSignal(tree, 'b')
      expect(probe.lastValue()).toBeNull()

      tree.insert(blk('b', { v: 1 }), { slot: ROOT_SLOT_KEY })
      expect(probe.triggered()).toBe(1)
      expect(probe.lastValue()?.fields).toEqual({ v: 1 })
    })

    it('fires when the watched id is removed and resolves to null', () => {
      const tree = new BlockTree([blk('a'), blk('b')])
      const probe = trackSignal(tree, 'b')
      tree.remove('b')
      expect(probe.triggered()).toBe(1)
      expect(probe.lastValue()).toBeNull()
    })

    it('does not fire when an unrelated block is removed', () => {
      const tree = new BlockTree([blk('a'), blk('b')])
      const probe = trackSignal(tree, 'a')
      tree.remove('b')
      expect(probe.triggered()).toBe(0)
    })
  })

  describe('triggers on `moved`', () => {
    it("fires on the moved block's signal", () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('x'), blk('y')] }),
        blk('p2', {}, { cta: [] }),
      ])
      const probe = trackSignal(tree, 'x')
      tree.move('x', { slot: 'p2:cta' as SlotKey })
      expect(probe.triggered()).toBe(1)
    })

    it("fires on both parents' signals via affected.updated", () => {
      const tree = new BlockTree([
        blk('p1', {}, { cta: [blk('x'), blk('y')] }),
        blk('p2', {}, { cta: [] }),
      ])
      const p1Probe = trackSignal(tree, 'p1')
      const p2Probe = trackSignal(tree, 'p2')
      const yProbe = trackSignal(tree, 'y')

      tree.move('x', { slot: 'p2:cta' as SlotKey })
      expect(p1Probe.triggered()).toBe(1)
      expect(p2Probe.triggered()).toBe(1)
      // Note: y's index shifted in p1:cta but applyMove's contract only lists
      // `op.id` in `affected.moved` — sibling shifts in source/target slots
      // are not tracked (asymmetric with `reorder`, by current design). y's
      // signal therefore does not fire on this move.
      expect(yProbe.triggered()).toBe(0)
    })
  })

  describe('fine-grained: only `affected` ids re-run', () => {
    it('updateFields on one block does not fire signals of unrelated blocks', () => {
      const tree = new BlockTree([blk('a', { v: 1 }), blk('b', { v: 2 }), blk('c', { v: 3 })])
      const a = trackSignal(tree, 'a')
      const b = trackSignal(tree, 'b')
      const c = trackSignal(tree, 'c')

      tree.updateFields('b', { set: { v: 999 } })
      expect(a.triggered()).toBe(0)
      expect(b.triggered()).toBe(1)
      expect(c.triggered()).toBe(0)
    })

    it('updateFields on a deeply nested leaf does not fire ancestors', () => {
      // Confirms the étape-3 contract: ancestors above the immediate parent
      // are NOT in `affected.updated`, so their signals don't fire even
      // though their slots map technically gets a new ref via spine rebuild.
      const tree = new BlockTree([
        blk('gp', {}, { x: [blk('p', {}, { y: [blk('child', { v: 'old' })] })] }),
      ])
      const gp = trackSignal(tree, 'gp')
      const p = trackSignal(tree, 'p')
      const child = trackSignal(tree, 'child')

      tree.updateFields('child', { set: { v: 'new' } })
      expect(gp.triggered()).toBe(0)
      expect(p.triggered()).toBe(0)
      expect(child.triggered()).toBe(1)
    })

    it('reorder fires only the parent + ids whose index changed', () => {
      const tree = new BlockTree([
        blk('p', {}, { cells: [blk('a'), blk('b'), blk('c'), blk('d')] }),
      ])
      const p = trackSignal(tree, 'p')
      const a = trackSignal(tree, 'a')
      const b = trackSignal(tree, 'b')
      const c = trackSignal(tree, 'c')
      const d = trackSignal(tree, 'd')

      tree.reorder('p:cells' as SlotKey, 0, 2)
      // p is updated; a, b, c are in moved (indices 0..2). d is untouched.
      expect(p.triggered()).toBe(1)
      expect(a.triggered()).toBe(1)
      expect(b.triggered()).toBe(1)
      expect(c.triggered()).toBe(1)
      expect(d.triggered()).toBe(0)
    })
  })

  describe('signal value is consistent with tree.get', () => {
    it('after updateFields, signal.value === tree.get(id)', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const ref = tree.signal('a')
      tree.updateFields('a', { set: { v: 2 } })
      expect(ref.value).toBe(tree.get('a'))
    })

    it('after move, signal.value === tree.get(id)', () => {
      const tree = new BlockTree([blk('p1', {}, { cta: [blk('x')] }), blk('p2', {}, { cta: [] })])
      const ref = tree.signal('x')
      tree.move('x', { slot: 'p2:cta' as SlotKey })
      expect(ref.value).toBe(tree.get('x'))
    })

    it('after remove, signal.value is null and tree.get returns null', () => {
      const tree = new BlockTree([blk('a')])
      const ref = tree.signal('a')
      tree.remove('a')
      expect(ref.value).toBeNull()
      expect(tree.get('a')).toBeNull()
    })
  })

  describe('signal created BEFORE the block exists', () => {
    it('returns null initially and updates when the block is inserted', () => {
      const tree = new BlockTree([blk('a')])
      const ref = tree.signal('willBeCreated')
      expect(ref.value).toBeNull()

      tree.insert(blk('willBeCreated', { v: 42 }), { slot: ROOT_SLOT_KEY })
      expect(ref.value?.fields).toEqual({ v: 42 })
    })
  })
})
