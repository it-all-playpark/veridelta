# `composition_id: vitest-native/1` — evidence-affecting configuration audit

## 1. ヘッダ/前提

> **改版注記（issue #39）**: 本文書はもともと `vitest-native/1` に対する audit（issue #38）の
> 記録として書かれた。issue #39 で本文書 §4 が列挙する 9 項目すべてが `instrumentConfigDigest`
> に実装され、`completeness.module_errors` も構造化フィールドとして record 化されたことに伴い、
> composition は `vitest-native/2`（定義: `src/adapters/vitest/recorder.ts:35` の
> `COMPOSITION_ID`）へ改版された。§2・§5 は audit 実施当時（`/1`, 2/9 covering）の記録として
> そのまま残す（歴史の書き換えをしない）。実装後の事実は §4・§7 に反映している。

- `composition_id`: `vitest-native/2`（定義: `src/adapters/vitest/recorder.ts:35` の `COMPOSITION_ID`）
- `adapter`: `vitest`（`ADAPTER_NAME`, `src/adapters/vitest/recorder.ts:34`）

本文書の位置づけ: `docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` §4.1.1
が定める adapter 共通契約

> `instrument.config_digest` は composition が列挙する **解決済み** evidence-affecting
> 設定から計算する。各 adapter は列挙リストを `composition_id` にひもづけて文書化する。
> config ファイルの digest は `surface.config_sources` の役割であり、`config_digest` の
> 代替にならない。

の `vitest-native/1` に対する実体（列挙リストそのもの）である。

根拠となる spec 側の規定を引用する（`spec/veridelta-1.md`）:

- §3.1（`instrument` フィールド定義）: 「The runner config digest MUST cover the effective
  configuration that alters evidence quality or structure — including
  assertion-introspection mode, traceback style, and diff/message truncation
  settings — however that configuration is supplied (command line,
  configuration files, plugins, or environment).」
- §6.2 same-instrument rule: 「If adapter name, adapter version, or runner
  config digest differ between the two runs, the measuring instrument itself
  changed. The comparator MUST NOT claim `exact`; it MUST report comparability
  `none` with reason `instrument-changed`.」

すなわち `config_digest` が evidence-affecting な設定を covering し損ねると、実際には
instrument が変わっている2 run が `exact` 扱いされ、same-instrument rule が実効性を失う。

## 2. 現状（audit 対象の実装）

`instrumentConfigDigest`（`src/adapters/vitest/recorder.ts:150-155`）:

```ts
export function instrumentConfigDigest(capture: Capture): string {
  return canonicalDigest({
    include_task_location: capture.config.include_task_location,
    truncate_threshold: capture.config.truncate_threshold,
  })
}
```

capture 由来の **2値** `{ include_task_location, truncate_threshold }` のみを
`canonicalDigest` している。値の出所は `src/adapters/vitest/reporter.ts:91-96`:

```ts
config: {
  include_task_location:
    (config as { includeTaskLocation?: boolean } | undefined)
      ?.includeTaskLocation === true,
  truncate_threshold: chaiConfig?.truncateThreshold ?? null,
},
```

config **ファイル**の digest（`surface.config_sources`, `recorder.ts:85-90`）は別物であり、
§4.1.1 が訂正したとおり `config_digest` の代替にならない。本文書の §4 判定表は、この 2 値
以外に evidence-affecting な解決済み設定が存在するかを audit する。

## 3. 判定基準の定義

**evidence-affecting** の操作的定義:

> 同一 tree・同一 selector・同一 adapter version で、当該設定の値だけを変えたとき、
>
> (a) `evidence_digest` / `structural_fingerprint` に入るバイト列 — `buildFinding`
> （`src/adapters/vitest/recorder.ts:202-231`）が生成する `exception_type` /
> `message` / `expected` / `actual` / `operator` / `rel_offsets` のいずれか、
>
> または
>
> (b) `observation` の `verdict`（`src/adapters/vitest/recorder.ts:172-200` の
> `mapVerdict`）、
>
> を変えうるか。

