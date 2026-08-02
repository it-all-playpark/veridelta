/**
 * F1: `previous-superset` baseline mode (spec §5.2) and its supporting
 * `seriesKey`/`latestMaximal` helpers. Covers: candidacy (proper-superset
 * proof only, same-series + complete gating), maximality (proven-containment
 * partial order, no equal-class dedupe), the abstention split
 * (baseline-missing vs selector-relation-unknown), the recency/run_id
 * tie-break, the single-readRun invariant, and the `previous-comparable`
 * regression guard (seriesKey must not change its selection rule).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildComparisonReport,
  latestMaximal,
  resolveBaseline,
  seriesKey,
  streamKey,
} from '../../src/compare.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-previous-superset-'))
  scratchDirs.push(dir)
  const store = new RunStore(dir)
  store.ensure()
  return store
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('previous-superset baseline resolution (§5.2)', () => {
  it('[1] selects the single proper superset candidate', () => {
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.mode).toBe('previous-superset')
    expect(result.runId).toBe(wideId)
    expect(result.record).not.toBeNull()
    expect(result.selectionReason).toBe('most-recent-maximal-proven-superset')
    expect(result.supersetCandidates).toBeUndefined()
  })

  it('[2] maximality: a wider candidate wins over a more recent narrower one', () => {
    const store = makeStore()
    const { runId: wideId } = store.writeRun(
      makeRecord({ invocation: { command: ['vitest', 'run'], selector: [] } }),
    )
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        provenance: {
          head: 'mid',
          dirty_diff_digest: 'dd-mid',
          tree_digest: 'td-mid',
        },
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src/sub'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.runId).toBe(wideId)
    expect(result.supersetCandidates).toBeUndefined()
  })

  it('[3] equal-selector candidates are both maximal (no dedupe); discloses supersetCandidates; winner is newest', () => {
    const store = makeStore()
    const { runId: olderId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: { head: 'p1', dirty_diff_digest: 'dd1', tree_digest: 't1' },
      }),
    )
    const { runId: newerId } = store.writeRun(
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(olderId).not.toBe(newerId)
    expect(result.runId).toBe(newerId)
    expect(result.supersetCandidates).toBe(2)
    expect(result.selectionReason).toBe('most-recent-maximal-proven-superset')
  })

  it('[4] mutually-unknown maximal candidates: discloses supersetCandidates; winner is newest', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src', 'liba'] },
        provenance: { head: 'p1', dirty_diff_digest: 'dd1', tree_digest: 't1' },
      }),
    )
    const { runId: newerId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src', 'libb'] },
        provenance: { head: 'p2', dirty_diff_digest: 'dd2', tree_digest: 't2' },
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src/mod'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.runId).toBe(newerId)
    expect(result.supersetCandidates).toBe(2)
  })

  it('[6] a decided subset relation abstains as baseline-missing, not unknown', () => {
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.record).toBeNull()
    expect(result.runId).toBeNull()
    expect(result.mode).toBe('previous-superset')
    expect(result.selectionReason).toBe('no-proven-superset-in-series')
    expect(result.failure?.reason).toBe('baseline-missing')
    expect(result.failure?.kind).toBe('determined')
    expect(result.failure?.near_miss).toBeUndefined()
  })

  it('[7] an undecidable relation aborts with selector-relation-unknown when no candidate is proven', () => {
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.record).toBeNull()
    expect(result.selectionReason).toBe('superset-candidacy-undetermined')
    expect(result.failure?.reason).toBe('selector-relation-unknown')
    expect(result.failure?.kind).toBe('determined')
    expect(result.failure?.near_miss).toBeUndefined()
  })

  it('[8] excludes the equal-selector run from superset candidacy (separation from previous-comparable)', () => {
    const store = makeStore()
    const { runId: sameId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
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

    const supersetResult = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })
    expect(supersetResult.record).toBeNull()
    expect(supersetResult.failure?.reason).toBe('baseline-missing')

    const comparableResult = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })
    expect(comparableResult.runId).toBe(sameId)
  })

  it('[9] excludes incomplete series-mates from candidacy', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        completeness: { status: 'partial', child_exit_code: 1 },
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.record).toBeNull()
    expect(result.failure?.reason).toBe('baseline-missing')
  })

  it('[10] gates on the current record missing the selector-relation capability (fail-closed)', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({ invocation: { command: ['vitest', 'run'], selector: [] } }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
      instrument: {
        adapter: 'vitest',
        adapter_version: '1',
        composition_id: 'vitest/1',
        config_digest: 'cfg1',
        // No `capabilities` at all: pre-declaration record.
      },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.record).toBeNull()
    expect(result.failure?.reason).toBe('selector-relation-unknown')
    expect(result.selectionReason).toBe('superset-candidacy-undetermined')
  })

  it('[11] readRun spy: winner-only, exactly once, even with multiple candidates', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: { head: 'p1', dirty_diff_digest: 'dd1', tree_digest: 't1' },
      }),
    )
    const { runId: newerId } = store.writeRun(
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

    const readRunSpy = vi.spyOn(store, 'readRun')

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-superset',
    })

    expect(result.runId).toBe(newerId)
    expect(readRunSpy).toHaveBeenCalledTimes(1)
    expect(readRunSpy).toHaveBeenCalledWith(newerId)
  })
})

describe('seriesKey (§5.1)', () => {
  it('[12a] matches for records differing only in selector; streamKey does not', () => {
    const a = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: [] },
    })
    const b = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
    })

    expect(seriesKey(a)).toBe(seriesKey(b))
    expect(streamKey(a)).not.toBe(streamKey(b))
  })

  it('[12b] is the stream key minus the selector (8 elements)', () => {
    const r = makeRecord()
    const parsed = JSON.parse(seriesKey(r)) as unknown[]

    expect(parsed).toHaveLength(8)
    expect(parsed).toEqual([
      r.repo.identity,
      r.repo.worktree,
      r.repo.branch,
      r.repo.cwd,
      r.invocation.command,
      r.instrument.adapter,
      r.instrument.adapter_version,
      r.instrument.config_digest,
    ])
  })
})

describe('latestMaximal (§5.2 tie-break)', () => {
  it('[5a] prefers higher pos regardless of run_id ordering', () => {
    expect(
      latestMaximal([
        { runId: 'run_aaa', pos: 0 },
        { runId: 'run_bbb', pos: 1 },
      ]),
    ).toBe('run_bbb')
  })

  it('[5b] breaks a pos tie on the lexicographically-larger run_id', () => {
    expect(
      latestMaximal([
        { runId: 'run_bbb', pos: 3 },
        { runId: 'run_aaa', pos: 3 },
      ]),
    ).toBe('run_bbb')
  })

  it('returns null for an empty entry list', () => {
    expect(latestMaximal([])).toBeNull()
  })
})

describe('previous-comparable is unaffected by seriesKey introduction (regression)', () => {
  it('[13a] selects the same-selector run even when a wider-selector run also exists', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({ invocation: { command: ['vitest', 'run'], selector: [] } }),
    )
    const { runId: sameId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.runId).toBe(sameId)
  })

  it('[13b] falls back to baseline-missing + near_miss when no same-selector run exists', () => {
    const store = makeStore()
    store.writeRun(
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

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.record).toBeNull()
    expect(result.failure?.reason).toBe('baseline-missing')
    expect(result.failure?.near_miss).toBeDefined()
  })
})

describe('buildComparisonReport end-to-end (previous-superset -> subset)', () => {
  it('[14] subset comparability, superset_candidates disclosed, selector-subset event carries the baseline selector', () => {
    const store = makeStore()
    store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: { head: 'p1', dirty_diff_digest: 'dd1', tree_digest: 't1' },
        observations: [{ test_id: 'src/a.test.ts::t1', verdict: 'pass' }],
      }),
    )
    const { runId: baselineId } = store.writeRun(
      makeRecord({
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: { head: 'p2', dirty_diff_digest: 'dd2', tree_digest: 't2' },
        observations: [
          { test_id: 'src/a.test.ts::t1', verdict: 'pass' },
          { test_id: 'src/b.test.ts::t2', verdict: 'fail' },
          { test_id: 'tests/c.test.ts::t3', verdict: 'fail' },
        ],
      }),
    )
    const current = makeRecord({
      invocation: { command: ['vitest', 'run'], selector: ['src'] },
      provenance: {
        head: 'cur',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
      observations: [{ test_id: 'src/a.test.ts::t1', verdict: 'pass' }],
    })
    const { runId: currentId } = store.writeRun(current)

    const report = buildComparisonReport(store, currentId, {
      mode: 'previous-superset',
    })

    expect(report.comparability).toBe('subset')
    expect(report.baseline?.run_id).toBe(baselineId)
    expect(report.baseline?.mode).toBe('previous-superset')
    expect(report.baseline?.superset_candidates).toBe(2)
    expect(report.verification_surface?.events).toContainEqual({
      kind: 'selector-subset',
      from: '',
      to: 'src',
      capability: 'selector-relation',
    })
    expect(report.transitions?.out_of_scope).toEqual(['tests/c.test.ts::t3'])
    expect(report.transitions?.removed).toEqual(['src/b.test.ts::t2'])
  })
})
