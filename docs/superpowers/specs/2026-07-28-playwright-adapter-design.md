# adapter seam 抽出 + Playwright adapter Design

**Status:** proposed
**Date:** 2026-07-28
**Scope:** vdelta 0.2.2 → 2番目の adapter（Playwright）を載せられる状態にする
**Related:** spec `veridelta/1` §3.4, §3.5, §3.6, §4.2, §6.2, §7.7, §12, §14

> 本文中の `spec §N` は `spec/veridelta-1.md` の節、`§N` は本設計の節を指す。

---

## 1. Goal

2つの目的を同時に満たす:

1. **dogfood 密度** — 自前で維持している suite で vdelta を実際に効かせる。
2. **adapter seam の検証** — 「vitest 以外を*ちゃんと*載せられるか」に実測で答える。現状これは未検証であり、後述の通り seam はそもそも存在しない。

spec §12 は Playwright を2番目の adapter として明示的に指名している（rev 0.3.1）。根拠は e2e 固有の adapter 縁（retries / project 間の同一タイトル重複 / worker 並列）である。本設計はその順位を採用し、コミットの前提条件である spec §3.6 probe を Phase 0b として明示的にスケジュールする。

**dogfood subject:** `playpark-llc/shift-bud`（pnpm モノレポ）

| 対象 | 規模 | runner |
| --- | --- | --- |
| backend / frontend / shared / landing / video | 255 test files | vitest `^4.1.10`（全パッケージ統一） |
| e2e | 53 spec | `@playwright/test` `^1.49.1` |

---

## 2. 決定サマリ

| ID | 決定 |
| --- | --- |
| **D1** | 順序は **probe → seam 抽出（挙動凍結）→ Playwright adapter**。copy-adapt 先行および experimental フラグ先行は却下（§5）。 |
| **D2** | `flaky` は **`/1` を閉じたまま**扱う。`fail → flaky` は `verification_inconclusive`、flaky 自体の verdict は `pass`、retry 各 attempt の failure evidence は annex + capability 宣言で開示。**反証可能な default** とし kill criterion を事前登録する（§7）。 |
| **D3** | Phase 1 は「純粋な構造移動」を先に完了させ、**run_id 一致**で挙動凍結を証明する。record 形状が変わる変更は `adapter_version` bump を伴う別ステップに切る（§8）。 |
| **D4** | dogfood のインストールは **ローカル link**（registry pin ではない）。CI gate 組み込みと shift-bud への devDependency コミットは**スコープ外**。 |
| **D5** | adapter 検出は **明示指定優先**（`--adapter <name>`）、argv 走査は補助。未検出は raw passthrough（INV-5 維持）。wrapper コマンド対応（ambient recording）はスコープ外・follow-up 化。 |

---

## 3. 調査結果（本設計の根拠）

### 3.1. adapter seam は存在しない

| 場所 | vitest 癒着の内容 |
| --- | --- |
| `src/run.ts:53-58` | `reporterModulePath()` が `adapters/vitest/reporter.js` を固定で返す |
| `src/run.ts:62-70` | `findVitestToken()` — argv から vitest バイナリを走査 |
| `src/run.ts:73-101` | **vitest 4.x 専用**の「値を別 argv で取るフラグ」表。selector 分離に使う。#15 で「vitest 自身の CLI 面と同期する自動機構は存在しない」と明記済み |
| `src/run.ts:213-222` | `--reporter=default --reporter=<path> --includeTaskLocation` を argv 末尾に注入 |
| `src/run.ts:15,19` | `Capture` 型と `buildRunRecord` / `DEGRADED_CAPABILITIES` を `adapters/vitest/*` から直接 import |
| `src/compare.ts:9`, `src/gate.ts:11`, `src/index.ts:12` | **汎用の比較器 / gate / 公開 API が `DEGRADED_CAPABILITIES` を `adapters/vitest/recorder.js` から静的 import** |
| `src/adapters/vitest/capture.ts` | `runner: 'vitest'` リテラル、`state` / `mode` / `fails`（`test.fails`）、`config: { include_task_location, truncate_threshold }` が vitest 語彙 |

最後の2つが本質的な問題。spec §3.4 は「capability の欠落は *unknown* であって *unchanged* ではない」と規定するが、比較器が特定 adapter の能力定数を静的に参照している限り、adapter が2つになった時点でこの規定は成立しない。**能力は run record が宣言するもの**に変える必要がある。

