/**
 * `buildRunRecord` (F2, `src/adapters/playwright/recorder.ts`), driven by
 * synthetic `Capture` payloads (no running playwright process — same style
 * as `tests/unit/recorder-config-digest.test.ts`/`recorder-config-sources.test.ts`
 * for the vitest adapter). Required cases per the F2 test_plan (a)-(j).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  Capture,
  CapturedPwAttachment,
  CapturedPwAttempt,
  CapturedPwError,
  CapturedPwProjectConfig,
  CapturedPwTest,
  CapturedPwUnreportedTest,
} from '../../src/adapters/playwright/capture.js'
import {
  buildRunRecord,
  instrumentConfigDigest,
  type RecordContext,
  RecorderError,
} from '../../src/adapters/playwright/recorder.js'

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

/** Writes `content` at `relFile` inside `worktree`, creating parent dirs. Returns the absolute path. */
function writeTestFile(
  worktree: string,
  relFile: string,
  content = '',
): string {
  const abs = join(worktree, relFile)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

function baseCtx(worktree: string): RecordContext {
  return {
    worktree,
    repoIdentity: worktree,
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
  }
}

function project(
  name: string,
  overrides: Partial<CapturedPwProjectConfig> = {},
): CapturedPwProjectConfig {
  return {
    name,
    testMatch: '**/*.spec.ts',
    testIgnore: [],
    dependencies: [],
    retries: 0,
    timeout: 30_000,
    use: {},
    ...overrides,
  }
}

function baseConfig(projects: CapturedPwProjectConfig[]): Capture['config'] {
  return {
    fullyParallel: true,
    workers: 1,
    shard: null,
    forbidOnly: false,
    maxFailures: 0,
    grep: null,
    grepInvert: null,
    globalTimeout: 0,
    projects,
  }
}

function baseCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    capture_version: 1,
    runner: 'playwright',
    runner_version: '1.49.1',
    status: 'passed',
    unhandled_errors: 0,
    config: baseConfig([project('chromium')]),
    tests: [],
    unreported_tests: [],
    config_files: [],
    ...overrides,
  }
}

function attempt(
  status: CapturedPwAttempt['status'],
  overrides: Partial<CapturedPwAttempt> = {},
): CapturedPwAttempt {
  return {
    status,
    retry: 0,
    errors: [],
    stdio: [],
    attachments: [],
    duration_ms: 5,
    ...overrides,
  }
}

function reportedTest(
  overrides: Partial<CapturedPwTest> & {
    projectName: string
    fileAbs: string
    titles: string[]
  },
): CapturedPwTest {
  const { projectName, fileAbs, titles, ...rest } = overrides
  return {
    test_case_id: `${projectName}-${titles.join('/')}`,
    file_abs: fileAbs,
    project: projectName,
    titles,
    location_line: 1,
    expected_status: 'passed',
    annotations: [],
    attempts: [attempt('passed')],
    ...rest,
  }
}

function unreportedTest(
  overrides: Partial<CapturedPwUnreportedTest> & {
    projectName: string
    fileAbs: string
    titles: string[]
  },
): CapturedPwUnreportedTest {
  const { projectName, fileAbs, titles, ...rest } = overrides
  return {
    test_case_id: `${projectName}-${titles.join('/')}`,
    file_abs: fileAbs,
    project: projectName,
    titles,
    location_line: 1,
    expected_status: 'passed',
    annotations: [],
    ...rest,
  }
}

function error(overrides: Partial<CapturedPwError> = {}): CapturedPwError {
  return {
    message: 'Error: boom',
    frames: [],
    ...overrides,
  }
}

describe('test id composition (F2)', () => {
  it('(a) puts project into the id, so same-titled tests in different projects get distinct ids', () => {
    const worktree = makeScratchDir('vdelta-pw-a-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      config: baseConfig([project('chromium'), project('firefox')]),
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['shared title'],
        }),
        reportedTest({
          projectName: 'firefox',
          fileAbs,
          titles: ['shared title'],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))

    const ids = record.observations.map((o) => o.test_id).sort()
    expect(ids).toEqual([
      'tests/app.spec.ts::chromium::shared title',
      'tests/app.spec.ts::firefox::shared title',
    ])
  })

  it('(b) throws RecorderError on a duplicate id within the same project', () => {
    const worktree = makeScratchDir('vdelta-pw-b-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({ projectName: 'chromium', fileAbs, titles: ['dup'] }),
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['dup'],
          test_case_id: 'a-different-underlying-id',
        }),
      ],
    })

    expect(() => buildRunRecord(capture, baseCtx(worktree))).toThrow(
      RecorderError,
    )
  })
})

