/**
 * Capture interchange format between the in-process vitest reporter and the
 * out-of-process recorder (`vdelta run`). Raw structured-channel data only;
 * canonicalization/redaction/digesting happen in the recorder.
 */

export const CAPTURE_VERSION = 1

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
  }
  tests: CapturedTest[]
  module_errors: { rel: string; messages: string[] }[]
}
