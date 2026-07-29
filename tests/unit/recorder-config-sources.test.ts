import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capture } from '../../src/adapters/vitest/capture.js'
import {
  buildRunRecord,
  configSourceKey,
  type RecordContext,
  RecorderError,
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

function baseCapture(configFiles: string[]): Capture {
  return {
    capture_version: 3,
    runner: 'vitest',
    runner_version: '4.0.0',
    reason: 'passed',
    unhandled_errors: 0,
    config: {
      include_task_location: false,
      truncate_threshold: null,
      environment: 'node',
      pool: 'forks',
      isolate: true,
      retry: 0,
      test_timeout: 5000,
      setup_files: [],
      sequence: {
        sequencer: 'BaseSequencer',
        shuffle_tests: false,
        concurrent: false,
        seed: null,
      },
    },
    tests: [],
    module_errors: [],
    config_files: configFiles,
  }
}

describe('configSourceKey (§3 config_sources key convention)', () => {
  it('returns a worktree-relative key for a nested worktree-internal path', () => {
    const worktree = makeScratchDir('vdelta-cfg-worktree-')
    const configPath = join(worktree, 'nested', 'vitest.config.ts')
    mkdirSync(join(worktree, 'nested'))
    writeFileSync(configPath, 'export default {}')

    expect(configSourceKey(configPath, worktree)).toBe(
      'nested/vitest.config.ts',
    )
  })

  it('returns an external: prefixed absolute path for a worktree-external path', () => {
    const worktree = makeScratchDir('vdelta-cfg-worktree-')
    const outside = makeScratchDir('vdelta-cfg-outside-')
    const configPath = join(outside, 'vite.config.ts')
    writeFileSync(configPath, 'export default {}')

    expect(configSourceKey(configPath, worktree)).toBe(
      `external:${realpathSync(configPath)}`,
    )
  })

  it('normalizes a symlinked worktree via realpath before computing the relative key', () => {
    const realWorktree = makeScratchDir('vdelta-cfg-real-')
    const configPath = join(realWorktree, 'vitest.config.ts')
    writeFileSync(configPath, 'export default {}')

    const symlinkParent = makeScratchDir('vdelta-cfg-link-parent-')
    const worktreeLink = join(symlinkParent, 'worktree-link')
    symlinkSync(realWorktree, worktreeLink)

    expect(configSourceKey(configPath, worktreeLink)).toBe('vitest.config.ts')
  })
})

describe('buildRunRecord surface.config_sources (F1)', () => {
  it('digests only readable config_files and keys them by worktree/external convention, skipping missing paths', () => {
    const worktree = makeScratchDir('vdelta-cfg-worktree-')
    const insideConfig = join(worktree, 'vitest.config.ts')
    const insideContent = 'export default { test: {} }'
    writeFileSync(insideConfig, insideContent)

    const outside = makeScratchDir('vdelta-cfg-outside-')
    const outsideConfig = join(outside, 'vite.config.ts')
    const outsideContent = 'export default {}'
    writeFileSync(outsideConfig, outsideContent)

    const missingConfig = join(outside, 'does-not-exist.config.ts')

    const capture = baseCapture([insideConfig, outsideConfig, missingConfig])
    const record = buildRunRecord(capture, baseCtx(worktree))

    expect(record.surface.config_sources).toEqual({
      'vitest.config.ts': canonicalDigest(insideContent),
      [`external:${realpathSync(outsideConfig)}`]:
        canonicalDigest(outsideContent),
    })
  })

  it('rejects capture_version 1 with a RecorderError', () => {
    const worktree = makeScratchDir('vdelta-cfg-worktree-')
    const capture = { ...baseCapture([]), capture_version: 1 }

    expect(() => buildRunRecord(capture, baseCtx(worktree))).toThrow(
      RecorderError,
    )
  })
})
