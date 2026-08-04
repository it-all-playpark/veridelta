# shift-bud Phase 0a baseline

`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` の **Phase 0a** 実行結果。
§8.3 副基準2（shift-bud live 再記録）と副基準1（capture replay）の基準値として保存する。

shift-bud 側の `.veridelta` store は gitignore され auto-GC もかかる（`src/run.ts` の
retention policy）ため、根拠 record が蒸発しうる。それを避けるためここに置く
（§8.3 baseline manifest 仕様）。

> **現行 baseline は vdelta 0.10.0 / `vitest-native/2`。**
> 初版 0.3.0 / `vitest-native/1` から数えて7回録り直している:
> 0.3.0 → 0.4.0（issue #39 / PR #46）、0.4.0 → 0.5.0（issue #49 / PR #50）、
> 0.5.0 → 0.6.0（issue #55 / PR #56）、0.6.0 → 0.7.0（issue #60 / PR #61）、
> 0.7.0 → 0.8.0（issue #64 / PR #65）、0.8.0 → 0.9.0（issue #68 / PR #69）、
> 0.9.0 → 0.10.0（issue #72 / PR #75）。
>
> **`instrument.adapter_version` は `VDELTA_VERSION` = package version そのもの**なので、
> record 形状が変わらなくても **release が入るだけで** spec §6.2 の same-instrument rule により
> comparability は切れる。0.5.0 → 0.6.0 がまさにその形（vitest composition は無変更）。
> 旧版の manifest と `runs/` は git 履歴に残る。経緯は末尾の「検証ログ」を参照。

## 内容

| ファイル | 中身 |
| --- | --- |
| `manifest.json` | 前提条件・コントロール証明・6ストリームのサマリ・superseded 2件 |
| `runs/<run_id>.json.gz` | 各 run の **run_id preimage**（record から `recording` グループを除いたもの）。gzip 済み |
| `diff-preimages.mjs` | 旧 baseline と新記録の**構造 diff**。§8.3 の「run_id の変化が想定した group の差分としてのみ説明可能であること」を機械判定する。使い方はファイル冒頭のコメント参照 |

## run_id preimage という性質

spec §3.5 は `run_id` を「Run record の canonical serialization（`recording` グループを**除外**）の
SHA-256」と定める。`runs/<run_id>.json.gz` は展開するとまさにその preimage であり、
**保存物からファイル名を再計算して検証できる**（自己検証性）。

```js
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { canonicalJson } from 'vdelta'   // src/index.ts が re-export

const preimage = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const id = 'run_' + createHash('sha256').update(canonicalJson(preimage), 'utf8').digest('hex')
// id === basename(path, '.json.gz')
```

生成時に全8件で検証済み（`manifest.json` の `run_id_verified` / `totals.all_run_id_verified`）。

## 記録結果

| package | run_id | observations | completeness |
| --- | --- | --- | --- |
| backend | `run_a38681d1` | 1958 | complete |
| frontend | `run_0b5b0108` | 1540 | complete |
| shared | `run_01d22ca9` | 457 | complete |
| landing | `run_077bae44` | 76 | complete |
| video | `run_d42c25ae` | 195 | complete |
| e2e | `run_b5840cf0` | 30 | complete |

計 **4256 observations**、全ストリームで `report != null`（passthrough に落ちない）。
Phase 0a の受け入れ基準1 を満たす。
**観測数は 6/6 とも 0.3.0 / 0.4.0 / 0.5.0 baseline と同一** — record 形状変更が2回、
Playwright adapter 追加が1回入ったが、検証面は一度も動いていない。

全ストリームが `instrument.capabilities` を**7項目**宣言している
（`verdicts` / `source-location` / `suppression` / `inventory` / `failure-evidence` /
`selector-relation` が `pass`、`source-region-text` が `unsupported`）。
0.4.0 以前の record はこのフィールドを持たない。

宣言の変遷:

