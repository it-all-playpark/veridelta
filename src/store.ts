/**
 * Content-addressed run store (spec §4): immutable records, atomic writes,
 * fail-open advisory lock, enforced gitignore. Recency is store insertion
 * order (the append-only index), never timestamps (§7.8).
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './digest.js'
import {
  COMPLETENESS_STATUSES,
  type CompletenessStatus,
  parseRunRecord,
  type RunRecord,
} from './schema.js'

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

/** Retention limits for {@link RunStore.gc}. `undefined` disables that limit. */
export interface GcPolicy {
  maxCount?: number
  maxBytes?: number
}

/** Outcome of a {@link RunStore.gc} pass. */
export interface GcResult {
  removed: string[]
  keptCount: number
  keptBytes: number
}

function parsePositiveIntEnv(
  name: string,
  fallback: number,
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw)) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

/**
 * Default retention policy (§4.1 SHOULD be bounded). Overridable via
 * VDELTA_GC_MAX_COUNT / VDELTA_GC_MAX_BYTES (positive integers only; unset,
 * empty, zero, or non-numeric values fall back to defaults or disable the
 * limit respectively).
 */
export function defaultGcPolicy(): GcPolicy {
  const policy: GcPolicy = {}
  const maxCount = parsePositiveIntEnv('VDELTA_GC_MAX_COUNT', 100)
  const maxBytes = parsePositiveIntEnv('VDELTA_GC_MAX_BYTES', 64 * 1024 * 1024)
  if (maxCount !== undefined) policy.maxCount = maxCount
  if (maxBytes !== undefined) policy.maxBytes = maxBytes
  return policy
}

/** Lightweight, non-strict view of a run record's addressing fields. */
export interface RunMeta {
  repo: { identity: string; worktree: string; branch: string; cwd: string }
  invocation: { command: string[]; selector: string[] }
  instrument: {
    adapter: string
    adapter_version: string
    composition_id: string
    config_digest: string
  }
  provenance: { head: string | null; tree_digest: string }
  completeness: { status: CompletenessStatus; child_exit_code: number }
}

function metaFail(runId: string, detail: string): never {
  throw new StoreCorruptError(`run record meta invalid (${runId}): ${detail}`)
}

function asMetaObject(
  v: unknown,
  runId: string,
  path: string,
): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    metaFail(runId, `${path}: expected object`)
  return v as Record<string, unknown>
}

function asMetaString(v: unknown, runId: string, path: string): string {
  if (typeof v !== 'string') metaFail(runId, `${path}: expected string`)
  return v as string
}

function asMetaStringArray(v: unknown, runId: string, path: string): string[] {
  if (!Array.isArray(v)) metaFail(runId, `${path}: expected array`)
  return v.map((e, i) => asMetaString(e, runId, `${path}[${i}]`))
}

/**
 * Extract {@link RunMeta} from an already-parsed record without running the
 * full §9.4 schema validation (observations/finding/recording are not
 * inspected). Field-level absence or type mismatch in the extracted fields
 * is still a StoreCorruptError.
 */