### 3.2. `flaky` は実装に存在しない

- `src/schema.ts:10-18` `VERDICTS` = `pass | fail | error | skip | xfail | xpass | not_run`
- `src/schema.ts:115-127` `TRANSITION_KEYS` = 11個、flaky 系ゼロ
- `flaky` / `retry` は `src/schema.ts` / `src/compare.ts` に**1件も出現しない**

一方 spec §7.7 は「runner 自身の retry verdict からなら flaky ラベルを許す」と規定し、Playwright の `TestCase.outcome()` は `expected | unexpected | flaky | skipped` で **flaky が一級の観測値**である。そして spec §14 は `/1` の enum を閉じた契約と定める（値追加には新 schema version が必要）。

つまり **Playwright の最も特徴的な観測値に `/1` 内の置き場がない**。これは vitest だけでは露出しなかった発見であり、「protocol は runner 中立か」への最初の実測回答である。

### 3.3. shift-bud の e2e config が adapter 縁を強く踏む

`packages/e2e/playwright.config.ts` 実測:

```ts
projects: [
  { name: 'setup',      testMatch: /.*\.setup\.ts/ },
  { name: 'auth-tests', testMatch: /(auth|session)\.spec\.ts/,  dependencies: ['setup'] },
  { name: 'chromium',   testIgnore: /(auth|session)\.spec\.ts/, dependencies: ['setup'] },
]
retries: process.env.CI ? 2 : 0
workers: process.env.CI ? 1 : undefined
forbidOnly: !!process.env.CI
fullyParallel: true
timeout: 30000, expect: { timeout: 5000 }
use: { trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure' }
```

導かれる要件:

1. **依存 skip カスケード（vitest に存在しない縁）** — `setup` が落ちると依存 project のテストは *skipped* で報告される。素直に写すと `fail_to_skip` + `surface: reduced` を出し、setup 破損ごとに狼少年になる。INV-9（surface 縮小による red 消失を repaired と呼ばない）を守りつつ、**これは surface 縮小ではない**と言い分ける必要がある。
2. **test ID に project を含める必須性** — 同一タイトルが project 間で重複しうる。
3. **resolved-vs-file config digest** — config **ファイル**の digest は local↔CI で同一だが、**解決後**の instrument は別物（`retries: 0` では flaky が観測不能）。vitest adapter は config *ファイル*を digest しているため、この方針をそのまま持ち込むと spec §6.2（same-instrument rule）が嘘になる。
   - 現状の緩和材料: `src/adapters/vitest/recorder.ts:32` `DECLARED_ENV_VARS` に `CI` が含まれ `env_fingerprint` に入る。ただし `env_fingerprint` は `STREAM_KEY_FIELDS`（`src/schema.ts:45-55`）に**含まれない**ため開示のみで stream 分離はしない。
4. **spec §7.8 順序正規化** — `fullyParallel: true`。
5. **annex / `context_digest`** — trace / screenshot / video の attachment。
6. **CE-2 全フィールド除外** — locator / timeout のエラーメッセージは retry ログ（`waiting for locator... 9 × locator resolved to ...`）を含み揮発する。

好材料: Playwright は `error.location` を提供するため spec §3.6 option (b)（recorded tree からの決定的再構成）が使え、**vitest が唯一 degraded にしている `source-region-text`（`src/adapters/vitest/recorder.ts:30`）を Playwright は満たせる可能性がある**。capability 宣言設計が正しく機能する証拠になる。

### 3.4. shift-bud のテスト入口に runner トークンがない

```
root     test:         pnpm -r --filter '!@shift-bud/e2e' test
root     backend:test: pnpm --filter @shift-bud/backend test
backend  test:         vitest run src        ← runner トークンはここだけ
e2e      test:         playwright test
```

`src/run.ts:213` の `findVitestToken()` は argv を走査する。`pnpm` しか無い → reporter 注入なし → `readFileSync(captureFile)` が throw → `degraded raw passthrough`（"is the child a vitest invocation?"）。INV-5 通り fail-safe だが、**チームが実際に打つコマンドからは dogfood シグナルがゼロ**になる。

