/**
 * vdelta — reference implementation of veridelta/1.
 * Public API surface: consumer parsers (§9.4), the comparator, the store,
 * and the vitest adapter pieces.
 */

import { degradedCapabilities } from './adapter.js'
import { resolveAdapter } from './adapters/registry.js'
import { ADAPTER_NAME, buildRunRecord } from './adapters/vitest/recorder.js'

/**
 * The vitest composition's standing, read off its adapter descriptor through
 * the registry rather than re-exported from the recorder (§4.2): what a
 * consumer sees must be what the adapter declares, so that a second adapter
 * cannot inherit vitest's disclosure. These are static public constants
 * describing the vitest adapter's *current* declaration — since Step 2, a
 * report's own `failure_evidence` is no longer derived from them: it is
 * derived from the run record's own `instrument.capabilities` (§4.2 Step 2),
 * so this pair plays no part in report generation.
 */
const vitest = resolveAdapter(ADAPTER_NAME)

export const COMPOSITION_ID: string = vitest.compositionId
export const DEGRADED_CAPABILITIES: string[] = degradedCapabilities(
  vitest.declaredCapabilities,
)

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
export { ADAPTER_NAME, buildRunRecord }