- **0.6.0（Playwright adapter 追加）はこの宣言を変えていない** — `retry-evidence` は
  Playwright 側のみが宣言し、vitest には追加しないと決めたため（issue #53 意思決定(2)）
- **0.8.0 で `selector-relation` が加わり 6 → 7 項目**（issue #64 / PR #65 = F-5）。
  これが 0.7.0 → 0.8.0 で `capabilities` が動いた唯一の理由
- **0.9.0（F-5-E `previous-superset` / series key）はこの宣言を変えていない** — E は
  比較側の baseline 選択の話であり、記録側には触れていない（issue #68 / PR #69）
- **0.10.0（`vdelta run` の加法的フォールバック）もこの宣言を変えていない** — 変更は
  `src/run.ts` の呼び出し側のみ（issue #72 / PR #75）

`superseded` の2件（`run_2c8eaba3` / `run_2bcfc36e`）は baseline ではない。
下記 F-2 の証拠として保存している。

### `config_digest` の分岐（F-1 の実データ確認）

9項目 covering により、6ストリームが **3種類**の digest に分岐した:

| digest | package |
| --- | --- |
| `sha256:7c7de262…` | backend |
| `sha256:0dcfea0b…` | frontend |
| `sha256:46ee147e…` | shared / landing / video / e2e |

0.3.0（2項目 covering）では **6/6 が同一値** `sha256:c2519213…` だった。
4パッケージが今も同一 digest なのは covering の漏れではなく、
`docs/compositions/vitest-native-1.md` §5 の判定表どおり
**9項目の解決済み値が実際に等価**だからである（`environment=node` / `pool=forks` /
`isolate=true` / `setupFiles` なし、残り5項目もデフォルト）。この4つを分けている
`globals` / `include` / `resolve.alias` は §3 の evidence-affecting 判定を満たさず
covering 対象外 — `include` の変化は `surface.inventory_digest` 側で観測される。

## 再検証手順（§8.3 副基準2）

```bash
# 1. subject を pin SHA で復元（絶対パスを manifest と一致させること）
git worktree add --detach \
  /Users/naramotoyuuji/ghq/github.com/playpark-llc/shift-bud/.claude/worktrees/vdelta-0a \
  8cf90518
cd <その worktree>
pnpm install --frozen-lockfile
pnpm --filter @shift-bud/shared build      # 必須。省くと F-2 の観測欠落が起きる

# 2. 各パッケージで記録
cd packages/<pkg> && npx -y vdelta@0.10.0 run -- npx vitest run <selector>
```

`selector` は `manifest.json` の `streams[].invocation` を参照（backend のみ `src`、
e2e は `screenshots/recording/__tests__`、他は空）。

> `~/.npm/_cacache` に root 所有ファイルが混じっていると `npx` が EPERM で落ちる。
> `export npm_config_cache=<書き込み可能なパス>` で回避できる。この変数は
> `DECLARED_ENV_VARS = [CI, NODE_ENV, TZ, LANG]`（`src/adapters/vitest/recorder.ts:37`）に
> 含まれないため `env_fingerprint` には影響しない。

### 比較前に検証する前提条件

`manifest.json` の `preconditions` と突き合わせる。**いずれかが異なれば run_id は正当に変わる**：

- subject の commit SHA（`8cf90518`）と `provenance.tree_digest`（`f0ffc727…`）
- 記録に使う worktree の**絶対パス**（`repo.identity` / `repo.worktree` に入り run_id に効く）
- vdelta の version（`instrument.adapter_version`。spec §6.2 により instrument 変更は comparability を切る）
- node version（現 baseline は **v24.19.0**）/ vitest version（`4.1.10`）
- `CI` / `NODE_ENV` / `TZ` / `LANG`（`environment.env_fingerprint` に入る）

### コントロール証明

