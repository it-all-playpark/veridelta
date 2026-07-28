# adapter seam 抽出 + Playwright adapter Design

**Status:** revised
**Date:** 2026-07-28
**Scope:** vdelta 0.2.2 → 2番目の adapter（Playwright）を載せられる状態にする
**Related:** spec `veridelta/1` §3.1, §3.2, §3.4, §3.5, §3.6, §4.2, §6.2, §6.3, §6.4, §7.5, §7.7, §9.1, §9.3, §11.1, §12, §14

> 本文中の `spec §N` は `spec/veridelta-1.md` の節、`§N` は本設計の節を指す。
> file:line 参照はすべて本 worktree の HEAD 実測値。

---

## 1. Goal

2つの目的を同時に満たす:

1. **dogfood 密度** — 自前で維持している suite で vdelta を実際に効かせる。
2. **adapter seam の検証** — 「vitest 以外を*ちゃんと*載せられるか」に実測で答える。現状これは未検証であり、後述の通り seam はそもそも存在しない。

spec §12 は Playwright を2番目の adapter として明示的に指名している（rev 0.3.1）。根拠は e2e 固有の adapter 縁（retries / project 間の同一タイトル重複 / worker 並列）である。本設計はその順位を採用し、コミットの前提条件である spec §3.6 probe を Phase 0b として明示的にスケジュールする。

**dogfood subject:** `playpark-llc/shift-bud`（pnpm モノレポ、実測 HEAD `8cf90518` / branch `dev`）

| 対象 | 規模（`8cf90518` 実測） | runner |
| --- | --- | --- |
| backend / frontend / shared / landing / video | 255 test files（`*.test.ts` + `*.test.tsx`） | vitest `^4.1.10`（全パッケージ統一） |
| e2e | **14 spec ファイル + 1 setup ファイル / `test()` 呼び出し 171 箇所** | `@playwright/test` `^1.49.1` |

> e2e の規模は §7 kill criterion 1 の分母に直結する。**分母は authored な 171 ではなく「当該 run で実際に実行された test case 数（project 展開後）」**と定義し、probe 実施時に再計測して記録する（`auth-tests` / `chromium` の project 分割で authored 数と実行数は乖離する）。

---

## 2. 決定サマリ

| ID | 決定 |
| --- | --- |
| **D1** | 順序は **probe → seam 抽出（挙動凍結）→ Playwright adapter**。copy-adapt 先行および experimental フラグ先行は却下（§5）。 |
| **D2** | `flaky` は **`/1` を閉じたまま**扱う。flaky の verdict は `pass` + `FailureFinding`（retry 失敗 attempt の evidence）、`fail → flaky` は `verification_inconclusive`、attempt 別詳細は annex + anchor で開示。**反証可能な default** とし kill criterion を事前登録する（§7）。<br>**本機構の規範化には `veridelta-1.md` §3.2 の 0.x draft 改訂（`finding` を非 red でも MAY として明示）が必要**。spec §14 の draft phase 規定（"closure binds from the first published revision"）により、これは `/2` 発行とは非対称に安価。 |
| **D3** | Phase 1 は「純粋な構造移動」を先に完了させ、**in-repo の A/B replay ハーネス**で挙動凍結を機械的に証明する。record 形状が変わる変更は `adapter_version` bump + spec draft 改訂を伴う別ステップに切る（§8）。 |
| **D4** | dogfood のインストールは **ローカル link**（registry pin ではない）。CI gate 組み込みと shift-bud への devDependency コミットは**スコープ外**。 |
| **D5** | adapter 検出は **明示指定優先**（`--adapter <name>`）、argv 走査は補助。未検出は raw passthrough（INV-5 維持）。wrapper コマンド対応（ambient recording）はスコープ外・follow-up 化。 |

---

## 3. 調査結果（本設計の根拠）

### 3.1. adapter seam は存在しない

| 場所 | vitest 癒着の内容 |
| --- | --- |
| `src/run.ts:53-60` | `reporterModulePath()` が `adapters/vitest/reporter.js` を固定で返す |
| `src/run.ts:62-70` | `findVitestToken()` — argv から vitest バイナリを走査 |
| `src/run.ts:72-119` | **vitest 4.x 専用**の「値を別 argv で取るフラグ」表（JSDoc 72-93 + `VITEST_VALUE_FLAGS` 94-119）。selector 分離に使う。JSDoc 91-92 で「vitest 自身の CLI 面と同期する自動機構は存在しない」と明記済み（#15） |
| `src/run.ts:130-165` | `splitCommandSelector()` — vitest の CLI 面に閉じた inclusion intent 抽出。`export` されており `tests/unit/run.test.ts:2` が依存 |
| `src/run.ts:213-222` | `--reporter=default --reporter=<path> --includeTaskLocation` を argv 末尾に注入 |
| `src/run.ts:15-19` | `Capture` 型（:15）と `buildRunRecord` / `RecordContext`（:16-19）を `adapters/vitest/*` から直接 import |
| `src/compare.ts:7-8`, `src/gate.ts:9-10`, `src/index.ts:10-11` | **汎用の比較器 / gate / 公開 API が `COMPOSITION_ID` と `DEGRADED_CAPABILITIES` を `adapters/vitest/recorder.js` から静的 import** |
| `src/adapters/vitest/capture.ts` | `runner: 'vitest'` リテラル（:34）、`state` の4値 union（:22）/ `mode`（:23）/ `fails`（:24、`test.fails`）、`config: { include_task_location, truncate_threshold }`（:38-41）が vitest 語彙 |

最後の2つが本質的な問題。spec §3.4 は「capability の欠落は *unknown* であって *unchanged* ではない」と規定するが、比較器が特定 adapter の能力定数を静的に参照している限り、adapter が2つになった時点でこの規定は成立しない。**能力は run record が宣言するもの**に変える必要がある。

### 3.2. `flaky` は実装に存在しない

- `src/schema.ts:10-18` `VERDICTS` = `pass | fail | error | skip | xfail | xpass | not_run`
- `src/schema.ts:115-127` `TRANSITION_KEYS` = 11個、flaky 系ゼロ
- `flaky` / `retry` は `src/schema.ts` / `src/compare.ts` に**1件も出現しない**

一方 spec §7.7 は「runner 自身の retry verdict からなら flaky ラベルを許す」と規定し、Playwright の `TestCase.outcome()` は `expected | unexpected | flaky | skipped` で **flaky が一級の観測値**である。そして spec §14 は `/1` の enum を閉じた契約と定める（値追加には新 schema version が必要）。

つまり **Playwright の最も特徴的な観測値に `/1` 内の置き場がない**。これは vitest だけでは露出しなかった発見であり、「protocol は runner 中立か」への最初の実測回答である。

ただし *enum* の話と *field 意味論* の話は分けねばならない。`parseRunRecord`（`src/schema.ts:783-784`, `:807-808`）は `finding` を **verdict 非依存の optional** として受理し、`src/compare.ts` が `finding` を読むのは red→red 経路（`:557-585`）のみである。つまり「`pass` 観測に retry 失敗 attempt の finding を載せる」は現 schema の中で成立する（§7 実装機構）。規範側で必要なのは spec §3.2 の `finding` 行（"MUST when red"）に非 red での MAY を明記する 0.x draft 改訂だけである。

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

1. **依存 skip カスケード（vitest に存在しない縁）** — `setup` が落ちると依存 project のテストは *skipped* で報告される。素直に写すと `fail_to_skip` + `surface: reduced` を出し、setup 破損ごとに狼少年になる。INV-9（surface 縮小による red 消失を repaired と呼ばない）を守りつつ、**これは「テストが suppress された」のではないと言い分ける必要がある**。候補機構と決定木は §3.3.1 に書き下す。
2. **test ID に project を含める必須性** — 同一タイトルが project 間で重複しうる。`buildRunRecord` は重複 ID で fail-closed に throw する（`src/adapters/vitest/recorder.ts:79-81`）ので、project を含めない ID 設計は即座に記録不能になる。
3. **resolved-vs-file config digest** — config **ファイル**の digest は local↔CI で同一だが、**解決後**の instrument は別物（`retries: 0` では flaky が観測不能）。これは Playwright 固有の問題ではなく **adapter 共通契約**の欠落なので §4.1.1 に昇格した。
4. **spec §7.8 順序正規化** — `fullyParallel: true`。
5. **annex / `context_digest`** — trace / screenshot / video の attachment。
6. **CE-2 全フィールド除外** — locator / timeout のエラーメッセージは retry ログ（`waiting for locator... 9 × locator resolved to ...`）を含み揮発する。

