/**
 * Comparator (spec §5–§9): baseline selection, comparability judgment,
 * the three delta axes, and comparison-report construction. Deterministic:
 * no timestamps, stable sort orders, recency = store insertion order.
 */
import { DEGRADED_CAPABILITIES, COMPOSITION_ID } from './adapters/vitest/recorder.js'
import { RunStore, StoreCorruptError } from './store.js'
import {
  SCHEMA_VERSION,
  isRed,
  type BaselineMode,
  type Comparability,
  type ComparabilityDetail,
  type ComparisonReport,
  type NoneReason,
  type RunRecord,
  type StillFailEntry,
  type SurfaceEvent,
  type SurfaceStatus,
  type Transitions,
  type UpdatedFailEntry,
} from './schema.js'

export type BaselineSpec =
  | { mode: 'previous-comparable' }
  | { mode: 'explicit-run-id'; runId: string }
  | { mode: 'git-ref'; ref: string; commit: string; tree: string }

export class CompareOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompareOperationError'
  }
}

/** Stream key (§5.1): repo + worktree + branch + cwd + command + selector + instrument. */
export function streamKey(r: RunRecord): string {
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

function sameInstrument(a: RunRecord, b: RunRecord): boolean {
  return (
    a.instrument.adapter === b.instrument.adapter &&
    a.instrument.adapter_version === b.instrument.adapter_version &&
    a.instrument.composition_id === b.instrument.composition_id &&
    a.instrument.config_digest === b.instrument.config_digest
  )
}

function sameSelector(a: RunRecord, b: RunRecord): boolean {
  return JSON.stringify(a.invocation.selector) === JSON.stringify(b.invocation.selector)
}

function sameStreamScope(a: RunRecord, b: RunRecord): boolean {
  return (
    a.repo.identity === b.repo.identity &&
    a.repo.worktree === b.repo.worktree &&
    a.repo.branch === b.repo.branch &&
    a.repo.cwd === b.repo.cwd &&
    JSON.stringify(a.invocation.command) === JSON.stringify(b.invocation.command)
  )
}

export interface BaselineResolution {
  record: RunRecord | null
  runId: string | null
  mode: BaselineMode
  selectionReason: string
  failure?: ComparabilityDetail
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
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]!
        if (id === currentId) continue
        const record = store.readRun(id)
        if (record.completeness.status !== 'complete') continue
        if (streamKey(record) !== key) continue
        return {
          record,
          runId: id,
          mode: 'previous-comparable',
          selectionReason: 'same-worktree-command-config-scope',
        }
      }
      return {
        record: null,
        runId: null,
        mode: 'previous-comparable',
        selectionReason: 'no-complete-run-in-stream',
        failure: { reason: 'baseline-missing', kind: 'determined' },
      }
    }
    case 'git-ref': {
      const ids = store.listRunIds()
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]!
        const record = store.readRun(id)
        if (record.completeness.status !== 'complete') continue
        if (record.provenance.head !== spec.commit) continue
        if (record.provenance.tree_digest !== spec.tree) continue
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
  }
}

interface Judged {
  comparability: Comparability
  detail?: ComparabilityDetail
  events: SurfaceEvent[]
}

