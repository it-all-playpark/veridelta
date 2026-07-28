/**
 * The adapter registry (§4.3). Three properties decide whether a second
 * adapter can be added safely, and none of them is observable from the
 * conformance suite (which only ever records with vitest):
 *
 *  1. an unknown `--adapter` name is an *error*, never a quiet no-op (§4.3-5);
 *  2. `detect` is evaluated on *every* adapter, so two claimants surface as a
 *     candidate list instead of being hidden by registry order (§4.3-2);
 *  3. registry order is deterministic and is the order every list the user
 *     sees is rendered in.
 *
 * The tests take a registry argument where they can, so the ordering and
 * multi-match properties are exercised with more than one adapter today
 * rather than becoming meaningful only once playwright lands.
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, DetectResult } from '../../src/adapter.js'
import {
  ADAPTERS,
  adapterNames,
  detectAdapter,
  findAdapter,
  resolveAdapter,
} from '../../src/adapters/registry.js'
import { vitestAdapter } from '../../src/adapters/vitest/adapter.js'

/**
 * A detect-only stand-in; the registry never calls the rest for detection.
 * `calls` records every evaluation so "all adapters were asked" is checked
 * directly rather than inferred from the outcome.
 */
function stubAdapter(
  name: string,
  matches: boolean,
  calls: string[] = [],
): Adapter {
  return {
    ...vitestAdapter,
    name,
    detect: (): DetectResult | null => {
      calls.push(name)
      return matches ? { tokenIndex: 0 } : null
    },
  }
}

describe('adapter registry (§4.3)', () => {
  it('lists adapters in a deterministic order', () => {
    expect(adapterNames()).toEqual(['vitest'])
    expect(ADAPTERS.map((a) => a.name)).toEqual(adapterNames())
  })

  it('renders names in registry order, not sorted or reversed', () => {
    const registry = [
      stubAdapter('zeta', false),
      stubAdapter('alpha', false),
      stubAdapter('mid', false),
    ]
    expect(adapterNames(registry)).toEqual(['zeta', 'alpha', 'mid'])
  })

  it('resolves a known adapter name to its descriptor', () => {
    expect(resolveAdapter('vitest')).toBe(vitestAdapter)
    expect(findAdapter('vitest')).toBe(vitestAdapter)
  })

  it('throws on an unknown adapter name and names the known ones', () => {
    expect(() => resolveAdapter('playwright')).toThrow(/unknown adapter/)
    expect(() => resolveAdapter('playwright')).toThrow(/vitest/)
  })

  it('enumerates every known name, in registry order, in the error', () => {
    const registry = [stubAdapter('zeta', false), stubAdapter('alpha', false)]
    expect(() => resolveAdapter('nope', registry)).toThrow(
      "unknown adapter 'nope' — known adapters: zeta, alpha",
    )
  })

  it('matches names exactly — a near miss is a miss, not a guess', () => {
    // A typo must reach the user as a typo (§4.3-5). Case-folding, trimming
    // or prefix matching here would resolve `Vitest` to the vitest adapter
    // and silently instrument a run the user did not ask for.
    for (const typo of ['Vitest', 'vitest ', 'vite', 'vitest-native']) {
      expect(findAdapter(typo)).toBeUndefined()
      expect(() => resolveAdapter(typo)).toThrow(/unknown adapter/)
    }
  })

  it('reports an unknown name as absent without throwing (fail-closed callers)', () => {
    expect(findAdapter('playwright')).toBeUndefined()
  })

  it('detects a single matching adapter and carries its DetectResult', () => {
    const detection = detectAdapter(['node', '/x/vitest.mjs', 'run'])
    expect(detection).toEqual({
      kind: 'unique',
      adapter: vitestAdapter,
      detected: { tokenIndex: 1 },
    })
  })

  it('reports no match for a wrapper command instead of guessing', () => {
    expect(detectAdapter(['pnpm', '-r', 'test'])).toEqual({ kind: 'none' })
  })

  it('returns the adapter that matched, not the first registered', () => {
    const declines = stubAdapter('declines', false)
    const claims = stubAdapter('claims', true)
    expect(detectAdapter(['x'], [declines, claims])).toEqual({
      kind: 'unique',
      adapter: claims,
      detected: { tokenIndex: 0 },
    })
  })

  it('evaluates every adapter and reports two matches as ambiguous', () => {
    const a = stubAdapter('a', true)
    const b = stubAdapter('b', true)
    const c = stubAdapter('c', false)
    const detection = detectAdapter(['x'], [a, c, b])
    expect(detection).toEqual({ kind: 'ambiguous', candidates: [a, b] })
  })

  it('asks every adapter exactly once even after one has claimed the argv', () => {
    // Short-circuiting on the first match would turn an ambiguous argv into a
    // silent `unique` decided by registry order — the outcome §4.3-2 exists
    // to prevent. Asserting the call log catches it at the source.
    const calls: string[] = []
    const registry = [
      stubAdapter('first', true, calls),
      stubAdapter('second', true, calls),
      stubAdapter('third', false, calls),
    ]
    detectAdapter(['x'], registry)
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('lists ambiguous candidates in registry order', () => {
    const a = stubAdapter('a', true)
    const b = stubAdapter('b', true)
    const forward = detectAdapter(['x'], [a, b])
    const reversed = detectAdapter(['x'], [b, a])
    expect(forward).toEqual({ kind: 'ambiguous', candidates: [a, b] })
    expect(reversed).toEqual({ kind: 'ambiguous', candidates: [b, a] })
  })
})
