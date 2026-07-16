/**
 * veridelta/1 data model: closed enums, report/run-record types, and the
 * consumer-side parsers. Per spec §9.4/§14 an unknown value in any closed
 * enum is a hard error (throw), and unknown fields are rejected — no
 * backward-compatibility scaffolding.
 */

export const SCHEMA_VERSION = 'veridelta/1'

export const VERDICTS = ['pass', 'fail', 'error', 'skip', 'xfail', 'xpass', 'not_run'] as const
export type Verdict = (typeof VERDICTS)[number]
export const RED_SET: readonly Verdict[] = ['fail', 'error']

export const COMPARABILITIES = ['exact', 'scope_changed', 'subset', 'partial', 'none'] as const
export type Comparability = (typeof COMPARABILITIES)[number]

export const NONE_REASONS = [
  'baseline-missing',
  'stream-mismatch',
  'instrument-changed',
  'selector-relation-unknown',
  'store-corrupt',
  'adapter-crashed',
  'record-integrity-failed',
] as const
export type NoneReason = (typeof NONE_REASONS)[number]

export const DETAIL_KINDS = ['determined', 'failed'] as const
export type DetailKind = (typeof DETAIL_KINDS)[number]

export const OUTCOME_VERDICTS = ['regressed', 'improved', 'unchanged', 'inconclusive'] as const
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number]

export const SURFACE_STATUSES = ['intact', 'changed', 'reduced', 'inconclusive'] as const
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number]

export const SURFACE_EVENT_KINDS = [
  'test-added',
  'test-removed',
  'test-renamed',
  'fail-to-skip',
  'fail-to-xfail',
  'selector-changed',
  'runner-config-changed',
  'adapter-capability-changed',
  'selector-subset',
  'test-source-changed',
  'config-source-changed',
] as const
export type SurfaceEventKind = (typeof SURFACE_EVENT_KINDS)[number]

export const BASELINE_MODES = [
  'previous-comparable',
  'git-ref',
  'explicit-run-id',
  'previous-superset',
] as const
export type BaselineMode = (typeof BASELINE_MODES)[number]

export const COMPLETENESS_STATUSES = ['complete', 'partial', 'crashed'] as const
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number]

export const RECORD_INTEGRITIES = ['advisory', 'tamper-evident', 'trusted-environment'] as const
export type RecordIntegrity = (typeof RECORD_INTEGRITIES)[number]

export const GATE_POLICIES = ['report-only', 'advisory', 'blocking'] as const
export type GatePolicy = (typeof GATE_POLICIES)[number]

export const GATE_VERDICTS = ['pass', 'fail', 'inconclusive'] as const
export type GateVerdict = (typeof GATE_VERDICTS)[number]

export const GATE_TARGET_KINDS = ['head', 'merge'] as const

export const TRANSITION_KEYS = [
  'new_fail',
  'still_fail_unchanged',
  'updated_fail',
  'repaired_same_surface',
  'repaired_with_test_change',
  'fail_to_skip',
  'fail_to_xfail',
  'removed',
  'not_observed',
  'out_of_scope',
  'verification_inconclusive',
] as const

// ---------------------------------------------------------------------------
// Types

export interface ComparabilityDetail {
  reason: NoneReason
  kind: DetailKind
}

export interface StillFailEntry {
  test_id: string
  degraded_capabilities?: string[]
  context_changed?: boolean
}

export interface UpdatedFailEntry {
  test_id: string
  evidence_digest_before: string
  evidence_digest_after: string
  failure_mode_changed: boolean
  degraded_capabilities?: string[]
}

export interface SurfaceEvent {
  kind: SurfaceEventKind
  test_id?: string
  path?: string
  from?: string
  to?: string
}

export interface Transitions {
  new_fail: string[]
  still_fail_unchanged: (string | StillFailEntry)[]
  updated_fail: UpdatedFailEntry[]
  repaired_same_surface: string[]
  repaired_with_test_change: string[]
  fail_to_skip: string[]
  fail_to_xfail: string[]
  removed: string[]
  not_observed: string[]
  out_of_scope?: string[]
  verification_inconclusive?: string[]
}

