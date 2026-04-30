import { describe, expect, it } from 'vitest'

import { BlockTree } from '../../src/state/block-tree'
import type { Block, BlockId, SlotKey, TreeOperation } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/**
 * Snapshot of the index, normalized to plain objects for deep-equal comparison.
 * Reaches into the private `_nodes` map intentionally — this test exists to
 * guarantee the incremental patch keeps the index byte-equivalent to a fresh
 * full rebuild.
 */
const snapshotIndex = (tree: BlockTree): Record<string, unknown> => {
  const nodes = (tree as unknown as { _nodes: Map<BlockId, unknown> })._nodes
  const out: Record<string, unknown> = {}
  for (const [id, node] of nodes) {
    out[id] = node
  }
  return out
}

/**
 * Simple seedable PRNG (mulberry32). Deterministic so failures are reproducible.
 */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick the SlotKey of any existing block's slot, plus the root slot.
 * Returns the candidate slot keys with the count of children currently in each.
 */
const collectSlots = (
  blocks: Block[],
): Array<{ slot: SlotKey; count: number; parentId: BlockId | null }> => {
  const out: Array<{ slot: SlotKey; count: number; parentId: BlockId | null }> = [
    { slot: ROOT_SLOT_KEY, count: blocks.length, parentId: null },
  ]
  const walk = (arr: Block[]): void => {
    for (const b of arr) {
      if (b.slots) {
        for (const [name, children] of Object.entries(b.slots)) {
          out.push({
            slot: `${b.id}:${name}` as SlotKey,
            count: children.length,
            parentId: b.id,
          })
          walk(children)
        }
      }
    }
  }
  walk(blocks)
  return out
}

const collectIds = (blocks: Block[]): BlockId[] => {
  const ids: BlockId[] = []
  const walk = (arr: Block[]): void => {
    for (const b of arr) {
      ids.push(b.id)
      if (b.slots) {
        for (const children of Object.values(b.slots)) walk(children)
      }
    }
  }
  walk(blocks)
  return ids
}

/**
 * Pick a random op valid against the current tree. Returns null if no op is
 * applicable (e.g. empty tree and PRNG steers us toward `remove`).
 *
 * The op may still throw at apply time (e.g. cycle on `move`); the caller
 * is expected to swallow that and try another op — the property tested is
 * "successful op leaves index byte-equal to full rebuild", not "every random
 * op succeeds".
 */
const pickOp = (
  tree: BlockTree,
  blocks: Block[],
  rng: () => number,
  newIdCounter: { n: number },
): TreeOperation | null => {
  const ids = collectIds(blocks)
  const slots = collectSlots(blocks)
  const opTypes = ['insert', 'remove', 'move', 'reorder', 'updateFields', 'replace'] as const
  const opKind = opTypes[Math.floor(rng() * opTypes.length)] ?? 'insert'

  const newId = (): string => `n${newIdCounter.n++}`

  if (opKind === 'insert' || ids.length === 0) {
    const slot = slots[Math.floor(rng() * slots.length)] ?? slots[0]
    if (!slot) return null
    return {
      op: 'insert',
      block: blk(newId(), { v: Math.floor(rng() * 100) }),
      target: { slot: slot.slot, index: Math.floor(rng() * (slot.count + 1)) },
    }
  }

  if (opKind === 'remove') {
    const id = ids[Math.floor(rng() * ids.length)]
    if (id === undefined) return null
    return { op: 'remove', id }
  }

  if (opKind === 'updateFields') {
    const id = ids[Math.floor(rng() * ids.length)]
    if (id === undefined) return null
    return { op: 'updateFields', id, set: { v: Math.floor(rng() * 1000) } }
  }

  if (opKind === 'reorder') {
    // Pick a slot with at least 2 children.
    const candidates = slots.filter((s) => s.count >= 2)
    if (candidates.length === 0) return null
    const s = candidates[Math.floor(rng() * candidates.length)]
    if (!s) return null
    return {
      op: 'reorder',
      slot: s.slot,
      from: Math.floor(rng() * s.count),
      to: Math.floor(rng() * s.count),
    }
  }

  if (opKind === 'move') {
    const id = ids[Math.floor(rng() * ids.length)]
    if (id === undefined) return null
    const slot = slots[Math.floor(rng() * slots.length)] ?? slots[0]
    if (!slot) return null
    return {
      op: 'move',
      id,
      target: { slot: slot.slot, index: Math.floor(rng() * (slot.count + 1)) },
    }
  }

  // replace
  const id = ids[Math.floor(rng() * ids.length)]
  if (id === undefined) return null
  const keepChildren = rng() < 0.5
  return {
    op: 'replace',
    id,
    block: blk(id, { v: Math.floor(rng() * 1000) }),
    keepChildren,
  }
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('BlockTree: incremental index == full rebuild (property)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'random op stream stays equivalent to a fresh BlockTree (seed=%i)',
    (seed) => {
      const initial: Block[] = [
        blk(
          'A',
          {},
          {
            x: [blk('A1'), blk('A2', {}, { y: [blk('A2a'), blk('A2b')] })],
          },
        ),
        blk('B'),
        blk('C', {}, { z: [blk('C1')] }),
      ]
      const tree = new BlockTree(initial)
      const rng = prng(seed)
      const newIdCounter = { n: 0 }

      const OPS_PER_SEED = 60
      let applied = 0
      let attempts = 0
      // Cap attempts so a stream that constantly hits invalid ops still terminates.
      while (applied < OPS_PER_SEED && attempts < OPS_PER_SEED * 10) {
        attempts++
        const op = pickOp(tree, tree.serialize(), rng, newIdCounter)
        if (!op) continue
        try {
          tree.applyOp(op)
        } catch {
          // Expected for cycle moves, id collisions, out-of-bounds reorders, etc.
          continue
        }
        applied++

        // Invariant: after every successful op, the incremental index must
        // match what a full rebuild would produce against the same tree.
        const incremental = snapshotIndex(tree)
        const fresh = snapshotIndex(new BlockTree(tree.serialize()))
        expect(incremental).toEqual(fresh)
      }

      // Sanity: we actually exercised ops.
      expect(applied).toBeGreaterThan(0)
    },
  )

  it('throwing ops do not corrupt the index', () => {
    const tree = new BlockTree([blk('p', {}, { cta: [blk('child')] })])
    const before = snapshotIndex(tree)

    // Cycle move: should throw, leave the tree + index untouched.
    expect(() =>
      tree.applyOp({ op: 'move', id: 'p', target: { slot: 'p:cta' as SlotKey } }),
    ).toThrow()
    expect(snapshotIndex(tree)).toEqual(before)

    // Id collision on insert: should throw, leave the tree + index untouched.
    expect(() => tree.insert(blk('p'), { slot: ROOT_SLOT_KEY })).toThrow(/already exists/)
    expect(snapshotIndex(tree)).toEqual(before)

    // Out-of-bounds reorder: should throw, no index drift.
    expect(() => tree.reorder('p:cta' as SlotKey, 5, 0)).toThrow(/out of bounds/)
    expect(snapshotIndex(tree)).toEqual(before)
  })
})
