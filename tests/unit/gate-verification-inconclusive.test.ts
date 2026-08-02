/**
 * F2: gate-side verdict derivation for the B-inconclusive decision (§12-1).
 * `buildGateReport` must classify a `verification_inconclusive`-only
 * transitions set (compare-side classification from F1) as gate verdict
 * `inconclusive` — not `pass` — while regression transitions
 * (new_fail/updated_fail/verification_surface_reduced) continue to force
 * `fail` even when they co-occur with `verification_inconclusive`. The
 * existing staleness-mismatch and comparability none/partial inconclusive
 * branches keep their priority over this new triggered kind.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGateReport } from '../../src/gate.js'
import type { FailureFinding, RunRecord } from '../../src/schema.js'
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

const finding: FailureFinding = {
  evidence_digest: 'ed1',
  structural_fingerprint: 'sf1',
  evidence: { errors: [] },
  context_digest: 'cd1',
  annex: { frames: [], console: [], location_line: null },
}

const playwrightInstrument = {
  adapter: 'playwright',
  adapter_version: '1',
  composition_id: 'playwright-native/1',
  config_digest: 'cfg1',
} as const

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '' },
    invocation: { command: ['playwright', 'test'], selector: [] },
    instrument: playwrightInstrument,
    environment: {
      runner: 'playwright',
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
    observations: [{ test_id: 'tests/t.spec.ts::flaky', verdict: 'pass' }],
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
 * Builds a real git repo (one commit) plus a workspace-tree-diverging
 * untracked file ("drift.txt"), and a RunStore with a baseline record
 * (recorded at the commit's tree) and a current record (recorded at the
 * post-drift workspace tree). Returns everything `buildGateReport` needs.
 */
async function setup(
  baselineOverrides: Partial<RunRecord>,
  currentOverrides: Partial<RunRecord>,
): Promise<{ store: RunStore; worktree: string }> {
  const worktree = makeScratchDir('vd-gate-')
  await initRepo(worktree)
  writeFileSync(join(worktree, 'a.txt'), 'hello\n')
  await git(worktree, ['add', 'a.txt'])
  await git(worktree, ['commit', '-m', 'initial'])
  const resolved = await resolveRef(worktree, 'HEAD')
  if (resolved === null) throw new Error('resolveRef failed in test setup')

  // Untracked, non-ignored file: makes the current workspace tree diverge
  // from the commit's tree so the current record (recorded at the
  // post-drift tree) does not itself satisfy git-ref baseline selection
  // (which does not exclude currentId).
  writeFileSync(join(worktree, 'drift.txt'), 'drift\n')
  const wsTree = await treeDigest(worktree)

  const storeDir = makeScratchDir('vd-gate-store-')
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
      instrument: {
        ...playwrightInstrument,
        capabilities: { 'retry-evidence': 'pass' },
      },
      ...currentOverrides,
    }),
  )
  return { store, worktree }
}

describe('buildGateReport: verdict derivation for verification_inconclusive (B-inconclusive, §12-1)', () => {
  it('flaky only: gate verdict inconclusive, triggered is exactly [verification_inconclusive]', async () => {
    const { store, worktree } = await setup(
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'fail', finding },
        ],
      },
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'pass', finding },
        ],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.gate?.verdict).toBe('inconclusive')
    expect(report.gate?.triggered).toEqual(['verification_inconclusive'])
    expect(report.gate?.staleness.match).toBe(true)
    expect(report.outcome_verdict).toBe('inconclusive')
    expect(report.comparability).toBe('exact')
  })

  it('mixed: flaky plus an unrelated new_fail -> gate verdict fail, triggered has new_fail and verification_inconclusive', async () => {
    const { store, worktree } = await setup(
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'fail', finding },
          { test_id: 'tests/t.spec.ts::other', verdict: 'pass' },
        ],
      },
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'pass', finding },
          { test_id: 'tests/t.spec.ts::other', verdict: 'fail', finding },
        ],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.gate?.verdict).toBe('fail')
    expect(report.gate?.triggered).toEqual([
      'new_fail',
      'verification_inconclusive',
    ])
  })

  it('no flaky: plain repair with current pass and no finding -> gate verdict pass, triggered empty', async () => {
    const { store, worktree } = await setup(
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'fail', finding },
        ],
      },
      {
        observations: [{ test_id: 'tests/t.spec.ts::flaky', verdict: 'pass' }],
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.gate?.verdict).toBe('pass')
    expect(report.gate?.triggered).toEqual([])
  })

  it('staleness mismatch takes priority over flaky-only inconclusive', async () => {
    const { store, worktree } = await setup(
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'fail', finding },
        ],
      },
      {
        observations: [
          { test_id: 'tests/t.spec.ts::flaky', verdict: 'pass', finding },
        ],
        // Only tree_digest matters here: buildGateReport's staleness check
        // compares this against the freshly recomputed workspace tree, not
        // against `head`.
        provenance: {
          head: 'deadbeef',
          dirty_diff_digest: 'dd',
          tree_digest: 'not-the-workspace-tree',
        },
      },
    )
    const report = await buildGateReport(store, { worktree, ref: 'HEAD' })
    expect(report.gate?.staleness.match).toBe(false)
    expect(report.gate?.verdict).toBe('inconclusive')
  })
})
