import type { AssetRef } from './asset'
import type { Link } from './link'

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

export interface RichTextValue {
  type: 'doc'
  content?: unknown[]
}

interface BaseFieldDefinition<T extends FieldType, V> {
  type: T
  label?: string
  description?: string
  required?: boolean
  default?: V
  validate?: (value: V, allProps: Record<string, unknown>) => string | true
}

export interface TextFieldDefinition extends BaseFieldDefinition<'text', string> {
  maxLength?: number
  placeholder?: string
}

export interface TextareaFieldDefinition extends BaseFieldDefinition<'textarea', string> {
  rows?: number
  maxLength?: number
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

export type Field = string | number | boolean | RichTextValue | AssetRef | Link | null
