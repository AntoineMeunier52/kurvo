import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import { History } from '../../src/state/history'
import { effect } from '../../src/state/reactive'
import type { Block, SlotKey } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

// ─── Step 1 — stack basique + undo/redo + reactive refs + maxEntries ───────

describe('History — step 1: stack, undo/redo, reactive refs, maxEntries', () => {
  describe('initial state', () => {
    it('starts empty', () => {
      const tree = new BlockTree([blk('a')])
      const history = new History(tree)
      expect(history.size.value).toBe(0)
      expect(history.cursor.value).toBe(0)
      expect(history.canUndo.value).toBe(false)
      expect(history.canRedo.value).toBe(false)
    })

    it('peek() on empty history returns nulls', () => {
      const tree = new BlockTree([blk('a')])
      const history = new History(tree)
      expect(history.peek()).toEqual({ undo: null, redo: null })
    })
  })

  describe('push entries on each mutation', () => {
    it('insert pushes a single-kind entry', () => {
      const tree = new BlockTree([blk('a')])
      const history = new History(tree)
      history.insert(blk('b'), { slot: ROOT_SLOT_KEY })
      expect(history.size.value).toBe(1)
      expect(history.cursor.value).toBe(1)
      expect(history.canUndo.value).toBe(true)
      expect(history.canRedo.value).toBe(false)
    })

    it('every wrapper pushes one entry', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.insert(blk('b'), { slot: ROOT_SLOT_KEY })
      history.updateFields('a', { set: { v: 2 } })
      history.move('a', { slot: ROOT_SLOT_KEY, index: 1 })
      history.replace('b', blk('b', { renamed: true }))
      history.reorder(ROOT_SLOT_KEY, 0, 1)
      history.remove('a')
      expect(history.size.value).toBe(6)
      expect(history.cursor.value).toBe(6)
    })

    it('peek().undo returns the last entry', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      const peeked = history.peek().undo
      expect(peeked).not.toBeNull()
      expect(peeked?.kind).toBe('single')
      expect(peeked?.kind === 'single' && peeked.op).toMatchObject({
        op: 'updateFields',
        id: 'a',
      })
    })
  })

  describe('undo / redo', () => {
    it('undo applies the inverse and updates the tree', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      expect(tree.get('a')?.fields).toEqual({ v: 2 })
      history.undo()
      expect(tree.get('a')?.fields).toEqual({ v: 1 })
    })

    it('redo re-applies the op', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      history.undo()
      history.redo()
      expect(tree.get('a')?.fields).toEqual({ v: 2 })
    })

    it('undo on empty history returns null and does nothing', () => {
      const tree = new BlockTree([blk('a')])
      const history = new History(tree)
      expect(history.undo()).toBeNull()
      expect(tree.get('a')).not.toBeNull()
    })

    it('redo on a clean cursor returns null and does nothing', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      // Cursor at the top — nothing to redo.
      expect(history.redo()).toBeNull()
      expect(tree.get('a')?.fields).toEqual({ v: 2 })
    })

    it('undo returns the entry that was undone', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      const undone = history.undo()
      expect(undone?.kind).toBe('single')
    })

    it('round-trip: insert / remove / reorder / replace / move / updateFields all reversible', () => {
      const initial = [
        blk('A', { v: 1 }),
        blk('B', {}, { cta: [blk('B1', { x: 'old' })] }),
        blk('C'),
      ]
      const tree = new BlockTree(initial)
      const history = new History(tree)
      const initialSnap = tree.serialize()

      history.insert(blk('D'), { slot: ROOT_SLOT_KEY })
      history.updateFields('B1', { set: { x: 'new' } })
      history.move('A', { slot: 'B:cta' as SlotKey, index: 0 })
      history.replace('C', blk('C', { renamed: true }))
      history.reorder('B:cta' as SlotKey, 0, 1)
      history.remove('D')

      // Now undo every op — should land back on the initial tree.
      while (history.canUndo.value) history.undo()
      expect(tree.serialize()).toEqual(initialSnap)
    })

    it('redo all the way back forward reaches the same end state', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      history.undo()
      history.undo()
      history.redo()
      history.redo()
      expect(tree.get('a')?.fields).toEqual({ v: 3 })
    })
  })

  describe('redo branch is truncated by a new commit', () => {
    it('new mutation after undo wipes the redo branch', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      history.undo() // back to v=2
      expect(history.canRedo.value).toBe(true)

      history.updateFields('a', { set: { v: 99 } })
      expect(history.canRedo.value).toBe(false)
      expect(history.size.value).toBe(2) // first updateFields + the new one
      expect(tree.get('a')?.fields).toEqual({ v: 99 })

      // Redo should be impossible now.
      expect(history.redo()).toBeNull()
    })
  })

  describe('reactive refs fire exactly once per mutation', () => {
    it('canUndo flips false→true on the first push, fires its effect once', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      let runs = 0
      effect(() => {
        void history.canUndo.value
        runs++
      })
      const initial = runs
      history.updateFields('a', { set: { v: 2 } })
      expect(runs - initial).toBe(1)
      expect(history.canUndo.value).toBe(true)
    })

    it('size counter tracks every push and undo / redo', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      const sizeReads: number[] = []
      effect(() => {
        sizeReads.push(history.size.value)
      })
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      history.undo()
      history.redo()
      // size goes from 0 to 1 to 2 (push), undo doesn't change size, redo doesn't either.
      expect(sizeReads).toEqual([0, 1, 2])
    })

    it('cursor reflects undo/redo position', () => {
      const tree = new BlockTree([blk('a', { v: 1 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      expect(history.cursor.value).toBe(2)
      history.undo()
      expect(history.cursor.value).toBe(1)
      history.undo()
      expect(history.cursor.value).toBe(0)
      expect(history.canUndo.value).toBe(false)
    })
  })

  describe('maxEntries eviction', () => {
    it('caps the stack size and evicts oldest', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree, { maxEntries: 3 })
      history.updateFields('a', { set: { v: 1 } })
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      history.updateFields('a', { set: { v: 4 } })
      expect(history.size.value).toBe(3)
      expect(history.cursor.value).toBe(3)
    })

    it('after eviction, undoing as far as possible cannot reach the oldest state', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree, { maxEntries: 2 })
      history.updateFields('a', { set: { v: 1 } }) // entry 0 evicted later
      history.updateFields('a', { set: { v: 2 } })
      history.updateFields('a', { set: { v: 3 } })
      // Stack now holds: [v0→v2, v2→v3]. Cursor=2.
      // Undoing 2x lands at v=1, NOT v=0 (entry 0 is gone).
      while (history.canUndo.value) history.undo()
      expect(tree.get('a')?.fields).toEqual({ v: 1 })
    })

    it('default maxEntries is 50', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree)
      for (let i = 1; i <= 60; i++) {
        history.updateFields('a', { set: { v: i } })
      }
      expect(history.size.value).toBe(50)
    })

    it('eviction keeps cursor consistent', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree, { maxEntries: 3 })
      history.updateFields('a', { set: { v: 1 } })
      history.updateFields('a', { set: { v: 2 } })
      history.undo() // cursor: 2→1
      history.updateFields('a', { set: { v: 99 } }) // truncate redo, push, cursor=2

      // Now push enough to trigger eviction.
      history.updateFields('a', { set: { v: 100 } }) // size=3, cursor=3
      history.updateFields('a', { set: { v: 101 } }) // evict oldest, cursor=3 still

      expect(history.size.value).toBe(3)
      expect(history.cursor.value).toBe(3)
    })
  })

  describe('clear()', () => {
    it('empties the stack and resets reactive refs', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 1 } })
      history.updateFields('a', { set: { v: 2 } })
      history.clear()
      expect(history.size.value).toBe(0)
      expect(history.cursor.value).toBe(0)
      expect(history.canUndo.value).toBe(false)
      expect(history.canRedo.value).toBe(false)
      expect(history.peek()).toEqual({ undo: null, redo: null })
    })

    it('clear does NOT touch the tree', () => {
      const tree = new BlockTree([blk('a', { v: 0 })])
      const history = new History(tree)
      history.updateFields('a', { set: { v: 1 } })
      history.clear()
      // Tree still has v=1; clear only forgets history, doesn't undo.
      expect(tree.get('a')?.fields).toEqual({ v: 1 })
    })
  })
})
