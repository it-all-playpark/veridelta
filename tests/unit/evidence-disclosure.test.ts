/**
 * `failure_evidence` provenance (§9.1, §4.2 Step 2): the composition and
 * degraded-capability disclosure a report carries comes from the *record's
 * own* `instrument.capabilities` — never from an adapter registry lookup.
 * A record's declaration travels with the record, so two records naming the
 * same adapter can still disclose different capabilities, and a record whose
 * adapter this build does not know still gets a disclosure taken from its
 * own declaration.
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
      capabilities: {
        verdicts: 'pass',
        'source-location': 'pass',
        suppression: 'pass',
        inventory: 'pass',
        'failure-evidence': 'pass',
        'source-region-text': 'unsupported',
      },
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

describe('failure_evidence disclosure (§9.1, §4.2 Step 2)', () => {
  it('discloses the record’s own composition_id and evidence capabilities', () => {
    const report = reportFor(makeRecord())
    expect(report.failure_evidence).toEqual({
      composition_id: 'vitest-native/2',
      degraded_capabilities: ['source-region-text'],
    })
  })

  it('derives disclosure from the record, not from a registry lookup, for a foreign adapter', () => {
    // Decisive evidence that disclosure is record-derived, not registry-derived:
    // this adapter name is unknown to the registry, yet its own declaration
    // still drives the output.
    const report = reportFor(
      makeRecord({
        instrument: {
          adapter: 'some-other-runner',
          adapter_version: '9',
          composition_id: 'some-other-runner/1',
          config_digest: 'cfg1',
          capabilities: {
            'failure-evidence': 'unsupported',
            'source-region-text': 'unsupported',
          },
        },
      }),
    )
    expect(report.failure_evidence.composition_id).toBe('some-other-runner/1')
    expect(report.failure_evidence.degraded_capabilities).toEqual([
      'failure-evidence',
      'source-region-text',
    ])
  })

  it('discloses an empty list for a record with no capabilities declaration (old record)', () => {
    const oldRecord = makeRecord()
    const { capabilities, ...instrumentWithoutCapabilities } =
      oldRecord.instrument
    const report = reportFor({
      ...oldRecord,
      instrument: instrumentWithoutCapabilities,
    })
    expect(report.failure_evidence).toEqual({
      composition_id: 'vitest-native/2',
      degraded_capabilities: [],
    })
  })

  it('only discloses evidence-bearing capabilities, not other unsupported capabilities', () => {
    const report = reportFor(
      makeRecord({
        instrument: {
          adapter: 'vitest',
          adapter_version: '1',
          composition_id: 'vitest-native/2',
          config_digest: 'cfg1',
          capabilities: {
            verdicts: 'pass',
            'source-location': 'pass',
            suppression: 'pass',
            inventory: 'unsupported',
            'failure-evidence': 'pass',
            'source-region-text': 'unsupported',
          },
        },
      }),
    )
    expect(report.failure_evidence.degraded_capabilities).toEqual([
      'source-region-text',
    ])
  })

  it('discloses the current record’s own capabilities when abstaining', () => {
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
      composition_id: 'vitest-native/2',
      degraded_capabilities: ['source-region-text'],
    })
  })
})