function extractRunMeta(value: unknown, runId: string): RunMeta {
  const o = asMetaObject(value, runId, 'record')

  const repoRaw = asMetaObject(o.repo, runId, 'record.repo')
  const repo = {
    identity: asMetaString(repoRaw.identity, runId, 'record.repo.identity'),
    worktree: asMetaString(repoRaw.worktree, runId, 'record.repo.worktree'),
    branch: asMetaString(repoRaw.branch, runId, 'record.repo.branch'),
    cwd: asMetaString(repoRaw.cwd, runId, 'record.repo.cwd'),
  }

  const invocationRaw = asMetaObject(o.invocation, runId, 'record.invocation')
  const invocation = {
    command: asMetaStringArray(
      invocationRaw.command,
      runId,
      'record.invocation.command',
    ),
    selector: asMetaStringArray(
      invocationRaw.selector,
      runId,
      'record.invocation.selector',
    ),
  }

  const instrumentRaw = asMetaObject(o.instrument, runId, 'record.instrument')
  const instrument = {
    adapter: asMetaString(
      instrumentRaw.adapter,
      runId,
      'record.instrument.adapter',
    ),
    adapter_version: asMetaString(
      instrumentRaw.adapter_version,
      runId,
      'record.instrument.adapter_version',
    ),
    composition_id: asMetaString(
      instrumentRaw.composition_id,
      runId,
      'record.instrument.composition_id',
    ),
    config_digest: asMetaString(
      instrumentRaw.config_digest,
      runId,
      'record.instrument.config_digest',
    ),
  }

  const provenanceRaw = asMetaObject(o.provenance, runId, 'record.provenance')
  const head =
    provenanceRaw.head === null
      ? null
      : asMetaString(provenanceRaw.head, runId, 'record.provenance.head')
  const provenance = {
    head,
    tree_digest: asMetaString(
      provenanceRaw.tree_digest,
      runId,
      'record.provenance.tree_digest',
    ),
  }

  const completenessRaw = asMetaObject(
    o.completeness,
    runId,
    'record.completeness',
  )
  const status = completenessRaw.status
  if (
    typeof status !== 'string' ||
    !(COMPLETENESS_STATUSES as readonly string[]).includes(status)
  ) {
    metaFail(runId, 'record.completeness.status: invalid')
  }
  const childExitCode = completenessRaw.child_exit_code
  if (typeof childExitCode !== 'number' || !Number.isInteger(childExitCode)) {
    metaFail(runId, 'record.completeness.child_exit_code: expected integer')
  }
  const completeness = {
    status: status as CompletenessStatus,
    child_exit_code: childExitCode,
  }

  return { repo, invocation, instrument, provenance, completeness }
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

  /**
   * Read a record's addressing/provenance fields without the full §9.4
   * schema validation (used for cheap baseline pre-filtering). Same
   * missing/unparseable error text as {@link readRun}; extracted-field
   * absence or type mismatch is also a StoreCorruptError. Does not inspect
   * observations/finding/recording.
   */
  readRunMeta(runId: string): RunMeta {
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
    return extractRunMeta(parsed, runId)
  }

  /** INV-10: recompute the content address and compare with the stored id. */
  verifyIntegrity(runId: string): boolean {
    const record = this.readRun(runId)
    return computeRunId(record) === runId
  }

  /**
   * Enforce a retention policy (§4.1 SHOULD be bounded). Evicts whole
   * records (file + index entry), oldest first, until both limits are
   * satisfied. The record pointed to by `last`, and any id passed in
   * `protectedIds` (e.g. a baseline just selected for a comparison), are
   * never evicted, even if one alone exceeds maxBytes (AC-3).
   *
   * PRECONDITION: the caller holds the advisory lock (see acquireLock()).
   * gc() itself does not take the lock — callers that gc concurrently with a
   * writer risk racing writeRun()'s index append.
   *
   * Index ids whose record file is already missing (dangling) are dropped
   * from the index unconditionally, independent of the policy limits.
   */
  gc(policy: GcPolicy, protectedIds: readonly string[] = []): GcResult {
    const lastId = this.lastRunId()
    const protectedSet = new Set(protectedIds)
    if (lastId !== null) protectedSet.add(lastId)

    if (policy.maxCount === undefined && policy.maxBytes === undefined) {
      const ids = this.listRunIds()
      let keptBytes = 0
      for (const id of ids) {
        try {
          keptBytes += statSync(join(this.runsDir, `${id}.json`)).size
        } catch {
          // dangling id with no-op policy: leave it be, don't account for it
        }
      }
      return { removed: [], keptCount: ids.length, keptBytes }
    }

    const ids = this.listRunIds()
    const removed: string[] = []
    const kept: { id: string; size: number }[] = []
    for (const id of ids) {
      let size: number
      try {
        size = statSync(join(this.runsDir, `${id}.json`)).size
      } catch {
        removed.push(id)
        continue
      }
      kept.push({ id, size })
    }

    let totalBytes = kept.reduce((sum, e) => sum + e.size, 0)
    const overCount = () =>
      policy.maxCount !== undefined && kept.length > policy.maxCount
    const overBytes = () =>
      policy.maxBytes !== undefined && totalBytes > policy.maxBytes

    while (overCount() || overBytes()) {
      const idx = kept.findIndex((e) => !protectedSet.has(e.id))
      if (idx === -1) break
      const [evicted] = kept.splice(idx, 1)
      if (!evicted) break
      totalBytes -= evicted.size
      rmSync(join(this.runsDir, `${evicted.id}.json`), { force: true })
      removed.push(evicted.id)
    }

    if (removed.length === 0) {
      return { removed: [], keptCount: kept.length, keptBytes: totalBytes }
    }

    const tmp = join(this.dir, `.tmp-index-${randomUUID()}`)
    const survivors = kept.map((e) => e.id)
    writeFileSync(tmp, survivors.length > 0 ? `${survivors.join('\n')}\n` : '')
    renameSync(tmp, this.indexPath)

    return { removed, keptCount: kept.length, keptBytes: totalBytes }
  }
}
