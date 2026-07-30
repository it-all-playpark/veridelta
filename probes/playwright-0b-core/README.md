# Playwright Phase 0b-core probe

`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md`（以下「設計 doc」）
**§6 Phase 0b-core**（shift-bud 非依存 / **Phase 2 のゲート**）の実測記録。issue #53 の成果物であり、
`probes/shift-bud-baseline/`（Phase 1 のゲートである Phase 0a の記録）と同格の probe 記録として
`probes/` 配下に置く。

0b-core は「structured reporter チャネルが spec `veridelta-1.md` §3.6 を満たすことの実測確認」
（設計 doc §6 Phase 0b 冒頭の記述）を、`@playwright/test` 1.49.1 で再現した**合成プロジェクト**
（Phase 2 の conformance fixture の種を兼ねる）に対して行う。

## 内容

| ファイル | 中身 |
| --- | --- |
| `README.md`（本ファイル） | 位置づけ・事前登録・probe 実測計画・実測結果（F3〜F5 で記入） |
| `project/` | 合成 Playwright プロジェクト（`@playwright/test` 1.49.1 pin、設計 doc §3.3 逐語 config 形状）。F2 で構築 |
| `observations/` | probe の生観測（reporter dump JSON 等）。F3 で構築 |

## 位置づけ

- 設計 doc §6 Phase 0b-core（`## Phase 0b: Playwright の spec §3.6 probe` → `#### 0b-core`）
- issue #53（Phase 0b-core probe）
- `probes/shift-bud-baseline/` と同格の probe 記録（内容は異なるが、実測結果を README に判定として
  記録し生観測をコミットする、という規律は共通）

Kill-1（§7 kill criterion 1）の判定手順は「N 回連続実行」を要求するが、設計 doc §7 は
「N は Phase 0b 開始前に一度だけ確定する（下限3、推奨10。shift-bud の CI 実行データで代替可 —
§12-8）」と明記している。着手後に決めると事後選択（post-hoc criterion tuning）になり
criterion の意味が失われるため、本 task（F1）を実測着手（F2 以降）より必ず先に置き、
単独でコミット可能な状態にする。

---

## 事前登録（Phase 0b-core 着手前に確定する）

### Kill-1 の N

**N = 10**（設計 doc §7 / §12-8 の推奨値を採用）。

設計 doc §12-8 は N について立場A「10回連続」と立場B「下限3回 + 事前登録（app スタック起動・
auth setup を要する suite では10回は重い）」を未決のまま両論併記している。本 probe はここで
**立場A（N=10）を確定**する。理由:

- 立場B の反対論「app スタック起動を要する suite では10回は重い」は、**0b-field**（shift-bud
  実 e2e suite、171 `test()` 呼び出し、DB/auth セットアップを伴う）**の実行コスト**を指している。
  0b-field は本 issue #53 の非ゴールであり、Phase 2 のゲートでもない（設計 doc §6 「Phase 2 の
  ゲートは 0b-core のみ」）。
- N 自体は「確定する回数」という**数値の決定**であり、確定した N を**実際に実行するコスト**とは
  独立である。実行コストが高いという事実は、実行を遅延・代替する理由（後述の CI 代替 / degraded
  path）にはなるが、**N という数値を下げる理由にはならない**。下げれば Kill-1 の統計的検出力
  （`median(f_i) ≥ 2` 等の判定に必要なサンプル数）が弱まり、flaky base rate を過小評価する方向に
  安全域を狭める。
- したがって推奨値 10 を採用し、実行コストの問題は「N 回の実行を誰がいつ行うか」という別の軸
  （0b-field 本体 or 後述の CI 代替 or degraded path）で吸収する。

### CI 実行データで代替する場合の等価な N

設計 doc §12-8 は「CI 実行データで代替する場合の等価な N も同時に決める」ことを要求している。

**等価な N = 同一 commit に対する `retries: 2` の CI 実行 10 run。**

同一 tree 条件（設計 doc §7 Kill-1 の「同一 tree で e2e 全 suite を retries:2 強制で N 回連続実行」）
を満たす CI run が **10 未満しか無い場合**は、設計 doc §6 の degraded path に落ちる:

> 0b-field が不能な場合の degraded path: base rate は shift-bud の CI 実行データで代替する。
> それも不能なら **D2 を provisional のまま Phase 2 に進み**、kill criterion の最終判定を
> **「Phase 2 の flaky マッピング実装の直前」（last responsible moment）まで繰り延べる**。
> Phase 1（seam 抽出）は D2 の帰結と独立に進行できるため、この繰り延べは Phase 1 を一切
> ブロックしない。

つまり本 probe（0b-core）の完了は Kill-1 の実行そのものを要求しない — 0b-core は N の**確定**と
判定手順の**転記**（下記）を担い、実行は 0b-field またはその代替（CI データ／degraded path）に
委ねる。これは設計 doc §6 の受け入れ基準「§7 の kill criterion は 0b-field またはその代替で判定
されているか、上記 degraded path に従って明示的に繰り延べられていること」に整合する。

### Kill-1 集計規則（設計 doc §7 から転記）

判定手順に必要な規則を、実行主体（0b-field / CI 代替 / degraded path のいずれか）が迷わず
適用できるよう本 README にも転記しておく（設計 doc §7 が一次ソース）。

