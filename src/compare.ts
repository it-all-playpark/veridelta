/**
 * Comparator (spec §5–§9): baseline selection, comparability judgment,
 * the three delta axes, and comparison-report construction. Deterministic:
 * no timestamps, stable sort orders, recency = store insertion order.
 */
import { findAdapter } from './adapters/registry.js'
import {
  type BaselineMode,
  type Comparability,
  type ComparabilityDetail,
  type ComparisonReport,
  EVIDENCE_CAPABILITY_NAMES,
  isRed,
  type NearMiss,
  type NearMissMismatch,
  type NoneReason,
  type RunRecord,
  SCHEMA_VERSION,
  STREAM_KEY_FIELDS,
  type StillFailEntry,
  type StreamKeyField,
  type SurfaceEvent,
  type SurfaceStatus,
  type Transitions,
  type UpdatedFailEntry,
} from './schema.js'
import { type RunMeta, type RunStore, StoreCorruptError } from './store.js'

export type BaselineSpec =
  | { mode: 'previous-comparable' }
  | { mode: 'explicit-run-id'; runId: string }
  | { mode: 'git-ref'; ref: string; commit: string; tree: string }
  | { mode: 'previous-superset' }

export class CompareOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompareOperationError'
  }
}

/**
 * Structural view of the stream-key-relevant fields, satisfied by both
 * full {@link RunRecord}s and the lightweight {@link RunMeta} produced by
 * `RunStore.readRunMeta()`. Lets baseline-scan code work with either
 * without a strict-parse of every candidate.
 */
export type StreamKeyView = Pick<
  RunRecord,
  'repo' | 'invocation' | 'instrument'
>

/** Stream key (§5.1): repo + worktree + branch + cwd + command + selector + instrument. */
export function streamKey(r: StreamKeyView): string {
  return JSON.stringify([
    r.repo.identity,
    r.repo.worktree,
    r.repo.branch,
    r.repo.cwd,
    r.invocation.command,
    r.invocation.selector,
    r.instrument.adapter,
    r.instrument.adapter_version,
    r.instrument.config_digest,
  ])
}

/**
 * Series key (§5.1): the stream key minus the selector — solely used to
 * scope `previous-superset` candidacy to the same series of runs. Never
 * widens what `streamKey`/`previous-comparable` treat as comparable: a
 * series-mate found through this key still needs its own proven selector
 * relation (via the adapter's `selectorRelation`) before it becomes a
 * `previous-superset` candidate.
 */
export function seriesKey(r: StreamKeyView): string {
  return JSON.stringify([
    r.repo.identity,
    r.repo.worktree,
    r.repo.branch,
    r.repo.cwd,
    r.invocation.command,
    r.instrument.adapter,
    r.instrument.adapter_version,
    r.instrument.config_digest,
  ])
}

/** Stream-key component value, rendered for near-miss disclosure (array fields joined with a single space). */
function streamKeyFieldValue(r: StreamKeyView, field: StreamKeyField): string {
  switch (field) {
    case 'repo.identity':
      return r.repo.identity
    case 'repo.worktree':
      return r.repo.worktree
    case 'repo.branch':
      return r.repo.branch
    case 'repo.cwd':
      return r.repo.cwd
    case 'invocation.command':
      return r.invocation.command.join(' ')
    case 'invocation.selector':
      return r.invocation.selector.join(' ')
    case 'instrument.adapter':
      return r.instrument.adapter
    case 'instrument.adapter_version':
      return r.instrument.adapter_version
    case 'instrument.config_digest':
      return r.instrument.config_digest
  }
}

function streamKeyFieldEqual(
  a: StreamKeyView,
  b: StreamKeyView,
  field: StreamKeyField,
): boolean {
  if (field === 'invocation.command') {
    return (
      JSON.stringify(a.invocation.command) ===
      JSON.stringify(b.invocation.command)
    )
  }
  if (field === 'invocation.selector') {
    return (
      JSON.stringify(a.invocation.selector) ===
      JSON.stringify(b.invocation.selector)
    )
  }
  return streamKeyFieldValue(a, field) === streamKeyFieldValue(b, field)
}

/**
 * Near-miss disclosure (§5.4): given `candidates` (complete stored runs
 * excluding the current run, oldest-first insertion order), select the
 * candidate with the fewest mismatching stream-key components. Ties break
 * on recency = latest store insertion order (last element wins). Returns
 * undefined when there are no candidates. Deterministic: no timestamps.
 */