同一 vdelta・同一 tree で `packages/shared` を2回記録し `run_01d22ca9` が一致することを確認済み。
2回目が `baseline-missing` のままなのは content addressing が完全重複を畳んだ結果であり、
spec §3.5 の設計どおりの挙動。

**副基準2 を回す前に、必ずこのコントロールを先に取ること**（§8.3）。
これを飛ばすと、不一致が「refactor による挙動変化」なのか「そもそも決定的でない」なのか
切り分けられない。

## Phase 0a で得られた所見

| # | 所見 | 状態 |
| --- | --- | --- |
| F-1 | `instrument.config_digest` が `include_task_location` / `truncate_threshold` の2値のみで、`environment` / `pool` / `retry` 等の evidence-affecting な解決済み設定を covering していない（設計 §4.1.1） | **解決**。#38（audit）→ #39 / PR #46 で9項目 covering を実装。上記「`config_digest` の分岐」で実データ確認済み |
| F-2 | module load 失敗時、当該ファイルのテストが `observations` から丸ごと消えるが `coverage=N/N` は 100% を示す。`module_errors` の詳細は record に載らず `recording.raw_stdout` の非構造テキストにしか残らない | **解決**。#39 / PR #46 で `completeness.module_errors` を record 化。superseded 2件で実データ確認済み（backend 84件 / frontend 43件を列挙） |
| F-3 | text renderer が `completeness.status` を出力しない。JSON report（primary interface）は `complete: false` を持つので spec §9.1 は満たしている | **解決**（#40 / PR #42） |
| — | （正常挙動）`compare.ts` の baseline 選択が `completeness.status !== 'complete'` を除外している。INV-4 に沿う | — |
| — | （正常挙動）near-miss disclosure（spec §5.4）が6ストリーム間で `repo.cwd` / `invocation.selector` の差分を正しく開示 | — |

## この baseline が検証できること / できないこと

設計 §6 は Phase 0a を「Phase 1 のゲート」と位置づけ、§8.3 副基準2 を
「Phase 0a で記録した run_id 群と、**Step 1 完了後**に同じ tree T で記録した run_id 群が一致すること」
と定義している。しかし実際には **Phase 1 Step 1（seam 抽出、PR #36 / `ac3442b`）が Phase 0a より先に
着地しており**、初版 baseline は Step 1 適用後のバイナリ（0.3.0）で記録された。
現行 baseline は Phase 2（Playwright adapter）着地後（0.6.0）である。

したがって:

- ❌ **Step 1 の挙動凍結検証には使えない。** 事前・事後の関係が成立していない
  （Step 1 は Phase 0a より先に着地した）。主基準は in-repo A/B replay
  （`tests/conformance/ab-replay.test.ts`）が担う。
- ✅ **Step 2（capabilities 載せ替え）の完了条件3 の判定には実際に使えた。**
  0.4.0 の preimage を保存していたため、0.5.0 との構造 diff で
  「差分が capabilities group と adapter_version のみ」を機械判定できた
  （2026-07-30 の検証ログ）。
- ✅ **adapter seam の分離性の検証にも使えた。** Playwright adapter を丸ごと追加した 0.6.0 で、
  差分が `adapter_version` の1パスのみであることを機械判定できた
  （2026-07-31 の検証ログ）。「adapter 追加が既存 adapter に漏れない」という
  seam の設計目的を、in-repo A/B replay とは別軸で裏付ける証拠になる。
- ✅ **記録経路と比較経路の分離の検証にも使えた。** comparator / gate / render / schema を
  変更した 0.7.0 でも差分は `adapter_version` の1パスのみだった（2026-08-02 の検証ログ）。
  adapter 軸（0.6.0）に加えて**記録 ↔ 比較の軸**でも分離が効いていることの実データ確認。
- ✅ **前向きの回帰基準として使える。** record 形状を変えないはずの変更が
  これらの run_id を再現できなければ、それは意図しない挙動変化である。
