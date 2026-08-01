# shift-bud Phase 0b-field — flaky base rate 実測と Kill-1 判定

`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` §6 の **Phase 0b-field**、
および §7 の **Kill-1 kill criterion** の実行記録。

> **結論: Kill-1 非発火。D2 を維持する。**
> 10 run すべてで flaky 0 件、`veridelta/2` への分岐は回避された。
> 詳細は「判定結果」節。

## 位置づけ

Phase 0b-field は **Phase 2 のゲートではない**（設計 doc §6「Phase 2 のゲートは 0b-core のみ」）。
本 probe が担うのは §7 kill criterion の **Kill-1**（flaky が稀ではなく常態か）の実データ判定であり、
0b-core（issue #53 / PR #54）が確定した判定手順を実際に走らせたものである。

Kill-1 の `N = 10` および集計規則は **0b-core が着手前に事前登録済み**
（`probes/playwright-0b-core/README.md`「事前登録」節）。本 probe はそれを**変更していない**。

## 前提として先に潰した経路

設計 doc §6 の degraded path は「0b-field が不能なら CI 実行データで代替、それも不能なら
D2 provisional のまま繰り延べ」と定める。**CI 代替は不能であることを実測で確定させた**:

| 条件 | 実測 |
| --- | --- |
| 等価な N = **同一 commit に対する `retries: 2` の CI 実行 10 run**（0b-core が確定） | 同一 commit の CI run は**最大 2 回**。10 に届かない |
| e2e ジョブの実行頻度 | `if: contains(github.event.pull_request.labels.*.name, 'full-ci')` の opt-in。`full-ci` ラベル付き PR は**歴代 5 件のみ**（#829〜#840、すべて 2025-12） |
| flaky データの所在 | `playwright-report` artifact（保持 7 日）。残存 11 件は**全て `expired=true`**、最新でも 2025-12-22 |

同一 commit 10 run という条件以前に、**e2e が CI で 7 ヶ月動いておらずデータ自体が存在しない**。
したがって 0b-field 本体（ローカル N=10 実行）を実施した。

## 実行条件

`scripts/e2e-local.sh`（shift-bud repo）の環境準備を踏襲し、テスト実行を N 回ループに差し替えた
（`measure.sh`）。実行環境:

| 項目 | 値 |
| --- | --- |
| subject | `playpark-llc/shift-bud` `e506d2db`（同一 tree で 10 run 連続） |
| `@playwright/test` | **1.57.0**（実測。0b-core の合成プロジェクトは 1.49.1 pin なので**別バージョン**） |
| retries | **2**（3 project すべてで解決済みを観測 JSON で確認） |
| workers | **1** |
| DB | Docker `postgres:17.7`、隔離用に別プロジェクト・別ポート（5433 / `shiftplanner_test`） |
| `DEV_TENANT_SLUG` | `cafe-standard` |
| run 間 | `db:seed` で reseed（seed は `deleteMany` → `upsert` の冪等実装） |

### 事前登録した実行パラメータ（計測前に固定）

- **`--retries=2 --workers=1` を CLI フラグで渡す。`CI=1` は使わない。**
  `playwright.config.ts` が `webServer: process.env.CI ? undefined : [...]` として
  CI 環境ではサーバ自動起動を無効化する（CI は workflow 側で手動起動するため）。
  `CI=1` を立てるとサーバが立たず suite が丸ごと落ちる。
  `--workers=1` は CI の `workers: process.env.CI ? 1 : undefined` に揃えた
  — Kill-1 の判定先である gate の消費者は CI であり、並行度が変われば資源競合経由の
  flaky 率も変わるため。
- **flaky の定義**: Playwright の `status === 'flaky'` をそのまま採用する。
  spec §7.7 が「flaky-class label is permitted **only from the runner's own retry verdict**」
  と定めるため、こちらで推定しない。
- **分母**: 各 run で実際に実行された test case 数を都度再計測する（project 展開後）。

### 試走（A-3）で棄却した前提

当初「テナント系 8 件がローカルで構造的に赤（#1086 × `DEV_TENANT_SLUG`）なので、恒常赤を
flaky と混同しないよう事前登録が要る」と想定して 1 run の試走を先に行った。
**実測ではこの 8 件は赤ではなく、168 件すべてが pass した。**
`scripts/e2e-local.sh` が `DEV_TENANT_SLUG=cafe-standard` を設定するようになった時点で
解消していたものと見られる。したがって恒常赤の分離集計は**不要**と確定し、
本計測は 168 件すべてを分母に含めたまま実施した。