export function nearMissDisclosure(
  current: StreamKeyView,
  candidates: readonly { runId: string; record: StreamKeyView }[],
): NearMiss | undefined {
  let best: { runId: string; mismatches: NearMissMismatch[] } | undefined
  for (const { runId, record } of candidates) {
    const mismatches: NearMissMismatch[] = []
    for (const field of STREAM_KEY_FIELDS) {
      if (!streamKeyFieldEqual(record, current, field)) {
        mismatches.push({
          field,
          recorded: streamKeyFieldValue(record, field),
          current: streamKeyFieldValue(current, field),
        })
      }
    }
    if (best === undefined || mismatches.length <= best.mismatches.length) {
      best = { runId, mismatches }
    }
  }
  if (best === undefined) return undefined
  return { run_id: best.runId, mismatches: best.mismatches }
}

function sameInstrument(a: RunRecord, b: RunRecord): boolean {
  return (
    a.instrument.adapter === b.instrument.adapter &&
    a.instrument.adapter_version === b.instrument.adapter_version &&
    a.instrument.composition_id === b.instrument.composition_id &&
    a.instrument.config_digest === b.instrument.config_digest
  )
}

function sameSelector(a: RunRecord, b: RunRecord): boolean {
  return (
    JSON.stringify(a.invocation.selector) ===
    JSON.stringify(b.invocation.selector)
  )
}

function sameStreamScope(a: RunRecord, b: RunRecord): boolean {
  return (
    a.repo.identity === b.repo.identity &&
    a.repo.worktree === b.repo.worktree &&
    a.repo.branch === b.repo.branch &&
    a.repo.cwd === b.repo.cwd &&
    JSON.stringify(a.invocation.command) ===
      JSON.stringify(b.invocation.command)
  )
}

export interface BaselineResolution {
  record: RunRecord | null
  runId: string | null
  mode: BaselineMode
  selectionReason: string
  failure?: ComparabilityDetail
  /** Set (>=2) only when `previous-superset` selection had more than one maximal candidate. */
  supersetCandidates?: number
}

/**
 * §5.2 `previous-superset` tie-break (normative): among tied maximal
 * candidates, `pos` (store insertion order — higher is more recent) wins.
 * A true `pos` tie is only reachable synthetically (the append-only,
 * de-duplicated index makes `pos` a total order in practice); ties break on
 * the lexicographically-larger `run_id`. Returns `null` for an empty list.
 */
export function latestMaximal(
  entries: readonly { runId: string; pos: number }[],
): string | null {
  let best: { runId: string; pos: number } | undefined
  for (const e of entries) {
    if (
      best === undefined ||
      e.pos > best.pos ||
      (e.pos === best.pos && e.runId > best.runId)
    ) {
      best = e
    }
  }
  return best?.runId ?? null
}

/**
 * Resolve the baseline per §5.2. Selection is content-addressed and
 * explainable; recency is index insertion order, never timestamps (§7.8).
 */
