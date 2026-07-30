/**
 * vitest adapter, recorder side: turns a Capture dump plus execution context
 * into a canonical RunRecord (§3). Composition `vitest-native/2` (expC):
 * digest core = exception type + message + structured expected/actual +
 * operator + line-shift-stable relOffsets; source-region-text is declared
 * unsupported (degraded capability); absolute positions, raw stacks, console
 * output and durations are annex/recording material, never digested.
 * Execution-cache coherence (§4.5): empirical probing found no stale-source
 * path in vitest run mode, so this adapter declares that no cache
 * neutralization is required — the §13.2(b) fixture arbitrates that claim.
 * `/2` bumped the record shape, not the capability declaration (§3.4
 * unchanged since `/1`): `instrument.config_digest` now covers all 9
 * judgement-table items (environment/pool/isolate/retry/test_timeout/
 * setup_files/sequence in addition to the original two), and
 * `completeness.module_errors` makes crash accounting a structured,
 * programmatically enumerable field instead of only a status string.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
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
import type { Capture, CapturedTest } from './capture.js'

export const ADAPTER_NAME = 'vitest'
export const COMPOSITION_ID = 'vitest-native/2'
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
 * Capability declaration for the `vitest-native` composition series (§3.4).
 * Unchanged since `/1`, and still true under `/2`: only `source-region-text`
 * is degraded (CE-1 — vitest's structured channel carries no failing-source
 * region text), everything else this composition claims is met. The `/2`
 * version bump (record shape: 9-item config_digest covering +
 * `completeness.module_errors`) does not touch this declaration.
 */
export const VITEST_CAPABILITIES: CapabilityDeclaration = {
  verdicts: 'pass',
  'source-location': 'pass',
  suppression: 'pass',
  inventory: 'pass',
  'failure-evidence': 'pass',
  'source-region-text': 'unsupported',
}

export function buildRunRecord(
  capture: Capture,
  ctx: RecordContext,
): RunRecord {
  if (capture.capture_version !== 3) {
    throw new RecorderError(
      `unsupported capture version ${capture.capture_version}`,
    )
  }

  const observations: TestObservation[] = []
  const durations: Record<string, number> = {}
  const seenIds = new Set<string>()
  const suppressed: string[] = []

  const sorted = [...capture.tests].sort((a, b) =>
    testId(a) < testId(b) ? -1 : testId(a) > testId(b) ? 1 : 0,
  )
  for (const t of sorted) {
    const id = testId(t)
    if (seenIds.has(id)) {
      // Fail-closed on ambiguity (§12): duplicate canonical IDs are not guessable.
      throw new RecorderError(`duplicate test id: ${id}`)
    }
    seenIds.add(id)
    const obs = toObservation(t, id)
    observations.push(obs)
    if (t.duration_us !== null) durations[id] = t.duration_us
    if (obs.verdict === 'skip' || obs.verdict === 'xfail') suppressed.push(id)
  }

  const testSources: Record<string, string> = {}
  for (const rel of [...new Set(capture.tests.map((t) => t.rel))].sort()) {
    const digest = fileDigest(join(ctx.worktree, rel))
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
  if (capture.unhandled_errors > 0 || capture.module_errors.length > 0)
    status = 'crashed'
  else if (capture.reason === 'interrupted' || notRun > 0) status = 'partial'

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
      config_digest: instrumentConfigDigest(capture, ctx.worktree),
      capabilities: { ...VITEST_CAPABILITIES },
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
      module_errors: [...capture.module_errors]
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
        .map((m) => ({ rel: m.rel, count: m.messages.length })),
    },
    observations,
    recording: {
      recorder: 'vdelta-run',
      recorded_at_ms: ctx.recordedAtMs,
      durations_us: durations,
      raw_stdout: redactText(ctx.rawStdout),
      raw_stderr: redactText(ctx.rawStderr),
      capture_reason: capture.reason,
      unhandled_errors: capture.unhandled_errors,
    },
  }
}

/**
 * The effective evidence-affecting configuration (§3.1, contract §5.4):
 * the judgement table's 9 covered items. `setup_files` is kept in resolved
 * order (not sorted — setup execution order is evidence-affecting) and
 * normalized to `config_sources`-style keys so the digest stays
 * machine-portable (worktree-relative, or `external:<abs path>`).
 */
