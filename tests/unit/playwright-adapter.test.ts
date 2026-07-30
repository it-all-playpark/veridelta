/**
 * `playwrightAdapter` descriptor (F2, `src/adapters/playwright/adapter.ts`):
 * `detect`/`instrument`/`splitCommandSelector`/`claimsCapture`. Mirrors the
 * structure of vitest's own descriptor tests (e.g. `tests/unit/run.test.ts`'s
 * argv-handling coverage), scoped to this adapter's own exports only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findPlaywrightToken,
  playwrightAdapter,
  splitCommandSelector,
} from '../../src/adapters/playwright/adapter.js'

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

describe('findPlaywrightToken / detect', () => {
  it('finds "playwright test" (bare binary token)', () => {
    expect(findPlaywrightToken(['playwright', 'test'])).toBe(0)
    expect(playwrightAdapter.detect(['playwright', 'test'])).toEqual({
      tokenIndex: 0,
    })
  })

  it('finds a path-shaped playwright binary token followed by test', () => {
    expect(
      findPlaywrightToken([
        'node',
        '/repo/node_modules/.bin/playwright',
        'test',
      ]),
    ).toBe(1)
  })

  it('finds the @playwright/test cli.js entry point followed by test', () => {
    expect(
      findPlaywrightToken([
        'node',
        '/repo/node_modules/@playwright/test/cli.js',
        'test',
      ]),
    ).toBe(1)
  })

  it('does not claim a playwright binary token NOT followed by "test" (e.g. "playwright install")', () => {
    // INV-5: injecting --reporter into a non-`test` subcommand would kill
    // that child outright, so this must not be treated as a claim.
    expect(findPlaywrightToken(['playwright', 'install'])).toBeNull()
    expect(playwrightAdapter.detect(['playwright', 'install'])).toBeNull()
  })

  it('skips flags between the binary token and "test"', () => {
    expect(findPlaywrightToken(['playwright', '--foo', 'test'])).toBe(0)
  })

  it('returns null for an argv with no playwright token at all', () => {
    expect(findPlaywrightToken(['npm', 'test'])).toBeNull()
  })

  it('does not misfire on an unrelated token that merely contains "playwright" as a substring', () => {
    expect(findPlaywrightToken(['my-playwright-wrapper', 'test'])).toBeNull()
  })
})

describe('instrument', () => {
  it('appends --reporter=list,<reporterModulePath> and injects VDELTA_CAPTURE_FILE', () => {
    const result = playwrightAdapter.instrument(['playwright', 'test'], {
      kind: 'single-file',
      path: '/tmp/channel.json',
    })
    expect(result.argv[0]).toBe('playwright')
    expect(result.argv[1]).toBe('test')
    expect(result.argv).toHaveLength(3)
    expect(result.argv[2]).toMatch(/^--reporter=list,.*reporter\.cjs$/)
    expect(result.env).toEqual({ VDELTA_CAPTURE_FILE: '/tmp/channel.json' })
  })
})

describe('channelEnv', () => {
  it('is exported unconditionally, independent of detect (§4.2 ambient recording)', () => {
    const env = playwrightAdapter.channelEnv({
      kind: 'single-file',
      path: '/tmp/x.json',
    })
    expect(env).toEqual({ VDELTA_CAPTURE_FILE: '/tmp/x.json' })
  })
})

describe('splitCommandSelector', () => {
  it('keeps "playwright test" in command and treats bare positional tokens as selector', () => {
    expect(
      splitCommandSelector(['playwright', 'test', 'tests/app.spec.ts']),
    ).toEqual({
      command: ['playwright', 'test'],
      selector: ['tests/app.spec.ts'],
    })
  })

  it('folds a value-flag "--flag value" pair into a single "--flag=value" command token', () => {
    expect(
      splitCommandSelector(['playwright', 'test', '--project', 'chromium']),
    ).toEqual({
      command: ['playwright', 'test', '--project=chromium'],
      selector: [],
    })
  })

  it('leaves an already =-joined flag untouched', () => {
    expect(
      splitCommandSelector(['playwright', 'test', '--project=chromium']),
    ).toEqual({
      command: ['playwright', 'test', '--project=chromium'],
      selector: [],
    })
  })

  it('does not fold a flag outside PLAYWRIGHT_VALUE_FLAGS — the following token stays a selector', () => {
    expect(
      splitCommandSelector([
        'playwright',
        'test',
        '--headed',
        'tests/x.spec.ts',
      ]),
    ).toEqual({
      command: ['playwright', 'test', '--headed'],
      selector: ['tests/x.spec.ts'],
    })
  })

  it('returns the argv unchanged with no selector when there is no playwright token', () => {
    expect(splitCommandSelector(['npm', 'test'])).toEqual({
      command: ['npm', 'test'],
      selector: [],
    })
  })
})

describe('claimsCapture', () => {
  it('claims a channel whose payload self-identifies as runner "playwright"', () => {
    const dir = makeScratchDir('vdelta-pw-claim-')
    const path = join(dir, 'channel.json')
    writeFileSync(path, JSON.stringify({ runner: 'playwright' }))
    expect(playwrightAdapter.claimsCapture({ kind: 'single-file', path })).toBe(
      true,
    )
  })

  it('does not claim a foreign payload', () => {
    const dir = makeScratchDir('vdelta-pw-claim-foreign-')
    const path = join(dir, 'channel.json')
    writeFileSync(path, JSON.stringify({ runner: 'vitest' }))
    expect(playwrightAdapter.claimsCapture({ kind: 'single-file', path })).toBe(
      false,
    )
  })

  it('does not throw and does not claim a missing/unreadable channel', () => {
    const dir = makeScratchDir('vdelta-pw-claim-missing-')
    const path = join(dir, 'does-not-exist.json')
    expect(() =>
      playwrightAdapter.claimsCapture({ kind: 'single-file', path }),
    ).not.toThrow()
    expect(playwrightAdapter.claimsCapture({ kind: 'single-file', path })).toBe(
      false,
    )
  })
})

describe('record', () => {
  it('throws AdapterCaptureError when the channel has no readable capture', () => {
    const dir = makeScratchDir('vdelta-pw-record-missing-')
    const path = join(dir, 'does-not-exist.json')
    expect(() =>
      playwrightAdapter.record(
        { kind: 'single-file', path },
        {
          worktree: dir,
          repoIdentity: dir,
          branch: 'main',
          cwdRel: '',
          command: ['playwright', 'test'],
          selector: [],
          head: null,
          treeDigest: `sha256:${'0'.repeat(64)}`,
          dirtyDiffDigest: `sha256:${'0'.repeat(64)}`,
          childExitCode: 0,
          rawStdout: '',
          rawStderr: '',
          adapterVersion: 'test',
          recordedAtMs: 0,
        },
      ),
    ).toThrow(/no capture from the playwright reporter/)
  })
})