export function resolveBaseline(
  store: RunStore,
  current: RunRecord,
  currentId: string,
  spec: BaselineSpec,
): BaselineResolution {
  switch (spec.mode) {
    case 'explicit-run-id': {
      const resolved = store.resolveRunId(spec.runId)
      if (resolved === null) {
        throw new CompareOperationError(`unknown run id: ${spec.runId}`)
      }
      return {
        record: store.readRun(resolved),
        runId: resolved,
        mode: 'explicit-run-id',
        selectionReason: 'caller-specified-run-id',
      }
    }
    case 'previous-comparable': {
      const ids = store.listRunIds()
      const key = streamKey(current)
      const candidates: { runId: string; record: RunMeta }[] = []
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]!
        if (id === currentId) continue
        // Cheap pre-filter: shallow field validation only (RunMeta), no
        // observations/finding/recording parsing (§9.4 strict validation is
        // deferred to the single selected candidate below).
        const meta = store.readRunMeta(id)
        if (meta.completeness.status !== 'complete') continue
        candidates.push({ runId: id, record: meta })
        if (streamKey(meta) !== key) continue
        // Selected baseline: strict-parse now. Corruption of the chosen
        // record still surfaces as StoreCorruptError (fail-closed, §6.3);
        // non-candidate corruption above (readRunMeta) does too.
        const record = store.readRun(id)
        return {
          record,
          runId: id,
          mode: 'previous-comparable',
          selectionReason: 'same-worktree-command-config-scope',
        }
      }
      candidates.reverse()
      const nm = nearMissDisclosure(current, candidates)
      return {
        record: null,
        runId: null,
        mode: 'previous-comparable',
        selectionReason: 'no-complete-run-in-stream',
        failure: {
          reason: 'baseline-missing',
          kind: 'determined',
          ...(nm !== undefined ? { near_miss: nm } : {}),
        },
      }
    }
    case 'git-ref': {
      const ids = store.listRunIds()
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]!
        // Same pre-filter/strict-parse split as previous-comparable above.
        const meta = store.readRunMeta(id)
        if (meta.completeness.status !== 'complete') continue
        if (meta.provenance.head !== spec.commit) continue
        if (meta.provenance.tree_digest !== spec.tree) continue
        const record = store.readRun(id)
        return {
          record,
          runId: id,
          mode: 'git-ref',
          selectionReason: `complete-run-recorded-at-${spec.ref}`,
        }
      }
      return {
        record: null,
        runId: null,
        mode: 'git-ref',
        selectionReason: `no-complete-run-recorded-at-${spec.ref}`,
        failure: { reason: 'baseline-missing', kind: 'determined' },
      }
    }
    case 'previous-superset': {
      // 1. Series-mates: same series (streamKey minus selector), complete,
      // excluding current. Pre-filter only (RunMeta) — same discipline as
      // previous-comparable/git-ref above.
      const key = seriesKey(current)
      const ids = store.listRunIds()
      const seriesMates: { runId: string; pos: number; meta: RunMeta }[] = []
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!
        if (id === currentId) continue
        const meta = store.readRunMeta(id)
        if (meta.completeness.status !== 'complete') continue
        if (seriesKey(meta) !== key) continue
        seriesMates.push({ runId: id, pos: i, meta })
      }

      // 2. Gating (fail-closed, mirrors judgeSelectorMismatch): an
      // undeclared adapter method, an un-declaring/perturbed current record,
      // demotes every series-mate's relation to 'unknown'.
      const adapter = findAdapter(current.instrument.adapter)
      const relationFn = adapter?.selectorRelation
      const perturbedFn = adapter?.commandScopePerturbed
      const currentGatingOk =
        relationFn !== undefined &&
        perturbedFn !== undefined &&
        current.instrument.capabilities?.['selector-relation'] === 'pass' &&
        !perturbedFn(current.invocation.command)

      // 3. Candidacy: only a proven `superset` (candidate ⊇ current)
      // counts. `equal` is previous-comparable's territory, not a
      // candidate here; `subset`/`disjoint` are decided non-candidates;
      // `unknown` (including per-mate gating failure) never fabricates a
      // candidate but also never forecloses one already proven.
      const candidates: { runId: string; pos: number; meta: RunMeta }[] = []
      let anyUnknown = false
      for (const mate of seriesMates) {
        const decided =
          currentGatingOk &&
          mate.meta.instrument.capabilities?.['selector-relation'] === 'pass'
        const rel = decided
          ? relationFn!(
              mate.meta.invocation.selector,
              current.invocation.selector,
            )
          : 'unknown'
        if (rel === 'superset') {
          candidates.push(mate)
        } else if (rel === 'unknown') {
          anyUnknown = true
        }
        // 'equal' / 'subset' / 'disjoint': decided non-candidate, no-op.
      }

      if (candidates.length === 0) {
        // §5.4: previous-superset never emits near_miss — a weak match is
        // never a fallback baseline (§5.3).
        return {
          record: null,
          runId: null,
          mode: 'previous-superset',
          selectionReason: anyUnknown
            ? 'superset-candidacy-undetermined'
            : 'no-proven-superset-in-series',
          failure: {
            reason: anyUnknown
              ? 'selector-relation-unknown'
              : 'baseline-missing',
            kind: 'determined',
          },
        }
      }

      // 4. Maximality (proven-containment partial order, §5.2): a candidate
      // is maximal unless another candidate proves a strict superset over
      // it. Equal-selector candidates only prove `equal` against each
      // other, never `superset`, so neither demotes the other — no
      // equal-class dedupe (spec §5.2 normative MUST on disclosure).
      const maximal = candidates.filter(
        (x) =>
          !candidates.some(
            (y) =>
              y.runId !== x.runId &&
              relationFn!(
                y.meta.invocation.selector,
                x.meta.invocation.selector,
              ) === 'superset',
          ),
      )

      // 5. Winner: most recent maximal candidate (tie-break: run_id desc).
      const winnerId = latestMaximal(maximal)!
      // Strict-parse only the winner (§9.4 deferred to the selected
      // candidate, same discipline as previous-comparable/git-ref).
      const record = store.readRun(winnerId)
      return {
        record,
        runId: winnerId,
        mode: 'previous-superset',
        selectionReason: 'most-recent-maximal-proven-superset',
        ...(maximal.length >= 2 ? { supersetCandidates: maximal.length } : {}),
      }
    }
  }
}