export function instrumentConfigDigest(
  capture: Capture,
  worktree: string,
): string {
  return canonicalDigest({
    include_task_location: capture.config.include_task_location,
    truncate_threshold: capture.config.truncate_threshold,
    environment: capture.config.environment,
    pool: capture.config.pool,
    isolate: capture.config.isolate,
    retry: capture.config.retry,
    test_timeout: capture.config.test_timeout,
    setup_files: capture.config.setup_files.map((p) =>
      configSourceKey(p, worktree),
    ),
    sequence: capture.config.sequence,
  })
}

export function testId(t: CapturedTest): string {
  return `${t.rel}::${t.full_name}`
}

function toObservation(t: CapturedTest, id: string): TestObservation {
  const { verdict, suppression } = mapVerdict(t)
  const obs: TestObservation = { test_id: id, verdict }
  if (suppression) obs.suppression = suppression
  if (t.location_line !== null)
    obs.source_ref = { file: t.rel, line: t.location_line }
  if (verdict === 'fail' || verdict === 'error') obs.finding = buildFinding(t)
  return obs
}

/** Contract §5.2 verdict mapping — verdict channel first (INV-3), refined only by structured markers. */
function mapVerdict(t: CapturedTest): {
  verdict: Verdict
  suppression?: { marker: string; note?: string }
} {
  switch (t.state) {
    case 'passed':
      return t.fails
        ? { verdict: 'xfail', suppression: { marker: 'fails' } }
        : { verdict: 'pass' }
    case 'failed':
      return t.fails
        ? { verdict: 'fail', suppression: { marker: 'fails' } }
        : { verdict: 'fail' }
    case 'skipped':
      if (t.mode === 'skip')
        return { verdict: 'skip', suppression: { marker: 'skip' } }
      if (t.mode === 'todo')
        return { verdict: 'skip', suppression: { marker: 'todo' } }
      return {
        verdict: 'skip',
        suppression: {
          marker: 'runtime',
          ...(t.note !== undefined ? { note: t.note } : {}),
        },
      }
    case 'pending':
      return { verdict: 'not_run' }
  }
}

function buildFinding(t: CapturedTest): FailureFinding {
  const errors: EvidenceError[] = t.errors.map((e) => ({
    exception_type: e.name,
    message: redactText(e.message),
    ...(e.expected !== undefined ? { expected: redactText(e.expected) } : {}),
    ...(e.actual !== undefined ? { actual: redactText(e.actual) } : {}),
    ...(e.operator !== undefined ? { operator: e.operator } : {}),
    rel_offsets: relOffsets(t, e.frames),
  }))
  const consoleEntries = t.console.map((c) => ({
    type: c.type,
    content: redactText(c.content),
  }))
  return {
    evidence_digest: canonicalDigest({ errors }),
    structural_fingerprint: canonicalDigest({
      module: t.rel,
      exception_types: errors.map((e) => e.exception_type),
      operators: errors.map((e) => e.operator ?? null),
      rel_offsets: errors.map((e) => e.rel_offsets),
    }),
    evidence: { errors },
    context_digest: canonicalDigest(consoleEntries),
    annex: redactValue({
      frames: t.errors.flatMap((e) => e.frames),
      console: consoleEntries,
      location_line: t.location_line,
    }),
  }
}

/**
 * CE-3 position stability: per-frame line offsets relative to the test's own
 * declaration line, for frames inside the test module only. Absolute lines
 * never enter the digest (expC §2).
 */
function relOffsets(
  t: CapturedTest,
  frames: { file: string; line: number }[],
): number[] {
  if (t.location_line === null) return []
  return frames
    .filter((f) => f.file === t.module_id)
    .map((f) => f.line - t.location_line!)
}

/**
 * Normalizes a config file's absolute path into a `surface.config_sources`
 * key: a worktree-relative POSIX-style path when the file lives inside the
 * worktree, or `external:<abs path>` when it doesn't (§3, config_sources key
 * convention). Both paths are realpath'd first so filesystem-level aliasing
 * (e.g. macOS's /var -> /private/var symlink) doesn't cause a worktree-local
 * config to be misclassified as external.
 */
export function configSourceKey(absPath: string, worktree: string): string {
  const resolvedPath = realpath(absPath)
  const resolvedWorktree = realpath(worktree)
  const rel = relative(resolvedWorktree, resolvedPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return `external:${resolvedPath}`
  // Keys are recorded artifacts (§3 convention) and must be platform-
  // independent, so normalize Windows backslashes to forward slashes.
  return rel.replaceAll('\\', '/')
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
