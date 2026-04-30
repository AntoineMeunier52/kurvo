import { describe, expect, it } from 'vitest'

import { applyOperation } from '../../src/state/apply-operation'
import type { Block, BlockId, Locator, LocatorInfo, SlotKey, TreeOperation } from '../../src/types'
import { ROOT_SLOT_KEY } from '../../src/types'

// ─── helpers ──────────────────────────────────────────────────────────────

const blk = (
  id: string,
  fields: Record<string, unknown> = {},
  slots?: Record<string, Block[]>,
): Block => (slots ? { id, type: 'Box', fields, slots } : { id, type: 'Box', fields })

/** Mulberry32 — seedable PRNG so failures reproduce. */
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
 * Build a fresh locator by walking the tree and indexing every block.
 * Mirrors what `BlockTree` would build, but standalone so the test stays
 * decoupled from BlockTree's internals.
 */
const buildLocator = (blocks: Block[]): Locator => {
  const index = new Map<BlockId, LocatorInfo>()
  const walk = (arr: Block[], parentId: BlockId | null, slot: string | null): void => {
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

interface SlotDescriptor {
  slot: SlotKey
  count: number
}

const collectSlots = (blocks: Block[]): SlotDescriptor[] => {
  const out: SlotDescriptor[] = [{ slot: ROOT_SLOT_KEY, count: blocks.length }]
  const walk = (arr: Block[]): void => {
    for (const b of arr) {
      if (b.slots) {
        for (const [name, children] of Object.entries(b.slots)) {
          out.push({ slot: `${b.id}:${name}` as SlotKey, count: children.length })
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

const pickOp = (blocks: Block[], rng: () => number, newId: () => string): TreeOperation | null => {
  const ids = collectIds(blocks)
  const slots = collectSlots(blocks)
  if (ids.length === 0) return null

  const opTypes = ['insert', 'remove', 'move', 'reorder', 'updateFields', 'replace'] as const
  const opKind = opTypes[Math.floor(rng() * opTypes.length)] ?? 'insert'

  if (opKind === 'insert') {
    const slot = slots[Math.floor(rng() * slots.length)]
    if (!slot) return null
    return {
      op: 'insert',
      block: blk(newId(), { v: Math.floor(rng() * 100) }),
      target: { slot: slot.slot, index: Math.floor(rng() * (slot.count + 1)) },
    }
  }
  if (opKind === 'remove') {
    const id = ids[Math.floor(rng() * ids.length)]
    return id !== undefined ? { op: 'remove', id } : null
  }
  if (opKind === 'updateFields') {
    const id = ids[Math.floor(rng() * ids.length)]
    return id !== undefined
      ? { op: 'updateFields', id, set: { v: Math.floor(rng() * 1000) } }
      : null
  }
  if (opKind === 'reorder') {
    const candidates = slots.filter((s) => s.count >= 2)
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
    const slot = slots[Math.floor(rng() * slots.length)]
    if (id === undefined || !slot) return null
    return {
      op: 'move',
      id,
      target: { slot: slot.slot, index: Math.floor(rng() * (slot.count + 1)) },
    }
  }
  // replace
  const id = ids[Math.floor(rng() * ids.length)]
  if (id === undefined) return null
  return {
    op: 'replace',
    id,
    block: blk(id, { v: Math.floor(rng() * 1000) }),
    keepChildren: rng() < 0.5,
  }
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('applyOperation: walk-based path == spine-based path (property)', () => {
  // Critical safety net: any divergence between the two paths (typical cause:
  // refactoring one without the other) is caught immediately, regardless of
  // which downstream consumers happen to be tested.

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'random op stream — both paths produce identical { blocks, inverse, affected } (seed=%i)',
    (seed) => {
      let current: Block[] = [
        blk(
          'A',
          {},
          {
            x: [blk('A1'), blk('A2', {}, { y: [blk('A2a'), blk('A2b'), blk('A2c')] })],
          },
        ),
        blk('B', {}, { z: [blk('B1')] }),
        blk('C'),
      ]

      const rng = prng(seed)
      let counter = 0
      const newId = (): string => `n${counter++}`

      const OPS = 60
      let applied = 0
      let attempts = 0
      while (applied < OPS && attempts < OPS * 10) {
        attempts++
        const op = pickOp(current, rng, newId)
        if (!op) continue

        const locator = buildLocator(current)

        let walkResult: ReturnType<typeof applyOperation> | undefined
        let spineResult: ReturnType<typeof applyOperation> | undefined
        let walkErr: unknown
        let spineErr: unknown

        try {
          walkResult = applyOperation(current, op)
        } catch (e) {
          walkErr = e
        }
        try {
          spineResult = applyOperation(current, op, locator)
        } catch (e) {
          spineErr = e
        }

        // Both paths must agree on whether the op throws. (We accept slightly
        // different error messages — `mapBlockSpine` includes "locator
        // inconsistent" framing in some throws — but if one throws the other
        // must throw too.)
        if (walkErr !== undefined || spineErr !== undefined) {
          if (walkErr === undefined || spineErr === undefined) {
            throw new Error(
              `walk vs spine throw mismatch on op=${JSON.stringify(op)} | walk=${
                walkErr === undefined ? 'ok' : (walkErr as Error).message
              } | spine=${spineErr === undefined ? 'ok' : (spineErr as Error).message}`,
            )
          }
          continue
        }

        if (!walkResult || !spineResult) continue

        // Both succeeded → the three observable outputs must match exactly.
        expect(spineResult.blocks).toEqual(walkResult.blocks)
        expect(spineResult.inverse).toEqual(walkResult.inverse)
        expect(spineResult.affected).toEqual(walkResult.affected)

        current = walkResult.blocks
        applied++
      }

      expect(applied).toBeGreaterThan(0)
    },
  )

  it('throw-paths agree: every op that throws walk-side also throws spine-side', () => {
    // Targeted scenarios (not random) for the deterministic throw cases.
    const tree = [blk('p', {}, { cta: [blk('a'), blk('b')] })]
    const locator = buildLocator(tree)

    const cases: TreeOperation[] = [
      // unknown id
      { op: 'updateFields', id: 'ghost', set: { x: 1 } },
      { op: 'remove', id: 'ghost' },
      { op: 'replace', id: 'ghost', block: blk('ghost') },
      { op: 'move', id: 'ghost', target: { slot: ROOT_SLOT_KEY } },
      // out-of-bounds reorder
      { op: 'reorder', slot: 'p:cta' as SlotKey, from: 5, to: 0 },
      // unknown nested slot
      { op: 'reorder', slot: 'p:nope' as SlotKey, from: 0, to: 0 },
      // cycle move
      { op: 'move', id: 'p', target: { slot: 'p:cta' as SlotKey } },
      // insert into unknown parent
      { op: 'insert', block: blk('z'), target: { slot: 'ghost:cta' as SlotKey } },
    ]

    for (const op of cases) {
      const walkThrows = (() => {
        try {
          applyOperation(tree, op)
          return false
        } catch {
          return true
        }
      })()
      const spineThrows = (() => {
        try {
          applyOperation(tree, op, locator)
          return false
        } catch {
          return true
        }
      })()
      expect({ op, walkThrows, spineThrows }).toEqual({
        op,
        walkThrows: true,
        spineThrows: true,
      })
    }
  })
})
