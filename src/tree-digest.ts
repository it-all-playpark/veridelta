/**
 * tree_digest (spec §3.5, algorithm proven in
 * claudedocs/2026-07-16-expA-tree-digest.md, ported verbatim):
 * a git tree object id over tracked+staged+unstaged+untracked files,
 * excluding committed-gitignore'd paths, computed against a dedicated
 * throwaway index, with host-dependent git settings pinned.
 * Rendered as a bare 40-hex OID (documented deviation from sha256:).
 *
 * treeDigest() is read-only with respect to the observed repo: all git
 * object writes (blobs from `add -A`, the tree from `write-tree`) are
 * redirected to a throwaway GIT_OBJECT_DIRECTORY under tmpdir(), while the
 * repo's real objects (resolved via `--git-path objects`, which also
 * handles linked worktrees whose objects live in the common dir) are made
 * available for reads through GIT_ALTERNATE_OBJECT_DIRECTORIES. The
 * throwaway directory is removed again once the digest has been computed.
 *
 * The throwaway index (GIT_INDEX_FILE) is seeded from a byte copy of the
 * repository's real index file (resolved via `--git-path index`, which
 * yields the per-worktree index for linked worktrees) with its mtime
 * preserved, so git's stat cache is honoured and `add -A` re-hashes only
 * files whose stat data changed, keeping cost proportional to dirty files
 * instead of tracked files. `add -A` + `write-tree` reconcile the index
 * with the working tree so the resulting tree id is independent of the
 * seed (verified for the S1-S17 scenarios of issue #81 and enforced by
 * tests/unit/tree-digest-parity.test.ts).
 *
 * (1) racy-git: correctness of the stat-cache shortcut rests on git's
 * racy-git handling (entries whose mtime is not older than the index
 * file's mtime are re-read rather than trusted, and racily-clean entries
 * are size-smudged at write time); the copy preserves the real index's
 * mtime so these semantics are identical to git's own; the issue's 20/20
 * same-size-same-second sample is evidence, not proof; environments that
 * rewrite file stat data behind git's back (tools that restore mtimes,
 * some sync/backup agents) can break this premise -- when in doubt such
 * environments should be treated as unverified.
 *
 * (2) split-index / extensions: an index with the `link` extension
 * (core.splitIndex) still resolves `sharedindex.*` from the real git dir,
 * so a copied index works (S14 in #81); however core.untrackedCache,
 * core.fsmonitor and index.sparse were all unset in every repo the change
 * was validated against, and behaviour with those enabled is UNVERIFIED.
 * assume-unchanged (CE_VALID) and skip-worktree (sparse-checkout) entries
 * are handled explicitly: `add -A` skips them via ie_match_stat without
 * stat'ing the working tree, so a copied index carrying either flag on a
 * changed file would silently keep the stale HEAD content. After copying,
 * `git ls-files -v` is run against the throwaway index and, if any entry
 * reports a lowercase tag (assume-unchanged) or an `S`/`s` tag
 * (skip-worktree), the copy is discarded and seeding falls back to
 * `read-tree` (note 3) instead, which always re-stats every path via
 * `add -A`. Covered by S16 (assume-unchanged) and S17 (skip-worktree) in
 * tests/unit/tree-digest-parity.test.ts.
 *
 * (3) fallback: when the real index file does not exist (fresh `git
 * init`, checkout from bare, `rm .git/index`) or cannot be copied, the
 * index is seeded with `git read-tree HEAD` (or `read-tree --empty` for
 * an unborn HEAD) exactly as before; this fallback MUST be kept.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, stat, utimes } from 'node:fs/promises'
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

/**
 * Seed the throwaway index by copying the repository's real index file
 * byte-for-byte, preserving its mtime (see header note 1: preserving
 * mtime keeps racy-git behaviour identical to git's own handling of the
 * real index). Returns false when the real index does not exist or the
 * copy cannot be completed, in which case any partial copy is removed and
 * the caller MUST fall back to `read-tree` (header note 3).
 */
async function seedFromRealIndex(
  realIndex: string,
  idx: string,
): Promise<boolean> {
  try {
    const st = await stat(realIndex)
    if (!st.isFile()) return false
    await copyFile(realIndex, idx)
    await utimes(idx, st.atime, st.mtime)
    return true
  } catch {
    await rm(idx, { force: true })
    return false
  }
}

/**
 * `git ls-files -v` tags each entry H (cached), S (skip-worktree), M
 * (unmerged), R (removed), C (modified/changed) or K (to be killed); the
 * tag is lowercased when the entry also has the assume-unchanged
 * (CE_VALID) bit set. `add -A` reconciles the index against the working
 * tree via ie_match_stat, which treats both assume-unchanged and
 * skip-worktree entries as trusted and skips re-stat'ing them -- so a
 * copied real index carrying either flag on a changed file would leave the
 * throwaway index (and therefore the resulting tree) pinned to the stale
 * content. Detect that here so the caller can fall back to a `read-tree`
 * seed, which re-stats every path.
 */
function hasUntrustworthyIndexFlags(lsFilesOutput: string): boolean {
  return lsFilesOutput
    .split('\n')
    .some((line) => line !== '' && /^[a-z]|^[Ss]/.test(line))
}

export async function treeDigest(worktree: string): Promise<string> {
  const idx = join(tmpdir(), `vd-idx-${randomUUID()}`)
  const objDir = join(tmpdir(), `vd-obj-${randomUUID()}`)
  try {
    await mkdir(objDir, { recursive: true })
    const paths = await git(worktree, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
      '--git-path',
      'index',
    ])
    const [realObjects = '', realIndex = ''] = paths.split(/\r?\n/)
    const existingAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
    const alternates = existingAlternates
      ? `${realObjects}${delimiter}${existingAlternates}`
      : realObjects
    const env = {
      GIT_INDEX_FILE: idx,
      GIT_OBJECT_DIRECTORY: objDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    }

    let seeded = await seedFromRealIndex(realIndex, idx)
    if (
      seeded &&
      hasUntrustworthyIndexFlags(await git(worktree, ['ls-files', '-v'], env))
    ) {
      seeded = false
    }
    if (!seeded) {
      let hasHead = true
      try {
        await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])
      } catch {
        hasHead = false
      }
      await git(worktree, ['read-tree', hasHead ? 'HEAD' : '--empty'], env)
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
