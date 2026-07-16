# vdelta conformance harness contract

This document is the **shared interface contract** between the conformance
fixture author and the `vdelta` implementer. It exists so that fixtures can be
written against the spec (`spec/veridelta-1.md`, revision 0.3.0) without ever
reading `src/`, and so that the implementation can execute fixtures without
ever editing `conformance/`.

Precedence: the spec is normative. Where this contract fixes an
implementation-specific choice the spec leaves open (CLI argument names,
store layout, digest renderings, adapter composition), fixtures MUST rely on
this contract. If this contract contradicts the spec, the spec wins and the
contradiction is a bug in this document.

Roles:

- **Fixture author** writes everything under `conformance/`: fixture
  manifests, mini vitest projects, static data files, and
  `conformance/README.md` (notes on fixture-side conventions). The fixture
  author MUST NOT read or reference `src/`.
- **Implementer** writes `src/` and the manifest runner under `tests/`. The
  implementer MUST NOT add or modify anything under `conformance/`. Suspected
  fixture bugs are sent back to the fixture author with evidence.

## 1. Directory layout

```
conformance/
  README.md                     # fixture-side notes (fixture author)
  fixtures/
    <fixture-name>/
      manifest.json             # steps + assertions (schema below)
      projects/<project-name>/  # mini vitest project snapshots (optional)
      data/*.json               # static inputs, e.g. consumer reports (optional)
```

Fixture naming: `inv-*` (invariant, class 1), `adv-*` (adversarial, class 2),
`pit-*` (operational pitfall, class 3), `con-*` (consumer, class 4),
`recall-*` (verification-surface recall / cheat corpus, class 5).

## 2. Execution model

The runner (implemented in `tests/`, not part of `conformance/`) executes each
manifest in a **fresh temporary git repository** (the *workspace*):

1. Create an empty directory outside the vdelta repo; `git init` with a fixed
   `user.name`/`user.email`, default branch `main`.
2. Symlink `node_modules` → the vdelta repo's `node_modules` so that `vitest`
   resolves. Because of this, **every fixture project MUST contain a
   `.gitignore` that ignores at least `node_modules` and `.veridelta`**
   (the tree digest honors committed gitignore rules).
3. Execute `steps` in order (vocabulary in §3).
4. Evaluate `assertions` (vocabulary in §4). All assertions must hold.

Workspace state (files, git history, the `.veridelta` store) persists across
steps within one fixture and is discarded afterwards.

Mini vitest projects:

- May contain test files, source files, `vitest.config.ts`, `.gitignore`,
  and any support files. No `package.json`, no lockfiles, no dependencies
  beyond `vitest` itself.
- `vitest.config.ts` MAY set evidence-affecting options (e.g.
  `test.chaiConfig.truncateThreshold`, `test.include`, `test.bail`,
  `test.fileParallelism`) — these are part of the measuring instrument.
  It MUST NOT set `reporters` or `includeTaskLocation`; the recorder injects
  both (§6.4).
- Tests must be deterministic unless the fixture is explicitly probing
  volatile behavior.

## 3. Manifest schema — steps

```json
{
  "name": "inv9-fail-to-skip",
  "class": "invariant | adversarial | pitfall | consumer | recall",
  "spec_refs": ["INV-9", "§7.5"],
  "mutation": "fail-to-skip",        // recall class only: the cheat kind
  "steps": [ ... ],
  "assertions": [ ... ]
}
```

Step vocabulary (executed in order; any step failing its expectation fails
the fixture):

