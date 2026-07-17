/**
 * vdelta — reference implementation of veridelta/1.
 * Public API surface: consumer parsers (§9.4), the comparator, the store,
 * and the vitest adapter pieces.
 */

export {
  ADAPTER_NAME,
  buildRunRecord,
  COMPOSITION_ID,
  DEGRADED_CAPABILITIES,
} from './adapters/vitest/recorder.js'
export { canonicalJson } from './canonical.js'
export {
  type BaselineSpec,
  buildComparisonReport,
  resolveBaseline,
  streamKey,
} from './compare.js'
export { buildGateReport, type GateOptions } from './gate.js'
export { redactText, redactValue } from './redact.js'
export { renderReport } from './render.js'
export { VDELTA_VERSION } from './run.js'
export {
  COMPARABILITIES,
  type Comparability,
  type ComparisonReport,
  type FailureFinding,
  NONE_REASONS,
  OUTCOME_VERDICTS,
  parseReport,
  parseRunRecord,
  type RunRecord,
  SCHEMA_VERSION,
  SchemaViolationError,
  SURFACE_EVENT_KINDS,
  SURFACE_STATUSES,
  type TestObservation,
  VERDICTS,
  type Verdict,
} from './schema.js'
export {
  computeRunId,
  defaultGcPolicy,
  type GcPolicy,
  type GcResult,
  LockHeldError,
  type RunMeta,
  RunStore,
  StoreCorruptError,
} from './store.js'
export { treeDigest } from './tree-digest.js'
