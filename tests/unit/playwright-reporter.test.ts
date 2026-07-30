/**
 * Pure helpers exported from `src/adapters/playwright/reporter.cts` (F1):
 * `safeSerialize`, `parseStackFrames`, `titlesFromTitlePath` /
 * `projectFromTitlePath`, and `aggregateAttempts`. Exercised standalone
 * (no running playwright test run) — the reporter class itself is a thin
 * wrapper that folds `TestCase`/`TestResult` through these functions.
 *
 * Imports the *built* `dist/adapters/playwright/reporter.cjs`, not the
 * `.cts` source: Vite's default oxc transform include regex
 * (`/\.(m?ts|[jt]sx)$/` — `node_modules/vite/dist/node/chunks/node.js`)
 * does not match `.cts`, so a `.cts` (or `.cjs`-resolved-to-`.cts`) source
 * specifier fails to have its TypeScript syntax stripped and errors at
 * parse time. `npm test`/`test:unit` in CI always run after `npm run
 * build` (`.github/workflows/ci.yml`), so the compiled `.cjs` is present.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateAttempts,
  parseStackFrames,
  projectFromTitlePath,
  safeSerialize,
  titlesFromTitlePath,
} from '../../dist/adapters/playwright/reporter.cjs'

describe('safeSerialize', () => {
  it('turns a RegExp into its .toString() form', () => {
    expect(safeSerialize(/(auth|session)\.spec\.ts/)).toBe(
      '/(auth|session)\\.spec\\.ts/',
    )
  })

  it('turns a circular object reference into the string [Circular]', () => {
    const obj: Record<string, unknown> = { name: 'launchOptions' }
    obj.self = obj
    expect(safeSerialize(obj)).toEqual({
      name: 'launchOptions',
      self: '[Circular]',
    })
  })

  it('drops function-valued properties entirely (missing key, not undefined)', () => {
    const result = safeSerialize({ a: 1, fn: () => 'x' }) as Record<
      string,
      unknown
    >
    expect(result).toEqual({ a: 1 })
    expect('fn' in result).toBe(false)
  })

  it('recurses through arrays and nested objects, preserving primitives', () => {
    expect(
      safeSerialize([1, 'x', { re: /abc/, nested: { flag: true } }]),
    ).toEqual([1, 'x', { re: '/abc/', nested: { flag: true } }])
  })

  it('passes null and primitives through unchanged', () => {
    expect(safeSerialize(null)).toBe(null)
    expect(safeSerialize(42)).toBe(42)
    expect(safeSerialize('plain')).toBe('plain')
  })
})

describe('parseStackFrames', () => {
  it('parses every named at-frame (symbol (file:line:col)) in order', () => {
    // Realistic shape (observations/failures.json): a named helper frame
    // followed by an anonymous call-site frame with no parens.
    const stack = [
      'Error: object shape mismatch',
      '    at assertObjectShape (/repo/tests/app.spec.ts:35:28)',
      '    at TestCaseRun (/repo/node_modules/playwright/lib/worker.js:88:20)',
    ].join('\n')
    expect(parseStackFrames(stack)).toEqual([
      { file: '/repo/tests/app.spec.ts', line: 35, column: 28 },
      {
        file: '/repo/node_modules/playwright/lib/worker.js',
        line: 88,
        column: 20,
      },
    ])
  })

  it('skips anonymous frames without a parenthesized file:line:col (same rule as the probe)', () => {
    const stack = ['Error: boom', '    at /repo/tests/app.spec.ts:12:5'].join(
      '\n',
    )
    expect(parseStackFrames(stack)).toEqual([])
  })

  it('returns [] for undefined or empty stack', () => {
    expect(parseStackFrames(undefined)).toEqual([])
    expect(parseStackFrames('')).toEqual([])
  })

  it('tolerates ANSI escapes surrounding a frame line (not stripped first)', () => {
    const stack =
      '[2m    at assertObjectShape (/repo/tests/app.spec.ts:1:1)[22m'
    // ANSI codes fall outside the `at ... (...)` capture groups, so the
    // frame still parses even though the raw string is not stripped first
    // (stripping is the recorder's job — this reporter passes it through).
    expect(parseStackFrames(stack)).toEqual([
      { file: '/repo/tests/app.spec.ts', line: 1, column: 1 },
    ])
  })
})

describe('titlesFromTitlePath / projectFromTitlePath', () => {
  const titlePath = [
    '',
    'chromium',
    'tests/app.spec.ts',
    'a group',
    'the test title',
  ]

  it('strips the leading empty-root / project / file entries', () => {
    expect(titlesFromTitlePath(titlePath)).toEqual([
      'a group',
      'the test title',
    ])
  })

  it('matches the flaky.json probe observation shape (no describe group)', () => {
    // observations/flaky.json: titlePath === ["", "setup", "tests/auth.setup.ts", "authenticate"]
    expect(
      titlesFromTitlePath(['', 'setup', 'tests/auth.setup.ts', 'authenticate']),
    ).toEqual(['authenticate'])
  })

  it('extracts the project name at index 1', () => {
    expect(projectFromTitlePath(titlePath)).toBe('chromium')
  })

  it('falls back to empty string for a short/malformed titlePath', () => {
    expect(projectFromTitlePath([''])).toBe('')
    expect(titlesFromTitlePath([''])).toEqual([])
  })
})

describe('aggregateAttempts', () => {
  function attempt(retry: number, status: 'passed' | 'failed' = 'passed') {
    return {
      status,
      retry,
      errors: [],
      stdio: [],
      attachments: [],
      duration_ms: 10,
    }
  }

  it('appends a new attempt to an empty list', () => {
    expect(aggregateAttempts([], attempt(0))).toEqual([attempt(0)])
  })

  it('accumulates repeated onTestEnd calls for the same test id, in retry order', () => {
    // Real playwright observation (observations/flaky.json): retry:0 failed,
    // then retry:1 passed — two separate onTestEnd calls for the same
    // TestCase.id, aggregated into a single attempts[] via repeated folds.
    let attempts = aggregateAttempts([], attempt(0, 'failed'))
    attempts = aggregateAttempts(attempts, attempt(1, 'passed'))
    expect(attempts).toEqual([attempt(0, 'failed'), attempt(1, 'passed')])
  })

  it('sorts by retry ascending even when appended out of order', () => {
    let attempts = aggregateAttempts([], attempt(2))
    attempts = aggregateAttempts(attempts, attempt(0))
    attempts = aggregateAttempts(attempts, attempt(1))
    expect(attempts.map((a) => a.retry)).toEqual([0, 1, 2])
  })

  it('does not mutate the existing array (returns a new one)', () => {
    const existing = aggregateAttempts([], attempt(0))
    const next = aggregateAttempts(existing, attempt(1))
    expect(existing).toHaveLength(1)
    expect(next).toHaveLength(2)
  })
})