(a)(b) いずれかを満たせば yes、いずれも満たさなければ no と判定する。以下の判定表の
「根拠」欄は必ずこの (a)/(b) のどちらに該当するかを含める。

## 4. 判定表（本体）

| 設定名 | 判定 | 根拠 | 実装注記（issue #39） |
| --- | --- | --- | --- |
| `include_task_location` | yes・収録済み（vitest-native/2） | `location_line` の有無が `observation.source_ref`（`toObservation`, `recorder.ts:165-166`）と `relOffsets`（`recorder.ts:238-246`、`t.location_line` が `null` なら `[]`）を左右する。`relOffsets` は `rel_offsets` として finding に入るため (a) に該当。 | `/1` から既収録。変更なし。 |
| `truncate_threshold` | yes・収録済み（vitest-native/2） | chai の diff 切り詰め長。assertion message（`error.message` → `EvidenceError.message`）のバイト列そのものを変える。spec §3.1 が「diff/message truncation settings」を明示的に MUST covering 対象として挙げている。(a) に該当。 | `/1` から既収録。変更なし。 |
| `environment` | yes・収録済み（vitest-native/2） | node ↔ happy-dom/jsdom で globals・DOM API の有無が変わる。同一 tree でも `document is not defined` のような `ReferenceError`（`exception_type` 変化、(a)）が出るか、あるいはそもそも assertion に到達できず verdict が変わる（(b)）。§4.1.1 が「vitest の … `environment`（jsdom↔node で例外型やメッセージが変わりうる）」として明示する穴。 | `capture.config.environment` をそのまま digest 入力に追加（`instrumentConfigDigest`, `recorder.ts`）。 |
| `pool` | yes・収録済み（vitest-native/2） | `threads` ↔ `forks` で runtime 意味論が変わる。例: `forks` では `process.chdir()` 等プロセス限定 API が worker 内でも有効だが `threads`（`worker_threads`）では制約が異なり、エラーの worker 境界 serialization で `message`/`stack` 形状が変わりうる（(a)）。実測は §5 参照。 | `capture.config.pool` を digest 入力に追加。 |
| `isolate` | yes・収録済み（vitest-native/2） | モジュール状態の隔離有無。`isolate: false` ではテスト間でモジュールのトップレベル状態（カウンタ、キャッシュ等）が漏れ、同一 tree でも実行順依存で verdict が変わりうる（(b)）。 | `capture.config.isolate` を digest 入力に追加。 |
| `retry` | yes・収録済み（vitest-native/2、count のみ） | 最終 attempt の結果のみが verdict として報告されるため、flaky な fail が verdict ごと消える（(b)）。報告される `error`（message/exception_type）も attempt により変わりうる（(a)）。§4.1.1 が挙げる Playwright `retries: CI ? 2 : 0` と同型の穴で、vitest 側も `test.retry` / `retry` config で同じ構造を持つ。 | `capture.config.retry` は `count`（number 正規化）のみ収録。`retry` の object 形（`{count, delay, condition}`）のうち `condition`（RegExp/function）は決定的 serialize が保証できないため未収録 — §7 の既知ギャップ (b) 参照。 |
| `testTimeout` | yes・収録済み（vitest-native/2） | timeout 発生時のメッセージに設定値そのものが埋め込まれる（例: `'Test timed out in Xms'`）。設定値を変えると同一 tree でも message バイト列が変わり（(a)）、timeout の発生有無自体で verdict（pass↔fail）も変わりうる（(b)）。 | `capture.config.test_timeout` を digest 入力に追加。 |
| `setupFiles` | yes・収録済み（vitest-native/2、解決済みパスリスト） | どの setup ファイルが解決され走るかのリストが、globals/mock の初期状態を変え、evidence 内容に波及する（(a)/(b)）。**covering すべきは解決済みパスのリスト（どの setup が走るか）であり、ファイル内容の digest ではない** — 内容側は `provenance.tree_digest` / `surface.config_sources`（設定ファイル自体を config_files 経由で拾う場合）の担当であり、役割はここで切り分ける。 | covering は `configSourceKey(path, worktree)` による worktree 相対パス（外部は `external:<abs>`）の解決済みリストで、resolved 順を保持（sort しない — setup 実行順は evidence-affecting）。ファイル内容 digest は入れない。 |
| `sequence`（shuffle/seed/concurrent 等） | yes・収録済み（vitest-native/2、sequencer+shuffle_tests） | 実行順序が変わると、`isolate: false` や外部リソース共有時の state leak を経由して同一 tree でも verdict・evidence が変わりうる（(b)、条件付きで (a)）。 | vitest 4 の `resolveConfig` は `shuffle` の `{files, tests}` object 形を正規化する（`node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:470-481`）: `tests` 側は `shuffle.tests` boolean になり、`files` 有効は `sequencer` クラス（`RandomSequencer`）としてのみ残る。そのため sequencer class 名 + `shuffle_tests` boolean の両軸で covering する。shuffle 有効かつ seed 未指定の run は vitest が `seed = Date.now()` を補う（同ファイル 481 行の条件付き `??=`）ため、run 毎に `config_digest` が変わり `instrument-changed` で abstain になる — これは実行順が毎回変わるという事実の正直な反映であり、比較したい場合は seed を pin する。 |

