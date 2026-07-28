/**
 * `vdelta run -- <cmd>` (spec §10): execute, record, report. The child's
 * exit code passes through unchanged (signal death → 128+N). Internal
 * errors — held lock, capture failure, store trouble — degrade to
 * transparent raw passthrough (INV-5): veridelta is never worse than its
 * absence. Diagnostics go to stderr and never interleave with the report.
 *
 * Which runner is being recorded is decided by the adapter registry (§4.3),
 * never here: an explicit `--adapter` always wins, otherwise every adapter's
 * `detect` is evaluated and only an unambiguous single match instruments the
 * child. No runner vocabulary lives in this module — instrumenting the child,
 * splitting inclusion intent and reading the capture channel all happen behind
 * the {@link Adapter} descriptor.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, CaptureChannel, RecordContext } from './adapter.js'
import {
  adapterNames,
  detectAdapter,
  resolveAdapter,
} from './adapters/registry.js'
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

/**
 * Public API freeze (§8.2): the split itself now belongs to the vitest
 * adapter's CLI surface, but the export stays on this path for Step 1 so
 * consumers keep their import. The core calls it through the resolved
 * descriptor, never through this binding.
 */
export { splitCommandSelector } from './adapters/vitest/adapter.js'

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

export interface RunOptions {
  /**
   * Explicit adapter name (`vdelta run --adapter <name>`). Always wins over
   * detection (§4.3-4): a contradicting argv is instrumented anyway and falls
   * through the ordinary capture path when nothing comes back. An unknown
   * name throws — user input error, never a silent degradation (§4.3-5).
   */
  adapter?: string
}

interface ChildOutcome {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
}

/**
 * Why a run degraded when no adapter claimed the child argv (§4.3-2).
 * Frozen at the pre-seam wording: Step 1 moves structure only and changes no
 * diagnostic byte, and with a single registered adapter this sentence is
 * still the accurate guidance. Phase 2 replaces it with the `--adapter` hint
 * §4.3-2 describes, once naming an adapter is a real choice.
 */
const NO_ADAPTER_DIAGNOSTIC =
  'no capture from the vitest reporter — is the child a vitest invocation?'

/**
 * Resolve the adapter that will instrument this child, or `null` plus the
 * reason to degrade with. Detection failure is never fatal (INV-5): the child
 * still runs verbatim, it is only recorded that no evidence could be taken.
 */
function chooseAdapter(
  cmd: readonly string[],
  opts: RunOptions,
): { adapter: Adapter | null; why: string } {
  if (opts.adapter !== undefined) {
    return { adapter: resolveAdapter(opts.adapter), why: NO_ADAPTER_DIAGNOSTIC }
  }
  const detection = detectAdapter(cmd)
  switch (detection.kind) {
    case 'unique':
      return { adapter: detection.adapter, why: NO_ADAPTER_DIAGNOSTIC }
    case 'ambiguous': {
      // Registry order must not silently pick a winner (§4.3-2): the
      // candidates are disclosed and the user names one.
      const candidates = detection.candidates.map((a) => a.name).join(', ')
      return {
        adapter: null,
        why: `several adapters claim this command (${candidates}) — pick one with --adapter <${adapterNames().join('|')}>`,
      }
    }
    case 'none':
      return { adapter: null, why: NO_ADAPTER_DIAGNOSTIC }
  }
}

function runChild(
  cmd: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, ...env },
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
  opts: RunOptions = {},
): Promise<RunResult> {
  const diagnostics: string[] = []
  // The channel's creation and teardown stay on the core's side of the seam
  // for now (§4.1): a single capture file is the only kind that exists, so
  // there is nothing to abstract yet. F-2 moves both into the adapter when
  // per-process channels arrive.
  const channel: CaptureChannel = {
    kind: 'single-file',
    path: join(tmpdir(), `vdelta-capture-${randomUUID()}.json`),
  }

  const { adapter, why: noAdapterReason } = chooseAdapter(cmd, opts)
  const instrumented = adapter?.instrument(cmd, channel)
  const child = await runChild(
    instrumented?.argv ?? cmd,
    instrumented?.env ?? {},
  )

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

  try {
    if (adapter === null) return degraded(noAdapterReason)

    const worktree = await gitRepoRoot(cwd)
    if (worktree === null) return degraded('not inside a git worktree')

    const { command, selector } = adapter.splitCommandSelector(cmd)
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
    // Reading, validating and parsing the channel belong to the adapter; an
    // unusable capture arrives here as an AdapterCaptureError and lands in
    // the same degraded passthrough as every other unrecordable state below.
    const record = adapter.record(channel, ctx)

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
  } finally {
    rmSync(channel.path, { force: true })
  }
}
