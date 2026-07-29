/**
 * A/B replay — the primary acceptance criterion of the adapter-seam refactor
 * (design §8.3 Step 1 主基準). A pure structural move must not change what is
 * recorded or reported, and the tool's own identity check proves it: `run_id`
 * is the digest of a run record minus its `recording` group (spec §3.5), so
 * two binaries that observe the same physical run identically produce the same
 * `run_id`. Report bytes are compared alongside it because the comparator /
 * gate / public-API edits of Step 1 never reach a run record (§8.1
 * limitation 2).
 *
 * Everything `run_id` covers that is *not* the code under test is pinned: the
 * workspace's absolute path, the git commit clock, and — asserted before any
 * comparison — the version both binaries report. What is left to explain a
 * mismatch is a behavior change.
 *
 * Two modes:
 *   - A/B (`VDELTA_AB_BASELINE_DIST=<path to a baseline dist>`): baseline
 *     binary vs this worktree's `dist`, over every fixture. Skipped when the
 *     variable is unset, i.e. it runs on CI once a baseline build exists.
 *   - self-test (always): the same binary on both sides. It cannot detect a
 *     behavior change — there is none — and instead proves the harness's own
 *     determinism, without which the A/B mode's mismatches would be noise.
 */
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  AB_REPLAY_EXCLUSIONS,
  assertSameCliVersion,
  DEFAULT_CLI,
  type FixtureReplay,
  replayFixture,
} from './runner.js'

const FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'conformance',
  'fixtures',
)

/**
 * Both passes record from this one path (§8.3 mechanism 2): `repo.worktree`
 * and `repo.identity` are absolute paths inside the record and `run_id`
 * covers them. Wiped and recreated per pass by the runner, and never shared —
 * the conformance project pins `fileParallelism: false` and vitest runs the
 * cases of a file in sequence.
 */
const AB_WORKSPACE_ROOT = join(tmpdir(), 'vdelta-ab-replay')

/**
 * The clock every fixture commit is made on (§8.3 mechanism 3). A commit SHA
 * hashes its author/committer timestamps and reaches `run_id` through
 * `provenance.head`.
 */
const AB_GIT_DATE = '2026-01-01T00:00:00+0000'

const baselineDist = process.env.VDELTA_AB_BASELINE_DIST
const baselineCli =
  baselineDist === undefined ? null : join(baselineDist, 'cli.js')

const allFixtures = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      existsSync(join(FIXTURES_DIR, e.name, 'manifest.json')),
  )
  .map((e) => e.name)
  .sort()

const replayable = allFixtures.filter((n) => !AB_REPLAY_EXCLUSIONS.has(n))

/**
 * The self-test's subset. Replaying all 46 fixtures twice costs the same as
 * running the conformance suite twice (~7 min measured), which is too much for
 * the default suite — the cut is a cost decision, not a determinism one: all
 * 46 do replay identically (see `AB_REPLAY_EXCLUSIONS`). These four cover
 * every path the A/B comparison reads, cheaply:
 *
 *   - `inv6-determinism-byte-identical` — two runs plus a repeated compare;
 *     the fixture that already asserts byte-identical output, so the harness
 *     is exercised against the one case that must never drift.
 *   - `recall-true-fix` — red → green across a commit: the git clock
 *     (mechanism 3) and a non-empty transitions block in the report bytes.
 *   - `pit-flag-value-forms` — two runs whose selector normalization decides
 *     the stream key, i.e. the comparator input most sensitive to the vitest
 *     CLI surface that Step 1 moves behind the seam.
 *   - `inv11-gate-staleness-exact` — the only step kind left, `gate`, and
 *     with it the gate report bytes.
 */
const SELF_TEST_FIXTURES = [
  'inv6-determinism-byte-identical',
  'recall-true-fix',
  'pit-flag-value-forms',
  'inv11-gate-staleness-exact',
]

const selfTestTargets = SELF_TEST_FIXTURES.filter((n) => replayable.includes(n))

function replayPass(name: string, cliPath: string): Promise<FixtureReplay> {
  return replayFixture(join(FIXTURES_DIR, name), {
    cliPath,
    workspaceRoot: AB_WORKSPACE_ROOT,
    gitDate: AB_GIT_DATE,
  })
}

/** Sorted plain object, so a mismatch reports a readable diff. */
function ordered(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)))
}

function expectIdentical(
  name: string,
  a: FixtureReplay,
  b: FixtureReplay,
): void {
  expect(
    ordered(b.runIds),
    `${name}: run_id differs between passes — the recorded content is not identical (§3.5)`,
  ).toEqual(ordered(a.runIds))
  expect(
    Object.keys(ordered(b.reportTexts)),
    `${name}: the two passes produced reports for different steps`,
  ).toEqual(Object.keys(ordered(a.reportTexts)))
  // Per step, so the diff is one report rather than the whole fixture.
  for (const [id, text] of a.reportTexts) {
    expect(
      b.reportTexts.get(id),
      `${name}: report of step "${id}" is not byte-identical between passes`,
    ).toBe(text)
  }
}

describe.skipIf(baselineCli === null)(
  'A/B replay: baseline binary vs candidate binary (§8.3 Step 1 主基準)',
  () => {
    beforeAll(async () => {
      if (baselineCli === null) return
      if (!existsSync(baselineCli)) {
        throw new Error(
          `VDELTA_AB_BASELINE_DIST=${String(baselineDist)} has no cli.js — point it at a built dist directory`,
        )
      }
      // Mechanism 5: abort before comparing anything, never after.
      await assertSameCliVersion(baselineCli, DEFAULT_CLI)
    })

    for (const name of replayable) {
      it(name, async () => {
        const baseline = await replayPass(name, baselineCli!)
        const candidate = await replayPass(name, DEFAULT_CLI)
        expectIdentical(name, baseline, candidate)
      })
    }
  },
)

describe('A/B replay self-test: the harness is deterministic', () => {
  for (const name of selfTestTargets) {
    it(name, async () => {
      const first = await replayPass(name, DEFAULT_CLI)
      const second = await replayPass(name, DEFAULT_CLI)
      expectIdentical(name, first, second)
    })
  }

  // Both hand-written lists are matched against the fixture directory: a
  // renamed fixture would otherwise silently shrink the A/B corpus (a dead
  // exclusion) or the self-test (a name that filters itself away).
  it('the harness lists name only fixtures that exist (§8.3 mechanism 6)', () => {
    expect(
      [...AB_REPLAY_EXCLUSIONS.keys()].filter((n) => !allFixtures.includes(n)),
      'exclusions naming no fixture',
    ).toEqual([])
    expect(
      SELF_TEST_FIXTURES.filter((n) => !allFixtures.includes(n)),
      'self-test entries naming no fixture',
    ).toEqual([])
  })
})
