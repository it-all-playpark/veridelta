/**
 * playwright adapter, recorder side: turns a Capture dump plus execution
 * context into a canonical RunRecord (§3). Composition `playwright-native/1`
 * (docs/compositions/playwright-native-1.md): digest core = exception type +
 * message + line-shift-stable relOffsets + tree-reconstructed
 * `source_region` text; `source-region-text` and `retry-evidence` are
 * declared `pass` (unlike vitest, which declares `source-region-text`
 * `unsupported` — `../vitest/recorder.ts:67-74`); `resolved-config-coverage`
 * is declared `unsupported` because playwright's resolved `FullConfig` never
 * exposes `expect.timeout` to the reporter (doc §4 `expect.timeout` row,
 * architecture decision 6). `resolved-config-coverage` is deliberately not
 * added to `schema.ts`'s `EVIDENCE_CAPABILITY_NAMES` (decision 6 implementation
 * contract): it is an `instrument`-level capability, not an evidence one, so
 * `failure_evidence.degraded_capabilities` never lists it.
 *
 * Test IDs are project-scoped (`${rel}::${project}::${titles.join(' > ')}`)
 * because playwright's own test identity is project-scoped
 * (`TestCase.id`/`titlePath()` — see `../../adapters/playwright/reporter.cts`);
 * without `project` in the id, same-titled tests in different projects would
 * collide.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import {
  AdapterCaptureError,
  type CapabilityDeclaration,
  type RecordContext,
} from '../../adapter.js'
import { canonicalDigest } from '../../digest.js'
import { redactText, redactValue } from '../../redact.js'
import {
  type CompletenessStatus,
  type EvidenceError,
  type FailureFinding,
  type RunRecord,
  SCHEMA_VERSION,
  type TestObservation,
  type Verdict,
} from '../../schema.js'
import {
  CAPTURE_VERSION,
  type Capture,
  type CapturedPwAttempt,
  type CapturedPwError,
  type CapturedPwProjectConfig,
  type CapturedPwTest,
  type CapturedPwUnreportedTest,
} from './capture.js'

export const ADAPTER_NAME = 'playwright'
export const COMPOSITION_ID = 'playwright-native/1'
/** Env vars whose values (fingerprinted, never stored) are comparison-relevant. */
export const DECLARED_ENV_VARS = ['CI', 'NODE_ENV', 'TZ', 'LANG'] as const

/**
 * A capture the recorder cannot turn into a record: unsupported capture
 * version, or an ambiguity it refuses to guess through (§12 fail-closed).
 * A subtype of `AdapterCaptureError` so the core degrades to raw passthrough
 * (INV-5) without knowing which adapter raised it.
 */
export class RecorderError extends AdapterCaptureError {
  constructor(message: string) {
    super(message)
    this.name = 'RecorderError'
  }
}

/** Re-exported from the seam: the context shape is runner-neutral (§4.1). */
export type { RecordContext }

/**
 * Capability declaration for `playwright-native/1`
 * (docs/compositions/playwright-native-1.md §8, decision 6). Unlike vitest,
 * `source-region-text` is `pass` (tree-reconstructed — provenance below), and
 * `retry-evidence` is `pass` (per-attempt evidence lands in
 * `FailureFinding.annex.attempts`). `resolved-config-coverage` is
 * `unsupported`: playwright's resolved `FullConfig`/`FullProject` never
 * expose `expect.timeout` to the reporter (doc §4 `expect.timeout` row),
 * so `instrumentConfigDigest` below cannot cover it. This capability is
 * intentionally not one of `schema.ts`'s `EVIDENCE_CAPABILITY_NAMES` — it is
 * an instrument-config capability, not an evidence capability, so a report's
 * `failure_evidence.degraded_capabilities` never lists it (decision 6).
 */
export const PLAYWRIGHT_CAPABILITIES: CapabilityDeclaration = {
  verdicts: 'pass',
  'source-location': 'pass',
  suppression: 'pass',
  inventory: 'pass',
  'failure-evidence': 'pass',
  'source-region-text': 'pass', // provenance: tree-reconstructed
  // (spec §3.6 option (b) — error.location [channel-provided
  // pointer] + recorded source tree から sourceLineText を
  // 決定的に再構成。raw error.snippet [channel-provided] は
  // line-shift 不安定なため使用しない。0b-core-1/2 実測、
  // probes/playwright-0b-core/observations/stability-report.json)
  'retry-evidence': 'pass',
  // expect.timeout は resolved FullConfig に公開されない — 同 doc §4
  // expect.timeout 行、決定6
  'resolved-config-coverage': 'unsupported',
}