- **分母** = 各 run で実際に実行された test case 数（project 展開後。authored な `test()` 呼び出し
  171 とは project 分割により乖離する。実行数は各 run で再計測する）。
- **無効 run 規則**: `setup` project が red の run は無効とし、`f_i`（当該 run の flaky test case
  数）の集計から**除外**する（件数は記録する）。依存 skip カスケード（設計 doc §3.3.1）が
  criterion 自体を偽発火させるのを防ぐため。
- **発火条件**（いずれか一つで発火）:
  - `median(f_i) ≥ 2`
  - `|F| / 実行 test case 数 ≥ 5%`（`F` は有効 run 全体を通した累積 distinct flaky test 集合）
  - すべての有効 run で `f_i / 実行数 > 1%`

発火した場合は D2（`/1` を閉じたまま flaky を `pass` + `FailureFinding` で表現する。設計 doc §7）
を破棄し `veridelta/2` の検討に切り替える。判定時点は「Phase 2 の flaky マッピング実装前
（last responsible moment）」（設計 doc §7 kill criterion 冒頭）。

---

## probe 実測計画（実測前に期待を固定する）

tdd の精神に倣い、各項目の**期待観測**を実測（F3）より先に書き下す。番号は設計 doc §6 の
0b-core 列挙（1, 2, 3, 5, 6, 7）と照合するため保持する。**4 は 0b-field 側の項目**（flaky base
rate の実測。設計 doc §6 の番号付けが 0b-core / 0b-field を跨いで連続しているため欠番）であり
0b-core には存在しない。

### 0b-core-1: CE-1〜CE-5 の充足確認（spec §3.6, §3.2）

対象: `spec/veridelta-1.md` §3.6 の Canonical failure evidence 要件（CE-1〜CE-5）。

- **CE-1（signal completeness）**: Playwright Reporter API（`TestResult.errors[].message` /
  `.stack`、`TestCase.location`、`error.location`（file/line/column）、`error.snippet`）から
  exception type・asserted values を保った message・failing source region text・traceback 構造の
  4要素が取得できる**はず**。特に `error.location` の存在は spec §3.6 option (b)（「runner の
  structured channel が CE-1 component を提供しない場合、recorded tree からの決定的再構成を
  composition として宣言する」）を Playwright が満たせる可能性を示唆する（設計 doc §3.3 の
  好材料所見）。実測でどのフィールドが (a) channel-provided か (b) tree-reconstruction が必要かを
  determined に判定する。
- **CE-2（rerun stability）**: locator/timeout 系のエラーメッセージは retry ログ
  （`waiting for locator... 9 × locator resolved to ...`）を含み揮発する**はず**（設計 doc §3.3-6）。
  この揮発フィールドは CE-5（whole-field granularity）に従い**フィールド全体を composition から
  除外**する候補になる**はず**。
- **CE-3（position stability）**: `error.location.line` は絶対行番号でありそのままでは
  line-shift-stable ではない**はず**。symbol-relative offset や source line text を使った
  再構成が可能かを実測する。
- **CE-4（structured fields only）**: composition は `error.message` / `error.stack` /
  `error.location` 等の構造化フィールドのみから計算し、rendered display string（reporter が
  ターミナルに整形出力する文字列）は使わない設計にする**はず**（これが本 task 群が built-in
  json reporter でなく自作 `probe-reporter.ts` を使う理由 — architecture_decisions 参照）。

### 0b-core-2: rerun 安定性（CE-2）・line-shift 安定性（CE-3）

- **同一 tree 再実行**: 対象テスト（assertion 失敗 1本）の core digest（CE-1 構造化フィールドから
  計算した digest 相当）は複数回実行しても不変の**はず**。
- **無関係編集**: 対象テストと無関係なファイルを編集しても、対象テストの digest は不変の**はず**。
- **行ズレ**: 対象テストの前に空行を挿入すると `error.location.line`（絶対行）は変わるが、
  symbol-relative offset または source line text ベースの再構成を使えば digest は不変の**はず**
  （CE-3）。
- **揮発フィールドの annex 格納方針**: locator/timeout メッセージ（CE-2 で whole-field 除外した
  フィールド）は spec §3.6「Material excluded by CE-2/CE-3 MUST be stored in the finding's annex,
  addressable via anchors (§9.3)」に従い annex に格納され anchor 経由で開示可能な**はず**。

### 0b-core-3: flaky（`retries: 2` 明示下の fail → retry → pass）

- 決定的 flaky テスト（`testInfo.retry === 0` で throw、それ以降は pass。edge_cases 参照）を
  `retries: 2` 明示指定の project で実行すると、`TestCase.outcome() === 'flaky'` になる**はず**
  （attempt0 fail → attempt1 pass）。
- これを D2 のマップ（設計 doc §7）に落とすと: verdict = `pass` + `FailureFinding`
  （attempt0 の failure evidence）、transition = `verification_inconclusive` になる**はず**。
  attempt 別の evidence（attempt0 の error、attempt1 の成功）の両方が annex に残り情報欠落が
  無いかを実測で確認する。
- **Kill-1 への feed**: このシナリオ自体は N=10 のうち1 run 相当の「flaky が1本存在する」観測
  であり、Kill-1 の発火判定は N 回 run の集計（0b-field またはその代替）で行う。0b-core-3 は
  「D2 の機構が1本の flaky に対して機能するか」を確認するものであり、Kill-1 の発火判定そのもの
  ではない。

