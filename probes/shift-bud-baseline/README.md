# shift-bud Phase 0a baseline

`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` の **Phase 0a** 実行結果。
§8.3 副基準2（shift-bud live 再記録）と副基準1（capture replay）の基準値として保存する。

shift-bud 側の `.veridelta` store は gitignore され auto-GC もかかる（`src/run.ts` の
retention policy）ため、根拠 record が蒸発しうる。それを避けるためここに置く
（§8.3 baseline manifest 仕様）。

> **現行 baseline は vdelta 0.5.0 / `vitest-native/2`。**
> 初版は 0.3.0 / `vitest-native/1`、2版は 0.4.0 / `/2` だった。
> record 形状を変える変更が入るたびに spec §6.2 の same-instrument rule で
> comparability が切れるため、2026-07-30 に2回録り直している
> （0.3.0 → 0.4.0: issue #39 / PR #46、0.4.0 → 0.5.0: issue #49 / PR #50）。
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
| backend | `run_b719cc15` | 1958 | complete |
| frontend | `run_c138e4b0` | 1540 | complete |
| shared | `run_132d59a1` | 457 | complete |
| landing | `run_5e62bd6c` | 76 | complete |
| video | `run_29f716db` | 195 | complete |
| e2e | `run_66400da0` | 30 | complete |

計 **4256 observations**、全ストリームで `report != null`（passthrough に落ちない）。
Phase 0a の受け入れ基準1 を満たす。
**観測数は 6/6 とも 0.3.0 / 0.4.0 baseline と同一** — Step 2 の2段階はいずれも record 形状を
変えたが、検証面は1件も動いていない。

全ストリームが `instrument.capabilities` を6項目宣言している
（`verdicts` / `source-location` / `suppression` / `inventory` / `failure-evidence` が `pass`、
`source-region-text` が `unsupported`）。0.4.0 以前の record はこのフィールドを持たない。

`superseded` の2件（`run_a5abf83d` / `run_3e87582b`）は baseline ではない。
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
cd packages/<pkg> && npx -y vdelta@0.5.0 run -- npx vitest run <selector>
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
- node version（現 baseline は **v24.18.1**）/ vitest version（`4.1.10`）
- `CI` / `NODE_ENV` / `TZ` / `LANG`（`environment.env_fingerprint` に入る）

### コントロール証明

同一 vdelta・同一 tree で `packages/shared` を2回記録し `run_132d59a1` が一致することを確認済み。
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
現行 baseline は Step 2 適用後（0.4.0）である。

したがって:

- ❌ **Step 1 の挙動凍結検証には使えない。** 事前・事後の関係が成立していない
  （Step 1 は Phase 0a より先に着地した）。主基準は in-repo A/B replay
  （`tests/conformance/ab-replay.test.ts`）が担う。
- ✅ **Step 2（capabilities 載せ替え）の完了条件3 の判定には実際に使えた。**
  0.4.0 の preimage を保存していたため、0.5.0 との構造 diff で
  「差分が capabilities group と adapter_version のみ」を機械判定できた
  （2026-07-30 の検証ログ）。
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
