/**
 * Playwright Reporter (`@playwright/test/reporter`) — the vdelta capture
 * side of the playwright adapter. Type-only import of `@playwright/test`:
 * veridelta ships zero runtime dependencies, so this file must not import
 * any playwright *value* (only `import type`). Structured-first (§12):
 * consumes only the runner's structured channel (TestCase/TestResult
 * fields), never rendered output. Writes a Capture dump to
 * $VDELTA_CAPTURE_FILE at run end; without that env var it is inert, so it
 * can stay permanently configured in a project's playwright config (ambient
 * recording, §4.2 — same convention as `../vitest/reporter.ts:123-124`).
 *
 * playwright's `error.message` can contain ANSI escapes (observed in
 * `probes/playwright-0b-core/observations/failures.json`); this reporter
 * writes it through unstripped. Stripping is the recorder's job, matching
 * the vitest adapter's division of labor (canonicalization lives in the
 * recorder, not the capture channel).
 *
 * This source file is `.cts` (not `.ts`), so `tsc` emits it as CommonJS
 * (`dist/adapters/playwright/reporter.cjs`) even though the package is
 * `"type": "module"`. That is deliberate: playwright 1.49.1's
 * `node_modules/playwright/lib/util.js:272-277` `fileIsModule()` treats a
 * `.js` file under `"type": "module"` as ESM and loads it through
 * `node_modules/playwright/lib/transform/transform.js:225-231`
 * `requireOrImport()`'s `eval("import(...)")` branch — in this environment
 * that dynamic `import()` promise never settles, hanging the run
 * indefinitely (observed/BLOCKED). `fileIsModule()` treats `.cjs`/`.cts`
 * as CommonJS unconditionally, which routes through the `require(file)`
 * branch instead — the same branch confirmed to complete normally.
 * Do not reintroduce an ESM `dist/adapters/playwright/reporter.js` as the
 * file playwright's `--reporter` flag loads.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter'
import type {
  Capture,
  CapturedPwAttachment,
  CapturedPwAttempt,
  CapturedPwError,
  CapturedPwFrame,
  CapturedPwTest,
  CapturedPwUnreportedTest,
} from './capture.js'

/**
 * Local copy of `capture.ts`'s `CAPTURE_VERSION`, kept in lockstep via
 * `satisfies` rather than a runtime import: `capture.ts` lives under
 * `"type": "module"` (ESM), and a `.cts` file importing an ESM *value*
 * either fails to compile (TS1479) or risks `ERR_REQUIRE_ESM` at runtime
 * (node 22.0–22.11, before `require(esm)` was unflagged). `import type`
 * (above) is erased at compile time and carries no such risk; this
 * `satisfies` clause makes any future change to `capture.ts`'s
 * `CAPTURE_VERSION` a compile-time error here instead of a silent drift.
 */
const CAPTURE_VERSION =
  1 satisfies typeof import('./capture.js')['CAPTURE_VERSION']

/**
 * Recursively serializes a resolved-config-shaped value into JSON-safe data:
 * `RegExp` becomes its `.toString()` form, circular object references become
 * the string `'[Circular]'`, and function-valued properties are dropped
 * (never appear as a key in the output). Used for `grep`/`grepInvert` and
 * per-project `testMatch`/`testIgnore`/`use`, all of which can carry `RegExp`
 * values in playwright's resolved `FullConfig`/`FullProject`.
 */
export function safeSerialize(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (value instanceof RegExp) return value.toString()
  const t = typeof value
  if (t === 'function') return undefined
  if (t !== 'object') return value
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => safeSerialize(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = safeSerialize(v, seen)
    if (s !== undefined) out[k] = s
  }
  return out
}

/**
 * Defensive-cast the playwright resolved config (`FullConfig`, as given to
 * `onBegin`) into `Capture['config']` (the §4-judged-`yes` covering set).
 * Pure function so the cast rules are unit-testable without a running
 * playwright test run.
 */
