/**
 * Content-addressed run store (spec §4): immutable records, atomic writes,
 * fail-open advisory lock, enforced gitignore. Recency is store insertion
 * order (the append-only index), never timestamps (§7.8).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
  constructor() {
    super('advisory lock is held')
    this.name = 'LockHeldError'
  }
}

const RUN_ID_RE = /^run_[0-9a-f]{64}$/

/** run_id = content address of the record excluding the recording group (§3.5). */
export function computeRunId(record: RunRecord): string {
  const { recording: _recording, ...addressed } = record
  return `run_${sha256Hex(canonicalJson(addressed))}`
}

export class RunStore {
  readonly dir: string

  constructor(worktreeRoot: string) {
    this.dir = join(worktreeRoot, '.veridelta')
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

  ensure(): void {
    mkdirSync(this.runsDir, { recursive: true })
    const gi = join(this.dir, '.gitignore')
    if (!existsSync(gi)) writeFileSync(gi, '*\n')
  }

  /** Advisory lock via mkdir; throws LockHeldError when already held (fail-open at the caller, INV-5). */
  acquireLock(): void {
    try {
      mkdirSync(this.lockPath)
    } catch {
      throw new LockHeldError()
    }
  }

  releaseLock(): void {
    try {
      rmdirSync(this.lockPath)
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
      if (!RUN_ID_RE.test(id)) throw new StoreCorruptError(`malformed index line: ${id}`)
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
    if (!RUN_ID_RE.test(id)) throw new StoreCorruptError(`malformed last pointer: ${id}`)
    return id
  }

  /** Resolve a possibly-prefixed run id to a stored full id (§3.5 MAY). */
  resolveRunId(idOrPrefix: string): string | null {
    if (RUN_ID_RE.test(idOrPrefix)) {
      return existsSync(join(this.runsDir, `${idOrPrefix}.json`)) ? idOrPrefix : null
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