### 0b-core-5: 依存 skip カスケードの区別可能性

- `setup` project を故意に失敗させると、依存 project（`auth-tests` / `chromium`）のテストは
  `status: 'skipped'` で報告される**はず**。
- **authored skip（`test.skip()`）との区別**: `TestCase.annotations` / `TestResult.annotations` に
  違いが出るか、あるいは `onTestEnd` 自体が呼ばれない（report されない）ケースがあるかを実測する
  （edge_cases: probe-reporter は `onEnd` で `Suite.allTests()` も dump し、`onTestEnd` に来なかった
  test を検出可能にする）。
- 受け入れ基準は「observation を残す」ではなく「区別可能か」への **determined な答え**（設計 doc
  §6 0b-core-5）。区別不能だった場合は設計 doc §3.3.1 の決定木（① dependency graph からの決定的
  再構成 fallback → ② 狼少年を受容して文書化。floor（spec §11.1）を破る選択肢は取らない）に
  従った分岐を記録する。

### 0b-core-6 参照: resolved config の観測

`onBegin(config: FullConfig)` で得られる resolved config から `instrument.config_digest` に
含めるべきフィールド（retries / workers / timeout / projects / shard は yes、reporter リストは
要検討 — 設計 doc §6）を列挙する。この結果は `docs/compositions/playwright-native-1.md`
§3（F4 で新規作成、`vitest-native-1.md` §3 と同じ操作的定義・同じ形式）に本体を記録し、
本 README には F4 doc への参照のみを置く。

### 0b-core-7: バージョン pin 宣言

reporter API 面は版で動く（設計 doc リスク表「`@playwright/test` 1.49.1 の reporter API 面が
想定と異なる」）ため、0b-core-1・0b-core-2・0b-core-3・0b-core-5・0b-core-6 の全観測結果は
下記バージョンに紐づけて記録する。

**`@playwright/test` = `1.49.1`（shift-bud 実測値。設計 doc §6「`@playwright/test` は `1.49.1` に
pin（shift-bud 実測値）」に準拠。全観測はこの版でのみ有効であり、版が変われば再実測が必要）。**

---

## 実測結果

F3（0b-core-1/2/3/5/7）・F4（0b-core-6 参照）・F5（意思決定3件）で記入済み。

### 0b-core-1

対象観測: `observations/baseline.json`, `observations/failures.json`, `observations/flaky.json`。
実測は `tests/app.spec.ts`（`assertObjectShape` / `assertStringEquality` / `throwCustomError` /
`waitTooLong`）の4種の失敗形態と `TestError` 型定義
（`node_modules/playwright/types/testReporter.d.ts:556-588`）の突合で行った。

`TestError` インターフェースが持つ構造化フィールドは `cause? / location? / message? / snippet? /
stack? / value?` の6個のみで、exception type を表す `name`/`type` フィールドも、
expected/actual を表す構造化フィールド（`matcherResult` 等）も**存在しない**
（reporter.d.ts に無い＝型として提供されていない。実測は`TestResult.errors[]`の生 dump で該当
フィールドが常に `undefined`＝ `safeSerialize` で drop されることでも裏付く）。