以上 9 項目すべてが `instrumentConfigDigest`（`src/adapters/vitest/recorder.ts`）で
covering 済みである（issue #39 実装）。9 項目以外の追加候補として `chaiConfig` の他フィールド
（例: `showDiff` 相当）も理論上 evidence-affecting になりうるが、実装調査で明白な根拠を
確認できていないため追記しない（YAGNI — 投機的な網羅はしない）。

## 5. 実測根拠（dogfood）

`probes/shift-bud-baseline/manifest.json`（本リポジトリ内）より、全 6 ストリーム
（backend / frontend / shared / landing / video / e2e）の `instrument.config_digest` が
**同一値**であることを確認した:

```
$ jq '[.streams[].instrument.config_digest] | unique' probes/shift-bud-baseline/manifest.json
[
  "sha256:c25192133cc3051d857d13b0b74cdde42e1b9534a0cb1468c1bad72aa0471b9c"
]
```

一方、subject である shift-bud の pin SHA `8cf90518`（`probes/shift-bud-baseline/README.md`
の再検証手順が定める SHA。完全形 `8cf905189a179d8c40fbd1dcead7915981b1c4d3` は各ストリームの
`provenance.head` と一致）で `git show 8cf90518:packages/<pkg>/vitest.config.ts` を実行し、
解決済み設定を確認したところ、実際には割れていた:

| package | `environment` | `pool` | `isolate` | `setupFiles` |
| --- | --- | --- | --- | --- |
| backend | `node`（明示） | `threads`（明示） | `true`（明示） | `['./tests/support/setup/test-env.ts']` |
| frontend | `happy-dom`（明示） | `threads`（明示） | `true`（明示） | `['./src/test/setup.ts']` |
| shared | `node`（明示） | `forks`（明示） | 未指定（vitest デフォルト `true`） | なし |
| landing | `node`（明示） | 未指定（vitest デフォルト `forks`） | 未指定（デフォルト `true`） | なし |
| video | 未指定（デフォルト `node`） | 未指定（デフォルト `forks`） | 未指定（デフォルト `true`） | なし |
| e2e | 未指定・**vitest.config 自体が存在しない**（デフォルト `node`） | 未指定（デフォルト `forks`） | 未指定（デフォルト `true`） | なし |

（`landing`/`video`/`e2e` の `pool` デフォルト値 `forks` は、shift-bud にインストールされた
`vitest@4.1.10`（`node_modules/.../vitest/dist/chunks/coverage.DM_a_rWm.js:180`
`resolved.pool ??= "forks"`）から確認した。`e2e` は `packages/e2e` に `playwright.config.ts`
のみ存在し `vitest.config.ts` は無い — `git ls-tree 8cf90518 packages/e2e` で確認済み — ため
「config ファイル不在 = vitest デフォルト設定一式」として記載する。）

