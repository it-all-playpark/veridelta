/**
 * §6.4 selector-relation capability, vitest side: `selectorRelation`,
 * `selectorMatches`, `commandScopePerturbed` (`src/adapters/vitest/adapter.ts`)
 * as pure functions, independent of the comparator that consumes them.
 */
import { describe, expect, it } from 'vitest'
import {
  commandScopePerturbed,
  selectorMatches,
  selectorRelation,
} from '../../src/adapters/vitest/adapter.js'

describe('selectorRelation', () => {
  it('both empty is equal', () => {
    expect(selectorRelation([], [])).toBe('equal')
  })

  it('empty a with non-empty b is superset (a selects the universe)', () => {
    expect(selectorRelation([], ['src'])).toBe('superset')
  })

  it('empty b with non-empty a is subset (b selects the universe)', () => {
    expect(selectorRelation(['src'], [])).toBe('subset')
  })

  it('normalizes and dedupes to extensional equality', () => {
    expect(selectorRelation(['src', 'src'], ['src'])).toBe('equal')
  })

  it('a narrower path-segment prefix of b is subset', () => {
    expect(selectorRelation(['src/domain'], ['src'])).toBe('subset')
  })

  it('a wider path-segment prefix of b is superset', () => {
    expect(selectorRelation(['src'], ['src/domain'])).toBe('superset')
  })

  it('non-overlapping path-prefix tokens are disjoint', () => {
    expect(
      selectorRelation(['tests/alpha.test.ts'], ['tests/beta.test.ts']),
    ).toBe('disjoint')
  })

  it('b covers only one of two a tokens: superset (bSubA only)', () => {
    // b=['src'] covers a's 'src' token but not a's 'tests' token, so b is
    // not a subset of a; a=['src','tests'] covers all of b's tokens
    // ('src'), so b is a superset relative to a — i.e. relation(a, b) is
    // 'superset'.
    expect(selectorRelation(['src', 'tests'], ['src'])).toBe('superset')
  })

  it('a glob token makes the pair unknown', () => {
    expect(selectorRelation(['src/**'], ['src'])).toBe('unknown')
  })

  it('a file:line position filter token makes the pair unknown', () => {
    expect(selectorRelation(['a.test.ts:10'], ['a.test.ts'])).toBe('unknown')
  })

  it('a ".." segment makes the pair unknown', () => {
    expect(selectorRelation(['../a.test.ts'], ['a.test.ts'])).toBe('unknown')
  })

  it('case differences normalize to equal', () => {
    expect(selectorRelation(['SRC'], ['src'])).toBe('equal')
  })
})

describe('selectorMatches', () => {
  it('empty selector always matches', () => {
    expect(selectorMatches([], 'src/a.test.ts::t')).toBe('yes')
  })

  it('a path-prefix token matches a test id under it', () => {
    expect(selectorMatches(['src'], 'src/a.test.ts::t')).toBe('yes')
  })

  it('a path-prefix token that does not cover the rel is a decidable no', () => {
    expect(selectorMatches(['src'], 'tests/b.test.ts::t')).toBe('no')
  })

  it('a substring hit that is not a path-prefix is unknown', () => {
    // 'mysrc' contains 'src' as a substring but is not prefixed by it — the
    // decidable core (path-segment prefix) cannot resolve this either way.
    expect(selectorMatches(['src'], 'mysrc/a.test.ts::t')).toBe('unknown')
  })

  it('a non-decidable token alone is unknown', () => {
    expect(selectorMatches(['src/**'], 'src/a.test.ts::t')).toBe('unknown')
  })

  it('unions across tokens: any deciding yes wins', () => {
    expect(selectorMatches(['tests', 'src'], 'src/a.test.ts::t')).toBe('yes')
  })

  it('unions across tokens: no only when every token decides no', () => {
    expect(selectorMatches(['tests', 'other'], 'src/a.test.ts::t')).toBe('no')
  })
})

describe('commandScopePerturbed', () => {
  it.each([
    ['--changed'],
    ['--changed=HEAD~1'],
    ['--testNamePattern'],
    ['--testNamePattern=x'],
    ['-t'],
    ['-t=x'],
    ['--shard=1/2'],
    ['--related'],
  ])('%s perturbs scope', (flag) => {
    expect(commandScopePerturbed(['node', 'vitest.mjs', 'run', flag])).toBe(
      true,
    )
  })

  it('a command with no scope-perturbing flag is false', () => {
    expect(
      commandScopePerturbed(['node', 'vitest.mjs', 'run', '--project=x']),
    ).toBe(false)
  })
})