| CE | 判定 | provenance | 根拠 |
| --- | --- | --- | --- |
| **CE-1** exception type | **満たさない**（構造化フィールドとしては）。ただし `message` の先頭行 `"<Name>: ..."` パターンを正規表現で抜き出せば決定的に復元できる（`throwCustomError` → `"TypeError: custom error"` で `TypeError` を抽出、`assertObjectShape` → `"Error: expect(...)..."` で汎用 `Error` を抽出。`analyze-stability.mjs` の `extractExceptionType()` で実装・実測済み） | **tree/text-reconstructed**（`message` という channel-provided フィールドの中身をテキスト解析。専用フィールドではない） | `node_modules/playwright/types/testReporter.d.ts:556-588`、`observations/failures.json` |
| CE-1 asserted values（expected/actual） | **満たさない**。`toEqual`/`toBe` の diff は `message` に ANSI 色コード付きの人間可読テキストとして埋め込まれる（例 `"Expected: [32m\"expected string\"[39m\nReceived: [31m\"actual string\"[39m"`）だけで、expected/actual を個別に取り出せる構造化フィールドは無い（`matcherResult` 相当は `errors[]` に載らない） | **channel-provided だが rendered**（フィールド自体は構造化だが値そのものが ANSI 付き rendered diff） | `observations/failures.json`（`string mismatch is observed` / `object shape mismatch is observed` エントリ） |
| CE-1 failing source region text | **満たす**（tree-reconstruction 経由）。`error.location`（file/line/column）は channel-provided。そこから合成プロジェクトのソースファイルを読み `sourceLineText` を決定的に再構成できることを `analyze-stability.mjs`（`sourceLineTextAt()`）で実証した（spec §3.6 option (b) 相当の経路） | **channel-provided location + tree-reconstructed text** | `probes/playwright-0b-core/project/scripts/analyze-stability.mjs`、`observations/stability-report.json` |
| CE-1 traceback entry structure | **満たさない**（構造化配列としては）。`error.stack` は Node 形式の単一フラット文字列で、フレームごとの `{file,line,function}` オブジェクト配列ではない。`error.location` は「投げた地点」1フレーム分の構造化情報のみを提供する。フレーム単位の情報が要るなら `stack` を `at <fn> (<file>:<line>:<col>)` 正規表現でテキスト解析する必要がある（`analyze-stability.mjs` の `findEnclosingFrame()` で実装） | **channel-provided（location: 1フレームのみ）+ text-reconstructed（stack 全体）** | 同上 |
| **CE-2** rerun stability | **満たす**（whole-field 除外を前提に）。決定的失敗テスト1本を同一 tree で2回実行し候補 core digest が完全一致することを実測（`stability-report.json.steps.rerun.stable === true`）。ただし locator/timeout 系の `message` は揮発しうるため（`observations/locator-blocked.md`）、CE-5 に従い揮発しうるフィールドは値レベルでなく whole-field で digest から除外し annex に格納する方針を採る（0b-core-2 節で詳述） | 実測 + 規範 | `observations/stability-report.json` |
| **CE-3** position stability | **満たさない**（raw `error.location.line` は絶対行番号でありそのままでは line-shift-stable でない。実測: 空行3行挿入で `location.line` が 35→38 に変化）。**満たす**（tree-reconstruction 経由）: enclosing symbol（`error.stack` の最初の named frame）からの symbol-relative offset、および `error.location` から再構成した `sourceLineText` は同一挿入後も不変（`symbolRelativeOffsetLine` 1→1、`sourceLineText` 完全一致）。さらに raw `error.snippet` も line-shift 後に**不変ではない**ことを発見した（後述） | **raw location: channel-provided だが不安定 / offset・sourceLineText: tree-reconstructed で安定** | `observations/stability-report.json.steps.line_shift` |
| **CE-4** structured fields only | **満たさない（厳密には）**。Reporter API が公開する唯一の "structured" evidence フィールド（`message`/`stack`/`snippet`）自体が ANSI エスケープコード付きの rendered テキスト（ターミナル整形用の色コード、`error.snippet` の行番号 gutter）を含んでいる。「rendered display string を使わない」を字義通り満たすには、これらのフィールドから ANSI コードを剥がした上でテキスト解析する前処理が composition に必須であり、この前処理自体を composition に明記する必要がある（黙示のままだと非適合 = silent omission） | channel-provided fields, but値そのものが semi-rendered | `observations/failures.json` の `message`/`snippet` 生値 |
| **CE-5** whole-field granularity | **満たす（設計として選択可能）**。ANSI ストリップは「宣言された field 全体に一様適用する正規化ステップ」であり、値の中身（例: `'resolved to'` を含む行だけを消す）に基づく条件付き除外ではないため CE-5 が禁じる値レベル書き換えに該当しない。composition はこの正規化ステップ自体を宣言すればよい（0b-core-1/CE-4 の帰結） | 規範（宣言前提） | 設計判断（spec §3.2 CE-5 の文言解釈） |

**結論**: Playwright の structured reporter channel は CE-1〜CE-5 の要件を**そのままでは満たさない**
が、spec §3.6 option (b)（recorded tree からの決定的再構成を composition として宣言する経路）を
使えば CE-1（source region text・exception type の一部）・CE-3（symbol-relative position）を
満たせることを実測で確認した。CE-4 は ANSI ストリップという前処理の明記が必須という条件付きで
満たせる。asserted/expected/actual 値（CE-1 の一部）と traceback 全体の構造化配列（CE-1 の一部）
は tree-reconstruction でも構造化された形では取得できず、rendered diff テキストの埋め込みという
形でしか手に入らない — これは composition の provenance 列に `text-embedded-in-message`
（channel-provided でも tree-reconstructed でもない第三区分）として明記すべき silent-omission
回避ポイントである。

### 0b-core-2

対象: `probes/playwright-0b-core/project/scripts/analyze-stability.mjs`
（`tests/app.spec.ts` の `object shape mismatch is observed with asserted/expected/actual` を
対象に実測）、結果は `observations/stability-report.json`。候補 core digest フィールドは
`exceptionType` / ANSI ストリップ済み `message` / `location.enclosingSymbol` /
`location.symbolRelativeOffsetLine` / `location.sourceLineText` / `location.column`（除外:
`duration` / `retry` / raw `location.line` 絶対値 / raw `error.snippet` / 絶対パス）。

- **(i) 同一 tree 再実行**: `stable stringify` した候補 digest が2回の実行で完全一致
  （`steps.rerun.stable === true`）。**判定: CE-2 の rerun stability を満たす**（この対象テストの
  この候補フィールド集合について）。
