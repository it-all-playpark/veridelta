/**
 * Conformance manifest runner — the implementer-owned interpreter for the
 * fixture vocabulary fixed in docs/conformance-harness.md §3–§4.
 * Fixtures under conformance/ are read-only for the implementation.
 *
 * All child processes are spawned via execFile with argument arrays (no
 * shell), so fixture-supplied strings can never be interpreted by a shell.
 *
 * The runner also serves the A/B replay of the adapter-seam design §8.3: the
 * three inputs a `run_id` is not allowed to drift on between two passes — the
 * CLI binary, the workspace's absolute path and the git commit timestamps —
 * are injectable per pass ({@link FixtureRunOptions}), and what a pass
 * observed is handed back as a {@link FixtureReplay} for cross-binary
 * comparison. Defaults reproduce the historical single-pass behavior byte for
 * byte.
 */
import { execFile } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { parseReport, parseRunRecord } from '../../src/index.js'

const execFileP = promisify(execFile)

/**
 * Fixtures replay a developer's local loop, so CI markers must not leak into
 * the child vitest: CI mode rejects the .only cheat outright (allowOnly
 * defaults to !CI) and GITHUB_ACTIONS injects an extra reporter into the
 * recorded raw output.
 */
const LOCAL_ENV: NodeJS.ProcessEnv = { ...process.env }
delete LOCAL_ENV.CI
delete LOCAL_ENV.CONTINUOUS_INTEGRATION
delete LOCAL_ENV.GITHUB_ACTIONS

const REPO_ROOT = join(import.meta.dirname, '..', '..')
/**
 * The CLI a fixture drives unless the pass injects its own (§8.3 mechanism
 * 1): this worktree's freshly built binary, i.e. the candidate side of an A/B
 * replay.
 */
export const DEFAULT_CLI = join(REPO_ROOT, 'dist', 'cli.js')
const VITEST_MJS = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const PLAYWRIGHT_CLI = join(
  REPO_ROOT,
  'node_modules',
  '@playwright/test',
  'cli.js',
)

/**
 * vitest/vite's config search (lilconfig) climbs parent directories with no
 * stop boundary until it finds a vite/vitest config file or reaches the
 * filesystem root. Fixture workspaces live under the OS tmp dir, which is
 * shared with unrelated tools/processes -- a stray vite/vitest config
 * anywhere above the workspace would otherwise be picked up by the child
 * vitest invocation and break it. Fixtures that ship their own config
 * already stop the search at the workspace root; this is the boundary
 * marker for fixtures that don't.
 */
const CONFIG_FILE_NAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
]

export interface Manifest {
  name: string
  class: string
  spec_refs?: string[]
  mutation?: string
  notes?: string
  steps: Step[]
  assertions: Assertion[]
}

type Step = Record<string, unknown> & { do: string }
type Assertion = Record<string, unknown>

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export class FixtureFailure extends Error {
  constructor(fixture: string, message: string) {
    super(`[${fixture}] ${message}`)
    this.name = 'FixtureFailure'
  }
}

/**
 * Per-pass knobs. Every field exists to make one source of `run_id` drift
 * injectable so two passes can be compared (design §8.3); omitting all of
 * them reproduces the historical behavior exactly.
 */
export interface FixtureRunOptions {
  /**
   * Parent directory for the disposable `mkdtemp` workspace root (used by
   * the ancestor-config-pollution regression test). Mutually exclusive with
   * `workspaceRoot`.
   */
  workspaceParent?: string
  /**
   * Fixed absolute workspace root, used instead of `mkdtemp` (§8.3 mechanism
   * 2). `repo.worktree` / `repo.identity` are recorded as absolute paths and
   * the `recording` group is the only thing `run_id` excludes (spec §3.5), so
   * two passes that must agree on `run_id` have to run at the same path.
   *
   * The directory is wiped and recreated on entry (§8.3 mechanism 4): steps
   * mutate the workspace incrementally and the `.veridelta` store lives inside
   * it, so a pass must never inherit the previous pass's state. A fixed root
   * therefore cannot be shared by fixtures running concurrently — the
   * conformance project pins `fileParallelism: false` and vitest runs the
   * cases of one file in sequence.
   */
  workspaceRoot?: string
  /** Which built CLI the fixture drives (§8.3 mechanism 1). */
  cliPath?: string
  /**
   * Fixed `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` for every git invocation
   * (§8.3 mechanism 3). A commit SHA hashes its timestamps and reaches
   * `run_id` through `provenance.head`, so the `commit` step is a `run_id`
   * drift source unless the clock is pinned. Any git-parsable date string.
   */
  gitDate?: string
}

