/**
 * `vdelta compare --superset` (issue #68 / D-2): CLI wiring for the
 * `previous-superset` baseline mode. Spawns the built CLI (see
 * tests/cli/gc.test.ts) against a scratch git worktree seeded through
 * RunStore directly.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComparisonReport, RunRecord } from '../../src/schema.js'
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
  const workspace = mkdtempSync(join(tmpdir(), 'vdelta-compare-superset-cli-'))
  workspaces.push(workspace)
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], {
    cwd: workspace,
  })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: workspace })
  return workspace
}

function makeRecord(
  worktree: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: {
      identity: worktree,
      worktree,
      branch: 'main',
      cwd: worktree,
    },
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
    observations: [
      {
        test_id: 'tests/x::t',
        verdict: 'fail',
      },
    ],
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

describe('vdelta compare --superset (issue #68)', () => {
  it('[1] resolves the current run from the store and reports previous-superset/subset', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: {
          head: 'wide',
          dirty_diff_digest: 'dd-w',
          tree_digest: 'td-w',
        },
      }),
    )
    store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        provenance: {
          head: 'narrow',
          dirty_diff_digest: 'dd-n',
          tree_digest: 'td-n',
        },
      }),
    )

    const result = await spawnCli(
      ['compare', '--superset', '--report', 'json'],
      workspace,
    )

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as ComparisonReport
    expect(report.baseline?.mode).toBe('previous-superset')
    expect(report.comparability).toBe('subset')
  })

  it('[2] accepts an explicit current-run positional alongside --superset', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: {
          head: 'wide',
          dirty_diff_digest: 'dd-w',
          tree_digest: 'td-w',
        },
      }),
    )
    const { runId: narrowId } = store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        provenance: {
          head: 'narrow',
          dirty_diff_digest: 'dd-n',
          tree_digest: 'td-n',
        },
      }),
    )

    const result = await spawnCli(
      ['compare', '--superset', narrowId.slice(0, 16), '--report', 'json'],
      workspace,
    )

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as ComparisonReport
    expect(report.baseline?.mode).toBe('previous-superset')
    expect(report.comparability).toBe('subset')
  })

  it('[3] rejects --superset combined with --ref', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(makeRecord(workspace))

    const result = await spawnCli(
      ['compare', '--superset', '--ref', 'HEAD'],
      workspace,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('usage: vdelta compare')
  })

  it('[4] rejects --superset combined with two positional run ids', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(makeRecord(workspace))

    const result = await spawnCli(
      ['compare', '--superset', 'a', 'b'],
      workspace,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('usage: vdelta compare')
  })

  it('[5] rejects the --superset=<value> form as an unknown option', async () => {
    const workspace = await makeGitWorkspace()

    const result = await spawnCli(['compare', '--superset=1'], workspace)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown option')
  })

  it('[6] abstains with baseline-missing when there is no superset candidate', async () => {
    const workspace = await makeGitWorkspace()
    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        provenance: {
          head: 'narrow',
          dirty_diff_digest: 'dd-n',
          tree_digest: 'td-n',
        },
      }),
    )
    store.writeRun(
      makeRecord(workspace, {
        invocation: { command: ['vitest', 'run'], selector: [] },
        provenance: {
          head: 'wide',
          dirty_diff_digest: 'dd-w',
          tree_digest: 'td-w',
        },
      }),
    )

    const result = await spawnCli(
      ['compare', '--superset', '--report', 'json'],
      workspace,
    )

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as ComparisonReport
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe('baseline-missing')
  })
})
