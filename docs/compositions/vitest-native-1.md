# `composition_id: vitest-native/1` — evidence-affecting configuration audit

## 1. ヘッダ/前提

- `composition_id`: `vitest-native/1`（定義: `src/adapters/vitest/recorder.ts:29` の `COMPOSITION_ID`）
- `adapter`: `vitest`（`ADAPTER_NAME`, `src/adapters/vitest/recorder.ts:28`）

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

| 設定名 | 判定 | 根拠 |
| --- | --- | --- |
| `include_task_location`（既収録） | yes | `location_line` の有無が `observation.source_ref`（`toObservation`, `recorder.ts:165-166`）と `relOffsets`（`recorder.ts:238-246`、`t.location_line` が `null` なら `[]`）を左右する。`relOffsets` は `rel_offsets` として finding に入るため (a) に該当。 |
| `truncate_threshold`（既収録） | yes | chai の diff 切り詰め長。assertion message（`error.message` → `EvidenceError.message`）のバイト列そのものを変える。spec §3.1 が「diff/message truncation settings」を明示的に MUST covering 対象として挙げている。(a) に該当。 |
| `environment` | yes | node ↔ happy-dom/jsdom で globals・DOM API の有無が変わる。同一 tree でも `document is not defined` のような `ReferenceError`（`exception_type` 変化、(a)）が出るか、あるいはそもそも assertion に到達できず verdict が変わる（(b)）。§4.1.1 が「vitest の … `environment`（jsdom↔node で例外型やメッセージが変わりうる）」として明示する穴。 |
| `pool` | yes | `threads` ↔ `forks` で runtime 意味論が変わる。例: `forks` では `process.chdir()` 等プロセス限定 API が worker 内でも有効だが `threads`（`worker_threads`）では制約が異なり、エラーの worker 境界 serialization で `message`/`stack` 形状が変わりうる（(a)）。実測は §5 参照。 |
| `isolate` | yes | モジュール状態の隔離有無。`isolate: false` ではテスト間でモジュールのトップレベル状態（カウンタ、キャッシュ等）が漏れ、同一 tree でも実行順依存で verdict が変わりうる（(b)）。 |
| `retry` | yes | 最終 attempt の結果のみが verdict として報告されるため、flaky な fail が verdict ごと消える（(b)）。報告される `error`（message/exception_type）も attempt により変わりうる（(a)）。§4.1.1 が挙げる Playwright `retries: CI ? 2 : 0` と同型の穴で、vitest 側も `test.retry` / `retry` config で同じ構造を持つ。 |
| `testTimeout` | yes | timeout 発生時のメッセージに設定値そのものが埋め込まれる（例: `'Test timed out in Xms'`）。設定値を変えると同一 tree でも message バイト列が変わり（(a)）、timeout の発生有無自体で verdict（pass↔fail）も変わりうる（(b)）。 |
| `setupFiles` | yes | どの setup ファイルが解決され走るかのリストが、globals/mock の初期状態を変え、evidence 内容に波及する（(a)/(b)）。**covering すべきは解決済みパスのリスト（どの setup が走るか）であり、ファイル内容の digest ではない** — 内容側は `provenance.tree_digest` / `surface.config_sources`（設定ファイル自体を config_files 経由で拾う場合）の担当であり、役割はここで切り分ける。 |
| `sequence`（shuffle/seed/concurrent 等） | yes | 実行順序が変わると、`isolate: false` や外部リソース共有時の state leak を経由して同一 tree でも verdict・evidence が変わりうる（(b)、条件付きで (a)）。 |

以上 9 項目。既収録 2 項目 + 未収録 7 項目（issue の最低要求）をすべて yes と判定した。
9 項目以外の追加候補として `chaiConfig` の他フィールド（例: `showDiff` 相当）も理論上
evidence-affecting になりうるが、実装調査で明白な根拠を確認できていないため本 audit では
追記しない（YAGNI — 投機的な網羅はしない）。

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

## 7. 既知の乖離と後続

現行の `instrumentConfigDigest`（`src/adapters/vitest/recorder.ts:150-155`）は本列挙
9 項目のうち **`include_task_location` / `truncate_threshold` の 2/9 しか covering していない**。
残り 7 項目（`environment` / `pool` / `isolate` / `retry` / `testTimeout` / `setupFiles` /
`sequence`）は未準拠であり、§5 の実測（`environment`・`pool` の乖離）がこれを裏付けている。

本 issue（#38）はこの audit と文書化のみをスコープとし、実装修正（`instrumentConfigDigest`
の計算ロジック変更、`Capture.config` へのフィールド追加、`composition_id` の変更）は
issue #39 と合わせて別 Step で行う。本文書の作成にあたり `src/` は一切変更していない。