- **(ii) 行ズレ（対象テスト直前に空行3行挿入 → `git restore` の代わりにインメモリ復元で原状回復
  — 対象ファイルは git 未 add の untracked ファイルであり `git restore` には HEAD 版が無いため）**:
  raw `error.location.line` は `35 → 38` へ変化した（**満たさない**、絶対行番号のまま）が、
  `location.enclosingSymbol`（`assertObjectShape`）からの `symbolRelativeOffsetLine`（`1 → 1`）と
  `location.sourceLineText`（`"expect({ a: 1, b: 'x' }).toEqual({ a: 2, b: 'y' })"` で完全一致）は
  不変 → **候補 digest 全体は不変**（`steps.line_shift.reconstructed_digest_stable === true`）。
  **判定: CE-3 の line-shift 安定性は tree-reconstruction 経由で満たす**。
  - **追加発見**: raw `error.snippet` も line-shift で**不変ではなかった**
    （`steps.line_shift.raw_snippet_identical === false`）。snippet はハイライト行の周辺3行を
    絶対行番号ガター付きテキスト（例 `" 35 |"`）で埋め込んでおり、行ズレでガター数字が変わる
    ため文字列として非同一になる。ハイライトされたコード自体（`expect({ a: 1, ... })` の部分）は
    テキストとして同一だが、raw snippet 全体をそのまま digest に使うと CE-3 に違反する。
    composition は raw snippet を直接使わず、`location.sourceLineText`（このスクリプトが
    tree-reconstruction で得た値と同じ経路）を使うべき、という具体的な設計含意が確定した。
- **(iii) 無関係ファイル編集（`tests/auth.spec.ts` の先頭にコメント1行追加 → 実行後に原状復元）**:
  候補 digest は完全不変（`steps.unrelated_edit.stable === true`）。**判定: 満たす**。
- **揮発フィールドの annex 格納方針（determined）**: `observations/locator-blocked.md` の通り、
  locator シナリオ自体はこの実行環境で environment-blocked（sandbox の mach port rendezvous
  拒否によりブラウザ起動不能。CDP 非互換という事前登録仮説とは異なる原因だが結論は同じ
  environment-blocked）だった。代わりに `observations/failures.json` の timeout シナリオ
  （`test.setTimeout(1000)` + `waitTooLong`）で `error.message === "Test timeout of 1000ms
  exceeded."`（ANSI込み）が `retry: 0/1/2` の3回とも一字一句不変であることを確認した。
  設計 doc §3.3-6 の事前登録警告（locator の retry ログは run 間で揮発しうる）と CE-5
  （whole-field 規律）から、**message フィールドは条件付き除外にできない（whole-field で
  include するか exclude するかの二択）**という方針を determined に確定する: locator/timeout
  系のように retry ログや経過時間を message に埋め込みうるテスト種別では `message` フィールド
  自体を core digest から丸ごと除外し annex（spec §9.3 anchor 経由で開示可能な領域）に格納する。
  timeout の実測（3回不変）はこの特定シナリオでは message が偶然安定していたことを示すのみで、
  「message は原理的に揮発しうるフィールドである」という規範上の分類を変えない。
  **locator 実測自体の補完は 0b-field または Phase 2 冒頭に繰り延べる**（`observations/locator-blocked.md`
  末尾を参照）。

### 0b-core-3

対象: `observations/flaky.json`（`tests/flaky.spec.ts` のみを対象に `retries: 2` 明示 config で
実行）。

| entry | retry | test.outcome() | result.status | errors |
| --- | --- | --- | --- | --- |
| attempt0 | 0 | `unexpected`（暫定値。最終判定ではない） | `failed` | `message: "Error: flaky: first attempt fails"`、`stack`・`location`（`tests/flaky.spec.ts:10:11`）・`snippet` すべて記録あり |
| attempt1 | 1 | `flaky`（最終判定） | `passed` | `[]`（空。成功した attempt にはエラーが無いのは正しい） |

`TestCase.outcome() === 'flaky'` は最終 attempt（attempt1）のエントリでのみ `'flaky'` になり、
attempt0 時点のエントリでは `'unexpected'`（暫定値）である。**両方の attempt が別々の
`onTestEnd` 呼び出しとして観測 JSON に残っており（`analyze-stability.mjs`/`run-scenarios.mjs`
の `finalEntriesOf()` が「同一 test.id の最終 attempt のみ」を採用する一方で、生観測 JSON 自体は
全 attempt を保持する）情報欠落は無い**。

D2 マップ（設計 doc §7）への対応:

| D2 要素 | 対応する観測フィールド | 判定 |
| --- | --- | --- |
| verdict `pass` | attempt1 の `result.status === 'passed'` + 最終 `outcome === 'flaky'` | 満たす |
| `FailureFinding`（失敗 attempt の evidence） | attempt0 の `result.errors[0]`（message/stack/location/snippet 完備） | 満たす（0b-core-1 で確認した CE-1 の制約＝expected/actual は message 埋め込みのみ、はここでも同様に適用される） |
| transition `verification_inconclusive` | attempt0（failed）→ attempt1（passed）の遷移そのもの。Reporter API に transition 用の専用フィールドは無いため、composition 側が「同一 test.id の連続 attempt が failed→passed」を検出して `verification_inconclusive` ラベルを付与する必要がある（tree-reconstruction 相当の判定ロジック） | 満たす（ロジックとして構成可能。専用フィールドとしては提供されない） |
| attempt 別詳細（annex + anchor） | 全 attempt の `retry` 番号・`duration`・`errors`・`hasStdout`/`hasStderr` が観測 JSON に個別に残る | 満たす（情報欠落なし） |

**Kill-1 への feed**: 本 issue は 0b-field 非ゴールであるため、Kill-1 の N=10 回実行そのものは
実行しない（README「事前登録」節で確定済み）。0b-core-3 で確認したのは「D2 の機構は1本の
flaky に対して機能し、attempt 別 evidence の欠落が無い」ことのみである。設計 doc §6 の
degraded path に従い、**D2 は provisional のまま、Kill-1 の最終判定（発火 or 非発火）は
Phase 2 の flaky マッピング実装の直前（last responsible moment）まで繰り延べる**。事前登録済み
の経路であり、Phase 1（seam 抽出）を一切ブロックしない。