これは単なる検出の話ではない。**spec §4.2 は recording を "ambient-first" と規定し、`vdelta run --` は「1つの recorder 実装にすぎない」と明記している**（根拠: wrapper-only 設計は agent の規律に依存し、1回の wrap 忘れで stream が切れる）。つまり shift-bud の wrapper 問題は、CLI-wrapper-only の現実装が spec §4.2 に追いついていない証拠であり、shift-bud はそれが実際に痛む repo である。

ただし ambient recording の実装は独立した規模の作業であり、本設計のスコープ外とする（D5、§10 F-1）。

**付随ハザード（現時点では発火しない）:** `VDELTA_CAPTURE_FILE` は単一パス（`src/run.ts:170`）。`pnpm -r` が6 runner プロセスを fan-out した場合、注入が届いていれば last-writer-wins で静かに1個だけ記録される。現状は argv にトークンが無く注入されないため発火しないが、ambient recording を実装する際は capture チャネルを per-process 化する必要がある（§10 F-2）。

**副産物:** backend は `test: vitest run src`（selector = `src`）と `test:all: vitest run`（selector なし）を持ち、**実データの subset 関係**が repo 内に存在する。spec §5.2 `previous-superset` / spec §6.1 `subset` を実データで踏める。

### 3.5. run_id が挙動凍結の機械的証明になる

spec §3.5:

> `run_id` は Run record の canonical serialization（**`recording` グループを除外**）の SHA-256。`recording` を除外しているため、同じ物理 run を同一に観測した2つの recorder は同じ `run_id` を生成する。

したがって Phase 1 の受け入れ基準が1行に落ちる（§8.3）。

---

## 4. Architecture: adapter seam（Phase 1 の到達点）

### 4.1. `Adapter` descriptor

adapter を1つのオブジェクトに閉じ、core（`run` / `compare` / `gate`）は名前で解決した descriptor 越しにしか adapter を触らない。

```
interface Adapter {
  readonly name: string                       // 'vitest' | 'playwright'
  readonly compositionId: string              // spec §3.6 versioned composition
  readonly declaredCapabilities: CapabilityDeclaration   // spec §3.4（pass/fail/unsupported 三値）
  readonly declaredEnvVars: readonly string[]            // env_fingerprint の入力

  /** argv がこの adapter のものか。null = 自分ではない（判断せず譲る） */
  detect(argv: readonly string[]): DetectResult | null

  /** reporter 注入済み argv と capture チャネル設定 */
  instrument(argv: readonly string[], captureFile: string): InstrumentedChild

  /** spec §6.4 inclusion intent の抽出。runner ごとの CLI 面に閉じる */
  splitCommandSelector(argv: readonly string[]): { command: string[]; selector: string[] }

  /** capture → Run record。canonicalization / redaction / digest を含む */
  buildRunRecord(capture: unknown, ctx: RecordContext): RunRecord
}
```

各ユニットの依存が単一方向であることを保つ:

- `detect` / `instrument` / `splitCommandSelector` は **argv のみ**に依存（runner の CLI 面の知識）。
- `buildRunRecord` は **capture + RecordContext のみ**に依存（runner の構造化チャネルの知識）。
- core は `Adapter` interface のみに依存し、`adapters/*` を直接 import しない。

### 4.2. core 側の変更

| 現状 | 変更後 |
| --- | --- |
| `src/compare.ts:9` / `src/gate.ts:11` / `src/index.ts:12` が `DEGRADED_CAPABILITIES` を静的 import | **run record が宣言した capability を読む**。spec §3.4 の「欠落 = unknown」が2 adapter でも成立する |
| `src/run.ts` が vitest 固定 | adapter registry から解決。未検出は raw passthrough（INV-5） |
| `src/run.ts:73-101` の vitest 4.x フラグ表 | `adapters/vitest/` 内に移動（他 adapter に漏れない） |

### 4.3. adapter 検出（D5）

**明示指定を第一とする:**

```
vdelta run --adapter playwright -- npx playwright test
vdelta run -- npx vitest run src            # argv 走査で vitest と判定（補助経路）
```

- argv 走査は**利便のための補助**であり、契約ではない。
- 複数 adapter が detect した / どれも detect しなかった → **raw passthrough + `--adapter` を案内する diagnostic**（fail-closed、INV-5 維持）。
- wrapper コマンド（`pnpm test`）は `--adapter` を付けても reporter を argv 注入できない。Phase 0a では「runner を直接呼ぶ」で回避し、恒久解は ambient recording（スコープ外、§10 F-1）。

