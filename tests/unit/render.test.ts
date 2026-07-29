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

describe('renderReport completeness (§9.1)', () => {
  const currentLine = (out: string): string | undefined =>
    out.split('\n').find((l) => l.startsWith('  current:'))

  it('appends " [INCOMPLETE: crashed]" when current.complete is false and completeness_status is crashed', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      current: {
        ...minimalNoneReport.current,
        complete: false,
        completeness_status: 'crashed',
      },
    }
    const out = renderReport(report)
    expect(currentLine(out)).toBe(
      '  current:  run_00000000 exit=1 coverage=1/1 [INCOMPLETE: crashed]',
    )
  })

  it('appends " [INCOMPLETE: partial]" when current.complete is false and completeness_status is partial', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      current: {
        ...minimalNoneReport.current,
        complete: false,
        completeness_status: 'partial',
      },
    }
    const out = renderReport(report)
    expect(currentLine(out)).toBe(
      '  current:  run_00000000 exit=1 coverage=1/1 [INCOMPLETE: partial]',
    )
  })

  it('leaves the current line unchanged when current.complete is true', () => {
    const out = renderReport(minimalNoneReport)
    expect(currentLine(out)).toBe(
      '  current:  run_00000000 exit=1 coverage=1/1',
    )
    expect(out).not.toContain('INCOMPLETE')
  })

  it('appends " [INCOMPLETE]" (no status) when current.complete is false and completeness_status is absent', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      current: {
        ...minimalNoneReport.current,
        complete: false,
      },
    }
    const out = renderReport(report)
    expect(currentLine(out)).toBe(
      '  current:  run_00000000 exit=1 coverage=1/1 [INCOMPLETE]',
    )
  })

  it('still shows INCOMPLETE when red is empty (crashed run that otherwise looks green)', () => {
    const report: ComparisonReport = {
      ...minimalNoneReport,
      current: {
        ...minimalNoneReport.current,
        red: [],
        complete: false,
        completeness_status: 'crashed',
      },
    }
    const out = renderReport(report)
    expect(currentLine(out)).toBe(
      '  current:  run_00000000 exit=1 coverage=1/1 [INCOMPLETE: crashed]',
    )
    expect(out).not.toContain('red now')
  })
})
