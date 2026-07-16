#!/usr/bin/env node
/**
 * vdelta CLI (spec §10). Exit-code contract:
 *   run     — transparent child exit; INV-5 degrades to raw passthrough
 *   compare — 0 when the comparison operation succeeds (inconclusive/none
 *             results included), 1 on operation failure
 *   show    — retrieval success (0) / not found (1)
 *   gate    — report-only: 0 whenever a report is produced, 2 otherwise
 * The report goes to stdout; vdelta diagnostics go to stderr only.
 */
import {
  type BaselineSpec,
  buildComparisonReport,
  CompareOperationError,
} from './compare.js'
import { buildGateReport, GateOperationError } from './gate.js'
import { renderReport } from './render.js'
import { runAndRecord, VDELTA_VERSION } from './run.js'
import type { ComparisonReport, RunRecord } from './schema.js'
import { RunStore, StoreCorruptError } from './store.js'
import { gitRepoRoot, resolveRef } from './tree-digest.js'

type ReportFormat = 'json' | 'text'

function emit(report: ComparisonReport, format: ReportFormat): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`)
  } else {
    process.stdout.write(renderReport(report))
  }
}

function parseReportFlag(args: string[]): {
  format: ReportFormat
  rest: string[]
} {
  let format: ReportFormat = 'text'
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--report') {
      const v = args[++i]
      if (v !== 'json' && v !== 'text')
        die(`--report expects json|text, got ${v ?? '(none)'}`)
      format = v
    } else if (a.startsWith('--report=')) {
      const v = a.slice('--report='.length)
      if (v !== 'json' && v !== 'text')
        die(`--report expects json|text, got ${v}`)
      format = v
    } else {
      rest.push(a)
    }
  }
  return { format, rest }
}

function die(message: string, code = 1): never {
  process.stderr.write(`vdelta: ${message}\n`)
  process.exit(code)
}

async function requireStore(): Promise<{ store: RunStore; worktree: string }> {
  const worktree = await gitRepoRoot(process.cwd())
  if (worktree === null) die('not inside a git worktree')
  return { store: new RunStore(worktree), worktree }
}

async function cmdRun(argv: string[]): Promise<never> {
  const sep = argv.indexOf('--')
  if (sep === -1) die('usage: vdelta run [--report json|text] -- <command...>')
  const { format } = parseReportFlag(argv.slice(0, sep))
  const child = argv.slice(sep + 1)
  if (child.length === 0) die('no child command given')

  const result = await runAndRecord(child, process.cwd())
  for (const d of result.diagnostics) process.stderr.write(`${d}\n`)
  if (result.degraded || result.report === null) {
    // INV-5 degraded path: verbatim raw passthrough, no report.
    process.stdout.write(result.rawStdout)
    process.stderr.write(result.rawStderr)
  } else {
    emit(result.report, format)
  }
  process.exit(result.exitCode)
}

async function cmdCompare(argv: string[]): Promise<never> {
  const { format, rest } = parseReportFlag(argv)
  let ref: string | undefined
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--ref') {
      ref = rest[++i]
      if (ref === undefined) die('--ref expects a git ref')
    } else if (a.startsWith('--ref=')) {
      ref = a.slice('--ref='.length)
    } else if (a.startsWith('-')) {
      die(`unknown option: ${a}`)
    } else {
      positional.push(a)
    }
  }

  const { store, worktree } = await requireStore()
  try {
    let currentId: string | null
    let spec: BaselineSpec

    if (ref !== undefined) {
      const resolved = await resolveRef(worktree, ref)
      if (resolved === null) die(`cannot resolve ref: ${ref}`)
      spec = {
        mode: 'git-ref',
        ref,
        commit: resolved.commit,
        tree: resolved.tree,
      }
      currentId =
        positional[0] !== undefined
          ? store.resolveRunId(positional[0])
          : store.lastRunId()
    } else if (positional.length === 2) {
      spec = { mode: 'explicit-run-id', runId: positional[0]! }
      currentId = store.resolveRunId(positional[1]!)
    } else if (positional.length === 0) {
      spec = { mode: 'previous-comparable' }
      currentId = store.lastRunId()
    } else {
      die(
        'usage: vdelta compare [<baseline-run> <current-run>] [--ref <git-ref>] [--report json|text]',
      )
    }

    if (currentId === null) die('cannot resolve the current run')
    emit(buildComparisonReport(store, currentId, spec), format)
    process.exit(0)
  } catch (err) {
    if (err instanceof CompareOperationError) die(err.message)
    if (err instanceof StoreCorruptError) die(`store corrupt: ${err.message}`)
    throw err
  }
}

async function cmdShow(argv: string[]): Promise<never> {
  let testId: string | undefined
  let raw = false
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--test') {
      testId = argv[++i]
      if (testId === undefined) die('--test expects a test id')
    } else if (a.startsWith('--test=')) {
      testId = a.slice('--test='.length)
    } else if (a === '--raw') {
      raw = true
    } else if (a.startsWith('-')) {
      die(`unknown option: ${a}`)
    } else {
      positional.push(a)
    }
  }
  if (positional.length !== 1)
    die('usage: vdelta show <run-id> [--test <test-id> | --raw]')

  const { store } = await requireStore()
  const runId = store.resolveRunId(positional[0]!)
  if (runId === null) die(`unknown run id: ${positional[0]}`)
  let record: RunRecord
  try {
    record = store.readRun(runId)
  } catch (err) {
    if (err instanceof StoreCorruptError) die(`store corrupt: ${err.message}`)
    throw err
  }

  if (raw) {
    process.stdout.write(record.recording.raw_stdout)
    process.stderr.write(record.recording.raw_stderr)
    process.exit(0)
  }
  if (testId !== undefined) {
    const obs = record.observations.find((o) => o.test_id === testId)
    if (obs === undefined) die(`no observation for test id: ${testId}`)
    process.stdout.write(`${JSON.stringify(obs, null, 1)}\n`)
    process.exit(0)
  }
  process.stdout.write(`${JSON.stringify(record, null, 1)}\n`)
  process.exit(0)
}

async function cmdGate(argv: string[]): Promise<never> {
  const { format, rest } = parseReportFlag(argv)
  let ref: string | undefined
  let runId: string | undefined
  let policy = 'report-only'
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--ref') ref = rest[++i]
    else if (a.startsWith('--ref=')) ref = a.slice('--ref='.length)
    else if (a === '--run') runId = rest[++i]
    else if (a.startsWith('--run=')) runId = a.slice('--run='.length)
    else if (a === '--policy') policy = rest[++i] ?? ''
    else if (a.startsWith('--policy=')) policy = a.slice('--policy='.length)
    else die(`unknown option: ${a}`, 2)
  }
  if (policy !== 'report-only') {
    die(
      `policy "${policy}" is not implemented in this MVP (report-only only, §11.1)`,
      2,
    )
  }
  if (ref === undefined)
    die(
      'usage: vdelta gate --ref <git-ref> [--run <run-id>] [--policy report-only]',
      2,
    )

  const worktree = await gitRepoRoot(process.cwd())
  if (worktree === null) die('not inside a git worktree', 2)
  const store = new RunStore(worktree)
  try {
    const report = await buildGateReport(store, {
      worktree,
      ref,
      ...(runId !== undefined ? { runId } : {}),
    })
    emit(report, format)
    process.exit(0)
  } catch (err) {
    if (err instanceof GateOperationError) die(err.message, 2)
    if (err instanceof StoreCorruptError)
      die(`store corrupt: ${err.message}`, 2)
    throw err
  }
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv
  switch (command) {
    case 'run':
      return cmdRun(argv)
    case 'compare':
      return cmdCompare(argv)
    case 'show':
      return cmdShow(argv)
    case 'gate':
      return cmdGate(argv)
    case '--version':
    case 'version':
      process.stdout.write(`vdelta ${VDELTA_VERSION} (veridelta/1)\n`)
      return process.exit(0)
    default:
      die(
        `usage: vdelta <run|compare|show|gate> ...\n` +
          `  run [--report json|text] -- <command...>\n` +
          `  compare [<baseline-run> <current-run>] [--ref <git-ref>] [--report json|text]\n` +
          `  show <run-id> [--test <test-id> | --raw]\n` +
          `  gate --ref <git-ref> [--run <run-id>] [--policy report-only] [--report json|text]`,
      )
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `vdelta: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