| Step | Meaning |
|---|---|
| `{"do": "apply", "project": "<name>", "preserveMtime": true?}` | Sync `projects/<name>/` into the workspace: copy all files, delete workspace files not present in the project (except `.git/` and `.veridelta/`). With `preserveMtime`, every file whose content changed keeps its pre-apply mtime (and size-preserving fixtures can thereby simulate stale-cache collisions). |
| `{"do": "commit", "message": "..."}` | `git add -A && git commit` in the workspace. |
| `{"do": "branch", "name": "..."}` | Create and switch to a new branch. |
| `{"do": "checkout", "ref": "..."}` | Switch branch / detach to ref. |
| `{"do": "run", "id": "A", "args": ["math.test.ts"]?, "expectExit": 0?, "expectReport": true?, "env": {"K":"V"}?}` | Invoke `vdelta run --report json -- <vitest command> [args...]` in the workspace. `args` are vitest CLI filters (selector). Stdout is parsed as a report JSON and stored under `id`; the recorded run is resolved via the report's `current.run_id`. `expectExit` checks the exit code (child passthrough). `expectReport: false` asserts the degraded path (stdout is NOT a report; raw child output passes through) — in that case no report is stored. |
| `{"do": "compare", "id": "cmp", "baseline": "A"?, "current": "B"?, "ref": "<git-ref>"?, "expectExit": 0?, "assertDeterministic": true?}` | Invoke `vdelta compare` with `--report json`. With `baseline`+`current`: explicit-run-id mode using the run ids recorded by those steps. With `ref`: git-ref mode (`--ref`), current defaults to the last recorded run unless `current` is given. With neither: previous-comparable mode against the last run. Stdout report stored under `id`. `assertDeterministic` re-executes the identical command and byte-compares the two stdouts (§13.3). |
| `{"do": "gate", "id": "g", "ref": "<git-ref>", "run": "A"?, "expectExit": 0?, "assertDeterministic": true?}` | Invoke `vdelta gate --ref <ref> --policy report-only --report json` (plus `--run <id>` if `run` given). Stdout gate report stored under `id`. |
| `{"do": "show", "id": "s", "run": "A", "test": "<test_id>"?, "raw": true?, "expectExit": 0?}` | Invoke `vdelta show`. Stdout stored under `id` (parsed as JSON unless `raw`). |
| `{"do": "write-file", "path": "...", "content": "..."}` | Write a file in the workspace (workspace-relative path; may target `.veridelta/...` for tampering fixtures). |
| `{"do": "edit-json", "path": "...", "set": {"<dot.path>": <value>}}` | Load a JSON file, set the given dot-paths (array indices allowed, e.g. `observations.0.verdict`), write it back. `{RUN:A}` inside `path` expands to the run id recorded by step `A`. |
| `{"do": "delete", "path": "..."}` | Delete a file or directory in the workspace. |
| `{"do": "mkdir", "path": "..."}` | Create a directory (e.g. `.veridelta/lock` to simulate held advisory lock). |
| `{"do": "parse-report", "id": "p", "path": "data/whatever.json", "expectError": true|false}` | Feed a static JSON file to the implementation's consumer entry point (report parser). `expectError: true` asserts it throws a hard error (§9.4); `false` asserts it parses. |
| `{"do": "parse-run-record", "id": "p", "path": "...", "expectError": true|false}` | Same, for stored run records. `{RUN:A}` expansion applies. |

Notes:

- Every `run` step executes the **whole project's vitest suite** unless
  `args` narrows it. The runner supplies the vitest binary; fixtures never
  spell the runner command.
- Exit-code expectations on `run` follow §10: `vdelta run` passes the child
  exit code through (vitest exits `1` when tests fail, `0` when green).
- `compare` exits `0` when the comparison operation succeeds — including
  `inconclusive`/`none` results — and `1` when the operation itself fails
  (e.g. unknown run id).
- `gate --policy report-only` exits `0` whenever a gate report was produced
  (even verdict `fail`/`inconclusive`), `2` only when no report could be
  produced (§11.1).

## 4. Manifest schema — assertions

Assertions are evaluated after all steps. Each assertion is one object:

