/**
 * RunStore advisory lock lifecycle: stale-lock detection and auto-reclaim
 * (dead PID, or mtime fallback for legacy meta-less locks), fail-open
 * behavior preserved for live/held locks (INV-5).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunRecord } from '../../src/schema.js'
import { LockHeldError, RunStore } from '../../src/store.js'

// Partial mock of node:fs: renameSync is wrapped in a spy that delegates to
// the real implementation by default, so only the one test that needs to
// force a lost reclaim-race (a renameSync failure) overrides it — every
// other test (and every other RunStore call) still hits the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const { renameSync: mockedRenameSync } = await import('node:fs')

const scratchDirs: string[] = []

function makeScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vdelta-lock-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (!dir) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

const minimalRecord = { foo: 'bar' } as unknown as RunRecord

function lockDirPath(worktree: string): string {
  return join(worktree, '.veridelta', 'lock')
}

function metaPath(worktree: string): string {
  return join(lockDirPath(worktree), 'meta.json')
}

describe('RunStore lock stale-detection and auto-reclaim', () => {
  it('(1) reclaims a lock held by a dead PID and resumes recording', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { isPidAlive: () => false })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(
      metaPath(worktree),
      JSON.stringify({ pid: 999999, acquired_at_ms: Date.now() }),
    )

    let result: { reclaimed: boolean; staleMeta: { pid: number } | null }
    expect(() => {
      result = store.acquireLock()
    }).not.toThrow()
    expect(result!.reclaimed).toBe(true)
    expect(result!.staleMeta?.pid).toBe(999999)

    const { runId } = store.writeRun(minimalRecord)
    expect(runId).toMatch(/^run_[0-9a-f]{64}$/)

    const meta = JSON.parse(readFileSync(metaPath(worktree), 'utf8'))
    expect(meta.pid).toBe(process.pid)
  })

  it('(2) does not steal a lock held by a live PID', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { isPidAlive: () => true })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(
      metaPath(worktree),
      JSON.stringify({ pid: process.pid, acquired_at_ms: Date.now() }),
    )

    let caught: unknown
    try {
      store.acquireLock()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LockHeldError)
    const err = caught as InstanceType<typeof LockHeldError>
    expect(err.lockPath).toContain('.veridelta/lock')
    expect(err.message).toContain('.veridelta/lock')
  })

  it('(3) legacy lock (no meta.json) with fresh mtime is held, not reclaimed', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { staleLockMs: 60_000 })
    store.ensure()
    mkdirSync(lockDirPath(worktree))

    expect(() => store.acquireLock()).toThrow(LockHeldError)
  })

  it('(4) legacy lock (no meta.json) backdated past the threshold is reclaimed', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { staleLockMs: 60_000 })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    const past = new Date(Date.now() - 120_000)
    utimesSync(lockDirPath(worktree), past, past)

    expect(() => store.acquireLock()).not.toThrow()
  })

  it('(5) corrupt meta.json with fresh mtime falls back to legacy held behavior', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { staleLockMs: 60_000 })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(metaPath(worktree), 'not valid json{{{')

    expect(() => store.acquireLock()).toThrow(LockHeldError)
  })

  it('(6) corrupt meta.json with backdated mtime is reclaimed via legacy fallback', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { staleLockMs: 60_000 })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(metaPath(worktree), 'not valid json{{{')
    const past = new Date(Date.now() - 120_000)
    utimesSync(lockDirPath(worktree), past, past)

    expect(() => store.acquireLock()).not.toThrow()
  })

  it('(7) normal round trip: acquire, release, re-acquire', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree)
    store.ensure()

    expect(store.acquireLock()).toEqual({ reclaimed: false, staleMeta: null })
    store.releaseLock()

    expect(() => store.acquireLock()).not.toThrow()
    store.releaseLock()
  })

  it('(8) a lost reclaim race (renameSync fails because another process already moved the stale dir aside) falls through to a plain mkdir retry instead of throwing or corrupting state', () => {
    const worktree = makeScratchDir()
    const store = new RunStore(worktree, { isPidAlive: () => false })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(
      metaPath(worktree),
      JSON.stringify({ pid: 999999, acquired_at_ms: Date.now() }),
    )

    // Simulate a racing process winning the renameSync just before ours runs
    // (e.g. it already moved the stale dir aside and hasn't recreated it
    // yet): our renameSync call fails, and reclaimStaleLock() must swallow
    // that and let the subsequent mkdir retry be the sole arbiter — it
    // must not fall back to an unconditional rmSync that could delete a
    // fresh lock the racer has since created.
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn-wrapped mock of a fs export
    ;(mockedRenameSync as any).mockImplementationOnce(() => {
      // Model the racer having already won: by the time our renameSync
      // call runs, the stale dir is already gone (moved aside elsewhere),
      // so our rename fails with ENOENT — and the path is free for the
      // subsequent plain mkdir to claim.
      rmSync(lockDirPath(worktree), { recursive: true, force: true })
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      })
    })

    const result = store.acquireLock()
    expect(result.reclaimed).toBe(true)
    expect(result.staleMeta?.pid).toBe(999999)
    // The lock dir still exists (we won the subsequent plain mkdir) and now
    // carries our own fresh meta, proving the reclaim completed cleanly
    // despite the lost rename race.
    const meta = JSON.parse(readFileSync(metaPath(worktree), 'utf8'))
    expect(meta.pid).toBe(process.pid)
  })

  it('(9) a stale lock reclaimed once yields a live lock that a second acquirer cannot also reclaim', () => {
    const worktree = makeScratchDir()
    // Only PID 999999 (the dead prior holder) is dead; our own PID (written
    // by writeLockMeta on reclaim) is alive, as real PID liveness would be.
    const store = new RunStore(worktree, {
      isPidAlive: (pid) => pid !== 999999,
    })
    store.ensure()
    mkdirSync(lockDirPath(worktree))
    writeFileSync(
      metaPath(worktree),
      JSON.stringify({ pid: 999999, acquired_at_ms: Date.now() }),
    )

    const first = store.acquireLock()
    expect(first.reclaimed).toBe(true)

    // A second acquireLock() while we already hold the (now-fresh, live)
    // lock must fail-open, never silently succeed alongside us.
    expect(() => store.acquireLock()).toThrow(LockHeldError)
  })
})