/**
 * What one pass observed, for cross-binary comparison (§8.3 主基準).
 *
 * `runIds` freezes the recorder path (`run.ts` → `record()` →
 * `buildRunRecord`). `reportTexts` closes the gap §8.1 limitation 2 names:
 * the comparator / gate / public-API edits of Step 1 never show up in a run
 * record, so the report bytes have to be compared directly. It holds the raw
 * stdout of the `run` / `compare` / `gate` steps only — `show` prints the run
 * record including its `recording` group (durations, wall-clock, raw child
 * output), which `run_id` excludes precisely because it is not reproducible.
 */
export interface FixtureReplay {
  runIds: Map<string, string>
  reports: Map<string, unknown>
  reportTexts: Map<string, string>
}

export async function runFixture(
  fixtureDir: string,
  options?: FixtureRunOptions,
): Promise<void> {
  await replayFixture(fixtureDir, options)
}

/**
 * Run a fixture exactly as {@link runFixture} does — every step, every
 * assertion — and hand back what it observed. Each pass of an A/B replay is
 * therefore also a full conformance check of the binary it drove.
 */
export async function replayFixture(
  fixtureDir: string,
  options?: FixtureRunOptions,
): Promise<FixtureReplay> {
  const manifest = JSON.parse(
    readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'),
  ) as Manifest
  const ctx = new FixtureContext(fixtureDir, manifest, options)
  try {
    await ctx.init()
    for (const step of manifest.steps) await ctx.runStep(step)
    for (const assertion of manifest.assertions) ctx.checkAssertion(assertion)
    return {
      runIds: new Map(ctx.runIds),
      reports: new Map(ctx.reports),
      reportTexts: new Map(ctx.reportTexts),
    }
  } finally {
    ctx.cleanup()
  }
}

/**
 * Fixtures the A/B replay must skip because their own replay is not
 * reproducible, keyed by fixture name with the measured reason as the value
 * (§8.3 mechanism 6). Skipping is preferable to reporting a mismatch that is
 * an artifact of the fixture rather than a behavior change in the binary.
 *
 * **Measured empty.** The list is populated only from mismatches observed
 * under the same-binary A/B (`VDELTA_AB_BASELINE_DIST` pointed at this
 * worktree's own `dist`), where no behavior change exists by construction, so
 * any mismatch is non-determinism. All 46 fixtures replayed identically —
 * every `run_id` and every report byte — with mechanisms 1–4 in place. That
 * includes the candidate the design named as likely non-deterministic,
 * `adv-stale-cache-collision`: its `preserveMtime` step freezes mtimes
 * *relative to earlier files of the same pass*, and mtimes reach neither the
 * record (`tree_digest` hashes content through git) nor the report, so the
 * absolute values differing between passes changes nothing.
 *
 * Re-measure before adding an entry, and say in the value what drifts.
 */
export const AB_REPLAY_EXCLUSIONS: ReadonlyMap<string, string> = new Map([])

/** `<cliPath> --version` → the version it reports. */
export async function cliVersion(cliPath: string): Promise<string> {
  const { stdout } = await execFileP(process.execPath, [cliPath, '--version'])
  const parsed = /^vdelta (\S+) \(veridelta\/1\)$/.exec(stdout.trim())
  if (parsed === null) {
    throw new Error(
      `${cliPath}: unexpected --version output ${JSON.stringify(stdout)}`,
    )
  }
  return parsed[1]!
}

/**
 * Assert that both binaries of an A/B replay carry the same VDELTA_VERSION,
 * and abort with an explicit diagnostic when they do not (§8.3 mechanism 5).
 *
 * The version is recorded as `instrument.adapter_version`, which `run_id`
 * covers, so a release-please bump landing between the baseline build and HEAD
 * would mismatch every fixture for a reason that has nothing to do with the
 * refactor under test. Failing loudly here is what keeps the criterion from
 * collapsing into a false positive.
 */