interface Judged {
  comparability: Comparability
  detail?: ComparabilityDetail
  events: SurfaceEvent[]
  outOfScope?: string[]
}

function judgeComparability(
  baseline: RunRecord | null,
  current: RunRecord,
): Judged {
  if (baseline === null) {
    return { comparability: 'none', events: [] }
  }
  if (!sameInstrument(baseline, current)) {
    const events: SurfaceEvent[] = [
      {
        kind: 'runner-config-changed',
        from: baseline.instrument.config_digest,
        to: current.instrument.config_digest,
      },
    ]
    // §12-6 (confirmed): this trigger condition is unchanged by Step 2 and
    // stays exactly `adapter` / `adapter_version` / `composition_id` diffing —
    // no per-capability diff event is added alongside it. `capabilities` is a
    // function of that same triple (adapter, adapter_version, composition_id);
    // a record whose declaration differs while all three hold constant is a
    // declaration bug, not a real capability change to surface. Adding a
    // second, per-capability trigger would only compound the double-meaning
    // this event kind already carries (§12-6), not resolve it.
    if (
      baseline.instrument.adapter !== current.instrument.adapter ||
      baseline.instrument.adapter_version !==
        current.instrument.adapter_version ||
      baseline.instrument.composition_id !== current.instrument.composition_id
    ) {
      events.push({
        kind: 'adapter-capability-changed',
        from: `${baseline.instrument.adapter}@${baseline.instrument.adapter_version}/${baseline.instrument.composition_id}`,
        to: `${current.instrument.adapter}@${current.instrument.adapter_version}/${current.instrument.composition_id}`,
      })
    }
    events.push(...configSourceEvents(baseline, current))
    return {
      comparability: 'none',
      detail: { reason: 'instrument-changed', kind: 'determined' },
      events,
    }
  }
  if (!sameSelector(baseline, current)) {
    const result = judgeSelectorMismatch(baseline, current)
    // `undefined` means the adapter proved the two selectors extensionally
    // `equal` (e.g. duplicate/case-variant tokens): fall through to the
    // ordinary exact/scope_changed/partial judgment below rather than
    // abstaining.
    if (result !== undefined) return result
  }
  if (!sameStreamScope(baseline, current)) {
    return {
      comparability: 'none',
      detail: { reason: 'stream-mismatch', kind: 'determined' },
      events: [],
    }
  }
  if (
    baseline.completeness.status !== 'complete' ||
    current.completeness.status !== 'complete'
  ) {
    return { comparability: 'partial', events: [] }
  }
  const bInventory = baseline.observations.map((o) => o.test_id).join('\n')
  const cInventory = current.observations.map((o) => o.test_id).join('\n')
  return {
    comparability: bInventory === cInventory ? 'exact' : 'scope_changed',
    events: [],
  }
}

/** The pre-existing selector-mismatch abstention (§6.4): unproven never means contained. */
function selectorUnknownAbstention(
  baseline: RunRecord,
  current: RunRecord,
): Judged {
  return {
    comparability: 'none',
    detail: { reason: 'selector-relation-unknown', kind: 'determined' },
    events: [
      {
        kind: 'selector-changed',
        from: baseline.invocation.selector.join(' '),
        to: current.invocation.selector.join(' '),
      },
    ],
  }
}

/**
 * §6.1/§6.4: baseline and current selectors differ (`sameSelector` already
 * failed). Asks the record's own declared adapter to prove a `subset`
 * narrowing; every unproven step falls back to the `selector-relation-
 * unknown` abstention (fail-closed). Returns `undefined` only when the
 * adapter proves the two selectors extensionally `equal` — the caller then
 * falls through to the ordinary exact/scope_changed/partial judgment,
 * since there is no real selector divergence to abstain over.
 */
