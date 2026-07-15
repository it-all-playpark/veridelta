# expC: vitest failure-evidence フィールド感度実測レポート

## 環境
- Node **v24.18.0** / **vitest 4.1.10** / **vite 8.1.4** / **@vitest/runner 4.1.10** / TypeScript **7.0.2**（`tsgo`系）
- 作業ディレクトリ実体: `/private/tmp/claude-501/expC/`（job tmp は sandbox 書込不可のため TMPDIR 側に構築。report md のみ Write ツールで job tmp に配置）
- 構造化チャネル: **vitest v4 Reporter API**（Reported Tasks モデル）。カスタム reporter (`reporter.ts`) を config の `reporters:[]` に instance で渡し、`onTestCaseResult(tc)` で `tc.result()`・`tc.diagnostic()`・`tc.location`・`tc.id`/`tc.fullName`/`tc.module.moduleId` を、`onUserConsoleLog(log)` で captured 出力を taskId 別に収集し、`onTestRunEnd` で JSON dump。
- error 型（`@vitest/utils` の `TestError extends SerializedError`）: `{ name, message, stack, stacks:ParsedStack[], expected?, actual?, diff?, cause?, [key]:unknown }`。`ParsedStack = { method, file, line, column }`。実測で追加キー `operator` / `showDiff` / `ok`（AssertionError 時）、`constructor` / `toString`（plain Error のシリアライズ placeholder）を確認。
- サンプル 7 定義 = 9 観測（test.each で 3 展開）: 値 assert(toBe) / deep-eq(toEqual, diff付) / 本体 throw / **beforeEach hook throw** / parametrize 一部失敗 / **captured 非決定値付き失敗** / **test.fails が pass する xpass**。
- `test.includeTaskLocation: true` を有効化（既定 false だと `tc.location` が `undefined`）。これは instrument config の一部として宣言対象（後述 S5 と同じ経路）。

## 実測シナリオ
| ID | 操作 | 目的 |
|----|------|------|
| S0 | baseline | 基準 dump |
| S1 | コード無変更で再実行 | 再実行安定性（CE-2） |
| S2 | ファイル先頭にコメント3行挿入 | 行シフト感度（CE-3） |
| S3 | 無関係ヘルパ `helperNoise` 本体変更（行数不変） | 無関係編集の不変性 |
| S4 | `getStatus()` の返値 500→404（in-place・行シフト無し） | 真のシグナル変化 |
| S5 | `chaiConfig.truncateThreshold` を 0/40/9999 | runner config が evidence に与える影響（pytest `--assert=plain` 相当） |
| S6 | 500→404→500 を同一サイズ + `touch -r` で mtime 偽装 | stale transform-cache 経路の有無（pytest `__pycache__` 相当） |

---

## 1. フィールド一覧表（× S1再実行 × S2行シフト × S4シグナル性 × S5 config 感度）

凡例: **不変**=値が変わらない / **変化**=値が変わる。

| フィールド（error / case） | S1 再実行 | S2 行シフト | S4 シグナル性 | S5 trunc感度 | 分類 |
|---|:--:|:--:|:--:|:--:|---|
| `id` / `fullName` / `name`(test名) | 不変 | 不変 | 不変(識別子) | 不変 | identity |
| `state`(verdict) | 不変 | 不変 | 不変(*) | 不変 | signal(状態遷移時のみ) |
| `modulePathRel` | 不変 | 不変 | 不変 | 不変 | core |
| `diagnostic.duration` / `.startTime` | **変化(毎回)** | 変化 | 変化 | 変化 | **pure noise** |
| `diagnostic.retryCount`/`repeatCount`/`flaky` | 不変 | 不変 | 不変 | 不変 | core(retry状態) |
| `error.name`(例外型) | 不変 | 不変 | 不変(型不変時) | 不変 | **CORE (exc type)** |
| `error.message`(値シグナル入り) | 不変 | **不変** | **変化** | **変化(truncで表現変)** | **CORE signal** |
| `error.expected`(構造化) | 不変 | **不変** | **変化** | 不変(*trunc非依存) | **CORE signal** |
| `error.actual`(構造化) | 不変 | **不変** | **変化** | 不変(*trunc非依存) | **CORE signal** |
| `error.operator`(strictEqual等) | 不変 | 不変 | 不変 | 不変 | core |
| `error.diff`(レンダ済み差分文字列) | 不変 | **不変** | **変化** | **変化(trunc依存)** | derived/presentation |
| `error.showDiff` / `error.ok` | 不変 | 不変 | 不変 | 不変 | presentation |
| `error.stacks[].method`(関数名) | 不変 | 不変 | 不変 | 不変 | **常に空文字（後述の欠落）** |
| `error.stacks[].file`(**絶対**パス) | 不変 | 不変 | 不変 | 不変 | volatile(env依存) |
| `error.stacks[].line`(**絶対**行) | 不変 | **変化 +3** | 不変 | 不変 | positional |
| `error.stacks[].column` | 不変 | 不変 | 不変 | 不変 | positional |
| `error.stack`(生 traceback 文字列) | 不変 | **変化**(行番号+絶対path埋込) | **変化**(message埋込) | 変化 | **derived/fragile** |
| `tc.location.line`(test定義行) | 不変 | **変化 +3** | 不変 | 不変 | positional |
| relOffset = crashLine − location.line（**算出値**） | 不変 | **不変** | 不変 | 不変 | **CORE (position, CE-3)** |
| console(`onUserConsoleLog`).content/time | **変化**(非決定test) | 変化 | 変化しうる | 変化 | **volatile / 別チャネル** |

