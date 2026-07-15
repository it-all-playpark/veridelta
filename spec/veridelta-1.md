# veridelta/1 — Verification Delta Protocol

| | |
|---|---|
| **Status** | Draft |
| **Schema identifier** | `veridelta/1` |
| **Spec revision** | 0.2.0 — 2026-07-16 |
| **License** | MIT |
| **Reference implementation** | `vdelta` (this repository; in development) |

## Abstract

veridelta is a protocol for **proof-carrying verification deltas** in coding-agent
development loops. Given two comparable test runs, a conforming implementation
reports — deterministically and with evidence — whether a change improved the
outcome *while maintaining the same verification surface*, whether pre-existing
failures mutated into different failures, and whether red results disappeared
because they were fixed or because the verification surface shrank
(fail→skip, deleted tests, narrowed selectors).

veridelta is not a log-compression tool. It is a **trust layer**: a deterministic
state-transition report between two immutable, content-addressed runs, with an
explicit comparability judgment. When comparability does not hold, a conforming
implementation **abstains** rather than guessing. Token savings for agents are a
side effect; the product is that an agent (or a CI gate reviewing an agent's PR)
can proceed to the next step safely.

## 1. Introduction

### 1.1. Motivation

In an agent's test→fix→test loop, most of a rerun's output is identical to the
previous run. Tools that summarize only the *current* run can answer "what
failed now?" but not "what did this change fix, and what did it newly break?" —
the agent must reconstruct that from history it does not reliably retain.

Three failure modes motivate this protocol:

1. **Pre-existing failures.** In repositories with standing red, the child
   process exits `1` every time. The exit code cannot express *improved*,
   *regressed*, or *unchanged*.
2. **Red→red mutation.** A test that fails before and after a change may be
   failing *differently*. Status-only diffs bury this, and the new failure mode
   goes uninvestigated.
3. **Verification-surface reduction.** A red result can disappear without a fix:
   fail→skip, fail→xfail, test deletion, selector narrowing, or a test rewritten
   to pass. Outcome-only comparison reports these as improvements. In the
   context of agent-generated changes this is precisely the cheating vector
   (reward hacking), so it must be a first-class, separately reported axis.

### 1.2. Position

Three separations of concern define the protocol:

- The **child process's exit code** and the **semantic judgment "did anything
  regress since the baseline?"** are different concepts and are never encoded in
  the same channel (§10).
- **Test-ID identity** and **failure-finding identity** are different concepts:
  the same test failing with different evidence is a state transition (§7.3).
- **Outcome improvement** and **verification-surface maintenance** are different
  axes and are always reported separately (§7.4).

### 1.3. Scope

In scope:

- Comparing two recorded runs of a test command over the same repository,
  including dirty working trees.
- Gating agent-generated changes (e.g., pull requests) on regression and
  verification-surface reduction relative to a baseline ref.
- The canonical data model, run store semantics, baseline selection,
  comparability rules, delta taxonomy, report contract, gate semantics, and
  conformance requirements.

Out of scope (non-goals):

- General-purpose log compression or summarization.
- Test selection or execution optimization (e.g., `--lf`-style reruns).
- Semantic diffing of arbitrary text, or any LLM-based summarization in the
  trust path.
- Attribution of *cause* ("the agent cheated", "your change broke this").
  Conforming implementations report observations; intent and blame are the
  consumer's judgment (§7.4).

### 1.4. Roles

| Role | Responsibility |
|---|---|
| **Adapter** | Translates one runner's native output/hooks into the canonical data model, under a declared capability set (§3.4, §12). |
| **Recorder** | Captures runs into the store. May be a runner plugin, a harness hook, or a CLI wrapper (§4.2). |
| **Run store** | Immutable, content-addressed persistence of runs (§4). |
| **Comparator** | Selects a baseline, judges comparability, computes the delta report (§5–§9). |
| **Gate** | Turns a delta report into a CI/agent-loop verdict under a policy, with integrity and staleness checks (§11). |
| **Consumer** | Anything that parses `veridelta/1` reports: agents, harnesses, CI, humans via secondary rendering (§9.4). |

A single binary may implement several roles. Conformance is claimed per role
(§13).

## 2. Conventions and terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as described in RFC 2119 and RFC 8174 when, and only when, they
appear in all capitals.

- **Run**: one recorded execution of a test command (§3.1).
- **Stream**: the equivalence class of runs that are candidates for implicit
  baseline selection (§5.1).
- **Baseline**: the run against which the current run is compared.
- **Verdict**: the canonical per-test outcome assigned by the runner (§7.1).
- **Red**: a verdict in the failing set (§7.1).
- **Failure finding**: the evidence attached to a red observation (§3.3).
- **Verification surface**: the set of checks a run actually performed —
  inventory, selectors, suppression state, test/config sources, adapter
  capabilities (§7.4).
- **Abstain**: report `inconclusive`/`none` with a reason instead of guessing.
- **Closed enum**: a field whose value set is fixed by this spec revision;
  consumers MUST treat unknown values as a hard error (§9.4, §14).

## 3. Data model

All persisted records and reports are JSON. Field names are `snake_case`.
Digests are lowercase-hex SHA-256 rendered as `sha256:<hex>` unless an adapter
documents otherwise.

### 3.1. Run

A Run is the immutable record of one execution. Its identity is
content-addressed: `run_id` is derived from the canonical serialization of the
record (stable key order, no volatile fields), so identical runs collide and
mutation is detectable.

| Field group | Fields | Notes |
|---|---|---|
| `schema_version` | `"veridelta/1"` | REQUIRED. |
| `repo` | repo identity, worktree path, branch lineage, `cwd` | REQUIRED. |
| `invocation` | canonicalized command, test selector | REQUIRED. Selector is recorded as normalized by the adapter. |
| `instrument` | adapter name, adapter version, runner config digest | REQUIRED. Together these identify the *measuring instrument* (§6.2). The runner config digest MUST cover the effective configuration that alters evidence quality or structure — including assertion-introspection mode and traceback style — however that configuration is supplied (command line, configuration files, plugins, or environment). |
| `environment` | runner, runtime, OS, fingerprint of adapter-declared comparison-relevant env vars | REQUIRED. Secret **values** MUST NOT be stored; fingerprints only (§15). |
| `provenance` | `head` (VCS revision), `dirty_diff_digest`, `tree_digest` | REQUIRED. `tree_digest` MUST identify the exact source content the run executed against, computed per §3.5. Provenance is **evidence of what was compared, never a stream-matching key** (§5.1). |
| `surface` | observed test inventory digest; digests of test source and test-relevant config files; suppression metadata | REQUIRED to the extent the adapter's declared capabilities allow. |
| `completeness` | `status`: `complete` \| `partial` \| `crashed`; `child_exit_code` | REQUIRED. |
| `observations` | array of TestObservation (§3.2) | REQUIRED. |
| `recording` | recorder kind, timestamps, raw-record references | Timestamps are permitted here and only here; they MUST NOT influence report content (§7.8), only duplicate matching (§4.3). |

### 3.2. TestObservation

| Field | Req | Description |
|---|---|---|
| `test_id` | MUST | Canonical item ID as provided by the adapter (e.g., pytest nodeid). The protocol does not accept user-supplied key regexes. |
| `verdict` | MUST | Canonical verdict (§7.1), derived **only** from the runner's verdict channel (INV-3). |
| `phase` | SHOULD | e.g., `collection` \| `setup` \| `call` \| `teardown`, if the capability is declared. |
| `suppression` | SHOULD | skip/xfail markers and reasons, if observable. |
| `source_ref` | MAY | file/line of the test definition, if the capability is declared. |
| `finding` | MUST when red | FailureFinding (§3.3). |
| `detail` | MAY | non-trust detail (e.g., duration). Never used for status derivation. |

### 3.3. FailureFinding

Each finding carries two fingerprints with strictly different trust roles:

| Field | Role |
|---|---|
| `evidence_digest` | **Trust path.** Lossless digest of the canonical failure evidence (§3.6) after deterministic secret redaction and canonical encoding, and after nothing else. Any change to canonical evidence changes this digest. Change detection MUST use this and only this. |
| `structural_fingerprint` | **Auxiliary.** Phase, exception type, assertion location, top project stack frames. Used for clustering and drill-down presentation only. It MUST NOT be used to suppress or merge a change that `evidence_digest` detects (INV-8). |
| `evidence` | Stored redacted raw evidence, addressable via anchors (§9.3). |

### 3.4. Adapter capability declaration

Adapters MUST declare, in schema form, which observables they can produce:
verdicts, phases, source locations, suppression metadata, failure evidence,
inventory, rename proof, coverage, etc. A missing capability means *unknown*,
never *unchanged*: comparators MUST NOT interpret absent data as absence of
change (§12). Capability values follow the three-valued convention
`pass`/`fail`/`unsupported` where applicable — "the runner cannot express this"
and "this broke" are never conflated.

### 3.5. Identifiers and digests

- All digest inputs MUST be canonicalized deterministically (encoding, ordering
  of multi-part evidence) and the canonicalization MUST be documented by the
  adapter.
- Redaction (§15) runs before digesting and MUST itself be deterministic, so
  digests remain stable for identical inputs.

**Run identity.** `run_id` is content-derived and immutable: `run_` followed by
the lowercase-hex SHA-256 of the canonical serialization of the Run record
excluding the `recording` group. Canonical serialization is JSON with
lexicographically sorted keys, UTF-8 encoding, no insignificant whitespace, and
all numbers restricted to integers (durations in microseconds) — sidestepping
floating-point serialization divergence between implementations. Because
`recording` is excluded, two recorders that observe the same physical run
identically produce the *same* `run_id`: content addressing itself collapses
exact duplicates, and §4.3 matching is needed only for records that differ.
Tools MAY accept unambiguous `run_id` prefixes as input; identity is always the
full digest.

**Tree identity.** The `tree_digest` of a git worktree MUST be computed as a
git tree object id over the union of tracked, staged, unstaged, and untracked
files, excluding paths ignored by committed `.gitignore`/`.gitattributes`
rules. Implementations MUST compute it against a dedicated, throwaway index
(`GIT_INDEX_FILE`) seeded from `HEAD` (`git read-tree HEAD`, or `read-tree
--empty` for an unborn `HEAD`), followed by `git add -A` and `git write-tree`,
so that the operation never mutates the repository's real index or working
tree. To keep the digest deterministic and independent of host and time, the
computation MUST pin `core.autocrlf=false`, `core.eol=lf`, and
`core.excludesFile=/dev/null`, and MUST NOT depend on file mtimes. For a clean
checkout the resulting id is identical to `git rev-parse HEAD^{tree}`, which a
verifier MAY use directly as the canonical form (subject to the conditions of
§11.3). The digest records submodules solely by their gitlink commit id; it
does NOT capture uncommitted changes inside a submodule working tree, and it
cannot represent empty directories — both are explicit, documented limitations
(see §11.3 for gate-side handling).

### 3.6. Canonical failure evidence

The input to `evidence_digest` is the **canonical failure evidence**: a
deterministic projection of the runner's structured failure representation,
declared per adapter as a versioned **composition** and satisfying:

- **CE-1 (signal completeness)**: it MUST include the exception type, the
  runner's failure message with asserted values intact, the failing source
  region text, and the traceback entry structure, as provided by the runner's
  structured channel.
- **CE-2 (rerun stability)**: it MUST NOT include durations, wall-clock or
  monotonic time, process- or host-specific values (memory addresses, PIDs,
  absolute filesystem paths), captured program output streams, or any field
  capable of carrying values supplied by run-scoped resources (e.g.,
  function-argument representations, which can embed per-run temporary paths).
  Exclusion under this rule operates on whole declared fields (CE-5): a field
  is excluded for what it *can carry*, never conditionally on what a particular
  value contains.
- **CE-3 (position stability)**: source position MUST be encoded in a
  line-shift-stable form (enclosing symbol plus symbol-relative offset, and/or
  source line text). Absolute line numbers MUST NOT enter the digest.
- **CE-4 (structured fields only)**: the digest MUST be computed from
  structured fields, never from rendered display strings that interleave
  position, style, and message.
- **CE-5 (whole-field granularity)**: composition includes or excludes whole
  declared fields only. Value-level rewriting of evidence content is
  prohibited; the sole exception is deterministic secret redaction (§15).
  Redaction MUST NOT be used to normalize non-secret volatile values.

Material excluded by CE-2/CE-3 MUST be stored in the finding's annex,
addressable via anchors (§9.3); exclusion from the digest is never exclusion
from the record (INV-2). An adapter that stores captured-output annex material
MUST compute a `context_digest` over it; when it differs between compared runs,
affected `still_fail_unchanged` entries MUST carry `context_changed: true` with
an anchor. `context_digest` MUST NOT influence transition classification
(§7.3).

The declared composition is part of the measuring instrument: any composition
change requires an adapter version change (§6.2).

**Known limitation (normative acknowledgment):** a failure message that embeds
values varying across executions at an identical tree (times, run-scoped
paths) yields differing digests on rerun. This is honest `updated_fail`
reporting of genuinely differing evidence, not noise to be normalized; such
transitions carry `failure_mode_changed: false` when the structural
fingerprint is stable, and gates MAY narrow blocking accordingly (§11.1,
subject to the blocking-set floor of §11.5) without narrowing reporting.

## 4. Recording and the run store

### 4.1. Immutability and content addressing

Stored runs are immutable. Implementations MUST NOT rewrite a stored run;
corrections are new records. The store is repo-local, MUST be excluded from
version control (e.g., enforced gitignore), and SHOULD be bounded (LRU or
equivalent).

### 4.2. Ambient recording

Recording is **ambient-first**: the RECOMMENDED deployment records every run
via runner plugins or harness hooks, with a CLI wrapper (`vdelta run --`) as
just one recorder implementation. Rationale: a wrapper-only design depends on
agent discipline, and one forgotten wrap severs the stream — contradicting the
premise that agents are stateless. **Record always; compare on demand.**

Continuous recording also enables the highest-value inner-loop query: comparing
the current subset run against the widest available proven-superset run over
their common IDs, under the `subset` comparability rules of §6.1 and the
`previous-superset` baseline mode of §5.2.

### 4.3. Duplicate-record normalization

When multiple recorders coexist (plugin + hook + wrapper), the same physical
test run may be recorded more than once. Stores MUST normalize duplicates
deterministically:

- Group candidate records by stream key (§5.1) and match by timestamp
  proximity with a fixed, documented window.
- Matching MUST be deterministic given the same set of records.
- Joined records and unjoinable residuals MUST both be explicit; raw and
  normalized forms are both retained. Residuals that cannot be normalized MUST
  remain observable — normalization never silently discards a record.

### 4.4. Store hygiene

- Writes MUST be atomic.
- Locks are advisory and **fail-open**: lock contention degrades to raw
  passthrough (INV-5), never to blocking or corruption.
- Known secret shapes MUST be redacted before persistence (§15).

### 4.5. Execution-cache coherence

A recorder MUST ensure the evidence a run reports was produced from the source
content identified by `provenance.tree_digest`. Runner- or runtime-level
caches that can serve compiled or rewritten artifacts from a prior source
state MUST be neutralized for recorded runs; the mechanism MUST be declared by
the adapter and MUST pass the stale-cache collision fixture (§13.2). For the
pytest adapter: purge in-scope `__pycache__` directories, or point
`PYTHONPYCACHEPREFIX` at a run-scoped empty directory.
`PYTHONDONTWRITEBYTECODE` alone is insufficient: it suppresses writes but not
reads of pre-existing cached bytecode. (pytest's `-p no:cacheprovider` does
not address this cache.)

## 5. Streams and baseline selection

Baseline selection is a public protocol, not an internal heuristic. Every
report MUST state which baseline was chosen and why (`selection_reason`).

### 5.1. Stream key

The default comparison stream is:

```
repo + worktree + branch + cwd + canonical command + selector + instrument
```

Branch switches, command changes, and selector changes start a new stream.
`tree_digest`/`head` are provenance, **not** part of the stream key — the tree
changes on every edit; that is the thing being iterated, not the thing that
identifies the series.

The **series key** is the stream key minus the selector: `repo + worktree +
branch + cwd + canonical command + instrument`. The canonical command
component excludes the selector, which §3.1 records as a separate field; two
invocations differing only in selector share a series. The series key exists
solely to scope `previous-superset` selection (§5.2); it never widens
`previous-comparable` matching.

### 5.2. Baseline modes

| Mode | Intended use | Meaning |
|---|---|---|
| `previous-comparable` | dirty-tree inner loop (default) | Most recent **complete** run in the same stream. |
| `git-ref` | PR / regression gate | Complete run whose provenance matches the given ref. |
| `explicit-run-id` | agent/harness control | Caller names an immutable run. |
| `previous-superset` | inner loop, subset runs | Candidates are **complete** runs in the same series whose selector the adapter proves to be a **proper superset** of the current run's selector via the `selector-relation` capability (§6.4). Among candidates, only those **maximal under the proven-containment partial order** (no other candidate's selector is a proven proper superset of theirs) are eligible; a narrower run MUST never be selected over a wider one. Select the most recent maximal candidate; recency ties break by lexicographic `run_id`. When more than one maximal candidate exists, the report MUST disclose `baseline.superset_candidates` (count) and the baseline's selector. An equal selector belongs to the same stream and is handled by `previous-comparable`, never by this mode. Abstention reasons are distinct (§6.3): when candidate relations are decided but no proper-superset candidate exists, this mode abstains with `baseline-missing`; when `unknown` relations prevent candidacy from being determined, it abstains with `selector-relation-unknown`. An `unknown` relation is absence of proof, never containment; this mode MUST NOT fall back to a weaker match (§5.3). |