function judgeSelectorMismatch(
  baseline: RunRecord,
  current: RunRecord,
): Judged | undefined {
  // Series identity first (issue decision 5): a stream that also diverges on
  // repo/worktree/branch/cwd/command is not a narrowing question at all.
  if (!sameStreamScope(baseline, current)) {
    return selectorUnknownAbstention(baseline, current)
  }

  const adapter = findAdapter(current.instrument.adapter)
  const relationFn = adapter?.selectorRelation
  const matchesFn = adapter?.selectorMatches
  const perturbedFn = adapter?.commandScopePerturbed
  if (
    relationFn === undefined ||
    matchesFn === undefined ||
    perturbedFn === undefined ||
    baseline.instrument.capabilities?.['selector-relation'] !== 'pass' ||
    current.instrument.capabilities?.['selector-relation'] !== 'pass'
  ) {
    // Undeclared adapter method, or either record predates the
    // `selector-relation` capability declaration: fail-closed.
    return selectorUnknownAbstention(baseline, current)
  }

  if (perturbedFn(current.invocation.command)) {
    // sameStreamScope already holds, so baseline's command is identical:
    // checking current's command covers both (§6.4, monotonicity reasoning
    // explicitly disallowed).
    return selectorUnknownAbstention(baseline, current)
  }

  const rel = relationFn(
    current.invocation.selector,
    baseline.invocation.selector,
  )
  if (rel === 'equal') return undefined
  if (rel !== 'subset') {
    // superset / disjoint / unknown: none of these license a claim here.
    // `disjoint` is folded into the same abstention as `unknown` per the
    // adapter's own doc comment (substring interpretation does not prove
    // non-overlap).
    return selectorUnknownAbstention(baseline, current)
  }

  if (
    baseline.completeness.status !== 'complete' ||
    current.completeness.status !== 'complete'
  ) {
    // An incomplete run's missing observations are indistinguishable from
    // bail-induced gaps: the removed/out_of_scope partition would be
    // unsound.
    return selectorUnknownAbstention(baseline, current)
  }

  const currentIds = new Set(current.observations.map((o) => o.test_id))
  const outOfScope: string[] = []
  for (const obs of baseline.observations) {
    if (currentIds.has(obs.test_id)) continue
    const match = matchesFn(current.invocation.selector, obs.test_id)
    if (match === 'unknown') {
      // Per-id guessing is forbidden: one undecidable id downgrades the
      // whole comparison.
      return selectorUnknownAbstention(baseline, current)
    }
    if (match === 'no') outOfScope.push(obs.test_id)
    // 'yes': still in scope but unobserved — left for the normal
    // test-removed/removed handling in claimsReport.
  }

  return {
    comparability: 'subset',
    events: [
      {
        kind: 'selector-subset',
        from: baseline.invocation.selector.join(' '),
        to: current.invocation.selector.join(' '),
        capability: 'selector-relation',
      },
    ],
    outOfScope,
  }
}

function configSourceEvents(
  baseline: RunRecord,
  current: RunRecord,
): SurfaceEvent[] {
  const events: SurfaceEvent[] = []
  const paths = new Set([
    ...Object.keys(baseline.surface.config_sources),
    ...Object.keys(current.surface.config_sources),
  ])
  for (const path of [...paths].sort()) {
    if (
      baseline.surface.config_sources[path] !==
      current.surface.config_sources[path]
    ) {
      events.push({ kind: 'config-source-changed', path })
    }
  }
  return events
}

function emptyTransitions(): Transitions {
  return {
    new_fail: [],
    still_fail_unchanged: [],
    updated_fail: [],
    repaired_same_surface: [],
    repaired_with_test_change: [],
    fail_to_skip: [],
    fail_to_xfail: [],
    removed: [],
    not_observed: [],
  }
}

function coverage(record: RunRecord): string {
  const declared = record.observations.length
  const observed = record.observations.filter(
    (o) => o.verdict !== 'not_run',
  ).length
  return `${observed}/${declared}`
}

function redIds(record: RunRecord): string[] {
  return record.observations
    .filter((o) => isRed(o.verdict))
    .map((o) => o.test_id)
}

function shortId(runId: string): string {
  return runId.slice(0, 12)
}

/**
 * The evidence-quality disclosure a report carries (§9.1): the composition the
 * *recorded* run's adapter declares, and the evidence capabilities that
 * composition declares `unsupported`. Both are read straight off the record's
 * own `instrument` fields (§4.2 Step 2) — never through an adapter registry
 * lookup. The record carries its own declaration, so the Step 1 interim
 * question "what does this build know about the record's adapter?" (§12-5) is
 * gone structurally: there is no adapter to resolve, and no notion of a record
 * this build "does not know" to fall back for.
 *
 * `composition_id` is always the record's own value. `degraded_capabilities`
 * is the intersection of {@link EVIDENCE_CAPABILITY_NAMES} with the names
 * whose declared value is `unsupported`, sorted (§4.2 derivation rule).
 * Records written before `instrument.capabilities` existed have no
 * declaration at all: rather than guess, the disclosure is an empty list —
 * the same "empty list otherwise" posture as §9.1, extended so that vdelta
 * never speaks on behalf of a composition that never declared anything.
 */