function judgeComparability(baseline: RunRecord | null, current: RunRecord): Judged {
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
    if (
      baseline.instrument.adapter !== current.instrument.adapter ||
      baseline.instrument.adapter_version !== current.instrument.adapter_version ||
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
    // No selector-relation capability in the MVP adapter: containment is
    // unproven, and unproven never means contained (§6.4).
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
  return { comparability: bInventory === cInventory ? 'exact' : 'scope_changed', events: [] }
}

function configSourceEvents(baseline: RunRecord, current: RunRecord): SurfaceEvent[] {
  const events: SurfaceEvent[] = []
  const paths = new Set([
    ...Object.keys(baseline.surface.config_sources),
    ...Object.keys(current.surface.config_sources),
  ])
  for (const path of [...paths].sort()) {
    if (baseline.surface.config_sources[path] !== current.surface.config_sources[path]) {
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
  const observed = record.observations.filter((o) => o.verdict !== 'not_run').length
  return `${observed}/${declared}`
}

function redIds(record: RunRecord): string[] {
  return record.observations.filter((o) => isRed(o.verdict)).map((o) => o.test_id)
}

function shortId(runId: string): string {
  return runId.slice(0, 12)
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
      return abstentionReport(current, currentId, { reason: 'store-corrupt', kind: 'failed' }, [])
    }
    throw err
  }

  const baseline = resolution.record
  const judged = judgeComparability(baseline, current)

  if (judged.comparability === 'none') {
    const detail = judged.detail ?? resolution.failure ?? {
      reason: 'baseline-missing' as NoneReason,
      kind: 'determined' as const,
    }
    return abstentionReport(current, currentId, detail, judged.events, baseline, resolution)
  }

  return claimsReport(baseline!, resolution, current, currentId, judged.comparability)
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
          }
        : null,
    current: {
      run_id: currentId,
      complete: current.completeness.status === 'complete',
      child_exit_code: current.completeness.child_exit_code,
      red,
    },
    observation_coverage: { current: coverage(current) },
    failure_evidence: {
      composition_id: COMPOSITION_ID,
      degraded_capabilities: [...DEGRADED_CAPABILITIES],
    },
    trust: { record_integrity: 'advisory' },
    anchors,
  }
  if (events.length > 0) {
    report.verification_surface = { status: 'changed', events: sortEvents(events) }
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
): ComparisonReport {
  const partial = comparability === 'partial'
  const bByid = new Map(baseline.observations.map((o) => [o.test_id, o]))
  const cById = new Map(current.observations.map((o) => [o.test_id, o]))
  const allIds = [...new Set([...bByid.keys(), ...cById.keys()])].sort()

  const transitions = emptyTransitions()
  const events: SurfaceEvent[] = []
  const contextChanged = new Set<string>()

  const testSourceChanged = (rel: string): boolean =>
    baseline.surface.test_sources[rel] !== current.surface.test_sources[rel]
  const anyConfigChanged =
    configSourceEvents(baseline, current).length > 0

  for (const id of allIds) {
    const b = bByid.get(id)
    const c = cById.get(id)

    if (b && !c) {
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
            degraded_capabilities: [...DEGRADED_CAPABILITIES],
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
            b.finding?.structural_fingerprint !== c.finding?.structural_fingerprint,
          degraded_capabilities: [...DEGRADED_CAPABILITIES],
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

  // Source/config drift events (observed facts on every comparability level).
  const changedModules = new Set(
    [...new Set([...allIds.map(relOf)])].filter((rel) => testSourceChanged(rel)),
  )
  for (const id of allIds) {
    if (!bByid.has(id) || !cById.has(id)) continue
    if (changedModules.has(relOf(id))) {
      events.push({ kind: 'test-source-changed', test_id: id })
    }
  }
  events.push(...configSourceEvents(baseline, current))

  const lostObservation = transitions.not_observed.length > 0 || (partial && hasLostObservation(baseline, current))
  const reduced =
    transitions.fail_to_skip.length > 0 ||
    transitions.fail_to_xfail.length > 0 ||
    events.some((e) => e.kind === 'test-removed' || e.kind === 'fail-to-skip' || e.kind === 'fail-to-xfail') ||
    lostObservation
  const status: SurfaceStatus = reduced ? 'reduced' : events.length > 0 ? 'changed' : 'intact'

  const outcome = deriveOutcome(transitions, partial)

  const anchors: Record<string, string> = {}
  for (const id of transitions.new_fail) anchors[`new_fail:${id}`] = showAnchor(currentId, id)
  for (const e of transitions.still_fail_unchanged) {
    const id = typeof e === 'string' ? e : e.test_id
    anchors[`still_fail_unchanged:${id}`] = showAnchor(currentId, id)
  }
  for (const e of transitions.updated_fail) {
    anchors[`updated_fail:${e.test_id}`] = showAnchor(currentId, e.test_id)
  }
  const currentRed = partial ? redIds(current) : undefined
  if (currentRed) {
    for (const id of currentRed) anchors[`red:${id}`] = showAnchor(currentId, id)
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
    },
    current: {
      run_id: currentId,
      complete: current.completeness.status === 'complete',
      child_exit_code: current.completeness.child_exit_code,
      ...(currentRed ? { red: currentRed } : {}),
    },
    observation_coverage: {
      baseline: coverage(baseline),
      current: coverage(current),
    },
    verification_surface: { status, events: sortEvents(events) },
    transitions,
    failure_evidence: {
      composition_id: COMPOSITION_ID,
      degraded_capabilities: [...DEGRADED_CAPABILITIES],
    },
    trust: { record_integrity: 'advisory' },
    anchors,
  }
}

function hasLostObservation(baseline: RunRecord, current: RunRecord): boolean {
  const observedNow = new Set(
    current.observations.filter((o) => o.verdict !== 'not_run').map((o) => o.test_id),
  )
  return baseline.observations.some(
    (o) => o.verdict !== 'not_run' && !observedNow.has(o.test_id),
  )
}

function relOf(testId: string): string {
  const sep = testId.indexOf('::')
  return sep === -1 ? testId : testId.slice(0, sep)
}

function deriveOutcome(t: Transitions, partial: boolean): ComparisonReport['outcome_verdict'] {
  if (t.new_fail.length > 0 || t.updated_fail.length > 0) return 'regressed'
  if (partial) return 'inconclusive'
  if (t.repaired_same_surface.length > 0 || t.repaired_with_test_change.length > 0) {
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
  t.still_fail_unchanged.sort((a, b) => {
    const ka = typeof a === 'string' ? a : a.test_id
    const kb = typeof b === 'string' ? b : b.test_id
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  t.updated_fail.sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0))
}
