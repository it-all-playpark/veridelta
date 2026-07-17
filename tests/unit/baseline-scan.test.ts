/**
 * Baseline scan cost (F3): resolveBaseline pre-filters candidates via
 * RunStore.readRunMeta() (light validation) and only calls store.readRun()
 * (full §9.4 strict validation) on the record it actually selects. These
 * tests pin the reduced strict-parse call count while preserving the
 * pre-existing near-miss / fail-closed / completeness-filter behavior.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBaseline } from '../../src/compare.js'
import type { RunRecord } from '../../src/schema.js'
import { RunStore, StoreCorruptError } from '../../src/store.js'

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '/wt' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest-native',
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
    observations: [],
    recording: {
      recorder: 'vitest-native/1',
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
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-baseline-scan-'))
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

describe('resolveBaseline pre-filter scan (F3)', () => {
  it('previous-comparable: reads only the matching baseline via readRun, not every candidate', () => {
    const store = makeStore()

    // Oldest: the eventual stream-key match.
    const { runId: matchId } = store.writeRun(
      makeRecord({
        instrument: {
          ...makeRecord().instrument,
          config_digest: 'match-digest',
        },
      }),
    )

    // 10 non-matching complete records in between (unique config_digest each).
    for (let i = 0; i < 10; i++) {
      store.writeRun(
        makeRecord({
          instrument: {
            ...makeRecord().instrument,
            config_digest: `other-${i}`,
          },
        }),
      )
    }

    const current = makeRecord({
      instrument: { ...makeRecord().instrument, config_digest: 'match-digest' },
      // Distinct provenance (not part of the stream key) so `current`
      // content-addresses to a different run id than the intended match.
      provenance: {
        head: 'current-head',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const readRunSpy = vi.spyOn(store, 'readRun')

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.runId).toBe(matchId)
    expect(result.record).not.toBeNull()
    expect(readRunSpy).toHaveBeenCalledTimes(1)
    expect(readRunSpy).toHaveBeenCalledWith(matchId)
  })

  it('previous-comparable: no match -> near-miss follows fewest-mismatch/latest-wins rule', () => {
    const store = makeStore()

    // older candidate: 1 mismatch (branch)
    const { runId: olderId } = store.writeRun(
      makeRecord({
        repo: {
          identity: 'repo1',
          worktree: '/wt',
          branch: 'other-branch',
          cwd: '/wt',
        },
      }),
    )
    // newer candidate: 2 mismatches (branch + config_digest)
    store.writeRun(
      makeRecord({
        repo: {
          identity: 'repo1',
          worktree: '/wt',
          branch: 'other-branch',
          cwd: '/wt',
        },
        instrument: {
          ...makeRecord().instrument,
          config_digest: 'other-digest',
        },
      }),
    )

    const current = makeRecord()
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.record).toBeNull()
    expect(result.runId).toBeNull()
    expect(result.selectionReason).toBe('no-complete-run-in-stream')
    expect(result.failure?.reason).toBe('baseline-missing')
    expect(result.failure?.near_miss?.run_id).toBe(olderId)
    expect(result.failure?.near_miss?.mismatches).toHaveLength(1)
  })

  it('previous-comparable: deep-invalid non-candidate record is skipped, valid baseline still returned', () => {
    const store = makeStore()

    // Oldest: valid match.
    const { runId: matchId } = store.writeRun(makeRecord())

    // Deep-invalid record placed between match and current: JSON parses fine
    // but observations violate the strict schema. Not a stream-key match, so
    // it must never be strictly parsed during the scan.
    const deepInvalidId = `run_${'e'.repeat(64)}`
    const deepInvalid = {
      ...makeRecord({
        instrument: {
          ...makeRecord().instrument,
          config_digest: 'deep-invalid-digest',
        },
      }),
      observations: [{ test_id: 't1', verdict: 'bogus' }],
    }
    writeFileSync(
      join(store.dir, 'runs', `${deepInvalidId}.json`),
      `${JSON.stringify(deepInvalid)}\n`,
    )
    // append after the match so scan (newest-first) hits it before the match
    const fsAppend = join(store.dir, 'index')
    writeFileSync(fsAppend, `${matchId}\n${deepInvalidId}\n`)

    const current = makeRecord({
      provenance: {
        head: 'current-head',
        dirty_diff_digest: 'dd-cur',
        tree_digest: 'td-cur',
      },
    })
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.record).not.toBeNull()
    expect(result.runId).toBe(matchId)
  })

  it('previous-comparable: unparseable JSON on a non-candidate record still propagates StoreCorruptError (fail-closed)', () => {
    const store = makeStore()

    const { runId: matchId } = store.writeRun(makeRecord())

    const brokenId = `run_${'f'.repeat(64)}`
    writeFileSync(join(store.dir, 'runs', `${brokenId}.json`), '{not json')
    writeFileSync(join(store.dir, 'index'), `${matchId}\n${brokenId}\n`)

    const current = makeRecord()
    const { runId: currentId } = store.writeRun(current)

    expect(() =>
      resolveBaseline(store, current, currentId, {
        mode: 'previous-comparable',
      }),
    ).toThrow(StoreCorruptError)
  })

  it('git-ref: reads only the head/tree-matching record via readRun', () => {
    const store = makeStore()

    store.writeRun(
      makeRecord({
        provenance: {
          head: 'other-head',
          dirty_diff_digest: 'dd',
          tree_digest: 'other-tree',
        },
      }),
    )
    const { runId: matchId } = store.writeRun(
      makeRecord({
        provenance: {
          head: 'target-head',
          dirty_diff_digest: 'dd',
          tree_digest: 'target-tree',
        },
      }),
    )
    store.writeRun(
      makeRecord({
        instrument: {
          ...makeRecord().instrument,
          config_digest: 'yet-another',
        },
        provenance: {
          head: 'other-head-2',
          dirty_diff_digest: 'dd',
          tree_digest: 'other-tree-2',
        },
      }),
    )

    const current = makeRecord()

    const readRunSpy = vi.spyOn(store, 'readRun')

    const result = resolveBaseline(store, current, 'run_current', {
      mode: 'git-ref',
      ref: 'origin/main',
      commit: 'target-head',
      tree: 'target-tree',
    })

    expect(result.runId).toBe(matchId)
    expect(readRunSpy).toHaveBeenCalledTimes(1)
    expect(readRunSpy).toHaveBeenCalledWith(matchId)
  })

  it('excludes incomplete (partial) records from candidates', () => {
    const store = makeStore()

    store.writeRun(
      makeRecord({
        completeness: { status: 'partial', child_exit_code: 1 },
        instrument: {
          ...makeRecord().instrument,
          config_digest: 'incomplete-digest',
        },
      }),
    )

    const current = makeRecord()
    const { runId: currentId } = store.writeRun(current)

    const result = resolveBaseline(store, current, currentId, {
      mode: 'previous-comparable',
    })

    expect(result.record).toBeNull()
    expect(result.failure?.near_miss).toBeUndefined()
  })
})
