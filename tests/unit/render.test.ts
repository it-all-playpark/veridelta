import { describe, expect, it } from 'vitest'
import { renderReport } from '../../src/index.js'
import type { ComparisonReport } from '../../src/schema.js'

const minimalNoneReport: ComparisonReport = {
  schema_version: 'veridelta/1',
  outcome_verdict: 'inconclusive',
  comparability: 'none',
  baseline: null,
  current: {
    run_id: `run_${'0'.repeat(64)}`,
    complete: true,
    child_exit_code: 1,
    red: [],
  },
  observation_coverage: { current: '1/1' },
  failure_evidence: {
    composition_id: 'vitest-native/1',
    degraded_capabilities: [],
  },
  trust: { record_integrity: 'advisory' },
  anchors: { raw: 'vdelta show x --raw' },
}

describe('renderReport near-miss (§9.1)', () => {
  it('prints reason, near-miss run id, and mismatch lines when near_miss is present', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      comparability_detail: {
        reason: 'baseline-missing',
        kind: 'determined',
        near_miss: {
          run_id: `run_abc${'0'.repeat(61)}`,
          mismatches: [
            {
              field: 'invocation.command',
              recorded: 'npx vitest run',
              current: 'vitest run',
            },
          ],
        },
      },
    }
    const out = renderReport(report)
    expect(out).toContain('  reason: baseline-missing (determined)')
    const nearMissLine = out
      .split('\n')
      .find((l) => l.startsWith('  near-miss: '))
    expect(nearMissLine).toBe(
      `  near-miss: ${`run_abc${'0'.repeat(61)}`.slice(0, 12)}`,
    )
    expect(out).toContain(
      '    invocation.command: recorded="npx vitest run" current="vitest run"',
    )
  })

  it('renders multiple mismatches in array order', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      comparability_detail: {
        reason: 'baseline-missing',
        kind: 'determined',
        near_miss: {
          run_id: `run_def${'0'.repeat(61)}`,
          mismatches: [
            {
              field: 'invocation.command',
              recorded: 'npx vitest run',
              current: 'vitest run',
            },
            { field: 'repo.branch', recorded: 'main', current: 'feature/x' },
          ],
        },
      },
    }
    const out = renderReport(report)
    const lines = out.split('\n')
    const commandIdx = lines.indexOf(
      '    invocation.command: recorded="npx vitest run" current="vitest run"',
    )
    const branchIdx = lines.indexOf(
      '    repo.branch: recorded="main" current="feature/x"',
    )
    expect(commandIdx).toBeGreaterThanOrEqual(0)
    expect(branchIdx).toBeGreaterThan(commandIdx)
  })

  it('prints the reason line without a near-miss line when near_miss is absent', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      comparability_detail: { reason: 'baseline-missing', kind: 'determined' },
    }
    const out = renderReport(report)
    expect(out).toContain('  reason: baseline-missing (determined)')
    expect(out).not.toContain('near-miss')
  })
})