export interface ComparisonReport {
  schema_version: typeof SCHEMA_VERSION
  outcome_verdict: OutcomeVerdict
  comparability: Comparability
  comparability_detail?: ComparabilityDetail
  baseline: {
    run_id: string
    mode: BaselineMode
    selection_reason: string
    superset_candidates?: number
  } | null
  current: {
    run_id: string
    complete: boolean
    child_exit_code: number
    red?: string[]
  }
  observation_coverage: {
    baseline?: string
    current: string
  }
  verification_surface?: {
    status: SurfaceStatus
    events: SurfaceEvent[]
  }
  transitions?: Transitions
  failure_evidence: {
    composition_id: string
    degraded_capabilities: string[]
  }
  trust: {
    record_integrity: RecordIntegrity
  }
  anchors: Record<string, string>
  budget_exceeded_for_safety?: boolean
  masking_applied?: { count: number; example: string }
  gate?: GateReport
}

export interface GateReport {
  policy: GatePolicy
  verdict: GateVerdict
  triggered: string[]
  target: {
    kind: (typeof GATE_TARGET_KINDS)[number]
    head_sha: string
    base_sha: string
    merge_sha?: string
  }
  staleness: {
    run_tree_digest: string
    target_tree_digest: string
    match: boolean
    unverified_submodules: string[]
  }
  record_integrity: RecordIntegrity
}

export interface EvidenceError {
  exception_type: string
  message: string
  expected?: string
  actual?: string
  operator?: string
  rel_offsets: number[]
}

export interface FailureFinding {
  evidence_digest: string
  structural_fingerprint: string
  evidence: { errors: EvidenceError[] }
  context_digest: string
  annex: {
    frames: { file: string; line: number; column: number }[]
    console: { type: string; content: string }[]
    location_line: number | null
  }
}

export interface TestObservation {
  test_id: string
  verdict: Verdict
  suppression?: { marker: string; note?: string }
  source_ref?: { file: string; line: number }
  finding?: FailureFinding
}

export interface RunRecord {
  schema_version: typeof SCHEMA_VERSION
  repo: { identity: string; worktree: string; branch: string; cwd: string }
  invocation: { command: string[]; selector: string[] }
  instrument: {
    adapter: string
    adapter_version: string
    composition_id: string
    config_digest: string
  }
  environment: {
    runner: string
    runner_version: string
    runtime: string
    os: string
    env_fingerprint: string
  }
  provenance: { head: string | null; dirty_diff_digest: string; tree_digest: string }
  surface: {
    inventory_digest: string
    test_sources: Record<string, string>
    config_sources: Record<string, string>
    suppressed: string[]
  }
  completeness: { status: CompletenessStatus; child_exit_code: number }
  observations: TestObservation[]
  recording: {
    recorder: string
    recorded_at_ms: number
    durations_us: Record<string, number>
    raw_stdout: string
    raw_stderr: string
    capture_reason: string
    unhandled_errors: number
  }
}

// ---------------------------------------------------------------------------
// Consumer-side validation

export class SchemaViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaViolationError'
  }
}

type Obj = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new SchemaViolationError(`${path}: ${message}`)
}

function asObject(v: unknown, path: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected object')
  return v as Obj
}

function checkKeys(o: Obj, path: string, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) fail(path, `unknown field "${k}" (unknown fields are rejected, §14)`)
  }
  for (const k of required) {
    if (!(k in o)) fail(path, `missing required field "${k}"`)
  }
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected string')
  return v
}

function asBoolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected boolean')
  return v
}

function asInteger(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(path, 'expected integer')
  return v
}

function asStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, 'expected array')
  return v.map((e, i) => asString(e, `${path}[${i}]`))
}

function asEnum<T extends string>(v: unknown, values: readonly T[], path: string): T {
  const s = asString(v, path)
  if (!(values as readonly string[]).includes(s)) {
    fail(path, `unknown closed-enum value "${s}" (hard error, §9.4)`)
  }
  return s as T
}

function validateStringMap(v: unknown, path: string): void {
  const o = asObject(v, path)
  for (const [k, val] of Object.entries(o)) asString(val, `${path}.${k}`)
}

function validateStillFailEntry(v: unknown, path: string): void {
  if (typeof v === 'string') return
  const o = asObject(v, path)
  checkKeys(o, path, ['test_id'], ['degraded_capabilities', 'context_changed'])
  asString(o.test_id, `${path}.test_id`)
  if ('degraded_capabilities' in o) asStringArray(o.degraded_capabilities, `${path}.degraded_capabilities`)
  if ('context_changed' in o) asBoolean(o.context_changed, `${path}.context_changed`)
}

