/**
 * Gate (spec §11), MVP scope: report-only policy. Record integrity (INV-10)
 * via content-address recomputation; staleness (INV-11) via exact
 * tree_digest equality with the judged workspace — binary equality, no
 * proximity rescue. Local-store verdicts are always advisory (§11.2).
 */

import {
  COMPOSITION_ID,
  DEGRADED_CAPABILITIES,
} from './adapters/vitest/recorder.js'
import { type BaselineSpec, buildComparisonReport } from './compare.js'
import {
  type ComparisonReport,
  type GateReport,
  type GateVerdict,
  SCHEMA_VERSION,
} from './schema.js'
import { type RunStore, StoreCorruptError } from './store.js'
import { gitHead, resolveRef, treeDigest } from './tree-digest.js'

export class GateOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateOperationError'
  }
}

export interface GateOptions {
  worktree: string
  ref: string
  runId?: string
}

export async function buildGateReport(
  store: RunStore,
  opts: GateOptions,
): Promise<ComparisonReport> {
  const resolved = await resolveRef(opts.worktree, opts.ref)
  if (resolved === null) {
    throw new GateOperationError(`cannot resolve ref: ${opts.ref}`)
  }

  const currentId =
    opts.runId !== undefined
      ? store.resolveRunId(opts.runId)
      : store.lastRunId()
  if (currentId === null) {
    throw new GateOperationError(
      opts.runId !== undefined
        ? `unknown run id: ${opts.runId}`
        : 'no recorded run to gate',
    )
  }

  const headSha = (await gitHead(opts.worktree)) ?? ''
  const targetTree = await treeDigest(opts.worktree)

  // INV-10: verify the consulted record's content address before judging.
  let integrityOk: boolean
  let runTree = ''
  try {
    integrityOk = store.verifyIntegrity(currentId)
    runTree = store.readRun(currentId).provenance.tree_digest
  } catch (err) {
    if (err instanceof StoreCorruptError) {
      integrityOk = false
    } else {
      throw err
    }
  }

  if (!integrityOk) {
    return integrityFailedReport(currentId, {
      headSha,
      baseSha: resolved.commit,
      runTree,
      targetTree,
    })
  }

  const spec: BaselineSpec = {
    mode: 'git-ref',
    ref: opts.ref,
    commit: resolved.commit,
    tree: resolved.tree,
  }
  const report = buildComparisonReport(store, currentId, spec)

  // INV-11: the judged target is the workspace tree, compared byte-exactly.
  const stalenessMatch = runTree === targetTree

  const triggered: string[] = []
  if (report.transitions !== undefined) {
    if (report.transitions.new_fail.length > 0) triggered.push('new_fail')
    if (report.transitions.updated_fail.length > 0)
      triggered.push('updated_fail')
  }
  if (report.verification_surface?.status === 'reduced') {
    triggered.push('verification_surface_reduced')
  }

  let verdict: GateVerdict
  if (!stalenessMatch) {
    verdict = 'inconclusive'
  } else if (
    report.comparability === 'none' ||
    report.comparability === 'partial'
  ) {
    verdict = 'inconclusive'
  } else if (triggered.length > 0) {
    verdict = 'fail'
  } else {
    verdict = 'pass'
  }

  const gate: GateReport = {
    policy: 'report-only',
    verdict,
    triggered,
    target: { kind: 'head', head_sha: headSha, base_sha: resolved.commit },
    staleness: {
      run_tree_digest: runTree,
      target_tree_digest: targetTree,
      match: stalenessMatch,
      unverified_submodules: [],
    },
    record_integrity: 'advisory',
  }
  return { ...report, gate }
}

function integrityFailedReport(
  currentId: string,
  ctx: {
    headSha: string
    baseSha: string
    runTree: string
    targetTree: string
  },
): ComparisonReport {
  // The record cannot be trusted: no red list, no transitions — only the
  // structural failure (§11.2). Reporting floor still discloses the anchor.
  return {
    schema_version: SCHEMA_VERSION,
    outcome_verdict: 'inconclusive',
    comparability: 'none',
    comparability_detail: { reason: 'record-integrity-failed', kind: 'failed' },
    baseline: null,
    current: {
      run_id: currentId,
      complete: false,
      child_exit_code: -1,
    },
    observation_coverage: { current: '0/0' },
    failure_evidence: {
      composition_id: COMPOSITION_ID,
      degraded_capabilities: [...DEGRADED_CAPABILITIES],
    },
    trust: { record_integrity: 'advisory' },
    anchors: { raw: `vdelta show ${currentId.slice(0, 12)} --raw` },
    gate: {
      policy: 'report-only',
      verdict: 'inconclusive',
      triggered: [],
      target: { kind: 'head', head_sha: ctx.headSha, base_sha: ctx.baseSha },
      staleness: {
        run_tree_digest: ctx.runTree,
        target_tree_digest: ctx.targetTree,
        match: ctx.runTree === ctx.targetTree,
        unverified_submodules: [],
      },
      record_integrity: 'advisory',
    },
  }
}