### 0b-core-5

対象: `observations/setup-cascade.json`（`PROBE_FAIL_SETUP=1`）と対照群 `observations/baseline.json`
（authored skip の基準値）。

- `setup` project のテスト（`authenticate`）は `status: 'failed'`、`errors[0].message ===
  "Error: setup intentionally failed"` で報告される（`setupTests` assert 済み、`run-scenarios.mjs`
  の scenario 'setup-cascade' が既にこれを確認）。
- 依存 project（`auth-tests` / `chromium`）の**9件**のテストは `tests[]`（`onTestEnd` 経由の
  観測）に**1件も現れない**。`config.projects[1].dependencies === ["setup"]` /
  `config.projects[2].dependencies === ["setup"]` であることは同じ observation の `config` dump
  で確認できる。これらは全件 `unreported_tests`（`Suite.allTests()` と `onTestEnd` で見た
  test.id の差集合）に載る。**つまり `TestResult.status` が `'skipped'` にも `'interrupted'` にも
  ならず、「そもそも report されない」（edge_cases が想定した最悪ケース）が実測された**。
- 対照群（baseline.json の `auth: authored skip`）: `onTestEnd` を正常に経由し、
  `result.status === 'skipped'`、`test.annotations === [{type: 'skip'}]`、
  `test.expectedStatus === 'skipped'` で報告される。
- **同一テスト（`auth: authored skip`）を setup-cascade の `unreported_tests` 内で見ると**、
  `annotations: [{type: 'skip'}]` は静的な `test.skip()` 宣言由来で残っている（`Suite.allTests()`
  はテスト定義そのものの dump であり実行結果ではないため）が、**`TestResult`（`status`/`retry`/
  `duration`/`errors`）に相当する情報は一切無い**（そもそも実行されていないので `TestResult`
  自体が存在しない）。

**判定（determined）: authored skip と dependency skip は構造化チャネル上で区別可能**。
区別の軸は `TestResult.status` の値ではなく「**`onTestEnd` を経由したか否か（reported vs
unreported）**」である:

| | 経由 | `TestResult.status` | `annotations` |
| --- | --- | --- | --- |
| authored skip（`test.skip()`） | `onTestEnd` を経由し**reported** | `'skipped'` | `[{type:'skip'}]`（実行結果としても残る） |
| dependency skip（setup 失敗による cascade） | `onTestEnd` を経由せず**unreported**（`Suite.allTests()` 経由でのみ discoverable） | 存在しない（`TestResult` 自体が無い） | 静的定義由来の annotations のみ（`allTests()` dump）。cascade 対象の非-skip テストは `annotations: []` |

§3.3.1 の事前登録機構（FullConfig の dependency graph を capture に含め
`suppression.marker='dependency'` を付す）は**成立する**: `config.projects[].dependencies` が
capture 済み FullConfig に既に含まれており（`serializeConfig()` 実装済み）、追加の
決定的再構成（決定木の① dependency graph reconstruction）を要さずに「unreported かつ、
その project が failed project に依存している」という条件だけで dependency skip を特定できる
（決定木の②狼少年受容まで落ちる必要はない）。composition はこの unreported 集合について
`Suite.allTests()` から合成した合成レコードに verdict `skip` + `suppression.marker='dependency'`
を付与し、**reported からは外さず**（unreported であることそのものを composition が
明示的に埋め合わせる責務を持つ）**blocking set からのみ除外**する必要がある（spec §11.1 floor
適合）。この「composition が合成レコードを作る責務」を怠ると、dependency skip テストは
reporter からは実行結果が一切出力されないため、composition の実装が `onTestEnd` ストリームだけ
を見ていると**サイレントに reported から欠落する**（floor 違反）ことが本実測で判明した —
これは composition doc に明記すべき必須要件である。

### 0b-core-6 参照

*(F4 で `docs/compositions/playwright-native-1.md` を新規作成し、本節にはそこへの参照のみ記入)*

### 0b-core-7

全観測 JSON（`observations/baseline.json` / `failures.json` / `flaky.json` / `locator.json` /
`setup-cascade.json` / `stability-report.json`）はいずれも `playwright_version: "1.49.1"`
フィールドを持つことを確認した（`probe-reporter.ts` の `payload.playwright_version` に
ハードコードされた値であり、実インストール済みバージョン
`node_modules/@playwright/test/package.json` の `"version": "1.49.1"` と一致することも確認済み）。
本 README の 0b-core-1・0b-core-2・0b-core-3・0b-core-5 の全判定は、この `@playwright/test`
1.49.1 の reporter API 面（`TestError` / `TestResult` / `TestCase` / `FullConfig` の型形状と
実際の値）に紐づく。版が変われば（特に reporter API のマイナー版差分がある場合）再実測が必要。

### 意思決定: §12-3 / retry-evidence / source-region-text

#### (1) §12-3: comparator の flaky トリガー適用条件

**結論: 立場B（capability ゲート付き — current record が `retry-evidence` を宣言する場合のみ
発火）を採る。**