好材料: Playwright は `error.location` を提供するため spec §3.6 option (b)（recorded tree からの決定的再構成）が使え、**vitest が唯一 degraded にしている `source-region-text`（`src/adapters/vitest/recorder.ts:30`）を Playwright は満たせる可能性がある**。capability 宣言設計が正しく機能する証拠になる。

#### 3.3.1. 依存 skip カスケードの候補機構と決定木

Phase 0b-core-5 の観測結果に応じて分岐する。**事前登録:**

1. adapter は `FullConfig` の project dependency graph を capture に含める。同一 run 内で依存先 project に red がある場合、依存元の `skipped` 観測に `suppression.marker = 'dependency'` を付す。`suppression.marker` は `src/schema.ts:799` で `asString` のみ（open string）なので schema 変更不要であり、verdict は runner の verdict channel が返す `skip` のままなので **INV-3 に抵触しない**。
2. comparator は `fail_to_skip` / `verification_surface: reduced` の **報告を維持する**。spec §11.1 の ungameable floor が「reduction events は如何なる flag / configuration / policy でも output から除去できない」と定める以上、`marker='dependency'` を理由に *reported* から外すのは非適合。
3. 狼少年問題の解は「除去」ではなく **attribution 付き開示 + blocking set からの除外**である。spec §11.1 は "MAY allow narrowing which transitions *block*, but never which are *reported*" を明示的に許すため、gate の default gate-relevant set から依存起因 `fail_to_skip` を外すのは適合する。
4. attribution の report 表現（`SurfaceEvent` への optional field 追加が要るか、`still_fail_unchanged` と同じ `string | object` union パターン（`src/schema.ts:149-153`）で足りるか）は record 形状変更なので **Step 2 の検討事項**。
5. **区別不能だった場合の分岐:** ① dependency graph からの決定的再構成 fallback を試す → ② それも不能なら「狼少年を受容して文書化」。**floor を破る選択肢は取らない。**

### 3.4. shift-bud のテスト入口に runner トークンがない

```
root     test:         pnpm -r --filter '!@shift-bud/e2e' test
root     backend:test: pnpm --filter @shift-bud/backend test
backend  test:         vitest run src        ← runner トークンはここだけ
e2e      test:         playwright test
```

`src/run.ts:213` の `findVitestToken()` は argv を走査する。`pnpm` しか無い → reporter 注入なし → `readFileSync(captureFile)` が throw → `degraded raw passthrough`（`src/run.ts:242-244`「is the child a vitest invocation?」）。INV-5 通り fail-safe だが、**チームが実際に打つコマンドからは dogfood シグナルがゼロ**になる。

これは単なる検出の話ではない。**spec §4.2 は recording を "ambient-first" と規定し、`vdelta run --` は「1つの recorder 実装にすぎない」と明記している**（根拠: wrapper-only 設計は agent の規律に依存し、1回の wrap 忘れで stream が切れる）。つまり shift-bud の wrapper 問題は、CLI-wrapper-only の現実装が spec §4.2 に追いついていない証拠であり、shift-bud はそれが実際に痛む repo である。

ただし ambient recording の実装は独立した規模の作業であり、本設計のスコープ外とする（D5、§10 F-1）。

**付随ハザード（現時点では発火しない）:** `VDELTA_CAPTURE_FILE` は単一パス（`src/run.ts:170`。`captureFile` は `runAndRecord` 1回につき1本、`src/run.ts:211`）。子孫プロセスは環境変数を継承するため、`pnpm -r` が6 runner プロセスを fan-out した場合、注入が届いていれば last-writer-wins で静かに1個だけ記録される。現状は argv にトークンが無く注入されないため発火しないが、ambient recording を実装する際は capture チャネルを per-process 化する必要がある（§10 F-2）。

**副産物:** backend は `test: vitest run src`（selector = `src`）と `test:all: vitest run`（selector なし）を持ち、**実データの subset 関係**が repo 内に存在する。ただしこれを実際に踏むには **`selector-relation` capability の実装が必要**である — 現実装は `src/compare.ts:309-311` で「No selector-relation capability in the MVP adapter」として containment を常に `selector-relation-unknown` に落とすため、この副産物は今のままでは永久に回収できない。Phase 1 では §4.1 の interface に optional な席を切るだけとし、実装は follow-up F-5 に置く（`BASELINE_MODES` に `previous-superset` が予約済み — `src/schema.ts:93`）。

### 3.5. run_id が挙動凍結の機械的証明になる

spec §3.5:

> `run_id` は Run record の canonical serialization（**`recording` グループを除外**）の SHA-256。`recording` を除外しているため、同じ物理 run を同一に観測した2つの recorder は同じ `run_id` を生成する。

実装も一致する（`src/store.ts:76-80`、`recording` を分割代入で除外）。

**ただし「純粋 refactor なら run_id 不変」には無視できない前提がある。** `recording` 以外のすべてが run_id に入るため、以下が record に埋まっている:

- `instrument.adapter_version` = `package.json` の `version`（`src/run.ts:32-36` → `src/adapters/vitest/recorder.ts:118`）— 本 repo は release-please による自動バージョン bot を運用中（直近 `chore(main): release 0.2.2`）
- `repo.worktree` / `repo.identity` = **絶対パス**（`src/adapters/vitest/recorder.ts:110-111`）
- `environment.runtime` = `node ${process.version}`、`environment.os`、`environment.env_fingerprint`（`CI` / `NODE_ENV` / `TZ` / `LANG` の実値の digest）
- `provenance.head` = commit SHA（author/committer timestamp を含む）
- red テストの failure evidence 全文

したがって「同じ tree で run_id 一致」は **バージョン・絶対パス・node・env・commit 日時が固定されている限りで**成立する。§8.3 の受け入れ基準はこの前提を構造的に固定できる形（in-repo A/B replay）を主判定に置く。

---

## 4. Architecture: adapter seam（Phase 1 の到達点）

### 4.1. `Adapter` descriptor

adapter を1つのオブジェクトに閉じ、core（`run` / `compare` / `gate`）は registry から解決した descriptor 越しにしか adapter を触らない。

**重要（D3 の根拠）:** 以下の型はほぼ全て既存実装の *昇格* であり、新規発明ではない。`RecordContext` は `src/adapters/vitest/recorder.ts:41-56` の14フィールドをそのまま持ち上げたもので、vitest 語彙を1つも含まない。`DetectResult` は `findVitestToken()`（`src/run.ts:63-70`）の戻り値、`InstrumentedChild` は `src/run.ts:214-222`（argv）と `src/run.ts:170`（env）の現挙動、`splitCommandSelector` は `src/run.ts:130` で既に同一シグネチャで `export` 済みである。

