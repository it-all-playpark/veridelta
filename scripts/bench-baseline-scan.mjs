#!/usr/bin/env node
/**
 * Benchmark harness for AC-5 (baseline-scan lightweight-parse effect).
 *
 * Seeds a fresh, throwaway git repo with a `.veridelta` store containing 500
 * RunRecords, then runs `<dist>/cli.js compare --report json` against it
 * under `hyperfine`, printing the raw hyperfine output.
 *
 * Store layout (index insertion order, oldest -> newest):
 *   #0        stream-key MATCHES current (instrument.config_digest
 *             'cfg-match'), completeness 'complete'. This is the only
 *             stream-key-compatible record besides `current` itself, so
 *             `previous-comparable` baseline resolution must scan all the
 *             way back to it.
 *   #1..#498  each has a unique, mismatching instrument.config_digest
 *             (`cfg-miss-<i>`), forcing the previous-comparable scan (newest
 *             -> oldest) to reject all 498 of them before reaching #0.
 *   #499      = current run. Same stream key as #0 (config_digest
 *             'cfg-match') but a different provenance.dirty_diff_digest, so
 *             it content-addresses to a distinct run_id and is skipped as
 *             "self" during the scan rather than matched as its own
 *             baseline.
 *
 * A store-parsing implementation that light-parses (metadata-only) during
 * the scan and strict-parses only the selected baseline will full-parse just
 * 1 record; an implementation that strict-parses every candidate during the
 * scan will full-parse 499 records. This is what the before/after comparison
 * in the AC-5 write-up is measuring.
 *
 * Usage:
 *   node scripts/bench-baseline-scan.mjs --dist <path-to-dist>
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RECORD_COUNT = 500
const OBSERVATIONS_PER_RECORD = 300
const RAW_STDOUT_BYTES = 200 * 1024

function parseArgs(argv) {
  let dist
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') {
      dist = argv[++i]
    } else if (a.startsWith('--dist=')) {
      dist = a.slice('--dist='.length)
    }
  }
  if (!dist) {
    console.error(
      'usage: node scripts/bench-baseline-scan.mjs --dist <path-to-dist>',
    )
    process.exit(1)
  }
  return { dist }
}

function digest(prefix, i) {
  return `${prefix}-${i}`.padEnd(64, '0')
}

/** ~1KB finding, matching the shape validated by src/schema.ts#validateFinding. */
function makeFinding(i) {
  return {
    evidence_digest: digest('evd', i),
    structural_fingerprint: digest('fp', i),
    evidence: {
      errors: [
        {
          exception_type: 'AssertionError',
          message: `expected value to equal target at index ${i}: ${'x'.repeat(800)}`,
          rel_offsets: [0],
        },
      ],
    },
    context_digest: digest('ctx', i),
    annex: {
      frames: [{ file: 'src/example.test.ts', line: 10 + (i % 50), column: 3 }],
      console: [{ type: 'stderr', content: `stderr output for test ${i}` }],
      location_line: 1,
    },
  }
}

function makeObservations() {
  const observations = []
  for (let i = 0; i < OBSERVATIONS_PER_RECORD; i++) {
    observations.push({
      test_id: `suite/test-${i}`,
      verdict: 'fail',
      finding: makeFinding(i),
    })
  }
  return observations
}

/**
 * Full RunRecord in the shape of tests/unit/near-miss.test.ts#makeRecord,
 * parameterized on the two fields that drive stream-key match/mismatch and
 * run_id distinctness.
 */