**実測 diff サマリ**（`differ.mjs` の changed-leaf を末尾フィールド名で bucket 集計）:
- S0↔S1: `duration×9  startTime×9  content×1  time×1`（**error evidence は全フィールド不変**。変化は timing と非決定 test の console のみ）
- S0↔S2: `line×15  stack×6  duration×9  startTime×9  content×1  time×1`（**message/expected/actual/diff/name/operator/relOffset は変化ゼロ**。動くのは絶対行番号系のみ）
- S0↔S3: `duration×9  startTime×9  content×1  time×1`（**S1 と同一＝無関係編集で evidence 完全不変**）
- S0↔S4: `actual×2  diff×2  message×2  stack×2  duration×9  startTime×9  content×1  time×1`（**line 変化ゼロ**。シグナルは actual/message/diff にのみ現れ、位置とは直交）

要点:
- **S2(行シフト)で動くのは絶対行番号系のみ**（`stacks[].line`, `tc.location.line`, および行番号を埋め込む生 `stack`）。**message・expected・actual・relOffset は完全不変。**
- **S1(再実行)で error evidence は 1 フィールドも変わらない**。変化は `duration`/`startTime`（timing）と、非決定 console を出す 1 test の `content`/`time` のみ。
- **console は `onUserConsoleLog` の完全独立チャネル**で、`error.message`/`stack` に一切混入しない（pytest の `sections` が longrepr と別だったのと同じ、ただし分離がより明確）。
- **S4 の真のシグナル(500→404)は `actual`/`message`/`diff` にのみ現れ、`line` は不変**（in-place 編集）。message 変化と行番号変化は直交。

---

## 2. digest core の定義と sha256 実測

**digest core（per red-test、正規化・不変性保証の対象）**
- `error.name`（例外型）
- `error.message`（値シグナル入り。plain throw では唯一の signal）
- `error.expected` / `error.actual`（assertion 時の構造化値。message より truncation 非依存で頑健）
- `error.operator`
- **位置(CE-3 安定形)**: `relOffsets = (test module 内の各 stack frame の line) − tc.location.line`。絶対行を含まず、行シフトで def と crash が同量ずれるため不変。

**除外（volatile annex 行き）**: `diagnostic.duration`/`startTime`、`stacks[].file`(絶対path)、`stacks[].line`/`column`(絶対位置)、生 `stack`、console 全体、`tc.location.line`(絶対)、`diff`（レンダ済み派生・trunc 依存）、`constructor`/`toString`(シリアライズ artifact)、`showDiff`/`ok`(presentation)。

**実測（`digest.mjs`、失敗 test 群の core を sha256 → 先頭16hex）**:
```
variant     S0                S1        S2        S3        S4
core        c0c93ed98634b0fd  =SAME     =SAME     =SAME     c42fb9f5(DIFF)
+console    (毎回別)          BREAKS    BREAKS    BREAKS    BREAKS
+absLine    a761b792…         =SAME     BREAKS(S2) =SAME    (coreごとDIFF)
+diff       50f3ba0c…         =SAME     =SAME     =SAME     DIFF(S4)
+duration   (毎回別)          BREAKS    BREAKS    BREAKS    BREAKS
+stackRaw   c6bc3fd5…         =SAME     BREAKS(S2) =SAME    DIFF(S4)
```
→ **core は S0=S1=S2=S3 で完全一致、S4 でのみ変化**。狙い通りの感度特性（expB pytest と同一の判定基準を達成）。
- `+console` / `+duration` を混ぜると **S1(無変更再実行)で即破綻** → digest identity から除外必須。
- `+absLine` / `+stackRaw` は **S2(行シフト)で破綻** → 絶対行・生 stack は除外必須。
- `+diff` は S1/S2/S3 では安定（diff は行番号を埋め込まない）が、**S5 で trunc 依存に破綻**するため CE-4（レンダ文字列非依存）に従い除外。