- **ブロッカー解消**: 設計 doc §12-3 の未決理由「capability の record 化は Step 2 なので、B を
  採ると flaky マッピングは Step 2 以降にしか動かない」は PR #49/#50（`aedb4ba`
  `feat(schema): instrument.capabilities を registry ではなく record へ載せる`、`c578e5b`
  マージ）で解消済み。`instrument.capabilities?: Record<string, CapabilityValue>` が
  record 契約として既に存在する（`src/schema.ts:308`, `:772-780`）ため、立場Bの実装
  （`record.instrument.capabilities['retry-evidence']` を見て発火可否を決める）は Step 2 を
  待たずに書ける。
- **0b-core-3 実測との整合**: `observations/flaky.json` は attempt0/attempt1 別 evidence が
  情報欠落なく annex 相当の形で残ることを確認済み（本 README 0b-core-3 節）。この実測は
  立場A・立場Bどちらの是非にも中立（両方とも「evidence が拾える」ことを前提にできる）だが、
  立場Bを否定する材料は出ていない — したがって既定の推奨（Bを採る）を維持する。
- **却下した代替案**: 立場A（素の `c.finding !== undefined`）。Step 1 の間でも動く利点はあるが、
  「将来の adapter が別目的で pass に finding を付けたときの silent 誤発火」を防げない。
  Step 順序制約が消えた以上、この risk を許容する理由が無い。
- **影響範囲**: Phase 2 で `src/compare.ts` の flaky-trigger 判定（現状の finding 存在チェック、
  `:612-613` 付近）に `record.instrument.capabilities['retry-evidence'] === 'pass'`（Playwright
  adapter が宣言した場合のみ）ゲートを追加する。Playwright adapter は `retry-evidence: 'pass'`
  を宣言する（決定(2)参照）。vitest adapter は宣言しない（決定(2)）ため vitest record では
  常に非発火のまま — これは意図した挙動である。

#### (2) retry-evidence capability を vitest に追加するか（= baseline 4回目録り直しの有無）

**結論: 追加しない。** vitest の宣言6項目（`VITEST_CAPABILITIES`、
`src/adapters/vitest/recorder.ts:67-74`: `verdicts` / `source-location` / `suppression` /
`inventory` / `failure-evidence` / `source-region-text`）は不変。vitest record の run_id は
変わらず、**`probes/shift-bud-baseline/` の baseline 録り直しは発生しない**（録り直しは既に
3回行っており、コストが高いことが実績で示されている）。

- **根拠**: `retry-evidence` が開示すべき内容は 0b-core-3 実測で判明した通り「retry attempt 別
  evidence への annex 到達可能性」（設計 doc §7 実装機構 item 4）である。vitest には retry の
  概念自体が無く（`retries` project 設定・attempt 分岐は Playwright 固有）、retry attempt という
  現象が存在しないため「unsupported」と宣言する対象の実体が無い。
  決定(1)で確定した立場Bの comparator は「宣言がある場合のみ発火」であり、宣言が無い vitest
  ではそもそも発火しない — これは vitest に対して望む挙動そのもの（vitest の pass に flaky
  finding が付くことは構造上あり得ない。`src/adapters/vitest/recorder.ts:176` は pass に
  finding を付けない）であり、`unsupported` 宣言を追加してもこの挙動に変化は無い。
  capability 名は open（spec §3.4「etc.」、`CAPABILITY_VALUES` は値の enum であって名前の enum
  ではない）ため、vitest が `retry-evidence` を宣言しないこと自体は spec 上問題にならない。
- **却下した代替案**: 追加する（`unsupported` として宣言）。意味的には「vitest は
  retry-evidence を提供しない」ことを機械可読にする効果はあるが、comparator の挙動には影響を
  与えず（決定(1)のゲートは「宣言なし」でも同じ非発火挙動を導く）、composition 変更 →
  `adapter_version` bump → 全 run_id 変化 → 4回目の baseline 録り直しという実コストに見合う
  便益が無い。
- **実測がこの結論を覆す条件**: 0b-core-3 の実測が「retry-evidence は vitest でも意味を持つ
  開示内容（retry 概念とは独立の annex 到達可能性一般）である」ことを示した場合。今回の実測
  （対象は Playwright 固有の attempt 別 evidence）はそれを示さなかったため「追加しない」を
  確定する。将来この判断を覆す場合は baseline 録り直しを**別 issue に切り出す**（本 issue #53
  のスコープ外）。
- **影響範囲**: `src/adapters/vitest/recorder.ts` の `VITEST_CAPABILITIES` は変更しない。
  Phase 2 で Playwright adapter が `retry-evidence` capability を新規追加する際も vitest 側への
  波及は無い。

#### (3) source-region-text を Playwright が `pass` で宣言できるか

**結論: `pass` で宣言できる（tree-reconstruction 経由）。** 確定形の宣言文言を
`docs/compositions/playwright-native-1.md` §8 に追記した。

