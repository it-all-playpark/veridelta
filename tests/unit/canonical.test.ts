import { describe, expect, it } from 'vitest'
import { canonicalJson, NonCanonicalValueError } from '../../src/canonical.js'

describe('canonicalJson (§3.5)', () => {
  it('sorts keys lexicographically and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    )
  })

  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('rejects non-integer numbers', () => {
    expect(() => canonicalJson({ duration: 1.5 })).toThrow(
      NonCanonicalValueError,
    )
  })

  it('is stable across key insertion order', () => {
    const a = { x: 1, y: [1, 2, { k: 'v' }] }
    const b = { y: [1, 2, { k: 'v' }], x: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })
})