function evidenceDisclosure(record: RunRecord): {
  composition_id: string
  degraded_capabilities: string[]
} {
  const caps = record.instrument.capabilities
  const degraded =
    caps === undefined
      ? []
      : EVIDENCE_CAPABILITY_NAMES.filter(
          (name) => caps[name] === 'unsupported',
        ).sort()
  return {
    composition_id: record.instrument.composition_id,
    degraded_capabilities: degraded,
  }
}

function showAnchor(runId: string, testId: string): string {
  return `vdelta show ${shortId(runId)} --test '${testId}'`
}

/**
 * Build the full comparison report for a current run against a baseline spec.
 * Store-level corruption during baseline resolution degrades to a
 * `store-corrupt`/`failed` abstention (fail-closed comparison, §6.3) — the
 * report is still produced.
 */
export function buildComparisonReport(
  store: RunStore,
  currentId: string,
  spec: BaselineSpec,
): ComparisonReport {
  const current = store.readRun(currentId)

  let resolution: BaselineResolution
  try {
    resolution = resolveBaseline(store, current, currentId, spec)
  } catch (err) {
    if (err instanceof StoreCorruptError) {
      return abstentionReport(
        current,
        currentId,
        { reason: 'store-corrupt', kind: 'failed' },
        [],
      )
    }
    throw err
  }

  const baseline = resolution.record
  const judged = judgeComparability(baseline, current)

  if (judged.comparability === 'none') {
    const detail = judged.detail ??
      resolution.failure ?? {
        reason: 'baseline-missing' as NoneReason,
        kind: 'determined' as const,
      }
    return abstentionReport(
      current,
      currentId,
      detail,
      judged.events,
      baseline,
      resolution,
    )
  }

  return claimsReport(
    baseline!,
    resolution,
    current,
    currentId,
    judged.comparability,
    judged.events,
    judged.outOfScope ?? [],
  )
}

/** comparability `none`: structured current-run results only (contract §5.7, finding F-1). */
function abstentionReport(
  current: RunRecord,
  currentId: string,
  detail: ComparabilityDetail,
  events: SurfaceEvent[],
  baseline?: RunRecord | null,
  resolution?: BaselineResolution,
): ComparisonReport {
  const red = redIds(current)
  const anchors: Record<string, string> = {}
  for (const id of red) anchors[`red:${id}`] = showAnchor(currentId, id)
  anchors.raw = `vdelta show ${shortId(currentId)} --raw`

  const report: ComparisonReport = {
    schema_version: SCHEMA_VERSION,
    outcome_verdict: 'inconclusive',
    comparability: 'none',
    comparability_detail: detail,
    baseline:
      baseline && resolution && resolution.runId !== null
        ? {
            run_id: resolution.runId,
            mode: resolution.mode,
            selection_reason: resolution.selectionReason,
            ...(resolution.supersetCandidates !== undefined
              ? { superset_candidates: resolution.supersetCandidates }
              : {}),
          }
        : null,
    current: {
      run_id: currentId,
      complete: current.completeness.status === 'complete',
      child_exit_code: current.completeness.child_exit_code,
      red,
      ...(current.completeness.status !== 'complete'
        ? { completeness_status: current.completeness.status }
        : {}),
    },
    observation_coverage: { current: coverage(current) },
    // Abstention discloses the *current* run's evidence quality: it is the
    // only run this report makes any claim about.
    failure_evidence: evidenceDisclosure(current),
    trust: { record_integrity: 'advisory' },
    anchors,
  }
  if (events.length > 0) {
    report.verification_surface = {
      status: 'changed',
      events: sortEvents(events),
    }
  }
  return report
}