---

## 5. 却下した順序案

| 案 | 却下理由 |
| --- | --- |
| **B. Playwright を copy-adapt で先に通し、後から seam 抽出** | **copy-adapt だけでは動かない。** reporter パス固定（`src/run.ts:53`）・`findVitestToken`（`src/run.ts:62`）・`DEGRADED_CAPABILITIES` 静的 import（3ファイル）は Playwright を dispatch する前に generalize が必要。結果「時間圧下の半端な seam」になる。実装2本から抽象を取る利点は認めるが、その利点は Phase 0b probe の実測出力で代替できる。 |
| **C. experimental フラグ配下に最小 dispatch で先行出荷** | 本設計の目的（vitest 以外を*ちゃんと*載せられるかの検証）そのものを捨てる。 |

---

## 6. Phase 構成

```
Phase 0a ─┐
          ├─→ Phase 1 ─→ Phase 2
Phase 0b ─┘
```

Phase 0a と 0b は独立（並行可）。Phase 1 のゲートは 0a、Phase 2 のゲートは 0b。

### Phase 0a: shift-bud への vitest 版 vdelta 導入（Phase 1 のゲート）

**目的:** conformance 46 fixture では代替できない回帰網を作り、seam 設計前に実バグを出す。

conformance suite は合成 fixture であり、実装と同じ著者が「期待する挙動」を符号化したもの。実データは別経路を踏む。そして shift-bud は**直近のバグ修正が出てきた地形そのもの**である:

- `8276e3b fix(recorder): worktree外の実効config_sourcesをexternal接頭辞で記録`
- `2b18572 fix(conformance): fixtureワークスペースを祖先のvitest設定汚染から隔離`
- `26157cd fix(windows): normalize backslash paths in recorder key and lock error`

shift-bud は pnpm モノレポでパッケージごとに vitest config が6つ。祖先 config 汚染・worktree 外 config 解決の本場である。

**やること:**

- 6パッケージを `cd packages/<X> && vdelta run -- npx vitest run <selector>` で記録（**6ストリーム**。1 run = 1 instrument invocation）
- 緑赤の実態把握、`surface.config_sources` の実挙動確認
- **run_id ベースラインの取得**（Phase 1 の受け入れ基準の基準値）
- spec §3.4 の capability 宣言が実際に何を運ぶ必要があるかを、6つの実 record（jsdom / node 環境差、prismock 等）から確認
- 本設計 §3.4 の経験的確認（`pnpm test` が本当に passthrough に落ちるか）

**やらないこと（D4）:** CI gate 組み込み / shift-bud への devDependency コミット。インストールはローカル link（Phase 1 で実装が動くため）。

**摩擦の小ささ:** store は `<worktree>/.veridelta`（`src/store.ts:293`）で、`src/store.ts:320` が store 内に自前の `.gitignore` を書く。**shift-bud 側の `.gitignore` 変更は不要。**

**受け入れ基準:**

- 6パッケージすべてで `report != null`（passthrough に落ちない）
- 全 run_id を記録した baseline ファイルが存在する
- 発見された不具合が issue 化されている（修正は Phase 1 と分離）

### Phase 0b: Playwright の spec §3.6 probe（Phase 2 のゲート）

spec §12 は Playwright へのコミットを「structured reporter チャネルが spec §3.6 を満たすことの実測確認」に条件付けている。

**probe 設計要件（仮説先行 / §7 の kill criterion に対応）:**

1. **CE-1〜CE-5 の充足確認** — exception type / asserted values を保った message / failing source region / traceback 構造。`error.location` からの tree 再構成が spec §3.6 option (b) を満たすか。
2. **rerun 安定性（CE-2）と line-shift 安定性（CE-3）** — 同一 tree での再実行、無関係な編集、行ズレで core digest が不変か。
3. **`retries: 2` を明示指定した flaky テスト1本** — `fail → retry → pass` を D2 のマップ（`pass` + `verification_inconclusive`）に落として失う情報がないか。
   **重要:** shift-bud は `retries: CI ? 2 : 0` なので**ローカルの probe では flaky が一度も観測されない**。仮説を持たずに実物 config へ当てると、CE-1〜5 は答えが出るのに flaky は出現せず「問題なし」と誤結論する経路が実在する。probe は retries を明示指定しなければならない。
