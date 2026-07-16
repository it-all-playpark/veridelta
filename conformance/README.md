# veridelta/1 conformance fixtures

This directory is the **published conformance suite** for the `veridelta/1`
protocol. Every fixture is authored **independently of any implementation**: the
expected values are deduced solely from `spec/veridelta-1.md` (revision 0.3.1)
and the shared interface contract in `docs/conformance-harness.md`. The fixture
author never reads `src/`; the implementer never edits `conformance/`. That
separation is the point — a fixture that passes proves the implementation agrees
with the *spec*, not with itself.

The runner that executes these manifests lives under `tests/` (implementer-owned)
and is described in `docs/conformance-harness.md`. Read that contract first; this
README only covers fixture-side conventions, the coverage map, the fixture
inventory, and findings sent back to the spec authors.

## How to read a fixture

```
fixtures/<name>/
  manifest.json            # steps + assertions (schema: harness contract §3–§4)
  projects/<project>/      # mini vitest project snapshots applied by `apply`
  data/*.json              # static consumer inputs (con-* only)
```

Each `manifest.json` carries:

- `class` — one of `invariant | adversarial | pitfall | consumer | recall`.
- `spec_refs` — the normative clauses the fixture pins (traceability).
- `mutation` — recall class only: the cheat kind.
- `notes` — the deduction: why these expected values follow from the spec.
- `steps` — executed in order (vocabulary: contract §3).
- `assertions` — all must hold after the steps (vocabulary: contract §4).

## Fixture-side conventions

- **Test IDs** are `tests/<file>.test.ts::<fullName>`, where `fullName` joins
  parent `describe` suites with `" > "` (contract §5.1). Fixtures keep the
  workspace-relative POSIX module path stable so IDs are predictable.
- **Every project ships a `.gitignore`** ignoring at least `node_modules` and
  `.veridelta` (contract §2); the tree digest honors committed ignore rules, and
  the runner symlinks `node_modules`. Projects that need an ephemeral state file
  (e.g. `adv-flaky-no-inference`) also ignore that file so it stays out of the
  tree.
- **Configs set only what the fixture probes.** `vitest.config.ts` never sets
  `reporters` or `includeTaskLocation` (the recorder injects both, contract §2).
  Where a fixture needs an evidence-affecting option it sets exactly that:
  `chaiConfig.truncateThreshold` (instrument identity), `bail` (partial runs),
  `fileParallelism` (worker ordering), `exclude` (collection modifier). Most
  fixtures omit the config file entirely.
- **No hardcoded digests / run_ids / absolute paths.** Identity is expressed
  with `sameValue` / `differentValue` / `matches` (`^sha256:[0-9a-f]{64}$`,
  `^run_[0-9a-f]{64}$`).
- **Mutations are inline.** A baseline project is `apply`-ed once; subsequent
  states are produced with `write-file` / `delete` / `edit-json` so the manifest
  reads as the story of the scenario. `adv-stale-cache-collision` is the sole
  exception: it needs `apply --preserveMtime` across three project snapshots.
- **Determinism.** No test uses `Math.random`/`Date.now` in a way that reaches a
  verdict or evidence. The one alternating test (`adv-flaky-no-inference`) is
  driven by a deterministic state file, not by chance.

### vitest verdict facts these fixtures rely on

Confirmed by running plain `vitest` (v4.1.10, node 24.18) against the project
snapshots; these back the expected verdicts:

| construct | vitest state | canonical verdict (contract §5.2) |
|---|---|---|
| `test.skip` | skipped/skip | `skip` (marker skip) |
| `test.todo` | skipped/todo | `skip` (marker todo) |
| `test.fails` + failing body | **passed** | `xfail` |
| `test.fails` + passing body | **failed** | `fail` (red) |
| `.only` elsewhere excludes a test | skipped/run | `skip` (marker runtime) |
| `bail:1` after first failure | remaining **pending** | `not_run`, completeness `partial` |

## Coverage map

Fixture classes 1–5 of spec §13.2 / contract §6 are all covered.

**Class 1 — invariants (INV-1..11), one+ each:**

| INV | fixture |
|---|---|
| INV-1 | `inv1-red-never-omitted` |
| INV-2 | `inv2-accounting-no-omission` |
| INV-3 | `inv3-verdict-channel-not-text` |
| INV-4 | `inv4-partial-no-false-repaired` (also `adv-partial-bail`) |
| INV-5 | `inv5-fail-open-held-lock` (also `pit-fail-open-vs-closed`) |
| INV-6 | `inv6-determinism-byte-identical` (also `adv-parallel-order`) |
| INV-7 | `inv7-claims-bounded-by-comparability` |
| INV-8 | `inv8-updated-fail-value-mutation` |
| INV-9 | `inv9-fail-to-skip-not-repaired` (+ every `recall-*`) |
| INV-10 | `inv10-gate-record-integrity` (gate path, per §13.2.1) |
| INV-11 | `inv11-gate-staleness-exact` (also `pit-wrong-target`) |

