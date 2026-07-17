/**
 * `vdelta gc` (issue #14): retention-policy enforcement via the CLI. Spawns
 * the built CLI (see tests/cli/stdout-flush.test.ts) against a scratch git
 * worktree seeded through RunStore directly.
 */
import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'

const execFileP = promisify(execFile)

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

const workspaces: string[] = []

afterEach(() => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()!
    rmSync(ws, { recursive: true, force: true })
  }
})

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

function spawnCli(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}

async function makeGitWorkspace(): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), 'vdelta-gc-cli-'))
  workspaces.push(workspace)
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], {
    cwd: workspace,
  })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: workspace })
  return workspace
}

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

describe('vdelta gc (issue #14)', () => {
  it('is a no-op that takes no lock when the store has never been written to', async () => {
    const workspace = await makeGitWorkspace()

    const result = await spawnCli(['gc'], workspace)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('nothing to collect')
    expect(result.stderr).not.toContain('advisory lock')
    expect(existsSync(join(workspace, '.veridelta'))).toBe(false)
  })

  it('evicts the oldest records beyond --max-count, keeping last retrievable', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    const ids = seed(store, 5)
    const last = ids[4]!

    const result = await spawnCli(['gc', '--max-count', '2'], workspace)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('removed 3 run(s)')
    expect(result.stdout).toContain('kept 2 run(s)')

    const files = readdirSync(join(workspace, '.veridelta', 'runs')).filter(
      (f) => f.endsWith('.json'),
    )
    expect(files.length).toBe(2)

    const show = await spawnCli(['show', last.slice(0, 16)], workspace)
    expect(show.code).toBe(0)
  })

  it('evicts the oldest large-annex record beyond --max-bytes, protecting last', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
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
    const last = ids[2]!

    const result = await spawnCli(['gc', '--max-bytes', '1000'], workspace)

    expect(result.code).toBe(0)
    expect(
      existsSync(join(workspace, '.veridelta', 'runs', `${ids[0]}.json`)),
    ).toBe(false)
    expect(
      existsSync(join(workspace, '.veridelta', 'runs', `${last}.json`)),
    ).toBe(true)
  })

  it('fails with a retry hint when the advisory lock is held', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    seed(store, 2)
    mkdirSync(join(workspace, '.veridelta', 'lock'))

    const before = readdirSync(join(workspace, '.veridelta', 'runs')).filter(
      (f) => f.endsWith('.json'),
    )

    const result = await spawnCli(['gc'], workspace)

    expect(result.code).toBe(1)
    expect(result.stderr.toLowerCase()).toContain('retry')

    const after = readdirSync(join(workspace, '.veridelta', 'runs')).filter(
      (f) => f.endsWith('.json'),
    )
    expect(after).toEqual(before)
  })

  it('rejects a non-numeric --max-count with a usage error', async () => {
    const workspace = await makeGitWorkspace()

    const result = await spawnCli(['gc', '--max-count', 'abc'], workspace)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('vdelta:')
  })
})
