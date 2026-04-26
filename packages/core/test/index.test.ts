import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index'

describe('@kurvo/core', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