```ts
// src/adapter.ts（新設）
import type { RunRecord } from './schema.js'

/** spec §3.4 の三値 convention。値は閉じた enum（§14）、名前は adapter 拡張可能。 */
export const CAPABILITY_VALUES = ['pass', 'fail', 'unsupported'] as const
export type CapabilityValue = (typeof CAPABILITY_VALUES)[number]
export type CapabilityDeclaration = Readonly<Record<string, CapabilityValue>>

/** capture チャネルの記述。現在の実装は single-file の1種のみ（F-2 で拡張予定）。 */
export interface CaptureChannel {
  readonly kind: 'single-file'
  readonly path: string
}

/** `detect` の戻り値。`null` は「自分ではない」の意味のみを持つ。 */
export interface DetectResult {
  /** runner バイナリの argv index（`findVitestToken()` の戻り値を昇格） */
  readonly tokenIndex: number
}

/** 子プロセスに渡す instrument 結果。`argv` は完全な置換、`env` は追加分のみ。 */
export interface InstrumentedChild {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** spec §6.4 inclusion intent の分離結果。 */
export interface CommandSelector {
  command: string[]
  selector: string[]
}

/** `src/adapters/vitest/recorder.ts:41-56` を無変更で昇格（vitest 語彙ゼロ）。 */
export interface RecordContext {
  worktree: string
  repoIdentity: string
  branch: string
  cwdRel: string
  command: string[]
  selector: string[]
  head: string | null
  treeDigest: string
  dirtyDiffDigest: string
  childExitCode: number
  rawStdout: string
  rawStderr: string
  adapterVersion: string
  recordedAtMs: number
}

/** spec §6.4 の宣言関数（optional capability）。 */
export type SelectorRelation =
  | 'equal'
  | 'subset'
  | 'superset'
  | 'disjoint'
  | 'unknown'
export type SelectorMatch = 'yes' | 'no' | 'unknown'

/** capture が読めない / 版が違う / 壊れている。core はこれを degraded passthrough に写す。 */
export class AdapterCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterCaptureError'
  }
}

export interface Adapter {
  readonly name: string
  readonly compositionId: string
  readonly declaredCapabilities: CapabilityDeclaration
  readonly declaredEnvVars: readonly string[]

  /** argv がこの adapter のものか。null = 自分ではない（判断せず譲る）。 */
  detect(argv: readonly string[]): DetectResult | null

  /** reporter 注入済み argv と、子プロセスに追加する env。 */
  instrument(
    argv: readonly string[],
    channel: CaptureChannel,
  ): InstrumentedChild

  /** spec §6.4 inclusion intent の抽出。runner ごとの CLI 面に閉じる。 */
  splitCommandSelector(argv: readonly string[]): CommandSelector

  /**
   * capture チャネルを読み、検証し、Run record を組む。
   * capture の parse / version 検証の所有者は **adapter**（core は JSON を知らない）。
   * 失敗は `AdapterCaptureError` を throw し、core が degraded passthrough に写す。
   */
  record(channel: CaptureChannel, ctx: RecordContext): RunRecord

  /** spec §6.4。未宣言 = 常に `unknown` = `src/compare.ts:309-311` の現挙動と互換。 */
  selectorRelation?(
    a: readonly string[],
    b: readonly string[],
  ): SelectorRelation
  selectorMatches?(selector: readonly string[], testId: string): SelectorMatch
}
```

vitest 実装は既存関数の束ね直しに落ちる（これが「純粋な構造移動」の意味）:

```ts
// src/adapters/vitest/adapter.ts（新設）
export const vitestAdapter: Adapter = {
  name: ADAPTER_NAME,                       // recorder.ts:27
  compositionId: COMPOSITION_ID,            // recorder.ts:28
  declaredCapabilities: VITEST_CAPABILITIES,
  declaredEnvVars: DECLARED_ENV_VARS,       // recorder.ts:32

  detect(argv) {
    const i = findVitestToken(argv)          // run.ts:63-70 を移設
    return i === null ? null : { tokenIndex: i }
  },

  instrument(argv, channel) {               // run.ts:170 + 214-222 を移設
    return {
      argv: [
        ...argv,
        '--reporter=default',
        `--reporter=${reporterModulePath()}`,
        '--includeTaskLocation',
      ],
      env: { VDELTA_CAPTURE_FILE: channel.path },
    }
  },

  splitCommandSelector,                     // run.ts:130-165 を移設

  record(channel, ctx) {
    let capture: Capture
    try {
      capture = JSON.parse(readFileSync(channel.path, 'utf8')) as Capture
    } catch {
      throw new AdapterCaptureError(
        'no capture from the vitest reporter — is the child a vitest invocation?',
      )
    }
    return buildRunRecord(capture, ctx)     // recorder.ts:58、capture_version 検証は :62-66
  },
}

/** 現出力 `['source-region-text']` をバイト単位で再現する初期宣言。 */
export const VITEST_CAPABILITIES: CapabilityDeclaration = {
  verdicts: 'pass',
  'source-location': 'pass',
  suppression: 'pass',
  inventory: 'pass',
  'failure-evidence': 'pass',
  'source-region-text': 'unsupported',      // recorder.ts:30 と等価
}
```

実装上の注意（コンパイルを通すために必要）:

- `splitCommandSelector` の引数型を `cmd: string[]` から `cmd: readonly string[]` に**広げる**必要がある。`strictFunctionTypes` 下で property 位置に代入するため。`slice` / index アクセスのみなので本体は無変更。`run.ts` からの `export` は Step 1 中は re-export で維持する（`tests/unit/run.test.ts:2` が依存 — 公開 API 面の凍結）。
- `Adapter` に capture 型の型パラメータは**置かない**。`record()` が `CaptureChannel → RunRecord` で型を閉じるため registry を `readonly Adapter[]` にできる（generic 版は variance で registry 化が破綻する）。
- `channel` の生成と後始末（tmp ファイルの作成と `rmSync`）は現状 core が持つ（`src/run.ts:211`, `:246`）。これは「core が capture = 単一ファイルであることを知っている」残存リークであり、**F-2（per-process 化）で adapter 側に移す予定**。今は実装が1つしかないため抽象化しない（YAGNI）。
- `RecorderError`（`src/adapters/vitest/recorder.ts:34-39`）は `AdapterCaptureError` を継承させる。`src/index.ts` は `RecorderError` を公開していないので API 破壊はない。

各ユニットの依存が単一方向であることを保つ:

- `detect` / `instrument` / `splitCommandSelector` は **argv のみ**に依存（runner の CLI 面の知識）。
- `record` は **capture チャネル + RecordContext のみ**に依存（runner の構造化チャネルの知識）。
- core は `Adapter` interface のみに依存し、`adapters/*` を直接 import しない（registry を除く）。

### 4.1.1. `instrument.config_digest` の adapter 共通契約

> **訂正:** 旧版 §3.3-3 は「vitest adapter は config *ファイル* を digest している」と書いていたが、これは誤りである。`instrumentConfigDigest`（`src/adapters/vitest/recorder.ts:159-164`）は capture 由来の `{ include_task_location, truncate_threshold }` の **2値だけ**であり、config ファイルの digest ですらない。config ファイルの digest は `surface.config_sources` の役割（`recorder.ts:94-99`）である。

spec §3.1 は instrument digest に「evidence quality or structure を変える effective configuration を、**どう供給されたかによらず**（command line, configuration files, plugins, or environment）」covering することを MUST で要求している。したがって:

**契約:** `instrument.config_digest` は composition が列挙する **解決済み** evidence-affecting 設定から計算する。各 adapter は列挙リストを `composition_id` にひもづけて文書化する。config ファイルの digest は `surface.config_sources` の役割であり、`config_digest` の代替にならない。

これは Playwright 固有の要件ではない。vitest の `retry` / `environment`（jsdom↔node で例外型やメッセージが変わりうる）/ `pool` は今日の digest に入っておらず、`environment: process.env.CI ? 'jsdom' : 'node'` の形の config を書けば **spec §6.2 の same-instrument rule が今日の vitest adapter でも嘘になる**。Playwright の `retries: CI ? 2 : 0` と完全に同型の穴である。

- Phase 0a の「発見不具合の issue 化」の具体例として **「vitest resolved-config coverage audit」**を立てる。内容は修正ではなく *audit + composition 文書化*: `retry` / `environment` / `pool` 等が evidence-affecting か判定し、`vitest-native/1` の列挙リストとして書き下す。
- 緩和材料と限界: `DECLARED_ENV_VARS`（`src/adapters/vitest/recorder.ts:32`）に `CI` が含まれ `env_fingerprint` に入るが、`env_fingerprint` は `STREAM_KEY_FIELDS`（`src/schema.ts:45-55`）に**含まれない**ため開示のみで stream 分離はしない。これは両 adapter 共通の課題であり §10 F-3 に置く。

### 4.2. core 側の変更と capability の record 表現

| 現状 | 変更後 |
| --- | --- |
| `src/compare.ts:7-8` / `src/gate.ts:9-10` / `src/index.ts:10-11` が `COMPOSITION_ID` / `DEGRADED_CAPABILITIES` を静的 import | **Step 1:** registry lookup に置換（下記 interim 規則）。**Step 2:** run record が宣言した capability を読む |
| `src/run.ts` が vitest 固定 | adapter registry から解決。未検出は raw passthrough（INV-5） |
| `src/run.ts:72-119` の vitest 4.x フラグ表 | `src/adapters/vitest/` 内に移動（他 adapter に漏れない） |

**Step 1 の interim 規則（record にまだ宣言が無い期間）:** comparator / gate は `record.instrument.adapter` の名前で静的 registry を引き `declaredCapabilities` / `compositionId` を得る。registry に無い adapter 名は **fail-closed abstention** とする。ただし spec §6.3 の closed enum に意味的に適合する `reason` は存在しない（`adapter-crashed` は「adapter が壊れた」であって「この record を解釈できる adapter を知らない」ではない）。**この不足自体が spec 発見であり §12-5 に未決として残す。**

