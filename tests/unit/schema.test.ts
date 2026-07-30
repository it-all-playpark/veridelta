import { describe, expect, it } from 'vitest'
import {
  parseReport,
  parseRunRecord,
  type RunRecord,
  SchemaViolationError,
} from '../../src/index.js'
import type { EvidenceError, FailureFinding } from '../../src/schema.js'

const minimalNoneReport = {
  schema_version: 'veridelta/1',
  outcome_verdict: 'inconclusive',
  comparability: 'none',
  comparability_detail: { reason: 'baseline-missing', kind: 'determined' },
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
  anchors: {},
}

describe('consumer parser hard errors (§9.4, §14)', () => {
  it('parses a valid abstention report', () => {
    expect(() => parseReport(minimalNoneReport)).not.toThrow()
  })

  it('throws on unknown enum values', () => {
    expect(() =>
      parseReport({ ...minimalNoneReport, comparability: 'kinda' }),
    ).toThrow(SchemaViolationError)
  })

  it('throws on unknown fields', () => {
    expect(() => parseReport({ ...minimalNoneReport, surprise: 1 })).toThrow(
      SchemaViolationError,
    )
  })

  it('requires comparability_detail under none', () => {
    const { comparability_detail: _, ...withoutDetail } = minimalNoneReport
    expect(() => parseReport(withoutDetail)).toThrow(SchemaViolationError)
  })
})

describe('comparability_detail.near_miss (§5.4/§9.1)', () => {
  const withNearMiss = {
    ...minimalNoneReport,
    comparability_detail: {
      reason: 'baseline-missing',
      kind: 'determined',
      near_miss: {
        run_id: `run_${'0'.repeat(64)}`,
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

  it('parses a report with a valid near_miss disclosure', () => {
    expect(() => parseReport(withNearMiss)).not.toThrow()
  })

  it('still parses the original report without near_miss', () => {
    expect(() => parseReport(minimalNoneReport)).not.toThrow()
  })

  it('throws on an unknown key inside near_miss', () => {
    const bad = {
      ...withNearMiss,
      comparability_detail: {
        ...withNearMiss.comparability_detail,
        near_miss: { ...withNearMiss.comparability_detail.near_miss, extra: 1 },
      },
    }
    expect(() => parseReport(bad)).toThrow(SchemaViolationError)
  })

  it('throws on an unknown stream-key field enum value', () => {
    const bad = {
      ...withNearMiss,
      comparability_detail: {
        ...withNearMiss.comparability_detail,
        near_miss: {
          ...withNearMiss.comparability_detail.near_miss,
          mismatches: [{ field: 'repo.head', recorded: 'a', current: 'b' }],
        },
      },
    }
    expect(() => parseReport(bad)).toThrow(SchemaViolationError)
  })

  it('throws on an empty mismatches array', () => {
    const bad = {
      ...withNearMiss,
      comparability_detail: {
        ...withNearMiss.comparability_detail,
        near_miss: {
          ...withNearMiss.comparability_detail.near_miss,
          mismatches: [],
        },
      },
    }
    expect(() => parseReport(bad)).toThrow(SchemaViolationError)
  })

  it('throws on a mismatch entry missing "current"', () => {
    const bad = {
      ...withNearMiss,
      comparability_detail: {
        ...withNearMiss.comparability_detail,
        near_miss: {
          ...withNearMiss.comparability_detail.near_miss,
          mismatches: [
            { field: 'invocation.command', recorded: 'npx vitest run' },
          ],
        },
      },
    }
    expect(() => parseReport(bad)).toThrow(SchemaViolationError)
  })
})

describe('current.completeness_status (F1)', () => {
  it('parses a report with current.completeness_status "crashed"', () => {
    const withCrashed = {
      ...minimalNoneReport,
      current: { ...minimalNoneReport.current, completeness_status: 'crashed' },
    }
    expect(() => parseReport(withCrashed)).not.toThrow()
  })

  it('parses a report with current.completeness_status "partial"', () => {
    const withPartial = {
      ...minimalNoneReport,
      current: { ...minimalNoneReport.current, completeness_status: 'partial' },
    }
    expect(() => parseReport(withPartial)).not.toThrow()
  })

  it('throws on an unknown completeness_status value', () => {
    const bad = {
      ...minimalNoneReport,
      current: {
        ...minimalNoneReport.current,
        completeness_status: 'exploded',
      },
    }
    expect(() => parseReport(bad)).toThrow(SchemaViolationError)
  })

  it('still parses the original report without completeness_status', () => {
    expect(() => parseReport(minimalNoneReport)).not.toThrow()
  })
})

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '/wt' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest',
      adapter_version: '1',
      composition_id: 'vitest-native/2',
      config_digest: 'cfg1',
    },
    environment: {
      runner: 'vitest',
      runner_version: '1',
      runtime: 'node',
      os: 'darwin',
      env_fingerprint: 'env1',
    },
    provenance: {
      head: 'deadbeef',
      dirty_diff_digest: 'dd1',
      tree_digest: 'td1',
    },
    surface: {
      inventory_digest: 'inv1',
      test_sources: {},
      config_sources: {},
      suppressed: [],
    },
    completeness: { status: 'complete', child_exit_code: 0 },
    observations: [],
    recording: {
      recorder: 'vdelta-run',
      recorded_at_ms: 0,
      durations_us: {},
      raw_stdout: '',
      raw_stderr: '',
      capture_reason: 'complete',
      unhandled_errors: 0,
    },
    ...overrides,
  }
}