function validateUpdatedFailEntry(v: unknown, path: string): void {
  const o = asObject(v, path)
  checkKeys(
    o,
    path,
    ['test_id', 'evidence_digest_before', 'evidence_digest_after', 'failure_mode_changed'],
    ['degraded_capabilities'],
  )
  asString(o.test_id, `${path}.test_id`)
  asString(o.evidence_digest_before, `${path}.evidence_digest_before`)
  asString(o.evidence_digest_after, `${path}.evidence_digest_after`)
  asBoolean(o.failure_mode_changed, `${path}.failure_mode_changed`)
  if ('degraded_capabilities' in o) asStringArray(o.degraded_capabilities, `${path}.degraded_capabilities`)
}

function validateTransitions(v: unknown, path: string): void {
  const o = asObject(v, path)
  checkKeys(
    o,
    path,
    [
      'new_fail',
      'still_fail_unchanged',
      'updated_fail',
      'repaired_same_surface',
      'repaired_with_test_change',
      'fail_to_skip',
      'fail_to_xfail',
      'removed',
      'not_observed',
    ],
    ['out_of_scope', 'verification_inconclusive'],
  )
  for (const key of TRANSITION_KEYS) {
    if (!(key in o)) continue
    const arr = o[key]
    if (!Array.isArray(arr)) fail(`${path}.${key}`, 'expected array')
    if (key === 'still_fail_unchanged') {
      arr.forEach((e, i) => validateStillFailEntry(e, `${path}.${key}[${i}]`))
    } else if (key === 'updated_fail') {
      arr.forEach((e, i) => validateUpdatedFailEntry(e, `${path}.${key}[${i}]`))
    } else {
      arr.forEach((e, i) => asString(e, `${path}.${key}[${i}]`))
    }
  }
}

function validateSurfaceEvent(v: unknown, path: string): void {
  const o = asObject(v, path)
  checkKeys(o, path, ['kind'], ['test_id', 'path', 'from', 'to'])
  asEnum(o.kind, SURFACE_EVENT_KINDS, `${path}.kind`)
  for (const k of ['test_id', 'path', 'from', 'to'] as const) {
    if (k in o) asString(o[k], `${path}.${k}`)
  }
}

function validateGate(v: unknown, path: string): void {
  const o = asObject(v, path)
  checkKeys(o, path, ['policy', 'verdict', 'triggered', 'target', 'staleness', 'record_integrity'])
  asEnum(o.policy, GATE_POLICIES, `${path}.policy`)
  asEnum(o.verdict, GATE_VERDICTS, `${path}.verdict`)
  asStringArray(o.triggered, `${path}.triggered`)
  const target = asObject(o.target, `${path}.target`)
  checkKeys(target, `${path}.target`, ['kind', 'head_sha', 'base_sha'], ['merge_sha'])
  asEnum(target.kind, GATE_TARGET_KINDS, `${path}.target.kind`)
  asString(target.head_sha, `${path}.target.head_sha`)
  asString(target.base_sha, `${path}.target.base_sha`)
  const staleness = asObject(o.staleness, `${path}.staleness`)
  checkKeys(staleness, `${path}.staleness`, [
    'run_tree_digest',
    'target_tree_digest',
    'match',
    'unverified_submodules',
  ])
  asString(staleness.run_tree_digest, `${path}.staleness.run_tree_digest`)
  asString(staleness.target_tree_digest, `${path}.staleness.target_tree_digest`)
  asBoolean(staleness.match, `${path}.staleness.match`)
  asStringArray(staleness.unverified_submodules, `${path}.staleness.unverified_submodules`)
  asEnum(o.record_integrity, RECORD_INTEGRITIES, `${path}.record_integrity`)
}

/**
 * Consumer entry point (§9.4): parse and validate a veridelta/1 comparison
 * (or gate) report. Throws SchemaViolationError on any unknown enum value or
 * unknown field.
 */
