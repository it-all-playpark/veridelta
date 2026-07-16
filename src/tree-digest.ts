/**
 * tree_digest (spec §3.5, algorithm proven in
 * claudedocs/2026-07-16-expA-tree-digest.md, ported verbatim):
 * a git tree object id over tracked+staged+unstaged+untracked files,
 * excluding committed-gitignore'd paths, computed against a dedicated
 * throwaway index seeded from HEAD, with host-dependent git settings pinned.
 * Rendered as a bare 40-hex OID (documented deviation from sha256:).
 *
 * treeDigest() is read-only with respect to the observed repo: all git
 * object writes (blobs from `add -A`, the tree from `write-tree`) are
 * redirected to a throwaway GIT_OBJECT_DIRECTORY under tmpdir(), while the
 * repo's real objects (resolved via `--git-path objects`, which also
 * handles linked worktrees whose objects live in the common dir) are made
 * available for reads through GIT_ALTERNATE_OBJECT_DIRECTORIES. The
 * throwaway directory is removed again once the digest has been computed.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

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
  worktree: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileP('git', [...PIN, '-C', worktree, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

export async function treeDigest(worktree: string): Promise<string> {
  const idx = join(tmpdir(), `vd-idx-${randomUUID()}`)
  const objDir = join(tmpdir(), `vd-obj-${randomUUID()}`)
  try {
    await mkdir(objDir, { recursive: true })
    const realObjects = await git(worktree, [
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
      await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])
    } catch {
      hasHead = false
    }
    if (hasHead) {
      await git(worktree, ['read-tree', 'HEAD'], env)
    } else {
      await git(worktree, ['read-tree', '--empty'], env)
    }
    await git(worktree, ['add', '-A'], env)
    return await git(worktree, ['write-tree'], env)
  } finally {
    await rm(idx, { force: true })
    await rm(objDir, { recursive: true, force: true })
  }
}

export async function gitHead(worktree: string): Promise<string | null> {
  try {
    return await git(worktree, ['rev-parse', 'HEAD'])
  } catch {
    return null
  }
}

export async function gitBranch(worktree: string): Promise<string> {
  try {
    const b = await git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'])
    return b === '' ? 'DETACHED' : b
  } catch {
    return 'DETACHED'
  }
}

export async function gitRepoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

/** Resolve a ref to {commitSha, treeOid}; null when unresolvable. */
export async function resolveRef(
  worktree: string,
  ref: string,
): Promise<{ commit: string; tree: string } | null> {
  try {
    const commit = await git(worktree, [
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
    ])
    const tree = await git(worktree, ['rev-parse', '--verify', `${ref}^{tree}`])
    return { commit, tree }
  } catch {
    return null
  }
}

/** Deterministic digest material for the dirty state (status + diff vs HEAD). */
export async function dirtyDiffMaterial(worktree: string): Promise<string> {
  try {
    const status = await git(worktree, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ])
    let diff = ''
    if ((await gitHead(worktree)) !== null) {
      diff = await git(worktree, ['diff', 'HEAD', '--no-color'])
    }
    return `${status}\n${diff}`
  } catch {
    return ''
  }
}
