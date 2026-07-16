/**
 * vitest v4 Reporter (Reported Tasks API) — the vdelta capture side of the
 * adapter. Structured-first (§12): consumes only the runner's structured
 * channel (TestCase results, options, locations, console callbacks), never
 * rendered output. Writes a Capture dump to $VDELTA_CAPTURE_FILE at run end;
 * without that env var it is inert, so it can stay permanently configured in
 * a project's vitest config (ambient recording, §4.2).
 */
import { writeFileSync } from 'node:fs'
import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from 'vitest/node'
import { CAPTURE_VERSION, type Capture, type CapturedError, type CapturedTest } from './capture.js'

type SerializedErrorLike = {
  name?: unknown
  message?: unknown
  expected?: unknown
  actual?: unknown
  operator?: unknown
  stacks?: { file?: unknown; line?: unknown; column?: unknown }[]
}

export default class VdeltaReporter implements Reporter {
  private ctx: Vitest | undefined
  private consoleByTask = new Map<string, { type: string; content: string }[]>()

  onInit(ctx: Vitest): void {
    this.ctx = ctx
  }

  onTestRunStart(_specifications: readonly TestSpecification[]): void {
    this.consoleByTask.clear()
  }

  onUserConsoleLog(log: { taskId?: string; type: string; content: string }): void {
    if (log.taskId === undefined) return
    const entries = this.consoleByTask.get(log.taskId) ?? []
    entries.push({ type: log.type, content: log.content })
    this.consoleByTask.set(log.taskId, entries)
  }

  onTestRunEnd(
    testModules: readonly TestModule[],
    unhandledErrors: readonly unknown[],
    reason: 'passed' | 'interrupted' | 'failed',
  ): void {
    const outFile = process.env.VDELTA_CAPTURE_FILE
    if (outFile === undefined || outFile === '') return

    const tests: CapturedTest[] = []
    const moduleErrors: Capture['module_errors'] = []
    for (const mod of testModules) {
      const modErrors = mod.errors()
      if (modErrors.length > 0) {
        moduleErrors.push({
          rel: mod.relativeModuleId,
          messages: modErrors.map((e) => String((e as { message?: unknown }).message ?? '')),
        })
      }
      for (const tc of mod.children.allTests()) {
        tests.push(this.captureTest(tc))
      }
    }

    const config = this.ctx?.config
    const chaiConfig = (config as { chaiConfig?: { truncateThreshold?: number } } | undefined)
      ?.chaiConfig
    const capture: Capture = {
      capture_version: CAPTURE_VERSION,
      runner: 'vitest',
      runner_version: this.ctx?.version ?? 'unknown',
      reason,
      unhandled_errors: unhandledErrors.length,
      config: {
        include_task_location:
          (config as { includeTaskLocation?: boolean } | undefined)?.includeTaskLocation === true,
        truncate_threshold: chaiConfig?.truncateThreshold ?? null,
      },
      tests,
      module_errors: moduleErrors,
    }
    writeFileSync(outFile, JSON.stringify(capture))
  }

  private captureTest(tc: TestCase): CapturedTest {
    const result = tc.result()
    const diagnostic = tc.diagnostic()
    const errors: CapturedError[] = (result.errors ?? []).map((e) => {
      const err = e as SerializedErrorLike
      return {
        name: typeof err.name === 'string' ? err.name : 'Error',
        message: typeof err.message === 'string' ? err.message : String(err.message ?? ''),
        ...(typeof err.expected === 'string' ? { expected: err.expected } : {}),
        ...(typeof err.actual === 'string' ? { actual: err.actual } : {}),
        ...(typeof err.operator === 'string' ? { operator: err.operator } : {}),
        frames: (err.stacks ?? [])
          .filter(
            (f): f is { file: string; line: number; column: number } =>
              typeof f.file === 'string' && typeof f.line === 'number' && typeof f.column === 'number',
          )
          .map((f) => ({ file: f.file, line: f.line, column: f.column })),
      }
    })
    return {
      rel: tc.module.relativeModuleId,
      module_id: tc.module.moduleId,
      full_name: tc.fullName,
      state: result.state,
      mode: tc.options.mode,
      fails: tc.options.fails === true,
      ...(result.state === 'skipped' && result.note !== undefined ? { note: result.note } : {}),
      location_line: tc.location?.line ?? null,
      errors,
      console: this.consoleByTask.get(tc.id) ?? [],
      duration_us:
        result.state === 'passed' || result.state === 'failed'
          ? Math.round((diagnostic?.duration ?? 0) * 1000)
          : null,
    }
  }
}

export { VdeltaReporter }