export function buildRunRecord(
  capture: Capture,
  ctx: RecordContext,
): RunRecord {
  if (capture.capture_version !== CAPTURE_VERSION) {
    throw new RecorderError(
      `unsupported capture version ${capture.capture_version}`,
    )
  }

  const redProjects = new Set<string>()
  for (const t of capture.tests) {
    const final = finalAttemptOf(t)
    if (final.status === 'failed' || final.status === 'timedOut')
      redProjects.add(t.project)
  }
  const depsClosure = transitiveDependencyClosure(capture.config.projects)

  const seenIds = new Set<string>()
  const observations: TestObservation[] = []
  const durations: Record<string, number> = {}
  const suppressed: string[] = []

  const reportedSorted = [...capture.tests].sort((a, b) =>
    compareId(testId(a, ctx.worktree), testId(b, ctx.worktree)),
  )
  for (const t of reportedSorted) {
    const id = testId(t, ctx.worktree)
    if (seenIds.has(id)) {
      // Fail-closed on ambiguity (§12): duplicate canonical IDs are not guessable.
      throw new RecorderError(`duplicate test id: ${id}`)
    }
    seenIds.add(id)
    const obs = toReportedObservation(t, id, ctx)
    observations.push(obs)
    durations[id] = Math.round(finalAttemptOf(t).duration_ms * 1000)
    if (obs.verdict === 'skip' || obs.verdict === 'xfail') suppressed.push(id)
  }

  const unreportedSorted = [...capture.unreported_tests].sort((a, b) =>
    compareId(testId(a, ctx.worktree), testId(b, ctx.worktree)),
  )
  for (const t of unreportedSorted) {
    const id = testId(t, ctx.worktree)
    if (seenIds.has(id)) {
      throw new RecorderError(`duplicate test id: ${id}`)
    }
    seenIds.add(id)
    const obs = toUnreportedObservation(t, id, redProjects, depsClosure, ctx)
    observations.push(obs)
    if (obs.verdict === 'skip') suppressed.push(id)
  }

  observations.sort((a, b) => compareId(a.test_id, b.test_id))

  const testSources: Record<string, string> = {}
  for (const t of [...capture.tests, ...capture.unreported_tests] as (
    | CapturedPwTest
    | CapturedPwUnreportedTest
  )[]) {
    const rel = relPath(ctx.worktree, t.file_abs)
    if (rel in testSources) continue
    const digest = fileDigest(t.file_abs)
    if (digest !== null) testSources[rel] = digest
  }

  const configSources: Record<string, string> = {}
  for (const abs of [...new Set(capture.config_files)].sort()) {
    const digest = fileDigest(abs)
    if (digest !== null)
      configSources[configSourceKey(abs, ctx.worktree)] = digest
  }

  const notRun = observations.filter((o) => o.verdict === 'not_run').length
  let status: CompletenessStatus = 'complete'
  if (capture.unhandled_errors > 0) status = 'crashed'
  else if (
    capture.status === 'interrupted' ||
    capture.status === 'timedout' ||
    notRun > 0
  )
    status = 'partial'

  return {
    schema_version: SCHEMA_VERSION,
    repo: {
      identity: ctx.repoIdentity,
      worktree: ctx.worktree,
      branch: ctx.branch,
      cwd: ctx.cwdRel,
    },
    invocation: { command: ctx.command, selector: [...ctx.selector].sort() },
    instrument: {
      adapter: ADAPTER_NAME,
      adapter_version: ctx.adapterVersion,
      composition_id: COMPOSITION_ID,
      config_digest: instrumentConfigDigest(capture),
      capabilities: { ...PLAYWRIGHT_CAPABILITIES },
    },
    environment: {
      runner: capture.runner,
      runner_version: capture.runner_version,
      runtime: `node ${process.version}`,
      os: process.platform,
      env_fingerprint: canonicalDigest(
        Object.fromEntries(
          DECLARED_ENV_VARS.map((k) => [k, process.env[k] ?? null]),
        ),
      ),
    },
    provenance: {
      head: ctx.head,
      dirty_diff_digest: ctx.dirtyDiffDigest,
      tree_digest: ctx.treeDigest,
    },
    surface: {
      inventory_digest: canonicalDigest([...seenIds].sort()),
      test_sources: testSources,
      config_sources: configSources,
      suppressed,
    },
    completeness: {
      status,
      child_exit_code: ctx.childExitCode,
      module_errors: [],
    },
    observations,
    recording: {
      recorder: 'vdelta-run',
      recorded_at_ms: ctx.recordedAtMs,
      durations_us: durations,
      raw_stdout: redactText(ctx.rawStdout),
      raw_stderr: redactText(ctx.rawStderr),
      capture_reason: capture.status,
      unhandled_errors: capture.unhandled_errors,
    },
  }
}

