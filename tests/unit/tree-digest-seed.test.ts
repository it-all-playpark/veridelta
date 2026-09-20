import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (!dir) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
}

/**
 * Run fn() with process.env.GIT_TRACE pointed at traceFile so every git
 * child spawned by treeDigest() (which spreads process.env into its own
 * env) appends `trace: built-in: git <subcommand> ...` lines there. The
 * previous value is restored (or deleted) in finally so this cannot leak
 * into other test files sharing the process.
 */
async function withGitTrace<T>(
  traceFile: string,
  fn: () => Promise<T>,
): Promise<{ result: T; trace: string }> {
  const prev = process.env.GIT_TRACE
  process.env.GIT_TRACE = traceFile
  try {
    const result = await fn()
    const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : ''
    return { result, trace }
  } finally {
    if (prev === undefined) {
      delete process.env.GIT_TRACE
    } else {
      process.env.GIT_TRACE = prev
    }
  }
}

describe('treeDigest (index seeding)', () => {
  it('seeds from a copy of the real index: no read-tree when .git/index exists', async () => {
    const dir = makeScratchDir('vd-tds-')
    await initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'initial'])

    const traceFile = join(dir, '..', `${basename(dir)}-trace.log`)
    scratchDirs.push(traceFile)
    const { result: oid, trace } = await withGitTrace(traceFile, () =>
      treeDigest(dir),
    )

    expect(trace).toContain('add -A')
    expect(trace).not.toMatch(/read-tree/)
    const headTree = await git(dir, ['rev-parse', 'HEAD^{tree}'])
    expect(oid).toBe(headTree)
  })

  it('falls back to read-tree HEAD when .git/index is missing (S13)', async () => {
    const dir = makeScratchDir('vd-tds-')
    await initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'initial'])
    rmSync(join(dir, '.git', 'index'))

    const traceFile = join(dir, '..', `${basename(dir)}-trace.log`)
    scratchDirs.push(traceFile)
    const { result: oid, trace } = await withGitTrace(traceFile, () =>
      treeDigest(dir),
    )

    expect(trace).toMatch(/read-tree/)
    const headTree = await git(dir, ['rev-parse', 'HEAD^{tree}'])
    expect(oid).toBe(headTree)
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false)
  })

  it('falls back to read-tree --empty for an unborn HEAD without an index', async () => {
    const dir = makeScratchDir('vd-tds-')
    await initRepo(dir)
    writeFileSync(join(dir, 'c.txt'), 'untracked only\n')

    const traceFile = join(dir, '..', `${basename(dir)}-trace.log`)
    scratchDirs.push(traceFile)
    const { result: oid, trace } = await withGitTrace(traceFile, () =>
      treeDigest(dir),
    )

    expect(trace).toMatch(/read-tree/)
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it("uses the linked worktree's own index (S12)", async () => {
    const repoDir = makeScratchDir('vd-tds-')
    await initRepo(repoDir)
    writeFileSync(join(repoDir, 'a.txt'), 'hello\n')
    await git(repoDir, ['add', 'a.txt'])
    await git(repoDir, ['commit', '-m', 'initial'])
    const wtParent = makeScratchDir('vd-tds-wt-')
    const wtDir = join(wtParent, 'wt')
    await git(repoDir, ['worktree', 'add', '--detach', wtDir])
    writeFileSync(join(wtDir, 'a.txt'), 'hello modified\n')

    const traceFile = join(wtParent, 'trace.log')
    const { result: oid, trace } = await withGitTrace(traceFile, () =>
      treeDigest(wtDir),
    )

    expect(trace).not.toMatch(/read-tree/)
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const headTree = await git(wtDir, ['rev-parse', 'HEAD^{tree}'])
    expect(oid).not.toBe(headTree)
  }, 20_000)

  it('does not modify the real index', async () => {
    const dir = makeScratchDir('vd-tds-')
    await initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'a.txt'), 'hello modified\n')
    writeFileSync(join(dir, 'b.txt'), 'untracked\n')

    const indexPath = join(dir, '.git', 'index')
    const before = readFileSync(indexPath)
    const mtimeBefore = statSync(indexPath).mtimeMs

    await treeDigest(dir)

    const after = readFileSync(indexPath)
    const mtimeAfter = statSync(indexPath).mtimeMs
    expect(before.equals(after)).toBe(true)
    expect(mtimeAfter).toBe(mtimeBefore)
  })
})
