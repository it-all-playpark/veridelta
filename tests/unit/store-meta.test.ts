import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRunRecord, type RunRecord } from '../../src/schema.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-meta-'))
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

describe('RunStore.readRunMeta', () => {
  it('extracts all RunMeta fields from a well-formed record', () => {
    const store = makeStore()
    const record = makeRecord()
    const { runId } = store.writeRun(record)

    const meta = store.readRunMeta(runId)

    expect(meta).toEqual({
      repo: record.repo,
      invocation: record.invocation,
      instrument: record.instrument,
      provenance: {
        head: record.provenance.head,
        tree_digest: record.provenance.tree_digest,
      },
      completeness: record.completeness,
    })
  })

  it('does not throw on a deep-invalid record (schema-violating observations)', () => {
    const store = makeStore()
    const validRecord = makeRecord()
    const runId = `run_${'a'.repeat(64)}`
    const deepInvalid: Record<string, unknown> = {
      ...validRecord,
      observations: [{ test_id: 't1', verdict: 'bogus' }],
    }
    writeFileSync(
      join(store.dir, 'runs', `${runId}.json`),
      `${JSON.stringify(deepInvalid)}\n`,
    )
    appendFileSync(join(store.dir, 'index'), `${runId}\n`)

    let meta: unknown
    expect(() => {
      meta = store.readRunMeta(runId)
    }).not.toThrow()
    expect((meta as { repo: { identity: string } }).repo.identity).toBe('repo1')

    // Paired check: the strict parser does reject the same record.
    expect(() => parseRunRecord(deepInvalid)).toThrow()
  })

  it('throws StoreCorruptError with the same wording as readRun for unparseable JSON', () => {
    const store = makeStore()
    const runId = `run_${'b'.repeat(64)}`
    writeFileSync(join(store.dir, 'runs', `${runId}.json`), '{not json')

    expect(() => store.readRunMeta(runId)).toThrow(StoreCorruptError)
    expect(() => store.readRunMeta(runId)).toThrow(
      `run record unparseable: ${runId}`,
    )
  })

  it('throws StoreCorruptError for a run id that does not exist', () => {
    const store = makeStore()
    const runId = `run_${'c'.repeat(64)}`

    expect(() => store.readRunMeta(runId)).toThrow(StoreCorruptError)
    expect(() => store.readRunMeta(runId)).toThrow(
      `run record missing: ${runId}`,
    )
  })

  it('throws StoreCorruptError when repo.identity is missing', () => {
    const store = makeStore()
    const runId = `run_${'d'.repeat(64)}`
    const record = makeRecord()
    const broken = {
      ...record,
      repo: { worktree: '/wt', branch: 'main', cwd: '/wt' },
    }
    writeFileSync(
      join(store.dir, 'runs', `${runId}.json`),
      `${JSON.stringify(broken)}\n`,
    )

    expect(() => store.readRunMeta(runId)).toThrow(StoreCorruptError)
  })
})
