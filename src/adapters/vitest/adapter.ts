/**
 * vitest adapter, descriptor side: the runner-facing half of the seam
 * (`src/adapter.ts`). Everything vitest-specific about *invoking* a run lives
 * here — locating the vitest binary in the child argv, injecting the capture
 * reporter, and splitting inclusion intent out of the command (§6.4) using
 * vitest's own CLI surface. The recorder half (capture → RunRecord) stays in
 * `./recorder.ts`; this module only owns reading and parsing the channel.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Adapter,
  AdapterCaptureError,
  type CaptureChannel,
  type CommandSelector,
  type SelectorMatch,
  type SelectorRelation,
} from '../../adapter.js'
import type { Capture } from './capture.js'
import {
  ADAPTER_NAME,
  buildRunRecord,
  COMPOSITION_ID,
  DECLARED_ENV_VARS,
  VITEST_CAPABILITIES,
} from './recorder.js'

/**
 * Re-exported from the recorder (§3.4): the declaration lives in
 * `recorder.ts` so `buildRunRecord` can write it into `instrument.capabilities`
 * without an import cycle. Kept here too so existing consumers of this
 * descriptor module keep importing it from `adapter.js`.
 */
export { VITEST_CAPABILITIES }

/**
 * Absolute path of the in-process vitest reporter that writes the capture.
 * Resolved relative to this module so it points at the built sibling
 * (`dist/adapters/vitest/reporter.js`) rather than at a source path.
 */
function reporterModulePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'reporter.js')
}

/**
 * The one env var the capture reporter reads (`reporter.ts:61`). Held here
 * rather than inline so `channelEnv` and the reporter's contract stay a single
 * fact; the reporter is inert without it, by design, so that it can sit
 * permanently in a project's vitest config (spec §4.2 ambient recording).
 */
const CAPTURE_FILE_ENV = 'VDELTA_CAPTURE_FILE'

function channelEnv(channel: CaptureChannel): Record<string, string> {
  return { [CAPTURE_FILE_ENV]: channel.path }
}

/** Parse the channel, or `undefined` when there is nothing readable in it. */
function readCapture(channel: CaptureChannel): Capture | undefined {
  try {
    return JSON.parse(readFileSync(channel.path, 'utf8')) as Capture
  } catch {
    return undefined
  }
}

/** Locate the vitest invocation inside the child argv; null when absent. */
function findVitestToken(cmd: readonly string[]): number | null {
  for (let i = 0; i < cmd.length; i++) {
    const token = cmd[i]!
    if (/(^|[\\/])vitest(\.mjs|\.js)?$/.test(token) || token === 'vitest')
      return i
  }
  return null
}

/**
 * vitest 4.x CLI flags that always take their value as a *separate* argv
 * token (`--flag value`), never combined into the flag token itself. Used
 * by {@link splitCommandSelector} to recognize `--flag value` pairs and fold
 * them into a single `--flag=value` canonical token so that space-separated
 * and `=`-joined invocations normalize to the same command array (and
 * therefore the same stream key — see `streamKey` in src/compare.ts).
 *
 * Deliberately excludes flags whose value is *optional*
 * (`--changed`, `--silent`, `--coverage`, `--browser`, `--inspect`, etc.):
 * for those, the token following the flag cannot be distinguished from a
 * positional selector without vitest's own arg-parsing rules, so folding
 * them here would risk silently swallowing a selector token. Flags outside
 * this list keep the historical (pre-fix) behavior: a space-separated value
 * is treated as a selector token, which may cause selector-based stream
 * splitting and an abstain (`comparability: 'none'`) rather than a
 * false-positive comparison.
 *
 * Maintenance: this list targets vitest 4.x. Revisit when bumping the
 * vitest minor/major version (see issue #15 Open Question — no automated
 * mechanism keeps this in sync with vitest's own CLI surface).
 */
const VITEST_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--project',
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--reporter',
  '--outputFile',
  '--pool',
  '--maxWorkers',
  '--minWorkers',
  '--environment',
  '--testNamePattern',
  '-t',
  '--testTimeout',
  '--hookTimeout',
  '--teardownTimeout',
  '--retry',
  '--bail',
  '--maxConcurrency',
  '--shard',
  '--exclude',
  '--mode',
  '--workspace',
])

/**
 * The invocation's selector is its inclusion intent (§6.4): the vitest CLI
 * positional filters. The canonical command excludes them (§5.1).
 *
 * `--flag value` pairs for known value-taking flags (see
 * {@link VITEST_VALUE_FLAGS}) are folded into a single `--flag=value`
 * canonical token so that this form and the pre-joined `--flag=value` form
 * produce byte-identical `command` arrays (and thus the same stream key).
 */