- **根拠（0b-core-1 / 0b-core-2 実測より）**: `error.location`（file/line/column）は
  channel-provided。これを起点にソースファイルを読み `sourceLineText` を再構成する経路
  （`analyze-stability.mjs` の `sourceLineTextAt()`）は同一 tree 再実行・無関係編集・行ズレの
  いずれでも安定（`observations/stability-report.json`）。一方 raw `error.snippet`（別の
  channel-provided フィールド）は**line-shift で不変ではない**ことを 0b-core-2 で発見した
  （`steps.line_shift.raw_snippet_identical === false`）— 絶対行番号ガター付きテキストを
  埋め込むため、行ズレでバイト列が変わる。したがって snippet をそのまま source-region-text と
  して使うのは CE-3（line-shift 安定性）に違反する。
- **却下した代替案**: channel-provided（`error.snippet` をそのまま使う）。line-shift 不安定と
  いう実測結果（CE-3 違反）により却下。
- **確定した provenance**: spec §3.6 option (b)（recorded tree からの決定的再構成）経路で
  `pass` 宣言可能。provenance は **tree-reconstructed**（`error.location` + recorded source
  tree）であり **channel-provided（snippet 由来）ではない**。spec §3.6「composition MUST
  distinguish channel-provided from tree-reconstructed; silent omission is non-conforming」
  （`spec/veridelta-1.md:269-270`）に従い、この区別を composition doc に明記した。
- **位置づけ**: vitest が唯一 `unsupported` にしている capability（`source-region-text`）を
  Playwright は `pass` で宣言できる = capability 宣言設計（composition ごとに
  `pass`/`fail`/`unsupported` を宣言し comparator がそれに応じて振る舞いを変える設計、
  `src/schema.ts:47` `CAPABILITY_VALUES`）が実際に機能する実証である。
- **影響範囲**: Phase 2 実装で Playwright adapter の `sourceLineText` 再構成ロジックは
  `analyze-stability.mjs` の `sourceLineTextAt()` / `findEnclosingFrame()` を土台にできる
  （probe project は conformance fixture の種を兼ねるため実装コードとして再利用可能）。
  `docs/compositions/playwright-native-1.md` §8 がこの Phase 2 実装契約になる。

---

## 非ゴール

- **Phase 2（Playwright adapter 実装）そのもの** — 本 issue は probe のみ
- **0b-field**（shift-bud 依存の flaky base rate 実測）— Phase 2 のゲートではない
- **§12-1（`fail → flaky` のみのときの gate verdict）の決着**: 解決条件は「0b-field の base rate
  実測」と「gate report の消費者要件」であり、0b-field は Phase 2 のゲートではない。したがって
  0b-core 完了後も §12-1 は open のまま残り、設計 doc が明記するとおり**これが決まるまで
  Phase 2 の flaky fixture は書けない**。0b-field が不能な場合の degraded path も設計に事前登録
  済み（本 README「事前登録」節の Kill-1 記述を参照）: shift-bud の CI 実行データで代替 →
  それも不能なら D2 を provisional のまま Phase 2 に進み、kill criterion の最終判定を「Phase 2
  の flaky マッピング実装の直前」まで繰り延べる。Phase 1 は完了しているため、この繰り延べは
  何もブロックしない。なお `outcome_verdict` = `inconclusive`（`unchanged` 禁止）は**合意済み**
  — 未決は gate 側のみ。
- **CI gate の組み込み**（設計 doc §9 Non-goals: Phase 0a / 1 / 2 いずれでも行わない）

---

## 受け入れ基準チェックリスト（issue #53）

| # | 受け入れ基準 | 判定 | 参照 |
| --- | --- | --- | --- |
| 1 | 合成 Playwright プロジェクト（`1.49.1` pin、spec §3.3 config 形状）が `probes/` 配下に、Phase 2 conformance fixture の種として再利用可能な形で保存されている | 満たす | `probes/playwright-0b-core/project/`（`playwright.config.ts`, `tests/`, `scripts/analyze-stability.mjs`） |
| 2 | 0b-core-1 に determined な答えが記録されている | 満たす | 本 README「実測結果 › 0b-core-1」節 |
| 3 | 0b-core-2 に determined な答えが記録されている | 満たす | 本 README「実測結果 › 0b-core-2」節 |
| 4 | 0b-core-3 に determined な答えが記録され、Kill-1 への feed 結果が記録されている | 満たす | 本 README「実測結果 › 0b-core-3」節（Kill-1 への feed 小節を含む） |
| 5 | 0b-core-5 に determined な答えが記録されている | 満たす | 本 README「実測結果 › 0b-core-5」節 |
| 6 | 0b-core-6: Playwright composition の列挙リストが `docs/compositions/` に vitest と同じ形式で書き下されている | 満たす | `docs/compositions/playwright-native-1.md` §3〜§4（本 README「実測結果 › 0b-core-6 参照」節から参照） |
| 7 | 0b-core-7: probe 結果が `@playwright/test` バージョンに紐づけて記録されている | 満たす | 本 README「実測結果 › 0b-core-7」節 |
| 8 | Kill-1 の `N` が 0b-core 着手前に確定され記録されている | 満たす | 本 README「事前登録 › Kill-1 の N」節（`N = 10`、CI 代替時の等価な N を含む） |
| 9 | §12-3 と retry-evidence capability の扱いに結論が出ている | 満たす | 本節「意思決定 (1)」「意思決定 (2)」 |
| 10 | source-region-text を Playwright が `pass` で宣言できるか否かが、composition の記述レベルで確定している | 満たす | 本節「意思決定 (3)」、`docs/compositions/playwright-native-1.md` §8 |