An implicit "the previous invocation" baseline (ordinal, order-dependent) is
prohibited: it is contaminated by branch switches and partial runs. Selection
MUST be content-addressed and explainable.

### 5.3. Selection transparency

`baseline.selection_reason` is REQUIRED in every comparison report and MUST be
sufficient for the consumer to verify the choice (e.g.,
`same-worktree-command-config-scope`). If no acceptable baseline exists, the
comparator MUST abstain with comparability `none` (§6.3), never fall back
silently to a weaker match.

## 6. Comparability

### 6.1. Levels and permitted claims

| `comparability` | Condition | Permitted claims |
|---|---|---|
| `exact` | Same scope and inventory; both runs `complete`; same instrument (§6.2) | All status transitions, including `unchanged`. |
| `scope_changed` | Same selector, but tests were added/removed/renamed | Transitions over common IDs, plus added/removed. A removed test MUST NOT be counted as repaired. |
| `subset` | Baseline selector is a proven proper superset of the current selector; both runs `complete`; same instrument | Transitions over common IDs, plus `test-added` for current-only IDs. Baseline IDs matching the current selector but unobserved are `removed`; baseline IDs outside it are `out_of_scope` — never `repaired`, never conflated with `removed` or `not_observed`. Red `out_of_scope` IDs MUST be listed. Every `subset` comparison MUST emit a `selector-subset` event (§7.4), which carries both selectors. All claims are bounded to the baseline's scope; claims about any wider suite MUST NOT be asserted. |
| `partial` | Declared scope not fully observed | Only facts observed in the current run. `repaired`, `missing`, and `unchanged` MUST NOT be asserted. |
| `none` | No comparable baseline | Structured current-run results only. |