export async function assertSameCliVersion(
  baselineCli: string,
  candidateCli: string,
): Promise<string> {
  const [baseline, candidate] = await Promise.all([
    cliVersion(baselineCli),
    cliVersion(candidateCli),
  ])
  if (baseline !== candidate) {
    throw new Error(
      `A/B replay aborted: the two binaries disagree on VDELTA_VERSION — ` +
        `baseline ${baselineCli} is ${baseline}, candidate ${candidateCli} is ${candidate}. ` +
        `That value is recorded as instrument.adapter_version and is covered by run_id ` +
        `(spec §3.5), so every fixture would mismatch for a reason unrelated to the ` +
        `refactor. Rebuild both binaries at the same package.json version (§8.3 mechanism 5).`,
    )
  }
  return baseline
}

class FixtureContext {
  /**
   * `root` is a fresh directory — an `mkdtemp` one, or the wiped fixed root
   * of an A/B replay pass — that is NOT itself the git
   * workspace: the git worktree lives in the `repo` subdirectory
   * (`this.workspace`). This nested layout gives fixtures a place to plant
   * files that are outside the git worktree but still inside the fixture's
   * own disposable tmp territory (see the `write-outside` step) -- e.g. to
   * simulate an ancestor-directory config file that takes effect from
   * outside the repo without ever touching the shared OS tmp dir directly.
   */
  readonly root: string
  readonly workspace: string
  readonly reports = new Map<string, unknown>()
  /**
   * Raw stdout of every stored comparison report — the byte-level companion
   * of `reports` (see {@link FixtureReplay}). Parsing loses whitespace and can
   * hide a serialization change that consumers would see.
   */
  readonly reportTexts = new Map<string, string>()
  readonly rawOutputs = new Map<string, string>()
  readonly runIds = new Map<string, string>()
  private readonly readonlyPaths: string[] = []
  private readonly cliPath: string
  /** undefined = inherit this process's environment (historical behavior). */
  private readonly gitEnv: NodeJS.ProcessEnv | undefined

  constructor(
    private readonly fixtureDir: string,
    private readonly manifest: Manifest,
    options?: FixtureRunOptions,
  ) {
    if (
      options?.workspaceRoot !== undefined &&
      options.workspaceParent !== undefined
    ) {
      throw new Error(
        'workspaceRoot and workspaceParent are mutually exclusive: a fixed root has no parent to be placed under',
      )
    }
    this.cliPath = options?.cliPath ?? DEFAULT_CLI
    this.gitEnv =
      options?.gitDate === undefined
        ? undefined
        : {
            ...process.env,
            GIT_AUTHOR_DATE: options.gitDate,
            GIT_COMMITTER_DATE: options.gitDate,
          }
    if (options?.workspaceRoot !== undefined) {
      // §8.3 mechanism 4: a fixed root is reused across passes, so it starts
      // from nothing every time -- including the .veridelta store, whose
      // leftovers would give the second pass a baseline the first never had.
      // Also covers a root left behind by a pass that crashed before cleanup.
      this.root = options.workspaceRoot
      resetDirectory(this.root)
    } else {
      this.root = mkdtempSync(
        join(options?.workspaceParent ?? tmpdir(), 'vdelta-conf-'),
      )
    }
    this.workspace = join(this.root, 'repo')
    mkdirSync(this.workspace, { recursive: true })
  }

  async init(): Promise<void> {
    await this.git(['init', '-b', 'main'])
    await this.git(['config', 'user.name', 'conformance'])
    await this.git(['config', 'user.email', 'conformance@veridelta.invalid'])
    symlinkSync(
      join(REPO_ROOT, 'node_modules'),
      join(this.workspace, 'node_modules'),
    )
  }

  cleanup(): void {
    // macOS/Linux refuse to rmSync a write-protected directory, so restore
    // write permission on every chmod-readonly'd path before deleting.
    for (const p of this.readonlyPaths) restoreWritable(p)
    rmSync(this.root, { recursive: true, force: true })
  }

  private fail(message: string): never {
    throw new FixtureFailure(this.manifest.name, message)
  }

  private async git(args: string[]): Promise<void> {
    await execFileP('git', ['-C', this.workspace, ...args], {
      env: this.gitEnv,
    })
  }