- ✅ **§8.3 副基準1（capture replay）の入力**として使える。
- ✅ **実データの証拠コーパス**として使える。

なお record 形状を変える変更（`adapter_version` bump を伴うもの）は spec §6.2 により
本 baseline との comparability を**意図的に**切る。その場合は着地後に baseline を録り直すこと。

## 検証ログ

本 baseline を実際に照合した記録。**不一致が出たとき「壊れた」のか「正当な instrument 変更」なのかを
切り分けるための履歴**なので、照合するたびにここへ追記すること。

### 2026-07-29 — #38 / #40 マージ後の main で 6/6 一致（0.3.0 baseline）

| 項目 | 値 |
| --- | --- |
| 対象 main | `749aa0c`（PR #42 = issue #40、PR #43 = issue #38 のマージ後） |
| `adapter_version` | **0.3.0**（release 0.3.1 は当時 PR #44 として未マージ） |
| 結果 | **6/6 の run_id が baseline と完全一致** |

確認したこと:

- #40（`fix(render)`）は `src/schema.ts` を変更しているが、差分は `ComparisonReport` への
  optional field `completeness_status` の追加のみ。**`src/adapters/` / `src/run.ts` /
  `src/digest.ts` / `src/canonical.ts` は差分ゼロ**で、record 構築経路は無傷。
- #38 は `src/` を一切変更していない（issue のスコープ制約どおり）。

→ 両者が record 形状を動かしていないことの実証であり、
**0.3.0 baseline が「前向きの回帰基準」として機能することの初めての実データ確認**でもある。

> **重要:** `instrument.adapter_version` は `VDELTA_VERSION` = package version そのもの
> （`src/run.ts:57`, `:273`）。したがって **release が入るたびに**、コード変更の有無に関わらず
> spec §6.2 の same-instrument rule により baseline との comparability は切れる。

### 2026-07-30 — Step 2 着地に伴う baseline 録り直し（0.3.0 → 0.4.0）

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.4.0`（npm 公開版。PR #46 = issue #39 マージ後の PR #47 release） |
| `composition_id` | `vitest-native/1` → **`vitest-native/2`**（`capture_version` 2 → 3） |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`（初版と同一） |
| node | v24.18.0 → **v24.18.1**（記録機のランタイム更新） |
| 結果 | 全 run_id が変化（**正常**）。観測数は 6/6 とも初版と一致 |

全 run_id が変わったのは spec §6.2 の same-instrument rule による**設計どおりの結果**であり、
欠陥ではない。`adapter_version`（0.3.0 → 0.4.0）と `config_digest`（2項目 → 9項目 covering）の
両方が動いているため。node の版も上がっており、**初版 baseline はこのマシンでも厳密再現できない**。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_ec8d2c42` が一致。決定性は維持。
- **観測数の完全一致** — backend 1958 / frontend 1540 / shared 457 / landing 76 / video 195 /
  e2e 30、計 4256。record 形状は変わったが**検証面は1件も動いていない**。
- **F-1 の実データ確認** — `config_digest` が 6/6 同一から3種へ分岐。
  実際に設定が異なる backend / frontend が分離され、9項目の値が等価な
  shared / landing / video / e2e は正しく畳まれた（上記「`config_digest` の分岐」）。
- **F-2 の実データ確認** — `shared/dist` を退避して未 build 状態を再現し backend / frontend を記録。
  観測数は 0.3.0 の superseded と同じ 528 / 536 に縮むが、
  今回は `completeness.module_errors` が失敗ファイルを **84件 / 43件** 列挙する。
  text renderer も `coverage=536/536 [INCOMPLETE: crashed]` / `surface: reduced (1004 events)` を
  併記するため、「100% なのに検証面の 65〜73% が消えている」という誤読が塞がれている。

### 2026-07-30 — Phase 1 Step 2 完了に伴う録り直し（0.4.0 → 0.5.0）と §8.3 条件3 の機械判定

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.5.0`（npm 公開版。PR #50 = issue #49 マージ後の PR #51 release） |
| 変更 | `instrument.capabilities` の record 化（設計 §4.2 = Phase 1 Step 2 の本体） |
| `composition_id` | **`vitest-native/2` のまま**（capability declaration の内容は不変、載せる場所のみ変更） |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`、node v24.18.1（前回と同一） |
| 結果 | 全 run_id が変化。**§8.3 Step 2 の完了条件3 を機械判定して PASS** |

**設計 §8.3 が定める Step 2 の完了条件3**「run_id の変化は、宣言した
`instrument.capabilities` group の差分としてのみ説明可能であること」を、
0.4.0 baseline の preimage（本 probe に保存済み）と 0.5.0 の preimage の**構造 diff**で
機械判定した。結果は 6/6 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.4.0"` → `"0.5.0"` |
| `instrument.capabilities` | （なし）→ 6項目の宣言 |