`environment` は `node` と `happy-dom` の 2 値、`pool` は `threads` と `forks` の 2 値に
実際に割れている 6 ストリームが、同一の `config_digest` を持つ。これは §4 判定表の
`environment` / `pool` を yes とした判定の実データによる裏付けであると同時に、
**現行 `config_digest` が spec §3.1 の MUST を満たしていないことの実証**でもある
（`environment`/`pool` は capture の `config` に一切含まれていないため、その差異は
`instrumentConfigDigest` の入力に到達し得ない）。

design doc §4.1.1 は同種の穴の例として `jsdom↔node` を挙げているが、shift-bud の実測は
`happy-dom↔node` である。本節は実測データ（`happy-dom`）を主とし、design doc の `jsdom` 言及
は同種の例として引用するにとどめる（実測と引用を混同しない）。

この結果は `probes/shift-bud-baseline/README.md` の Phase 0a 所見 F-1
（「`instrument.config_digest` が `include_task_location` / `truncate_threshold` の2値のみで、
`environment` / `pool` / `retry` 等の evidence-affecting な解決済み設定を covering していない」）
として既に issue 化されている既知欠陥に対応する。

## 6. 変更規律

本列挙リスト（§4 判定表）の変更は composition の変更である。spec §3.6 末尾:

> The declared composition is part of the measuring instrument: any
> composition change requires an adapter version change (§6.2).

に基づき、列挙リストへの項目追加・削除・判定変更は `instrument.adapter_version` の変更を
要求する。これは §6.2 same-instrument rule により、instrument が変われば2 run 間の
comparability が `exact` と主張できなくなる（`instrument-changed`）ことの直接の帰結である。

## 7. 既知の乖離と後続（issue #39 実装後の事実）

issue #39 の実装により、`instrumentConfigDigest`（`src/adapters/vitest/recorder.ts`）は
本文書 §4 が列挙する **9/9 項目すべてを covering** している
（`include_task_location` / `truncate_threshold` / `environment` / `pool` / `isolate` /
`retry`（count のみ） / `test_timeout` / `setup_files`（解決済みパスリスト） / `sequence`
（sequencer 名 + `shuffle_tests`)）。§5 の実測（audit 当時 `/1` の 2/9 covering で
`environment`・`pool` の乖離が実データに現れていた）が裏付けていた欠陥は、この実装で
解消された。

`completeness.module_errors: { rel: string, count: number }[]`（rel 昇順ソート、record 常時
存在・無エラー時は `[]`）が構造化フィールドとして record 化され、モジュールロード失敗が
プログラムから列挙可能になった（既存の `completeness.status` はこの会計情報の帰結として
そのまま残る）。

残るギャップ（YAGNI によりスコープ外、投機的網羅はしない）:

- (a) **multi-project workspace の per-project config 分岐は未 covering**。root の
  resolved config（`ctx.config`）のみを capture し、project 毎の `environment`/`pool` 等の
  差分は covering しない。#38 audit の実測モデル（shift-bud）は package 毎に別 invocation
  （別ストリーム）であり root config で足りるため、per-project capture への拡張は本 issue の
  スコープ外とした。
- (b) **`retry.condition`（RegExp/function）は未 covering**。`count` のみ number 正規化して
  収録し、`condition` は決定的 serialize が保証できないため除外している。
- (c) **`probes/shift-bud-baseline/` の録り直しは本 PR スコープ外で未実施**。§5 の実測記録は
  `/1`・2/9 covering 時点のものであり、`config_digest` が変わるため（`run_id` 全変化）
  再録が必要だが、baseline の録り直しは別スコープとする。
- (d) **coverage 表示への completeness 併記は #40** で扱う。本 issue では
  `completeness.module_errors` の record 化までをスコープとする。