  private vdelta(
    args: string[],
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [this.cliPath, ...args],
        {
          cwd: this.workspace,
          env: { ...LOCAL_ENV, ...env },
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? (error as unknown as { code: number }).code
                : 1
          resolve({ code, stdout, stderr })
        },
      )
    })
  }

  async runStep(step: Step): Promise<void> {
    switch (step.do) {
      case 'apply':
        return this.stepApply(step)
      case 'commit':
        await this.git(['add', '-A'])
        await this.git([
          'commit',
          '-m',
          String(step.message ?? 'fixture'),
          '--allow-empty',
        ])
        return
      case 'branch':
        await this.git(['checkout', '-b', String(step.name)])
        return
      case 'checkout':
        await this.git(['checkout', String(step.ref)])
        return
      case 'run':
        return this.stepRun(step)
      case 'compare':
        return this.stepCompare(step)
      case 'gate':
        return this.stepGate(step)
      case 'show':
        return this.stepShow(step)
      case 'write-file': {
        const target = join(this.workspace, String(step.path))
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, String(step.content ?? ''))
        return
      }
      case 'write-outside':
        return this.stepWriteOutside(step)
      case 'edit-json':
        return this.stepEditJson(step)
      case 'delete':
        rmSync(join(this.workspace, String(step.path)), {
          recursive: true,
          force: true,
        })
        return
      case 'mkdir':
        mkdirSync(join(this.workspace, String(step.path)), { recursive: true })
        return
      case 'chmod-readonly':
        return this.stepChmodReadonly(step)
      case 'parse-report':
        return this.stepParse(step, 'report')
      case 'parse-run-record':
        return this.stepParse(step, 'record')
      default:
        this.fail(`unknown step: ${step.do}`)
    }
  }

  private stepApply(step: Step): void {
    const project = join(this.fixtureDir, 'projects', String(step.project))
    if (!existsSync(project))
      this.fail(`no such project: ${String(step.project)}`)
    const preserve = step.preserveMtime === true
    const before = new Map<string, { mtime: Date; content: Buffer }>()
    if (preserve) {
      for (const rel of walkFiles(this.workspace, [
        '.git',
        '.veridelta',
        'node_modules',
      ])) {
        const abs = join(this.workspace, rel)
        before.set(rel, {
          mtime: statSync(abs).mtime,
          content: readFileSync(abs),
        })
      }
    }
    // delete workspace files not present in the project (contract §3 apply)
    const projectFiles = new Set(walkFiles(project, []))
    for (const rel of walkFiles(this.workspace, [
      '.git',
      '.veridelta',
      'node_modules',
    ])) {
      if (!projectFiles.has(rel))
        rmSync(join(this.workspace, rel), { force: true })
    }
    cpSync(project, this.workspace, { recursive: true })
    if (preserve) {
      for (const rel of projectFiles) {
        const prior = before.get(rel)
        if (prior === undefined) continue
        const abs = join(this.workspace, rel)
        if (!readFileSync(abs).equals(prior.content)) {
          utimesSync(abs, prior.mtime, prior.mtime)
        }
      }
    }
  }

  /**
   * Recursively remove the write bit from every file/directory under
   * `step.path`, and record the root so cleanup() can restore it before
   * rmSync (write-protected dirs otherwise can't be removed on macOS).
   */
  private stepChmodReadonly(step: Step): void {
    const target = join(this.workspace, String(step.path))
    this.readonlyPaths.push(target)
    chmodReadonlyRecursive(target)
  }

  /**
   * Write a file into the fixture's disposable tmp territory (`this.root`)
   * but outside the git worktree (`this.workspace`) — e.g. to simulate an
   * ancestor-directory config that takes effect on the workspace from
   * outside the repo. `step.path` is resolved relative to `this.root`; it
   * MUST stay inside `this.root` and outside `this.workspace` (no `..`
   * escape into the shared OS tmp dir, and no clobbering the workspace
   * itself), or the step fails.
   */
  private stepWriteOutside(step: Step): void {
    const target = resolve(this.root, String(step.path))
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep
    const workspaceWithSep = this.workspace.endsWith(sep)
      ? this.workspace
      : this.workspace + sep
    const insideRoot = target === this.root || target.startsWith(rootWithSep)
    const insideWorkspace =
      target === this.workspace || target.startsWith(workspaceWithSep)
    if (!insideRoot || insideWorkspace) {
      this.fail(
        `write-outside: path "${String(step.path)}" must resolve inside the fixture root and outside the workspace`,
      )
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, String(step.content ?? ''))
  }

  /** See the CONFIG_FILE_NAMES doc comment: guarantee the child vitest's
   * upward config search stops at the workspace root instead of escaping
   * into whatever happens to sit above the shared OS tmp dir. Only writes
   * a boundary marker when the fixture (or a prior apply step) hasn't
   * already supplied its own vite/vitest config -- either directly in the
   * workspace, or (via `write-outside`) in the fixture root that sits
   * between the workspace and the shared OS tmp dir. A config placed in
   * the root by `write-outside` is itself a valid boundary: vite's upward
   * search stops there just as it would at the workspace root. */
  private ensureConfigBoundary(): void {
    const hasOwnConfig = CONFIG_FILE_NAMES.some(
      (name) =>
        existsSync(join(this.workspace, name)) ||
        existsSync(join(this.root, name)),
    )
    if (!hasOwnConfig) {
      writeFileSync(
        join(this.workspace, 'vitest.config.mjs'),
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({})\n",
      )
    }
  }

  private async stepRun(step: Step): Promise<void> {
    const runner = step.runner === 'playwright' ? 'playwright' : 'vitest'
    const args = Array.isArray(step.args) ? step.args.map(String) : []
    let child: string[]
    if (runner === 'playwright') {
      // playwright's own config search only ever looks at the cwd it is
      // invoked from -- it does not climb ancestor directories the way
      // vite/vitest's does (§2 CONFIG_FILE_NAMES doc comment) -- so the
      // boundary marker vitest fixtures need would be pure workspace
      // pollution here and is skipped.
      child = [
        'run',
        '--report',
        'json',
        '--',
        process.execPath,
        PLAYWRIGHT_CLI,
        'test',
        ...args,
      ]
    } else {
      this.ensureConfigBoundary()
      child = [
        'run',
        '--report',
        'json',
        '--',
        process.execPath,
        VITEST_MJS,
        'run',
        ...args,
      ]
    }
    const env = (step.env ?? {}) as Record<string, string>
    const result = await this.vdelta(child, env)
    if (
      typeof step.expectExit === 'number' &&
      result.code !== step.expectExit
    ) {
      this.fail(
        `run ${String(step.id)}: expected exit ${step.expectExit}, got ${result.code}\nstderr: ${result.stderr.slice(0, 2000)}\nstdout: ${result.stdout.slice(0, 2000)}`,
      )
    }
    if (step.expectReport === false) {
      let looksLikeReport = false
      try {
        const parsed = JSON.parse(result.stdout) as { schema_version?: string }
        looksLikeReport = parsed.schema_version === 'veridelta/1'
      } catch {
        looksLikeReport = false
      }
      if (looksLikeReport)
        this.fail(
          `run ${String(step.id)}: expected degraded passthrough, got a report`,
        )
      return
    }
    let report: { current?: { run_id?: string } }
    try {
      report = JSON.parse(result.stdout) as typeof report
    } catch {
      this.fail(
        `run ${String(step.id)}: stdout is not a JSON report\nstderr: ${result.stderr.slice(0, 2000)}\nstdout: ${result.stdout.slice(0, 2000)}`,
      )
    }
    if (typeof step.id === 'string') {
      this.reports.set(step.id, report)
      this.reportTexts.set(step.id, result.stdout)
      const runId = report.current?.run_id
      if (typeof runId === 'string') this.runIds.set(step.id, runId)
    }
  }

  private compareArgs(step: Step): string[] {
    const args = ['compare']
    if (step.superset === true) {
      if (
        typeof step.ref === 'string' ||
        (typeof step.baseline === 'string' && typeof step.current === 'string')
      ) {
        this.fail(
          `compare ${String(step.id)}: superset cannot be combined with ref or baseline+current`,
        )
      }
      args.push('--superset')
      if (typeof step.current === 'string')
        args.push(this.resolveRunRef(step.current))
    } else if (typeof step.ref === 'string') {
      args.push('--ref', step.ref)
      if (typeof step.current === 'string')
        args.push(this.resolveRunRef(step.current))
    } else if (
      typeof step.baseline === 'string' &&
      typeof step.current === 'string'
    ) {
      args.push(
        this.resolveRunRef(step.baseline),
        this.resolveRunRef(step.current),
      )
    }
    args.push('--report', 'json')
    return args
  }

  private async stepCompare(step: Step): Promise<void> {
    const args = this.compareArgs(step)
    const result = await this.vdelta(args)
    if (
      typeof step.expectExit === 'number' &&
      result.code !== step.expectExit
    ) {
      this.fail(
        `compare ${String(step.id)}: expected exit ${step.expectExit}, got ${result.code}\nstderr: ${result.stderr.slice(0, 2000)}`,
      )
    }
    if (step.assertDeterministic === true) {
      const again = await this.vdelta(args)
      if (again.stdout !== result.stdout) {
        this.fail(
          `compare ${String(step.id)}: re-execution is not byte-identical (§13.3)`,
        )
      }
    }
    this.storeStepReport(step, result)
  }

  private async stepGate(step: Step): Promise<void> {
    const args = ['gate', '--ref', String(step.ref), '--policy', 'report-only']
    if (typeof step.run === 'string')
      args.push('--run', this.resolveRunRef(step.run))
    args.push('--report', 'json')
    const result = await this.vdelta(args)
    if (
      typeof step.expectExit === 'number' &&
      result.code !== step.expectExit
    ) {
      this.fail(
        `gate ${String(step.id)}: expected exit ${step.expectExit}, got ${result.code}\nstderr: ${result.stderr.slice(0, 2000)}`,
      )
    }
    if (step.assertDeterministic === true) {
      const again = await this.vdelta(args)
      if (again.stdout !== result.stdout) {
        this.fail(
          `gate ${String(step.id)}: re-execution is not byte-identical (§13.3)`,
        )
      }
    }
    this.storeStepReport(step, result)
  }

  private async stepShow(step: Step): Promise<void> {
    const args = ['show', this.resolveRunRef(String(step.run))]
    if (typeof step.test === 'string') args.push('--test', step.test)
    if (step.raw === true) args.push('--raw')
    const result = await this.vdelta(args)
    if (
      typeof step.expectExit === 'number' &&
      result.code !== step.expectExit
    ) {
      this.fail(
        `show ${String(step.id)}: expected exit ${step.expectExit}, got ${result.code}`,
      )
    }
    if (typeof step.id === 'string') {
      if (step.raw === true) {
        this.rawOutputs.set(step.id, result.stdout)
      } else {
        try {
          this.reports.set(step.id, JSON.parse(result.stdout))
        } catch {
          this.fail(`show ${String(step.id)}: stdout is not JSON`)
        }
      }
    }
  }

  private storeStepReport(step: Step, result: ExecResult): void {
    if (typeof step.id !== 'string') return
    try {
      this.reports.set(step.id, JSON.parse(result.stdout))
      this.reportTexts.set(step.id, result.stdout)
    } catch {
      this.fail(
        `${step.do} ${step.id}: stdout is not a JSON report\nstderr: ${result.stderr.slice(0, 2000)}\nstdout: ${result.stdout.slice(0, 2000)}`,
      )
    }
  }

  private resolveRunRef(stepId: string): string {
    const runId = this.runIds.get(stepId)
    if (runId === undefined) this.fail(`no recorded run for step id: ${stepId}`)
    return runId
  }

  private expandPath(path: string): string {
    return path.replace(/\{RUN:([^}]+)\}/g, (_, id: string) =>
      this.resolveRunRef(id),
    )
  }

  private stepEditJson(step: Step): void {
    const target = join(this.workspace, this.expandPath(String(step.path)))
    const doc = JSON.parse(readFileSync(target, 'utf8')) as unknown
    for (const [dotPath, value] of Object.entries(
      step.set as Record<string, unknown>,
    )) {
      setPath(doc, dotPath, value)
    }
    writeFileSync(target, `${JSON.stringify(doc, null, 1)}\n`)
  }

  private stepParse(step: Step, kind: 'report' | 'record'): void {
    const rel = this.expandPath(String(step.path))
    const inWorkspace = join(this.workspace, rel)
    const inFixture = join(this.fixtureDir, rel)
    const target = existsSync(inWorkspace) ? inWorkspace : inFixture
    let threw = false
    let error = ''
    try {
      const doc = JSON.parse(readFileSync(target, 'utf8')) as unknown
      if (kind === 'report') parseReport(doc)
      else parseRunRecord(doc)
    } catch (err) {
      threw = true
      error = err instanceof Error ? err.message : String(err)
    }
    if (step.expectError === true && !threw) {
      this.fail(
        `parse-${kind} ${String(step.id)}: expected a hard error, parsed cleanly (§9.4)`,
      )
    }
    if (step.expectError === false && threw) {
      this.fail(
        `parse-${kind} ${String(step.id)}: expected clean parse, threw: ${error}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Assertions

  checkAssertion(a: Assertion): void {
    if ('sameValue' in a) {
      this.checkPairs(a.sameValue, true)
      return
    }
    if ('differentValue' in a) {
      this.checkPairs(a.differentValue, false)
      return
    }
    if ('reportNotContains' in a) {
      const spec = a.reportNotContains as { report: string; text: string }
      const report = this.getReport(spec.report)
      if (JSON.stringify(report).includes(spec.text)) {
        this.fail(`report ${spec.report} must not contain "${spec.text}"`)
      }
      return
    }
    if ('storeNotContains' in a || 'storeContains' in a) {
      const text = String(a.storeNotContains ?? a.storeContains)
      const found = this.storeGrep(text)
      if ('storeNotContains' in a && found)
        this.fail(`store must not contain "${text}"`)
      if ('storeContains' in a && !found)
        this.fail(`store must contain "${text}"`)
      return
    }
    if ('observationsSorted' in a) {
      const spec = a.observationsSorted as { run: string }
      const runId = this.resolveRunRef(spec.run)
      const record = JSON.parse(
        readFileSync(
          join(this.workspace, '.veridelta', 'runs', `${runId}.json`),
          'utf8',
        ),
      ) as { observations: { test_id: string }[] }
      const ids = record.observations.map((o) => o.test_id)
      const sorted = [...ids].sort()
      if (JSON.stringify(ids) !== JSON.stringify(sorted)) {
        this.fail(
          `run ${spec.run}: observations are not canonically ordered (§7.8)`,
        )
      }
      return
    }
    // path-based assertion on a stored report
    const reportId = String(a.report)
    const value = getPath(this.getReport(reportId), String(a.path))
    const where = `report ${reportId} path ${String(a.path)}`
    if ('eq' in a) {
      if (!deepEqual(value, a.eq)) {
        this.fail(
          `${where}: expected ${JSON.stringify(a.eq)}, got ${JSON.stringify(value)}`,
        )
      }
    } else if ('contains' in a) {
      if (
        !Array.isArray(value) ||
        !value.some((e) => deepEqual(e, a.contains))
      ) {
        this.fail(
          `${where}: expected array containing ${JSON.stringify(a.contains)}, got ${JSON.stringify(value)}`,
        )
      }
    } else if ('containsMatch' in a) {
      const subset = a.containsMatch as Record<string, unknown>
      if (!Array.isArray(value) || !value.some((e) => subsetMatch(e, subset))) {
        this.fail(
          `${where}: expected array with element matching ${JSON.stringify(subset)}, got ${JSON.stringify(value)}`,
        )
      }
    } else if ('empty' in a) {
      const isEmpty = Array.isArray(value)
        ? value.length === 0
        : value !== null && typeof value === 'object'
          ? Object.keys(value as object).length === 0
          : false
      if (a.empty === true && !isEmpty)
        this.fail(`${where}: expected empty, got ${JSON.stringify(value)}`)
      if (a.empty === false && isEmpty)
        this.fail(`${where}: expected non-empty`)
    } else if ('nonEmpty' in a) {
      const size = Array.isArray(value)
        ? value.length
        : value && typeof value === 'object'
          ? Object.keys(value).length
          : 0
      if (a.nonEmpty === true && size === 0)
        this.fail(`${where}: expected non-empty`)
    } else if ('defined' in a) {
      const isDefined = value !== undefined
      if (a.defined !== isDefined) {
        this.fail(
          `${where}: expected defined=${String(a.defined)}, got ${JSON.stringify(value)}`,
        )
      }
    } else if ('matches' in a) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        this.fail(
          `${where}: expected scalar to match ${String(a.matches)}, got ${JSON.stringify(value)}`,
        )
      }
      if (!new RegExp(String(a.matches)).test(String(value))) {
        this.fail(
          `${where}: "${String(value)}" does not match /${String(a.matches)}/`,
        )
      }
    } else {
      this.fail(`unknown assertion: ${JSON.stringify(a)}`)
    }
  }

  private checkPairs(spec: unknown, wantEqual: boolean): void {
    const pair = spec as { report: string; path: string }[]
    const [a, b] = pair
    if (a === undefined || b === undefined)
      this.fail('sameValue/differentValue needs two locations')
    const va = getPath(this.getReport(a.report), a.path)
    const vb = getPath(this.getReport(b.report), b.path)
    const equal = deepEqual(va, vb)
    if (wantEqual && !equal) {
      this.fail(
        `expected same value at ${a.report}.${a.path} and ${b.report}.${b.path}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`,
      )
    }
    if (!wantEqual && equal) {
      this.fail(
        `expected different values at ${a.report}.${a.path} and ${b.report}.${b.path}, both ${JSON.stringify(va)}`,
      )
    }
  }

  private getReport(id: string): unknown {
    const report = this.reports.get(id)
    if (report === undefined) this.fail(`no stored report for step id: ${id}`)
    return report
  }

  private storeGrep(text: string): boolean {
    const storeDir = join(this.workspace, '.veridelta')
    if (!existsSync(storeDir)) return false
    for (const rel of walkFiles(storeDir, [])) {
      if (readFileSync(join(storeDir, rel), 'utf8').includes(text)) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// helpers

/** Delete `dir` and everything under it, then recreate it empty. Restores the
 * write bit first for the same reason cleanup() does: a fixture may have
 * chmod-readonly'd a subtree and then died before its own teardown ran. */
function resetDirectory(dir: string): void {
  if (existsSync(dir)) {
    restoreWritable(dir)
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
}

/** Recursively strip the write bit (owner/group/other) from root and its
 * contents (files and directories alike). Symlinks are left untouched. */
function chmodReadonlyRecursive(root: string): void {
  const st = statSync(root)
  if (st.isDirectory()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      chmodReadonlyRecursive(join(root, entry.name))
    }
  }
  chmodSync(root, st.mode & ~0o222)
}

/** Recursively restore the owner write bit under root (inverse of
 * chmodReadonlyRecursive), so the workspace can be torn down. */
function restoreWritable(root: string): void {
  if (!existsSync(root)) return
  const st = statSync(root)
  chmodSync(root, st.mode | 0o200)
  if (st.isDirectory()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      restoreWritable(join(root, entry.name))
    }
  }
}

function walkFiles(root: string, excludeTop: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs)
      if (dir === root && excludeTop.includes(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(abs)
      else out.push(rel)
    }
  }
  walk(root)
  return out
}

function getPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj
  for (const seg of dotPath.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      cur = cur[Number(seg)]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

function setPath(obj: unknown, dotPath: string, value: unknown): void {
  const segs = dotPath.split('.')
  let cur: unknown = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    cur = Array.isArray(cur)
      ? cur[Number(seg)]
      : (cur as Record<string, unknown>)[seg]
    if (cur === null || typeof cur !== 'object') {
      throw new Error(`edit-json: cannot descend into ${dotPath} at "${seg}"`)
    }
  }
  const last = segs[segs.length - 1]!
  if (Array.isArray(cur)) (cur as unknown[])[Number(last)] = value
  else (cur as Record<string, unknown>)[last] = value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((e, i) => deepEqual(e, b[i]))
  }
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as object).sort()
    const kb = Object.keys(b as object).sort()
    if (!deepEqual(ka, kb)) return false
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    )
  }
  return false
}

function subsetMatch(
  element: unknown,
  subset: Record<string, unknown>,
): boolean {
  if (element === null || typeof element !== 'object') return false
  return Object.entries(subset).every(([k, v]) =>
    deepEqual((element as Record<string, unknown>)[k], v),
  )
}
