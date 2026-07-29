/**
 * Capture interchange format between the in-process vitest reporter and the
 * out-of-process recorder (`vdelta run`). Raw structured-channel data only;
 * canonicalization/redaction/digesting happen in the recorder.
 */

export const CAPTURE_VERSION = 3

export interface CapturedError {
  name: string
  message: string
  expected?: string
  actual?: string
  operator?: string
  frames: { file: string; line: number; column: number }[]
}

export interface CapturedTest {
  rel: string
  module_id: string
  full_name: string
  state: 'passed' | 'failed' | 'skipped' | 'pending'
  mode: 'run' | 'only' | 'skip' | 'todo'
  fails: boolean
  note?: string
  location_line: number | null
  errors: CapturedError[]
  console: { type: string; content: string }[]
  duration_us: number | null
}

export interface Capture {
  capture_version: number
  runner: 'vitest'
  runner_version: string
  reason: 'passed' | 'failed' | 'interrupted'
  unhandled_errors: number
  config: {
    include_task_location: boolean
    truncate_threshold: number | null
    environment: string
    pool: string
    isolate: boolean
    retry: number
    test_timeout: number | null
    /**
     * Absolute paths, already `resolvePath`-resolved by vitest's
     * `resolveConfig` (node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js
     * around line 340). The recorder normalizes each into a
     * `surface.config_sources`-style key (worktree-relative, or
     * `external:<abs path>`) when digesting; this field never carries file
     * *content*, only which setup files would run.
     */
    setup_files: string[]
    sequence: {
      /**
       * `Function.name` of the resolved sequencer class (e.g.
       * `'BaseSequencer'`, `'RandomSequencer'`), or `null` if unresolved.
       * vitest 4's `resolveConfig` normalizes `sequence.shuffle`'s
       * `{files, tests}` object form: `shuffle` becomes the `tests` boolean,
       * and a `files: true` shuffle survives only as
       * `sequence.sequencer === RandomSequencer`
       * (coverage.DM_a_rWm.js:470-481). Capturing the sequencer name is the
       * only way files-shuffle stays covered by config_digest.
       */
      sequencer: string | null
      shuffle_tests: boolean
      concurrent: boolean
      seed: number | null
    }
  }
  tests: CapturedTest[]
  module_errors: { rel: string; messages: string[] }[]
  /**
   * Absolute paths of the config files vite/vitest actually resolved for this
   * run: the union of `configFile` and `configFileDependencies` across the
   * global vite dev server and every workspace `TestProject`'s dev server.
   * Sorted and deduped by the reporter. The recorder digests each of these
   * paths directly (no more decide-file-name guessing) and keys the result
   * with a worktree-relative path, or `external:<abs path>` for anything
   * outside the worktree.
   */
  config_files: string[]
}
