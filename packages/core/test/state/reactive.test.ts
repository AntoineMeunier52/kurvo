import { describe, expect, it, vi } from 'vitest'

import {
  computed,
  effect,
  isReactive,
  reactive,
  ref,
  shallowRef,
  snapshot,
  toRaw,
  triggerRef,
  watch,
  type Reactive,
  type Ref,
} from '../../src/state/reactive'

describe('state/reactive', () => {
  describe('ref', () => {
    it('wraps a scalar in a .value container', () => {
      const count = ref(0)
      expect(count.value).toBe(0)

      count.value = 5
      expect(count.value).toBe(5)
    })

    it('triggers an effect on mutation', () => {
      const count = ref(0)
      const observed: number[] = []

      effect(() => observed.push(count.value))

      count.value = 1
      count.value = 2

      expect(observed).toEqual([0, 1, 2])
    })

    it('preserves reactivity when wrapping an object', () => {
      const user: Ref<{ name: string }> = ref({ name: 'A' })
      const seen: string[] = []

      effect(() => seen.push(user.value.name))

      user.value.name = 'B'
      user.value = { name: 'C' }

      expect(seen).toEqual(['A', 'B', 'C'])
    })
  })

  describe('reactive', () => {
    it('tracks deep nested mutation', () => {
      const state: Reactive<{ nested: { count: number } }> = reactive({
        nested: { count: 0 },
      })
      const observed: number[] = []

      effect(() => observed.push(state.nested.count))

      state.nested.count = 1
      state.nested.count = 2

      expect(observed).toEqual([0, 1, 2])
    })

    it('reads return reactive proxies for nested objects (deep auto-wrap)', () => {
      const state = reactive({
        children: [{ id: 'a' }, { id: 'b' }],
      })

      const childA = state.children[0]
      expect(isReactive(childA)).toBe(true)
      expect(childA).not.toBe(toRaw(childA))
    })

    it('tracks native array mutations (push, splice, length=)', () => {
      const list = reactive<number[]>([])
      const lengths: number[] = []

      effect(() => lengths.push(list.length))

      list.push(1)
      list.push(2)
      list.splice(0, 1)
      list.length = 0

      expect(lengths).toEqual([0, 1, 2, 1, 0])
    })
  })

  describe('computed', () => {
    it('is lazy — does not run before first read', () => {
      const spy = vi.fn(() => 42)
      computed(spy)

      expect(spy).not.toHaveBeenCalled()
    })

    it('memoizes — recomputes only when a dep changes', () => {
      const a = ref(1)
      const b = ref(2)
      const spy = vi.fn(() => a.value + b.value)
      const sum = computed(spy)

      expect(sum.value).toBe(3)
      expect(sum.value).toBe(3)
      expect(spy).toHaveBeenCalledTimes(1)

      a.value = 10
      expect(sum.value).toBe(12)
      expect(spy).toHaveBeenCalledTimes(2)

      // unchanged read — still cached
      expect(sum.value).toBe(12)
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('chained computeds resolve through the DAG with a single recompute per source mutation', () => {
      const blocks = ref<{ id: string }[]>([])
      const indexSpy = vi.fn(() => new Map(blocks.value.map((b) => [b.id, b])))

      const nodesById = computed(indexSpy)
      const heroBlock = computed(() => nodesById.value.get('hero') ?? null)
      const hasHero = computed(() => heroBlock.value !== null)

      expect(hasHero.value).toBe(false)
      expect(indexSpy).toHaveBeenCalledTimes(1)

      blocks.value = [{ id: 'hero' }]
      expect(hasHero.value).toBe(true)
      expect(indexSpy).toHaveBeenCalledTimes(2)
    })

    it('supports writable get/set', () => {
      const first = ref('Antoine')
      const last = ref('Meunier')

      const full = computed({
        get: () => `${first.value} ${last.value}`,
        set: (v: string) => {
          const [f = '', l = ''] = v.split(' ')
          first.value = f
          last.value = l
        },
      })

      expect(full.value).toBe('Antoine Meunier')

      full.value = 'Jean Dupont'
      expect(first.value).toBe('Jean')
      expect(last.value).toBe('Dupont')
    })
  })

  describe('effect', () => {
    it('re-collects dependencies on each run (conditional tracking)', () => {
      const useA = ref(true)
      const a = ref(1)
      const b = ref(100)
      const observed: number[] = []

      effect(() => {
        observed.push(useA.value ? a.value : b.value)
      })

      a.value = 2
      useA.value = false
      a.value = 999
      b.value = 200

      expect(observed).toEqual([1, 2, 100, 200])
    })
  })

  describe('watch', () => {
    it('fires the callback only on subsequent changes by default', () => {
      const count = ref(0)
      const calls: Array<[number, number]> = []

      watch(count, (value, oldValue) => {
        calls.push([value, oldValue])
      })

      count.value = 1
      count.value = 2

      expect(calls).toEqual([
        [1, 0],
        [2, 1],
      ])
    })
  })

  describe('shallowRef', () => {
    it('does not track deep mutation — only .value reassignment', () => {
      const list = shallowRef<number[]>([1, 2, 3])
      const seen: number[] = []

      effect(() => seen.push(list.value.length))

      list.value.push(4)
      expect(seen).toEqual([3])

      list.value = [10, 20]
      expect(seen).toEqual([3, 2])
    })

    it('triggerRef forces notification after deep mutation', () => {
      const list = shallowRef<number[]>([1, 2, 3])
      const seen: number[] = []

      effect(() => seen.push(list.value.length))

      list.value.push(4)
      triggerRef(list)

      expect(seen).toEqual([3, 4])
    })
  })

  describe('toRaw', () => {
    it('unwraps the proxy and returns the original object', () => {
      const original = { id: 'a' }
      const proxy = reactive(original)

      expect(proxy).not.toBe(original)
      expect(toRaw(proxy)).toBe(original)
    })

    it('does NOT clone — mutating raw still mutates the reactive view', () => {
      const proxy = reactive({ count: 0 })
      const raw = toRaw(proxy)

      raw.count = 5
      expect(proxy.count).toBe(5)
    })
  })

  describe('snapshot', () => {
    it('returns a deep clone — mutating clone does not affect source', () => {
      const tree = reactive({
        id: 'root',
        children: [
          { id: 'a', title: 'Hero' },
          { id: 'b', title: 'Footer' },
        ],
      })

      const clone = snapshot(tree)

      expect(clone).toEqual(toRaw(tree))
      expect(clone).not.toBe(toRaw(tree))
      expect(clone.children).not.toBe(toRaw(tree).children)

      const [firstClone] = clone.children
      const [firstSrc] = tree.children
      if (!firstClone || !firstSrc) throw new Error('children empty')

      firstClone.title = 'CLONE'
      expect(firstSrc.title).toBe('Hero')
    })

    it('strips reactivity from the result', () => {
      const state = reactive({ id: 'a' })
      const clone = snapshot(state)

      expect(isReactive(state)).toBe(true)
      expect(isReactive(clone)).toBe(false)
    })

    it('works on a plain non-reactive value', () => {
      const plain = { id: 'x', count: 1 }
      const clone = snapshot(plain)

      expect(clone).toEqual(plain)
      expect(clone).not.toBe(plain)
    })
  })

  describe('runtime portability', () => {
    it('runs without DOM globals', () => {
      expect(typeof globalThis.document).toBe('undefined')
      expect(typeof globalThis.window).toBe('undefined')

      const r = ref(0)
      const c = computed(() => r.value * 2)
      r.value = 21
      expect(c.value).toBe(42)
    })
  })
})