/**
 * The §4-judged-`yes` covering set (docs/compositions/playwright-native-1.md
 * §4): every field the resolved `FullConfig`/`FullProject` exposes that can
 * change evidence bytes or test-selection verdicts. `testDir`/`rootDir`/
 * `configFile`/`reporter` are `no` in the judgement table and are absent from
 * `Capture['config']`/`CapturedPwProjectConfig` by construction (never
 * captured at all — see `./capture.ts`), so no extra filtering is needed
 * here. `expect.timeout` is `channel-unavailable` (§4) and is likewise absent
 * from the capture; it is disclosed instead via
 * `PLAYWRIGHT_CAPABILITIES['resolved-config-coverage'] === 'unsupported'`.
 */
export function instrumentConfigDigest(capture: Capture): string {
  return canonicalDigest({
    fully_parallel: capture.config.fullyParallel,
    workers: capture.config.workers,
    shard: capture.config.shard,
    forbid_only: capture.config.forbidOnly,
    max_failures: capture.config.maxFailures,
    grep: capture.config.grep,
    grep_invert: capture.config.grepInvert,
    global_timeout: capture.config.globalTimeout,
    projects: capture.config.projects.map((p) => ({
      name: p.name,
      test_match: p.testMatch,
      test_ignore: p.testIgnore,
      dependencies: p.dependencies,
      retries: p.retries,
      timeout: p.timeout,
      use: p.use,
    })),
  })
}

/**
 * Project-scoped test id: `${rel}::${project}::${titles.join(' > ')}`.
 * `rel` is computed here (not carried in the capture) because the reporter
 * runs in-process without the worktree root; only the recorder — which has
 * `RecordContext.worktree` — can normalize `file_abs` into a worktree-relative
 * path.
 */