When the conditions of more than one level hold, the comparator MUST assign
the highest level in the order `exact` > `scope_changed` > `subset` >
`partial`.

A comparator MUST NOT claim more than its comparability level permits (INV-7).
`comparability` and its reason appear in every report.

### 6.2. Same-instrument rule

If adapter name, adapter version, or runner config digest differ between the
two runs, the measuring instrument itself changed. The comparator MUST NOT
claim `exact`; it MUST report comparability `none` with reason
`instrument-changed`. (Evidence digests are not comparable across instrument
changes — formatting drift would surface as false `updated` findings.)

### 6.3. Reasons for `none` (closed enum)

"We determined the runs are incomparable" and "the tool did not run properly"
are different statements and get different vocabulary. `comparability_detail`
is REQUIRED whenever `comparability` is `none`:

```json
{ "reason": "baseline-missing", "kind": "determined" }
```

| `reason` | `kind` |
|---|---|
| `baseline-missing` | `determined` |
| `stream-mismatch` | `determined` |
| `instrument-changed` | `determined` |
| `selector-relation-unknown` | `determined` |
| `store-corrupt` | `failed` |
| `adapter-crashed` | `failed` |
| `record-integrity-failed` | `failed` |

`kind: failed` reasons additionally trigger the fail-open behavior of INV-5
where applicable. This enum is closed (§14).