export function parseReport(value: unknown): ComparisonReport {
  const o = asObject(value, 'report')
  checkKeys(
    o,
    'report',
    [
      'schema_version',
      'outcome_verdict',
      'comparability',
      'baseline',
      'current',
      'observation_coverage',
      'failure_evidence',
      'trust',
      'anchors',
    ],
    [
      'comparability_detail',
      'verification_surface',
      'transitions',
      'budget_exceeded_for_safety',
      'masking_applied',
      'gate',
    ],
  )
  if (o.schema_version !== SCHEMA_VERSION) {
    fail('report.schema_version', `expected "${SCHEMA_VERSION}"`)
  }
  asEnum(o.outcome_verdict, OUTCOME_VERDICTS, 'report.outcome_verdict')
  const comparability = asEnum(o.comparability, COMPARABILITIES, 'report.comparability')

  if (o.baseline !== null) {
    const b = asObject(o.baseline, 'report.baseline')
    checkKeys(b, 'report.baseline', ['run_id', 'mode', 'selection_reason'], ['superset_candidates'])
    asString(b.run_id, 'report.baseline.run_id')
    asEnum(b.mode, BASELINE_MODES, 'report.baseline.mode')
    asString(b.selection_reason, 'report.baseline.selection_reason')
    if ('superset_candidates' in b) asInteger(b.superset_candidates, 'report.baseline.superset_candidates')
  }

  const cur = asObject(o.current, 'report.current')
  checkKeys(cur, 'report.current', ['run_id', 'complete', 'child_exit_code'], ['red'])
  asString(cur.run_id, 'report.current.run_id')
  asBoolean(cur.complete, 'report.current.complete')
  asInteger(cur.child_exit_code, 'report.current.child_exit_code')
  if ('red' in cur) asStringArray(cur.red, 'report.current.red')

  const cov = asObject(o.observation_coverage, 'report.observation_coverage')
  checkKeys(cov, 'report.observation_coverage', ['current'], ['baseline'])
  asString(cov.current, 'report.observation_coverage.current')
  if ('baseline' in cov) asString(cov.baseline, 'report.observation_coverage.baseline')

  if ('comparability_detail' in o) {
    const d = asObject(o.comparability_detail, 'report.comparability_detail')
    checkKeys(d, 'report.comparability_detail', ['reason', 'kind'])
    asEnum(d.reason, NONE_REASONS, 'report.comparability_detail.reason')
    asEnum(d.kind, DETAIL_KINDS, 'report.comparability_detail.kind')
  } else if (comparability === 'none') {
    fail('report.comparability_detail', 'required when comparability is "none" (§6.3)')
  }

  if ('verification_surface' in o) {
    const s = asObject(o.verification_surface, 'report.verification_surface')
    checkKeys(s, 'report.verification_surface', ['status', 'events'])
    asEnum(s.status, SURFACE_STATUSES, 'report.verification_surface.status')
    if (!Array.isArray(s.events)) fail('report.verification_surface.events', 'expected array')
    s.events.forEach((e, i) => validateSurfaceEvent(e, `report.verification_surface.events[${i}]`))
  }

  if ('transitions' in o) validateTransitions(o.transitions, 'report.transitions')

  const fe = asObject(o.failure_evidence, 'report.failure_evidence')
  checkKeys(fe, 'report.failure_evidence', ['composition_id', 'degraded_capabilities'])
  asString(fe.composition_id, 'report.failure_evidence.composition_id')
  asStringArray(fe.degraded_capabilities, 'report.failure_evidence.degraded_capabilities')

  const trust = asObject(o.trust, 'report.trust')
  checkKeys(trust, 'report.trust', ['record_integrity'])
  asEnum(trust.record_integrity, RECORD_INTEGRITIES, 'report.trust.record_integrity')

  validateStringMap(o.anchors, 'report.anchors')

  if ('budget_exceeded_for_safety' in o) asBoolean(o.budget_exceeded_for_safety, 'report.budget_exceeded_for_safety')
  if ('masking_applied' in o) {
    const m = asObject(o.masking_applied, 'report.masking_applied')
    checkKeys(m, 'report.masking_applied', ['count', 'example'])
    asInteger(m.count, 'report.masking_applied.count')
    asString(m.example, 'report.masking_applied.example')
  }
  if ('gate' in o) validateGate(o.gate, 'report.gate')

  return o as unknown as ComparisonReport
}

function validateFinding(v: unknown, path: string): void {
  const o = asObject(v, path)
  checkKeys(o, path, ['evidence_digest', 'structural_fingerprint', 'evidence', 'context_digest', 'annex'])
  asString(o.evidence_digest, `${path}.evidence_digest`)
  asString(o.structural_fingerprint, `${path}.structural_fingerprint`)
  const ev = asObject(o.evidence, `${path}.evidence`)
  checkKeys(ev, `${path}.evidence`, ['errors'])
  if (!Array.isArray(ev.errors)) fail(`${path}.evidence.errors`, 'expected array')
  ev.errors.forEach((e, i) => {
    const eo = asObject(e, `${path}.evidence.errors[${i}]`)
    checkKeys(
      eo,
      `${path}.evidence.errors[${i}]`,
      ['exception_type', 'message', 'rel_offsets'],
      ['expected', 'actual', 'operator'],
    )
    asString(eo.exception_type, `${path}.evidence.errors[${i}].exception_type`)
    asString(eo.message, `${path}.evidence.errors[${i}].message`)
    if (!Array.isArray(eo.rel_offsets)) fail(`${path}.evidence.errors[${i}].rel_offsets`, 'expected array')
    eo.rel_offsets.forEach((n, j) => asInteger(n, `${path}.evidence.errors[${i}].rel_offsets[${j}]`))
  })
  asString(o.context_digest, `${path}.context_digest`)
  const annex = asObject(o.annex, `${path}.annex`)
  checkKeys(annex, `${path}.annex`, ['frames', 'console', 'location_line'])
}

