/**
 * The adapter seam. The core (`run` / `compare` / `gate`) never reaches into a
 * concrete runner: it resolves an {@link Adapter} descriptor from the registry
 * (`src/adapters/registry.ts`) and talks to it through this interface only.
 *
 * Every type here is a promotion of a shape that already existed on the vitest
 * side, so the seam is a rearrangement of what already ran rather than a new
 * mechanism: {@link RecordContext} is the recorder's context object verbatim,
 * {@link DetectResult} is the runner-token scan's return value,
 * {@link InstrumentedChild} is the argv/env injection `vdelta run` already
 * performed, and {@link CommandSelector} is the §6.4 inclusion-intent split.
 *
 * Dependency direction inside an adapter is one-way: `detect` / `instrument` /
 * `splitCommandSelector` know only the runner's *argv surface*, `record` knows
 * only its *structured channel*.
 */
import {
  CAPABILITY_VALUES,
  type CapabilityValue,
  type RunRecord,
} from './schema.js'

export type { CapabilityValue }
/**
 * The three-valued capability convention (§3.4). Defined in `schema.ts`
 * because `parseRunRecord` needs it for `instrument.capabilities` value
 * validation; re-exported here so adapter code keeps importing it from the
 * adapter seam.
 */
export { CAPABILITY_VALUES }
export type CapabilityDeclaration = Readonly<Record<string, CapabilityValue>>

/**
 * Where the adapter's structured channel lands. A single capture file is the
 * only kind today; per-process channels are follow-up F-2, at which point the
 * channel's creation and teardown move from the core into the adapter.
 */
export interface CaptureChannel {
  readonly kind: 'single-file'
  readonly path: string
}

/** What {@link Adapter.detect} returns; `null` means only "not mine". */
export interface DetectResult {
  /** argv index of the runner binary token. */
  readonly tokenIndex: number
}

/**
 * The instrumented child invocation. `argv` fully replaces the caller's argv;
 * `env` carries only the additions to layer onto the inherited environment.
 */
export interface InstrumentedChild {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** The §6.4 inclusion-intent split of a child argv (§5.1 canonical command). */
export interface CommandSelector {
  command: string[]
  selector: string[]
}

/**
 * Everything the recorder needs beyond the runner's own structured channel:
 * repo identity, provenance, the canonicalized invocation and the child's raw
 * streams. Runner-neutral by construction — no field carries runner vocabulary.
 */
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

/**
 * The capability names a declaration says the composition cannot meet, sorted
 * (§4.2 disclosure rule). `unsupported` is the only degraded value: `fail`
 * means the capability is met and the observation is red, not that evidence is
 * missing. This is what a report's `failure_evidence.degraded_capabilities`
 * and every per-test claim that carries it are derived from.
 */
export function degradedCapabilities(caps: CapabilityDeclaration): string[] {
  return Object.entries(caps)
    .filter(([, value]) => value === 'unsupported')
    .map(([name]) => name)
    .sort()
}

/** §6.4 selector containment, as declared by an adapter that can decide it. */
export type SelectorRelation =
  | 'equal'
  | 'subset'
  | 'superset'
  | 'disjoint'
  | 'unknown'
export type SelectorMatch = 'yes' | 'no' | 'unknown'

/**
 * The capture channel is unreadable, of an unsupported version, or malformed.
 * The core maps this onto degraded raw passthrough (INV-5): veridelta is never
 * worse than its absence.
 */
export class AdapterCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterCaptureError'
  }
}

export interface Adapter {
  readonly name: string
  readonly compositionId: string
  readonly declaredCapabilities: CapabilityDeclaration
  readonly declaredEnvVars: readonly string[]

  /**
   * Whether this argv is this adapter's invocation. `null` means "not mine"
   * and nothing else — an adapter alone can never conclude "this is a wrapper
   * command"; that is a registry-level conclusion.
   */
  detect(argv: readonly string[]): DetectResult | null

  /**
   * The env that points this adapter's reporter at the channel.
   *
   * Exported to the child *whether or not* the adapter claimed the argv. A
   * reporter registered in the project's own configuration (spec §4.2 ambient
   * recording — the RECOMMENDED deployment) has no other way to find the
   * channel, and it is deliberately inert without it. Gating this on argv
   * detection would silently stop recording every wrapper invocation
   * (`vdelta run -- npm test`), which is exactly the stream-severing §4.2
   * warns about.
   *
   * The channel is one file today, so two adapters pointing their reporters at
   * it would race (last writer wins). That is the pre-existing single-channel
   * hazard follow-up F-2 exists for, not something detection was protecting
   * against — pre-seam this env was exported unconditionally.
   */
  channelEnv(channel: CaptureChannel): Readonly<Record<string, string>>

  /**
   * The reporter-injected argv plus the env additions for the child. Only
   * applied when this adapter recognizes the argv: injecting runner flags into
   * a command that is not that runner kills it outright (INV-5 — veridelta is
   * never worse than its absence), and a wrapper cannot forward them anyway
   * (§4.3-7). {@link channelEnv} is what covers the uninstrumented case.
   */
  instrument(
    argv: readonly string[],
    channel: CaptureChannel,
  ): InstrumentedChild

  /**
   * Whether the capture now sitting in the channel is this adapter's, decided
   * on the channel's own payload rather than on argv.
   *
   * Consulted only when no adapter claimed the argv: the ambient case, where
   * the reporter came from the project's configuration instead of from
   * {@link instrument}, so the argv carries no evidence of which runner ran.
   * MUST NOT throw — an absent, empty, foreign or malformed channel is simply
   * not a claim. A claim asserts authorship only; a payload this adapter owns
   * but cannot use still fails in {@link record}, with its own diagnostic.
   */
  claimsCapture(channel: CaptureChannel): boolean

  /** §6.4 inclusion intent, decided purely on the runner's own CLI surface. */
  splitCommandSelector(argv: readonly string[]): CommandSelector

  /**
   * Read the capture channel, validate it, and build the Run record. Parsing
   * and version checking belong to the *adapter* — the core knows nothing
   * about the channel's payload. Failures throw {@link AdapterCaptureError},
   * which the core maps onto degraded passthrough.
   */
  record(channel: CaptureChannel, ctx: RecordContext): RunRecord

  /**
   * §6.4, optional. Undeclared means every relation is `unknown`, which is
   * exactly the comparator's pre-seam behavior (`selector-relation-unknown`).
   */
  selectorRelation?(
    a: readonly string[],
    b: readonly string[],
  ): SelectorRelation
  selectorMatches?(selector: readonly string[], testId: string): SelectorMatch

  /**
   * §6.4: does the canonical `command` (not the selector) carry a flag that
   * perturbs execution scope beyond the positional selector — `--changed`,
   * `--testNamePattern`/`-t`, sharding, related-file expansion? Undeclared
   * means "unknown whether the command perturbs scope", and the comparator
   * MUST treat that as unproven (fail-closed): it may not conclude `subset`
   * from a command it cannot ask.
   */
  commandScopePerturbed?(command: readonly string[]): boolean
}