### 6.4. Selector semantics and containment proof

A recorded selector denotes the invocation's **inclusion intent**. Exclusion
mechanisms (e.g., pytest `--deselect`, `--ignore`, `collect_ignore`,
deselection hooks) MUST NOT narrow the recorded selector: an ID matching the
inclusion selector but not observed is in-scope non-observation (`removed` or
`not_observed`), never `out_of_scope`.

Cross-selector comparability (`subset`) requires a deterministic containment
proof. Adapters MAY declare the `selector-relation` capability, providing
pure, documented functions
`selector_relation(a, b) → equal | subset | superset | disjoint | unknown` and
`selector_matches(selector, test_id) → yes | no | unknown`, evaluated over
inclusion intent only and covered by conformance fixtures. Where the relation
is undecidable (e.g., pytest `-k`/`-m` expressions), the adapter MUST return
`unknown`; comparators MUST treat `unknown` as absence of proof, never as
containment.

## 7. Delta taxonomy

Deltas are reported on three axes, never collapsed into one array:
**outcome delta** (§7.2), **failure-mode delta** (§7.3), and
**verification-surface delta** (§7.4).

### 7.1. Canonical verdicts

`pass | fail | error | skip | xfail | xpass | not_run`

The **red set** is `{fail, error}`. Adapters MUST map any runner outcome the
runner itself treats as failing (e.g., strict-mode `xpass` in pytest) into the
red set. Verdicts derive exclusively from the runner's verdict channel, never
from output text (INV-3).

### 7.2. Outcome verdict

`outcome_verdict`: `regressed | improved | unchanged | inconclusive`

If even one new or updated failure exists, `regressed` takes precedence over
any concurrent repairs; the breakdown is preserved in `transitions`. No blended
scores, no confidence values.

### 7.3. Failure-mode delta

Test-ID identity and failure identity are separated. For tests red in either
run:

| Transition | Meaning |
|---|---|
| `new_fail` | Not red at baseline (or newly added and red), red now. |
| `still_fail_unchanged` | Red in both; `evidence_digest` identical. Listed by ID; detail suppressed but never omitted (INV-1, INV-2). |
| `updated_fail` | Red in both; `evidence_digest` changed. Carries `evidence_digest_before/after` and `failure_mode_changed: true` when the structural fingerprint also changed. |
| `repaired_*` | Red at baseline, not red now — decomposed per §7.5. |

If the structural fingerprint matches but raw evidence changed, the transition
is still `updated_fail`. Rounding "similar failures" together is never in the
trust path (INV-8).

### 7.4. Verification-surface delta

"Red disappeared" and "the same check passed" are separated. Deterministically
observable surface changes are reported as `verification_surface.events`:

- inventory `test-added` / `test-removed` / `test-renamed` (rename only when
  the adapter can prove it uniquely)
- verdict-class moves into suppression: `fail-to-skip`, `fail-to-xfail`
- `selector-changed`, `runner-config-changed`, `adapter-capability-changed`
- `selector-subset` — the current selector is a proven proper subset of the
  baseline selector; carries both selectors and the proving capability.
  Distinct from `selector-changed` (unproven or non-containment change)
- `test-source-changed`, `config-source-changed` (digest changes of test/config
  sources)

`verification_surface.status`: `intact | changed | reduced | inconclusive`.
`changed` covers source/config digest drift alone; `reduced` is REQUIRED
whenever the observed scope demonstrably shrank *within the compared scope*
(fail→skip/xfail, deletions, lost observation). Proven selector narrowing is
carried by the `subset` comparability level and its mandatory
`selector-subset` event (§6.1, §11.1), never by `status`: under `subset`
comparability, `verification_surface.status` is computed over the current
selector's scope, so `reduced` retains its alarm value for in-scope reduction
rather than firing on every deliberate subset run. An unproven selector change
precludes cross-selector comparability entirely (§5.2, §6.3). Coverage-based
surface evidence is handled only by adapters that declare it; otherwise
`inconclusive` (Appendix A).