function sortEvents(events: SurfaceEvent[]): SurfaceEvent[] {
  return [...events].sort((a, b) => {
    const ka = `${a.kind}\n${a.test_id ?? ''}\n${a.path ?? ''}`
    const kb = `${b.kind}\n${b.test_id ?? ''}\n${b.path ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

function claimsReport(
  baseline: RunRecord,
  resolution: BaselineResolution,
  current: RunRecord,
  currentId: string,
  comparability: Comparability,
  extraEvents: SurfaceEvent[],
  outOfScope: string[],
): ComparisonReport {
  const partial = comparability === 'partial'
  // Reaching a claims report means `sameInstrument` held (§6.2), so baseline
  // and current name the same adapter: one disclosure describes both, and
  // every claim below carries it.
  const evidence = evidenceDisclosure(current)
  const bByid = new Map(baseline.observations.map((o) => [o.test_id, o]))
  const cById = new Map(current.observations.map((o) => [o.test_id, o]))
  const allIds = [...new Set([...bByid.keys(), ...cById.keys()])].sort()
  const outOfScopeSet = new Set(outOfScope)

  const transitions = emptyTransitions()
  const events: SurfaceEvent[] = [...extraEvents]
  const contextChanged = new Set<string>()
  const retryEvidence =
    current.instrument.capabilities?.['retry-evidence'] === 'pass'
  const verificationInconclusive: string[] = []

  const testSourceChanged = (rel: string): boolean =>
    baseline.surface.test_sources[rel] !== current.surface.test_sources[rel]
  const anyConfigChanged = configSourceEvents(baseline, current).length > 0

  for (const id of allIds) {
    const b = bByid.get(id)
    const c = cById.get(id)

    if (b && !c) {
      if (outOfScopeSet.has(id)) {
        // Excluded by the narrower selector, not removed from the
        // codebase (§6.1): never a test-removed event, never `removed`.
        // Only a red out_of_scope id is disclosed at all; green ones are
        // never claimed anywhere.
        if (!partial && isRed(b.verdict)) {
          if (transitions.out_of_scope === undefined) {
            transitions.out_of_scope = []
          }
          transitions.out_of_scope.push(id)
        }
        continue
      }
      events.push({ kind: 'test-removed', test_id: id })
      if (!partial && isRed(b.verdict)) transitions.removed.push(id)
      continue
    }
    if (!b && c) {
      events.push({ kind: 'test-added', test_id: id })
      if (isRed(c.verdict)) transitions.new_fail.push(id)
      continue
    }
    if (!b || !c) continue

    const bRed = isRed(b.verdict)
    const cRed = isRed(c.verdict)

    if (cRed && !bRed) {
      transitions.new_fail.push(id)
    } else if (cRed && bRed) {
      const bDigest = b.finding?.evidence_digest
      const cDigest = c.finding?.evidence_digest
      if (bDigest === cDigest) {
        if (!partial) {
          const entry: StillFailEntry = {
            test_id: id,
            degraded_capabilities: [...evidence.degraded_capabilities],
          }
          if (
            b.finding !== undefined &&
            c.finding !== undefined &&
            b.finding.context_digest !== c.finding.context_digest
          ) {
            entry.context_changed = true
            contextChanged.add(id)
          }
          transitions.still_fail_unchanged.push(entry)
        }
        // Under partial, a red-in-both same-evidence test cannot be claimed
        // unchanged (§6.1); it is disclosed via current.red (contract §5.7).
      } else {
        const entry: UpdatedFailEntry = {
          test_id: id,
          evidence_digest_before: bDigest ?? '',
          evidence_digest_after: cDigest ?? '',
          failure_mode_changed:
            b.finding?.structural_fingerprint !==
            c.finding?.structural_fingerprint,
          degraded_capabilities: [...evidence.degraded_capabilities],
        }
        transitions.updated_fail.push(entry)
      }
    } else if (bRed && !cRed) {
      if (c.verdict === 'skip') {
        events.push({ kind: 'fail-to-skip', test_id: id })
        if (!partial) transitions.fail_to_skip.push(id)
      } else if (c.verdict === 'xfail') {
        events.push({ kind: 'fail-to-xfail', test_id: id })
        if (!partial) transitions.fail_to_xfail.push(id)
      } else if (c.verdict === 'not_run') {
        transitions.not_observed.push(id)
      } else if (c.verdict === 'pass' || c.verdict === 'xpass') {
        if (!partial) {
          if (retryEvidence && c.finding !== undefined) {
            verificationInconclusive.push(id)
          } else {
            const rel = relOf(id)
            if (!testSourceChanged(rel) && !anyConfigChanged) {
              transitions.repaired_same_surface.push(id)
            } else {
              transitions.repaired_with_test_change.push(id)
            }
          }
        }
      }
    }
  }

  // Source/config drift events (observed facts on every comparability level).
  const changedModules = new Set(
    [...new Set([...allIds.map(relOf)])].filter((rel) =>
      testSourceChanged(rel),
    ),
  )
  for (const id of allIds) {
    if (!bByid.has(id) || !cById.has(id)) continue
    if (changedModules.has(relOf(id))) {
      events.push({ kind: 'test-source-changed', test_id: id })
    }
  }
  events.push(...configSourceEvents(baseline, current))

  if (verificationInconclusive.length > 0) {
    transitions.verification_inconclusive = verificationInconclusive
  }

  const lostObservation =
    transitions.not_observed.length > 0 ||
    (partial && hasLostObservation(baseline, current))
  const reduced =
    transitions.fail_to_skip.length > 0 ||
    transitions.fail_to_xfail.length > 0 ||
    events.some(
      (e) =>
        e.kind === 'test-removed' ||
        e.kind === 'fail-to-skip' ||
        e.kind === 'fail-to-xfail',
    ) ||
    lostObservation
  const status: SurfaceStatus = reduced
    ? 'reduced'
    : events.length > 0
      ? 'changed'
      : 'intact'

  const outcome = deriveOutcome(transitions, partial)

  const anchors: Record<string, string> = {}
  for (const id of transitions.new_fail)
    anchors[`new_fail:${id}`] = showAnchor(currentId, id)
  for (const e of transitions.still_fail_unchanged) {
    const id = typeof e === 'string' ? e : e.test_id
    anchors[`still_fail_unchanged:${id}`] = showAnchor(currentId, id)
  }
  for (const e of transitions.updated_fail) {
    anchors[`updated_fail:${e.test_id}`] = showAnchor(currentId, e.test_id)
  }
  for (const id of verificationInconclusive) {
    anchors[`verification_inconclusive:${id}`] = showAnchor(currentId, id)
  }
  // Evidence for an out_of_scope id lives in the baseline run — it was
  // never observed by current, so `showAnchor(currentId, ...)` would point
  // nowhere.
  for (const id of transitions.out_of_scope ?? []) {
    anchors[`out_of_scope:${id}`] = showAnchor(resolution.runId!, id)
  }
  const currentRed = partial ? redIds(current) : undefined
  if (currentRed) {
    for (const id of currentRed)
      anchors[`red:${id}`] = showAnchor(currentId, id)
  }
  anchors.raw = `vdelta show ${shortId(currentId)} --raw`

  sortTransitions(transitions)

  return {
    schema_version: SCHEMA_VERSION,
    outcome_verdict: outcome,
    comparability,
    baseline: {
      run_id: resolution.runId!,
      mode: resolution.mode,
      selection_reason: resolution.selectionReason,
      ...(resolution.supersetCandidates !== undefined
        ? { superset_candidates: resolution.supersetCandidates }
        : {}),
    },
    current: {
      run_id: currentId,
      complete: current.completeness.status === 'complete',
      child_exit_code: current.completeness.child_exit_code,
      ...(currentRed ? { red: currentRed } : {}),
      ...(current.completeness.status !== 'complete'
        ? { completeness_status: current.completeness.status }
        : {}),
    },
    observation_coverage: {
      baseline: coverage(baseline),
      current: coverage(current),
    },
    verification_surface: { status, events: sortEvents(events) },
    transitions,
    failure_evidence: evidence,
    trust: { record_integrity: 'advisory' },
    anchors,
  }
}

function hasLostObservation(baseline: RunRecord, current: RunRecord): boolean {
  const observedNow = new Set(
    current.observations
      .filter((o) => o.verdict !== 'not_run')
      .map((o) => o.test_id),
  )
  return baseline.observations.some(
    (o) => o.verdict !== 'not_run' && !observedNow.has(o.test_id),
  )
}

function relOf(testId: string): string {
  const sep = testId.indexOf('::')
  return sep === -1 ? testId : testId.slice(0, sep)
}

function deriveOutcome(
  t: Transitions,
  partial: boolean,
): ComparisonReport['outcome_verdict'] {
  if (t.new_fail.length > 0 || t.updated_fail.length > 0) return 'regressed'
  if ((t.verification_inconclusive?.length ?? 0) > 0) return 'inconclusive'
  if (partial) return 'inconclusive'
  if (
    t.repaired_same_surface.length > 0 ||
    t.repaired_with_test_change.length > 0
  ) {
    return 'improved'
  }
  return 'unchanged'
}

function sortTransitions(t: Transitions): void {
  t.new_fail.sort()
  t.repaired_same_surface.sort()
  t.repaired_with_test_change.sort()
  t.fail_to_skip.sort()
  t.fail_to_xfail.sort()
  t.removed.sort()
  t.not_observed.sort()
  t.out_of_scope?.sort()
  t.still_fail_unchanged.sort((a, b) => {
    const ka = typeof a === 'string' ? a : a.test_id
    const kb = typeof b === 'string' ? b : b.test_id
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  t.updated_fail.sort((a, b) =>
    a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0,
  )
  t.verification_inconclusive?.sort()
}
