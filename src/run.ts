/**
 * `vdelta run -- <cmd>` (spec §10): execute, record, report. The child's
 * exit code passes through unchanged (signal death → 128+N). Internal
 * errors — held lock, capture failure, store trouble — degrade to
 * transparent raw passthrough (INV-5): veridelta is never worse than its
 * absence. Diagnostics go to stderr and never interleave with the report.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capture } from './adapters/vitest/capture.js'
import {
  buildRunRecord,
  type RecordContext,
} from './adapters/vitest/recorder.js'
import { buildComparisonReport } from './compare.js'
import { canonicalDigest } from './digest.js'
import type { ComparisonReport } from './schema.js'
import { defaultGcPolicy, LockHeldError, RunStore } from './store.js'
import {
  dirtyDiffMaterial,
  gitBranch,
  gitHead,
  gitRepoRoot,
  treeDigest,
} from './tree-digest.js'

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string
}

export const VDELTA_VERSION: string = pkg.version

export interface RunResult {
  exitCode: number
  report: ComparisonReport | null
  degraded: boolean
  diagnostics: string[]
  rawStdout: Buffer
  rawStderr: Buffer
}

interface ChildOutcome {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
}

function reporterModulePath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    'adapters',
    'vitest',
    'reporter.js',
  )
}

/** Locate the vitest invocation inside the child argv; null when absent. */
function findVitestToken(cmd: string[]): number | null {
  for (let i = 0; i < cmd.length; i++) {
    const token = cmd[i]!
    if (/(^|[\\/])vitest(\.mjs|\.js)?$/.test(token) || token === 'vitest')
      return i
  }
  return null
}

/**
 * The invocation's selector is its inclusion intent (§6.4): the vitest CLI
 * positional filters. The canonical command excludes them (§5.1).
 */
export function splitCommandSelector(cmd: string[]): {
  command: string[]
  selector: string[]
} {
  const idx = findVitestToken(cmd)
  if (idx === null) return { command: cmd, selector: [] }
  const command: string[] = cmd.slice(0, idx + 1)
  const selector: string[] = []
  for (let i = idx + 1; i < cmd.length; i++) {
    const token = cmd[i]!
    if (token === 'run' && i === idx + 1) {
      command.push(token)
    } else if (token.startsWith('-')) {
      command.push(token)
    } else {
      selector.push(token)
    }
  }
  return { command, selector }
}

function runChild(cmd: string[], captureFile: string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, VDELTA_CAPTURE_FILE: captureFile },
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      const exitCode =
        code !== null
          ? code
          : 128 + (signal !== null ? signalNumber(signal) : 0)
      resolve({
        exitCode,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      })
    })
  })
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGSEGV: 11,
    SIGPIPE: 13,
    SIGTERM: 15,
  }
  return table[signal] ?? 15
}

export async function runAndRecord(
  cmd: string[],
  cwd: string,
): Promise<RunResult> {
  const diagnostics: string[] = []
  const captureFile = join(tmpdir(), `vdelta-capture-${randomUUID()}.json`)

  const vitestIdx = findVitestToken(cmd)
  const childCmd =
    vitestIdx !== null
      ? [
          ...cmd,
          '--reporter=default',
          `--reporter=${reporterModulePath()}`,
          '--includeTaskLocation',
        ]
      : cmd

  const child = await runChild(childCmd, captureFile)

  const degraded = (why: string): RunResult => {
    diagnostics.push(`vdelta: degraded to raw passthrough (${why})`)
    return {
      exitCode: child.exitCode,
      report: null,
      degraded: true,
      diagnostics,
      rawStdout: child.stdout,
      rawStderr: child.stderr,
    }
  }

  let capture: Capture
  try {
    capture = JSON.parse(readFileSync(captureFile, 'utf8')) as Capture
  } catch {
    return degraded(
      'no capture from the vitest reporter — is the child a vitest invocation?',
    )
  } finally {
    rmSync(captureFile, { force: true })
  }

  try {
    const worktree = await gitRepoRoot(cwd)
    if (worktree === null) return degraded('not inside a git worktree')

    const { command, selector } = splitCommandSelector(cmd)
    const ctx: RecordContext = {
      worktree,
      repoIdentity: worktree,
      branch: await gitBranch(worktree),
      cwdRel: cwd === worktree ? '' : cwd.slice(worktree.length + 1),
      command,
      selector,
      head: await gitHead(worktree),
      treeDigest: await treeDigest(worktree),
      dirtyDiffDigest: canonicalDigest(await dirtyDiffMaterial(worktree)),
      childExitCode: child.exitCode,
      rawStdout: child.stdout.toString('utf8'),
      rawStderr: child.stderr.toString('utf8'),
      adapterVersion: VDELTA_VERSION,
      recordedAtMs: Date.now(),
    }
    const record = buildRunRecord(capture, ctx)

    const store = new RunStore(worktree)
    store.ensure()
    const { reclaimed } = store.acquireLock()
    if (reclaimed) {
      diagnostics.push(
        `vdelta: reclaimed stale advisory lock at ${join(store.dir, 'lock')}`,
      )
    }
    let runId: string
    try {
      runId = store.writeRun(record).runId
    } finally {
      store.releaseLock()
    }

    const report = buildComparisonReport(store, runId, {
      mode: 'previous-comparable',
    })

    // Auto-GC (§4.1 SHOULD be bounded): keep the store from growing
    // unbounded across repeated `vdelta run` invocations. Runs *after* the
    // comparison above so the baseline it just resolved cannot be evicted
    // out from under it — a comparison performed here always saw its
    // baseline still present. The record just written is `last` and the
    // resolved baseline (if any) are both protected for this pass, so
    // neither is evicted even under a tight VDELTA_GC_MAX_COUNT/BYTES
    // (AC-3). A GC failure (including a held lock) must not fail the run
    // itself (INV-5 spirit) — it only downgrades to a diagnostic.
    try {
      store.acquireLock()
      try {
        const protectedIds = report.baseline ? [report.baseline.run_id] : []
        store.gc(defaultGcPolicy(), protectedIds)
      } finally {
        store.releaseLock()
      }
    } catch (e) {
      diagnostics.push(
        `vdelta: gc skipped (${e instanceof Error ? e.message : String(e)})`,
      )
    }

    return {
      exitCode: child.exitCode,
      report,
      degraded: false,
      diagnostics,
      rawStdout: child.stdout,
      rawStderr: child.stderr,
    }
  } catch (err) {
    if (err instanceof LockHeldError) {
      // err.message already carries the lock path and the `rm -rf` recovery
      // hint (see LockHeldError in store.ts); acquireLock() has already
      // auto-reclaimed any stale lock, so reaching here means a live holder.
      return degraded(err.message)
    }
    return degraded(err instanceof Error ? err.message : String(err))
  }
}