4. **flaky base rate の測定** — 実物 53 spec を `retries: 2` 強制で回し、flaky outcome を出す spec の割合を測る（§7 kill criterion 1 の判定材料）。
5. **依存 skip カスケードの観測** — `setup` を意図的に落とし、依存 project のテストがどう報告されるか（status / annotation / outcome）を記録。
6. **resolved config の観測** — `FullConfig` から instrument digest に入れるべきフィールドの確定（retries / workers / timeout / projects / shard は yes、reporter リストは要検討）。
7. **バージョン pin** — `@playwright/test` `1.49.1`（shift-bud 実測値）で probe する。reporter API 面は版で動くため、probe 結果は版に紐づけて記録する。

**受け入れ基準:** 上記7項目に determined な答えが出ており、§7 の kill criterion が判定できている。

### Phase 1: seam 抽出（挙動凍結）

**入力:** Phase 0a の run_id baseline、Phase 0b の capability / composition 実測

**やること:** §4 の Architecture を実装。**§8 の順序制約に従う。**

### Phase 2: Playwright adapter

**やること:**

- `Adapter` interface に対する Playwright 実装
- 新しい縁の conformance fixture: retries / flaky、project 間の同一タイトル重複、依存 skip カスケード、resolved-vs-file config、attachment の `context_digest`
- shift-bud e2e 53 spec での dogfood

---

## 7. `flaky` の表現（D2）と kill criterion

### 決定

`/1` を閉じたまま扱う:

| 観測 | 表現 |
| --- | --- |
| Playwright `outcome() === 'flaky'`（retry 後 pass） | verdict `pass` |
| `fail → flaky` の transition | **`verification_inconclusive`**（`TRANSITION_KEYS` に既存） |
| retry 各 attempt の failure evidence | annex + anchor（spec §9.3）、capability 宣言で開示 |

### 根拠

1. **新 enum 値が不要** — `verification_inconclusive` は `src/schema.ts:115-127` に既に存在する。表現を発明せず、既存スロットの適合を試すだけ。
2. **spec §7.7 は許可規定であって義務規定ではない** — "a flaky-class label **is permitted** only from the runner's own retry verdict"。同時に課す制約は "Flaky annotations never suppress new/updated failure reporting" で、本マップはこれを自明に満たす（何も抑制しない）。
3. **trust 上の危険を構造的に防ぐ** — 危険は「`fail → flaky` を `repaired` と報告すること」（INV-9 の精神に反する）。本マップはそれを構造的に不可能にする。
4. **可逆性の非対称性** — `/2` を切るのは**公開した promise** である（spec §14 が enum を閉じた契約と定める以上、version 番号自体が契約）。`/1` で足りたと後で分かっても un-publish できず、conformance 46 fixture と consumer parser（spec §9.4）が分岐を永久に抱える。対して本決定が誤っていた場合のコストは Phase 0b で判明し、失うのは probe 設計の時間だけである（Phase 1 未着手）。安く戻せる側を default に置く。

### 認めておく弱点

`verification_inconclusive` は意味的に「判定できなかった」であり、flaky は「不安定と判定できた」である。**意味の引き伸ばしであり report の精度を下げる方向のカテゴリ誤り**という批判は成立する。本決定は「安全だが表現力が貧しい」選択である。

### kill criterion（事前登録）

Phase 0b で以下のいずれかが観測されたら **D2 を破棄し `veridelta/2` に切る**:

1. **flaky が稀ではなく常態** — 53 spec に `retries: 2` を強制して flaky outcome の割合が高い場合、全てが `verification_inconclusive` バケツに落ちて report が洪水になり、狙った suite でこそ使えなくなる。
2. **`flaky → fail` / `fail → flaky` / flaky 回数の変化を区別する必要がある** — 単一バケツでは区別できない。

これを事前に書き下していることが、「証拠なしに決める」との差である。

---

## 8. Phase 1 の順序制約（D3）と受け入れ基準

### 8.1. なぜ順序制約が必要か

spec §3.5 により、`recording` グループを除いた record content が同一なら run_id は一致する。spec §6.2 により、composition 不変の純粋 refactor は `adapter_version` を上げない。したがって**ツール自身の同一性判定がそのまま refactor の証明になる**。