S6 の core も一致確認: `S6a_500=S6c_revert500=S6e_nocache500=c0c93ed9`（=S0）、`S6b_404=c42fb9f5`（=S4）。全実験を通じ 500→c0c93ed9 / 404→c42fb9f5 で完全整合。

---

## 3. 問い1〜5への実測ベース回答

### Q1. CE-1 充足性（例外型・値入り message／構造化 expected/actual・traceback 構造・**failing source region のソース行テキスト**）
**条件付き YES（3/4 を構造化チャネルが提供、ソース行テキストのみ欠落）。**
- 例外型: `error.name`（`AssertionError` / `Error`）✓
- 値入り message: `error.message`（`expected 500 to be 200 // Object.is equality`）✓ さらに **構造化 `expected`/`actual`**（`"200"` / `"500"`、object 時は pretty-print 済み）を別フィールドで提供 ✓✓（pytest は reprcrash.message の 1 本のみ。vitest は message＋構造化値の二重で **むしろ優位**）
- traceback entry 構造: `error.stacks[]`（`{method,file,line,column}`、node_modules 内部フレームは除去済み）✓
- **ソース行テキスト: 構造化チャネルに存在しない（欠落）。** raw dump を `expect(resp).toBe(200)` で grep → **0 件**。terminal の default reporter は code frame（行13-15 のソース＋caret）を出すが、これは reporter が表示時に `stacks[0].{file,line}` からソースファイルを読み再構成したもので、worker→main に転送される error オブジェクトには含まれない。→ **CE-1 の「as provided by the runner's structured channel」を厳密に取ると、source region text は vitest では unsupported**。adapter が絶対 `file:line` からソースを読めば再構成可能だが、(a) 絶対path＋絶対行への再結合が発生し CE-3 の行安定性を損なう、(b) runner 提供ではなく adapter によるソース読取りになる。→ **capability として `unsupported` 宣言、または composition で「adapter 再構成・offset正規化つき」を明示、の二択**。pytest（`entries[].lines` がソース行テキストを行番号なしで構造化提供）に対する明確な劣位点。

### Q2. CE-2 充足性（core を組んで S1/S2/S3 不変・S4 のみ変化。除外必須フィールド）
**YES（実証済み、§2 の sha256）。** core = `{name, message, expected, actual, operator, relOffsets}` で S0=S1=S2=S3、S4 のみ変化。**除外必須**:
1. `diagnostic.duration` / `startTime`（毎回変化）
2. console 全体（`onUserConsoleLog`。非決定値を出す test で S1 破綻）
3. 絶対行番号系（`stacks[].line`, `tc.location.line`, 生 `stack`）— S2 破綻
4. `diff`（CE-4：レンダ済み派生文字列。S5 trunc 依存）
5. `constructor`/`toString`（plain Error のシリアライズ artifact。`Function<Error>` 等）

**pytest との差**: pytest で警戒した `reprfuncargs`（run-scoped path を運びうる補助フィールド）に相当する**補助フィールドが vitest には無い**。run-scoped 値を運びうるのは意図的な `expected`/`actual`/`message`（＝それ自体が signal）のみで、これは §3.6 の known-limitation（同一 tree でも実行毎に変わる値は honest な `updated_fail`）でカバーされる。→ vitest は「除外すべき補助 volatile フィールド」が pytest より少なくクリーン。

### Q3. CE-3 充足性（位置の安定形。source map 解決後 lineno は S2 でどう動くか）
**YES（ただし enclosing symbol は stack から取れない点に注意）。**
- source map: `stacks[].line` も `tc.location.line` も **.ts のソース行に解決済み**（例: toBe の crash は line 15 = `expect(resp).toBe(200)` の行）。S2 で両者とも **+3** シフト。
- **enclosing symbol 欠落**: `stacks[].method` は arrow 関数 test callback では **常に空文字**（`test('...', () => {...})` に名前が無いため）。→ pytest の `location[2]`（関数名）に相当する「囲むシンボル名」は stack からは得られない。
- 代替アンカー: **`tc.fullName`（test 識別子）＋ relOffset = crashLine − tc.location.line**。両行が同量シフトするため relOffset は S2 不変（実測: core が S0=S2 で一致）。`tc.location` を得るには `includeTaskLocation: true` が必須（instrument config の一部として宣言）。
- 絶対 lineno は annex（human ナビ用）に退避。→ CE-3 は「fullName + relOffset」で満たせるが、**位置アンカーの構成が pytest（関数名がタダで取れる）より一手間**。

