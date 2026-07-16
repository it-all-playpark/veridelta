/**
 * Conformance manifest runner — the implementer-owned interpreter for the
 * fixture vocabulary fixed in docs/conformance-harness.md §3–§4.
 * Fixtures under conformance/ are read-only for the implementation.
 *
 * All child processes are spawned via execFile with argument arrays (no
 * shell), so fixture-supplied strings can never be interpreted by a shell.
 */
import { execFile } from 'node:child_process'
import {
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
import { join, relative } from 'node:path'
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
const CLI = join(REPO_ROOT, 'dist', 'cli.js')
const VITEST_MJS = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

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

export async function runFixture(fixtureDir: string): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'),
  ) as Manifest
  const ctx = new FixtureContext(fixtureDir, manifest)
  try {
    await ctx.init()
    for (const step of manifest.steps) await ctx.runStep(step)
    for (const assertion of manifest.assertions) ctx.checkAssertion(assertion)
  } finally {
    ctx.cleanup()
  }
}

class FixtureContext {
  readonly workspace: string
  readonly reports = new Map<string, unknown>()
  readonly rawOutputs = new Map<string, string>()
  readonly runIds = new Map<string, string>()

  constructor(
    private readonly fixtureDir: string,
    private readonly manifest: Manifest,
  ) {
    this.workspace = mkdtempSync(join(tmpdir(), 'vdelta-conf-'))
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
    rmSync(this.workspace, { recursive: true, force: true })
  }

  private fail(message: string): never {
    throw new FixtureFailure(this.manifest.name, message)
  }

  private async git(args: string[]): Promise<void> {
    await execFileP('git', ['-C', this.workspace, ...args])
  }

  private vdelta(
    args: string[],
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, ...args],
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

  private async stepRun(step: Step): Promise<void> {
    const args = Array.isArray(step.args) ? step.args.map(String) : []
    const child = [
      'run',
      '--report',
      'json',
      '--',
      process.execPath,
      VITEST_MJS,
      'run',
      ...args,
    ]
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
      const runId = report.current?.run_id
      if (typeof runId === 'string') this.runIds.set(step.id, runId)
    }
  }

  private compareArgs(step: Step): string[] {
    const args = ['compare']
    if (typeof step.ref === 'string') {
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
