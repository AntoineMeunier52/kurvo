import type { Block, BlockId, Locator, SlotKey, Target, TreeOperation } from '../types'
import { ROOT_SLOT_KEY } from '../types'
import type { BlockNode } from '../types/block-node'
import { applyOperation } from './apply-operation'
import { shallowRef, type Reactive } from './reactive'

/**
 * Reactive wrapper around an immutable block tree, with a manually-maintained
 * `Map<BlockId, BlockNode>` index (parent pointers) for O(1) lookups.
 *
 * Pure orchestrator: delegates to {@link applyOperation} for the algebra,
 * rebuilds the index after each mutation, and validates id uniqueness on
 * insert/replace (which `applyOperation` does not enforce).
 *
 * History is intentionally NOT owned by this class — see Phase M4 for the
 * `History` companion. Each mutation method returns the inverse op so the
 * caller (or History) can stack it.
 */
export class BlockTree {
  private _blocks = shallowRef<Block[]>([])
  private _nodes: Map<BlockId, BlockNode> = new Map()

  constructor(initial: Block[] = []) {
    this._blocks.value = structuredClone(initial)
    this.rebuildIndex()
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  get blocks(): Reactive<Block[]> {
    return this._blocks.value
  }

  get size(): number {
    void this._blocks.value
    return this._nodes.size
  }

  get(id: BlockId): Block | null {
    void this._blocks.value
    return this._nodes.get(id)?.block ?? null
  }

  has(id: BlockId): boolean {
    void this._blocks.value
    return this._nodes.has(id)
  }

  getParent(id: BlockId): Block | null {
    void this._blocks.value
    const node = this._nodes.get(id)
    if (!node || node.parentId === null) return null
    return this._nodes.get(node.parentId)?.block ?? null
  }

  getPath(id: BlockId): SlotKey[] {
    void this._blocks.value
    if (!this._nodes.has(id)) return []

    const path: SlotKey[] = []
    let current = this._nodes.get(id)
    while (current) {
      if (current.parentId === null) {
        path.unshift(ROOT_SLOT_KEY)
        break
      }
      path.unshift(`${current.parentId}:${current.slot}` as SlotKey)
      current = this._nodes.get(current.parentId)
    }
    return path
  }

  // ─── Mutation (returns inverse op for History) ───────────────────────────

  insert(block: Block, target: Target): TreeOperation {
    return this.applyOp({ op: 'insert', block, target })
  }

  move(id: BlockId, target: Target): TreeOperation {
    return this.applyOp({ op: 'move', id, target })
  }

  remove(id: BlockId): TreeOperation {
    return this.applyOp({ op: 'remove', id })
  }

  replace(id: BlockId, block: Block, opts?: { keepChildren?: boolean }): TreeOperation {
    return this.applyOp({
      op: 'replace',
      id,
      block,
      keepChildren: opts?.keepChildren,
    })
  }

  reorder(slot: SlotKey, from: number, to: number): TreeOperation {
    return this.applyOp({ op: 'reorder', slot, from, to })
  }

  updateFields(
    id: BlockId,
    fields: { set?: Record<string, unknown>; unset?: readonly string[] },
  ): TreeOperation {
    return this.applyOp({
      op: 'updateFields',
      id,
      set: fields.set,
      unset: fields.unset,
    })
  }

  /**
   * Generic op application — useful to replay ops from history (undo/redo).
   *
   * Validates id uniqueness for `insert` and `replace` before delegating to
   * `applyOperation` (which assumes the caller has already enforced this).
   */
  applyOp(op: TreeOperation): TreeOperation {
    if (op.op === 'insert') {
      this.assertNoCollision(op.block)
    } else if (op.op === 'replace' && !op.keepChildren) {
      const oldBlock = this._nodes.get(op.id)?.block
      const exclude = oldBlock ? collectIds(oldBlock) : undefined
      this.assertNoCollision(op.block, exclude)
    }

    // Pass a locator built from the live index so applyOperation uses the
    // O(depth) spine-rebuild path instead of a recursive O(N) walk.
    const { blocks: next, inverse } = applyOperation(this._blocks.value, op, this.locator)
    // Rebuild the index BEFORE flipping the reactive ref so that any effect
    // re-running synchronously on the trigger sees a coherent (tree, index) pair.
    this.rebuildIndex(next)
    this._blocks.value = next
    return inverse
  }

  /**
   * Stable locator function bound to this instance's index.
   *
   * Non-serializable: this is a closure over `_nodes`. Use {@link serialize} to
   * snapshot the tree as plain JSON.
   */
  private readonly locator: Locator = (id) => {
    const node = this._nodes.get(id)
    if (!node) return null
    return { parentId: node.parentId, slot: node.slot, index: node.index }
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────

  serialize(): Block[] {
    return structuredClone(this._blocks.value)
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private rebuildIndex(blocks: Block[] = this._blocks.value): void {
    this._nodes.clear()
    this.indexBlocks(blocks, null, null)
  }

  private indexBlocks(blocks: Block[], parentId: BlockId | null, slot: string | null): void {
    // Invariant: a block lives at the document root (parentId === null) iff it has no slot
    // (slot === null). The spine helpers in applyOperation rely on this invariant to
    // reconstruct SlotKeys from LocatorInfo without an extra branch.
    if ((parentId === null) !== (slot === null)) {
      throw new Error(
        'BlockTree.indexBlocks: invariant violated — parentId and slot must be both null or both non-null',
      )
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!block) continue
      this._nodes.set(block.id, { block, parentId, slot, index: i })
      if (block.slots) {
        for (const [slotName, children] of Object.entries(block.slots)) {
          this.indexBlocks(children, block.id, slotName)
        }
      }
    }
  }

  /**
   * Assert that none of the ids carried by `block` (and its subtree) collide with
   * an existing id in the tree, except for ids in the optional `exclude` set
   * (used for `replace` to whitelist the old block's subtree which is being removed).
   */
  private assertNoCollision(block: Block, exclude?: Set<BlockId>): void {
    const ids = collectIds(block)
    for (const id of ids) {
      if (this._nodes.has(id) && (exclude === undefined || !exclude.has(id))) {
        throw new Error(`BlockTree: id "${id}" already exists in the tree`)
      }
    }
  }
}

/** Collect all block ids in a subtree (root included). Local helper. */
const collectIds = (block: Block): Set<BlockId> => {
  const ids = new Set<BlockId>()
  const walk = (b: Block): void => {
    ids.add(b.id)
    if (b.slots) {
      for (const children of Object.values(b.slots)) {
        for (const child of children) walk(child)
      }
    }
  }
  walk(block)
  return ids
}