### Q4. stale cache 経路の有無（S6）
**経路は存在しない（vitest run mode）。** 同一サイズ 500↔404 反転 + `touch -r` で mtime を凍結しても、報告値は常に現在のソース内容:
```
S6a content=500 mtime凍結  -> actual=500  core=c0c93ed9
S6b content=404 mtime凍結  -> actual=404  core=c42fb9f5   (stale 500 を出さない)
S6c content=500 mtime凍結  -> actual=500  core=c0c93ed9   (pytype攻撃と同型: 同サイズ revert+mtime偽装 でも stale 404 を出さない)
S6e content=500 .vite削除  -> actual=500  core=c0c93ed9
```
理由: `vitest run` は毎回新規プロセスで、Vite が .ts をメモリ内 esbuild 変換する。ソースのコンパイル成果物を **mtime/size キーで永続化する cache が無い**。実在する cache は `node_modules/.vite/vitest/<hash>/results.json` = `{version, results:[[":path",{duration,failed}]]}`（テスト順序付け用の duration/pass-fail のみ）で **evidence を持たない**。`.vite` を grep しても `getStatus`/`return 500`/`return 404` は 0 件。
→ **§4.5 の pytest `__pycache__` 相当の neutralization は vitest run mode では不要**。§13.2(b) stale-cache collision fixture は vitest では「no-op でパスする」ことを実測で確認。
- 残る caveat（evidence 経路ではない）: (1) watch mode は長寿命プロセスで in-memory module graph を保持するが、記録は run mode 前提で対象外。(2) `optimizeDeps`（`node_modules/.vite/deps`）は **node_modules 依存の pre-bundle 専用**でユーザーソース／evidence には無関係、キーは config/lockfile hash（instrument identity・§11.5 lockfile の範疇）。
- 宣言上の推奨: adapter は run-scoped `cacheDir`（または `.vite` 削除）を宣言してもよいが、**stale-source を防ぐ目的では必須でない**。pytest が `PYTHONPYCACHEPREFIX` を必須とするのと非対称。

### Q5. 選外事項（考察レベル）
**(a) selector 意味論の containment 決定可能性**:
- path/glob 引数（`vitest run src/foo.test.ts`, glob）→ **decidable**（path prefix / glob 包含で subset/superset 判定可）。
- `-t` / `--testNamePattern <regex>`（fullName への正規表現）→ **undecidable → `unknown`**（pytest `-k`/`-m` と同型）。
- `--changed`（git diff ベースで影響 test を動的選択）→ git 状態依存で固定 selector に対する含意が動的 → **`unknown`/dynamic**。
- `--project <name>`（workspace filter）→ project 集合の包含で decidable。
→ pytest と同じ「path は decidable / 式フィルタは unknown」の二分。§6.4 の `selector_relation` capability はそのまま移植可能。

**(b) worker 並列（pool: threads/forks）の recorder 設計への影響**:
- v4 既定は `pool:'forks'`（child_process）。`threads`（worker_threads）も可。**Reporter は main プロセスで走り、`onTestCaseResult` は worker からシリアライズ済み `SerializedError` を受け取る**ため、recorder は worker に触れず単一集約ストリームを見る（pool 非依存で evidence 内容は同一）。
- **唯一の設計要件は順序非決定性**: 並列 worker では `onTestCaseResult` の到着順が非決定。recorder は digest 前に **安定キー（test_id/fullName）でソート必須**（本実験の reporter・digest は実装済み）。`fileParallelism`/`maxWorkers` は duration にのみ影響し evidence には無影響。
→ pytest（既定シリアル、xdist で並列）より「並列がデフォルト」な分、**順序正規化は必須事項**として §7.8 determinism に効かせる必要がある。

---

## 4. 総合判定

**vitest adapter は CE-1〜CE-5 を満たせるか: 条件付き YES。**

| 要件 | 判定 | 根拠 |
|---|---|---|
| CE-1 signal completeness | **条件付き**（3/4） | 例外型・値入りmessage・構造化expected/actual・traceback構造 ✓／**ソース行テキストは構造化チャネルに無し**（unsupported 宣言 or adapter 再構成を明示）|
| CE-2 rerun stability | **YES** | S1 で error evidence 全フィールド不変。除外対象は duration/console/絶対行/生stack/diff。補助 volatile フィールドが pytest より少ない |
| CE-3 position stability | **YES**（一手間） | source map 解決済み。**enclosing symbol は stack から取れず（method=""）**、`fullName + relOffset(crash−location.line)` で構成。`includeTaskLocation` 必須 |
| CE-4 structured fields only | **YES** | message/expected/actual/name/operator の構造化フィールドで digest 構成。生 `stack`・`diff` を排除 |
| CE-5 whole-field granularity | **YES** | フィールド単位で included/excluded。値レベル書換なし |

