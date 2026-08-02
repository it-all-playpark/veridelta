/**
 * F1: compare-side fail→flaky classification (§12-1 decision B-inconclusive,
 * §12-3 position B). When a baseline-red observation becomes pass|xpass in
 * current, and the current observation carries a finding, and the current
 * record declares `instrument.capabilities['retry-evidence'] === 'pass'`,
 * the transition is classified as `transitions.verification_inconclusive`
 * (not `repaired_same_surface` / `repaired_with_test_change`), and
 * `outcome_verdict` derives to `inconclusive`. Without the capability
 * declaration (vitest records, or older records with no `capabilities` at
 * all), the transition falls back to the existing `repaired_*` classification
 * (no silent misclassification for adapters that never claimed retry
 * evidence).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildComparisonReport } from '../../src/compare.js'
import type { FailureFinding, RunRecord } from '../../src/schema.js'
import { parseReport } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest',
      adapter_version: '1',
      composition_id: 'vitest-native/1',
      config_digest: 'cfg1',
    },
    environment: {
      runner: 'vitest',
      runner_version: '1',
      runtime: 'node',
      os: 'darwin',
      env_fingerprint: 'env1',
    },
    provenance: {
      head: 'deadbeef',
      dirty_diff_digest: 'dd1',
      tree_digest: 'td1',
    },
    surface: {
      inventory_digest: 'inv1',
      test_sources: {},
      config_sources: {},
      suppressed: [],
    },
    completeness: { status: 'complete', child_exit_code: 0 },
    observations: [{ test_id: 'a.test.ts::t', verdict: 'pass' }],
    recording: {
      recorder: 'vdelta-run',
      recorded_at_ms: 0,
      durations_us: {},
      raw_stdout: '',
      raw_stderr: '',
      capture_reason: 'complete',
      unhandled_errors: 0,
    },
    ...overrides,
  }
}

const finding: FailureFinding = {
  evidence_digest: 'ed1',
  structural_fingerprint: 'sf1',
  evidence: { errors: [] },
  context_digest: 'cd1',
  annex: { frames: [], console: [], location_line: null },
}

const playwrightInstrument = {
  adapter: 'playwright',
  adapter_version: '1',
  composition_id: 'playwright-native/1',
  config_digest: 'cfg1',
} as const

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  }
})

function reportForPair(
  baselineOverrides: Partial<RunRecord>,
  currentOverrides: Partial<RunRecord>,
): ReturnType<typeof buildComparisonReport> {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-flaky-inconclusive-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  store.writeRun(makeRecord(baselineOverrides))
  const { runId } = store.writeRun(makeRecord(currentOverrides))
  return buildComparisonReport(store, runId, { mode: 'previous-comparable' })
}

describe('compare: fail→flaky classification into verification_inconclusive (§12-1/§12-3)', () => {
  it('classifies baseline-fail/current-pass+finding as verification_inconclusive when retry-evidence capability is pass', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    expect(report.transitions?.verification_inconclusive).toEqual([
      'a.test.ts::t',
    ])
    expect(report.transitions?.repaired_same_surface).toEqual([])
    expect(report.transitions?.repaired_with_test_change).toEqual([])
    expect(report.outcome_verdict).toBe('inconclusive')
    expect(report.anchors['verification_inconclusive:a.test.ts::t']).toMatch(
      /^vdelta show/,
    )
  })

  it('does not classify when current capabilities lack retry-evidence (vitest shape)', () => {
    const report = reportForPair(
      {
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        instrument: {
          adapter: 'vitest',
          adapter_version: '1',
          composition_id: 'vitest-native/1',
          config_digest: 'cfg1',
          capabilities: {
            'failure-evidence': 'pass',
            'source-region-text': 'unsupported',
          },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    expect(report.transitions?.repaired_same_surface).toEqual(['a.test.ts::t'])
    expect(report.outcome_verdict).toBe('improved')
    expect(
      report.transitions && 'verification_inconclusive' in report.transitions,
    ).toBe(false)
  })

  it('does not classify when current record has no capabilities field at all (old record)', () => {
    const report = reportForPair(
      {
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    expect(report.transitions?.repaired_same_surface).toEqual(['a.test.ts::t'])
    expect(report.outcome_verdict).toBe('improved')
    expect(
      report.transitions && 'verification_inconclusive' in report.transitions,
    ).toBe(false)
  })

  it('does not classify when current pass has no finding, even with retry-evidence pass', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass' }],
      },
    )
    expect(report.transitions?.repaired_same_surface).toEqual(['a.test.ts::t'])
    expect(report.outcome_verdict).toBe('improved')
    expect(
      report.transitions && 'verification_inconclusive' in report.transitions,
    ).toBe(false)
  })

  it('does not classify when baseline was not red (flaky without baseline red)', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass' }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    expect(
      report.transitions && 'verification_inconclusive' in report.transitions,
    ).toBe(false)
    expect(report.transitions?.repaired_same_surface).toEqual([])
    expect(report.transitions?.repaired_with_test_change).toEqual([])
    expect(report.outcome_verdict).toBe('unchanged')
  })

  it('mixes flaky with an unrelated new_fail: outcome regressed, but flaky id still lands in verification_inconclusive', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [
          { test_id: 'a.test.ts::t', verdict: 'fail', finding },
          { test_id: 'b.test.ts::t', verdict: 'pass' },
        ],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [
          { test_id: 'a.test.ts::t', verdict: 'pass', finding },
          { test_id: 'b.test.ts::t', verdict: 'fail', finding },
        ],
      },
    )
    expect(report.outcome_verdict).toBe('regressed')
    expect(report.transitions?.verification_inconclusive).toEqual([
      'a.test.ts::t',
    ])
    expect(report.transitions?.new_fail).toEqual(['b.test.ts::t'])
  })

  it('mixes flaky with an unrelated repaired test (no regression): outcome inconclusive, wins over improved', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [
          { test_id: 'a.test.ts::t', verdict: 'fail', finding },
          { test_id: 'b.test.ts::t', verdict: 'fail', finding },
        ],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [
          { test_id: 'a.test.ts::t', verdict: 'pass', finding },
          { test_id: 'b.test.ts::t', verdict: 'pass' },
        ],
      },
    )
    expect(report.outcome_verdict).toBe('inconclusive')
    expect(report.transitions?.verification_inconclusive).toEqual([
      'a.test.ts::t',
    ])
    expect(report.transitions?.repaired_same_surface).toEqual(['b.test.ts::t'])
  })

  it('does not classify under partial comparability, and outcome stays inconclusive (existing partial behavior)', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        completeness: { status: 'partial', child_exit_code: 0 },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    expect(report.comparability).toBe('partial')
    expect(
      report.transitions && 'verification_inconclusive' in report.transitions,
    ).toBe(false)
    expect(report.outcome_verdict).toBe('inconclusive')
  })

  it('pre-registered side effect: baseline flaky (pass+finding), current fail → new_fail, outcome regressed', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
    )
    expect(report.transitions?.new_fail).toEqual(['a.test.ts::t'])
    expect(report.outcome_verdict).toBe('regressed')
  })

  it('round-trips through JSON.parse(JSON.stringify(report)) via parseReport', () => {
    const report = reportForPair(
      {
        instrument: playwrightInstrument,
        observations: [{ test_id: 'a.test.ts::t', verdict: 'fail', finding }],
      },
      {
        instrument: {
          ...playwrightInstrument,
          capabilities: { 'retry-evidence': 'pass' },
        },
        observations: [{ test_id: 'a.test.ts::t', verdict: 'pass', finding }],
      },
    )
    const roundTripped = JSON.parse(JSON.stringify(report))
    expect(() => parseReport(roundTripped)).not.toThrow()
    const parsed = parseReport(roundTripped)
    expect(parsed.transitions?.verification_inconclusive).toEqual([
      'a.test.ts::t',
    ])
  })
})
