/**
 * vitest adapter, recorder side: turns a Capture dump plus execution context
 * into a canonical RunRecord (§3). Composition `vitest-native/1` (expC):
 * digest core = exception type + message + structured expected/actual +
 * operator + line-shift-stable relOffsets; source-region-text is declared
 * unsupported (degraded capability); absolute positions, raw stacks, console
 * output and durations are annex/recording material, never digested.
 * Execution-cache coherence (§4.5): empirical probing found no stale-source
 * path in vitest run mode, so this adapter declares that no cache
 * neutralization is required — the §13.2(b) fixture arbitrates that claim.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
export const COMPOSITION_ID = 'vitest-native/1'
/** CE-1: vitest's structured channel has no failing-source-region text (expC Q1). */
export const DEGRADED_CAPABILITIES = ['source-region-text']
/** Env vars whose values (fingerprinted, never stored) are comparison-relevant. */
export const DECLARED_ENV_VARS = ['CI', 'NODE_ENV', 'TZ', 'LANG'] as const

const CONFIG_SOURCE_CANDIDATES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.js',
]

export class RecorderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecorderError'
  }
}

export interface RecordContext {
  worktree: string
  repoIdentity: string
  branch: string
  cwdRel: string
  command: string[]
  selector: string[]
  head: string | null
  treeDigest: string
  dirtyDiffDigest: string
  childExitCode: number
  rawStdout: string
  rawStderr: string
  adapterVersion: string
  recordedAtMs: number
}

export function buildRunRecord(
  capture: Capture,
  ctx: RecordContext,
): RunRecord {
  if (capture.capture_version !== 1) {
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
  for (const rel of CONFIG_SOURCE_CANDIDATES) {
    const digest = fileDigest(join(ctx.worktree, rel))
    if (digest !== null) configSources[rel] = digest
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
      config_digest: instrumentConfigDigest(capture),
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
    completeness: { status, child_exit_code: ctx.childExitCode },
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

/** The effective evidence-affecting configuration (§3.1, contract §5.4). */
export function instrumentConfigDigest(capture: Capture): string {
  return canonicalDigest({
    include_task_location: capture.config.include_task_location,
    truncate_threshold: capture.config.truncate_threshold,
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

function fileDigest(path: string): string | null {
  try {
    return canonicalDigest(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