**これ以外の差分はゼロ。** `observations` は 6/6 とも完全一致（配列丸ごとバイト同一）、
`config_digest` / `surface` / `provenance` / `environment` も不変。

near-miss disclosure がこれを独立に裏付けている: backend / frontend / shared / e2e の
near-miss は `instrument.adapter_version` の差分**のみ**を開示した。
0.3.0 → 0.4.0 のときは `config_digest` も併記されていたので、
capabilities の追加が digest を動かしていないことが report 側からも読める。

> **これが baseline を「前向きの回帰基準」として実際に使った初めてのケースである。**
> 0.4.0 の preimage を保存していたからこそ、「record 形状が変わったが検証面は不変」を
> 主張ではなく機械判定で示せた。§8.3 が baseline manifest に run_id 文字列だけでなく
> preimage 本体の保存を要求している理由がここにある。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_132d59a1` が一致。決定性は維持
- **F-2 の再確認** — 0.5.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去2版と同一）
- **capabilities の宣言** — 6ストリーム全てが6項目を宣言。
  `degraded_capabilities` は `EVIDENCE_CAPABILITY_NAMES` との積集合により
  `['source-region-text']` のままで、§8.3 完了条件2 も満たす

> **注意（0.4.0 以前の record を 0.5.0 build で読む場合）:** `instrument.capabilities` は
> optional であり、宣言を持たない record に対して `evidenceDisclosure()` は
> 「推測せず空リストを返す」設計である（`src/compare.ts`）。したがって 0.4.0 baseline を
> 0.5.0 build で読むと `degraded_capabilities` は `['source-region-text']` ではなく `[]` になる。
> 比較自体は `adapter_version` 差で `instrument-changed` に落ちるので実害はないが、
> **保存済み baseline の evidence 開示が新 build 下で変わる**点は把握しておくこと。

### 2026-07-31 — Phase 2（Playwright adapter）着地に伴う録り直し（0.5.0 → 0.6.0）と seam 分離性の機械判定

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.6.0`（npm 公開版。PR #56 = issue #55 マージ後の PR #57 release） |
| 変更 | Playwright adapter の追加（Phase 2、flaky マッピングを除く） |
| vitest composition | **無変更**（`VITEST_CAPABILITIES` 6項目のまま、`src/adapters/vitest/` 差分ゼロ、`EVIDENCE_CAPABILITY_NAMES` 不変） |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`、node v24.18.1（前回と同一） |
| 結果 | 全 run_id が変化。**差分は `adapter_version` の1パスのみ**で PASS |

**これまでの3回とは意味が違う録り直しである。** 0.3.0→0.4.0 と 0.4.0→0.5.0 は
「record 形状が変わったから録り直す」だったが、今回は **vitest 側が1バイトも変わっていないのに
`adapter_version` だけで comparability が切れた**ケース。`instrument.adapter_version` は
`VDELTA_VERSION` = package version そのものなので、`src/` に `feat` が入って release されれば
それだけで spec §6.2 の same-instrument rule が発火する。

`diff-preimages.mjs` で 0.5.0 preimage と構造 diff した結果、6/6 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.5.0"` → `"0.6.0"` |

