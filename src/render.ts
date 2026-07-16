/**
 * Human-readable rendering (§9.1): a secondary view of the report schema
 * with no independent logic. Deterministic, timestamp-free.
 */
import type { ComparisonReport } from './schema.js'

export function renderReport(report: ComparisonReport): string {
  const lines: string[] = []
  lines.push(`veridelta/1 ${report.outcome_verdict} (comparability: ${report.comparability})`)
  if (report.comparability_detail) {
    lines.push(
      `  reason: ${report.comparability_detail.reason} (${report.comparability_detail.kind})`,
    )
    const nm = report.comparability_detail.near_miss
    if (nm) {
      lines.push(`  near-miss: ${nm.run_id.slice(0, 12)}`)
      for (const m of nm.mismatches) {
        lines.push(`    ${m.field}: recorded="${m.recorded}" current="${m.current}"`)
      }
    }
  }
  if (report.baseline) {
    lines.push(`  baseline: ${report.baseline.run_id.slice(0, 12)} [${report.baseline.mode}]`)
  } else {
    lines.push('  baseline: none')
  }
  lines.push(
    `  current:  ${report.current.run_id.slice(0, 12)} exit=${report.current.child_exit_code} coverage=${report.observation_coverage.current}`,
  )
  if (report.current.red && report.current.red.length > 0) {
    lines.push(`  red now (${report.current.red.length}):`)
    for (const id of report.current.red) lines.push(`    ✗ ${id}`)
  }
  const t = report.transitions
  if (t) {
    const bucket = (label: string, items: readonly unknown[]): void => {
      if (items.length === 0) return
      lines.push(`  ${label} (${items.length}):`)
      for (const item of items) {
        const id =
          typeof item === 'string' ? item : (item as { test_id: string }).test_id
        lines.push(`    ${label === 'repaired' ? '✓' : '✗'} ${id}`)
      }
    }
    bucket('new_fail', t.new_fail)
    bucket('updated_fail', t.updated_fail)
    bucket('still_fail_unchanged', t.still_fail_unchanged)
    if (t.repaired_same_surface.length + t.repaired_with_test_change.length > 0) {
      lines.push(
        `  repaired: ${t.repaired_same_surface.length} same-surface, ${t.repaired_with_test_change.length} with-test-change`,
      )
    }
    bucket('fail_to_skip', t.fail_to_skip)
    bucket('fail_to_xfail', t.fail_to_xfail)
    bucket('removed', t.removed)
    bucket('not_observed', t.not_observed)
  }
  if (report.verification_surface) {
    lines.push(
      `  surface: ${report.verification_surface.status} (${report.verification_surface.events.length} events)`,
    )
  }
  if (report.gate) {
    lines.push(
      `  gate: ${report.gate.verdict} [${report.gate.policy}] triggered=${report.gate.triggered.join(',') || 'none'} staleness=${report.gate.staleness.match ? 'ok' : 'MISMATCH'}`,
    )
  }
  if (report.failure_evidence.degraded_capabilities.length > 0) {
    lines.push(
      `  degraded capabilities: ${report.failure_evidence.degraded_capabilities.join(', ')}`,
    )
  }
  lines.push(`  drill-down: ${report.anchors.raw ?? 'n/a'}`)
  return `${lines.join('\n')}\n`
}