| Assertion | Meaning |
|---|---|
| `{"report": "cmp", "path": "outcome_verdict", "eq": <json>}` | Deep-equal at dot-path. Arrays compare order-sensitively (report arrays are canonically sorted, §5.7). |
| `{"report": "cmp", "path": "...", "contains": <json>}` | Array at path contains a deep-equal element. |
| `{"report": "cmp", "path": "...", "containsMatch": {<subset>}}` | Array at path contains an object element whose fields deep-include the subset. |
| `{"report": "cmp", "path": "...", "empty": true}` / `{"nonEmpty": true}` | Array/object emptiness. |
| `{"report": "cmp", "path": "...", "defined": true|false}` | Field presence. |
| `{"report": "cmp", "path": "...", "matches": "<ECMAScript regex>"}` | Stringified scalar matches. |
| `{"sameValue": [{"report": "a", "path": "p"}, {"report": "b", "path": "q"}]}` | Values at two locations are deep-equal (e.g. rerun-stable `evidence_digest`s). |
| `{"differentValue": [{...}, {...}]}` | Values differ. |
| `{"reportNotContains": {"report": "cmp", "text": "..."}}` | Serialized report does not contain substring. |
| `{"storeNotContains": "..."}` | No file under the workspace `.veridelta/` contains the substring (redaction proof). |
| `{"storeContains": "..."}` | Some file under `.veridelta/` contains the substring. |
| `{"observationsSorted": {"run": "A"}}` | The stored run record for step `A` has `observations` sorted ascending by `test_id` (§7.8). |

`path` uses dot notation; numeric segments index arrays
(`transitions.updated_fail.0.evidence_digest_before`). A path into a report
stored by `show`/`parse-*` steps works the same way.

Expected values MUST NOT hardcode digest hex values, run ids, or absolute
paths — express identity via `sameValue`/`differentValue`/`matches` (e.g.
`"matches": "^sha256:[0-9a-f]{64}$"`).

## 5. Implementation-fixed surface (what fixtures may rely on)

### 5.1. Identifiers

- `test_id` = `<relativeModuleId>::<fullName>` where `relativeModuleId` is the
  test module path relative to the workspace root (POSIX separators) and
  `fullName` is vitest's full test name with parent suites joined by `" > "`.
  Example: `tests/math.test.ts::adder > adds negatives`.
- `run_id` = `run_` + 64-hex SHA-256 (§3.5). CLI commands accept unambiguous
  prefixes.
