/**
 * F2: `completeness.status` propagation from RunRecord into
 * `ComparisonReport.current.completeness_status` (§9.1 — text rendering must
 * be a secondary view of the report, so the signal has to reach the report
 * first). Non-complete runs abstain (comparability `none`), so this exercises
 * the abstention report-construction path in src/compare.ts; complete runs
 * must keep the report byte-identical to before this change.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildComparisonReport } from '../../src/compare.js'
import { parseReport } from '../../src/schema.js'
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

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  }
})

/** A lone run has no baseline: comparability `none` (abstention path). */
function reportFor(record: RunRecord): ReturnType<typeof buildComparisonReport> {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-completeness-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  const { runId } = store.writeRun(record)
  return buildComparisonReport(store, runId, { mode: 'previous-comparable' })
}

describe('completeness.status propagation into report.current (§9.1)', () => {
  it('emits completeness_status: crashed for a crashed current run', () => {
    const report = reportFor(
      makeRecord({ completeness: { status: 'crashed', child_exit_code: 1 } }),
    )
    expect(report.comparability).toBe('none')
    expect(report.current.complete).toBe(false)
    expect(report.current.completeness_status).toBe('crashed')
  })

  it('emits completeness_status: partial for a partial current run', () => {
    const report = reportFor(
      makeRecord({ completeness: { status: 'partial', child_exit_code: 0 } }),
    )
    expect(report.current.complete).toBe(false)
    expect(report.current.completeness_status).toBe('partial')
  })

  it('omits completeness_status entirely for a complete current run', () => {
    const report = reportFor(makeRecord())
    expect(report.current.complete).toBe(true)
    expect(report.current).not.toHaveProperty('completeness_status')
  })

  it('round-trips through JSON and parseReport for a crashed run', () => {
    const report = reportFor(
      makeRecord({ completeness: { status: 'crashed', child_exit_code: 1 } }),
    )
    const roundTripped = parseReport(JSON.parse(JSON.stringify(report)))
    expect(roundTripped.current.completeness_status).toBe('crashed')
  })
})