Implementations MUST NOT claim intent or causation ("test was weakened to
cheat", "your change caused this"). The observation is the deliverable; the
judgment belongs to the consumer.

### 7.5. Repaired decomposition

`repaired` is never a single bucket:

| Class | Meaning |
|---|---|
| `repaired_same_surface` | Same test, same scope, fail→pass, test/config digests unchanged. |
| `repaired_with_test_change` | fail→pass, but test or config source changed. |
| `fail_to_skip` / `fail_to_xfail` | Transition into suppression. **Not repaired.** |
| `removed` / `not_observed` | Deleted or unobserved. **Not repaired.** |
| `out_of_scope` | Red at baseline, provably outside the current run's inclusion selector (§6.4). Occurs **only** under `subset` comparability (§6.1). **Not repaired. Not removed. Not `not_observed`.** Red IDs listed individually; non-red out-of-scope items MAY be reported as counts in `observation_coverage`. |
| `verification_inconclusive` | Adapter capability or provenance insufficient to classify. |

### 7.6. Normalization and masking constraints

- Free-form, caller-supplied masking/keying/watching expressions MUST NOT
  exist in the trust path. (Design history: Appendix B.)
- Curated maskers, if implemented at all, MUST NOT touch status, test IDs, or
  assertion regions; they are OPTIONAL, default-off, and restricted to detail
  deduplication (e.g., durations).
- Any suppression a masker performs MUST be loudly accounted: count and at
  least one concrete example per application, in the report.

### 7.7. Flakiness

Implementations MUST NOT infer flakiness from a two-run alternation. A
`flaky`-class label is permitted only from the runner's own retry verdict, or
from three or more comparable historical runs (`observed-flaky`, post-1.0 —
Appendix A). Flaky annotations never suppress new/updated failure reporting.

### 7.8. Determinism

Same input runs + same configuration → byte-identical report. Reports contain
no timestamps and use stable sort orders. This is proven by conformance
fixtures over adversarial inputs: reordering, partial execution, flakiness,
secret-bearing output, branch crossing (§13).

## 8. Trust invariants (normative core)

Safety takes precedence over budget: if the mandatory failure IDs and
observation coverage exceed a requested `--budget`, the implementation MUST NOT
omit them; it exceeds the budget and sets `budget_exceeded_for_safety: true`.

Each invariant carries a **justification class** (general rule: any distrust
mechanism must declare one, plus a sunset path if capability-bound):

- **incentive-structural** — guards against actors whose incentive to game the
  mechanism *grows* with capability. Never sunset.
- **blast-radius** — guards against failure modes whose cost is unbounded
  regardless of actor intent. Permanent.
- **capability-bound** — compensates for current model/tooling limitations;
  MUST declare a re-evaluation trigger. *(None of INV-1..11 is in this class;
  the class exists so future mechanisms must self-classify.)*

| # | Invariant | Class |
|---|---|---|
| **INV-1** | Never report green where red exists: failing items are never omitted and never masked into `unchanged`. | blast-radius |
| **INV-2** | Never omit without accounting: suppressed items' existence and status always appear in observation coverage. Only the *detail* of unchanged/passing items may be suppressed. | blast-radius |
| **INV-3** | Status derives from the runner's verdict channel, never from any text a masker could touch. Green→red concealment is structurally impossible, not policy-forbidden. | blast-radius |
| **INV-4** | Completeness gate: incomplete/partial/crashed runs never yield `repaired`/`missing` as fact; they yield "N items unobserved". | blast-radius |
| **INV-5** | Fail-open / crash-safe: config errors, cache faults, lock contention, and internal errors all degrade to transparent passthrough of the child's raw output and exit code. **veridelta is never worse than its absence.** | blast-radius |
| **INV-6** | Determinism: same input + same config → same output, proven against adversarial conformance fixtures. | blast-radius |
| **INV-7** | Claims never exceed comparability: baseline mismatch → abstain from all transitions; scope change → common IDs only; incomplete runs → no `repaired`/`missing`/`unchanged`. Comparability with reason is always returned. | blast-radius |
| **INV-8** | Red→red mutation is never buried in `still-fail/unchanged`: if the lossless evidence digest changed, the transition is `updated`. Structural fingerprints cluster; they never conceal. | incentive-structural |
| **INV-9** | Red that vanished by shrinking the verification surface is never called repaired: fail→skip/xfail, deletion, selector narrowing, non-observation, and capability loss are reported as surface changes, separate from `repaired`. | incentive-structural |
| **INV-10** | The threat model includes the **deceiving** agent, not just the confused one. The agent can shell into the local store, so local outputs are advisory; gate verdicts require tamper-evident records (content addressing + signature verification) or re-verification in a trusted environment (CI). Every report states which threat model each claim holds under. | incentive-structural |
| **INV-11** | "Honest but stale" records are never gated on (TOCTOU): the gate verifies exact content-hash equality between the run's `tree_digest` and the judged target before judging. Mismatch is `inconclusive` — no proximity or ratio rescue. Staleness is a distinct threat from tampering; both are closed independently. | incentive-structural |

## 9. Report contract

### 9.1. Comparison report

JSON is the primary interface. Human-readable text MUST be a secondary
rendering of this schema with no independent logic.

```json
{
  "schema_version": "veridelta/1",
  "outcome_verdict": "regressed",
  "comparability": "exact",
  "baseline": {
    "run_id": "run_abc123",
    "mode": "previous-comparable",
    "selection_reason": "same-worktree-command-config-scope"
  },
  "current": {
    "run_id": "run_def456",
    "complete": true,
    "child_exit_code": 1
  },
  "observation_coverage": {
    "baseline": "842/842",
    "current": "842/842"
  },
  "verification_surface": {
    "status": "changed",
    "events": [
      {
        "kind": "test-source-changed",
        "test_id": "tests/api/test_user.py::test_update_user"
      }
    ]
  },
  "transitions": {
    "new_fail": ["tests/api/test_user.py::test_create_user"],
    "still_fail_unchanged": ["tests/legacy/test_import.py::test_v2"],
    "updated_fail": [
      {
        "test_id": "tests/legacy/test_import.py::test_v1",
        "evidence_digest_before": "sha256:111",
        "evidence_digest_after": "sha256:222",
        "failure_mode_changed": true
      }
    ],
    "repaired_same_surface": [],
    "repaired_with_test_change": ["tests/api/test_user.py::test_update_user"],
    "fail_to_skip": [],
    "fail_to_xfail": [],
    "removed": [],
    "not_observed": []
  },
  "failure_evidence": {
    "composition_id": "pytest-native/1",
    "degraded_capabilities": []
  },
  "trust": {
    "record_integrity": "advisory"
  },
  "anchors": {
    "new_fail:tests/api/test_user.py::test_create_user":
      "vdelta show run_def456 --test tests/api/test_user.py::test_create_user",
    "raw": "vdelta show run_def456 --raw"
  }
}
```

Additional REQUIRED-when-applicable fields:

- `comparability_detail` when `comparability` is `none` (§6.3).
- `budget_exceeded_for_safety: true` when §8's budget rule fires.
- `masking_applied` with count and example when §7.6 dedup fired.
- `trust.record_integrity`: `advisory | tamper-evident | trusted-environment`
  (INV-10).

Reports MUST include `failure_evidence.composition_id` (the adapter's declared
canonical-evidence composition and version, §3.6) and
`failure_evidence.degraded_capabilities` (signal-bearing evidence capabilities
declared `unsupported`, §3.4; empty list otherwise). When
`degraded_capabilities` is non-empty, every `still_fail_unchanged` and
`updated_fail` claim MUST carry it, consumers MUST relay it with the claim,
and the gate report MUST surface it under every policy. Gates MAY treat
degraded `still_fail_unchanged` as gate-relevant; the default gate-relevant
set is unchanged.

Entries in `still_fail_unchanged` are test-ID strings, or objects
`{"test_id": ..., "context_changed": true}` when §3.6 requires the context
flag; the corresponding drill-down anchor appears under `anchors`.

### 9.2. Budget

`--budget N` (tokens) is a first-class parameter: the implementation returns
the most informative representation within N tokens, deterministically. Budget
never overrides safety (§8).

### 9.3. Anchors

Every omission leaves a drill-down anchor: a concrete command (or address) that
retrieves the elided detail (`vdelta show <run> --test <id>`, `--raw`).
Progressive disclosure is mandatory — a consumer can always reach raw evidence.

### 9.4. Consumer requirements

- Consumers MUST treat an unknown value in any closed enum as a hard error
  (throw), never as a default or a silent skip. Backward-compatibility
  scaffolding around unknown enum values is non-conforming.
- Consumers MUST NOT reinterpret unknown fields; unknown fields SHOULD be
  rejected (§14).
- Consumers MUST honor `comparability` limits when relaying claims onward.

## 10. Command interface (reference CLI)

Command names are illustrative of the reference implementation; the division of
responsibilities and exit-code semantics are normative for any CLI claiming
conformance.

| Command | Responsibility | Exit code |
|---|---|---|
| `vdelta run -- <cmd>` | Execute, record, report | **Transparent child exit.** Internal errors degrade to raw passthrough (INV-5). |
| `vdelta compare <run-a> <run-b>` | Compare immutable runs | Success of the comparison operation itself (an `inconclusive` *result* is a successful comparison). |
| `vdelta show <run-id> [--test <id>\|--raw]` | Drill-down retrieval | Retrieval success. |
| `vdelta gate` | Policy verdict for CI/agent loops | `0` no gate-relevant transitions; `1` regression or surface reduction; `2` inconclusive or error (§11). |
| `vdelta doctor` *(OPTIONAL)* | Store-health diagnostics: comparable-run density, inconclusive rate, passthrough rate | Diagnostic success. Small samples MUST abstain (`insufficient_data`), not extrapolate. |

The child's "tests failed" and "something regressed since baseline" are never
encoded in the same exit code: `run` owns transparency, `gate` owns semantics.

## 11. Gate

### 11.1. Policies and the reporting floor

`policy` is a closed enum — there is no free-form selection of which findings
exist:

| Policy | Exit behavior | Intended stage |
|---|---|---|
| `report-only` | Always `0` (report published, e.g., PR comment); `2` only if the gate itself cannot produce a report | First deployment; builds trust without blocking. |
| `advisory` | Exit codes as `blocking`, but the report marks `policy: advisory` so harnesses surface it as a warning | Transition stage. |
| `blocking` | `1` on gate-relevant transitions, `2` on inconclusive | Required check. |

**Ungameable floor:** under every policy, `new_fail` findings and
`verification_surface` reduction events MUST appear in the output, and no flag,
configuration, or policy choice may remove them. Implementations MAY allow
narrowing which transitions *block*, but never which are *reported*; a
`blocking`-policy gate is further constrained by the blocking-set floor of
§11.5.

The default gate-relevant set is `{new_fail, updated_fail,
verification-surface reduced}`.

When comparing against a `git-ref` baseline, the gate MUST treat a
`selector-subset` event as gate-relevant: proven selector narrowing relative
to the baseline yields gate verdict `fail`, with common-ID transitions still
reported. An unproven selector change (`selector-relation-unknown`) yields
gate verdict `inconclusive`. Exit behavior follows the policy table: under
`blocking`, `1` and `2` respectively. Neither outcome ever maps to verdict
`pass` under any policy. `subset` comparability never relaxes §11.2 or §11.3.

### 11.2. Record integrity (INV-10)

The agent under audit can execute arbitrary commands, including edits to a
local run store. Therefore:

- Verdicts computed from an unverified local store are `advisory` and MUST be
  labeled as such.
- A `blocking` or `advisory` gate verdict MUST be based on records whose
  content addresses (and, where configured, signatures) verify, or on
  re-execution in an environment the agent cannot write to (CI).
- Verification failure is `comparability_detail: {reason:
  "record-integrity-failed", kind: "failed"}` → exit `2`.

### 11.3. Staleness check (INV-11)

Before judging, the gate MUST verify that the run's `provenance.tree_digest`
equals the content digest of the judged target (e.g., PR HEAD) **exactly**.
Binary equality only: no ratio, proximity, or "close enough" rescue. Mismatch →
`inconclusive`, exit `2`. Tampering (§11.2) and staleness are independent
checks; passing one never waives the other.

The gate MUST recompute the target's `tree_digest` from the workspace in which
the head-side run executed, immediately before judging. `git rev-parse
HEAD^{tree}` MAY be used as the canonical equivalent only when `git status
--porcelain --ignore-submodules=none` reports a clean workspace AND the judged
tree contains no gitlink entries. When submodules are present, the gate MUST
verify each initialized submodule worktree recursively: the submodule
worktree's `tree_digest` MUST equal the tree of the commit named by the
superproject's gitlink; any mismatch is `inconclusive`, exit 2. Submodules
without an initialized worktree cannot be content-verified: the gate report
MUST list them under `staleness.unverified_submodules`. The superproject
digest alone does not witness submodule content.

### 11.4. Gate report

The gate report extends the comparison report (§9.1) with:

```json
{
  "gate": {
    "policy": "report-only",
    "verdict": "fail",
    "triggered": ["new_fail", "verification_surface_reduced"],
    "target": {
      "kind": "merge",
      "head_sha": "1a2b3c...",
      "base_sha": "4d5e6f...",
      "merge_sha": "7a8b9c..."
    },
    "staleness": {
      "run_tree_digest": "sha256:aaa",
      "target_tree_digest": "sha256:aaa",
      "match": true,
      "unverified_submodules": []
    },
    "record_integrity": "tamper-evident"
  }
}
```

`gate.verdict`: `pass | fail | inconclusive` — reported identically under all
policies; policy affects only exit behavior.

### 11.5. Gate invocation contract (CI)

**Baseline supply.** A gate producing `blocking` or `advisory` verdicts MUST
support `same-job` mode: the gate job checks out the base tree and the target
tree and executes and records both runs itself. A gate MAY additionally
support `trusted-store` mode, substituting a stored base-branch run for
base-side execution only if all of the following verify: (1) record integrity
per §11.2; (2) exact `tree_digest` equality with the base tree; (3) exact
instrument identity per §6.2 and this section. On any failure the gate MUST
fall back to same-job base execution or return `inconclusive` (exit 2); it
MUST NOT select a weaker baseline (§5.3). Records produced inside the audited
agent's writable environment MUST NOT feed `blocking` or `advisory` verdicts
(INV-10).

**Isolation and sealing (INV-10).** Same-job execution qualifies as
`trusted-environment` only under this ordering contract: (1) the base-side run
MUST complete before any code from the audited change (tests,
conftest/build/install hooks, dependency resolution of the head tree) executes
in the job; (2) before any such code executes, the gate MUST seal the base
record's content address and a digest of the gate toolchain (gate executable,
runtime, configuration) by exporting them to an append-only channel outside
the job workspace (e.g., the CI step log or a check annotation); where the
channel permits later appends, verifiers MUST bind to the earliest seal entry
for the evaluation; (3) immediately before judging, the gate MUST re-verify
the base record and its own toolchain against the sealed values — any mismatch
is `record-integrity-failed` (§6.3), exit 2; (4) because step (3) executes
after the audited change's code has run in the job, a `blocking` verdict
additionally REQUIRES that the judgment's integrity is established outside the
audited change's write reach: either (a) the judgment runs in a separate job
or runner that receives only the sealed records and independently verifies
them against the sealed values, or (b) the party enforcing the verdict
independently verifies the published report and records against the sealed
values before acting on it. A gate that judges in-job without (a) or (b) MUST
cap `trust.record_integrity` at `tamper-evident` and its verdict at
`advisory`: the seals make in-job tampering detectable by an external auditor,
but an in-job judgment cannot witness its own integrity (§15). If the gate's
invocation path (workflow definition, checkout procedure, or gate-binary
resolution) is modifiable by the change's author for the evaluation at hand,
the verdict MUST NOT be `blocking`.