**core digest 実測: S0=S1=S2=S3=`c0c93ed98634b0fd`、S4のみ`c42fb9f56dcf1cbc`**（§3.6 rerun stability / §13.2(a) 充足）。

**pytest 比較（evidence チャネルの優劣）**:
| 観点 | vitest | pytest | 優劣 |
|---|---|---|---|
| 値シグナル | `message` ＋ 構造化 `expected`/`actual`/`operator` の**二重** | `reprcrash.message` 1本（rewriting 依存） | **vitest 優**（構造化値が別フィールド） |
| ソース行テキスト | **無し**（要 adapter 再構成 or unsupported） | `entries[].lines`（行番号なしで構造化提供） | **pytest 優** |
| enclosing symbol | `stacks[].method=""`（arrow で欠落）→ fullName で代替 | `location[2]` 関数名がタダ | **pytest 優** |
| 補助 volatile | reprfuncargs 相当が**無くクリーン** | reprfuncargs が run-scoped path を運びうる | **vitest 優** |
| console 分離 | `onUserConsoleLog` 完全独立チャネル | `sections` が report 内だが分離済み | **vitest 優**（別コールバック） |
| config 感度 | `truncateThreshold` が message truncation を変化（要 instrument digest） | `--assert=plain` で値シグナル消失／`--tb` で書式変化 | 同等（両者とも instrument digest 必須） |
| stale cache | **経路なし**（run mode。neutralization 不要） | `__pycache__` rewrite pyc が stale evidence を出す（`PYTHONPYCACHEPREFIX` 必須） | **vitest 優** |
| verdict channel | `state`＋`test.fails`→failed を runner が判定（INV-3 準拠可） | outcome＋strict xfail→fail | 同等 |
| 並列 | 既定並列（forks）→順序正規化必須 | 既定シリアル | pytest やや楽だが両者ソートで解決 |

**結論**: evidence チャネルとしては **一長一短で、MVP 第1 adapter を vitest に反転することは技術的に妥当**。vitest は「構造化 expected/actual の二重シグナル」「補助 volatile の少なさ」「console の完全分離」「**stale cache 経路が無く §4.5 neutralization が不要**」で pytest より **記録側の実装が単純**になる。代償は 2 点の位置系欠落 —（i）ソース行テキストが構造化チャネルに無い（CE-1 を厳密には満たせず capability 宣言 or adapter 再構成が要る）、（ii）enclosing symbol が arrow test で取れず `fullName + relOffset` 構成が必要（`includeTaskLocation` 必須）。いずれも digest の不変性・シグナル性（Q2/§2 で実証）を損なわず、composition の宣言で吸収可能。**判定: 条件付き YES で vitest 反転を支持。ブロッカーは無い。**

---

## 5. raw dump / スクリプト パス一覧

ベース: `/private/tmp/claude-501/expC/`（`$TMPDIR/expC` と同一実体）
- スクリプト: `reporter.ts`（evidence dumper, v4 Reporter API）, `src/sample.test.ts`（7定義/9観測）, `vitest.config.ts`（S0-S4/S6 用, includeTaskLocation:true）, `vitest.s5.config.ts`（TRUNC env 可変）, `digest.mjs`（core/variant sha256）, `showcore.mjs`（core フィールド表示）, `differ.mjs`（field-level diff bucket）, `run_scenarios.sh`（S0-S4 harness）, `s6_stale.sh`（stale-cache probe）
- dump（`dumps/` 配下、各キー = `[{id,fullName,state,location,diagnostic,errors[],console[]}]`）:
  - `S0.json` / `S1.json` / `S2.json` / `S3.json` / `S4.json`
  - `S5_trunc0.json` / `S5_trunc40.json` / `S5_trunc9999.json`（truncateThreshold 別）
  - `S6a_500.json` / `S6b_404.json` / `S6c_revert500.json` / `S6d_404b.json` / `S6e_nocache500.json`（stale-cache probe）
- 注意: job tmp（`/Users/naramotoyuuji/.claude/jobs/e0d8df14/tmp/`）は sandbox 書込不可のため raw 実体は TMPDIR 側。本 report md のみ job tmp に配置（Write ツール経由）。