- `tree_digest` = bare 40-hex git tree object id (expA algorithm; documented
  deviation from the `sha256:` rendering per §3 "unless an adapter documents
  otherwise").
- `evidence_digest`, `context_digest`, and all config/source digests render as
  `sha256:<64-hex>`.

### 5.2. Canonical verdicts (vitest adapter)

| vitest observation | canonical verdict | suppression metadata |
|---|---|---|
| `state: "passed"`, no `fails` marker | `pass` | – |
| `state: "failed"` | `fail` | `{"marker": "fails"}` when the `fails` marker is set (runner-judged xpass; red set per §7.1) |
| `state: "passed"` + `fails` marker | `xfail` | `{"marker": "fails"}` |
| `state: "skipped"`, mode `skip` | `skip` | `{"marker": "skip"}` |
| `state: "skipped"`, mode `todo` | `skip` | `{"marker": "todo"}` |
| `state: "skipped"`, mode `run` (dynamic `ctx.skip(note)` or excluded by `.only` elsewhere) | `skip` | `{"marker": "runtime"}`, plus `"note"` when provided |
| `state: "pending"` at run end | `not_run` | – |

The `xpass` and `error` canonical verdicts are not produced by this adapter
(declared in its capability set). Hook failures surface as `fail` on the
affected test; `phase` is not observable and is declared unsupported.

### 5.3. Failure evidence composition

- `composition_id`: `"vitest-native/1"`.
- Digest core per red finding (expC): exception type (`error.name`), failure
  message (`error.message`), structured `expected` / `actual` / `operator`,
  and line-shift-stable position `relOffsets` (per-frame
  `stack.line − test.location.line` for frames inside the test module),
  plus `test_id`. Deterministic secret redaction (§5.6) runs before digesting.
- Excluded to annex (never digested, always stored, reachable via anchors):
  durations, start times, absolute paths, absolute line/column numbers, raw
  `stack` strings, rendered `diff`, captured console output.
- `degraded_capabilities`: always `["source-region-text"]` (vitest's
  structured channel provides no failing-source-region text; declared
  `unsupported` per §3.6(a)). Because it is always non-empty:
  - every `still_fail_unchanged` entry is an **object**
    `{"test_id": "...", "degraded_capabilities": ["source-region-text"]}`,
    plus `"context_changed": true` and an anchor when §3.6 requires it;
  - every `updated_fail` entry carries a `degraded_capabilities` array field.
- `context_digest` is computed over the redacted captured console output of
  the red test (empty console ⇒ digest of the empty canonical form).
- `structural_fingerprint` covers exception type, operator, module path, and
  `relOffsets` — not the message (so a pure value change keeps the
  fingerprint stable and `updated_fail.failure_mode_changed` is `false`).

### 5.4. Instrument identity

`instrument` = adapter name (`vitest`), adapter version (the vdelta package
version), and `config_digest` over the effective evidence-affecting resolved
config — at minimum `chaiConfig.truncateThreshold`, `includeTaskLocation`,
and the resolved reporter-relevant options, however supplied (§3.1). Changing
`test.chaiConfig.truncateThreshold` in `vitest.config.ts` between two runs
therefore yields `comparability: "none"` with reason `instrument-changed`
plus a `runner-config-changed` surface event.

Only evidence-affecting settings enter the instrument digest. `test.include`
/ `test.exclude` are neither instrument nor selector (the selector is the
invocation's CLI filters): an exclude-list change surfaces as inventory
change (`scope_changed` comparability, `removed` transitions — in-scope
non-observation, §6.4) plus a `config-source-changed` event.

### 5.5. Streams, baselines, completeness

- Stream key (§5.1): repo root + worktree + branch + cwd + canonical command
  (child argv minus injected flags minus selector args) + selector (vitest
  positional filters, sorted) + instrument identity.
- `previous-comparable` picks the most recent **complete** run of the same
  stream by store insertion order (no timestamps; §7.8).
- `git-ref` baseline: a complete run whose `provenance.head` equals the
  resolved commit SHA **and** whose `tree_digest` equals that commit's tree
  (dirty-tree records never match a ref).
- Completeness: vitest run finishing normally ⇒ `complete`; interrupted runs
  (e.g. `bail`) leave `pending` observations recorded as `not_run` and
  `completeness.status: "partial"`.
- `observation_coverage` strings are `"<observed>/<declared>"` where declared
  counts all collected observations and observed excludes `not_run`.
- Cross-selector comparisons (explicit-run-id or git-ref where the two runs'
  selectors differ): the MVP adapter declares no `selector-relation`
  capability, so containment is unproven ⇒ `comparability: "none"` with
  `{"reason": "selector-relation-unknown", "kind": "determined"}`, a
  `selector-changed` surface event, and gate verdict `inconclusive` (§11.1 —
  never `pass`).

### 5.6. Secret redaction shapes

Applied deterministically to all persisted evidence/annex/raw output before
storage and digesting; replacement is `[REDACTED:<kind>]`:

| kind | pattern (ECMAScript) |
|---|---|
| `aws-access-key-id` | `AKIA[0-9A-Z]{16}` |
| `github-token` | `gh[pousr]_[A-Za-z0-9]{36,255}` and `github_pat_[A-Za-z0-9_]{22,255}` |
| `slack-token` | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| `private-key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` |
| `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}` |
| `bearer-token` | `[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}` (token part replaced) |
| `api-key` | `sk-[A-Za-z0-9_-]{20,}` |

### 5.7. Report shape decisions

- Reports follow §9.1. Key order and array orders are canonical and stable:
  all transition arrays, event arrays, and anchor keys sort ascending
  (by `test_id` / event kind + test_id / key).
- `trust.record_integrity` is `"advisory"` for all MVP reports (local store,
  no signatures).
- When `comparability` is `"none"`: `baseline` is present with the JSON value
  `null`, `transitions` and `verification_surface` keys are **omitted**
  (not empty), `comparability_detail` is present, and the current run's red
  set is still fully disclosed (INV-1) as `current.red`: a sorted array of
  red `test_id` **strings**, each with a drill-down anchor in `anchors`.
  (Spec gap recorded as a finding; this contract fixes the shape.)
- `current.red` also appears under `partial` comparability: a test red in
  both runs with identical evidence cannot be claimed `still_fail_unchanged`
  there (that is an `unchanged` claim, §6.1), so its disclosure channel is
  `current.red`. Under `partial`, `transitions` carries only the claimable
  buckets (`new_fail`, `updated_fail`); `not_observed` lists in-scope
  baseline IDs unobserved in the current run.
  Exception: when the reason is `instrument-changed`, observable
  `verification_surface` events (`runner-config-changed`,
  `adapter-capability-changed`, `selector-changed`) ARE reported (§11.5).
- `outcome_verdict` derivation: any `new_fail`/`updated_fail` ⇒ `regressed`;
  else any `repaired_*` ⇒ `improved`; else ⇒ `unchanged` (suppression-only
  movements like `fail_to_skip` do not count as improvement — the surface
  axis carries them); `partial` comparability caps the verdict at
  `inconclusive` for claims it cannot make (`repaired`/`missing`/`unchanged`
  are never asserted under `partial`, per §6.1 — the verdict is
  `inconclusive` unless an observed `new_fail`/`updated_fail` forces
  `regressed`).
- `verification_surface.status`: `reduced` if any of `fail-to-skip`,
  `fail-to-xfail`, `test-removed`, lost observation occurred; else `changed`
  if any event occurred (source/config drift, `test-added`); else `intact`;
  `inconclusive` when the comparison cannot evaluate the surface.
- Anchor keys: `"<transition-kind>:<test_id>"` (e.g.
  `"new_fail:tests/a.test.ts::x > y"`) plus `"raw"`; values are concrete
  `vdelta show ...` command strings.
- `masking_applied` and `budget_exceeded_for_safety` never appear (no maskers,
  no `--budget` in MVP).
- The gate report extends the comparison report with the `gate` object
  exactly as §11.4, with `gate.policy: "report-only"`,
  `gate.target.kind: "head"`, and `staleness` computed against the current
  workspace tree.

### 5.8. Store layout

```
.veridelta/
  .gitignore          # auto-generated, contains "*" (enforced ignore, §4.1)
  runs/<run_id>.json  # immutable run records (atomic writes)
  index               # append-only, one run_id per line, insertion order
  last                # run_id of the most recently recorded run
  lock/               # advisory lock directory (held while present)
```

Run records embed the redacted raw child output under the `recording` group
(excluded from `run_id`, §3.5). Tampering with any byte of a stored record is
detectable by recomputing the content address (INV-10 fixtures use
`edit-json` on `.veridelta/runs/{RUN:A}.json`).

Further store semantics fixed by this contract:

- **All volatile per-test data (durations, start times) lives under the
  `recording` group**, never in `observations`. Consequence: two executions
  of a deterministic suite at an identical tree produce byte-identical
  content-addressed payloads and therefore the **same `run_id`** — the store
  treats such re-records idempotently (no duplicate `index` line), and
  `compare` accepts a self-comparison (baseline id == current id).
- `previous-comparable` never selects the current run's own `run_id` as its
  baseline; it picks the most recent *distinct* complete run of the stream.
- Unparseable `index`, `last`, or run-record files map to
  `comparability_detail: {"reason": "store-corrupt", "kind": "failed"}`;
  `adapter-crashed` is reserved for capture/adapter-side failures. A
  `compare` that can still produce a report (including a `none`/failed
  abstention) exits `0`.

### 5.9. Gate specifics (MVP)

- Only `--policy report-only` is implemented; any other policy value exits `2`
  with an error (not silently accepted).
- Record integrity check: every consulted record's content address is
  recomputed; mismatch ⇒ `comparability_detail: {"reason":
  "record-integrity-failed", "kind": "failed"}`, `gate.verdict:
  "inconclusive"` (exit stays `0` under report-only as long as the report is
  produced).
- Staleness (INV-11): the workspace `tree_digest` is recomputed immediately
  before judging and compared byte-exactly with the current run's
  `provenance.tree_digest`; mismatch ⇒ `gate.verdict: "inconclusive"`,
  `staleness.match: false`.
- `gate.triggered` lists the gate-relevant findings (default set: `new_fail`,
  `updated_fail`, `verification_surface_reduced`).
- Gate verdict: `fail` when any gate-relevant finding exists, `pass` when the
  comparison succeeded with none, `inconclusive` for
  none/partial comparability, staleness mismatch, or integrity failure.

### 5.10. Degraded path (INV-5)

Internal recorder/store errors (store corruption, held advisory lock, capture
failure) degrade `vdelta run` to transparent passthrough: the child's raw
stdout/stderr appear verbatim on vdelta's stdout/stderr, the exit code passes
through, no report is emitted, and diagnostics go to stderr only. Fixtures
assert this with `expectReport: false`.

## 6. Fixture obligations (what the suite must cover)

Per §13.2, at minimum:

1. **Invariant fixtures** — at least one per INV-1..11. INV-10 via the gate
   path (record tampering ⇒ integrity failure). INV-11 via exact
   `tree_digest` equality (post-record workspace edit ⇒ staleness mismatch).
2. **Adversarial fixtures** — parallel-worker reordering (canonical
   observation ordering), partial execution (`bail`), flaky sequence (a test
   whose pass/fail depends on a state file — no flakiness inference, §7.7),
   secret-bearing output (§5.6 shapes never persist), branch crossing
   (streams don't leak across branches), plus §13.2(a) rerun stability,
   (b) stale-cache collision (same-size revert with `preserveMtime`; the
   vitest adapter declares no neutralization needed — the fixture arbitrates
   that declaration, §4.5), and (c) degraded-capability marking (red-in-both
   claims carry non-empty `degraded_capabilities`).
3. **Pitfall fixtures** — gate wired to the wrong target (staleness),
   instrument drift (`truncateThreshold` change ⇒ `instrument-changed`),
   duplicate records (duplicated index lines / identical re-record never
   double-count), fail-open vs fail-closed (held lock ⇒ INV-5 passthrough;
   corrupted store ⇒ `kind: "failed"` abstention, never a guess).
4. **Consumer fixtures** — unknown enum value in a report ⇒ parser throws;
   unknown field ⇒ rejected; comparability limits honored.
5. **Recall fixtures (cheat corpus)** — ≥10 distinct mutation kinds including
   at least: fail→skip, fail→todo, fail→`test.fails`, test deletion, test
   file deletion, `.only` narrowing, early-return assertion removal,
   assertion weakening to tautology, repaired-with-test-change, expected
   value rewritten to actual. Each fixture MUST assert both detection
   (recall: the mutation surfaces as its spec-mandated transition/event) and
   no-false-green (it is never classified `repaired_same_surface`, and
   `outcome_verdict` is never `improved` unless the spec says so).

The suite mechanically aggregates: all `recall-*` fixtures passing ⇒ recall
100% / false-green 0; `assertDeterministic` compare/gate steps prove §13.3
byte-determinism.