describe('record.instrument.capabilities (F1, §3.4)', () => {
  it('parses a record with no instrument.capabilities (pre-F1 record, read back-compat)', () => {
    expect(() => parseRunRecord(makeRunRecord())).not.toThrow()
  })

  it('parses a record whose capabilities declare an unknown (future) capability name', () => {
    const record = makeRunRecord({
      instrument: {
        adapter: 'vitest',
        adapter_version: '1',
        composition_id: 'vitest-native/2',
        config_digest: 'cfg1',
        capabilities: {
          verdicts: 'pass',
          'some-future-capability': 'unsupported',
        },
      },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })

  it('throws when a capability value is outside the closed enum', () => {
    const record = makeRunRecord({
      instrument: {
        adapter: 'vitest',
        adapter_version: '1',
        composition_id: 'vitest-native/2',
        config_digest: 'cfg1',
        capabilities: { verdicts: 'totally-bogus' } as unknown as Record<
          string,
          'pass' | 'fail' | 'unsupported'
        >,
      },
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
    expect(() => parseRunRecord(record)).toThrow(
      /record\.instrument\.capabilities\.verdicts/,
    )
  })

  it('throws when instrument.capabilities is not an object', () => {
    const record = makeRunRecord({
      instrument: {
        adapter: 'vitest',
        adapter_version: '1',
        composition_id: 'vitest-native/2',
        config_digest: 'cfg1',
        capabilities: 'nope' as unknown as Record<
          string,
          'pass' | 'fail' | 'unsupported'
        >,
      },
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
  })
})

describe('report.comparability_detail.reason "adapter-unknown" (F1, §6.3)', () => {
  it('parses a report whose comparability_detail.reason is "adapter-unknown"', () => {
    const withAdapterUnknown = {
      ...minimalNoneReport,
      comparability_detail: { reason: 'adapter-unknown', kind: 'failed' },
    }
    expect(() => parseReport(withAdapterUnknown)).not.toThrow()
  })
})

describe('record.completeness.module_errors (F1)', () => {
  it('parses a record with no module_errors (pre-F1 record, read back-compat)', () => {
    expect(() => parseRunRecord(makeRunRecord())).not.toThrow()
  })

  it('parses a record with a well-formed module_errors array', () => {
    const record = makeRunRecord({
      completeness: {
        status: 'crashed',
        child_exit_code: 1,
        module_errors: [
          { rel: 'a.test.ts', count: 1 },
          { rel: 'b.test.ts', count: 2 },
        ],
      },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })

  it('throws when a module_errors entry has a non-string rel', () => {
    const record = makeRunRecord({
      completeness: {
        status: 'crashed',
        child_exit_code: 1,
        module_errors: [{ rel: 1, count: 1 }] as unknown as {
          rel: string
          count: number
        }[],
      },
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
  })

  it('throws when a module_errors entry has an unknown extra key', () => {
    const record = makeRunRecord({
      completeness: {
        status: 'crashed',
        child_exit_code: 1,
        module_errors: [
          { rel: 'a.test.ts', count: 1, extra: true },
        ] as unknown as { rel: string; count: number }[],
      },
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
  })
})

describe('F2: EvidenceError.source_region / FailureFinding.annex.attempts / annex.attachments (optional, additive)', () => {
  function makeFindingRecord(
    finding: RunRecord['observations'][number]['finding'],
  ) {
    return makeRunRecord({
      observations: [{ test_id: 't1', verdict: 'fail', finding }],
    })
  }

  it('parses a finding whose evidence.errors[] carries source_region', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: {
        errors: [
          {
            exception_type: 'Error',
            message: 'boom',
            rel_offsets: [1],
            source_region: 'expect(1).toBe(2)',
          },
        ],
      },
      context_digest: 'c1',
      annex: { frames: [], console: [], location_line: 5 },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })

  it('parses a finding whose annex carries attempts (retry evidence)', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: { errors: [] },
      context_digest: 'c1',
      annex: {
        frames: [],
        console: [],
        location_line: 5,
        attempts: [
          {
            retry: 0,
            errors: [
              { exception_type: 'Error', message: 'boom', rel_offsets: [] },
            ],
            frames: [{ file: 'a.ts', line: 1, column: 1 }],
          },
        ],
      },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })

  it('parses a finding whose annex carries attachments (name/content_type/body_digest only)', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: { errors: [] },
      context_digest: 'c1',
      annex: {
        frames: [],
        console: [],
        location_line: 5,
        attachments: [
          {
            name: 'trace.zip',
            content_type: 'application/zip',
            body_digest: 'sha256:ab',
          },
          {
            name: 'unreadable',
            content_type: 'application/octet-stream',
            body_digest: null,
          },
        ],
      },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })

  it('throws on an unknown key inside evidence.errors[] (still closed-key otherwise)', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: {
        errors: [
          {
            exception_type: 'Error',
            message: 'boom',
            rel_offsets: [],
            surprise: 1,
          } as unknown as EvidenceError,
        ],
      },
      context_digest: 'c1',
      annex: { frames: [], console: [], location_line: 5 },
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
  })

  it('throws on an unknown key inside annex (attempts/attachments spelled wrong stays rejected)', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: { errors: [] },
      context_digest: 'c1',
      annex: {
        frames: [],
        console: [],
        location_line: 5,
        attemps: [],
      } as unknown as FailureFinding['annex'],
    })
    expect(() => parseRunRecord(record)).toThrow(SchemaViolationError)
  })

  it('still parses a vitest-shaped finding with no source_region/attempts/attachments keys at all', () => {
    const record = makeFindingRecord({
      evidence_digest: 'e1',
      structural_fingerprint: 'f1',
      evidence: {
        errors: [
          {
            exception_type: 'AssertionError',
            message: 'boom',
            rel_offsets: [2],
          },
        ],
      },
      context_digest: 'c1',
      annex: { frames: [], console: [], location_line: 5 },
    })
    expect(() => parseRunRecord(record)).not.toThrow()
  })
})
