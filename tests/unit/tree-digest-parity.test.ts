/**
 * Parity oracle for treeDigest() (src/tree-digest.ts): reproduces the
 * pre-issue-#81 algorithm (throwaway index seeded with `git read-tree
 * HEAD`/`--empty`) independently of src, and asserts it yields the same
 * tree object id as the current implementation for a battery of scenarios.
 *
 * This file is intentionally trivially green before src/tree-digest.ts
 * switches its seed to a real-index copy (both sides then use read-tree);
 * it becomes the real A-vs-B guard once treeDigest() changes seed strategy.
 * Its purpose is not to detect the change itself (see
 * tests/unit/tree-digest-seed.test.ts for that), but to prove the tree id
 * produced is seed-independent.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { treeDigest } from '../../src/tree-digest.js'

const execFileP = promisify(execFile)

const PIN = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'advice.addEmbeddedRepo=false',
]

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (!dir) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
}

async function commitAll(dir: string, msg: string): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', msg])
}

async function makeRepo(dir: string): Promise<void> {
  await initRepo(dir)
  writeFileSync(join(dir, 'a.txt'), 'alpha\n')
  writeFileSync(join(dir, 'b.txt'), 'beta\n')
  await mkdir(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'c.txt'), 'gamma\n')
  await commitAll(dir, 'initial')
}

async function headTree(dir: string): Promise<string> {
  return git(dir, [...PIN, '-C', dir, 'rev-parse', 'HEAD^{tree}'])
}

/**
 * Independent reproduction of the pre-#81 treeDigest() seed algorithm: a
 * throwaway index seeded with `git read-tree HEAD` (or `--empty` when HEAD
 * does not exist yet), then `add -A` + `write-tree` against a throwaway
 * object dir with the real objects made available as an alternate. Must
 * NOT import anything from src other than via this file's own git() calls.
 */
async function readTreeSeededDigest(worktree: string): Promise<string> {
  const idx = join(tmpdir(), `vd-oracle-idx-${randomUUID()}`)
  const objDir = join(tmpdir(), `vd-oracle-obj-${randomUUID()}`)
  try {
    await mkdir(objDir, { recursive: true })
    const realObjects = await git(worktree, [
      ...PIN,
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
    ])
    const existingAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
    const alternates = existingAlternates
      ? `${realObjects}${delimiter}${existingAlternates}`
      : realObjects
    const env = {
      GIT_INDEX_FILE: idx,
      GIT_OBJECT_DIRECTORY: objDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    }

    let hasHead = true
    try {
      await git(worktree, [
        ...PIN,
        '-C',
        worktree,
        'rev-parse',
        '--verify',
        '-q',
        'HEAD',
      ])
    } catch {
      hasHead = false
    }
    if (hasHead) {
      await git(worktree, [...PIN, '-C', worktree, 'read-tree', 'HEAD'], env)
    } else {
      await git(worktree, [...PIN, '-C', worktree, 'read-tree', '--empty'], env)
    }
    await git(worktree, [...PIN, '-C', worktree, 'add', '-A'], env)
    return await git(worktree, [...PIN, '-C', worktree, 'write-tree'], env)
  } finally {
    await rm(idx, { force: true })
    await rm(objDir, { recursive: true, force: true })
  }
}

async function expectParity(dir: string): Promise<string> {
  const b = await treeDigest(dir)
  const a = await readTreeSeededDigest(dir)
  expect(a).toMatch(/^[0-9a-f]{40}$/)
  expect(b).toBe(a)
  return a
}

describe('treeDigest parity: read-tree seed (A) vs current implementation (B)', () => {
  it('S1 clean tree', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    const oid = await expectParity(dir)
    expect(oid).toBe(await headTree(dir))
  })

  it('S2 tracked change, unstaged', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'alpha2\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S3 tracked change, staged', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'alpha3\n')
    await git(dir, ['add', 'a.txt'])
    await expectParity(dir)
  })

  it('S4 staged X, worktree Y', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'X-version\n')
    await git(dir, ['add', 'a.txt'])
    writeFileSync(join(dir, 'a.txt'), 'Y-version\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S5 new untracked file', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S6 tracked file deleted, unstaged', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    rmSync(join(dir, 'b.txt'))
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S7 git rm b.txt (staged deletion)', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    await git(dir, ['rm', 'b.txt'])
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S8 committed .gitignore excludes a file', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    await commitAll(dir, 'ignore')
    writeFileSync(join(dir, 'ignored.txt'), 'should be excluded\n')
    const oid = await expectParity(dir)
    expect(oid).toBe(await headTree(dir))
  })

  it('S9 core.excludesFile in repo config is overridden by the pin', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    const excludeFile = join(dir, '..', 'excludes.txt')
    writeFileSync(excludeFile, 'x.txt\n')
    await git(dir, ['config', 'core.excludesFile', excludeFile])
    writeFileSync(join(dir, 'x.txt'), 'included by pin\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S10 racy-git, 20 iterations', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    for (let i = 0; i < 20; i++) {
      const n = String(i).padStart(2, '0')
      writeFileSync(join(dir, 'a.txt'), `v${n}\n`)
      await git(dir, ['add', 'a.txt'])
      writeFileSync(join(dir, 'a.txt'), `w${n}\n`)
      await expectParity(dir)
    }
  }, 60_000)

  it('S11 mode change only', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    chmodSync(join(dir, 'a.txt'), 0o755)
    await expectParity(dir)
  })

  it('S12 linked worktree', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    const otherScratch = makeScratchDir('vd-tdp-wt-')
    const wtDir = join(otherScratch, 'wt')
    await git(dir, ['worktree', 'add', '--detach', wtDir])
    writeFileSync(join(wtDir, 'w.txt'), 'worktree-only\n')
    writeFileSync(join(wtDir, 'a.txt'), 'alpha-wt\n')
    await expectParity(wtDir)
  }, 20_000)

  it('S13 index file missing', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    rmSync(join(dir, '.git', 'index'))
    await expectParity(dir)
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false)
  })

  it('S14 split-index', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    await git(dir, ['config', 'core.splitIndex', 'true'])
    await git(dir, ['update-index', '--split-index'])
    writeFileSync(join(dir, 'a.txt'), 'split\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    await expectParity(dir)
  }, 20_000)

  it('S15 unborn HEAD with an existing index', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'alpha\n')
    await git(dir, ['add', 'a.txt'])
    writeFileSync(join(dir, 'b.txt'), 'beta\n')
    await expectParity(dir)
  })

  it('S16 assume-unchanged (CE_VALID) entry with a changed file', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    await git(dir, ['update-index', '--assume-unchanged', 'a.txt'])
    writeFileSync(join(dir, 'a.txt'), 'alpha-changed-behind-assume-unchanged\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })

  it('S17 skip-worktree entry with a changed file', async () => {
    const dir = makeScratchDir('vd-tdp-')
    await makeRepo(dir)
    await git(dir, ['update-index', '--skip-worktree', 'a.txt'])
    writeFileSync(join(dir, 'a.txt'), 'alpha-changed-behind-skip-worktree\n')
    const oid = await expectParity(dir)
    expect(oid).not.toBe(await headTree(dir))
  })
})
