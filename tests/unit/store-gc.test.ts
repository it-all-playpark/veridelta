import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-gc-'))
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

/** Seed `count` distinct records (distinguished by config_digest), oldest first. */
function seed(
  store: RunStore,
  count: number,
  overridesFor: (i: number) => Partial<RunRecord> = () => ({}),
): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const record = makeRecord({
      instrument: {
        adapter: 'vitest-native',
        adapter_version: '1',
        composition_id: 'vitest-native/1',
        config_digest: `cfg-${i}`,
      },
      ...overridesFor(i),
    })
    const { runId } = store.writeRun(record)
    ids.push(runId)
  }
  return ids
}

describe('RunStore.gc (§4.1 retention)', () => {
  it('is a no-op when within both limits', () => {
    const store = makeStore()
    const ids = seed(store, 3)
    const indexBefore = readFileSync(join(store.dir, 'index'), 'utf8')

    const result = store.gc({ maxCount: 100, maxBytes: 64 * 1024 * 1024 })

    expect(result.removed).toEqual([])
    expect(store.listRunIds()).toEqual(ids)
    expect(readFileSync(join(store.dir, 'index'), 'utf8')).toBe(indexBefore)
    for (const id of ids) {
      expect(() =>
        statSync(join(store.dir, 'runs', `${id}.json`)),
      ).not.toThrow()
    }
  })

  it('evicts the oldest records beyond maxCount, protecting last', () => {
    const store = makeStore()
    const ids = seed(store, 5)
    const last = store.lastRunId()
    expect(last).toBe(ids[4])

    const result = store.gc({ maxCount: 3 })

    expect(result.removed).toEqual([ids[0], ids[1]])
    expect(store.listRunIds()).toEqual([ids[2], ids[3], ids[4]])
    expect(store.listRunIds()).toContain(last)
    for (const id of [ids[0], ids[1]]) {
      expect(() => statSync(join(store.dir, 'runs', `${id}.json`))).toThrow()
    }
    for (const id of store.listRunIds()) {
      expect(store.verifyIntegrity(id)).toBe(true)
    }
  })

  it('evicts the oldest large-annex record beyond maxBytes, never evicting last', () => {
    const store = makeStore()
    const bigAnnex = 'x'.repeat(200_000)
    const ids = seed(store, 3, (i) =>
      i === 0
        ? {
            recording: {
              recorder: 'vitest-native/1',
              recorded_at_ms: 0,
              durations_us: {},
              raw_stdout: bigAnnex,
              raw_stderr: '',
              capture_reason: 'complete',
              unhandled_errors: 0,
            },
          }
        : {},
    )
    const last = store.lastRunId()
    expect(last).toBe(ids[2])

    const result = store.gc({ maxBytes: 3000 })

    expect(result.removed).toEqual([ids[0]])
    expect(store.listRunIds()).toEqual([ids[1], ids[2]])
    expect(store.listRunIds()).toContain(last)
    expect(() => statSync(join(store.dir, 'runs', `${ids[0]}.json`))).toThrow()
    expect(() =>
      statSync(join(store.dir, 'runs', `${ids[2]}.json`)),
    ).not.toThrow()
  })

  it('keeps only last when maxCount is 1', () => {
    const store = makeStore()
    const ids = seed(store, 3)
    const last = store.lastRunId()

    const result = store.gc({ maxCount: 1 })

    expect(store.listRunIds()).toEqual([last])
    expect(result.removed).toEqual([ids[0], ids[1]])
    expect(result.keptCount).toBe(1)
  })

  it('drops a dangling index entry without throwing', () => {
    const store = makeStore()
    const ids = seed(store, 3)
    // Simulate an out-of-band deletion that leaves the index stale.
    rmSync(join(store.dir, 'runs', `${ids[0]}.json`))

    let result: ReturnType<RunStore['gc']> | undefined
    expect(() => {
      result = store.gc({ maxCount: 100, maxBytes: 64 * 1024 * 1024 })
    }).not.toThrow()
    expect(result?.removed).toEqual([ids[0]])
    expect(store.listRunIds()).toEqual([ids[1], ids[2]])
  })

  it('is a no-op when both limits are undefined', () => {
    const store = makeStore()
    const ids = seed(store, 3)
    const indexBefore = readFileSync(join(store.dir, 'index'), 'utf8')

    const result = store.gc({})

    expect(result.removed).toEqual([])
    expect(store.listRunIds()).toEqual(ids)
    expect(readFileSync(join(store.dir, 'index'), 'utf8')).toBe(indexBefore)
  })
})