export function splitCommandSelector(cmd: readonly string[]): CommandSelector {
  const idx = findVitestToken(cmd)
  if (idx === null) return { command: [...cmd], selector: [] }
  const command: string[] = cmd.slice(0, idx + 1)
  const selector: string[] = []
  for (let i = idx + 1; i < cmd.length; i++) {
    const token = cmd[i]!
    if (token === 'run' && i === idx + 1) {
      command.push(token)
      continue
    }
    if (!token.startsWith('-')) {
      selector.push(token)
      continue
    }
    if (token.includes('=')) {
      command.push(token)
      continue
    }
    const next = cmd[i + 1]
    if (
      VITEST_VALUE_FLAGS.has(token) &&
      next !== undefined &&
      !next.startsWith('-')
    ) {
      command.push(`${token}=${next}`)
      i++
      continue
    }
    command.push(token)
  }
  return { command, selector }
}

/**
 * §6.4 selector-relation capability, pure-function half: normalizes a raw
 * selector token the same way regardless of whether it came from the
 * invocation's own selector or from a test id's `rel` half.
 *
 * Lower-cases (vitest's own filter match is case-insensitive — see
 * {@link isDecidableToken} doc comment), strips a leading `./` and a
 * trailing `/`, both of which are path-spelling variance rather than
 * selection intent.
 */
export function normalizeToken(token: string): string {
  let t = token.toLowerCase()
  if (t.startsWith('./')) t = t.slice(2)
  if (t.endsWith('/')) t = t.slice(0, -1)
  return t
}

/** Glob metacharacters vitest's filter surface treats specially. */
const GLOB_META = /[*?[\]{}()!]/

/**
 * Whether a normalized token's *meaning* under vitest's filter is decidable
 * from its spelling alone (issue #64 decision, spec §6.4). vitest 4.x
 * resolves positional filters by case-insensitive substring match against
 * the relative test file path (measured in
 * `node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:10860-10872`,
 * `filterFiles`); a token that is plain lowercase path-ish text behaves the
 * same way whether that stays substring matching or narrows to a
 * directory-prefix interpretation. Excluded, because their meaning is not
 * pinned by that shared ground:
 *
 * - tokens starting with `-` (an unfolded flag leaking through, not a
 *   selector),
 * - tokens containing a `..` path segment (traversal, not a containable
 *   prefix),
 * - tokens starting with `/` (absolute path — outside the worktree-relative
 *   space {@link tokenCovers} reasons about),
 * - tokens containing `:` (vitest's `file:line`/`file:column` position
 *   filter — matches a single location, not a path prefix),
 * - tokens containing a glob metacharacter (`* ? [ ] { } ( ) !` — matched by
 *   vitest's own glob engine, not by substring/prefix).
 */
export function isDecidableToken(token: string): boolean {
  if (!/^[a-z0-9._/-]+$/.test(token)) return false
  if (token.startsWith('-')) return false
  if (token.startsWith('/')) return false
  if (token.includes(':')) return false
  if (GLOB_META.test(token)) return false
  if (token === '..' || token.split('/').includes('..')) return false
  return true
}

/**
 * `narrow`'s selection is contained in `wide`'s under the path-segment-
 * prefix reading: identical, or `wide` is a path-segment ancestor of
 * `narrow`. Sound under both vitest's current substring interpretation and
 * a hypothetical future directory-prefix interpretation (see
 * {@link isDecidableToken}) — a strictly narrower notion of containment than
 * either, never a wider one.
 */
export function tokenCovers(wide: string, narrow: string): boolean {
  return narrow === wide || narrow.startsWith(`${wide}/`)
}

/**
 * §6.4 selector-relation capability. `a`/`b` are raw (un-normalized)
 * `invocation.selector` arrays; the empty array means "no positional
 * filter" (i.e. selects the whole inventory — vitest's universe).
 *
 * The `superset`/`subset` branches for one side empty do not claim
 * properness (an empty selector could tie a non-empty one extensionally
 * were the non-empty one to also cover the whole inventory, which this
 * function cannot know) — only that positional filters narrow and never
 * widen, so a non-empty selector's selection can never exceed the universe.
 * The previous-superset "b" and "b" of the comparator, i.e. proving a
 * *strict* narrowing, is out of scope here (see issue's follow-up "E").
 *
 * `disjoint` means the two token sets have no pairwise path-segment-prefix
 * overlap. It does **not** prove the two selectors' matched test sets are
 * disjoint under vitest's actual substring interpretation: tokens `"alpha"`
 * and `"beta"` are pairwise prefix-disjoint here, yet both match a file
 * named `alpha-beta.test.ts`. The comparator that consumes this function
 * today folds `disjoint` into the same abstention as `unknown`, so this
 * unsoundness produces no observable wrong claim — but an implementation
 * that starts consuming `disjoint` as a distinct, stronger signal (e.g. to
 * assert non-overlap) MUST NOT do so without re-deriving that guarantee;
 * this comment is the flag to revisit at that point.
 */
