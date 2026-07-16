import { describe, expect, it } from 'vitest'
import { parseReport, SchemaViolationError } from '../../src/index.js'

const minimalNoneReport = {
  schema_version: 'veridelta/1',
  outcome_verdict: 'inconclusive',
  comparability: 'none',
  comparability_detail: { reason: 'baseline-missing', kind: 'determined' },
  baseline: null,
  current: { run_id: `run_${'0'.repeat(64)}`, complete: true, child_exit_code: 1, red: [] },
  observation_coverage: { current: '1/1' },
  failure_evidence: { composition_id: 'vitest-native/1', degraded_capabilities: [] },
  trust: { record_integrity: 'advisory' },
  anchors: {},
}

describe('consumer parser hard errors (§9.4, §14)', () => {
  it('parses a valid abstention report', () => {
    expect(() => parseReport(minimalNoneReport)).not.toThrow()
  })

  it('throws on unknown enum values', () => {
    expect(() => parseReport({ ...minimalNoneReport, comparability: 'kinda' })).toThrow(
      SchemaViolationError,
    )
  })

  it('throws on unknown fields', () => {
    expect(() => parseReport({ ...minimalNoneReport, surprise: 1 })).toThrow(SchemaViolationError)
  })

  it('requires comparability_detail under none', () => {
    const { comparability_detail: _, ...withoutDetail } = minimalNoneReport
    expect(() => parseReport(withoutDetail)).toThrow(SchemaViolationError)
  })
})