**Target definition.** The judged target is a tree, not a ref. The head-side
run MUST execute against the tree being judged (INV-11); testing a synthetic
merge tree while judging the head commit tree, or vice versa, is
non-conforming. The gate report MUST bind the judged tree to its provenance:
`gate.target: {kind: "head" | "merge", head_sha, base_sha, merge_sha?}`. For
`kind: "merge"` the base tree is the first parent's tree; for `kind: "head"`
it is the tree of `merge-base(base_branch, head_sha)`. A `pass` certifies the
judged tree only; re-validation after base movement is the responsibility of
branch protection, and the report MUST expose `base_sha` to enable it.

**Instrument identity.** Same-job execution does not waive §6.2. Each run MUST
execute in a dependency environment resolved from its own tree, and the run's
`environment` fingerprint MUST include the resolved runner plugin set and
adapter-declared runner-affecting environment variables (for pytest: including
`PYTEST_ADDOPTS`). Implementations SHOULD resolve both environments from
committed lockfiles where available, so that registry drift between the two
in-job resolutions cannot manufacture an instrument mismatch. Any instrument
mismatch between the two runs yields `none`/`instrument-changed`, exit 2, with
the corresponding `verification_surface` events (§7.4) in the report.

**Bytecode-cache hygiene.** Before each run, the recorder MUST ensure the
interpreter cannot load compilation or assertion-rewrite caches not derived
from that run's tree (§4.5). For CPython the RECOMMENDED mechanism is a fresh
`PYTHONPYCACHEPREFIX` per run, which neutralizes both stale and committed
`__pycache__` content without mutating the worktree; purging caches is
acceptable only for untracked files (deleting tracked files diverges the
workspace from the judged tree). `PYTHONDONTWRITEBYTECODE` alone is NOT
sufficient: it does not prevent reading pre-existing caches. Adapters SHOULD
report tracked bytecode files in the judged tree as a `verification_surface`
event.

