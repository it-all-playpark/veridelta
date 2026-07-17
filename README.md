# veridelta / vdelta

**Proof-carrying verification deltas for coding-agent development loops.**

`vdelta` is the reference implementation of the
[`veridelta/1` protocol](spec/veridelta-1.md): given two comparable test
runs, it reports — deterministically and with evidence — whether a change
*improved* the outcome while *maintaining the same verification surface*,
whether pre-existing failures mutated into different failures, and whether
red results disappeared because they were fixed or because the verification
surface shrank (fail→skip, deleted tests, weakened assertions).

It is not a log summarizer. It is a trust layer: an exit code cannot tell an
agent (or a CI gate reviewing an agent's PR) "you fixed one thing and broke
another" — a verification delta can, and when two runs are not comparable it
**abstains instead of guessing**.

- Runner support (MVP): **vitest v4** (native reporter, structured channel only)
- Zero runtime dependencies; Node ≥ 20
- Machine-verified against the [conformance suite](conformance/) —
  39 fixtures covering the spec's invariants, adversarial inputs, and a
  10-mutation cheating corpus with 100% detection recall

## Quickstart (5 minutes)

Requires Node 20+ inside a git repository.

```bash
npm i -D vitest vdelta
```

Create a failing test:

```ts
// src/status.ts
export const getStatus = () => 500

// tests/status.test.ts
import { test, expect } from 'vitest'
import { getStatus } from '../src/status.js'

test('status is ok', () => {
  expect(getStatus()).toBe(200)
})
```

Record the red run (vdelta wraps your normal test command — it injects its
reporter, captures everything, and passes the child's exit code through):

```bash
npx vdelta run -- npx vitest run
# veridelta/1 inconclusive (comparability: none)
#   reason: baseline-missing (determined)   ← first run: nothing to compare yet
#   red now (1):
#     ✗ tests/status.test.ts::status is ok
```

Fix the bug (`500` → `200`), then run again:

```bash
npx vdelta run -- npx vitest run
# veridelta/1 improved (comparability: exact)
#   repaired: 1 same-surface, 0 with-test-change   ← a real fix, not a hidden skip
```

Had you "fixed" it with `test.skip` instead, the same command reports
`fail_to_skip` and `surface: reduced` — never `repaired`.

Everything is also available as machine-readable JSON (the primary
interface), with drill-down anchors for every omitted detail:

```bash
npx vdelta run --report json -- npx vitest run   # report on stdout, exit = vitest's
npx vdelta compare --report json                 # re-compare the last two runs
npx vdelta show run_ab12cd34 --test 'tests/status.test.ts::status is ok'
npx vdelta show run_ab12cd34 --raw               # the captured vitest output
```

Gate a change against a baseline ref (report-only policy — builds trust
before it ever blocks):

```bash
npx vdelta gate --ref origin/main --policy report-only --report json
```

The gate verifies record integrity (content-addressed run ids) and staleness
(the recorded tree must equal the judged working tree, byte-exact) before it
judges anything.

## Commands

| Command | Purpose | Exit code |
|---|---|---|
| `vdelta run [--report json\|text] -- <cmd>` | Execute, record, report | The child's exit code, unchanged. Internal errors degrade to raw passthrough — vdelta is never worse than its absence. |
| `vdelta compare [<baseline> <current>] [--ref <git-ref>]` | Compare recorded runs (explicit ids, a git ref, or the previous comparable run) | 0 when the comparison ran (an `inconclusive` result is a successful comparison); 1 on operation failure |
| `vdelta show <run-id> [--test <id>\|--raw]` | Drill down into a run record | Retrieval success |
| `vdelta gate --ref <git-ref> [--policy report-only]` | Policy verdict for CI/agent loops | report-only: 0 when a report was produced; 2 otherwise |
| `vdelta gc [--max-count <n>] [--max-bytes <n>]` | Reclaim run records beyond the retention policy | 0 = reclaimed or no-op; 1 = failed |

Run ids may be abbreviated to any unambiguous prefix.

`vdelta run` also runs this retention policy automatically after recording
each run (a failure there only downgrades to a stderr diagnostic — it never
fails the run). The policy is bounded by count and/or total bytes, whichever
is hit first; the record `last` points to is always kept. Defaults are 100
runs / 64MiB, overridable via `VDELTA_GC_MAX_COUNT` / `VDELTA_GC_MAX_BYTES`
(positive integers; unset/invalid falls back to the default, `0` or
non-numeric disables that limit).

## What the report separates (and why)

Three axes, never collapsed into one:

1. **Outcome verdict** — `regressed | improved | unchanged | inconclusive`.
   One new or updated failure outweighs any number of repairs.
2. **Failure-mode delta** — the same test failing *differently* is
   `updated_fail` (evidence digests differ), never buried in
   "still failing". Test identity ≠ failure identity.
3. **Verification-surface delta** — red that vanished via `fail→skip`,
   deletion, `.only` narrowing, config excludes, or a rewritten assertion is
   reported as surface reduction / `repaired_with_test_change`,
   **never** as `repaired_same_surface`. Cheating is a first-class,
   separately-reported axis.

Comparability is judged first (`exact | scope_changed | partial | none`),
and every claim is bounded by it: instrument changes (e.g. a different
`chaiConfig.truncateThreshold`) abstain with `instrument-changed`; a missing
baseline abstains with `baseline-missing`. Reasons are closed enums —
consumers must treat unknown values as hard errors.

## vitest adapter notes

- The recorder injects `--includeTaskLocation` and its reporter into the
  vitest invocation; your config needs no changes. Evidence-affecting
  settings you *do* set (like `chaiConfig.truncateThreshold`) become part of
  the measuring-instrument identity.
- Positional arguments after the vitest token are recorded as the run's
  selector. If you pass vitest flags that take a value, use the
  `--flag=value` form (a separate value token would be read as a selector
  filter — comparisons then abstain; nothing false-greens).
- Evidence digests are built from vitest's structured channel only
  (exception type, message, structured expected/actual, operator, and
  line-shift-stable relative positions). Durations, absolute paths/lines,
  raw stacks, rendered diffs, and console output are stored as annex
  material, reachable via `vdelta show`, never digested.
- vitest's channel provides no failing-source-region text, so the adapter
  declares that capability `unsupported`; every red-in-both claim carries
  `degraded_capabilities: ["source-region-text"]`.
- Known secret shapes (AWS keys, GitHub/Slack tokens, JWTs, private keys,
  bearer tokens) are redacted deterministically before anything is stored
  or digested.
- The run store lives in `.veridelta/` (repo-local, self-gitignored,
  content-addressed, immutable).
- veridelta is read-only with respect to the observed repository: the only
  things it writes are its own `.veridelta/` store and throwaway files under
  the OS temp directory. Tree digesting uses a private index
  (`GIT_INDEX_FILE`) and a private object directory
  (`GIT_OBJECT_DIRECTORY`, with the repo's real objects supplied read-only
  via `GIT_ALTERNATE_OBJECT_DIRECTORIES`), so no loose objects are ever
  added to your `.git` — recording works even when the object database is
  not writable (e.g. sandboxed environments).

## Protocol

The spec is the product: [`spec/veridelta-1.md`](spec/veridelta-1.md)
defines the `veridelta/1` schema, trust invariants (INV-1..11), gate
semantics, and conformance requirements. Independent implementations are the
intended success mode.

## Conformance

```bash
npm test                     # unit + full conformance suite
npm run test:conformance     # the 39-fixture suite only
```

The suite is authored independently of this implementation (the fixture
author reads only the spec and the harness contract in
[docs/conformance-harness.md](docs/conformance-harness.md), never `src/`)
and mechanically verifies, among the spec's §13.2 classes: byte-identical
determinism of re-executed comparisons, 100% detection recall on the
cheating corpus, zero false green, fail-open degradation (INV-5),
record-integrity tampering detection (INV-10), exact tree-digest
staleness (INV-11), and read-only object-database recording (tree
digesting never writes loose objects into the observed repository's
`.git`, even when it is not writable).

## License

MIT — see [LICENSE](LICENSE).