function makeRecord({ configDigest, dirtyDiffDigest }) {
  return {
    schema_version: 'veridelta/1',
    repo: { identity: 'repo1', worktree: '/wt', branch: 'main', cwd: '/wt' },
    invocation: { command: ['vitest', 'run'], selector: [] },
    instrument: {
      adapter: 'vitest-native',
      adapter_version: '1',
      composition_id: 'vitest-native/1',
      config_digest: configDigest,
    },
    environment: {
      runner: 'vitest',
      runner_version: '1',
      runtime: 'node',
      os: 'darwin',
      env_fingerprint: 'env1',
    },
    provenance: {
      head: 'deadbeef',
      dirty_diff_digest: dirtyDiffDigest,
      tree_digest: 'td1',
    },
    surface: {
      inventory_digest: 'inv1',
      test_sources: {},
      config_sources: {},
      suppressed: [],
    },
    completeness: { status: 'complete', child_exit_code: 0 },
    observations: makeObservations(),
    recording: {
      recorder: 'vitest-native/1',
      recorded_at_ms: 0,
      durations_us: {},
      raw_stdout: 'x'.repeat(RAW_STDOUT_BYTES),
      raw_stderr: '',
      capture_reason: 'complete',
      unhandled_errors: 0,
    },
  }
}

async function seedStore(RunStore, repoDir) {
  const store = new RunStore(repoDir)
  store.ensure()

  let baselineRunId
  let currentRunId
  for (let i = 0; i < RECORD_COUNT; i++) {
    const isFirst = i === 0
    const isLast = i === RECORD_COUNT - 1
    const configDigest = isFirst || isLast ? 'cfg-match' : `cfg-miss-${i}`
    const dirtyDiffDigest = isLast ? 'dd-current' : 'dd-base'
    const record = makeRecord({ configDigest, dirtyDiffDigest })
    const { runId } = store.writeRun(record)
    if (isFirst) baselineRunId = runId
    if (isLast) currentRunId = runId
  }
  return { baselineRunId, currentRunId }
}

async function importAndRun(indexUrl, cliPath, repoDir) {
  const { RunStore } = await import(indexUrl)
  const { baselineRunId, currentRunId } = await seedStore(RunStore, repoDir)

  console.log(
    `seeded ${RECORD_COUNT} records in ${repoDir} ` +
      `(baseline=${baselineRunId}, current=${currentRunId})`,
  )

  const hyperfineResult = spawnSync(
    'hyperfine',
    ['--warmup', '2', `node ${JSON.stringify(cliPath)} compare --report json`],
    { cwd: repoDir, stdio: 'inherit', shell: false },
  )
  if (hyperfineResult.error) {
    console.error(`failed to run hyperfine: ${hyperfineResult.error.message}`)
    return 1
  }
  if (hyperfineResult.status !== 0) {
    console.error(`hyperfine exited with status ${hyperfineResult.status}`)
    return 1
  }

  const compareResult = spawnSync(
    'node',
    [cliPath, 'compare', '--report', 'json'],
    { cwd: repoDir, encoding: 'utf8' },
  )
  if (compareResult.status !== 0) {
    console.error(
      `sanity check: vdelta compare exited ${compareResult.status}\n` +
        `${compareResult.stderr}`,
    )
    return 1
  }
  const report = JSON.parse(compareResult.stdout)
  if (report.baseline?.run_id !== baselineRunId) {
    console.error(
      `sanity check FAILED: report.baseline.run_id = ${report.baseline?.run_id}, ` +
        `expected seeded record #0 run_id = ${baselineRunId}`,
    )
    return 1
  }
  console.log(
    `sanity check passed: report.baseline.run_id === seeded record #0 (${baselineRunId})`,
  )
  return 0
}

async function main() {
  const { dist } = parseArgs(process.argv.slice(2))
  const distAbs = isAbsolute(dist) ? dist : resolve(process.cwd(), dist)
  const indexUrl = pathToFileURL(join(distAbs, 'index.js')).href
  const cliPath = join(distAbs, 'cli.js')

  const repoDir = mkdtempSync(join(tmpdir(), 'vdelta-bench-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'vdelta-bench'], {
      cwd: repoDir,
    })
    execFileSync('git', ['config', 'user.email', 'vdelta-bench@example.com'], {
      cwd: repoDir,
    })

    return await importAndRun(indexUrl, cliPath, repoDir)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err)
    process.exit(1)
  },
)