**これ以外の差分はゼロ。** `instrument.capabilities` / `config_digest` / `surface` /
`provenance` / `environment` はすべて不変、`observations` は 6/6 とも配列丸ごと一致。

> **Playwright adapter を丸ごと追加しても vitest composition が一切摂動していない**ことの
> 実データによる証明である。adapter seam の設計目的（core から vitest 依存を切り、
> adapter 追加が既存 adapter に漏れない — 設計 §4.2）を、Phase 1 Step 1 の主基準だった
> in-repo A/B replay とは**別軸**で裏付ける。seam を入れた本来の狙いが効いていることを、
> 合成 fixture ではなく実リポジトリの 4256 observations で確認できた。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_f5362a51` が一致。決定性は維持
- **F-2 の再確認** — 0.6.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去3版と同一）
- **capabilities の宣言が不変** — 6項目のまま。`retry-evidence` は Playwright 側のみが宣言し
  vitest には追加しないという issue #53 意思決定(2) が、実 record で守られている
- **自己検証性** — 全8件について保存した gz から run_id を再計算して一致

### 2026-08-02 — flaky マッピング / §12-1 着地に伴う録り直し（0.6.0 → 0.7.0）

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.7.0`（npm 公開版。PR #61 = issue #60 マージ後の PR #62 release） |
| 変更 | flaky マッピング（D2）と §12-1 gate verdict の実装 |
| 変更ファイル | `src/compare.ts` / `src/gate.ts` / `src/render.ts` / `src/schema.ts`。**`src/adapters/vitest/` は差分ゼロ** |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`、node v24.18.1（前回と同一） |
| 結果 | 全 run_id が変化。**差分は `adapter_version` の1パスのみ**で PASS |

`diff-preimages.mjs` で 0.6.0 preimage と構造 diff した結果、6/6 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.6.0"` → `"0.7.0"` |

**これ以外の差分はゼロ。** `instrument.capabilities` / `config_digest` / `surface` /
`provenance` / `environment` はすべて不変、`observations` は 6/6 とも配列丸ごと一致。

> **flaky マッピングが比較側・gate 側に閉じており、記録側に一切漏れていない**ことの実データ確認。
> `src/compare.ts` / `src/gate.ts` / `src/render.ts` / `src/schema.ts` を触った変更が
> vitest の record 構築経路を摂動していない。**0.5.0 → 0.6.0（Playwright adapter 追加）が
> 「新しい adapter を足しても既存 adapter に漏れない」を示したのに対し、今回は
> 「comparator / gate を変えても記録が動かない」を示している** — seam の分離が
> adapter 軸だけでなく記録・比較の軸でも効いていることになる。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_d80f20de` が一致。決定性は維持
- **F-2 の再確認** — 0.7.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去4版と同一）
- **capabilities の宣言が不変** — 6項目のまま。flaky マッピングは
  `retry-evidence` を宣言する record（= Playwright）でのみ発火するため、
  vitest record では構造的に非発火（§12-3 立場B）
- **自己検証性** — 全8件について保存した gz から run_id を再計算して一致

### 2026-08-02 — F-5（selector-relation capability）着地に伴う録り直し（0.7.0 → 0.8.0）

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.8.0`（npm 公開版。PR #65 = issue #64 マージ後の PR #66 release） |
| 変更 | `selector-relation` capability と subset comparability（F-5、`previous-superset` を除く） |
| `VITEST_CAPABILITIES` | **6項目 → 7項目**（`selector-relation: 'pass'` を追加） |
| `composition_id` | **`vitest-native/2` のまま**（§4 判定表の列挙リストは不変） |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`、node v24.18.1（前回と同一） |
| 結果 | 全 run_id が変化。**差分は2パスのみ**で PASS |

**これまでの5回と違い、許容差分が2パス**である（`capabilities` が実際に変わるため）。
`diff-preimages.mjs` で 0.7.0 preimage と構造 diff した結果、6/6 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.7.0"` → `"0.8.0"` |
| `instrument.capabilities.selector-relation` | （なし）→ `"pass"` |

