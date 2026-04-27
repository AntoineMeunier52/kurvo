/**
 * @kurvo/core — abstraction layer over @vue/reactivity.
 *
 * Only this file is authorized to import from `@vue/reactivity` directly.
 * Every other module in core imports reactivity primitives from here.
 *
 * This indirection lets us:
 *  - migrate to a different reactivity engine (TC39 Signals, etc.) by editing
 *    a single file
 *  - make the @vue/reactivity surface we depend on explicit and auditable
 *  - layer Kurvo-specific helpers (e.g. `snapshot`) on top of the primitives
 */

import {
  computed as vueComputed,
  effect as vueEffect,
  isProxy as vueIsProxy,
  isReactive as vueIsReactive,
  isReadonly as vueIsReadonly,
  isRef as vueIsRef,
  markRaw as vueMarkRaw,
  reactive as vueReactive,
  readonly as vueReadonly,
  ref as vueRef,
  shallowReactive as vueShallowReactive,
  shallowRef as vueShallowRef,
  toRaw as vueToRaw,
  toRef as vueToRef,
  toRefs as vueToRefs,
  triggerRef as vueTriggerRef,
  unref as vueUnref,
  watch as vueWatch,
} from '@vue/reactivity'

import type {
  ComputedRef,
  MaybeRef,
  MaybeRefOrGetter,
  Ref,
  ShallowRef,
  UnwrapNestedRefs,
  UnwrapRef,
  WatchCallback,
  WatchOptions,
  WatchSource,
  WritableComputedRef,
} from '@vue/reactivity'

// Functions

export const ref = vueRef
export const reactive = vueReactive
export const readonly = vueReadonly
export const computed = vueComputed
export const effect = vueEffect
export const watch = vueWatch

export const shallowRef = vueShallowRef
export const shallowReactive = vueShallowReactive
export const triggerRef = vueTriggerRef

export const isRef = vueIsRef
export const isReactive = vueIsReactive
export const isReadonly = vueIsReadonly
export const isProxy = vueIsProxy

export const toRaw = vueToRaw
export const unref = vueUnref
export const toRef = vueToRef
export const toRefs = vueToRefs
export const markRaw = vueMarkRaw

// Types

export type {
  ComputedRef,
  MaybeRef,
  MaybeRefOrGetter,
  Ref,
  ShallowRef,
  UnwrapRef,
  WatchCallback,
  WatchOptions,
  WatchSource,
  WritableComputedRef,
}

/**
 * Type of a reactive proxy of T.
 */
export type Reactive<T> = UnwrapNestedRefs<T>

// Specific helpers

/**
 * Deep-clone a reactive value into a plain JS object, severing all reactivity
 *
 * Always prefer `snapshot(x)` over `toRaw(x)` when you need a *standalone* copy:
 * `toRaw` only unwraps the surface proxy, leaving nested objects shared with
 * the live state. `structuredClone` over `toRaw` ensures full isolation.
 */
export function snapshot<T>(value: T): T {
  return structuredClone(vueToRaw(value as object) as T)
}