ただし `DEGRADED_CAPABILITIES` を静的 import から record 宣言へ移す変更は、*記録される内容*を変えうる（能力宣言が record に明示的に載る）。その場合 run_id は**正当に**変わり、この綺麗なテストが使えなくなる。

### 8.2. 順序

1. **Step 1（純粋な構造移動）** — record 内容を1バイトも変えない移動のみ。`Adapter` interface の導入、`src/run.ts` の registry 化、vitest 固有ロジックの `adapters/vitest/` への移動、core からの直接 import 除去。`adapter_version` は**上げない**。
2. **Step 2（record 形状変更）** — capability 宣言の record への明示的な載せ替え等。**`adapter_version` bump を伴う**。spec §6.2 に従い、この bump は Step 1 以前の record との comparability を意図的に切る。

### 8.3. 受け入れ基準

**Step 1:**

> shift-bud 6パッケージを tree T において Phase 0a で記録した run_id 群と、Step 1 完了後に同じ tree T で記録した run_id 群が**完全に一致すること**。

一致しない差分は、conformance 46 fixture が捕まえられなかった挙動変化である。加えて conformance suite（46 fixture + determinism proof）が green であること。

**Step 2:** conformance suite が green であること。run_id の変化は宣言した capability group の差分としてのみ説明可能であること。

---

## 9. Non-goals

- CI gate の組み込み（Phase 0a / 1 / 2 いずれでも）
- ambient recording（spec §4.2）の実装 — §10 F-1
- `pytest` / JUnit XML adapter — spec §12 で demand-driven
- Rust / `cargo test` adapter — roadmap 外。dogfood 対象が薄く（自前 Rust repo は 668〜2562 行 / test 0〜31 件、nextest 設定なし）、構造化チャネルが nightly・experimental・spec が格下げした lossy な JUnit のいずれかに依存する
- coverage adapter（spec Appendix A.4）
- `veridelta/2` — §7 kill criterion が発火した場合にのみ再検討

---

## 10. Follow-up（本設計のスコープ外だが記録する）

| # | 内容 | 根拠 |
| --- | --- | --- |
| F-1 | **ambient recording の実装** — spec §4.2 が RECOMMENDED と規定するデプロイ形態が未実装。CLI-wrapper-only では shift-bud のような wrapper script 中心の repo から signal が取れない | §3.4 |
| F-2 | **capture チャネルの per-process 化** — F-1 の前提。`VDELTA_CAPTURE_FILE` 単一パスは multi-process fan-out で last-writer-wins になる | §3.4 付随ハザード |
| F-3 | `env_fingerprint` を `STREAM_KEY_FIELDS` に含めるかの検討 — 現状 `CI` は開示のみで stream 分離しないため、local↔CI の instrument 差が stream 上では見えない | §3.3-3 |
| F-4 | vitest 4.x フラグ表（`src/run.ts:73-101`）の同期機構 — 既知 open question（#15）。Phase 1 で `adapters/vitest/` に移動するが、同期問題自体は残る | §3.1 |

---

## 11. Risks

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| flaky base rate が高い | D2 破棄 → `/2` | §7 kill criterion で Phase 0b 中に判定。Phase 1 未着手のため損失は probe 設計時間のみ |
| `@playwright/test` 1.49.1 の reporter API 面が想定と異なる | Phase 0b やり直し | probe をバージョンに紐づけて記録（§6 Phase 0b-7）。shift-bud の実測値で probe する |
| shift-bud e2e のテナント系8件がローカルで構造的に赤（#1086 × `DEV_TENANT_SLUG`） | Phase 2 の baseline が赤 | **むしろ好材料**。「既存赤が別の赤に変異したか」を言い分けるのが vdelta の中核価値であり、理想的な demo subject。ただし `DEV_TENANT_SLUG` 依存を probe 記録に残す |
| Phase 1 Step 1 で run_id が一致しない | 挙動変化の混入 | それが検出目的。差分を特定して Step 1 に戻す（受け入れ基準を緩めない） |
| 依存 skip カスケードを surface 縮小と誤判定 | INV-9 の狼少年化 | Phase 0b-5 で実挙動を観測し、Phase 2 の conformance fixture に固定する |