## 判定結果

| run | executed | flaky | failed | retried | setup red |
| --- | --- | --- | --- | --- | --- |
| 1〜10（全 run 同一） | **168** | **0** | **0** | **0** | no |

| 項目 | 値 |
| --- | --- |
| 有効 run | **10 / 10**（`setup` red による無効 run ゼロ） |
| `f_i` | `[0,0,0,0,0,0,0,0,0,0]` / median = **0** |
| `\|F\|`（累積 distinct flaky） | **0** |
| 実行 test case 数 median | **168** |

| 発火条件（設計 doc §7） | 判定 |
| --- | --- |
| `median(f_i) >= 2` | **no**（0） |
| `\|F\| / 実行数 >= 5%` | **no**（0.00%） |
| すべての有効 run で `f_i / 実行数 > 1%` | **no** |

**3 条件すべて非発火 → D2 を維持する。**

補強材料として、**`retried_count` が全 run で 0**（`observations/kill1-runs.json`）。
retry が一度も発動していないので、flaky 0 は「retry して通った」のではなく
「そもそも 1 回で通った」ことを意味する。実行数も 10 run すべて 168 で完全に一定だった。

## この結果が示さないこと

- ❌ **D2 マッピングの実データ検証にはならない。** flaky 率 0 は「D2 が安全」を意味するが、
  同時に **実 suite からは `fail → retry → pass` の実例が 1 件も取れなかった**ということでもある。
  D2 が正しく動くことの根拠は引き続き **0b-core-3 の合成観測**
  （`probes/playwright-0b-core/observations/flaky.json`）が担う。
  0b-core が合成プロジェクトで flaky を人工的に起こした理由がまさにこれである。
- ❌ **CI の flaky 率がこれと同じ保証はない。** 本測定はローカル・単一マシン・同一時刻帯のもの。
  GitHub Actions の共有ランナーは資源競合が異なる。設計が求めた「同一 tree で N 回連続実行」は
  満たしているが、環境差は残る限界である。
- ❌ **§12-1 は決まらない。** §12-1（`fail → flaky` のみのときの gate verdict）の解決条件は
  「0b-field の base rate 実測」**と**「gate report の消費者要件」の 2 つであり、
  本 probe が満たすのは前者のみ。設計 doc が明記するとおり、
  **これが決まるまで Phase 2 の flaky fixture は書けない。**

## 内容

| ファイル | 中身 |
| --- | --- |
| `measure.sh` | 計測スクリプト。Docker DB 起動 → shared build → migrate/seed → N 回ループ |
| `analyze.mjs` | Kill-1 集計。分母・無効 run 規則・発火条件 3 つを設計 doc §7 のまま実装 |
| `observations/kill1-runs.json` | 10 run の抽出済み観測 |

生の Playwright JSON reporter 出力（248KB × 10 = 約 2.5MB）は保存していない。
大半が判定に無関係な duration / stdout であり、CE-2 が evidence digest から揮発値を除くのと
同じ発想で、**判定に効く構造だけ**を `observations/kill1-runs.json` に落としてある
（executed / flaky / failed / retried / setup_red / 解決済み retries / workers / playwright version）。

## 再現手順

```bash
# 新規に計測する（shift-bud repo が必要。Docker が要る）
bash probes/shift-bud-0b-field/measure.sh 10
node probes/shift-bud-0b-field/analyze.mjs "$TMPDIR/kill1-runs"

# 保存済み観測から判定だけ再現する（shift-bud も Docker も不要）
node probes/shift-bud-0b-field/analyze.mjs probes/shift-bud-0b-field/observations/kill1-runs.json
```

`analyze.mjs` が両方を入力に取れるのは、生 JSON が `$TMPDIR` にしか無く消えるため。
保存した記録だけで判定を再現できないと probe が自己完結しない。

> **注意:** `measure.sh` は shift-bud の `packages/backend/.env` を一時退避する
> （Prisma が読み込むのを防ぐため）。異常終了時は `.env.kill1-backup` が残るので、
> `.env` に戻すこと。trap で復元するが、SIGKILL では走らない。

## 次に必要なこと

Kill-1 は非発火で確定したが、**flaky マッピングの実装前に §12-1（gate verdict）の決着が要る**。
残る解決条件は「gate report の消費者要件」— `fail → flaky` のみのときに gate をブロックさせるか
を、実際の消費者（PR コメント / required check）の観点から決める設計判断である。

なお `outcome_verdict` = `inconclusive`（`unchanged` 禁止）は**合意済み**。未決は gate 側のみ。
