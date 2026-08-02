/**
 * `instrumentConfigDigest` (F1): the 9-field config_digest covering + the
 * `completeness.module_errors` record shape. capture_version 3.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capture } from '../../src/adapters/vitest/capture.js'
import {
  buildRunRecord,
  instrumentConfigDigest,
  type RecordContext,
  VITEST_CAPABILITIES,
} from '../../src/adapters/vitest/recorder.js'
import { canonicalDigest } from '../../src/digest.js'

const scratchDirs: string[] = []

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function baseCtx(worktree: string): RecordContext {
  return {
    worktree,
    repoIdentity: worktree,
    branch: 'main',
    cwdRel: '',
    command: ['vitest', 'run'],
    selector: [],
    head: null,
    treeDigest: `sha256:${'0'.repeat(64)}`,
    dirtyDiffDigest: `sha256:${'0'.repeat(64)}`,
    childExitCode: 0,
    rawStdout: '',
    rawStderr: '',
    adapterVersion: 'test',
    recordedAtMs: 0,
  }
}

function fullConfig(
  worktree: string,
  overrides: Partial<Capture['config']> = {},
): Capture['config'] {
  return {
    include_task_location: false,
    truncate_threshold: null,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    retry: 0,
    test_timeout: 5000,
    setup_files: [join(worktree, 'setup.ts')],
    sequence: {
      sequencer: 'BaseSequencer',
      shuffle_tests: false,
      concurrent: false,
      seed: null,
    },
    ...overrides,
  }
}

function baseCapture(config: Capture['config']): Capture {
  return {
    capture_version: 3,
    runner: 'vitest',
    runner_version: '4.0.0',
    reason: 'passed',
    unhandled_errors: 0,
    config,
    tests: [],
    module_errors: [],
    config_files: [],
  }
}

describe('instrumentConfigDigest (F1): 9-field config_digest', () => {
  it('changes when any one of the 9 covered fields changes', () => {
    const worktree = makeScratchDir('vdelta-digest-worktree-')
    writeFileSync(join(worktree, 'setup.ts'), 'export {}')
    const baseDigest = instrumentConfigDigest(
      baseCapture(fullConfig(worktree)),
      worktree,
    )

    const variants: Partial<Capture['config']>[] = [
      { include_task_location: true },
      { truncate_threshold: 10 },
      { environment: 'jsdom' },
      { pool: 'threads' },
      { isolate: false },
      { retry: 1 },
      { test_timeout: 10_000 },
      { setup_files: [] },
      {
        sequence: {
          sequencer: 'RandomSequencer',
          shuffle_tests: false,
          concurrent: false,
          seed: null,
        },
      },
    ]

    for (const variant of variants) {
      const digest = instrumentConfigDigest(
        baseCapture(fullConfig(worktree, variant)),
        worktree,
      )
      expect(digest).not.toBe(baseDigest)
    }
  })

  it('normalizes setup_files to worktree-relative keys, so two worktrees with identical layout share a digest', () => {
    const worktreeA = makeScratchDir('vdelta-digest-wtA-')
    const worktreeB = makeScratchDir('vdelta-digest-wtB-')
    mkdirSync(join(worktreeA, 'test'))
    mkdirSync(join(worktreeB, 'test'))
    writeFileSync(join(worktreeA, 'test', 'setup.ts'), 'export {}')
    writeFileSync(join(worktreeB, 'test', 'setup.ts'), 'export {}')

    const captureA = baseCapture(
      fullConfig(worktreeA, {
        setup_files: [join(worktreeA, 'test', 'setup.ts')],
      }),
    )
    const captureB = baseCapture(
      fullConfig(worktreeB, {
        setup_files: [join(worktreeB, 'test', 'setup.ts')],
      }),
    )

    expect(instrumentConfigDigest(captureA, worktreeA)).toBe(
      instrumentConfigDigest(captureB, worktreeB),
    )
  })

  it('keys a setup file outside the worktree as external:<realpath>', () => {
    const worktree = makeScratchDir('vdelta-digest-wt-')
    const outside = makeScratchDir('vdelta-digest-outside-')
    const outsideFile = join(outside, 'global-setup.ts')
    writeFileSync(outsideFile, 'export {}')

    const config = fullConfig(worktree, { setup_files: [outsideFile] })
    const capture = baseCapture(config)

    const expected = canonicalDigest({
      include_task_location: config.include_task_location,
      truncate_threshold: config.truncate_threshold,
      environment: config.environment,
      pool: config.pool,
      isolate: config.isolate,
      retry: config.retry,
      test_timeout: config.test_timeout,
      setup_files: [`external:${realpathSync(outsideFile)}`],
      sequence: config.sequence,
    })

    expect(instrumentConfigDigest(capture, worktree)).toBe(expected)
  })

  it('preserves setup_files order rather than sorting (setup order is evidence-affecting)', () => {
    const worktree = makeScratchDir('vdelta-digest-order-')
    writeFileSync(join(worktree, 'a.ts'), 'export {}')
    writeFileSync(join(worktree, 'b.ts'), 'export {}')

    const forward = baseCapture(
      fullConfig(worktree, {
        setup_files: [join(worktree, 'a.ts'), join(worktree, 'b.ts')],
      }),
    )
    const reversed = baseCapture(
      fullConfig(worktree, {
        setup_files: [join(worktree, 'b.ts'), join(worktree, 'a.ts')],
      }),
    )

    expect(instrumentConfigDigest(forward, worktree)).not.toBe(
      instrumentConfigDigest(reversed, worktree),
    )
  })
})

describe('buildRunRecord completeness.module_errors (F1)', () => {
  it('sorts module_errors by rel ascending and reduces messages to a count', () => {
    const worktree = makeScratchDir('vdelta-modrec-worktree-')
    writeFileSync(join(worktree, 'setup.ts'), 'export {}')
    const capture = baseCapture(fullConfig(worktree))
    capture.module_errors = [
      { rel: 'b.test.ts', messages: ['x', 'y'] },
      { rel: 'a.test.ts', messages: ['z'] },
    ]

    const record = buildRunRecord(capture, baseCtx(worktree))

    expect(record.completeness).toEqual({
      status: 'crashed',
      child_exit_code: 0,
      module_errors: [
        { rel: 'a.test.ts', count: 1 },
        { rel: 'b.test.ts', count: 2 },
      ],
    })
  })

  it('writes an empty module_errors array with no effect on status when there are none', () => {
    const worktree = makeScratchDir('vdelta-modrec-worktree-')
    writeFileSync(join(worktree, 'setup.ts'), 'export {}')
    const capture = baseCapture(fullConfig(worktree))

    const record = buildRunRecord(capture, baseCtx(worktree))

    expect(record.completeness).toEqual({
      status: 'complete',
      child_exit_code: 0,
      module_errors: [],
    })
  })
})

describe('buildRunRecord instrument.capabilities (F2)', () => {
  it('writes the vitest declaration into instrument.capabilities', () => {
    const worktree = makeScratchDir('vdelta-caps-worktree-')
    writeFileSync(join(worktree, 'setup.ts'), 'export {}')
    const record = buildRunRecord(
      baseCapture(fullConfig(worktree)),
      baseCtx(worktree),
    )

    expect(record.instrument.capabilities).toEqual({
      verdicts: 'pass',
      'source-location': 'pass',
      suppression: 'pass',
      inventory: 'pass',
      'failure-evidence': 'pass',
      'source-region-text': 'unsupported',
      'selector-relation': 'pass',
    })
    expect(record.instrument.capabilities).not.toBe(VITEST_CAPABILITIES)
  })
})