export function serializeConfig(config: FullConfig): Capture['config'] {
  return {
    fullyParallel: config.fullyParallel,
    workers: config.workers,
    shard: config.shard,
    forbidOnly: config.forbidOnly,
    maxFailures: config.maxFailures,
    grep: safeSerialize(config.grep),
    grepInvert: safeSerialize(config.grepInvert),
    globalTimeout: config.globalTimeout,
    projects: config.projects.map((p) => ({
      name: p.name,
      testMatch: safeSerialize(p.testMatch),
      testIgnore: safeSerialize(p.testIgnore),
      dependencies: [...p.dependencies],
      retries: p.retries,
      timeout: p.timeout,
      use: safeSerialize(p.use),
    })),
  }
}

/**
 * Deterministically parses `at <symbol> (<file>:<line>:<column>)` frames out
 * of a raw error stack string — the same regex rule as
 * `probes/playwright-0b-core/project/scripts/analyze-stability.mjs`'s
 * `findEnclosingFrame`, applied to every matching line rather than just the
 * first. Anonymous frames (no named symbol, no parens) do not match, by
 * design (same rule as the probe). Returns `[]` for an undefined/empty
 * stack.
 */
export function parseStackFrames(stack: string | undefined): CapturedPwFrame[] {
  if (stack === undefined || stack === '') return []
  const frames: CapturedPwFrame[] = []
  const re = /at\s+[\w$.]+\s+\(([^)]+):(\d+):(\d+)\)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(stack)) !== null) {
    const file = m[1]
    const line = m[2]
    const column = m[3]
    if (file === undefined || line === undefined || column === undefined)
      continue
    frames.push({ file, line: Number(line), column: Number(column) })
  }
  return frames
}

/**
 * `TestCase.titlePath()` is `['', project, file, ...titles]` (root suite
 * title is always `''`, then the project suite title, then the file suite
 * title). Strips those first three entries, leaving the describe/test title
 * chain.
 */
export function titlesFromTitlePath(titlePath: readonly string[]): string[] {
  return titlePath.slice(3)
}

/** The project name is `titlePath()[1]` — `''` if the path is malformed/short. */
export function projectFromTitlePath(titlePath: readonly string[]): string {
  return titlePath[1] ?? ''
}

/**
 * Appends `attempt` to `existing` and returns a new array sorted by `retry`
 * ascending. Playwright calls `onTestEnd` once per attempt for the same
 * `TestCase.id` (retries), so the reporter aggregates by folding each new
 * result through this pure function; sorting keeps the aggregation
 * deterministic even if attempts arrive out of order (e.g. under
 * `--repeat-each`, where a single id's retries interleave with other
 * repeats' worker scheduling).
 */
export function aggregateAttempts(
  existing: readonly CapturedPwAttempt[],
  attempt: CapturedPwAttempt,
): CapturedPwAttempt[] {
  return [...existing, attempt].sort((a, b) => a.retry - b.retry)
}

function stdioEntryText(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8')
}

function captureError(error: TestError): CapturedPwError {
  const location = error.location
  return {
    message: typeof error.message === 'string' ? error.message : '',
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    ...(location !== undefined
      ? {
          location: {
            file: location.file,
            line: location.line,
            column: location.column,
          },
        }
      : {}),
    frames: parseStackFrames(error.stack),
  }
}

function digestAttachmentBody(attachment: {
  name: string
  contentType: string
  path?: string
  body?: Buffer
}): CapturedPwAttachment {
  let bodyDigest: string | null = null
  if (attachment.body !== undefined) {
    bodyDigest = createHash('sha256').update(attachment.body).digest('hex')
  } else if (typeof attachment.path === 'string') {
    try {
      bodyDigest = createHash('sha256')
        .update(readFileSync(attachment.path))
        .digest('hex')
    } catch {
      bodyDigest = null
    }
  }
  return {
    name: attachment.name,
    content_type: attachment.contentType,
    body_digest: bodyDigest,
  }
}

