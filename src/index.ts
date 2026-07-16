/**
 * vdelta — reference implementation of veridelta/1.
 * Public API surface: consumer parsers (§9.4), the comparator, the store,
 * and the vitest adapter pieces.
 */
export {
  parseReport,
  parseRunRecord,
  SchemaViolationError,
  SCHEMA_VERSION,
  VERDICTS,
  COMPARABILITIES,
  NONE_REASONS,
  OUTCOME_VERDICTS,
  SURFACE_STATUSES,
  SURFACE_EVENT_KINDS,
  type ComparisonReport,
  type RunRecord,
  type TestObservation,
  type FailureFinding,
  type Verdict,
  type Comparability,
} from './schema.js'
export { RunStore, StoreCorruptError, LockHeldError, computeRunId } from './store.js'
export { buildComparisonReport, resolveBaseline, streamKey, type BaselineSpec } from './compare.js'
export { buildGateReport, type GateOptions } from './gate.js'
export { treeDigest } from './tree-digest.js'
export { canonicalJson } from './canonical.js'
export { redactText, redactValue } from './redact.js'
export { renderReport } from './render.js'
export {
  buildRunRecord,
  COMPOSITION_ID,
  DEGRADED_CAPABILITIES,
  ADAPTER_NAME,
} from './adapters/vitest/recorder.js'
export { VDELTA_VERSION } from './run.js'