**Step 2 の record スキーマ（具体案）:**

```ts
// src/schema.ts
export const CAPABILITY_VALUES = ['pass', 'fail', 'unsupported'] as const
export type CapabilityValue = (typeof CAPABILITY_VALUES)[number]

// RunRecord.instrument に1フィールド追加
instrument: {
  adapter: string
  adapter_version: string
  composition_id: string
  config_digest: string
  capabilities: Record<string, CapabilityValue>   // ← NEW
}
```

- `parseRunRecord` の `record.instrument` の `checkKeys`（`src/schema.ts:729-735`）に `capabilities` を足し、**値のみ** `asEnum(CAPABILITY_VALUES)` で検証する（名前は adapter 拡張可能、spec §3.4 が "etc." で開いている）。
- `capabilities` は `STREAM_KEY_FIELDS` に**入れない** — `(adapter, adapter_version, composition_id)` の関数であり、開示であって鍵ではない。`streamKey`（`src/compare.ts:55-67`）と `sameInstrument`（`:144-151`）はフィールド名指定で読むため、追加による副作用はない。
- 導出規則: `report.failure_evidence.degraded_capabilities` = 比較対象 record の `capabilities` のうち **evidence 系 capability**（`EVIDENCE_CAPABILITY_NAMES` 定数で列挙）で値が `'unsupported'` のものの名前（sorted）。vitest の初期宣言（§4.1）でこれは `['source-region-text']` になり、現出力とバイト同一 → `adv-degraded-capability` 等の既存 fixture が green のまま移行できる。**これが Step 2 の機械判定可能な完了条件の1つ**（§13）。
- `SURFACE_EVENT_KINDS` の `'adapter-capability-changed'`（`src/schema.ts:82`）は **既に発火している** — `judgeComparability`（`src/compare.ts:290-301`）が adapter / adapter_version / composition_id の差分で出す。per-capability 差分での新発火をこの kind に同居させるか発火条件を再定義するかは §12-6 に残す。
- 旧 record（宣言なし）と新 record の混在比較は **追加実装不要**: Step 2 は `adapter_version` bump を伴うため `sameInstrument`（`src/compare.ts:144-151`）が false になり、spec §6.2 通り `instrument-changed` abstention に構造的に落ちる。
- spec 側は §3.1 の `instrument` 行に `capabilities` を明記する 0.x draft 改訂が必要（spec §14「Field additions within `/1` occur only through published spec revisions」）。

### 4.3. adapter 検出（D5）

**明示指定を第一とする:**

```
vdelta run --adapter playwright -- npx playwright test
vdelta run -- npx vitest run src            # argv 走査で vitest と判定（補助経路）
```

決定リスト（実装者が迷わないための確定事項）:

1. **registry は静的配列** `[vitestAdapter, playwrightAdapter]`（決定的順序）。登録 API は adapter が external plugin になるまで作らない（YAGNI）。
2. **`detect` は常に全 adapter を評価する。** 一致0件 → raw passthrough + `--adapter` を案内する diagnostic。一致2件以上 → raw passthrough + 候補列挙 diagnostic。いずれも INV-5 維持。
3. `DetectResult | null` の `null` は「自分ではない」だけを意味する。「wrapper なので判断できない」は adapter 単体では言えないので、**registry レベルの結論**（全 adapter 不一致かつ `argv[0]` が `pnpm` / `npm` / `yarn` 等）として diagnostic 側で表現する。
4. **`--adapter` は `detect` より常に優先する。** argv が矛盾していても指定 adapter で `instrument` し、capture が得られなければ既存の degraded 経路（`src/run.ts:242-244` 相当）に落ちる。
5. **`--adapter` の値が registry に無い場合は子プロセス起動前の即エラー**（exit 1、stderr に既知 adapter 一覧）。ユーザ入力エラーであり degraded passthrough の対象ではない — 黙って passthrough すると typo が silent degradation になり INV-5 の意図と逆に働く。
6. argv 走査は**利便のための補助**であり契約ではない。
7. wrapper コマンド（`pnpm test`）は `--adapter` を付けても reporter を argv 注入できない。Phase 0a では「runner を直接呼ぶ」で回避し、恒久解は ambient recording（スコープ外、§10 F-1）。

---

## 5. 却下した順序案

| 案 | 却下理由 |
| --- | --- |
| **B. Playwright を copy-adapt で先に通し、後から seam 抽出** | **copy-adapt は「遅い」のではなく「非適合な出力を出荷する」。** (a) `src/run.ts:213-222` の注入経路は vitest トークン検出に条件付けられており、Playwright では `vitestIdx === null` → `childCmd = cmd` → `readFileSync` throw → degraded passthrough（`:238-247`）にしか到達しない。**dispatch 変更（= seam 作成）は copy-adapt でも不可避**で、計画なしに作られるだけ。(b) `Capture` 型は vitest 語彙の閉じた union（`capture.ts:22` の `state` 4値、`:34` の `runner: 'vitest'` リテラル）であり、Playwright の `timedOut` / `interrupted` / `flaky` は型を偽らずに載らない。`mapVerdict`（`recorder.ts:181-209`）も入力型で閉じている。(c) **決定的なのは `src/compare.ts:492-493, 563, 585, 687-688` と `src/gate.ts:157-158` が vitest の `COMPOSITION_ID` / `DEGRADED_CAPABILITIES` を全レポートに無条件で刻印すること。** adapter が2つになった瞬間、Playwright run のレポートに `composition_id: 'vitest-native/1'` が載る — spec §9.1（`composition_id` は当該 adapter の宣言）の直接違反である。案Bの利点（実装2本から抽象を取る）は Phase 0b probe の実測出力（capability / composition の第2データ点）で代替できる。 |
| **C. experimental フラグ配下に最小 dispatch で先行出荷** | 本設計の目的（vitest 以外を*ちゃんと*載せられるかの検証）そのものを捨てる。 |

---

## 6. Phase 構成

```
Phase 0a ─┐
          ├─→ Phase 1 ─→ Phase 2
Phase 0b ─┘
```

Phase 0a と 0b は独立（並行可）。Phase 1 のゲートは 0a、Phase 2 のゲートは **0b-core のみ**。

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
- **baseline manifest の取得**（§8.3 副基準2 の基準値。shift-bud の pin SHA `8cf90518` を含む前提条件を同一ファイルに記録する）
- spec §3.4 の capability 宣言が実際に何を運ぶ必要があるかを、6つの実 record（jsdom / node 環境差、prismock 等）から確認
- 本設計 §3.4 の経験的確認（`pnpm test` が本当に passthrough に落ちるか）

**やらないこと（D4）:** CI gate 組み込み / shift-bud への devDependency コミット。インストールはローカル link（Phase 1 で実装が動くため）。

**摩擦の小ささ:** store は `<worktree>/.veridelta`（`src/store.ts:293`）で、`src/store.ts:320-321` が store 内に自前の `.gitignore` を書く。**shift-bud 側の `.gitignore` 変更は不要。**

**受け入れ基準:**

- 6パッケージすべてで `report != null`（passthrough に落ちない）
- §8.3 の baseline manifest が存在する（run_id 文字列だけでは不十分 — 不一致時に診断できない）
- 発見された不具合が issue 化されている（修正は Phase 1 と分離）。**最低1件は §4.1.1 の vitest resolved-config coverage audit**

### Phase 0a′: shift-bud がブロックされた場合の代替経路（degraded path）

shift-bud は別 org の private repo であり `dev` branch が動き続ける。到達不能な場合の代替を事前に決めておく:

- **(i) self-dogfood** — vdelta 自身の suite を `vdelta run` で記録する。`package.json` の `test` / `test:unit` / `test:conformance` / `test:platform` の**4ストリーム**が取れ、後者3つは `--project` フラグを使うため `VITEST_VALUE_FLAGS`（`src/run.ts:94-119`）の folding を**実データで踏む**。
- **(ii) 合成モノレポ bench** — shift-bud のトポロジ（6パッケージ・パッケージ別 vitest config・backend 相当の `src` / 全体という subset selector 対）を写した bench を `bench/` に追加する。

**明示的な留保:** 代替経路は「実装と同じ著者が期待挙動を符号化する」という Phase 0a が逃れようとした限界を部分的に再導入する。したがってこれは shift-bud 可用時の primary ではなく **degraded path** である。

