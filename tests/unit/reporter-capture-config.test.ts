/**
 * `captureRunnerConfig` (F1): the pure defensive-cast function that turns
 * vitest's resolved config into `Capture['config']` (9 covering fields).
 * Kept separate from `onTestRunEnd` so the cast rules are testable without a
 * running vitest instance.
 */
import { describe, expect, it } from 'vitest'
import { captureRunnerConfig } from '../../src/adapters/vitest/reporter.js'

class RandomSequencer {}
class BaseSequencer {}

describe('captureRunnerConfig (F1)', () => {
  it('captures all 9 fields from a full resolved-config-like object', () => {
    const config = {
      includeTaskLocation: true,
      chaiConfig: { truncateThreshold: 40 },
      environment: 'jsdom',
      pool: 'threads',
      isolate: false,
      retry: 3,
      testTimeout: 10_000,
      setupFiles: ['/wt/setup.ts', '/wt/setup2.ts'],
      sequence: {
        sequencer: BaseSequencer,
        shuffle: false,
        concurrent: true,
        seed: 42,
      },
    }

    expect(captureRunnerConfig(config)).toEqual({
      include_task_location: true,
      truncate_threshold: 40,
      environment: 'jsdom',
      pool: 'threads',
      isolate: false,
      retry: 3,
      test_timeout: 10_000,
      setup_files: ['/wt/setup.ts', '/wt/setup2.ts'],
      sequence: {
        sequencer: 'BaseSequencer',
        shuffle_tests: false,
        concurrent: true,
        seed: 42,
      },
    })
  })

  it('captures files-shuffle as a sequencer name even though sequence.shuffle is false', () => {
    // vitest 4 resolveConfig normalizes the `shuffle: { files, tests }` object
    // form: `sequence.shuffle` becomes the `tests` boolean, and a `files: true`
    // shuffle survives only as `sequence.sequencer === RandomSequencer`
    // (node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:470-481). Without
    // capturing the sequencer's class name, a files-only shuffle would be
    // silently uncovered by the digest.
    const config = {
      sequence: {
        sequencer: RandomSequencer,
        shuffle: false,
        concurrent: false,
        seed: 1234,
      },
    }

    const captured = captureRunnerConfig(config)
    expect(captured.sequence).toEqual({
      sequencer: 'RandomSequencer',
      shuffle_tests: false,
      concurrent: false,
      seed: 1234,
    })
  })

  it('captures shuffle_tests true when tests are shuffled', () => {
    const config = {
      sequence: {
        sequencer: RandomSequencer,
        shuffle: true,
        concurrent: false,
        seed: 5678,
      },
    }

    expect(captureRunnerConfig(config).sequence).toEqual({
      sequencer: 'RandomSequencer',
      shuffle_tests: true,
      concurrent: false,
      seed: 5678,
    })
  })

  it('normalizes the retry object form ({count, delay, condition}) to its count', () => {
    // vitest 4's resolved retry can be an object
    // (node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:168-172); only
    // `count` is a deterministic serialize target, `condition` is covering-
    // excluded (RegExp/function, documented gap in docs/compositions §7).
    const config = { retry: { count: 2, delay: 100 } }
    expect(captureRunnerConfig(config).retry).toBe(2)
  })

  it('falls back to defaults for a missing/empty config', () => {
    expect(captureRunnerConfig(undefined)).toEqual({
      include_task_location: false,
      truncate_threshold: null,
      environment: 'node',
      pool: 'forks',
      isolate: true,
      retry: 0,
      test_timeout: null,
      setup_files: [],
      sequence: {
        sequencer: null,
        shuffle_tests: false,
        concurrent: false,
        seed: null,
      },
    })
    expect(captureRunnerConfig({})).toEqual(captureRunnerConfig(undefined))
  })

  it('filters non-string entries out of setupFiles and defaults a non-array to []', () => {
    expect(
      captureRunnerConfig({ setupFiles: ['/a.ts', 1, null, '/b.ts'] })
        .setup_files,
    ).toEqual(['/a.ts', '/b.ts'])
    expect(
      captureRunnerConfig({ setupFiles: 'not-an-array' }).setup_files,
    ).toEqual([])
  })
})
