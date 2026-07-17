/**
 * Regression tests for issue #12: on some platforms/downstream consumers,
 * `process.exit()` called immediately after a large `stream.write()` can
 * truncate the write before libuv has flushed it to the pipe. These tests
 * spawn the *built* CLI (not the in-process functions) so the truncation
 * bug — which only manifests when stdout/stderr are real pipes — has a
 * chance to reproduce.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildComparisonReport,
  parseRunRecord,
  type RunRecord,
  RunStore,
  SCHEMA_VERSION,
  type TestObservation,
} from '../../src/index.js'

const execFileP = promisify(execFile)

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

const workspaces: string[] = []

afterEach(() => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()!
    rmSync(ws, { recursive: true, force: true })
  }
})

interface SpawnResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

function spawnCli(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      })
    })
  })
}

function repeatPattern(pattern: string, size: number): string {
  return pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size)
}

describe('CLI stdout/stderr flush (issue #12 regression)', () => {
  it('degraded passthrough transports >1MB of child stdout/stderr byte-exact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vdelta-flush-'))
    workspaces.push(workspace)

    // Deterministic, non-UTF-8-ambiguous patterns for stdout/stderr so a
    // truncation shows up as a length/content mismatch, not a decode error.
    const stdoutPattern = '0123456789abcdef'
    const stdoutSize = 2 * 1024 * 1024
    const stderrPattern = 'fedcba9876543210'
    const stderrSize = 64 * 1024

    const expectedStdout = Buffer.from(repeatPattern(stdoutPattern, stdoutSize))
    const expectedStderrChunk = repeatPattern(stderrPattern, stderrSize)

    // The child must not call process.exit() itself: an early exit would let
    // the child's own writes race libuv the same way (issue #12), which
    // would make this a test of the child, not of vdelta's CLI.
    const scriptPath = join(workspace, 'child.js')
    writeFileSync(
      scriptPath,
      [
        `const stdoutChunk = ${JSON.stringify(stdoutPattern)}.repeat(${Math.ceil(stdoutSize / stdoutPattern.length)}).slice(0, ${stdoutSize})`,
        'process.stdout.write(stdoutChunk)',
        `const stderrChunk = ${JSON.stringify(stderrPattern)}.repeat(${Math.ceil(stderrSize / stderrPattern.length)}).slice(0, ${stderrSize})`,
        'process.stderr.write(stderrChunk)',
        '',
      ].join('\n'),
    )

    const result = await spawnCli(
      ['run', '--', process.execPath, scriptPath],
      workspace,
    )

    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(expectedStdout.length)
    expect(result.stdout.equals(expectedStdout)).toBe(true)

    const stderrText = result.stderr.toString('utf8')
    expect(stderrText).toContain('vdelta: degraded to raw passthrough')
    expect(stderrText).toContain(expectedStderrChunk)
  })

  it('compare --report json transports a >1MB report byte-exact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vdelta-flush-'))
    workspaces.push(workspace)

    await execFileP('git', ['init', '-b', 'main'], { cwd: workspace })

    const OBSERVATION_COUNT = 8000
    const testId = (i: number): string =>
      `suite > case ${i} > ${'x'.repeat(100)}`

    const baseFields = {
      schema_version: SCHEMA_VERSION,
      repo: {
        identity: 'stream-identity',
        worktree: workspace,
        branch: 'main',
        cwd: '',
      },
      invocation: { command: ['echo', 'noop'], selector: [] as string[] },
      instrument: {
        adapter: 'test-adapter',
        adapter_version: '1.0.0',
        composition_id: 'test-composition',
        config_digest: 'digest-fixed',
      },
      environment: {
        runner: 'test-runner',
        runner_version: '1.0.0',
        runtime: 'node',
        os: 'linux',
        env_fingerprint: 'fp-fixed',
      },
      provenance: {
        head: null as string | null,
        dirty_diff_digest: 'dd-fixed',
        tree_digest: 'td-fixed',
      },
      surface: {
        inventory_digest: 'inv-fixed',
        test_sources: {} as Record<string, string>,
        config_sources: {} as Record<string, string>,
        suppressed: [] as string[],
      },
      completeness: { status: 'complete' as const, child_exit_code: 0 },
      recording: {
        recorder: 'test',
        recorded_at_ms: 0,
        durations_us: {} as Record<string, number>,
        raw_stdout: '',
        raw_stderr: '',
        capture_reason: 'n/a',
        unhandled_errors: 0,
      },
    }

    function makeRecord(observations: TestObservation[]): RunRecord {
      return { ...baseFields, observations }
    }

    const baselineObservations: TestObservation[] = []
    for (let i = 0; i < OBSERVATION_COUNT; i++) {
      baselineObservations.push({ test_id: testId(i), verdict: 'pass' })
    }

    const currentObservations: TestObservation[] = []
    for (let i = 0; i < OBSERVATION_COUNT; i++) {
      currentObservations.push({
        test_id: testId(i),
        verdict: 'fail',
        finding: {
          evidence_digest: `evidence-${i}`,
          structural_fingerprint: `fingerprint-${i}`,
          evidence: {
            errors: [
              {
                exception_type: 'Error',
                message: 'assertion failed',
                rel_offsets: [],
              },
            ],
          },
          context_digest: `context-${i}`,
          annex: { frames: [], console: [], location_line: null },
        },
      })
    }

    const baselineRecord = makeRecord(baselineObservations)
    const currentRecord = makeRecord(currentObservations)

    // Fail-fast: both records must satisfy the veridelta/1 schema before
    // being stored, otherwise store.readRun() would throw StoreCorruptError
    // and turn this regression test into a false negative for `compare`.
    parseRunRecord(baselineRecord)
    parseRunRecord(currentRecord)

    const store = new RunStore(workspace)
    store.ensure()
    store.writeRun(baselineRecord)
    const { runId: currentId } = store.writeRun(currentRecord)

    expect(store.lastRunId()).toBe(currentId)

    const report = buildComparisonReport(store, store.lastRunId()!, {
      mode: 'previous-comparable',
    })
    // Same expression cmdCompare's emit() uses for the json format.
    const expectedBytes = Buffer.from(`${JSON.stringify(report, null, 1)}\n`)

    expect(expectedBytes.length).toBeGreaterThan(1024 * 1024)

    const result = await spawnCli(['compare', '--report', 'json'], workspace)

    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(expectedBytes.length)
    expect(result.stdout.equals(expectedBytes)).toBe(true)
  })
})
