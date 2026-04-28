import type { AssetRef } from './asset'
import type { Link } from './link'

/**
 * Component opaque cote core — typee precisement (Vue Component) au niveau `@kurvo/vue`.
 * Volontairement large pour preserver la frontiere "pas de dep Vue runtime dans core".
 */
export type ComponentLike = unknown

export type FieldType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'number'
  | 'boolean'
  | 'select'
  | 'image'
  | 'link'
  | 'color'
  | 'custom'

export interface RichTextValue {
  type: 'doc'
  content?: unknown[]
}

export type FieldValidator<V> = (value: V, allProps: Record<string, unknown>) => string | true

interface BaseFieldDefinition<T extends FieldType, V> {
  type: T
  label?: string
  description?: string
  required?: boolean
  default?: V
  validate?: FieldValidator<V>
}

export interface TextFieldDefinition extends BaseFieldDefinition<'text', string> {
  maxLength?: number
  minLength?: number
  placeholder?: string
}

export interface TextareaFieldDefinition extends BaseFieldDefinition<'textarea', string> {
  rows?: number
  maxLength?: number
  minLength?: number
}

export interface RichTextFieldDefinition extends BaseFieldDefinition<'richtext', RichTextValue> {
  marks?: readonly string[]
  nodes?: readonly string[]
}

export interface NumberFieldDefinition extends BaseFieldDefinition<'number', number> {
  min?: number
  max?: number
  step?: number
}

export type BooleanFieldDefinition = BaseFieldDefinition<'boolean', boolean>

export interface SelectFieldOption<V extends string = string> {
  value: V
  label: string | Record<string, string>
}

export interface SelectFieldDefinition<V extends string = string> extends BaseFieldDefinition<
  'select',
  V
> {
  options: ReadonlyArray<SelectFieldOption<V>>
  multiple?: boolean
}

export interface ImageFieldDefinition extends BaseFieldDefinition<'image', AssetRef> {
  accept?: readonly string[]
  maxSize?: number
}

export interface LinkFieldDefinition extends BaseFieldDefinition<'link', Link> {
  allowExternal?: boolean
  allowAnchor?: boolean
  allowAsset?: boolean
}

export interface ColorFieldDefinition extends BaseFieldDefinition<'color', string> {
  preset?: readonly string[]
  allowCustom?: boolean
}

/**
 * Field custom one-off (`f.custom<T>({...})`) ou genere par un FieldType register
 * (`f.register(defineFieldType(...))`).
 *
 * `name` permet d'identifier les types enregistres. Pour un one-off, `name` peut etre `undefined`.
 */
export interface CustomFieldDefinition<TValue = unknown> extends BaseFieldDefinition<
  'custom',
  TValue
> {
  name?: string
  component: ComponentLike
}

export type FieldDefinition =
  | TextFieldDefinition
  | TextareaFieldDefinition
  | RichTextFieldDefinition
  | NumberFieldDefinition
  | BooleanFieldDefinition
  | SelectFieldDefinition
  | ImageFieldDefinition
  | LinkFieldDefinition
  | ColorFieldDefinition
  | CustomFieldDefinition

/**
 * Valeur runtime stockee dans `Block.props[fieldName]`.
 *
 * Les fields custom peuvent stocker n'importe quoi (`unknown`), donc on ouvre l'union.
 */
export type Field = string | number | boolean | RichTextValue | AssetRef | Link | null | unknown

/**
 * Builder fluent renvoye par `f.text()`, `f.image()`, etc.
 *
 * Le parametre `TValue` reflete le type de la valeur stockee une fois le field configure
 * (`f.text()` → `string | undefined`, `.required()` → `string`).
 *
 * Methode `_build()` (interne) materialise la `FieldDefinition` finale.
 */
export interface FieldBuilder<TValue> {
  required(): FieldBuilder<NonNullable<TValue>>
  default(value: NonNullable<TValue>): FieldBuilder<TValue>
  label(label: string): FieldBuilder<TValue>
  description(description: string): FieldBuilder<TValue>
  validate(fn: FieldValidator<TValue>): FieldBuilder<TValue>
  /** @internal */
  _build(): FieldDefinition
  /** @internal phantom type pour l'inference */
  readonly _value?: TValue
}

/**
 * Definition d'un type de field reusable, retournee par `defineFieldType<TValue>(name, config)`.
 * Une fois passe a `f.register(...)`, accessible via `f.<name>()` typed identiquement aux builtins.
 */
export interface FieldTypeDefinition<TValue> {
  name: string
  component: ComponentLike
  default?: TValue
  validate?: FieldValidator<TValue>
  label?: string
  description?: string
  /** @internal phantom */
  readonly _value?: TValue
}

/**
 * Extrait `TValue` d'un `FieldBuilder<TValue>` ou d'un `FieldTypeDefinition<TValue>`.
 * Sert a `InferBlockProps<typeof MyBlock>`.
 */
export type InferFieldValue<F> =
  F extends FieldBuilder<infer V> ? V : F extends FieldTypeDefinition<infer V> ? V : unknown