export function selectorRelation(
  a: readonly string[],
  b: readonly string[],
): SelectorRelation {
  const normA = [...new Set(a.map(normalizeToken))]
  const normB = [...new Set(b.map(normalizeToken))]

  if (setsEqual(normA, normB)) return 'equal'
  if (a.length === 0 && b.length > 0) return 'superset'
  if (b.length === 0 && a.length > 0) return 'subset'

  if (normA.length > 0 && normB.length > 0) {
    if (normA.some((t) => !isDecidableToken(t))) return 'unknown'
    if (normB.some((t) => !isDecidableToken(t))) return 'unknown'
  }

  const aSubB = normA.every((aTok) =>
    normB.some((bTok) => tokenCovers(bTok, aTok)),
  )
  const bSubA = normB.every((bTok) =>
    normA.some((aTok) => tokenCovers(aTok, bTok)),
  )
  if (aSubB && bSubA) return 'equal'
  if (aSubB) return 'subset'
  if (bSubA) return 'superset'

  const anyOverlap = normA.some((aTok) =>
    normB.some((bTok) => tokenCovers(aTok, bTok) || tokenCovers(bTok, aTok)),
  )
  return anyOverlap ? 'unknown' : 'disjoint'
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((t) => bSet.has(t))
}

/**
 * §6.4 selector-relation capability, second half: does `selector` (a raw
 * `invocation.selector` array) match a single canonical test id
 * (`<rel>::<full name>`, `recorder.ts`'s `testId`)?
 *
 * Per-token decision, then union across tokens (vitest's positional filters
 * are inclusive-OR): a single deciding `yes` wins regardless of other
 * tokens' verdicts; otherwise `no` only when every token is decidably `no`;
 * otherwise `unknown` (at least one token could not be decided either way).
 */
export function selectorMatches(
  selector: readonly string[],
  testId: string,
): SelectorMatch {
  if (selector.length === 0) return 'yes'
  const sepIndex = testId.indexOf('::')
  const rel = normalizeToken(
    sepIndex === -1 ? testId : testId.slice(0, sepIndex),
  )

  const perToken = selector.map((raw): SelectorMatch => {
    const token = normalizeToken(raw)
    if (!isDecidableToken(token)) return 'unknown'
    if (tokenCovers(token, rel)) return 'yes'
    if (!rel.includes(token)) return 'no'
    return 'unknown'
  })

  if (perToken.includes('yes')) return 'yes'
  if (perToken.every((m) => m === 'no')) return 'no'
  return 'unknown'
}

/**
 * §6.4: canonical-command flags that perturb the child's execution scope
 * beyond the positional selector. `--changed`/`--testNamePattern`/`-t` are
 * the spec's own examples (comparator MUST NOT infer `subset` past them —
 * issue decision 4, monotonicity reasoning explicitly disallowed). `--shard`
 * is included because shard partitioning is not monotone in the file set —
 * the same shard index selects a different file subset depending on the
 * *total* inventory, so a positional-selector subset relation does not
 * carry over. `--related` is included because it expands the selection
 * through the module dependency graph, a relation `selectorRelation` (path-
 * prefix only) knows nothing about. `--test-name-pattern` is `--testNamePattern`'s
 * kebab-case alias (vitest 4.1.10 accepts both spellings for the same flag)
 * and must perturb scope identically — omitting it would let the alias slip
 * the pattern's value into the positional selector unperturbed, defeating
 * this list's fail-closed guarantee for that spelling.
 */
export const SCOPE_PERTURBING_FLAGS: readonly string[] = [
  '--changed',
  '--testNamePattern',
  '--test-name-pattern',
  '-t',
  '--shard',
  '--related',
]

export function commandScopePerturbed(command: readonly string[]): boolean {
  return command.some((token) =>
    SCOPE_PERTURBING_FLAGS.some(
      (flag) => token === flag || token.startsWith(`${flag}=`),
    ),
  )
}

export const vitestAdapter: Adapter = {
  name: ADAPTER_NAME,
  compositionId: COMPOSITION_ID,
  declaredCapabilities: VITEST_CAPABILITIES,
  declaredEnvVars: DECLARED_ENV_VARS,

  detect(argv) {
    const i = findVitestToken(argv)
    return i === null ? null : { tokenIndex: i }
  },

  channelEnv,

  instrument(argv, channel) {
    return {
      argv: [
        ...argv,
        '--reporter=default',
        `--reporter=${reporterModulePath()}`,
        '--includeTaskLocation',
      ],
      env: channelEnv(channel),
    }
  },

  splitCommandSelector,

  claimsCapture(channel) {
    // Authorship only, and from the payload's own self-identification
    // (`capture.ts:34`, a literal `'vitest'`). Deliberately not a version or
    // shape check: a capture this adapter wrote but cannot read must reach
    // `record` so the run degrades with *that* diagnostic ("unsupported
    // capture version N") instead of the generic "is the child a vitest
    // invocation?", which is what the pre-seam code path said.
    return readCapture(channel)?.runner === 'vitest'
  },

  record(channel, ctx) {
    const capture = readCapture(channel)
    if (capture === undefined) {
      throw new AdapterCaptureError(
        'no capture from the vitest reporter — is the child a vitest invocation?',
      )
    }
    return buildRunRecord(capture, ctx)
  },

  selectorRelation,
  selectorMatches,
  commandScopePerturbed,
}