### Phase 0b: Playwright の spec §3.6 probe

spec §12 は Playwright へのコミットを「structured reporter チャネルが spec §3.6 を満たすことの実測確認」に条件付けている。probe を **shift-bud 非依存の 0b-core** と **shift-bud 依存の 0b-field** に分割する。**Phase 2 のゲートは 0b-core のみ**とする。

#### 0b-core（shift-bud 不要 / Phase 2 のゲート）

§3.3 に逐語引用した config 形状（projects / dependencies / retries / fullyParallel）を再現した**合成 Playwright プロジェクト**で実施する。`@playwright/test` は `1.49.1` に pin（shift-bud 実測値）。**成果物はそのまま Phase 2 の conformance fixture の種として保存する。**

1. **CE-1〜CE-5 の充足確認** — exception type / asserted values を保った message / failing source region / traceback 構造。`error.location` からの tree 再構成が spec §3.6 option (b) を満たすか。
2. **rerun 安定性（CE-2）と line-shift 安定性（CE-3）** — 同一 tree での再実行、無関係な編集、行ズレで core digest が不変か。
3. **`retries: 2` を明示指定した flaky テスト1本** — `fail → retry → pass` を D2 のマップ（`pass` + finding、transition は `verification_inconclusive`）に落として失う情報がないか。
   **重要:** shift-bud は `retries: CI ? 2 : 0` なので**ローカルの実物 config では flaky が一度も観測されない**。仮説を持たずに実物 config へ当てると、CE-1〜5 は答えが出るのに flaky は出現せず「問題なし」と誤結論する経路が実在する。probe は retries を明示指定しなければならない。
5. **依存 skip カスケードの観測** — `setup` を意図的に落とし、依存 project のテストがどう報告されるか（status / annotation / outcome）を記録する。**受け入れ基準は「observation を残す」ではなく「authored skip（`test.skip()`）と dependency skip が構造化チャネル上で区別可能か」に determined な答えを出すこと**。区別不能だった場合の分岐は §3.3.1 の決定木に従う。
6. **resolved config の観測** — `FullConfig` から `instrument.config_digest` に入れるべきフィールドの確定（retries / workers / timeout / projects / shard は yes、reporter リストは要検討）。§4.1.1 の列挙リストとして書き下す。
7. **バージョン pin** — reporter API 面は版で動くため、probe 結果は版に紐づけて記録する。

#### 0b-field（shift-bud 依存 / Phase 2 のゲートではない）

4. **flaky base rate の測定** — 実物 e2e suite（14 spec ファイル / `test()` 171 箇所、実行 test case 数は probe 時に再計測）を `retries: 2` 強制で回し、§7 kill criterion 1 を判定する。

**0b-field が不能な場合の degraded path:** base rate は shift-bud の CI 実行データで代替する。それも不能なら **D2 を provisional のまま Phase 2 に進み**、kill criterion の最終判定を「Phase 2 の flaky マッピング実装の直前」（last responsible moment）まで繰り延べる。Phase 1（seam 抽出）は D2 の帰結と独立に進行できるため、この繰り延べは Phase 1 を一切ブロックしない。

**受け入れ基準:** 0b-core の6項目に determined な答えが出ていること。§7 の kill criterion は 0b-field またはその代替で判定されているか、上記 degraded path に従って明示的に繰り延べられていること。

### Phase 1: seam 抽出（挙動凍結）

**入力:** Phase 0a の baseline manifest、Phase 0b-core の capability / composition 実測

**やること:** §4 の Architecture を実装。**§8 の順序制約に従う。** 作るファイルと完了条件は §13。

### Phase 2: Playwright adapter

**やること:**

- `Adapter` interface に対する Playwright 実装
- 新しい縁の conformance fixture: retries / flaky（**§12-1 の決着が前提**）、project 間の同一タイトル重複、依存 skip カスケード、resolved-vs-file config、attachment の `context_digest`
- shift-bud e2e（14 spec ファイル / `test()` 171 箇所）での dogfood

---

## 7. `flaky` の表現（D2）と kill criterion

### 決定

`/1` を閉じたまま扱う:

| 観測 | 表現 |
| --- | --- |
| Playwright `outcome() === 'flaky'`（retry 後 pass） | verdict `pass` + `FailureFinding`（失敗 attempt の evidence） |
| `fail → flaky` の transition | **`verification_inconclusive`**（`TRANSITION_KEYS` に既存 — `src/schema.ts:126`、`Transitions` の optional key — `:182`） |
| retry 各 attempt の failure evidence | `finding.evidence.errors` + `finding.annex`（attempt 別 frames / console）、anchor（spec §9.3）、capability 宣言 `retry-evidence` で開示 |
| `fail → flaky` を含む report の `outcome_verdict` | **`inconclusive`**（`unchanged` は禁止）。§12-1 参照 |
| 同 report の gate verdict | **未決 — §12-1。決着まで Phase 2 の flaky fixture は書かない** |

### 実装機構

1. **記録側:** flaky = verdict `'pass'` + `FailureFinding`。`parseRunRecord` は `finding` を verdict 非依存の optional として既に受理する（`src/schema.ts:783-784`, `:807-808` — verdict 結合チェックは存在しない）。vitest recorder は pass に finding を付けない（`src/adapters/vitest/recorder.ts:176`）ため、既存 record 形状は変わらない。
2. **比較側:** baseline red かつ current 非 red かつ current 観測が `finding` を持つ場合、`repaired_*` ではなく `verification_inconclusive` に分類し、`verification_inconclusive:<test_id>` → `vdelta show <run> --test <id>` の anchor を張る。`src/compare.ts` は pass 観測の `finding` を red→red 経路（`:557-585`）以外で読まないため、この追加は既存分類に副作用を持たない — **`adv-flaky-no-inference` fixture（fail→pass = `repaired_same_surface` + outcome `improved`、flaky ラベルなし）も green のまま**。
3. **outcome 導出:** `deriveOutcome`（`src/compare.ts:711-724`）を拡張する。`new_fail` / `updated_fail` があれば従来通り `regressed`。それが無く `verification_inconclusive` が非空なら **`inconclusive`**。`unchanged` に落とすことは禁止する — baseline の red が消えたのに「何も変わっていない」と主張する report は INV-9 の精神に照らして最も危険な形になる。
4. **capability:** `retry-evidence` を capability 宣言に追加し、annex 到達可能性を機械可読に開示する（Step 2 の record 形状変更に属する）。
5. **事前登録する副作用:** baseline が flaky（pass + finding）で current が red のとき、現行ロジックでは `new_fail` に分類される。loud な方向なので許容するが、**意図した挙動として事前登録**し Phase 2 fixture でアサートする。
6. **spec 側:** `veridelta-1.md` §3.2 の `finding` 行（"MUST when red"）に非 red での MAY を明記する 0.x draft 改訂、および §7.5 の `verification_inconclusive` の意味拡張を改訂ノートに記録する。

### 根拠

1. **新 enum 値が不要** — `verification_inconclusive` は `src/schema.ts:115-127` に既に存在する。表現を発明せず、既存スロットの適合を試すだけ。
2. **spec §7.7 は許可規定であって義務規定ではない** — "a flaky-class label **is permitted** only from the runner's own retry verdict"。同時に課す制約は "Flaky annotations never suppress new/updated failure reporting" で、本マップはこれを自明に満たす（何も抑制しない）。
3. **trust 上の危険を構造的に防ぐ** — 危険は「`fail → flaky` を `repaired` と報告すること」（INV-9 の精神に反する）。current に failure evidence が現存する限り構造的に `repaired` と報告できない形にした。
4. **可逆性の非対称性** — `/2` を切るのは**公開した promise** である（spec §14 が enum を閉じた契約と定める以上、version 番号自体が契約）。`/1` で足りたと後で分かっても un-publish できず、conformance 46 fixture と consumer parser（spec §9.4）が分岐を永久に抱える。対して本決定に必要なのは `/1` の **0.x draft 改訂**であり、spec §14 は "During the draft phase (0.x spec revisions), enum sets may still change between revisions; closure binds from the first published revision" と明記している。**つまり必要なのは「`/2` は不要だが `/1` draft 改訂は必要」であり、コストは非対称のままである。** 誤りだった場合のコストは Phase 0b で判明し、失うのは probe 設計の時間だけ（Phase 1 未着手）。

### 認めておく弱点

