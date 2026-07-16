import { execFile } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { treeDigest } from '../../src/tree-digest.js'

const execFileP = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd })
  return stdout.trim()
}

const scratchDirs: string[] = []

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/**
 * Recursively apply a mode transform to a directory tree. Used both to lock
 * down `.git/objects` (read-only tests) and to restore write bits before
 * cleanup — macOS refuses to rmSync a write-protected directory.
 */
function chmodRecursive(root: string, transform: (mode: number) => number) {
  const st = statSync(root)
  chmodSync(root, transform(st.mode))
  if (st.isDirectory()) {
    for (const entry of readdirSync(root)) {
      chmodRecursive(join(root, entry), transform)
    }
  }
}

function makeReadOnly(root: string) {
  chmodRecursive(root, (m) => m & ~0o222)
}

function restoreWritable(root: string) {
  chmodRecursive(root, (m) => m | 0o200)
}

function countObjects(gitDir: string): number {
  let count = 0
  const walk = (p: string) => {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry))
    } else {
      count++
    }
  }
  try {
    walk(join(gitDir, 'objects'))
  } catch {
    return 0
  }
  return count
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (!dir) continue
    try {
      restoreWritable(dir)
    } catch {
      // best-effort: dir may already be fully writable
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
}

/**
 * Repo with a committed file plus staged, unstaged, and untracked changes on
 * top. Content is deterministic so two independently-created repos produce
 * the same tree oid, letting tests compare a writable run against a
 * read-only run without either polluting the other's object store.
 */
async function makeDirtyRepo(dir: string): Promise<void> {
  await initRepo(dir)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  await git(dir, ['add', 'a.txt'])
  await git(dir, ['commit', '-m', 'initial'])
  writeFileSync(join(dir, 'a.txt'), 'hello world\n')
  writeFileSync(join(dir, 'b.txt'), 'untracked\n')
}

describe('treeDigest (read-only object DB)', () => {
  it('(a) returns a 40-hex oid for a repo with tracked/staged/unstaged/untracked changes', async () => {
    const dir = makeScratchDir('vd-td-')
    await makeDirtyRepo(dir)
    const oid = await treeDigest(dir)
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it('(b) does not change the number of loose objects under .git/objects (repo pollution zero)', async () => {
    const dir = makeScratchDir('vd-td-')
    await makeDirtyRepo(dir)
    const before = countObjects(join(dir, '.git'))
    await treeDigest(dir)
    const after = countObjects(join(dir, '.git'))
    expect(after).toBe(before)
  })

  it('(c) succeeds and returns the same oid as an equivalent writable repo when .git/objects is read-only', async () => {
    // Two independently-created repos with identical (new, uncommitted)
    // content: neither run can piggyback on objects the other already
    // wrote, so the read-only run genuinely needs to create new blob/tree
    // objects — a real EPERM without the fix.
    const writableDir = makeScratchDir('vd-td-')
    await makeDirtyRepo(writableDir)
    const expected = await treeDigest(writableDir)

    const readonlyDir = makeScratchDir('vd-td-')
    await makeDirtyRepo(readonlyDir)
    makeReadOnly(join(readonlyDir, '.git', 'objects'))
    const actual = await treeDigest(readonlyDir)

    expect(actual).toBe(expected)
    expect(actual).toMatch(/^[0-9a-f]{40}$/)
  })

  it('(d) succeeds against a read-only object DB when HEAD does not exist yet', async () => {
    const dir = makeScratchDir('vd-td-')
    await initRepo(dir)
    writeFileSync(join(dir, 'c.txt'), 'untracked only\n')
    makeReadOnly(join(dir, '.git', 'objects'))
    const oid = await treeDigest(dir)
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it('(e) resolves the common objects dir for a linked worktree with a read-only object DB', async () => {
    async function buildWorktreeScenario(): Promise<{
      repoDir: string
      wtDir: string
    }> {
      const repoDir = makeScratchDir('vd-td-')
      await initRepo(repoDir)
      writeFileSync(join(repoDir, 'a.txt'), 'hello\n')
      await git(repoDir, ['add', 'a.txt'])
      await git(repoDir, ['commit', '-m', 'initial'])
      const wtParent = makeScratchDir('vd-td-wt-')
      const wtDir = join(wtParent, 'wt')
      await git(repoDir, ['worktree', 'add', '--detach', wtDir])
      // New, never-before-seen content in the linked worktree: forces a
      // fresh blob + tree write that can only be satisfied by resolving
      // this repo's own common objects dir as the alternate.
      writeFileSync(join(wtDir, 'w.txt'), 'worktree-only\n')
      return { repoDir, wtDir }
    }

    const writable = await buildWorktreeScenario()
    const expected = await treeDigest(writable.wtDir)

    const readonly = await buildWorktreeScenario()
    makeReadOnly(join(readonly.repoDir, '.git', 'objects'))
    const actual = await treeDigest(readonly.wtDir)

    expect(actual).toBe(expected)
  })
})