export function testId(
  t: { file_abs: string; project: string; titles: readonly string[] },
  worktree: string,
): string {
  return `${relPath(worktree, t.file_abs)}::${t.project}::${t.titles.join(' > ')}`
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function finalAttemptOf(t: CapturedPwTest): CapturedPwAttempt {
  const sorted = [...t.attempts].sort((a, b) => a.retry - b.retry)
  const last = sorted.at(-1)
  if (last === undefined) {
    throw new RecorderError(`test ${t.test_case_id} has no attempts`)
  }
  return last
}

function failingAttemptsOf(t: CapturedPwTest): CapturedPwAttempt[] {
  return [...t.attempts]
    .filter((a) => a.status === 'failed' || a.status === 'timedOut')
    .sort((a, b) => a.retry - b.retry)
}

/**
 * `annotations[].type` marker for a `status: 'skipped'` reported test
 * (contract §5.2-equivalent for playwright): `'skip'`/`'fixme'` when present,
 * else `'runtime'`.
 */
function skipMarkerFromAnnotations(
  annotations: readonly { type: string; description?: string }[],
): string {
  if (annotations.some((a) => a.type === 'skip')) return 'skip'
  if (annotations.some((a) => a.type === 'fixme')) return 'fixme'
  return 'runtime'
}

/**
 * Verdict channel first (INV-3): the *final* attempt's `status`, refined only
 * by `expected_status`/structured markers — see this file's header for the
 * mapping table (module doc comment references the task's contract).
 */
function mapVerdict(
  t: CapturedPwTest,
  finalAttempt: CapturedPwAttempt,
): { verdict: Verdict; suppression?: { marker: string; note?: string } } {
  const status = finalAttempt.status
  if (status === 'skipped') {
    return {
      verdict: 'skip',
      suppression: { marker: skipMarkerFromAnnotations(t.annotations) },
    }
  }
  if (status === 'interrupted') return { verdict: 'not_run' }

  const expected = t.expected_status
  if (status === 'passed' && expected === 'passed') return { verdict: 'pass' }
  if ((status === 'failed' || status === 'timedOut') && expected === 'failed')
    return { verdict: 'xfail', suppression: { marker: 'fail' } }
  if (status === 'passed' && expected === 'failed') return { verdict: 'fail' }
  if ((status === 'failed' || status === 'timedOut') && expected === 'passed')
    return { verdict: 'fail' }

  // Fail-closed on ambiguity (§12): no other status/expected combination is
  // guessable from playwright's public semantics.
  throw new RecorderError(
    `unmapped playwright verdict: status=${status} expected=${expected} (test ${t.test_case_id})`,
  )
}

function toReportedObservation(
  t: CapturedPwTest,
  id: string,
  ctx: RecordContext,
): TestObservation {
  const finalAttempt = finalAttemptOf(t)
  const { verdict, suppression } = mapVerdict(t, finalAttempt)
  const obs: TestObservation = { test_id: id, verdict }
  if (suppression) obs.suppression = suppression
  if (t.location_line !== null)
    obs.source_ref = {
      file: relPath(ctx.worktree, t.file_abs),
      line: t.location_line,
    }

  const failing = failingAttemptsOf(t)
  if (
    verdict === 'fail' &&
    (finalAttempt.status === 'failed' || finalAttempt.status === 'timedOut')
  ) {
    // status failed|timedOut & expected passed: build finding from the final
    // (failing) attempt; earlier failed attempts (if any, from retries) are
    // retry evidence (annex.attempts).
    const priorFailing = failing.filter((a) => a.retry !== finalAttempt.retry)
    obs.finding = buildFinding(t, finalAttempt, priorFailing, ctx)
  } else if (verdict === 'pass' && failing.length > 0) {
    // outcome 'flaky' (D2 implementation mechanism 1, design doc §7): final
    // attempt passed but an earlier attempt failed. verdict stays 'pass';
    // the finding is built from the last failing attempt, with any earlier
    // failing attempts recorded as retry evidence.
    const primary = failing.at(-1)!
    const priorFailing = failing.filter((a) => a.retry !== primary.retry)
    obs.finding = buildFinding(t, primary, priorFailing, ctx)
  }
  return obs
}

/**
 * Computes each project's transitive dependency set from
 * `Capture['config'].projects[].dependencies` (direct deps only, as declared
 * by `FullProject.dependencies`). Cycle-safe (a project cannot depend on
 * itself through the closure).
 */
function transitiveDependencyClosure(
  projects: readonly CapturedPwProjectConfig[],
): Map<string, Set<string>> {
  const direct = new Map<string, readonly string[]>()
  for (const p of projects) direct.set(p.name, p.dependencies)

  const closure = new Map<string, Set<string>>()
  function resolve(name: string, seen: ReadonlySet<string>): Set<string> {
    const cached = closure.get(name)
    if (cached !== undefined) return cached
    const result = new Set<string>()
    for (const dep of direct.get(name) ?? []) {
      if (seen.has(dep)) continue
      result.add(dep)
      const nestedSeen = new Set(seen)
      nestedSeen.add(dep)
      for (const nested of resolve(dep, nestedSeen)) result.add(nested)
    }
    closure.set(name, result)
    return result
  }
  for (const p of projects) resolve(p.name, new Set([p.name]))
  return closure
}

/**
 * spec §11.1 floor (never drop an unreported test from `observations`).
 * Per architecture decision (setup-cascade.json realtime observation): the
 * authored/dependency distinction is only meaningful for *reported* tests
 * (onTestEnd fired). A block-cascaded project's unreported tests — including
 * authored `test.skip()` ones — arrive with `annotations: []` and are
 * structurally indistinguishable, so they all synthesize into a single
 * `marker: 'dependency'` observation. Unreported tests whose transitive
 * dependency projects contain no red (failed/timedOut) reported test are
 * `not_run` instead (e.g. `interrupted`/`globalTimeout`/`maxFailures`
 * early-abort — no dependency to blame).
 */
function toUnreportedObservation(
  t: CapturedPwUnreportedTest,
  id: string,
  redProjects: ReadonlySet<string>,
  depsClosure: ReadonlyMap<string, Set<string>>,
  ctx: RecordContext,
): TestObservation {
  const obs: TestObservation = { test_id: id, verdict: 'not_run' }
  if (t.location_line !== null)
    obs.source_ref = {
      file: relPath(ctx.worktree, t.file_abs),
      line: t.location_line,
    }

  const deps = depsClosure.get(t.project) ?? new Set<string>()
  const redDeps = [...deps].filter((d) => redProjects.has(d)).sort()
  if (redDeps.length > 0) {
    obs.verdict = 'skip'
    obs.suppression = {
      marker: 'dependency',
      note: `blocked by red dependency project ${redDeps[0]}`,
    }
  }
  return obs
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires the ESC control char
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

function stripAnsi(message: string): string {
  return message.replace(ANSI_PATTERN, '')
}

const EXCEPTION_TYPE_PATTERN =
  /^([A-Za-z][A-Za-z0-9]*Error|AssertionError|TimeoutError):/

function extractExceptionType(strippedMessage: string): string {
  const m = strippedMessage.match(EXCEPTION_TYPE_PATTERN)
  return m?.[1] ?? 'Error'
}

/**
 * CE-1 failing source region text, tree-reconstructed (doc §8): prefer
 * `error.location` (channel-provided pointer), else the innermost parsed
 * stack frame that lands inside the test file itself. Raw `error.snippet` is
 * never read (line-shift unstable, `stability-report.json`). Returns
 * `undefined` — key omitted, never a guessed value — when neither a location
 * nor an in-file frame exists (e.g. fixture teardown failures) or the source
 * file cannot be read.
 */
function sourceRegion(
  t: CapturedPwTest,
  e: CapturedPwError,
): string | undefined {
  let target: { file: string; line: number } | undefined
  if (e.location !== undefined) {
    target = { file: e.location.file, line: e.location.line }
  } else {
    const inner = e.frames.find((f) => f.file === t.file_abs)
    if (inner !== undefined) target = { file: inner.file, line: inner.line }
  }
  if (target === undefined) return undefined
  try {
    const lines = readFileSync(target.file, 'utf8').split('\n')
    const text = lines[target.line - 1]
    return text !== undefined ? text.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * CE-3 position stability: per-frame line offsets relative to the test's own
 * declaration line, for frames inside the test module only (same rule as
 * `../vitest/recorder.ts`'s `relOffsets`).
 */
function relOffsets(t: CapturedPwTest, e: CapturedPwError): number[] {
  if (t.location_line === null) return []
  return e.frames
    .filter((f) => f.file === t.file_abs)
    .map((f) => f.line - t.location_line!)
}

function buildEvidenceError(
  e: CapturedPwError,
  t: CapturedPwTest,
): EvidenceError {
  const stripped = stripAnsi(e.message)
  const region = sourceRegion(t, e)
  return {
    exception_type: extractExceptionType(stripped),
    message: redactText(stripped),
    rel_offsets: relOffsets(t, e),
    ...(region !== undefined ? { source_region: region } : {}),
  }
}

function buildFinding(
  t: CapturedPwTest,
  primary: CapturedPwAttempt,
  priorFailing: readonly CapturedPwAttempt[],
  ctx: RecordContext,
): FailureFinding {
  const errors: EvidenceError[] = primary.errors.map((e) =>
    buildEvidenceError(e, t),
  )
  const consoleEntries = primary.stdio.map((s) => ({
    type: s.type,
    content: redactText(s.text),
  }))
  const attachments = primary.attachments
  const priorAttempts = [...priorFailing]
    .sort((a, b) => a.retry - b.retry)
    .map((a) => ({
      retry: a.retry,
      errors: a.errors.map((e) => buildEvidenceError(e, t)),
      frames: a.errors.flatMap((e) => e.frames),
    }))

  return {
    evidence_digest: canonicalDigest({ errors }),
    structural_fingerprint: canonicalDigest({
      module: relPath(ctx.worktree, t.file_abs),
      exception_types: errors.map((e) => e.exception_type),
      rel_offsets: errors.map((e) => e.rel_offsets),
      source_regions: errors.map((e) => e.source_region ?? null),
    }),
    evidence: { errors },
    context_digest: canonicalDigest([...consoleEntries, ...attachments]),
    annex: redactValue({
      frames: primary.errors.flatMap((e) => e.frames),
      console: consoleEntries,
      location_line: t.location_line,
      ...(priorAttempts.length > 0 ? { attempts: priorAttempts } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  }
}

/**
 * Normalizes an absolute path into a `surface.config_sources`/test-file key:
 * a worktree-relative POSIX-style path when the file lives inside the
 * worktree, or `external:<abs path>` when it doesn't. Private duplicate of
 * `../vitest/recorder.ts`'s `configSourceKey` (same convention) — the vitest
 * module is not imported from here, and is not modified by this file.
 */
export function configSourceKey(absPath: string, worktree: string): string {
  const resolvedPath = realpath(absPath)
  const resolvedWorktree = realpath(worktree)
  const rel = relative(resolvedWorktree, resolvedPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return `external:${resolvedPath}`
  return rel.replaceAll('\\', '/')
}

function relPath(worktree: string, fileAbs: string): string {
  return relative(realpath(worktree), realpath(fileAbs)).replaceAll('\\', '/')
}

function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function fileDigest(path: string): string | null {
  try {
    return canonicalDigest(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