**Blocking-set floor.** For `policy: blocking`, the gate-relevant set MUST
include `new_fail`, `updated_fail`, and `verification_surface` reduction. The
narrowing permitted by §11.1 MUST NOT remove `updated_fail` from a blocking
gate's set; this clause takes precedence over §11.1.

**Claim scope.** Gate claims are facts about the two recorded runs: `new_fail`
asserts "red in the head run and not red in the base run", nothing stronger.
The gate MUST NOT rerun tests to derive flakiness (§7.7). A base run that is
not `complete` is not an acceptable baseline (§5.2) and yields `inconclusive`,
exit 2 — never `pass`.

## 12. Adapters

- Adapters are **capability-declared, structured-first** (§3.4). They consume
  runner-native structured channels (plugins, machine-readable reporters), not
  scraped human-oriented text.
- Fail-closed on ambiguity: duplicate IDs, unknown outcomes, count mismatches,
  and undeclared capabilities yield `inconclusive` (or `kind: failed`
  abstention), never a guess.
- Unsupported formats pass through raw (INV-5). Line-level fallback parsing is
  excluded from the trust core.
- Lossy interchange formats (e.g., JUnit XML dialects that drop xfail, phase,
  source, markers) require an explicit supported-subset declaration and a
  capability matrix; anything outside the subset is `unsupported`, not
  approximated.

Adapter roadmap for the reference implementation (informative): `pytest`
native first; `vitest` native reporter second (agent coding skews TS/JS);
JUnit XML third, for CI breadth, under the constraints above.

## 13. Conformance

### 13.1. Conformance classes

Implementations claim conformance per role: **Recorder**, **Store**,
**Comparator**, **Gate**, **Adapter**, **Consumer**. The badge
`veridelta/1 compliant` requires passing the published conformance suite for
every claimed role.

### 13.2. Required fixture classes

The conformance suite MUST include, at minimum:

1. **Invariant fixtures** — one or more per INV-1..11 (INV-10 may be limited
   to the gate path in early revisions).
2. **Adversarial input fixtures** — reordering, partial execution, flaky
   sequences, secret-bearing output, branch crossing (§7.8) — including:
   (a) rerun stability — two executions of a deterministically failing test at
   an identical `tree_digest` MUST yield identical `evidence_digest`s;
   (b) stale-cache collision — a same-size source revert under coarse mtime
   resolution MUST NOT reproduce evidence from the prior source state (§4.5);
   (c) degraded-capability marking — a run pair recorded with assertion
   introspection disabled MUST emit non-empty `degraded_capabilities` on
   red-in-both claims.
3. **Operational pitfall fixtures** — the four classes that recur in practice:
   gate wired to the wrong target (wiring position), instrument drift
   undetected (§6.2), duplicate records double-counted (§4.3), and
   fail-open/fail-closed confusion (§6.3 vs INV-5).
4. **Consumer fixtures** — unknown enum value MUST throw; comparability limits
   MUST be honored.
5. **Verification-surface recall fixtures** — labeled cheating corpus
   (fail→skip/xfail, test deletion, repaired-with-test-change, selector
   narrowing, and collection-modifier inputs — `--deselect`, `--ignore`,
   `collect_ignore`-style exclusion — that MUST classify as in-scope
   non-observation, never `out_of_scope`): detection recall MUST be 100% on
   comparable runs.

### 13.3. Determinism proof

Fixture outputs are byte-compared. Any nondeterminism is a conformance
failure, not a warning.

## 14. Versioning and extensibility

- `schema_version` `"veridelta/1"` names this contract. Enums defined here are
  **closed** for `/1`; new enum values require a new schema version. During
  the draft phase (0.x spec revisions), enum sets may still change between
  revisions; closure binds from the first published revision of `veridelta/1`.
- Field additions within `/1` occur only through published spec revisions;
  consumers SHOULD reject unknown fields and MUST NOT silently reinterpret
  them.