function captureAttempt(result: TestResult): CapturedPwAttempt {
  return {
    status: result.status,
    retry: result.retry,
    errors: result.errors.map(captureError),
    stdio: [
      ...result.stdout.map((s) => ({
        type: 'stdout' as const,
        text: stdioEntryText(s),
      })),
      ...result.stderr.map((s) => ({
        type: 'stderr' as const,
        text: stdioEntryText(s),
      })),
    ],
    attachments: result.attachments.map(digestAttachmentBody),
    duration_ms: result.duration,
  }
}

function captureAnnotations(
  annotations: readonly { type: string; description?: string }[],
): { type: string; description?: string }[] {
  return annotations.map((a) =>
    a.description !== undefined
      ? { type: a.type, description: a.description }
      : { type: a.type },
  )
}

function describeTest(test: TestCase): CapturedPwUnreportedTest {
  const titlePath = test.titlePath()
  return {
    test_case_id: test.id,
    file_abs: test.location.file,
    project: projectFromTitlePath(titlePath),
    titles: titlesFromTitlePath(titlePath),
    location_line: test.location.line ?? null,
    expected_status: test.expectedStatus,
    annotations: captureAnnotations(test.annotations),
  }
}

export default class VdeltaPlaywrightReporter implements Reporter {
  private configDump: Capture['config'] | undefined
  private configFile: string | undefined
  private runnerVersion = 'unknown'
  private rootSuite: Suite | undefined
  private unhandledErrorCount = 0
  private metaById = new Map<string, CapturedPwUnreportedTest>()
  private attemptsById = new Map<string, CapturedPwAttempt[]>()

  private get active(): boolean {
    const outFile = process.env.VDELTA_CAPTURE_FILE
    return outFile !== undefined && outFile !== ''
  }

  onBegin(config: FullConfig, suite: Suite): void {
    if (!this.active) return
    this.configDump = serializeConfig(config)
    this.configFile =
      typeof config.configFile === 'string' && config.configFile !== ''
        ? config.configFile
        : undefined
    this.runnerVersion = config.version
    this.rootSuite = suite
  }

  onError(_error: TestError): void {
    if (!this.active) return
    this.unhandledErrorCount += 1
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.active) return
    const id = test.id
    if (!this.metaById.has(id)) this.metaById.set(id, describeTest(test))
    const existing = this.attemptsById.get(id) ?? []
    this.attemptsById.set(
      id,
      aggregateAttempts(existing, captureAttempt(result)),
    )
  }

  onEnd(result: FullResult): void {
    if (!this.active) return
    const outFile = process.env.VDELTA_CAPTURE_FILE
    if (outFile === undefined || outFile === '') return

    const tests: CapturedPwTest[] = []
    for (const [id, meta] of this.metaById) {
      tests.push({ ...meta, attempts: this.attemptsById.get(id) ?? [] })
    }

    const allTests = this.rootSuite?.allTests() ?? []
    const unreportedTests: CapturedPwUnreportedTest[] = allTests
      .filter((t) => !this.metaById.has(t.id))
      .map((t) => describeTest(t))

    const capture: Capture = {
      capture_version: CAPTURE_VERSION,
      runner: 'playwright',
      runner_version: this.runnerVersion,
      status: result.status,
      unhandled_errors: this.unhandledErrorCount,
      config: this.configDump ?? {
        fullyParallel: false,
        workers: 0,
        shard: null,
        forbidOnly: false,
        maxFailures: 0,
        grep: null,
        grepInvert: null,
        globalTimeout: 0,
        projects: [],
      },
      tests,
      unreported_tests: unreportedTests,
      config_files: this.configFile !== undefined ? [this.configFile] : [],
    }
    writeFileSync(outFile, JSON.stringify(capture))
  }

  printsToStdio(): boolean {
    return false
  }
}

export { VdeltaPlaywrightReporter }
