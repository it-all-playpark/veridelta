/**
 * Content-addressed run store (spec §4): immutable records, atomic writes,
 * fail-open advisory lock, enforced gitignore. Recency is store insertion
 * order (the append-only index), never timestamps (§7.8).
 *
 * The advisory lock (`.veridelta/lock`, mkdir-based for atomicity) is
 * fail-open per INV-5: a lock that cannot be proven live degrades the
 * caller to transparent passthrough rather than blocking indefinitely.
 * On top of that, acquireLock() auto-reclaims *stale* locks so a crashed
 * process doesn't wedge recording forever:
 *   - if the lock carries `meta.json` ({pid, acquired_at_ms}), staleness is
 *     decided purely by PID liveness (dead PID => stale, reclaim now;
 *     regardless of age otherwise a live holder is never stolen);
 *   - if `meta.json` is missing or unreadable/malformed (a legacy lock, or
 *     a write that failed), staleness falls back to an mtime threshold
 *     (`staleLockMs`, default 10 minutes) — this also preserves INV-5 for
 *     the existing fail-open-held-lock conformance fixture, whose fresh
 *     bare-mkdir lock must still degrade to passthrough.
 * Reclaim is remove-then-retry-once: if another process wins the race, the
 * retry mkdir fails and we throw LockHeldError (fail-open), never loop.
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './digest.js'
import { parseRunRecord, type RunRecord } from './schema.js'

export class StoreCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreCorruptError'
  }
}

export class LockHeldError extends Error {
  constructor(readonly lockPath: string) {
    super(
      `advisory lock is held at ${lockPath} — if no other vdelta run is active, remove it: rm -rf ${lockPath}`,
    )
    this.name = 'LockHeldError'
  }
}

const RUN_ID_RE = /^run_[0-9a-f]{64}$/

/** run_id = content address of the record excluding the recording group (§3.5). */
export function computeRunId(record: RunRecord): string {
  const { recording: _recording, ...addressed } = record
  return `run_${sha256Hex(canonicalJson(addressed))}`
}

/** Options for RunStore's advisory lock stale-detection (testability + tuning). */
export interface RunStoreOptions {
  /** mtime threshold (ms) for reclaiming a meta-less legacy lock. Default 10 minutes. */
  staleLockMs?: number
  /** PID liveness probe. Default: process.kill(pid, 0) (ESRCH => dead, else alive). */
  isPidAlive?: (pid: number) => boolean
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH: no such process => dead. Anything else (EPERM, unknown) means
    // we cannot prove it's dead, so treat as alive — never steal a lock we
    // cannot prove is unheld.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export class RunStore {
  readonly dir: string
  private readonly staleLockMs: number
  private readonly isPidAlive: (pid: number) => boolean

  constructor(worktreeRoot: string, options?: RunStoreOptions) {
    this.dir = join(worktreeRoot, '.veridelta')
    this.staleLockMs = options?.staleLockMs ?? 10 * 60_000
    this.isPidAlive = options?.isPidAlive ?? defaultIsPidAlive
  }

  private get runsDir(): string {
    return join(this.dir, 'runs')
  }

  private get indexPath(): string {
    return join(this.dir, 'index')
  }

  private get lastPath(): string {
    return join(this.dir, 'last')
  }

  private get lockPath(): string {
    return join(this.dir, 'lock')
  }

  private get lockMetaPath(): string {
    return join(this.lockPath, 'meta.json')
  }

  ensure(): void {
    mkdirSync(this.runsDir, { recursive: true })
    const gi = join(this.dir, '.gitignore')
    if (!existsSync(gi)) writeFileSync(gi, '*\n')
  }

  /** Best-effort: write lock metadata for future stale-detection. Never throws. */
  private writeLockMeta(): void {
    try {
      writeFileSync(
        this.lockMetaPath,
        JSON.stringify({ pid: process.pid, acquired_at_ms: Date.now() }),
      )
    } catch {
      // advisory only: an unwritten meta.json just makes this lock behave
      // like a legacy lock (mtime-only staleness) for the next acquirer
    }
  }

  /**
   * Decide whether the currently-held lock is stale and may be reclaimed.
   * - meta.json present and parseable with a finite numeric pid: stale iff
   *   that pid is not alive (PID liveness is authoritative, any age).
   * - meta.json missing/unreadable/unparseable/malformed (legacy lock):
   *   stale iff the lock dir's mtime is older than staleLockMs (strict >).
   * - lock dir vanished while we were checking (concurrent release): stale.
   */
  private isLockStale(): boolean {
    let raw: string
    try {
      raw = readFileSync(this.lockMetaPath, 'utf8')
    } catch {
      return this.isLegacyLockStale()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.isLegacyLockStale()
    }
    const pid = (parsed as { pid?: unknown } | null)?.pid
    if (typeof pid !== 'number' || !Number.isFinite(pid)) {
      return this.isLegacyLockStale()
    }
    return !this.isPidAlive(pid)
  }