describe('dependency skip cascade (F2, spec §11.1 floor)', () => {
  it('(c) synthesizes marker "dependency" for an unreported test whose transitive dependency project is red, and does not drop it from observations', () => {
    const worktree = makeScratchDir('vdelta-pw-c-')
    const setupFile = writeTestFile(worktree, 'tests/auth.setup.ts')
    const authFile = writeTestFile(worktree, 'tests/auth.spec.ts')
    const capture = baseCapture({
      config: baseConfig([
        project('setup'),
        project('auth-tests', { dependencies: ['setup'] }),
      ]),
      tests: [
        reportedTest({
          projectName: 'setup',
          fileAbs: setupFile,
          titles: ['authenticate'],
          attempts: [attempt('failed', { errors: [error()] })],
        }),
      ],
      // Reflects observations/setup-cascade.json: annotations arrive empty
      // even for an authored `test.skip()` inside a blocked project.
      unreported_tests: [
        unreportedTest({
          projectName: 'auth-tests',
          fileAbs: authFile,
          titles: ['auth: authored skip'],
          annotations: [],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))

    const obs = record.observations.find(
      (o) =>
        o.test_id === 'tests/auth.spec.ts::auth-tests::auth: authored skip',
    )
    expect(obs).toBeDefined()
    expect(obs?.verdict).toBe('skip')
    expect(obs?.suppression).toEqual({
      marker: 'dependency',
      note: 'blocked by red dependency project setup',
    })
  })

  it('(c) resolves the dependency transitively (project B depends on A, A depends on red project setup)', () => {
    const worktree = makeScratchDir('vdelta-pw-c2-')
    const setupFile = writeTestFile(worktree, 'tests/auth.setup.ts')
    const bFile = writeTestFile(worktree, 'tests/b.spec.ts')
    const capture = baseCapture({
      config: baseConfig([
        project('setup'),
        project('a', { dependencies: ['setup'] }),
        project('b', { dependencies: ['a'] }),
      ]),
      tests: [
        reportedTest({
          projectName: 'setup',
          fileAbs: setupFile,
          titles: ['authenticate'],
          attempts: [attempt('failed', { errors: [error()] })],
        }),
      ],
      unreported_tests: [
        unreportedTest({
          projectName: 'b',
          fileAbs: bFile,
          titles: ['b test'],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))

    const obs = record.observations.find(
      (o) => o.test_id === 'tests/b.spec.ts::b::b test',
    )
    expect(obs?.verdict).toBe('skip')
    expect(obs?.suppression?.marker).toBe('dependency')
  })

  it('(d) an unreported test with no red transitive dependency is not_run, not dependency-skip', () => {
    const worktree = makeScratchDir('vdelta-pw-d-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      config: baseConfig([project('chromium')]),
      tests: [],
      unreported_tests: [
        unreportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['blocked by maxFailures'],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))

    const obs = record.observations.find(
      (o) =>
        o.test_id === 'tests/app.spec.ts::chromium::blocked by maxFailures',
    )
    expect(obs?.verdict).toBe('not_run')
    expect(obs?.suppression).toBeUndefined()
  })
})

describe('source_region: tree-reconstructed failing source region text (F2, CE-1/CE-3)', () => {
  it('(e) is byte-identical for two captures whose error.location line differs only by an unrelated line shift', () => {
    const worktreeA = makeScratchDir('vdelta-pw-e-a-')
    const worktreeB = makeScratchDir('vdelta-pw-e-b-')
    const fileA = writeTestFile(
      worktreeA,
      'tests/app.spec.ts',
      'const helper = () => {}\nexpect(1).toBe(2)\n',
    )
    const fileB = writeTestFile(
      worktreeB,
      'tests/app.spec.ts',
      '\n\n\nconst helper = () => {}\nexpect(1).toBe(2)\n',
    )

    const captureA = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs: fileA,
          titles: ['t'],
          expected_status: 'passed',
          attempts: [
            attempt('failed', {
              errors: [
                error({
                  message: 'Error: boom',
                  location: { file: fileA, line: 2, column: 1 },
                }),
              ],
            }),
          ],
        }),
      ],
    })
    const captureB = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs: fileB,
          titles: ['t'],
          expected_status: 'passed',
          attempts: [
            attempt('failed', {
              errors: [
                error({
                  message: 'Error: boom',
                  location: { file: fileB, line: 5, column: 1 },
                }),
              ],
            }),
          ],
        }),
      ],
    })

    const recordA = buildRunRecord(captureA, baseCtx(worktreeA))
    const recordB = buildRunRecord(captureB, baseCtx(worktreeB))

    const findingA = recordA.observations[0]?.finding
    const findingB = recordB.observations[0]?.finding
    expect(findingA?.evidence.errors[0]?.source_region).toBe(
      'expect(1).toBe(2)',
    )
    expect(findingB?.evidence.errors[0]?.source_region).toBe(
      'expect(1).toBe(2)',
    )
    expect(findingA?.evidence_digest).toBe(findingB?.evidence_digest)
  })

  it('(f) never reads the raw error.snippet field — reconstructs from the tree even when a differing snippet is present', () => {
    const worktree = makeScratchDir('vdelta-pw-f-')
    const fileAbs = writeTestFile(
      worktree,
      'tests/app.spec.ts',
      'expect(1).toBe(2)\n',
    )
    const errorWithFakeSnippet = {
      ...error({
        message: 'Error: boom',
        location: { file: fileAbs, line: 1, column: 1 },
      }),
      // Not part of CapturedPwError's type (see capture.ts) — simulating a
      // channel that carried the runner's rendered gutter-annotated snippet.
      // If the recorder ever read this, source_region would pick up this
      // (deliberately different, gutter-prefixed) text instead.
      snippet: ' 38 | totally different rendered text',
    } as CapturedPwError

    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          attempts: [attempt('failed', { errors: [errorWithFakeSnippet] })],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    expect(
      record.observations[0]?.finding?.evidence.errors[0]?.source_region,
    ).toBe('expect(1).toBe(2)')
  })

  it('omits source_region when neither error.location nor an in-file frame exists', () => {
    const worktree = makeScratchDir('vdelta-pw-noregion-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts', 'x\n')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          attempts: [
            attempt('failed', {
              errors: [error({ message: 'Error: teardown boom', frames: [] })],
            }),
          ],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    const err = record.observations[0]?.finding?.evidence.errors[0]
    expect(err).toBeDefined()
    expect(err && 'source_region' in err).toBe(false)
  })
})