**Class 2 — adversarial:** reordering (`adv-parallel-order`), partial
(`adv-partial-bail`), flaky sequence (`adv-flaky-no-inference`), secret-bearing
output (`adv-secret-redaction`), branch crossing (`adv-branch-cross`), plus
§13.2 (a) `adv-rerun-stability`, (b) `adv-stale-cache-collision`,
(c) `adv-degraded-capability`, and a write-protected object database
(`adv-readonly-object-db`).

**Class 3 — operational pitfalls:** wrong target (`pit-wrong-target`),
instrument drift (`pit-instrument-drift`), duplicate records
(`pit-duplicate-records`), fail-open vs fail-closed (`pit-fail-open-vs-closed`).

**Class 4 — consumer:** valid report parses (`con-report-valid`), unknown enum
throws (`con-report-unknown-enum`), unknown field rejected
(`con-report-unknown-field`), run-record parse valid + unknown-enum
(`con-runrecord`).

**Class 5 — recall / cheat corpus (10 distinct cheats + 1 honest control):**
`recall-fail-to-skip`, `recall-fail-to-todo`, `recall-fail-to-testfails`,
`recall-test-deleted`, `recall-testfile-deleted`, `recall-only-narrowing`,
`recall-early-return`, `recall-tautology`, `recall-expected-rewritten`,
`recall-selector-exclude`, and the honest positive control `recall-true-fix`.
Each cheat asserts both **detection** (the spec-mandated transition/event fires)
and **no false green** (never `repaired_same_surface`; the surface axis flags
it).

## Fixture inventory

### Invariant (`inv-*`)

| fixture | spec_refs | verifies |
|---|---|---|
| inv1-red-never-omitted | INV-1, §7.3 | a red-in-both test is listed in `still_fail_unchanged`, never omitted or masked into a green verdict |
| inv2-accounting-no-omission | INV-2, §9.1 | passing detail is suppressed but all items are counted in `observation_coverage` (3/3) |
| inv3-verdict-channel-not-text | INV-3, §7.1 | verdicts derive from the runner channel; a passing test that prints failure text is not red |
| inv4-partial-no-false-repaired | INV-4, §6.1 | unobserved reds in a `bail` partial run are never `repaired`; verdict caps at inconclusive |
| inv5-fail-open-held-lock | INV-5, §4.4 | a held advisory lock degrades `run` to passthrough (no report, child exit); recovery is clean |
| inv6-determinism-byte-identical | INV-6, §7.8 | `compare` is byte-identical across re-execution (`assertDeterministic`) |
| inv7-claims-bounded-by-comparability | INV-7, §5.3 | no baseline → `none`/`baseline-missing`, transitions omitted, `current.red` still disclosed |
| inv8-updated-fail-value-mutation | INV-8, §3.6 | a red→red value change is `updated_fail` (not buried), `failure_mode_changed:false`, digests differ |
| inv9-fail-to-skip-not-repaired | INV-9, §7.5 | fail→skip is a surface reduction, never `repaired`; status `reduced` |
| inv10-gate-record-integrity | INV-10, §11.2 | a tampered stored record fails the content-address check → `record-integrity-failed`, gate inconclusive |
| inv11-gate-staleness-exact | INV-11, §11.3 | a post-record workspace edit breaks exact `tree_digest` equality → staleness mismatch, gate inconclusive |

### Adversarial (`adv-*`)

| fixture | spec_refs | verifies |
|---|---|---|
| adv-parallel-order | §7.8 | parallel-worker results are canonically sorted by test_id in the record; comparison is deterministic |
| adv-partial-bail | §5.5, §6.1 | `bail` partial run: observed `new_fail` forces regressed; coverage `1/3`; unobserved not claimed |
| adv-flaky-no-inference | §7.7 | 1st-fail/2nd-pass at an identical tree is factual `repaired_same_surface`; no flaky label inferred |
| adv-secret-redaction | §15, §5.6 | AWS key (message) and GitHub token (console) never persist raw; `[REDACTED:<kind>]` stored |
| adv-branch-cross | §5.1, §5.2 | branch is in the stream key: within-branch compare is exact; cross-branch abstains baseline-missing |
| adv-rerun-stability | §13.2(a), §3.6 | two runs at an identical tree produce the same `run_id` (⇒ identical `evidence_digest`) |
| adv-stale-cache-collision | §13.2(b), §4.5 | same-size 500→404→500 revert under frozen mtime reports current source; C matches A, not B |
| adv-degraded-capability | §13.2(c), §9.1 | red-in-both claims carry `degraded_capabilities:["source-region-text"]`; composition `vitest-native/1` |
| adv-readonly-object-db | §13.2, §3.5 | a run against a chmod-readonly `.git/objects` yields the same `run_id` as a writable run at the identical tree; no INV-5 passthrough degrade |