  private isLegacyLockStale(): boolean {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.lockPath).mtimeMs
    } catch {
      // lock vanished concurrently: safe to treat as stale and retry
      return true
    }
    return Date.now() - mtimeMs > this.staleLockMs
  }

  /**
   * Advisory lock via mkdir (atomic). A stale lock (dead PID, or an aged
   * legacy lock past staleLockMs) is auto-reclaimed: remove then retry
   * mkdir exactly once. If the lock is live, or the retry loses a race,
   * throws LockHeldError — fail-open at the caller (INV-5).
   */
  acquireLock(): void {
    try {
      mkdirSync(this.lockPath)
      this.writeLockMeta()
      return
    } catch {
      // fall through to stale-reclaim below
    }

    if (!this.isLockStale()) {
      throw new LockHeldError(this.lockPath)
    }

    rmSync(this.lockPath, { recursive: true, force: true })
    try {
      mkdirSync(this.lockPath)
    } catch {
      throw new LockHeldError(this.lockPath)
    }
    this.writeLockMeta()
  }

  releaseLock(): void {
    try {
      rmSync(this.lockPath, { recursive: true, force: true })
    } catch {
      // releasing a lock we no longer hold is not an error path worth failing on
    }
  }

  /**
   * Persist a record. Atomic (tmp+rename). Content-identical re-records are
   * idempotent: no duplicate index line, no rewrite of the immutable record.
   */
  writeRun(record: RunRecord): { runId: string; isNew: boolean } {
    const runId = computeRunId(record)
    const path = join(this.runsDir, `${runId}.json`)
    const isNew = !existsSync(path)
    if (isNew) {
      const tmp = join(this.runsDir, `.tmp-${randomUUID()}`)
      writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`)
      renameSync(tmp, path)
      appendFileSync(this.indexPath, `${runId}\n`)
    }
    const tmpLast = join(this.dir, `.tmp-last-${randomUUID()}`)
    writeFileSync(tmpLast, `${runId}\n`)
    renameSync(tmpLast, this.lastPath)
    return { runId, isNew }
  }

  /** Insertion-ordered run ids, oldest first, de-duplicated (§4.3 floor). */
  listRunIds(): string[] {
    if (!existsSync(this.indexPath)) return []
    let raw: string
    try {
      raw = readFileSync(this.indexPath, 'utf8')
    } catch {
      throw new StoreCorruptError('index unreadable')
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of raw.split('\n')) {
      const id = line.trim()
      if (id === '') continue
      if (!RUN_ID_RE.test(id))
        throw new StoreCorruptError(`malformed index line: ${id}`)
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
    return out
  }

  lastRunId(): string | null {
    if (!existsSync(this.lastPath)) return null
    const id = readFileSync(this.lastPath, 'utf8').trim()
    if (!RUN_ID_RE.test(id))
      throw new StoreCorruptError(`malformed last pointer: ${id}`)
    return id
  }

  /** Resolve a possibly-prefixed run id to a stored full id (§3.5 MAY). */
  resolveRunId(idOrPrefix: string): string | null {
    if (RUN_ID_RE.test(idOrPrefix)) {
      return existsSync(join(this.runsDir, `${idOrPrefix}.json`))
        ? idOrPrefix
        : null
    }
    if (!existsSync(this.runsDir)) return null
    const matches = readdirSync(this.runsDir)
      .filter((f) => f.endsWith('.json') && f.startsWith(idOrPrefix))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((f) => RUN_ID_RE.test(f))
    return matches.length === 1 ? (matches[0] ?? null) : null
  }

  /** Read and validate a record; parse/validation failures are store corruption. */
  readRun(runId: string): RunRecord {
    const path = join(this.runsDir, `${runId}.json`)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      throw new StoreCorruptError(`run record missing: ${runId}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new StoreCorruptError(`run record unparseable: ${runId}`)
    }
    return parseRunRecord(parsed)
  }

  /** INV-10: recompute the content address and compare with the stored id. */
  verifyIntegrity(runId: string): boolean {
    const record = this.readRun(runId)
    return computeRunId(record) === runId
  }
}
