/**
 * Capture interchange format between the in-process playwright reporter and
 * the out-of-process recorder (`vdelta run`). Raw structured-channel data
 * only; canonicalization/redaction/digesting happen in the recorder (mirrors
 * `../vitest/capture.ts`). Field names diverge where playwright's structured
 * channel differs from vitest's: test IDs are project-scoped
 * (`TestCase.id`), results are per-attempt (retries produce multiple
 * `onTestEnd` calls for the same test), and dependency-skip cascades can
 * leave whole projects unreported (`unreported_tests`).
 */

export const CAPTURE_VERSION = 1

export interface CapturedPwFrame {
  file: string
  line: number
  column: number
}

export interface CapturedPwError {
  message: string
  stack?: string
  location?: { file: string; line: number; column: number }
  /**
   * Deterministically parsed from `stack` (named `at symbol (file:line:col)`
   * frames only — see `parseStackFrames` in `reporter.ts`). Used by the
   * recorder to reconstruct a line-shift-stable failing source region
   * without relying on the runner's rendered `snippet` (CE-4).
   */
  frames: CapturedPwFrame[]
}

export interface CapturedPwAttachment {
  name: string
  content_type: string
  /**
   * sha256 hex digest of the attachment body (from `body` if present,
   * otherwise read from `path`). `null` when neither is readable. The
   * absolute path string itself is never carried into the capture.
   */
  body_digest: string | null
}

export interface CapturedPwAttempt {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
  retry: number
  errors: CapturedPwError[]
  stdio: { type: 'stdout' | 'stderr'; text: string }[]
  attachments: CapturedPwAttachment[]
  duration_ms: number
}

interface CapturedPwTestMeta {
  test_case_id: string
  file_abs: string
  project: string
  /** `titlePath()` with the leading `''` / project / file entries removed. */
  titles: string[]
  location_line: number | null
  expected_status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
  annotations: { type: string; description?: string }[]
}

export interface CapturedPwTest extends CapturedPwTestMeta {
  attempts: CapturedPwAttempt[]
}

/**
 * A `TestCase` that `allTests()` enumerates but that never reached
 * `onTestEnd` (e.g. blocked by a failed `dependencies` project). No attempts
 * exist for it, so it carries the same identifying fields as
 * `CapturedPwTest` minus `attempts`.
 */
export type CapturedPwUnreportedTest = CapturedPwTestMeta

export interface CapturedPwProjectConfig {
  name: string
  /** `RegExp`/array entries safe-serialized (`.toString()`), see `safeSerialize`. */
  testMatch: unknown
  testIgnore: unknown
  dependencies: string[]
  retries: number
  timeout: number
  /** `use` safe-serialized; may contain absolute paths (e.g. `launchOptions.executablePath`). */
  use: unknown
}

export interface Capture {
  capture_version: number
  runner: 'playwright'
  runner_version: string
  status: 'passed' | 'failed' | 'timedout' | 'interrupted'
  unhandled_errors: number
  /**
   * Only the fields `docs/compositions/playwright-native-1.md` §4 judges
   * `yes` (evidence-affecting / test-selection-affecting). `reporter` is
   * omitted (§4 `no`); `testDir`/`rootDir`/`configFile` are omitted (§4 `no`
   * — absolute-path administrative values, see `config_files` instead).
   */
  config: {
    fullyParallel: boolean
    workers: number
    shard: { total: number; current: number } | null
    forbidOnly: boolean
    maxFailures: number
    grep: unknown
    grepInvert: unknown
    globalTimeout: number
    projects: CapturedPwProjectConfig[]
  }
  tests: CapturedPwTest[]
  unreported_tests: CapturedPwUnreportedTest[]
  /** `[config.configFile]` when playwright resolved one, else `[]`. */
  config_files: string[]
}