describe('retry evidence / flaky (F2, D2 mechanism 1, record side only)', () => {
  it('(g) a fail→fail→pass sequence keeps verdict "pass", attaches a finding from the last failing attempt, and records the earlier failing attempt in annex.attempts', () => {
    const worktree = makeScratchDir('vdelta-pw-g-')
    const fileAbs = writeTestFile(worktree, 'tests/flaky.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['eventually passes'],
          expected_status: 'passed',
          attempts: [
            attempt('failed', {
              retry: 0,
              errors: [error({ message: 'Error: first' })],
            }),
            attempt('failed', {
              retry: 1,
              errors: [error({ message: 'Error: second' })],
            }),
            attempt('passed', { retry: 2, errors: [] }),
          ],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    const obs = record.observations[0]
    expect(obs?.verdict).toBe('pass')
    expect(obs?.finding).toBeDefined()
    expect(obs?.finding?.evidence.errors[0]?.message).toContain('second')
    expect(obs?.finding?.annex.attempts).toEqual([
      expect.objectContaining({
        retry: 0,
        errors: [
          expect.objectContaining({
            message: expect.stringContaining('first'),
          }),
        ],
      }),
    ])
  })

  it('a single fail→pass sequence has no annex.attempts (the only failing attempt is the finding-primary one)', () => {
    const worktree = makeScratchDir('vdelta-pw-g2-')
    const fileAbs = writeTestFile(worktree, 'tests/flaky.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          expected_status: 'passed',
          attempts: [
            attempt('failed', { retry: 0, errors: [error()] }),
            attempt('passed', { retry: 1, errors: [] }),
          ],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    expect(record.observations[0]?.verdict).toBe('pass')
    expect(record.observations[0]?.finding).toBeDefined()
    expect(record.observations[0]?.finding?.annex.attempts).toBeUndefined()
  })

  it('a final fail with a prior failed retry stores the prior attempt in annex.attempts', () => {
    const worktree = makeScratchDir('vdelta-pw-g3-')
    const fileAbs = writeTestFile(worktree, 'tests/flaky.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          expected_status: 'passed',
          attempts: [
            attempt('failed', {
              retry: 0,
              errors: [error({ message: 'Error: first' })],
            }),
            attempt('failed', {
              retry: 1,
              errors: [error({ message: 'Error: last' })],
            }),
          ],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    const obs = record.observations[0]
    expect(obs?.verdict).toBe('fail')
    expect(obs?.finding?.evidence.errors[0]?.message).toContain('last')
    expect(obs?.finding?.annex.attempts?.[0]?.retry).toBe(0)
  })
})

describe('instrumentConfigDigest (F2, docs/compositions/playwright-native-1.md §4)', () => {
  it('(h) changes when shard changes', () => {
    const base = baseCapture()
    const withShard = baseCapture({
      config: baseConfig([project('chromium')]),
    })
    withShard.config.shard = { total: 2, current: 1 }
    expect(instrumentConfigDigest(withShard)).not.toBe(
      instrumentConfigDigest(base),
    )
  })

  it('(h) changes when grep changes', () => {
    const base = baseCapture()
    const withGrep = baseCapture({
      config: {
        ...baseConfig([project('chromium')]),
        grep: { __regexp: '/foo/' },
      },
    })
    expect(instrumentConfigDigest(withGrep)).not.toBe(
      instrumentConfigDigest(base),
    )
  })

  it('(h) changes when the projects set changes', () => {
    const base = baseCapture()
    const withMoreProjects = baseCapture({
      config: baseConfig([project('chromium'), project('firefox')]),
    })
    expect(instrumentConfigDigest(withMoreProjects)).not.toBe(
      instrumentConfigDigest(base),
    )
  })

  it('(h) is unaffected by testDir/reporter, which Capture["config"] structurally never carries', () => {
    const base = baseCapture()
    const digestBase = instrumentConfigDigest(base)

    // Capture['config'] has no testDir/reporter fields at all (§4 "no" rows
    // — see capture.ts); simulate a channel that smuggled them in anyway and
    // confirm instrumentConfigDigest still ignores them (reads only its
    // named properties).
    const withExtraneous = baseCapture()
    ;(withExtraneous.config as unknown as Record<string, unknown>).testDir =
      '/abs/path/to/project'
    ;(withExtraneous.config as unknown as Record<string, unknown>).reporter = [
      ['list', null],
    ]
    expect(instrumentConfigDigest(withExtraneous)).toBe(digestBase)
  })
})

describe('context_digest (F2)', () => {
  it("(i) changes when an attachment's body_digest changes", () => {
    const worktree = makeScratchDir('vdelta-pw-i-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')

    function attachment(bodyDigest: string | null): CapturedPwAttachment {
      return {
        name: 'trace.zip',
        content_type: 'application/zip',
        body_digest: bodyDigest,
      }
    }

    function captureWithAttachment(bodyDigest: string | null): Capture {
      return baseCapture({
        tests: [
          reportedTest({
            projectName: 'chromium',
            fileAbs,
            titles: ['t'],
            attempts: [
              attempt('failed', {
                errors: [error()],
                attachments: [attachment(bodyDigest)],
              }),
            ],
          }),
        ],
      })
    }

    const recordA = buildRunRecord(
      captureWithAttachment('sha256:aaaa'),
      baseCtx(worktree),
    )
    const recordB = buildRunRecord(
      captureWithAttachment('sha256:bbbb'),
      baseCtx(worktree),
    )

    expect(recordA.observations[0]?.finding?.context_digest).not.toBe(
      recordB.observations[0]?.finding?.context_digest,
    )
    expect(recordA.observations[0]?.finding?.annex.attachments).toEqual([
      attachment('sha256:aaaa'),
    ])
  })
})

describe('ANSI stripping (F2)', () => {
  it('(j) strips ANSI escapes from the message before redaction/digesting', () => {
    const worktree = makeScratchDir('vdelta-pw-j-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          attempts: [
            attempt('failed', {
              errors: [error({ message: '[31mError: boom[39m' })],
            }),
          ],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    const message = record.observations[0]?.finding?.evidence.errors[0]?.message
    expect(message).toBe('Error: boom')
    expect(message?.includes(String.fromCharCode(27))).toBe(false)
  })
})

describe('verdict mapping (F2, INV-3)', () => {
  it('maps expected fail + actual fail to xfail with suppression marker "fail"', () => {
    const worktree = makeScratchDir('vdelta-pw-xfail-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          expected_status: 'failed',
          attempts: [attempt('failed', { errors: [error()] })],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    expect(record.observations[0]?.verdict).toBe('xfail')
    expect(record.observations[0]?.suppression).toEqual({ marker: 'fail' })
    expect(record.observations[0]?.finding).toBeUndefined()
  })

  it('maps expected fail + actual pass (unexpected pass) to fail with no finding', () => {
    const worktree = makeScratchDir('vdelta-pw-unexpass-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          expected_status: 'failed',
          attempts: [attempt('passed', { errors: [] })],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    expect(record.observations[0]?.verdict).toBe('fail')
    expect(record.observations[0]?.finding).toBeUndefined()
  })

  it('maps status "interrupted" to not_run', () => {
    const worktree = makeScratchDir('vdelta-pw-interrupted-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['t'],
          attempts: [attempt('interrupted')],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    expect(record.observations[0]?.verdict).toBe('not_run')
  })

  it('maps skip via annotations.type "fixme" to marker "fixme", and falls back to "runtime" with no annotation', () => {
    const worktree = makeScratchDir('vdelta-pw-skipmarker-')
    const fileAbs = writeTestFile(worktree, 'tests/app.spec.ts')
    const capture = baseCapture({
      tests: [
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['fixme case'],
          annotations: [{ type: 'fixme' }],
          attempts: [attempt('skipped')],
        }),
        reportedTest({
          projectName: 'chromium',
          fileAbs,
          titles: ['runtime case'],
          annotations: [],
          attempts: [attempt('skipped')],
        }),
      ],
    })

    const record = buildRunRecord(capture, baseCtx(worktree))
    const fixmeObs = record.observations.find((o) =>
      o.test_id.endsWith('fixme case'),
    )
    const runtimeObs = record.observations.find((o) =>
      o.test_id.endsWith('runtime case'),
    )
    expect(fixmeObs?.suppression).toEqual({ marker: 'fixme' })
    expect(runtimeObs?.suppression).toEqual({ marker: 'runtime' })
  })
})

describe('buildRunRecord basics (F2)', () => {
  it('rejects a capture_version other than 1 with a RecorderError', () => {
    const worktree = makeScratchDir('vdelta-pw-version-')
    const capture = { ...baseCapture(), capture_version: 2 }
    expect(() => buildRunRecord(capture, baseCtx(worktree))).toThrow(
      RecorderError,
    )
  })

  it('writes the playwright declaration into instrument.capabilities and composition_id', () => {
    const worktree = makeScratchDir('vdelta-pw-caps-')
    const record = buildRunRecord(baseCapture(), baseCtx(worktree))
    expect(record.instrument.composition_id).toBe('playwright-native/1')
    expect(record.instrument.capabilities).toEqual({
      verdicts: 'pass',
      'source-location': 'pass',
      suppression: 'pass',
      inventory: 'pass',
      'failure-evidence': 'pass',
      'source-region-text': 'pass',
      'retry-evidence': 'pass',
      'resolved-config-coverage': 'unsupported',
    })
  })

  it('sets completeness.status "crashed" when unhandled_errors > 0', () => {
    const worktree = makeScratchDir('vdelta-pw-crashed-')
    const record = buildRunRecord(
      baseCapture({ unhandled_errors: 1 }),
      baseCtx(worktree),
    )
    expect(record.completeness.status).toBe('crashed')
    expect(record.completeness.module_errors).toEqual([])
  })

  it('sets completeness.status "partial" when capture.status is "interrupted"', () => {
    const worktree = makeScratchDir('vdelta-pw-partial-')
    const record = buildRunRecord(
      baseCapture({ status: 'interrupted' }),
      baseCtx(worktree),
    )
    expect(record.completeness.status).toBe('partial')
  })
})