/**
 * Consumer entry point for stored run records; same hard-error discipline
 * as parseReport.
 */
export function parseRunRecord(value: unknown): RunRecord {
  const o = asObject(value, 'record')
  checkKeys(o, 'record', [
    'schema_version',
    'repo',
    'invocation',
    'instrument',
    'environment',
    'provenance',
    'surface',
    'completeness',
    'observations',
    'recording',
  ])
  if (o.schema_version !== SCHEMA_VERSION) fail('record.schema_version', `expected "${SCHEMA_VERSION}"`)

  const repo = asObject(o.repo, 'record.repo')
  checkKeys(repo, 'record.repo', ['identity', 'worktree', 'branch', 'cwd'])
  const invocation = asObject(o.invocation, 'record.invocation')
  checkKeys(invocation, 'record.invocation', ['command', 'selector'])
  asStringArray(invocation.command, 'record.invocation.command')
  asStringArray(invocation.selector, 'record.invocation.selector')

  const instrument = asObject(o.instrument, 'record.instrument')
  checkKeys(instrument, 'record.instrument', ['adapter', 'adapter_version', 'composition_id', 'config_digest'])

  const environment = asObject(o.environment, 'record.environment')
  checkKeys(environment, 'record.environment', ['runner', 'runner_version', 'runtime', 'os', 'env_fingerprint'])

  const provenance = asObject(o.provenance, 'record.provenance')
  checkKeys(provenance, 'record.provenance', ['head', 'dirty_diff_digest', 'tree_digest'])
  if (provenance.head !== null) asString(provenance.head, 'record.provenance.head')
  asString(provenance.tree_digest, 'record.provenance.tree_digest')

  const surface = asObject(o.surface, 'record.surface')
  checkKeys(surface, 'record.surface', ['inventory_digest', 'test_sources', 'config_sources', 'suppressed'])
  validateStringMap(surface.test_sources, 'record.surface.test_sources')
  validateStringMap(surface.config_sources, 'record.surface.config_sources')
  asStringArray(surface.suppressed, 'record.surface.suppressed')

  const completeness = asObject(o.completeness, 'record.completeness')
  checkKeys(completeness, 'record.completeness', ['status', 'child_exit_code'])
  asEnum(completeness.status, COMPLETENESS_STATUSES, 'record.completeness.status')
  asInteger(completeness.child_exit_code, 'record.completeness.child_exit_code')

  if (!Array.isArray(o.observations)) fail('record.observations', 'expected array')
  o.observations.forEach((obs, i) => {
    const oo = asObject(obs, `record.observations[${i}]`)
    checkKeys(oo, `record.observations[${i}]`, ['test_id', 'verdict'], ['suppression', 'source_ref', 'finding'])
    asString(oo.test_id, `record.observations[${i}].test_id`)
    asEnum(oo.verdict, VERDICTS, `record.observations[${i}].verdict`)
    if ('suppression' in oo) {
      const sup = asObject(oo.suppression, `record.observations[${i}].suppression`)
      checkKeys(sup, `record.observations[${i}].suppression`, ['marker'], ['note'])
      asString(sup.marker, `record.observations[${i}].suppression.marker`)
    }
    if ('source_ref' in oo) {
      const sr = asObject(oo.source_ref, `record.observations[${i}].source_ref`)
      checkKeys(sr, `record.observations[${i}].source_ref`, ['file', 'line'])
      asString(sr.file, `record.observations[${i}].source_ref.file`)
      asInteger(sr.line, `record.observations[${i}].source_ref.line`)
    }
    if ('finding' in oo) validateFinding(oo.finding, `record.observations[${i}].finding`)
  })

  const recording = asObject(o.recording, 'record.recording')
  checkKeys(recording, 'record.recording', [
    'recorder',
    'recorded_at_ms',
    'durations_us',
    'raw_stdout',
    'raw_stderr',
    'capture_reason',
    'unhandled_errors',
  ])

  return o as unknown as RunRecord
}

export function isRed(verdict: Verdict): boolean {
  return RED_SET.includes(verdict)
}
