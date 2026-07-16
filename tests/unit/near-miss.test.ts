import { describe, expect, it } from 'vitest'
import { nearMissDisclosure } from '../../src/compare.js'
import type { RunRecord } from '../../src/schema.js'

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
    provenance: { head: 'deadbeef', dirty_diff_digest: 'dd1', tree_digest: 'td1' },
    surface: { inventory_digest: 'inv1', test_sources: {}, config_sources: {}, suppressed: [] },
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

const current = makeRecord()

describe('nearMissDisclosure (§5.4)', () => {
  it('returns undefined when there are no candidates', () => {
    expect(nearMissDisclosure(current, [])).toBeUndefined()
  })

  it('reports a single mismatching component (invocation.command)', () => {
    const candidate = makeRecord({ invocation: { command: ['npx', 'vitest', 'run'], selector: [] } })
    const result = nearMissDisclosure(current, [{ runId: 'run_a', record: candidate }])
    expect(result).toEqual({
      run_id: 'run_a',
      mismatches: [{ field: 'invocation.command', recorded: 'npx vitest run', current: 'vitest run' }],
    })
  })

  it('breaks ties by picking the latest (last) candidate in the array', () => {
    const candidateA = makeRecord({ repo: { identity: 'repo1', worktree: '/wt', branch: 'branchA', cwd: '/wt' } })
    const candidateB = makeRecord({ repo: { identity: 'repo1', worktree: '/wt', branch: 'branchB', cwd: '/wt' } })
    const result = nearMissDisclosure(current, [
      { runId: 'run_a', record: candidateA },
      { runId: 'run_b', record: candidateB },
    ])
    expect(result?.run_id).toBe('run_b')
  })

  it('prefers fewest mismatches over recency', () => {
    // older candidate (first in array): 1 mismatch
    const olderOneMismatch = makeRecord({
      repo: { identity: 'repo1', worktree: '/wt', branch: 'other-branch', cwd: '/wt' },
    })
    // newer candidate (last in array): 2 mismatches
    const newerTwoMismatches = makeRecord({
      repo: { identity: 'repo1', worktree: '/wt', branch: 'other-branch', cwd: '/wt' },
      instrument: {
        adapter: 'vitest-native',
        adapter_version: '1',
        composition_id: 'vitest-native/1',
        config_digest: 'other-digest',
      },
    })
    const result = nearMissDisclosure(current, [
      { runId: 'run_older', record: olderOneMismatch },
      { runId: 'run_newer', record: newerTwoMismatches },
    ])
    expect(result?.run_id).toBe('run_older')
    expect(result?.mismatches).toHaveLength(1)
  })

  it('empty candidates array returns undefined', () => {
    expect(nearMissDisclosure(current, [])).toBeUndefined()
  })

  it('lists multiple mismatches in canonical stream-key order', () => {
    const candidate = makeRecord({
      repo: { identity: 'repo1', worktree: '/wt', branch: 'other-branch', cwd: '/wt' },
      instrument: {
        adapter: 'vitest-native',
        adapter_version: '1',
        composition_id: 'vitest-native/1',
        config_digest: 'other-digest',
      },
    })
    const result = nearMissDisclosure(current, [{ runId: 'run_a', record: candidate }])
    expect(result?.mismatches.map((m) => m.field)).toEqual(['repo.branch', 'instrument.config_digest'])
  })

  it("renders selector mismatches with join(' ')", () => {
    const candidate = makeRecord({ invocation: { command: ['vitest', 'run'], selector: ['a', 'b'] } })
    const result = nearMissDisclosure(current, [{ runId: 'run_a', record: candidate }])
    expect(result).toEqual({
      run_id: 'run_a',
      mismatches: [{ field: 'invocation.selector', recorded: 'a b', current: '' }],
    })
  })
})