`verification_inconclusive` は意味的に「判定できなかった」であり、flaky は「不安定と判定できた」である。**意味の引き伸ばしであり report の精度を下げる方向のカテゴリ誤り**という批判は成立する。加えて単一の `string[]` バケツは spec §7.5 本来の意味（capability / provenance 不足）と flaky を消費者が区別できない形で混ぜる — `inconclusive` を capability 異常のアラートに使う consumer に恒常ノイズを注入する。entries を `{test_id, reason}` に構造化する案（`StillFailEntry` の `string | object` union パターン、`src/schema.ts:149-153` が前例）は Step 2 の検討事項として記録する。本決定は「安全だが表現力が貧しい」選択である。

### kill criterion（事前登録）

以下のいずれかが観測されたら **D2 を破棄し `veridelta/2` に切る**（判定時点は Phase 2 の flaky マッピング実装前 = last responsible moment。Phase 1 は独立に進行できる）。

**Kill-1（flaky が稀ではなく常態）— 判定手順つき:**

- 同一 tree で e2e 全 suite を `retries: 2` 強制で **N 回連続実行**する。`N` は Phase 0b 開始前に一度だけ確定する（下限3、推奨10。shift-bud の CI 実行データで代替可 — §12-8）。
- **分母** = 各 run で実際に実行された test case 数（project 展開後。authored は 171 だが実行数とは乖離する）。
- **無効 run 規則:** `setup` project が red の run は無効とし `f_i` の集計から除外する（件数は記録する）。依存 skip カスケード（§3.3.1）が criterion 自体を偽発火させるのを防ぐため。
- 有効 run ごとの flaky test case 数を `f_i`、累積 distinct flaky 集合を `F` とする。
- **発火条件:** `median(f_i) ≥ 2`、**または** `|F| / 実行 test case 数 ≥ 5%`、**または** すべての有効 run で `f_i / 実行数 > 1%`。
- 意味: 典型的な1 run が恒常的に複数の手動 drill-down を要求する水準。狙った suite でこそ report が使えなくなる。

**Kill-2（区別する必要がある）:** `flaky → fail` / `fail → flaky` / flaky 回数の変化を区別する機械可読の要求が、具体的な消費者（gate policy、quarantine 自動化など）として Phase 0b〜Phase 2 fixture 設計までに現れた場合。**判定線（anchor 経由の drill-down を D2 の正当な充足手段と認めるか否か）は未決 — §12-2。**

**Kill-3（機構が置けない）:** spec §3.2 の MUST / Never 制約（`finding: MUST when red`、`detail: Never used for status derivation`）を破らずに flaky 信号を record に載せられないと判明した場合。

これを事前に書き下していることが、「証拠なしに決める」との差である。

---

## 8. Phase 1 の順序制約（D3）と受け入れ基準

### 8.1. なぜ順序制約が必要か

spec §3.5 により、`recording` グループを除いた record content が同一なら run_id は一致する。spec §6.2 により、composition 不変の純粋 refactor は `adapter_version` を上げない。したがって**ツール自身の同一性判定がそのまま refactor の証明になる**。

ただし2つの限界がある:

1. **`DEGRADED_CAPABILITIES` を静的 import から record 宣言へ移す変更は *記録される内容* を変える。** その場合 run_id は**正当に**変わり、この綺麗なテストが使えなくなる → Step 分割の理由。
2. **run_id が凍結を証明するのは recorder 経路（`run.ts` → `record()` → `buildRunRecord`）だけである。** Step 1 が実際に編集する `src/compare.ts:7-8` / `src/gate.ts:9-10` / `src/index.ts:10-11` の静的 import 除去は run record に一切現れない。comparator / gate の挙動変化は **report のバイト比較**で別途捕まえる必要がある（§8.3 主基準に組み込む）。

さらに §3.5 の通り、run_id には `adapter_version`（release-please が動かす）・絶対パス・node version・env・commit SHA が含まれる。**受け入れ基準はこれらを構造的に固定できる形で書かねばならない。**

### 8.2. 順序

1. **Step 1（純粋な構造移動）** — record 内容を1バイトも変えない移動のみ。`Adapter` interface の導入、`src/run.ts` の registry 化、vitest 固有ロジックの `src/adapters/vitest/` への移動、core からの直接 import 除去、`--adapter` フラグ。`adapter_version` は**上げない**。公開 API 面（`splitCommandSelector` の `run.ts` からの export 等）は凍結する。
2. **Step 2（record 形状変更）** — `instrument.capabilities` の record への載せ替え（§4.2）。**`adapter_version` bump を伴う**。spec §6.2 に従い、この bump は Step 1 以前の record との comparability を意図的に切る（`sameInstrument` が false → `instrument-changed` abstention。追加実装は不要）。**あわせて `veridelta-1.md` の 0.x draft 改訂（§3.1 の `instrument` 行に `capabilities` 追加、§3.2 の `finding` 非 red MAY）が必要。**

### 8.3. 受け入れ基準

#### Step 1 主基準: in-repo A/B replay ハーネス（自己完結・CI 常設可能）

`tests/conformance/runner.ts` に **dual-binary モード**を追加する。merge-base から build した `dist`（baseline binary）と HEAD の `dist`（candidate binary）で、決定的 fixture を**同一のワークスペース絶対パス**で2回 replay し、次を assert する:

- 全 run step の `run_id` が binary 間で**完全一致**すること（`FixtureContext.runIds` — `tests/conformance/runner.ts:128`, `:399-403` に既に収集済み）
- 全 compare / gate step の report JSON が binary 間で**バイト同一**であること（`FixtureContext.reports` — `:126`。§8.1 の限界2 を塞ぐ。spec §7.8 の決定性を refactor 検証に転用する）

**決定性を成立させるために必要な機構（これを書かないと最初の fixture で偽陽性崩壊する）:**