- Producers MUST emit exactly one schema version per report.
- The spec is licensed MIT and intended for independent implementation;
  absorbing the schema into other tools (with or without the reference CLI) is
  the intended success mode.

## 15. Security considerations

- **Secrets**: secret values are never persisted. Environment comparison uses
  fingerprints of adapter-declared variables; failure evidence is redacted for
  known secret shapes before storage and digesting, deterministically (§3.5).
- **Threat model**: three distinct adversarial conditions are handled
  independently — the *confused* agent (wrong baseline, partial runs; INV-1..9),
  the *deceiving* agent (store tampering; INV-10, §11.2), and the *stale honest
  record* (TOCTOU; INV-11, §11.3). A mechanism addressing one MUST NOT be
  presented as addressing another.
- **Store**: repo-local, ignored by VCS, ephemeral, bounded; atomic writes;
  advisory fail-open locks (§4.4).
- The gate MUST run outside the audited agent's blast radius (separate
  process, CI environment) for any non-advisory claim.

## Appendix A (informative): Post-1.0 roadmap

| # | Feature | Constraint carried from this spec |
|---|---|---|
| A.1 | Failure clusters | Cluster by structural fingerprint; keep all IDs, counts, representative evidence, raw anchors; never assert same root cause. |
| A.2 | Changed-hunk correlation | `direct / transitive / none / unavailable` intersection of failure locations and changed hunks — prioritization evidence, not causation. |
| A.3 | Observed-flaky history | Only from ≥3 comparable runs at the same code state; never suppresses new/updated findings; gate policy stays with the caller. |
| A.4 | Coverage surface delta | Per-changed-line/branch execution comparison where a coverage adapter exists; aggregate coverage % alone never proves surface equality. |
| A.5 | Causal proof | Opt-in red/green re-verification: stash implementation-only changes → confirm red → restore → confirm green. Proves the test constrains the implementation (no vacuous pass) — a strictly stronger claim than `repaired_same_surface`, kept as a separate proof level. Ambiguous cases (mixed test/impl changes, stash failure, already-green base) stay `inconclusive`. |

## Appendix B (informative): Rejected designs

These were removed during adversarial design review and MUST NOT be
reintroduced without revisiting the arguments:

| Rejected | Why |
|---|---|
| Caller-supplied `--mask` regex in the trust path | `--mask '\d+'` collapses `expected 200 got 500` into `expected N got N` — a silently hidden regression that no diagnostic layer can recover. |
| `suggest` (inducing masks from run history) | "Environmental noise" and "values my fix moved" are indistinguishable as run-to-run diffs; suggesting masks from them is a self-propagating blind spot. |
| Caller-supplied `--key` regex | Replaced by adapter-provided canonical test IDs; also fixes parametrized-test merge accidents. |
| Implicit "previous invocation" baseline | Order-dependent; contaminated by branch switches and partial runs. Replaced by content addressing + explicit selection (§5). |
| Agent-interpreted diagnostic meta-loop | Making the agent reason about the tool's health spends the context the tool exists to save. Replaced by self-check → automatic fail-open (INV-5). |

Two counterarguments that were withdrawn, preserved for future reviewers:

- "`pytest --lf` suffices" — `--lf` changes *what runs* and can hide
  regressions in previously-passing tests; veridelta keeps the full suite
  semantics and changes only *what is looked at*. Orthogonal axes.
- "Let the agent diff the outputs" — both full outputs must enter context
  (defeating the purpose), and model summaries hallucinate and drop items;
  a deterministic diff structurally cannot.

## Appendix C (informative): Known residual risks

Accepted limitations surfaced during adversarial review of revision 0.2.0.
None violates an invariant; each is disclosed rather than papered over.

- **Degraded-evidence repositories.** Where both compared runs were recorded
  with assertion introspection disabled, a genuine red→red value mutation can
  yield digest-identical `still_fail_unchanged`. The mandatory
  `degraded_capabilities` surfacing (§9.1) makes the condition visible;
  escalating it to gate-relevant remains a MAY.
- **Flood valve vs. value signal.** Narrowing blocking to
  `failure_mode_changed: true` (to absorb honest flapping from
  volatile-in-message values, §3.6) would also exclude genuine value-only
  changes, whose structural fingerprint is likewise stable. Hence the
  blocking-set floor (§11.5); below `blocking`, the tradeoff is the
  operator's.
- **Multiple maximal superset baselines.** When maximal `previous-superset`
  candidates are mutually non-comparable, recency decides which out-of-scope
  ledger a report shows. Disclosed via `baseline.superset_candidates`; full
  closure (a per-series red ledger) is post-1.0.
- **Undecidable selectors.** For `-k`/`-m`-style expressions,
  `selector_relation` returns `unknown` and `previous-superset` abstains — a
  functional limitation, not a trust hole.
- **Cross-stream suppression blind spot (inner loop).** A fail→skip between
  two superset runs with different selectors appears in no local comparison;
  the final defense is the gate's full-width `git-ref` comparison.
- **Seal channel strength is platform-dependent.** The spec can require only
  append-only export and earliest-entry binding (§11.5); platforms where the
  audited job's token can rewrite annotations weaken the evidence.
- **Registry drift without lockfiles.** Per-tree dependency resolution twice
  in one job can hit registry drift, producing PR-unrelated
  `instrument-changed` abstentions; lockfile resolution is SHOULD-level.
- **Uninitialized submodules.** Content verification is impossible; the gate
  can only disclose them (`staleness.unverified_submodules`).
- **Two-run factualism.** A flaky base red whose evidence is byte-identical to
  the head's deterministic failure classifies as `still_fail_unchanged`;
  reporting floors keep it visible, but 2-run facts cannot distinguish it.
- **Head-run self-forgery is out of contract scope.** A hostile change that
  makes its own tests report `pass` is common to every architecture that
  executes the author's code; defenses are the surface events (§7.4) and the
  non-goal boundary (§1.3) — intent attribution stays with the consumer.

## Revision history

- **0.2.0 (2026-07-16)** — Resolved the open implementation questions via
  empirical probes (git tree-digest behavior; pytest failure-evidence
  volatility) and a two-round adversarial design review. Added: canonical
  failure evidence (§3.6), run/tree identity algorithms (§3.5),
  execution-cache coherence (§4.5), series key and `previous-superset`
  baseline mode (§5), `subset` comparability and selector semantics (§6.1,
  §6.4), `out_of_scope` transition and `selector-subset` event (§7),
  evidence-composition transparency in reports (§9.1), the gate CI invocation
  contract (§11.5), conformance fixtures for all of the above (§13.2), and
  this appendix.
- **0.1.0 (2026-07-16)** — Initial draft from the design document.
