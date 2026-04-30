import { describe, expect, it } from 'vitest'

import { PageTree } from '../../src/state/page-tree'
import { effect } from '../../src/state/reactive'
import type { Block, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

// ─── tests ────────────────────────────────────────────────────────────────

describe('PageTree: multi-PageSlot orchestrator', () => {
  describe('construction', () => {
    it('builds an empty document by default', () => {
      const doc = new PageTree()
      expect(doc.slotNames()).toEqual([])
      expect(doc.has('anything')).toBe(false)
    })

    it('builds from a Record of slot → blocks', () => {
      const doc = new PageTree({
        header: [blk('h1')],
        main: [blk('m1'), blk('m2')],
        footer: [blk('f1')],
      })
      expect(doc.slotNames()).toEqual(['header', 'main', 'footer'])
      expect(doc.has('h1')).toBe(true)
      expect(doc.has('m1')).toBe(true)
      expect(doc.has('m2')).toBe(true)
      expect(doc.has('f1')).toBe(true)
    })

    it('throws if an id appears in more than one slot', () => {
      expect(
        () =>
          new PageTree({
            header: [blk('shared')],
            main: [blk('shared')],
          }),
      ).toThrow(/appears in both/)
    })

    it('throws if a nested id collides with a top-level id in another slot', () => {
      expect(
        () =>
          new PageTree({
            header: [blk('p', {}, { cta: [blk('hidden')] })],
            main: [blk('hidden')],
          }),
      ).toThrow(/already exists|appears in both/)
    })
  })

  describe('cross-slot reads', () => {
    const doc = (): PageTree =>
      new PageTree({
        header: [blk('h1', { v: 'header1' })],
        main: [blk('m1', {}, { cta: [blk('m1a', { v: 'nested' })] })],
        footer: [blk('f1')],
      })

    it('has() finds ids regardless of slot', () => {
      const d = doc()
      expect(d.has('h1')).toBe(true)
      expect(d.has('m1a')).toBe(true)
      expect(d.has('f1')).toBe(true)
      expect(d.has('ghost')).toBe(false)
    })

    it('get() returns the live block from any slot', () => {
      const d = doc()
      expect(d.get('h1')?.fields).toEqual({ v: 'header1' })
      expect(d.get('m1a')?.fields).toEqual({ v: 'nested' })
      expect(d.get('ghost')).toBeNull()
    })

    it('findSlot() returns the slot name where an id lives', () => {
      const d = doc()
      expect(d.findSlot('h1')).toBe('header')
      expect(d.findSlot('m1a')).toBe('main')
      expect(d.findSlot('f1')).toBe('footer')
      expect(d.findSlot('ghost')).toBeNull()
    })

    it('slot() exposes the underlying BlockTree by name', () => {
      const d = doc()
      const headerTree = d.slot('header')
      expect(headerTree).not.toBeNull()
      expect(headerTree?.has('h1')).toBe(true)
      expect(d.slot('nope')).toBeNull()
    })
  })

  describe('mutations: dispatch to the right slot', () => {
    it('insert into a named slot', () => {
      const d = new PageTree({ header: [], main: [] })
      const inverse = d.insert('main', blk('x'), { slot: ROOT_SLOT_KEY })
      expect(d.has('x')).toBe(true)
      expect(d.findSlot('x')).toBe('main')
      expect(inverse).toEqual({ op: 'remove', id: 'x' })
    })

    it('updateFields finds the id in whichever slot it lives in', () => {
      const d = new PageTree({
        header: [blk('h1', { v: 1 })],
        main: [blk('m1', { v: 1 })],
      })
      d.updateFields('m1', { set: { v: 2 } })
      expect(d.get('h1')?.fields).toEqual({ v: 1 })
      expect(d.get('m1')?.fields).toEqual({ v: 2 })
    })

    it('remove dispatches by current slot', () => {
      const d = new PageTree({
        header: [blk('h1')],
        main: [blk('m1')],
      })
      d.remove('h1')
      expect(d.has('h1')).toBe(false)
      expect(d.has('m1')).toBe(true)
    })

    it('reorder takes an explicit slot name + intra-slot SlotKey', () => {
      const d = new PageTree({
        main: [blk('p', {}, { cta: [blk('a'), blk('b'), blk('c')] })],
      })
      d.reorder('main', 'p:cta' as SlotKey, 0, 2)
      expect(d.get('p')?.slots?.cta?.map((b) => b.id)).toEqual(['b', 'c', 'a'])
    })

    it('replace works in-place within whichever slot the id lives in', () => {
      const d = new PageTree({
        header: [blk('h1', { v: 'old' })],
        main: [blk('m1')],
      })
      d.replace('h1', blk('h1', { v: 'new' }))
      expect(d.get('h1')?.fields).toEqual({ v: 'new' })
      expect(d.findSlot('h1')).toBe('header')
    })

    it('move (intra-slot) delegates to the slot tree', () => {
      const d = new PageTree({
        main: [blk('p', {}, { cta: [blk('x'), blk('y')] })],
      })
      d.move('x', { slot: 'p:cta' as SlotKey, index: 1 })
      expect(d.get('p')?.slots?.cta?.map((b) => b.id)).toEqual(['y', 'x'])
    })
  })

  describe('global id collision on insert/replace', () => {
    it('insert into one slot rejects an id that already exists in another', () => {
      const d = new PageTree({
        header: [blk('shared')],
        main: [],
      })
      expect(() => d.insert('main', blk('shared'), { slot: ROOT_SLOT_KEY })).toThrow(
        /already exists/,
      )
    })

    it('insert rejects nested ids that collide with ids in other slots', () => {
      const d = new PageTree({
        header: [blk('hi')],
        main: [],
      })
      expect(() =>
        d.insert('main', blk('p', {}, { x: [blk('hi')] }), { slot: ROOT_SLOT_KEY }),
      ).toThrow(/already exists/)
    })

    it('replace !keepChildren whitelists the old subtree (no false-positive)', () => {
      const d = new PageTree({
        header: [blk('h1', {}, { x: [blk('hidden')] })],
        main: [],
      })
      // Replacing h1 with a block whose subtree includes 'hidden' must not
      // throw — 'hidden' is being removed in the same op.
      expect(() => d.replace('h1', blk('h1', {}, { y: [blk('hidden')] }))).not.toThrow()
    })

    it('replace still rejects ids that collide with OTHER slots', () => {
      const d = new PageTree({
        header: [blk('h1')],
        main: [blk('m1')],
      })
      expect(() => d.replace('h1', blk('h1', {}, { x: [blk('m1')] }))).toThrow(/already exists/)
    })
  })

  describe('cross-slot moves are not supported in V1', () => {
    it('move with a target.slot that resolves to the same slot tree works', () => {
      const d = new PageTree({
        main: [blk('p', {}, { cta: [blk('a'), blk('b')] })],
      })
      // Intra-slot move (within the 'main' tree's subtree).
      expect(() => d.move('a', { slot: 'p:cta' as SlotKey, index: 1 })).not.toThrow()
    })

    it("move whose target.slot doesn't exist in the source tree throws", () => {
      // 'a' lives in 'header'. target.slot 'unknown:cta' doesn't exist
      // anywhere — BlockTree.move on the header tree will throw.
      const d = new PageTree({
        header: [blk('a')],
        main: [],
      })
      expect(() => d.move('a', { slot: 'unknown:cta' as SlotKey, index: 0 })).toThrow()
    })
  })

  describe('signals', () => {
    it('signal(id) returns the same ref on repeated calls (memoized in slot tree)', () => {
      const d = new PageTree({ main: [blk('a')] })
      expect(d.signal('a')).toBe(d.signal('a'))
    })

    it('signal(id) finds the id in whatever slot it lives in', () => {
      const d = new PageTree({
        header: [blk('h1', { v: 1 })],
        main: [blk('m1', { v: 2 })],
      })
      expect(d.signal('h1').value?.fields).toEqual({ v: 1 })
      expect(d.signal('m1').value?.fields).toEqual({ v: 2 })
    })

    it('signal(id) fires when the watched block is updated in its slot', () => {
      const d = new PageTree({
        header: [blk('h1', { v: 1 })],
        main: [blk('m1', { v: 1 })],
      })
      const ref = d.signal('m1')
      let runs = 0
      effect(() => {
        runs++
        void ref.value
      })
      const initial = runs
      d.updateFields('m1', { set: { v: 2 } })
      expect(runs - initial).toBe(1)
      expect(ref.value?.fields).toEqual({ v: 2 })
    })

    it('signal(id) for an unknown id is null and fires on subsequent insert', () => {
      const d = new PageTree({ main: [] })
      const ref = d.signal('willCome')
      expect(ref.value).toBeNull()
      d.insert('main', blk('willCome', { v: 'arrived' }), { slot: ROOT_SLOT_KEY })
      expect(ref.value?.fields).toEqual({ v: 'arrived' })
    })
  })

  describe('serialize round-trip', () => {
    it('snapshots the whole document keyed by slot', () => {
      const d = new PageTree({
        header: [blk('h1', { v: 1 })],
        main: [blk('m1', {}, { cta: [blk('m1a')] })],
      })
      const snap = d.serialize()
      expect(Object.keys(snap)).toEqual(['header', 'main'])
      expect(snap.header?.[0]?.id).toBe('h1')
      expect(snap.main?.[0]?.slots?.cta?.[0]?.id).toBe('m1a')
    })

    it('reconstructing from a serialize() round-trip is equivalent', () => {
      const a = new PageTree({
        header: [blk('h1', { v: 1 })],
        main: [blk('m1')],
      })
      const b = new PageTree(a.serialize())
      expect(b.get('h1')?.fields).toEqual({ v: 1 })
      expect(b.findSlot('m1')).toBe('main')
    })
  })
})