**これ以外の差分はゼロ。** `config_digest` / `surface` / `provenance` / `environment` は
すべて不変、`observations` は 6/6 とも配列丸ごと一致。

> **`selector-relation` が比較側の capability であり、記録側に一切漏れていない**ことの実データ確認。
> capability 宣言が1項目増えるだけで、記録される観測そのものは1バイトも動いていない。
> `composition_id` が `/2` のままなのも整合している — F-5 は `config_digest` の
> 列挙リスト（`docs/compositions/vitest-native-1.md` §4）を変えていないため。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_6375a281` が一致。決定性は維持
- **F-2 の再確認** — 0.8.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去5版と同一）
- **自己検証性** — 全8件について保存した gz から run_id を再計算して一致

> **`diff-preimages.mjs` の修正:** 許容パスの判定を**完全一致から prefix 一致に変えた**。
> diff は object 同士を再帰するため、既存 object にキーが増えると親ではなく子のパスで
> 報告される（`instrument.capabilities` ではなく
> `instrument.capabilities.selector-relation`）。今回まさにこれを踏み、
> 親を許容指定したのに FAIL になった。prefix 一致なら親の指定で配下を許容でき、
> 粒度を絞りたければ子パスまで書けばよい。

### 2026-08-03 — F-5-E（`previous-superset` / series key）着地に伴う録り直し（0.8.0 → 0.9.0）

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.9.0`（npm 公開版。PR #69 = issue #68 マージ後の PR #70 release） |
| 変更 | `previous-superset` baseline mode と `seriesKey`（F-5-E）。**いずれも比較側のみ** |
| `VITEST_CAPABILITIES` | **7項目のまま**（`selector-relation` を含む。追加削除なし） |
| `composition_id` | **`vitest-native/2` のまま** |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`、node v24.18.1（前回と同一） |
| 結果 | 全 run_id が変化。**差分は1パスのみ**で PASS |

**0.8.0 の録り直しが2パスだったのに対し、今回は1パスに戻った。**
`diff-preimages.mjs` を既定の許容パス（`instrument.adapter_version` のみ）で回した結果、6/6 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.8.0"` → `"0.9.0"` |

**これ以外の差分はゼロ。** `capabilities` / `config_digest` / `surface` / `provenance` /
`environment` はすべて不変、`observations` は 6/6 とも配列丸ごと一致
（457 / 1958 / 1540 / 76 / 195 / 30）。

