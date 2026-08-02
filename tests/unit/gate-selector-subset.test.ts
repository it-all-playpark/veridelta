/**
 * G1: gate MUST (spec §11.1) for the `subset` comparability introduced in
 * src/compare.ts. A `git-ref` baseline comparison that proves a `selector-
 * subset` narrowing MUST NOT report a clean `pass` — the gate fails it via a
 * dedicated `selector_subset` trigger, even when no new_fail is present.
 * `selector-relation-unknown` (the fail-closed abstention for every unproven
 * narrowing) stays `inconclusive`, never `pass`.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGateReport } from '../../src/gate.js'
import type { RunRecord } from '../../src/schema.js'
import { RunStore } from '../../src/store.js'
import { resolveRef, treeDigest } from '../../src/tree-digest.js'

const execFileP = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd })
  return stdout.trim()
}

const scratchDirs: string[] = []

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  }
})

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
}

const vitestInstrument = {
  adapter: 'vitest',
  adapter_version: '1',
  composition_id: 'vitest-native/2',
  config_digest: 'cfg1',
  capabilities: { 'selector-relation': 'pass' as const },
} as const

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: vitestInstrument,
    environment: {
      runner: 'vitest',
      runner_version: '1',
      runtime: 'node',
      os: 'darwin',
      env_fingerprint: 'env1',
    },
    provenance: {
      head: 'deadbeef',
      dirty_diff_digest: 'dd',
      tree_digest: 'td1',
    },
    surface: {
      inventory_digest: 'inv1',
      test_sources: {},
      config_sources: {},
      suppressed: [],
    },
    completeness: { status: 'complete', child_exit_code: 0 },
    observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
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

/**
 * Builds a real git repo (one commit, no drift so the current run's recorded
 * tree matches the workspace tree exactly — staleness match) plus a RunStore
 * with a baseline record (recorded at the commit's tree) and a current
 * record (also recorded at that same tree).
 */
async function setup(
  baselineOverrides: Partial<RunRecord>,
  currentOverrides: Partial<RunRecord>,
): Promise<{ store: RunStore; worktree: string }> {
  const worktree = makeScratchDir('vd-gate-subset-')
  await initRepo(worktree)
  writeFileSync(join(worktree, 'a.txt'), 'hello\n')
  await git(worktree, ['add', 'a.txt'])
  await git(worktree, ['commit', '-m', 'initial'])
  const resolved = await resolveRef(worktree, 'HEAD')
  if (resolved === null) throw new Error('resolveRef failed in test setup')

  // Untracked, non-ignored file: makes the current workspace tree diverge
  // from the commit's tree so the current record (recorded at the
  // post-drift tree) does not itself satisfy git-ref baseline selection
  // (which does not exclude currentId) — see
  // tests/unit/gate-verification-inconclusive.test.ts for the same pattern.
  writeFileSync(join(worktree, 'drift.txt'), 'drift\n')
  const wsTree = await treeDigest(worktree)

  const storeDir = makeScratchDir('vd-gate-subset-store-')
  const store = new RunStore(storeDir)
  store.ensure()
  store.writeRun(
    makeRecord({
      provenance: {
        head: resolved.commit,
        dirty_diff_digest: 'dd',
        tree_digest: resolved.tree,
      },
      ...baselineOverrides,
    }),
  )
  store.writeRun(
    makeRecord({
      provenance: {
        head: resolved.commit,
        dirty_diff_digest: 'dd',
        tree_digest: wsTree,
      },
      ...currentOverrides,
    }),
  )
  return { store, worktree }
}

describe('buildGateReport: selector_subset MUST (§11.1)', () => {
  it('proper narrowing (baseline [] -> current [src]) -> verdict fail, triggered [selector_subset], no pass', async () => {
    const { store, worktree } = await setup(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        observations: [
          { test_id: 'src/a.test.ts::t', verdict: 'pass' },
          { test_id: 'tests/b.test.ts::u', verdict: 'pass' },
        ],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.comparability).toBe('subset')
    expect(report.gate?.verdict).toBe('fail')
    expect(report.gate?.triggered).toEqual(['selector_subset'])
  })

  it('common ids keep their transitions in the report alongside the subset trigger', async () => {
    const { store, worktree } = await setup(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.comparability).toBe('subset')
    expect(report.transitions).toBeDefined()
    expect(report.gate?.triggered).toEqual(['selector_subset'])
  })

  it('selector-relation-unknown (command perturbed) -> verdict inconclusive, not pass', async () => {
    const { store, worktree } = await setup(
      {
        invocation: {
          command: ['vitest', 'run', '--testNamePattern=alpha'],
          selector: [],
        },
      },
      {
        invocation: {
          command: ['vitest', 'run', '--testNamePattern=alpha'],
          selector: ['src'],
        },
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.comparability).toBe('none')
    expect(report.comparability_detail?.reason).toBe(
      'selector-relation-unknown',
    )
    expect(report.gate?.verdict).toBe('inconclusive')
    expect(report.gate?.verdict).not.toBe('pass')
  })

  it('disjoint selector difference -> verdict inconclusive', async () => {
    const { store, worktree } = await setup(
      { invocation: { command: ['vitest', 'run'], selector: ['alpha'] } },
      { invocation: { command: ['vitest', 'run'], selector: ['beta'] } },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.comparability).toBe('none')
    expect(report.gate?.verdict).toBe('inconclusive')
  })

  it('new_fail concurrent with selector_subset -> verdict fail, triggered has both', async () => {
    const { store, worktree } = await setup(
      {
        invocation: { command: ['vitest', 'run'], selector: [] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'pass' }],
      },
      {
        invocation: { command: ['vitest', 'run'], selector: ['src'] },
        observations: [{ test_id: 'src/a.test.ts::t', verdict: 'fail' }],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.gate?.verdict).toBe('fail')
    expect(report.gate?.triggered).toEqual(['new_fail', 'selector_subset'])
  })
})
