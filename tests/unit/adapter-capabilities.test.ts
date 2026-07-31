/**
 * The capability declaration → `degraded_capabilities` derivation (§4.1, §4.2).
 *
 * Step 1 must not move a single byte of what a report discloses, and Step 2
 * puts the declaration *into* the record and derives the disclosure from it.
 * Both steps hinge on one equality: the vitest declaration must reduce to
 * exactly `['source-region-text']`, which is what the pre-seam constant said.
 * This file pins that equality at the declaration level; the report level is
 * pinned in `evidence-disclosure.test.ts`, and the two must not drift apart.
 */
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_VALUES,
  type CapabilityDeclaration,
  degradedCapabilities,
} from '../../src/adapter.js'
import { PLAYWRIGHT_CAPABILITIES } from '../../src/adapters/playwright/adapter.js'
import { resolveAdapter } from '../../src/adapters/registry.js'
import {
  VITEST_CAPABILITIES,
  vitestAdapter,
} from '../../src/adapters/vitest/adapter.js'
import { DEGRADED_CAPABILITIES } from '../../src/index.js'

describe('vitest capability declaration (§4.1)', () => {
  it('derives exactly the pre-seam degraded set', () => {
    // Byte-for-byte the value `DEGRADED_CAPABILITIES` held before the seam
    // existed. Any change here changes every report's `failure_evidence`.
    expect(degradedCapabilities(VITEST_CAPABILITIES)).toEqual([
      'source-region-text',
    ])
  })

  it('declares CE-1 as the only shortfall of vitest-native/2', () => {
    // The whole declaration is frozen, not just its reduction: a capability
    // added as `pass` would leave the derived list unchanged and slip through
    // the assertion above, yet it is a claim the composition now makes.
    expect(VITEST_CAPABILITIES).toEqual({
      verdicts: 'pass',
      'source-location': 'pass',
      suppression: 'pass',
      inventory: 'pass',
      'failure-evidence': 'pass',
      'source-region-text': 'unsupported',
    })
  })

  it('declares only values from the closed enum (§3.4)', () => {
    // A misspelt value (`'unsuported'`) would drop the capability out of the
    // degraded list silently — the disclosure would shrink, not error. Assert
    // membership so a typo surfaces as a typo, not as a missing shortfall.
    for (const [name, value] of Object.entries(VITEST_CAPABILITIES)) {
      expect(
        CAPABILITY_VALUES,
        `capability '${name}' declares an unknown value '${value}'`,
      ).toContain(value)
    }
  })

  it('reaches the public surface and the registry unchanged', () => {
    // Three paths must agree: the descriptor's own declaration, what the
    // registry hands the comparator and the gate, and what `src/index.ts`
    // publishes to consumers.
    expect(vitestAdapter.declaredCapabilities).toEqual(VITEST_CAPABILITIES)
    expect(
      degradedCapabilities(resolveAdapter('vitest').declaredCapabilities),
    ).toEqual(['source-region-text'])
    expect(DEGRADED_CAPABILITIES).toEqual(['source-region-text'])
  })
})

describe('playwright capability declaration (F2, docs/compositions/playwright-native-1.md §8, decision 6)', () => {
  it('declares the full 8-capability set frozen (verdicts through resolved-config-coverage)', () => {
    // Unlike vitest, source-region-text is 'pass' here (tree-reconstructed —
    // doc §8), and this composition additionally declares retry-evidence
    // ('pass') and resolved-config-coverage ('unsupported', expect.timeout
    // is never exposed on resolved FullConfig — doc §4 expect.timeout row).
    expect(PLAYWRIGHT_CAPABILITIES).toEqual({
      verdicts: 'pass',
      'source-location': 'pass',
      suppression: 'pass',
      inventory: 'pass',
      'failure-evidence': 'pass',
      'source-region-text': 'pass',
      'retry-evidence': 'pass',
      'resolved-config-coverage': 'unsupported',
    })
  })

  it("derives ['resolved-config-coverage'] from the helper — a distinct thing from a report's degraded_capabilities", () => {
    // degradedCapabilities() is a generic reduction over ANY
    // CapabilityDeclaration (§4.2): it reports every 'unsupported' key,
    // regardless of whether that key is evidence-bearing. This is NOT the
    // same set a comparison report's failure_evidence.degraded_capabilities
    // would carry for a playwright record: that field is derived only from
    // schema.ts's EVIDENCE_CAPABILITY_NAMES (['failure-evidence',
    // 'source-region-text'] — frozen, decision 6), neither of which
    // playwright declares 'unsupported'. So a playwright run's report-level
    // failure_evidence.degraded_capabilities is always [], even though this
    // helper-level reduction is ['resolved-config-coverage'].
    expect(degradedCapabilities(PLAYWRIGHT_CAPABILITIES)).toEqual([
      'resolved-config-coverage',
    ])
  })

  it('declares only values from the closed enum (§3.4)', () => {
    for (const [name, value] of Object.entries(PLAYWRIGHT_CAPABILITIES)) {
      expect(
        CAPABILITY_VALUES,
        `capability '${name}' declares an unknown value '${value}'`,
      ).toContain(value)
    }
  })
})

describe('degradedCapabilities (§4.2 derivation rule)', () => {
  it("counts 'unsupported' only — 'fail' means met and red", () => {
    // Treating `fail` as degraded would report a red-but-fully-evidenced
    // composition as missing evidence, which inverts the disclosure's meaning.
    const caps: CapabilityDeclaration = {
      met: 'pass',
      red: 'fail',
      missing: 'unsupported',
    }
    expect(degradedCapabilities(caps)).toEqual(['missing'])
  })

  it('sorts by name rather than by declaration order', () => {
    // Reports are byte-compared (§7.8 determinism), so the output cannot
    // depend on the order the adapter author happened to write the keys in.
    const caps: CapabilityDeclaration = {
      zeta: 'unsupported',
      alpha: 'unsupported',
      mid: 'pass',
    }
    expect(degradedCapabilities(caps)).toEqual(['alpha', 'zeta'])
  })

  it('is empty for a composition that declares no shortfall', () => {
    expect(degradedCapabilities({ verdicts: 'pass' })).toEqual([])
    expect(degradedCapabilities({})).toEqual([])
  })
})
