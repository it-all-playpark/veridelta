# shift-bud Phase 0a baseline

`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` の **Phase 0a** 実行結果。
§8.3 副基準2（shift-bud live 再記録）と副基準1（capture replay）の基準値として保存する。

shift-bud 側の `.veridelta` store は gitignore され auto-GC もかかる（`src/run.ts` の
retention policy）ため、根拠 record が Phase 0a から Step 1 の間に蒸発しうる。
それを避けるためここに置く（§8.3 baseline manifest 仕様）。

## 内容

| ファイル | 中身 |
| --- | --- |
| `manifest.json` | 前提条件・コントロール証明・6ストリームのサマリ・superseded 2件 |
| `runs/<run_id>.json.gz` | 各 run の **run_id preimage**（record から `recording` グループを除いたもの）。gzip 済み |

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
| backend | `run_e12cdb84` | 1958 | complete |
| frontend | `run_b27b0c76` | 1540 | complete |
| shared | `run_13d242f9` | 457 | complete |
| landing | `run_30101781` | 76 | complete |
| video | `run_5a3064bb` | 195 | complete |
| e2e | `run_0e840fe8` | 30 | complete |

計 **4256 observations**、全ストリームで `report != null`（passthrough に落ちない）。
Phase 0a の受け入れ基準1 を満たす。

`superseded` の2件（`run_07df741d` / `run_b24e6af4`）は baseline ではない。
下記 F-2 の証拠として保存している。

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
cd packages/<pkg> && vdelta run -- npx vitest run <selector>
```

`selector` は `manifest.json` の `streams[].invocation` を参照（backend のみ `src`、
e2e は `screenshots/recording/__tests__`、他は空）。

### 比較前に検証する前提条件

`manifest.json` の `preconditions` と突き合わせる。**いずれかが異なれば run_id は正当に変わる**：

- subject の commit SHA（`8cf90518`）と `provenance.tree_digest`（`f0ffc727…`）
- 記録に使う worktree の**絶対パス**（`repo.identity` / `repo.worktree` に入り run_id に効く）
- vdelta の version（`instrument.adapter_version`。spec §6.2 により instrument 変更は comparability を切る）
- node version / vitest version
- `CI` / `NODE_ENV` / `TZ` / `LANG`（`environment.env_fingerprint` に入る）

### コントロール証明

同一 vdelta・同一 tree で `packages/shared` を2回記録し `run_13d242f9` が一致することを確認済み。
2回目が `baseline-missing` のままなのは content addressing が完全重複を畳んだ結果であり、
spec §3.5 の設計どおりの挙動。

**副基準2 を回す前に、必ずこのコントロールを先に取ること**（§8.3）。
これを飛ばすと、不一致が「refactor による挙動変化」なのか「そもそも決定的でない」なのか
切り分けられない。

## Phase 0a で得られた所見

| # | 所見 | 起票 |
| --- | --- | --- |
| F-1 | `instrument.config_digest` が `include_task_location` / `truncate_threshold` の2値のみで、`environment` / `pool` / `retry` 等の evidence-affecting な解決済み設定を covering していない（設計 §4.1.1） | issue |
| F-2 | module load 失敗時、当該ファイルのテストが `observations` から丸ごと消えるが `coverage=N/N` は 100% を示す。`module_errors` の詳細は record に載らず `recording.raw_stdout` の非構造テキストにしか残らない | issue |
| F-3 | text renderer が `completeness.status` を出力しない。JSON report（primary interface）は `complete: false` を持つので spec §9.1 は満たしている | issue |
| — | （正常挙動）`compare.ts` の baseline 選択が `completeness.status !== 'complete'` を除外している。INV-4 に沿う | — |
| — | （正常挙動）near-miss disclosure（spec §5.4）が6ストリーム間で `repo.cwd` / `invocation.selector` の差分を正しく開示 | — |

## この baseline が検証できること / できないこと

設計 §6 は Phase 0a を「Phase 1 のゲート」と位置づけ、§8.3 副基準2 を
「Phase 0a で記録した run_id 群と、**Step 1 完了後**に同じ tree T で記録した run_id 群が一致すること」
と定義している。しかし実際には **Phase 1 Step 1（seam 抽出、PR #36 / `ac3442b`）が Phase 0a より先に
着地しており、本 baseline は Step 1 適用後のバイナリ（0.3.0）で記録されている**。

したがって:

- ❌ **Step 1 の挙動凍結検証には使えない。** 事前・事後の関係が成立していない。
  Step 1 の主基準は in-repo A/B replay（`tests/conformance/ab-replay.test.ts`）が担う。
  実データで Step 1 の A/B を取りたい場合は、seam 抽出前の `b001196` をビルドして
  本 baseline と同一条件で記録すれば retroactive に得られる。
- ✅ **前向きの回帰基準として使える。** record 形状を変えないはずの変更が
  これらの run_id を再現できなければ、それは意図しない挙動変化である。
- ✅ **§8.3 副基準1（capture replay）の入力**として使える。
- ✅ **実データの証拠コーパス**として使える（issue #38 / #39 / #40 の根拠）。

なお record 形状を変える変更（`adapter_version` bump を伴うもの、設計 §8.2 Step 2）は
spec §6.2 により本 baseline との comparability を**意図的に**切る。その場合は
Step 2 着地後に baseline を録り直すこと。

## 既知の限界

- **絶対パス依存** — `repo.identity` / `repo.worktree` が絶対パスで run_id に入るため、
  別マシン・別パスでは run_id が一致しない。副基準2 は同一マシン・同一パス前提。
- **vdelta 0.3.0 の出所** — 記録時は release-please PR #37 branch `f754f2e` のローカル build（publish 前）。
  その後 PR #37 が main へマージされ `v0.3.0` が公開された。
  `git diff ac3442b 3eff367 -- src/ tests/` が空であることを確認済みで、
  **公開 0.3.0 のコードは記録に使った成果物と同一**。本 baseline は公開 0.3.0 に対してそのまま有効。
