# veridelta/1 — Verification Delta Protocol

| | |
|---|---|
| **Status** | Draft |
| **Schema identifier** | `veridelta/1` |
| **Spec revision** | 0.1.0 — 2026-07-16 |
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
| `instrument` | adapter name, adapter version, runner config digest | REQUIRED. Together these identify the *measuring instrument* (§6.2). |
| `environment` | runner, runtime, OS, fingerprint of adapter-declared comparison-relevant env vars | REQUIRED. Secret **values** MUST NOT be stored; fingerprints only (§15). |
| `provenance` | `head` (VCS revision), `dirty_diff_digest`, `tree_digest` | REQUIRED. `tree_digest` MUST identify the exact source content the run executed against (for git: derivable as the tree OID of the worktree content including uncommitted changes). Provenance is **evidence of what was compared, never a stream-matching key** (§5.1). |
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
| `evidence_digest` | **Trust path.** Lossless digest of the runner-provided failure evidence after (deterministic) secret redaction and canonical encoding, and after nothing else. Any change to raw evidence changes this digest. Change detection MUST use this and only this. |
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

- `run_id` MUST be content-derived and immutable.
- All digest inputs MUST be canonicalized deterministically (encoding, ordering
  of multi-part evidence) and the canonicalization MUST be documented by the
  adapter.
- Redaction (§15) runs before digesting and MUST itself be deterministic, so
  digests remain stable for identical inputs.

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
the most recent full-scope run against the current subset run over their common
IDs, under the `scope_changed` rules of §6.

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

### 5.2. Baseline modes

| Mode | Intended use | Meaning |
|---|---|---|
| `previous-comparable` | dirty-tree inner loop (default) | Most recent **complete** run in the same stream. |
| `git-ref` | PR / regression gate | Complete run whose provenance matches the given ref. |
| `explicit-run-id` | agent/harness control | Caller names an immutable run. |

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
| `partial` | Declared scope not fully observed | Only facts observed in the current run. `repaired`, `missing`, and `unchanged` MUST NOT be asserted. |
| `none` | No comparable baseline | Structured current-run results only. |

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
| `store-corrupt` | `failed` |
| `adapter-crashed` | `failed` |
| `record-integrity-failed` | `failed` |

`kind: failed` reasons additionally trigger the fail-open behavior of INV-5
where applicable. This enum is closed (§14).

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
- `test-source-changed`, `config-source-changed` (digest changes of test/config
  sources)

`verification_surface.status`: `intact | changed | reduced | inconclusive`.
`changed` covers source/config digest drift alone; `reduced` is REQUIRED
whenever the observed scope demonstrably shrank (fail→skip/xfail, deletions,
selector narrowing, lost observation). Coverage-based surface evidence is
handled only by adapters that declare it; otherwise `inconclusive` (Appendix A).

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
narrowing which transitions *block* (e.g., not blocking on `updated_fail`), but
never which are *reported*.

The default gate-relevant set is `{new_fail, updated_fail,
verification-surface reduced}`.

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

### 11.4. Gate report

The gate report extends the comparison report (§9.1) with:

```json
{
  "gate": {
    "policy": "report-only",
    "verdict": "fail",
    "triggered": ["new_fail", "verification_surface_reduced"],
    "staleness": {
      "run_tree_digest": "sha256:aaa",
      "target_tree_digest": "sha256:aaa",
      "match": true
    },
    "record_integrity": "tamper-evident"
  }
}
```

`gate.verdict`: `pass | fail | inconclusive` — reported identically under all
policies; policy affects only exit behavior.

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
   sequences, secret-bearing output, branch crossing (§7.8).
3. **Operational pitfall fixtures** — the four classes that recur in practice:
   gate wired to the wrong target (wiring position), instrument drift
   undetected (§6.2), duplicate records double-counted (§4.3), and
   fail-open/fail-closed confusion (§6.3 vs INV-5).
4. **Consumer fixtures** — unknown enum value MUST throw; comparability limits
   MUST be honored.
5. **Verification-surface recall fixtures** — labeled cheating corpus
   (fail→skip/xfail, test deletion, repaired-with-test-change, selector
   narrowing): detection recall MUST be 100% on comparable runs.

### 13.3. Determinism proof

Fixture outputs are byte-compared. Any nondeterminism is a conformance
failure, not a warning.

## 14. Versioning and extensibility

- `schema_version` `"veridelta/1"` names this contract. Enums defined here are
  **closed** for `/1`; new enum values require a new schema version.
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