> **1パスに収まったこと自体が受け入れ基準の機械判定である。** issue #68 は
> 「capability を変えていない」ことを受け入れ基準に挙げ、その検証手段として
> 「許容差分は `instrument.adapter_version` の1パスのみになるはず。2パス以上出たら
> capability を触ってしまっている」と事前に宣言していた。E は baseline **選択**の話であり、
> 記録される観測には触れない — それが実データで裏付けられた。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_b228cea1` が一致。決定性は維持。
  2回目が `baseline-missing` のままなのも過去6版と同じ（content addressing が完全重複を畳む）
- **F-2 の再確認** — 0.9.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去6版と同一）。
  superseded 2件も 0.8.0 との構造 diff で `instrument.adapter_version` の1パスのみの PASS
- **自己検証性** — 全8件について保存した gz から `sha256(canonicalJson(preimage))` を再計算して
  ファイル名と一致することを確認。あわせて**同じ手順を 0.8.0 の gz 6件にも適用して一致を確認**し、
  検証コード自体が正しいことを先に担保してから 0.9.0 を検証した

> **superseded を録り直すときの退避先は worktree の外に置くこと。** 今回まず
> `packages/shared/dist.vdelta-bak` へ退避して失敗した。`dist/` は `.gitignore` されているが
> `dist.vdelta-bak` は対象外なので、**未追跡ファイルとして tree に現れ**
> `provenance.tree_digest` が `f0ffc727…` → `d0a11915…`、`dirty_diff_digest` も動いて
> baseline と provenance が揃わなくなる（構造 diff が4件の XXX で FAIL して露見）。
> `/tmp` など repo 外へ退避し、記録前に `git status --short` が空であることを確認する。

### 2026-08-04 — `vdelta run` の加法的フォールバック着地と node bump に伴う録り直し（0.9.0 → 0.10.0）

| 項目 | 値 |
| --- | --- |
| 対象 | `vdelta@0.10.0`（npm 公開版。PR #75 = issue #72 マージ後の PR #76 release） |
| 変更 | `vdelta run` の baseline 解決に `previous-superset` の加法的フォールバック。**`src/run.ts` の呼び出し側のみ** |
| `VITEST_CAPABILITIES` | **7項目のまま**（追加削除なし） |
| `composition_id` | **`vitest-native/2` のまま** |
| subject | pin SHA `8cf90518`、`tree_digest` `f0ffc727…`（前回と同一） |
| **node** | **v24.18.1 → v24.19.0（記録機の mise が `lts` を更新）** |
| 結果 | 全 run_id が変化。**差分は2パス**で PASS |

**これまでと違い、vdelta 以外の変数（node）が同時に動いた回である。**
`diff-preimages.mjs` に許容パスを2つ明示指定して回した結果、baseline 6/6・superseded 2/2 とも:

| 差分パス | 内容 |
| --- | --- |
| `instrument.adapter_version` | `"0.9.0"` → `"0.10.0"` |
| `environment.runtime` | `"node v24.18.1"` → `"node v24.19.0"` |

**これ以外の差分はゼロ。** `capabilities` / `config_digest` / `surface` / `provenance` は
すべて不変、`observations` は 8/8 とも配列丸ごと一致（457 / 1958 / 1540 / 76 / 195 / 30、
superseded 528 / 536）。

> **`instrument.capabilities` が3つ目のパスとして出ていないことが、判定の要点である。**
> node bump によって許容パスが2つに増えたが、capability を触っていれば
> `instrument.capabilities.*` が**3つ目**として必ず現れる。したがって
> 「2パスで PASS」は「1パスで PASS」と同じ強さで capability 不変を主張できる。
> node bump は許容パスとして**明示指定したうえでの** PASS であり、暗黙に見逃してはいない。

**node を v24.18.1 に固定し直す選択は取らなかった。** node は今後も上がり続けるため、
古い node を抱え続ける方が不自然であり、上記のとおり判定の鋭さは失われないため。
`manifest.json` の `preconditions.node_version` を `v24.19.0` に更新した。

確認したこと:

- **コントロール証明** — `packages/shared` を2回記録し `run_01d22ca9` が一致。決定性は維持。
  store 上 `packages/shared` の complete な 0.10.0 run が**1件しか存在しない**ことが、
  2回の記録が同一 run_id に畳まれた（= 一致した）ことの機械的な確認になっている
- **F-2 の再確認** — 0.10.0 でも `shared/dist` 退避時に `completeness.module_errors` が
  backend 84件 / frontend 43件を列挙（観測数 528 / 536 も過去7版と同一）。
  退避先を `/tmp`（repo 外）にしたので `provenance.tree_digest` は baseline と同じ `f0ffc727…`
- **自己検証性** — 全8件について保存した gz から `sha256(canonicalJson(preimage))` を再計算して
  ファイル名と一致することを確認。あわせて**同じ手順を 0.9.0 の gz 8件にも適用して一致を確認**し、
  検証コード自体が正しいことを先に担保してから 0.10.0 を検証した