### Operational pitfall (`pit-*`)

| fixture | spec_refs | verifies |
|---|---|---|
| pit-wrong-target | §11.3, §11.5 | gating a run whose tree ≠ the moved-on workspace yields staleness mismatch, not a spurious pass |
| pit-instrument-drift | §6.2, §5.4 | a `truncateThreshold` change → `instrument-changed`/none + a `runner-config-changed` event |
| pit-duplicate-records | §4.3, §3.5 | a content-identical re-record is not double-counted; baseline resolves to the real prior distinct run |
| pit-fail-open-vs-closed | §6.3, INV-5 | corrupt store → `compare` abstains `store-corrupt` (fail-closed); held lock → `run` passthrough (fail-open) |

### Consumer (`con-*`)

| fixture | spec_refs | verifies |
|---|---|---|
| con-report-valid | §9.1, §9.4 | a §9.1/§5.7-shaped report parses without error (positive control) |
| con-report-unknown-enum | §9.4, §14 | an unknown `comparability` enum value is a hard error |
| con-report-unknown-field | §9.4, §14 | an unknown top-level field is rejected |
| con-runrecord | §9.4, §3.2 | a real recorded record parses; a bogus observation verdict makes re-parse throw |

### Recall / cheat corpus (`recall-*`)

| fixture | mutation | detection / no-false-green |
|---|---|---|
| recall-fail-to-skip | fail→skip | `fail_to_skip` + reduced; not repaired; outcome unchanged |
| recall-fail-to-todo | fail→todo | `fail_to_skip` + reduced; not repaired; outcome unchanged |
| recall-fail-to-testfails | fail→`test.fails` | `fail_to_xfail` + reduced; not repaired; outcome unchanged |
| recall-test-deleted | test removed from file | `removed` + `test-removed` event; scope_changed; not repaired |
| recall-testfile-deleted | test file deleted | `removed` + `test-removed` event; scope_changed; not repaired |
| recall-only-narrowing | `.only` narrows away the red | `fail_to_skip` + reduced; not repaired; outcome unchanged |
| recall-early-return | early return skips the assertion | `repaired_with_test_change` + `test-source-changed`; not `repaired_same_surface` |
| recall-tautology | assertion → `expect(true).toBe(true)` | `repaired_with_test_change` + `test-source-changed`; not `repaired_same_surface` |
| recall-expected-rewritten | expected rewritten to actual | `repaired_with_test_change` + `test-source-changed`; not `repaired_same_surface` |
| recall-selector-exclude | config `exclude` drops the file | `removed` (in-scope non-observation, never `out_of_scope`) + `config-source-changed` |
| recall-true-fix | implementation-only fix (honest) | `repaired_same_surface`, surface intact, outcome improved (the honest control) |

## Fixture author findings

Ambiguities and gaps surfaced while deducing expected values. The fixture author
does not change the spec; these are reported for the spec/contract owners. Where
a finding affected a fixture, the workaround is noted.

1. **Partial-mode disclosure of a red-in-both test has no defined bucket.**
   Under `partial` comparability, §6.1 forbids asserting `unchanged`. But a test
   red at baseline *and* observed red in the current partial run is not
   `new_fail` (it was red before), not `still_fail_unchanged` (that is an
   `unchanged` claim), and not `updated_fail` (same evidence). INV-1 requires the
   red be disclosed, yet the spec/contract name no channel for it under
   `partial`. `inv4-partial-no-false-repaired` therefore does not assert that
   test's bucket. Recommend a defined disclosure (e.g. list under `current.red`
   or a dedicated observed-red array) for reds observed under `partial`.

2. **`current.red` element shape is underspecified.** Contract §5.7 says
   "`current.red`: a sorted array of red `test_id`s, each with a drill-down
   anchor," but does not say whether entries are bare strings (with anchors in
   the top-level `anchors` map) or objects. `inv3`/`inv7` assume bare strings
   (`contains` a string). If the implementation emits objects, those assertions
   need the object shape. Recommend pinning the element shape as was done for
   `still_fail_unchanged` (§5.3).

