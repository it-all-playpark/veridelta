/**
 * G1: subset comparability (spec §6.1/§6.4). `judgeComparability` consults the
 * vitest adapter's declared `selectorRelation`/`selectorMatches`/
 * `commandScopePerturbed` (F1, src/adapters/vitest/adapter.ts) to prove a
 * `subset` narrowing when the baseline and current selectors differ, and
 * partitions baseline-only test ids into `out_of_scope` (selector-excluded,
 * never claimed as removed/repaired) versus `removed` (still in scope but
 * unobserved). Every unproven step (undeclared capability, perturbed
 * command, non-`subset` relation, incomplete run, per-id `unknown` match)
 * falls back to the pre-existing `selector-relation-unknown` abstention
 * (fail-closed, §6.4).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildComparisonReport } from '../../src/compare.js'
import type { RunRecord } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest',
      adapter_version: '1',
      composition_id: 'vitest-native/2',
      config_digest: 'cfg1',
      capabilities: { 'selector-relation': 'pass' },
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

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  }
})

function reportForPair(
  baselineOverrides: Partial<RunRecord>,
  currentOverrides: Partial<RunRecord>,
): {
  report: ReturnType<typeof buildComparisonReport>
  baselineRunId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-subset-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  const { runId: baselineRunId } = store.writeRun(makeRecord(baselineOverrides))
  const { runId } = store.writeRun(makeRecord(currentOverrides))
  // `previous-comparable` selection requires an exact stream-key match
  // (streamKey() includes invocation.selector), so it would never even
  // *select* a baseline whose selector differs from current's — these
  // tests need the selector-mismatch judgment inside judgeComparability to
  // run, so they pin the baseline explicitly instead.
  const report = buildComparisonReport(store, runId, {
    mode: 'explicit-run-id',
    runId: baselineRunId,
  })
  return { report, baselineRunId }
}

describe('subset comparability (§6.1/§6.4)', () => {
  it('proves subset, partitions out_of_scope vs removed, and points anchors at the baseline run', () => {
    const { report, baselineRunId } = reportForPair(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        observations: [
          { test_id: 'src/a.test.ts::t1', verdict: 'pass' },
          { test_id: 'src/b.test.ts::t2', verdict: 'fail' },
          { test_id: 'tests/c.test.ts::t3', verdict: 'fail' },
          { test_id: 'tests/d.test.ts::t4', verdict: 'pass' },
        ],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [{ test_id: 'src/a.test.ts::t1', verdict: 'pass' }],
      },
    )

    expect(report.comparability).toBe('subset')
    expect(report.verification_surface?.events).toContainEqual({
      kind: 'selector-subset',
      from: '',
      to: 'src',
      capability: 'selector-relation',
    })

    // Red, in-scope, unobserved -> removed.
    expect(report.transitions?.removed).toEqual(['src/b.test.ts::t2'])
    // Red, out-of-scope -> out_of_scope, never removed/repaired.
    expect(report.transitions?.out_of_scope).toEqual(['tests/c.test.ts::t3'])
    expect(report.transitions?.removed).not.toContain('tests/c.test.ts::t3')
    // Green, out-of-scope -> never claimed anywhere.
    expect(report.transitions?.out_of_scope).not.toContain(
      'tests/d.test.ts::t4',
    )
    expect(report.transitions?.removed).not.toContain('tests/d.test.ts::t4')
    expect(report.transitions?.repaired_same_surface).not.toContain(
      'tests/d.test.ts::t4',
    )
    expect(report.transitions?.repaired_with_test_change).not.toContain(
      'tests/d.test.ts::t4',
    )

    expect(report.anchors['out_of_scope:tests/c.test.ts::t3']).toBe(
      `vdelta show ${baselineRunId.slice(0, 12)} --test 'tests/c.test.ts::t3'`,
    )
  })

  it('degrades to selector-relation-unknown when a baseline-only id has unknown selectorMatches', () => {
    const { report } = reportForPair(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        observations: [{ test_id: 'mysrc/a.test.ts::t', verdict: 'fail' }],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [],
      },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('abstains when the command carries a scope-perturbing flag, even for a prefix-relation selector pair', () => {
    const { report } = reportForPair(
      {
        invocation: {
          command: ['vitest', 'run', '--testNamePattern=alpha'],
          selector: [],
        },
      },
      {
        invocation: {
          command: ['vitest', 'run', '--testNamePattern=alpha'],
          selector: ['src'],
        },
      },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('abstains on --changed too', () => {
    const { report } = reportForPair(
      {
        invocation: {
          command: ['vitest', 'run', '--changed'],
          selector: [],
        },
      },
      {
        invocation: {
          command: ['vitest', 'run', '--changed'],
          selector: ['src'],
        },
      },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('abstains on a superset relation (current selector broader than baseline)', () => {
    const { report } = reportForPair(
      { invocation: { command: ['vitest', 'run'], selector: ['src'] } },
      { invocation: { command: ['vitest', 'run'], selector: [] } },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('abstains on a disjoint relation', () => {
    const { report } = reportForPair(
      { invocation: { command: ['vitest', 'run'], selector: ['alpha'] } },
      { invocation: { command: ['vitest', 'run'], selector: ['beta'] } },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('abstains on an unknown relation (non-decidable token)', () => {
    const { report } = reportForPair(
      { invocation: { command: ['vitest', 'run'], selector: ['src'] } },
      { invocation: { command: ['vitest', 'run'], selector: ['*.ts'] } },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('falls through to exact/scope_changed when the relation is extensionally equal', () => {
    const { report } = reportForPair(
      {
        invocation: { command: ['vitest', 'run'], selector: ['src', 'src'] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
    )
    expect(report.comparability).toBe('exact')
  })

  it('abstains (old-record compat) when either record lacks the selector-relation capability declaration', () => {
    const { report } = reportForPair(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        instrument: {
          adapter: 'vitest',
          adapter_version: '1',
          composition_id: 'vitest-native/2',
          config_digest: 'cfg1',
          // No `capabilities` at all: pre-declaration record.
        },
      },
      { invocation: { command: ['vitest', 'run'], selector: ['src'] } },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })

  it('does not claim subset when either run is incomplete', () => {
    const { report } = reportForPair(
      { invocation: { command: ['vitest', 'run'], selector: [] } },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        completeness: { status: 'partial', child_exit_code: 0 },
      },
    )
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
  })
})