| # | 機構 | 理由 |
| --- | --- | --- |
| 1 | `FixtureContext` に `cliPath` を注入可能にする | 現状は定数（`tests/conformance/runner.ts:43`） |
| 2 | ワークスペース root を **固定パス**にするオプション（`mkdtempSync` — `:136-138` を迂回） | `repo.worktree` / `repo.identity` は絶対パスで run_id に入る（`recorder.ts:110-111`） |
| 3 | `FixtureContext.git()`（`:164-166`）に固定 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` を注入 | `commit` step（`:198-206`）が作る SHA は timestamp を含み、`provenance.head` は `recording` 外なので run_id に入る |
| 4 | pass 間で workspace root を完全削除→再作成（`.veridelta` を含む） | steps は workspace を漸進的に変異させる（apply / delete / branch / checkout） |
| 5 | 両 binary の `VDELTA_VERSION` 一致を比較前に assert し、不一致なら明示的診断で abort | release-please による bump が `instrument.adapter_version` を動かす偽陽性を**構造的に**排除する |
| 6 | replay 非決定な fixture の除外リストを明記（mtime 依存の `adv-stale-cache-collision` 等） | 0b/実装時に実測で確定する |

この方式は shift-bud 6ストリームより挙動網羅が広い（`pit-flag-value-forms` の selector 正規化、`pit-config-*` の config 探索、`adv-parallel-order`、`adv-secret-redaction` 等、40 前後の fixture × 複数 run）。しかも CI で永続再現できる。

**あわせて conformance suite（46 fixture。determinism proof の `inv6-determinism-byte-identical` はその46個のうちの1つであり別枠の追加検証ではない）が green であること。**

#### Step 1 副基準1: capture replay（recorder 経路の単体凍結）

Phase 0a で保存した `{capture JSON, RecordContext JSON}` を新旧 `buildRunRecord` に流し、生成 record がバイト同一であることを assert する。

**前提の明記:** `buildRunRecord` は `ctx.worktree` に対して実 fs read を行う（`src/adapters/vitest/recorder.ts:89-99` の `test_sources` / `config_sources` digest。ファイル欠落時は digest が `null` で silently drop され record が変わる）。したがって shift-bud capture の replay は **pin した SHA の tree を記録時と同一の絶対パスに復元してから**行う必要がある。素の unit test ではない。

#### Step 1 副基準2: shift-bud live 再記録（confirmatory）

Phase 0a で記録した run_id 群と、Step 1 完了後に同じ tree T で記録した run_id 群が完全に一致すること。**前提条件チェックリスト**（下記 baseline manifest に記録し、比較前に検証する）:

- shift-bud の commit SHA が pin 値（`8cf90518` 相当）と一致
- 記録に使う worktree の**絶対パス**が同一
- vdelta の `package.json` version が同一
- node version が同一
- `CI` / `NODE_ENV` / `TZ` / `LANG` の値が同一

**コントロール証明:** Phase 0a 時点で、同一バージョンの vdelta で2回録って run_id が安定することを先に確認する（255 test files の evidence 決定性は未確認であり、これを確認せずに副基準2 を回すと何が壊れたか切り分けられない）。

#### baseline manifest 仕様

veridelta repo 内 `probes/shift-bud-baseline/` に置く（shift-bud 側の `.veridelta` store は gitignore され auto-GC もかかる — `src/run.ts:300-311` — ため、そこに置くと Phase 0a から Step 1 までの間に根拠 record が蒸発しうる）。

- **(a) 前提条件:** shift-bud commit SHA / 記録時の絶対パス / vdelta version / node version / env 4変数
- **(b) 6 run 分の** `{capture JSON, RecordContext JSON, 生成 RunRecord, run_id}`
- **(c) replay 手順:** pin した SHA を記録時と同一絶対パスに checkout してから `buildRunRecord` replay を行う旨の明記
- **受け入れ基準に含める:** run_id 不一致時に、保存 record と再生成 record の**構造 diff で原因フィールドを特定できる**こと（run_id は不透明ハッシュなので、run_id 文字列だけを保存すると診断不能）

#### Step 2

- conformance suite が green であること
- `report.failure_evidence.degraded_capabilities` が vitest について `['source-region-text']` のままであること（§4.2 の導出規則の機械判定）
- run_id の変化は、宣言した `instrument.capabilities` group の差分としてのみ説明可能であること

---

## 9. Non-goals

- CI gate の組み込み（Phase 0a / 1 / 2 いずれでも）
- ambient recording（spec §4.2）の実装 — §10 F-1
- `selector-relation` capability の**実装** — §10 F-5（Phase 1 では interface の席のみ）
- `pytest` / JUnit XML adapter — spec §12 で demand-driven
- Rust / `cargo test` adapter — roadmap 外。dogfood 対象が薄く（自前 Rust repo は 668〜2562 行 / test 0〜31 件、nextest 設定なし）、構造化チャネルが nightly・experimental・spec が格下げした lossy な JUnit のいずれかに依存する
- coverage adapter（spec Appendix A.4）
- `veridelta/2` — §7 kill criterion が発火した場合にのみ再検討

---

## 10. Follow-up（本設計のスコープ外だが記録する）

| # | 内容 | 根拠 |
| --- | --- | --- |
| F-1 | **ambient recording の実装** — spec §4.2 が RECOMMENDED と規定するデプロイ形態が未実装。CLI-wrapper-only では shift-bud のような wrapper script 中心の repo から signal が取れない | §3.4 |
| F-2 | **capture チャネルの per-process 化** — F-1 の前提。`VDELTA_CAPTURE_FILE` 単一パスは multi-process fan-out で last-writer-wins になる。あわせて channel の生成・破棄を core から adapter へ移す（§4.1 の残存リーク） | §3.4 付随ハザード / §4.1 |
| F-3 | `env_fingerprint` を `STREAM_KEY_FIELDS` に含めるかの検討 — 現状 `CI` は開示のみで stream 分離しないため、local↔CI の instrument 差が stream 上では見えない。**両 adapter 共通課題** | §4.1.1 |
| F-4 | vitest 4.x フラグ表（`src/run.ts:72-119`）の同期機構 — 既知 open question（#15）。Phase 1 で `src/adapters/vitest/` に移動するが、同期問題自体は残る | §3.1 |
| F-5 | **`selector-relation` capability の実装** — これ無しでは `src/compare.ts:309-311` により containment が永久に `selector-relation-unknown` に落ち、backend の `test` / `test:all` subset 関係（spec §5.2 `previous-superset` / §6.1 `subset`）を実データで踏めない | §3.4 副産物 / §4.1 |

---

## 11. Risks

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| flaky base rate が高い | D2 破棄 → `/2` | §7 kill criterion（数値化済み）で判定。Phase 1 は D2 と独立に進行できるため損失は probe 設計時間のみ |
| `@playwright/test` 1.49.1 の reporter API 面が想定と異なる | Phase 0b やり直し | probe をバージョンに紐づけて記録（§6 Phase 0b-core-7）。shift-bud の実測値で probe する |
| shift-bud e2e のテナント系8件がローカルで構造的に赤（#1086 × `DEV_TENANT_SLUG`） | Phase 2 の baseline が赤 | **むしろ好材料**。「既存赤が別の赤に変異したか」を言い分けるのが vdelta の中核価値であり、理想的な demo subject。ただし `DEV_TENANT_SLUG` 依存を probe 記録に残す |
| **release-please が Phase 0a〜Step 1 の間に `package.json` version を bump する** | `instrument.adapter_version` が変わり run_id 一致基準が**偽陽性で崩壊**する（本 repo は自動リリース運用中 — 直近 `chore(main): release 0.2.2`） | §8.3 主基準の **`VDELTA_VERSION` 一致 assert**（不一致なら明示的診断で abort）。副基準2 は前提条件チェックリストで検証 |
| node / 絶対パス / env / commit 日時のドリフト | 同上 | §8.3 主基準は固定ワークスペースパス + 固定 git 日時 + 同一 node プロセスで構造的に排除。副基準2 は前提条件チェックリストで検証 |
| Phase 1 Step 1 で run_id / report が一致しない | 挙動変化の混入 | それが検出目的。差分を特定して Step 1 に戻す（受け入れ基準を緩めない）。baseline manifest の構造 diff で原因フィールドを特定する |
| 依存 skip カスケードを surface 縮小と誤判定 | INV-9 の狼少年化、または spec §11.1 floor 違反 | §3.3.1 の決定木（attribution 付き開示 + blocking set からのみ除外、区別不能時の fallback、最終手段は「狼少年を受容して文書化」）に従う。§12-4 も参照 |
| shift-bud（外部 private repo、`dev` branch 稼働中）に到達できない | Phase 0a / 0b-field がブロック | Phase 0a′（self-dogfood + 合成モノレポ bench）と 0b-core / 0b-field の分割。**Phase 2 のゲートは 0b-core のみ** |

---

## 12. 未決の設計判断

以下は討論で決着しなかった論点である。**推測で埋めない。** 各行の「解決条件」を満たした時点で本文へ昇格させる。

| # | 論点 | 立場A | 立場B | 何を決めれば解決するか |
| --- | --- | --- | --- | --- |
| **§12-1** | `fail → flaky` のみ（他に regressed 要因なし）のときの **gate verdict** | default gate-relevant set は spec §9.1 通り不変とし、gate はブロックせず件数 + anchor を必ず開示（pass-with-disclosure）。flaky 1件で CI が exit 2 に汚染される洪水を避ける | `verification_inconclusive` 非空を gate の `triggered` または `inconclusive` に反映する。baseline の red が消えたのに gate が pass する経路を作らない | 0b-field の base rate 実測と、gate report の消費者（PR コメント / required check）の要件。**`outcome_verdict` = `inconclusive`（`unchanged` 禁止）は合意済み。gate 側のみ未決であり、これが決まるまで Phase 2 の flaky fixture は書かない** |
| **§12-2** | kill criterion 2 の判定線 | `report` 本文 + anchors（spec §9.3 progressive disclosure）込みで充足できない機械可読要求があれば kill | annex を開かず report 本文だけで回答できない triage シナリオが1つでもあれば kill | anchor 経由の drill-down を D2 の正当な充足手段と認めるか。spec §9.3 が anchors を正規機構と定める以上、認めない側に立つと **D2 は設計通り動いても kill される**（自己矛盾）— この整合性をどう扱うか |
| **§12-3** | comparator の flaky トリガーの適用条件 | 素の `c.finding !== undefined`（Step 1 の間でも動く） | capability ゲート付き（current record が `retry-evidence` を宣言する場合のみ）。将来の adapter が別目的で pass に finding を付けたときの silent 誤発火を防ぐ | capability の record 化は Step 2 なので、B を採ると flaky マッピングは Step 2 以降にしか動かない。**Step 順序との依存関係込みで決める** |
| **§12-4** | 依存 skip カスケードの comparator 表現 | attribution 付き開示 + blocking set からのみ除外（spec §11.1 floor 適合） | `/1` draft 改訂で floor に attribution 例外を切る | 0b-core-5 で dependency skip が構造化チャネル上で区別可能と確認された後、「報告はするが依存起因と機械可読に言い分ける」で狼少年問題が実用上解消するかの実測判定 |
| **§12-5** | 未知 adapter 名を持つ record に対する abstention reason | 暫定 `adapter-crashed`（`kind: failed`、最近傍）で運用し、専用 reason は Step 2 の spec 改訂項目に載せる | Step 2 の `/1` draft 改訂で専用 reason（例 `adapter-unknown`）を追加してから実装する | Step 1 期間中にこのケースが実際に到達可能か。registry 登録 adapter しか record を書かないため、外来 store / 改竄経由でのみ発生する — **到達不能なら暫定案で足り、spec 改訂項目としての記録のみでよい** |
| **§12-6** | `adapter-capability-changed` イベントの二重意味 | 既存発火（instrument 同一性差分 — `src/compare.ts:290-301`）と per-capability 差分発火を同一 kind に同居させる | 発火条件を1つの規則に再定義する | Step 2 で per-capability 差分が実際に単独で起きうるか（`adapter_version` bump なしに capabilities だけ変わる経路があるか） |
| **§12-7** | `integrityFailedReport`（`src/gate.ts:133-176`）の `composition_id` / `degraded_capabilities` のソース | sentinel 文字列（record 不読時の固定値） | `readRunMeta` を試行してから fallback | capability を record 宣言に移すと、record が読めない状態（`StoreCorruptError`）でソースが無くなる。schema は `composition_id: string` を必須とするため**空にはできない** |
| **§12-8** | kill criterion 1 の実行回数 `N` | 10回連続 | 下限3回 + 事前登録（app スタック起動・auth setup を要する suite では10回は重い） | Phase 0b 開始前に一度だけ確定する。CI 実行データで代替する場合の等価な N も同時に決める |

---

## 13. 実装スコープ（このリポジトリ内で完結する範囲）

外部リポジトリ（shift-bud）を必要とする作業は**この節から明示的に除外する**。本節の項目はすべて veridelta repo 内で完結し、テストで機械判定できる。

### Phase 1 Step 1（record 内容を1バイトも変えない）

| ファイル | 変更 | 完了条件（機械判定） |
| --- | --- | --- |
| `src/adapter.ts` | **新設**。§4.1 の型と `Adapter` interface、`AdapterCaptureError` | `tsc --noEmit` が通る |
| `src/adapters/registry.ts` | **新設**。静的配列 `[vitestAdapter]`（Phase 2 で playwright 追加）、名前解決 + 全評価 detect | 新規 unit test: 未知名で throw、全評価で複数一致を検出、順序が決定的 |
| `src/adapters/vitest/adapter.ts` | **新設**。`reporterModulePath` / `findVitestToken` / `VITEST_VALUE_FLAGS` / `splitCommandSelector` を `src/run.ts:53-165` から移設し `vitestAdapter` に束ねる。`VITEST_CAPABILITIES` 定数を置く（Step 1 では record に載せない） | `tests/unit/run.test.ts` が**無改変で** green（`src/run.ts` からの re-export 維持 = 公開 API 凍結） |
| `src/adapters/vitest/recorder.ts` | `RecorderError extends AdapterCaptureError`、`RecordContext` を `src/adapter.ts` から re-export | 既存 unit / conformance が green |
| `src/run.ts` | registry 解決に置換。`capture` の `JSON.parse` を削除し `adapter.record(channel, ctx)` へ。`splitCommandSelector` は re-export で維持 | conformance 46 fixture green |
| `src/compare.ts` | `:7-8` の静的 import 除去 → `record.instrument.adapter` で registry lookup（§4.2 interim 規則） | 全 report の `composition_id` / `degraded_capabilities` が現行とバイト同一 |
| `src/gate.ts` | `:9-10` 同上。`integrityFailedReport` は §12-7 決着まで現行定数を維持 | 同上 |
| `src/index.ts` | `:10-11` の re-export 元を registry 経由に変更（**公開シンボル名は不変**） | `con-*` fixture green + 公開 export 一覧の差分ゼロ |
| `src/cli.ts` | `--adapter <name>` フラグ。未知名は exit 1（§4.3-5） | 新規 CLI test: 未知名 exit 1 / stderr に既知一覧、明示指定が detect に優先 |
| `tests/conformance/runner.ts` | dual-binary モード（§8.3 主基準の機構1〜6） | 自己テスト: 同一 binary 同士の A/B が全 fixture で run_id + report 一致 |
| `tests/conformance/ab-replay.test.ts` | **新設**。baseline `dist` のパスを env で受け、無指定なら skip | CI で baseline build を用意した場合に green |

**Step 1 全体の完了条件:** §8.3 主基準（A/B replay で run_id 完全一致 + report バイト同一）+ conformance 46 fixture green + `VDELTA_VERSION` 不変。

### Phase 1 Step 2（record 形状変更、`adapter_version` bump を伴う）

| ファイル | 変更 | 完了条件（機械判定） |
| --- | --- | --- |
| `src/schema.ts` | `CAPABILITY_VALUES` 追加、`RunRecord.instrument.capabilities` 追加、`parseRunRecord` の `instrument` `checkKeys`（`:729-735`）と値の `asEnum` 検証、`EVIDENCE_CAPABILITY_NAMES` 定数 | `con-runrecord` fixture 更新版が green。未知 capability *値* で throw、未知 capability *名* は受理 |
| `src/adapters/vitest/recorder.ts` | `capabilities: VITEST_CAPABILITIES` を record に載せる。`adapter_version` bump | run_id の変化が `instrument.capabilities` の追加のみで説明できること（構造 diff で確認） |
| `src/compare.ts` / `src/gate.ts` | `degraded_capabilities` を §4.2 の導出規則（record の capabilities から）で計算 | **vitest について出力が `['source-region-text']` のままバイト同一**（`adv-degraded-capability` 等が green） |
| `spec/veridelta-1.md` | 0.x draft 改訂: §3.1 `instrument` 行に `capabilities`、§3.2 `finding` に非 red MAY、Revision history 追記 | spec と実装の突き合わせ（`con-*` fixture） |
| `conformance/fixtures/` | 新規: capability 宣言の record 表現、旧新 record 混在時の `instrument-changed` abstention | 新 fixture green |

**Step 2 全体の完了条件:** §8.3 Step 2 基準（conformance green + `degraded_capabilities` バイト同一 + run_id 差分が capabilities group で説明可能）。

### この節から除外する作業（外部リポジトリ必須）

- Phase 0a の shift-bud 6ストリーム記録と baseline manifest の**生成**（仕様は §8.3 に定義済み、生成には shift-bud が要る）
- Phase 0b-field（flaky base rate の実測）
- §8.3 副基準1・副基準2 の**実行**（ハーネス自体は in-repo で書ける）

---

## 改訂履歴

- **2026-07-28 rev.1（初版, status: proposed）** — 初稿。
- **2026-07-28 rev.2（status: revised）** — 事実確認と敵対的レビューを統合。誤引用の訂正（`src/run.ts:15-19` の import 内容、`DEGRADED_CAPABILITIES` の実 import 行 `compare.ts:8` / `gate.ts:10` / `index.ts:11`、`VITEST_VALUE_FLAGS` の実範囲 `run.ts:72-119`、shift-bud e2e 規模「53 spec」→「14 spec ファイル / `test()` 171 箇所」、「46 fixture + determinism proof」の二重計上）。§4.1 を実装可能な TypeScript に置換し §4.1.1（config_digest 共通契約、旧 §3.3-3 の誤記訂正を含む）を新設。§4.2 に capability の具体スキーマと Step 1 interim 規則を追加。§4.3 に検出・registry の決定リストを追加。§5 案B の却下理由を「非効率」から「spec §9.1 違反出力の出荷」へ格上げ。§6 を Phase 0a′ / 0b-core / 0b-field に分割。§7 に実装機構・outcome 導出・数値化した kill criterion を追加。§8.3 を in-repo A/B replay 主基準 + capture replay + shift-bud confirmatory の三層に再構成し baseline manifest 仕様を定義。§3.3.1（依存 skip カスケードの決定木）、§12（未決の設計判断 8件）、§13（実装スコープと機械判定可能な完了条件）を新設。§10 に F-5、§11 に release-please / 環境ドリフト / 外部リポジトリ依存のリスク行を追加。
