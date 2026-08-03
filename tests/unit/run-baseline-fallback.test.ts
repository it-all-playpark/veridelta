/**
 * F1: `buildRunComparisonReport` (src/run.ts) -- the additive 2-stage
 * baseline fallback used by `vdelta run`: stage 1 `previous-comparable`,
 * falling back to stage 2 `previous-superset` only when stage 1 abstains
 * with `baseline-missing`. Covers additivity (byte-identical report when
 * stage 1 resolves), stage-2 hit (subset disclosure), stage-2 also
 * baseline-missing (stage-1 report wins, near_miss preserved), stage-2
 * selector-relation-unknown (stage-2 report wins), and the empty-store case.
 *
 * Helpers (`makeRecord`/`makeStore`) are duplicated from
 * tests/unit/previous-superset.test.ts by design (self-contained, no
 * cross-file import) per the task instructions.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildComparisonReport } from '../../src/compare.js'
import { buildRunComparisonReport } from '../../src/run.js'
import type { RunRecord } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '/wt' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest',
      adapter_version: '1',
      composition_id: 'vitest/1',
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
    observations: [],
    recording: {
      recorder: 'vitest/1',
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

function makeStore(): RunStore {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-run-baseline-fallback-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  return store
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildRunComparisonReport (F1 additive fallback)', () => {
  it('[1] additivity: stage 1 hit is byte-identical to buildComparisonReport(previous-comparable), even when a wider series-mate exists', () => {
    const store = makeStore()
    const { runId: sameSelectorId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        provenance: { head: 'p1', dirty_diff_digest: 'dd1', tree_digest: 't1' },
      }),
    )
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: { head: 'p2', dirty_diff_digest: 'dd2', tree_digest: 't2' },
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const fallbackReport = buildRunComparisonReport(store, currentId)
    const comparableReport = buildComparisonReport(store, currentId, {
      mode: 'previous-comparable',
    })

    expect(JSON.stringify(fallbackReport)).toBe(
      JSON.stringify(comparableReport),
    )
    expect(fallbackReport.baseline?.mode).toBe('previous-comparable')
    expect(fallbackReport.baseline?.run_id).toBe(sameSelectorId)
  })

  it('[2] stage 2 hit: falls back to previous-superset when stage 1 is baseline-missing', () => {
    const store = makeStore()
    const { runId: wideId } = store.writeRun(
      makeRecord({ invocation: { command: ['vitest', 'run'], selector: [] } }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const report = buildRunComparisonReport(store, currentId)

    expect(report.comparability).toBe('subset')
    expect(report.baseline?.mode).toBe('previous-superset')
    expect(report.baseline?.run_id).toBe(wideId)
    expect(report.baseline?.selection_reason).toBe(
      'most-recent-maximal-proven-superset',
    )
    expect(report.verification_surface?.events).toContainEqual(
      expect.objectContaining({ kind: 'selector-subset' }),
    )
  })

  it('[3] stage 2 also baseline-missing (decided relation): returns the stage-1 report (near_miss preserved)', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: [] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const report = buildRunComparisonReport(store, currentId)
    const stage1Report = buildComparisonReport(store, currentId, {
      mode: 'previous-comparable',
    })

    expect(report).toEqual(stage1Report)
    expect(report.comparability_detail).toEqual(
      expect.objectContaining({
        reason: 'baseline-missing',
        kind: 'determined',
      }),
    )
    expect(report.baseline).toBeNull()
  })

  it('[4] stage 2 selector-relation-unknown: returns the stage-2 report, baseline stays null', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src/a', 'tests'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const report = buildRunComparisonReport(store, currentId)

    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
    expect(report.comparability_detail?.kind).toBe('determined')
    expect(report.baseline).toBeNull()
  })

  it('[5] empty store (current run only): baseline-missing, stage-1 report returned', () => {
    const store = makeStore()
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
    })
    const { runId: currentId } = store.writeRun(current)

    const report = buildRunComparisonReport(store, currentId)

    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe('baseline-missing')
    expect(report.baseline).toBeNull()
  })
})
