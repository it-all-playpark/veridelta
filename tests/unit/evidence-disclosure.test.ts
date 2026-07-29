/**
 * `failure_evidence` provenance (§9.1, §4.2 Step 1 interim rule): the
 * composition and degraded-capability disclosure a report carries must come
 * from the *record's own* adapter, resolved through the registry — not from a
 * constant baked into the comparator. Conformance cannot tell those two apart
 * (every fixture records with vitest), so the distinction is pinned here.
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

/** Two identical runs so the report is a claims report, not an abstention. */
function reportFor(
  record: RunRecord,
): ReturnType<typeof buildComparisonReport> {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-disclosure-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  store.writeRun(record)
  const { runId } = store.writeRun({
    ...record,
    recording: { ...record.recording, recorded_at_ms: 1 },
  })
  return buildComparisonReport(store, runId, { mode: 'previous-comparable' })
}

describe('failure_evidence disclosure (§9.1, §4.2)', () => {
  it('discloses the declaration of the registered adapter itself', () => {
    const report = reportFor(makeRecord())
    expect(report.failure_evidence).toEqual({
      composition_id: 'vitest-native/1',
      degraded_capabilities: ['source-region-text'],
    })
  })

  it('never stamps the vitest composition onto a foreign record', () => {
    // The decisive reason the seam exists (§5, plan B rejection): a report for
    // a run this build did not instrument must not claim `vitest-native/1`.
    const report = reportFor(
      makeRecord({
        instrument: {
          adapter: 'some-other-runner',
          adapter_version: '9',
          composition_id: 'some-other-runner/1',
          config_digest: 'cfg1',
        },
      }),
    )
    expect(report.failure_evidence.composition_id).toBe('some-other-runner/1')
    expect(report.failure_evidence.degraded_capabilities).toEqual([])
  })

  it('discloses the adapter of the current run when abstaining', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdelta-disclosure-'))
    scratchDirs.push(dir)
    const store = new RunStore(dir)
    store.ensure()
    // A lone run has no baseline: comparability `none`, and the disclosure
    // still describes the run the report does speak about.
    const { runId } = store.writeRun(makeRecord())
    const report = buildComparisonReport(store, runId, {
      mode: 'previous-comparable',
    })
    expect(report.comparability).toBe('none')
    expect(report.failure_evidence).toEqual({
      composition_id: 'vitest-native/1',
      degraded_capabilities: ['source-region-text'],
    })
  })
})
