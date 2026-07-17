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
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../src/schema.js'
import { LockHeldError, RunStore } from '../../src/store.js'

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

    expect(() => store.acquireLock()).not.toThrow()

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

    store.acquireLock()
    store.releaseLock()

    expect(() => store.acquireLock()).not.toThrow()
    store.releaseLock()
  })
})