3. **Corruption→`store-corrupt` mapping is not enumerated.** §6.3 makes
   `store-corrupt` (kind `failed`) the reason for a corrupt store, but neither
   the spec nor the contract fixes *which* corruptions map to `store-corrupt`
   versus `adapter-crashed`. `pit-fail-open-vs-closed` corrupts
   `.veridelta/index` and expects `store-corrupt`; a different internal detection
   path could plausibly return `adapter-crashed`. Recommend enumerating at least:
   unparseable `index`/`last`/record ⇒ `store-corrupt`.

4. **`out_of_scope` key presence under non-`subset` comparability.** §7.5 lists
   `out_of_scope` as occurring *only* under `subset`, and the §9.1 `transitions`
   object does not show the key. Whether `transitions.out_of_scope` is omitted or
   present-empty under `exact`/`scope_changed` is unstated. `recall-selector-exclude`
   sidesteps this by asserting positively (the dropped test is in `removed`,
   which is mutually exclusive with `out_of_scope`) rather than asserting
   `out_of_scope` absence. Recommend stating whether non-applicable transition
   keys are omitted or present-empty.

5. **`show` drill-down output shape is unspecified.** The contract pins the
   report and run-record shapes but not `vdelta show <run> --test <id>`. This
   blocked a direct `sameValue` on a finding's `evidence_digest` across two
   records; `adv-rerun-stability` proves stability via `run_id` equality (a
   superset of `evidence_digest` equality) and `still_fail_unchanged`
   classification instead. If a future fixture must read an individual finding's
   `evidence_digest`, the `show` output shape must be fixed.

6. **`none`-case key set: omitted vs null vs empty.** §5.7 says under `none`,
   `transitions`/`verification_surface` are omitted and `baseline` is null.
   `inv7` asserts `baseline == null` and `transitions` undefined. If the
   implementation instead omits `baseline` or emits `transitions: {}`, these need
   adjustment. Recommend the contract state, per reason, exactly which keys are
   omitted vs null-valued vs empty.

7. **Two content-identical `run` steps collapse to one `run_id`.** Because
   `run_id` excludes only the recording group (§3.5), two `run` steps over an
   identical tree yield the same `run_id`. This is used deliberately
   (`adv-rerun-stability`, `pit-duplicate-records`), and fixtures that need two
   *distinct* comparable runs introduce a non-test/non-config tree change. Not a
   spec bug, but the runner must treat a re-recorded identical run idempotently
   (or duplicate-normalize per §4.3) and must accept `compare baseline:A
   current:B` where A and B resolve to the same id as a valid self-comparison.

8. **`repaired_with_test_change` maps to `outcome_verdict: improved`.** Per §5.7,
   any `repaired_*` ⇒ `improved`, so the test-changing cheats
   (`recall-early-return`/`-tautology`/`-expected-rewritten`) yield outcome
   `improved`. A consumer keying only on `outcome_verdict` would read that as
   green. The no-false-green guard therefore rests on the *transition class*
   (`repaired_with_test_change`, not `repaired_same_surface`) plus the
   `test-source-changed` surface event — which is exactly what those fixtures
   assert. This matches the spec's design (consumers MUST read the failure-mode
   and surface axes, not just outcome), but is worth an explicit consumer
   obligation note.

## Verifications not representable in the current vocabulary

Recorded per the task instruction; the fixtures cover what the harness vocabulary
can express, and these remain out of reach for the MVP surface:

- **Consumer relay of comparability limits (§13.2.4, §9.4).** The harness has no
  "relaying consumer" step — only `parse-report` (throw / no-throw). The
  comparator-side honoring of comparability is covered by `inv7` and the `pit-*`
  fixtures, but a consumer's obligation to *not over-claim when relaying onward*
  is not directly exercised.
- **Gate `blocking`/`advisory` and the §11.5 CI invocation contract.** The MVP
  gate implements only `report-only` (contract §5.9), so seal/isolation ordering,
  same-job dual-run, trusted-store fallback, and recursive submodule staleness
  are not fixture-tested. INV-10 is intentionally limited to the record-integrity
  path, which §13.2.1 permits for early revisions.
- **Budget (§9.2) and curated masking (§7.6).** Absent from the MVP (contract
  §5.7): no `--budget`, no maskers, so no `budget_exceeded_for_safety` /
  `masking_applied` fixtures.
