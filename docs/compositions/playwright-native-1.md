# `composition_id: playwright-native/1`（予約） — resolved FullConfig の evidence-affecting configuration 列挙

## 1. ヘッダ/前提

> **本文書の性格（issue #53 / 0b-core-6）**: `playwright` adapter は本リポジトリに**未実装**
> （`docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` の Phase 2 は未着手）。
> 本文書は Phase 0b-core probe（`probes/playwright-0b-core/`）の実測に基づき、Phase 2 実装が
> `instrumentConfigDigest` 相当の関数へそのまま bind することを想定した**予約列挙リスト**である。
> `vitest-native-1.md` が実装済みコードの audit として書かれたのに対し、本文書は実装に**先行**
> する契約仕様である点が異なる。実装時（Phase 2）に列挙内容へ変更が必要と判明した場合は、
> 本文書を改版した上で §6 の変更規律（列挙リスト変更 = composition 変更 = adapter_version 変更）
> に従う。

- `composition_id`: `playwright-native/1`（予約。実装後の定義位置は Phase 2 で
  `src/adapters/playwright/recorder.ts` 相当のファイルに置かれる想定 — `vitest-native/2` の
  `COMPOSITION_ID`（`src/adapters/vitest/recorder.ts:39`）と同型）
- `adapter`: `playwright`（未実装）

本文書の位置づけ: `docs/superpowers/specs/2026-07-28-playwright-adapter-design.md` §4.1.1
が定める adapter 共通契約

> `instrument.config_digest` は composition が列挙する **解決済み** evidence-affecting
> 設定から計算する。各 adapter は列挙リストを `composition_id` にひもづけて文書化する。
> config ファイルの digest は `surface.config_sources` の役割であり、`config_digest` の
> 代替にならない。

の `playwright-native/1` に対する実体（列挙リストそのもの）である。

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
design doc §4.1.1 はこの穴を vitest の `retry` / `environment` / `pool` で実証しており、
Playwright の `retries: CI ? 2 : 0`（design doc §3.3-3）は「完全に同型の穴」と評されている。

## 2. 観測対象

合成 Playwright プロジェクト `probes/playwright-0b-core/project/`（issue #53 / F2 で構築、
Phase 2 conformance fixture の種を兼ねる）:

- `@playwright/test` = `1.49.1` 固定（shift-bud 実測値。設計 doc §6「`@playwright/test` は
  `1.49.1` に pin」に準拠。0b-core-7 で全観測 JSON の `playwright_version` フィールドが
  `"1.49.1"` であることを確認済み）
- `playwright.config.ts`（`probes/playwright-0b-core/project/playwright.config.ts:9-38`）は
  spec §3.3 が shift-bud `packages/e2e/playwright.config.ts` から逐語引用した config 形状
  （`setup` / `auth-tests`（`dependencies: ['setup']`）/ `chromium`（`dependencies: ['setup']`）
  の3 project、`retries: 2` 明示、`fullyParallel: true`、`timeout: 30000`、
  `expect: { timeout: 5000 }`）を再現する
- 観測手段: built-in json reporter ではなく自作 `probe-reporter.ts`（Reporter API 直結。
  built-in reporter は rendered/整形済み情報しか返さず CE-4 の検証に使えないため —
  architecture_decisions 参照）。`onBegin(config: FullConfig, suite: Suite)` で
  `serializeConfig(config)`（`probe-reporter.ts:52-78`）が resolved FullConfig を dump する
- 生観測: `probes/playwright-0b-core/observations/{baseline,flaky,setup-cascade,locator}.json`
  の `.config` フィールド（architecture_decisions の決定により、シナリオ切替は環境変数のみで
  行い config ファイル自体は1本のため、全観測 JSON の `.config` は同一値 — 4 ファイルすべてで
  `workers: 5`, `shard: null`, `fullyParallel: true` を実測確認済み）

## 3. 判定基準の定義

`vitest-native-1.md` §3 と同一の操作的定義を転記する（**evidence-affecting** の操作的定義）:

> 同一 tree・同一 selector・同一 adapter version で、当該設定の値だけを変えたとき、
>
> (a) `evidence_digest` / `structural_fingerprint` に入るバイト列、
>
> または
>
> (b) `observation` の `verdict`、
>
> を変えうるか。

(a)(b) いずれかを満たせば yes、いずれも満たさなければ no と判定する。以下の判定表の
「根拠」欄は必ずこの (a)/(b) のどちらに該当するかを含める（Playwright には vitest の
`buildFinding`/`mapVerdict` に相当する実装がまだ存在しないため、根拠は「Playwright の
実行意味論として (a)/(b) のどちらの経路で効くか」を実測または構造推論で示す形を取る）。

## 4. 判定表（本体）

**provenance 列の凡例**（0b-core-1 で確立した区分の config_digest 版）:

- `channel-provided`: resolved `FullConfig`（`onBegin` 引数）に直接のプロパティとして存在し、
  そのまま読める
- `channel-unavailable`: 該当する解決済み値が `FullConfig` / `FullProject`
  （`node_modules/playwright/types/test.d.ts:650-724`, `:1726-1845`）のいずれにも
  **存在しない**（実測: 後述 `expect.timeout` の行を参照）。covering するには spec §3.6
  option (b) と同型の tree-reconstruction（`playwright.config.ts` ソース自体の解析）を
  composition が宣言する必要がある — これは evidence の CE-1 でなく **instrument config**
  に対して同じ「channel が言明しない値を tree から決定的に再構成する」という構造を適用する
  ケースであり、0b-core-1 の `source-region-text`（tree-reconstruction 経由で満たす）と
  同じ語彙で記述できることが確認できた（最終的な composition 文言の確定は F5 に委ねる）

| 設定名 | 判定 | provenance | 根拠 |
| --- | --- | --- | --- |
| `retries`（project 単位） | **yes** | channel-provided（`FullProject.retries`。実測: `baseline.json` の `config.projects[].retries === 2`） | `retries: 0` では flaky が一度も観測されない（design doc §3.3-3「resolved-vs-file config digest」の本体）。同一 tree でも `retries` の値だけを変えると `TestCase.outcome()` が `'flaky'` になるか `'unexpected'`（fail のまま）になるかが変わる（(b)）。0b-core-3 で `retries: 2` 明示下の `fail→retry→pass` を実測済み（`observations/flaky.json`）。 |
| `workers` | **yes** | channel-provided（`FullConfig.workers`。実測値 `5`） | §7.8 順序正規化との関係を明記する: spec §7.8 は recorder が observation を canonical 順（test ID 順）に並べ直すことを義務付けており、**report のバイト順序**は `workers` に依存しない。しかし §7.8 が対処するのは「届く順序」だけであり、`workers` が変える**実行時の並行度**（同時に走る worker プロセス数）そのものは別の軸である。並行度が変わればテスト間の資源競合（ポート・一時ファイル・共有 fixture 初期化タイミング）で assertion の成否や message 内容が変わりうる（(a)/(b)）。これは vitest の `pool`/`isolate`（`vitest-native-1.md` §4）が worker 境界の意味論変化で evidence を変えうると判定したのと同型の懸念であり、0b-core probe では専用の A/B 実験を行っていないため実測ではなく構造推論による事前判定（yes）である。 |
| `timeout`（project 単位のテスト timeout） | **yes** | channel-provided（`FullProject.timeout`。実測: 全 project で `30000`） | timeout 発生時のメッセージに設定値が埋め込まれる。0b-core-2 の実測で `test.setTimeout(1000)` を使った timeout シナリオの `error.message === "Test timeout of 1000ms exceeded."` を確認済み（`observations/failures.json`）— 設定値を変えれば同一 tree でも message バイト列が変わる（(a)）。timeout の発生有無自体で `status`（`'passed'`↔`'timedOut'`）も変わる（(b)）。 |
| `expect.timeout`（assertion 既定 polling timeout） | **yes（evidence-affecting）だが channel-unavailable** | **channel-unavailable** — `playwright.config.ts:29-31` で `expect: { timeout: 5000 }` を明示指定しているにもかかわらず、resolved `FullConfig`/`FullProject`（`onBegin` の引数）には `expect` プロパティが**存在しない**ことを実測で確認した（`baseline.json` の `config.projects[0]` は `dependencies/name/retries/testDir/testIgnore/testMatch/timeout/use` の8キーのみで `expect` を含まない。`node_modules/playwright/types/test.d.ts` を確認すると `expect?: {...}` は `TestProject`（`:164-166` 相当、authoring 用の入力型）と `TestConfig` の両方に存在するが、`FullProject`（`:650-724`）・`FullConfig`（`:1726-1845`）のどちらにも存在しない — つまり Reporter API の型設計として **resolved expect timeout は reporter に一切公開されない**）。 | 値自体は明らかに evidence-affecting（`toBeVisible`/`toPass` 等 async matcher の待機時間が変われば timeout 失敗の発生有無・message が変わる、(a)/(b)）。しかし本 probe は browserless-first（architecture_decisions）のため page ベースの async matcher timeout 実験は行っておらず、この判定は Reporter API の型・実測 dump 双方から得た**構造的事実**（channel が値を出力しない）に基づく。**Phase 2 実装への申し送り事項**: `instrumentConfigDigest` 相当の実装は `FullConfig` を読むだけでは `expect.timeout` を covering できない。covering するには `playwright.config.ts`（resolved 後ではなく authored source）を tree-reconstruction で解析するか、capability `unsupported` を宣言する（spec §3.6 option (a) 相当を config_digest に転用）必要がある。本 issue の scope（0b-core-6 は列挙の確定であり実装ではない）ではどちらを選ぶかまでは決めない。 Phase 2 決定（issue #55 決定6）: capability `resolved-config-coverage: 'unsupported'` の宣言で開示する（tree-reconstruction 案は不採用）。EVIDENCE_CAPABILITY_NAMES へは追加しないため report の `failure_evidence.degraded_capabilities` には現れず、開示は record の `instrument.capabilities` が担う。 |
| `projects`（各 project の `name`/`testMatch`/`testIgnore`/`dependencies`/per-project `retries`/`timeout`） | **yes** | channel-provided（`FullConfig.projects[]`。実測: `baseline.json` の3 project すべてで dump 済み） | project 展開が実行される test の分母（test ID 集合）そのものを変える。`testMatch`/`testIgnore` は正規表現として resolve され selector と独立にどのファイルが当該 project に属すかを決め、`dependencies` は 0b-core-5 で実測したとおり skip カスケードの発生条件そのものを決める（(b)、かつ project 名は test ID の一部になるため id 自体が変わる — design doc §3.3 要件2「test ID に project を含める必須性」）。per-project `retries`/`timeout` は上記2行と同じ根拠がそのまま project 粒度で成立する。 |
| `projects[].testDir` | **no** | 該当なし（config_digest に含めない） | `rootDir`/`configFile` と同じ絶対パス問題（実測: `baseline.json` の全 project で `testDir` は worktree 内絶対パス）。`testMatch`/`testIgnore` が正規表現として実際にどのファイルを拾うかを決めており、`testDir` はその解決の基点にすぎない。worktree 配置を変えただけで値が変わり、同一 config でも `instrument-changed` を過剰発火させる CE-2 型の懸念があるため config_digest には含めない。 |
| `shard` | **yes** | channel-provided（`FullConfig.shard`。実測値: `null`。値がある場合は `{total, current}` — `node_modules/playwright/types/test.d.ts:1821-1826`） | shard は実行 test 集合（どの test ファイルが当該 shard に割り当てられるか）を変える。同一 tree・同一 selector でも `shard` の値だけを変えれば、当該実行が観測する test ID 集合自体が変わる（(b)）。本 probe は非 shard 実行のみ実測しており（`shard: null` を全観測で確認）、shard 有効時の挙動は Phase 2 の conformance fixture 候補として申し送る（design doc §6 Phase 2「新しい縁の conformance fixture」に resolved-vs-file config は既出だが shard は未列挙 — 追加候補）。 |
| `fullyParallel` | **yes** | channel-provided（`FullConfig.fullyParallel`。実測値: `true`、全観測で一致） | design doc §3.3 要件4「spec §7.8 順序正規化」が名指しする設定。`workers` と同じ根拠（同一項目参照）が成立する: `fullyParallel` はファイル内テストが並行実行されるか直列実行されるかを切り替え、テスト間の資源共有・実行順依存の副作用有無を変える。§7.8 の順序正規化は report のバイト順序を保証するのみで、`fullyParallel` が変える実行時並行構造そのものは orthogonal であるため、順序正規化の存在は `fullyParallel` を no にする根拠にならない。本 probe は `fullyParallel: true` 固定でのみ実測しており（0b-core-2 の rerun/unrelated-edit/line-shift はすべてこの設定下で安定を確認）、`false` との A/B は実施していないため `workers` と同様に構造推論による事前判定（yes）。 |
| `reporter`（reporter リスト） | **no** | channel-provided（`FullConfig.reporter`。実測: `[[<probe-reporter.ts のパス>, null], ['list', null]]`） | 設計 doc §6 0b-core-6 が「要検討」とした項目。判定: reporter は `TestResult`/`TestCase` の**消費者**であり、どの reporter が併走していても Playwright コアが生成する `TestResult`（`status`/`retry`/`errors`/`duration` 等）の値自体には影響しない — reporter が増減しても同一 tree・同一 selector での assertion 成否や message バイト列は変わらない（(a)(b) いずれも該当しない）。vdelta adapter 視点では「自 reporter（`probe-reporter.ts` 相当）が注入されているか」は record が**組める/組めない**の前提条件（capture channel の可用性）であり、`config_digest`（evidence-affecting 設定の識別）とは別の関心事である（`surface.config_sources` や capture channel の可用性チェックの役割）。したがって reporter リストは `config_digest` の入力に含めない（no）。 |
| `grep` / `grepInvert` | **yes** | channel-provided（`FullConfig.grep`/`grepInvert`。実測: `grep: {"__regexp":"/.*/"}`, `grepInvert: null`） | `shard`/`projects` と同じ根拠: どの test が実行対象に選抜されるかを変える（フィルタ条件）。同一 tree・同一 selector でも `grep`/`grepInvert` の値だけを変えれば実行される test ID 集合が変わる（(b)）。vdelta 自身の selector 機構（CLI 由来の inclusion intent、spec §6.4）とは独立した Playwright 側のフィルタであり、両者が食い違うと「selector 通りに実行されない」という混乱を生みうる点は Phase 2 実装時の注意事項として申し送る。 |
| `maxFailures` | **yes** | channel-provided（`FullConfig.maxFailures`。実測値: `0` = 無制限） | `maxFailures > 0` の場合、規定件数の失敗到達後に残りのテストが実行されず `'interrupted'` として報告される（Playwright の early-abort 機構）。同一 tree・同一 selector でも `maxFailures` の値だけを変えれば、後続テストの `status` が `'passed'`/`'failed'` から `'interrupted'` に変わりうる（(b)）。 |
| `forbidOnly` | **yes** | channel-provided（`FullConfig.forbidOnly`。実測値: `false`） | tree 内に `test.only`/`describe.only` が存在する場合、`forbidOnly: true` は起動時エラーで run 全体を止める。同じ tree（`.only` を含む）で `forbidOnly` の値だけを変えると、run が全体として成立するか（全 test が `unreported`）と、成立して通常実行されるか、が変わる（(b)、最も極端な形の verdict 変化）。本 probe の tree には `.only` を含まないため直接の A/B 実測はしていないが、Playwright の公開仕様として決定的に成立する挙動であるため yes と判定する。 |
| `globalTimeout` | **yes** | channel-provided（`FullConfig.globalTimeout`。実測値: `0` = 無制限） | run 全体の時間予算。`0` 以外を設定し run 全体がこの時間を超過すると、実行中/未実行のテストが `'interrupted'`/`'timedOut'` として報告される。`maxFailures` と同型の early-abort 経路であり、値を変えれば同一 tree でも後続テストの `status` が変わりうる（(b)）。 |
| `use.launchOptions`（および project 単位の `use.*` 全般） | **yes** | channel-provided（`FullProject.use`。実測: `{"launchOptions":{}}` — `PROBE_CHROMIUM_PATH` 未設定時。設定時は `{"launchOptions":{"executablePath": "..."}}` になる想定、`playwright.config.ts:33-37`） | `launchOptions.executablePath`（起動する Chromium バイナリ）やその他の `use` オプション（`headless`/`viewport`/`trace`/`screenshot`/`video` 等、design doc §3.3 要件5「annex / `context_digest`」が挙げる shift-bud 実物設定）はブラウザの挙動・attachment 生成の有無を左右する。ブラウザ差異はエラーの `message` 形式・`snippet` 内容を変えうる（(a)）ため yes と判定する。本 probe は browserless-first（architecture_decisions）のため `launchOptions` 以外の `use` フィールドは playwright.config.ts で未設定であり実測 dump にも現れていない（`observations/locator-blocked.md` 参照 — locator/page シナリオは sandbox 環境要因で実行不能）。`use.*` の個別フィールド単位の粒度分解（例: `trace` は attachment=annex 側の関心で `context_digest` の役割ではないか）は Phase 2 実装時の細目として申し送る。 |
| `rootDir` | **no** | 該当なし（config_digest に含めない） | design doc §3.5 が指摘する `repo.worktree` と同型の絶対パス問題。`rootDir` は同一 config・同一 tree でも worktree の物理配置が変わるだけで値が変化し、CE-2 が evidence digest から絶対パスを除外するのと同じ理由で config_digest に含めるべきではない — 含めると同一 config でも worktree を変えただけで `instrument-changed` が過剰発火し、same-instrument rule（spec §6.2）の実効性を損なう。`rootDir` 自体は同一 tree・同一 selector で値だけを変える、という操作的定義の前提が成立しにくい（`rootDir` は `configFile` の位置から導出される派生値であり独立に変えると tree 解決が崩れる）ため、この点でも yes/no 判定になじまない administrative な値と整理する。 |
| `configFile` | **no** | 該当なし（config_digest に含めない） | `rootDir` と同じ絶対パス問題。`configFile` の**内容**（resolved 設定値そのもの）は本表の他行がすでに個別に covering しており、パス文字列自体は `surface.config_sources`（config ファイルの digest を担当する既存の役割。vitest 側の同名フィールド、`vitest-native-1.md` §1 参照）の管轄であって `config_digest` の代替にはならない（§4.1.1 契約の逆方向の帰結 — ファイル digest が config_digest の代替にならないのと対称に、config_digest もファイルパスを covering する必要はない）。 |

## 5. 判定根拠（合成プロジェクトでの実測参照）

architecture_decisions の決定（シナリオ切替は環境変数のみで行い `playwright.config.ts` は
1本のみ）により、本 probe は `config_digest` 候補フィールドの値そのものを変化させる A/B
実験を行っていない（0b-core-2 が行った rerun/unrelated-edit/line-shift の3実験は、evidence
フィールド側の CE-2/CE-3 実測であり config フィールドの A/B ではない）。そのため §4 の
判定は次の2種の実測・構造根拠を組み合わせて行った:

1. **resolved FullConfig dump の構造的事実**（実測）: `probes/playwright-0b-core/observations/
   {baseline,flaky,setup-cascade,locator}.json` の `.config` は4ファイルすべてで同一値
   （`workers: 5`, `shard: null`, `fullyParallel: true`, `retries: 2` 等）であることを
   `jq` で突合済み。この dump に **存在するフィールドの型・値**（例: `projects[].retries` が
   確かに `FullConfig` 経由で読める）と、**存在しないフィールド**（`expect` が
   `FullProject` に一切現れない）の両方が実測根拠になる。
   ```
   $ jq '.config | keys' probes/playwright-0b-core/observations/{baseline,flaky,setup-cascade}.json
   ["configFile","forbidOnly","fullyParallel","globalTimeout","grep","grepInvert",
    "maxFailures","projects","reporter","rootDir","shard","workers"]
   （3ファイルとも同一キー集合）
   $ jq '.config.projects[0] | keys' probes/playwright-0b-core/observations/baseline.json
   ["dependencies","name","retries","testDir","testIgnore","testMatch","timeout","use"]
   ```
2. **Reporter API 型定義との突合**（実測）: `node_modules/playwright/types/test.d.ts` の
   `FullProject`（`:650-724`）・`FullConfig`（`:1726-1845`）インターフェースを
   `TestProject`（authoring 用入力型、`expect?:` を含む）・`TestConfig` と比較し、
   `expect` が resolved 型に存在しないことを型定義レベルでも確認した（dump の実測と型定義の
   両方が一致することで「たまたま今回の実行で undefined だった」ではなく「この Reporter API
   バージョンの構造として提供されない」ことを裏付けている）。
3. **evidence-affecting semantics の構造推論**（0b-core-1〜3・5 の実測結果からの外挿）:
   `retries`/`timeout`/`projects`/`shard` は 0b-core-3・0b-core-5 で実際に挙動が確認されて
   いる（flaky マップ・skip カスケード）。`workers`/`fullyParallel`/`maxFailures`/
   `globalTimeout`/`forbidOnly`/`grep`/`grepInvert`/`use.*` は Playwright の公開仕様
   （型定義のコメント、`node_modules/playwright/types/test.d.ts` の JSDoc）から導かれる
   決定論的挙動に基づく判定であり、`vitest-native-1.md` §4 の `environment`/`pool`/
   `isolate`/`sequence` 行が実装調査＋部分的実測を組み合わせて判定したのと同じ方法論を
   踏襲する。

## 6. 変更規律

本列挙リスト（§4 判定表）の変更は composition の変更である。spec §3.6 末尾:

> The declared composition is part of the measuring instrument: any
> composition change requires an adapter version change (§6.2).

に基づき、列挙リストへの項目追加・削除・判定変更は `instrument.adapter_version` の変更を
要求する。これは §6.2 same-instrument rule により、instrument が変われば2 run 間の
comparability が `exact` と主張できなくなる（`instrument-changed`）ことの直接の帰結である。
本文書は Phase 2 実装前の予約列挙リストであるため、**Phase 2 の初回実装がこの列挙を
`composition_id: playwright-native/1` として bind した時点**が本規律の起点になる
（実装前の本文書自体の改版は git 履歴として残るのみで adapter_version には影響しない —
まだ adapter が存在しないため）。

## 7. note: vitest への影響について

本文書が確定する列挙は `playwright-native/1` のものであり、`vitest-native-1.md` §7 (a) が
記録している「multi-project workspace の per-project config 分岐は未 covering」（vitest
adapter は root の resolved config のみを capture し、project 毎の differences は covering
しない）という既知ギャップとは**別問題**である。vitest 側のこのギャップの解消可否は本 issue
（#53）のスコープ外であり、本文書は何の判定も追加しない（issue #53 本文の note を転記）。

## 8. capability 宣言: `source-region-text`（issue #53 / F5 確定）

本節は §4（`instrument.config_digest` 判定表）とは別軸の宣言である。§4 は instrument の
同一性判定に使う config digest を対象とするのに対し、本節は spec §3.2 CE-1「failing source
region text」要件を composition がどう `capabilities` 宣言（`instrument.capabilities`、
`src/schema.ts:308`, `CAPABILITY_VALUES = ['pass', 'fail', 'unsupported']` — `:47`）として
開示するかを対象とする。

### 対象 capability

`source-region-text` は `vitest-native-1.md` の実装（`VITEST_CAPABILITIES`,
`src/adapters/vitest/recorder.ts:67-74`）が**唯一 `'unsupported'` を宣言している** capability
である（vitest の structured channel は CE-1 の failing source region text を提供しない）。

### 0b-core-1 / 0b-core-2 実測結果（判定根拠）

| 候補 provenance | 判定 | 実測根拠 |
| --- | --- | --- |
| channel-provided（`error.snippet` をそのまま使う） | **不可**（CE-3 line-shift 安定性に違反） | probes/playwright-0b-core の 0b-core-2 (ii) 行ズレ実験で `steps.line_shift.raw_snippet_identical === false` を確認（`probes/playwright-0b-core/observations/stability-report.json`）。snippet は絶対行番号ガター付きテキストを埋め込むため、行ズレでバイト列が変わる |
| tree-reconstructed（`error.location` + recorded source tree → `sourceLineText`） | **可**（CE-2 rerun 安定性・CE-3 line-shift 安定性いずれも満たす） | 0b-core-1 CE-1「failing source region text」行、0b-core-2 (i)(ii)(iii) 実測（同一 tree 再実行・無関係編集・行ズレいずれも `sourceLineText` 完全一致）。実装参照: `probes/playwright-0b-core/project/scripts/analyze-stability.mjs` の `sourceLineTextAt()` / `findEnclosingFrame()` |

### 確定した宣言文言

```
'source-region-text': 'pass'  // provenance: tree-reconstructed
                               // (spec §3.6 option (b) — error.location [channel-provided
                               // pointer] + recorded source tree から sourceLineText を
                               // 決定的に再構成。raw error.snippet [channel-provided] は
                               // line-shift 不安定なため使用しない。0b-core-1/2 実測、
                               // probes/playwright-0b-core/observations/stability-report.json)
```

Phase 2 実装で `PLAYWRIGHT_CAPABILITIES`（`VITEST_CAPABILITIES` と同型の
`CapabilityDeclaration`、`src/adapters/vitest/recorder.ts:67` 相当）を新設する際、
`source-region-text: 'pass'` を上記 provenance コメント込みで宣言する。spec §3.6 末尾
「composition MUST distinguish channel-provided from tree-reconstructed; silent omission is
non-conforming」（`spec/veridelta-1.md:269-270`）への適合として、provenance の明記はコード
コメントの体裁だけに頼らず composition doc 本体（本節）に一次情報として残す。

### 位置づけ

vitest が唯一 `unsupported` にしている capability を Playwright が `pass` で宣言できる、という
本節の結論は、capability 宣言設計（composition ごとに `pass`/`fail`/`unsupported` を宣言し
comparator がそれに応じて振る舞いを変える設計）が実際に機能する実証である。同一 spec 要件
（CE-1 failing source region text）に対して runner ごとに異なる capability 値を宣言でき、その
差が record に構造化されて残る、という設計意図が 0b-core probe の実測により裏付けられた。

## 9. 未公開フィールド `matcherResult` の実在と不採用判定（issue #53 / PR #54 レビュー指摘）

### 実測した事実

`TestResult.errors[]` の**実行時オブジェクト**には、`TestError` 型
（`node_modules/playwright/types/testReporter.d.ts:556-588`）が宣言しないフィールド
`matcherResult` が載ることがある。`@playwright/test` 1.49.1 pin で実測した内容:

| 観測項目 | 実測値 |
| --- | --- |
| 付与条件 | `node_modules/playwright/lib/worker/util.js:25-29` の `testInfoError()` が `error instanceof ExpectError` の場合にのみ `result.matcherResult = error.matcherResult` を代入する。`toEqual`/`toBe` 等の matcher 由来失敗でのみ出現し、`throw new TypeError(...)` や test timeout 由来では `null`（キー自体が無い） |
| 構造 | `{ name, expected, actual, pass, message }`。`name` は matcher 名（`'toEqual'` / `'toBe'`）、`pass` は `false` |
| `expected` / `actual` の値 | **ANSI を含まない生の構造化値**。`toEqual` の例で `expected = {"a":2,"b":"y"}` / `actual = {"a":1,"b":"x"}`、`toBe` の例で `"expected string"` / `"actual string"` |
| 実測装置・観測 | `probes/playwright-0b-core/project/scripts/capture-matcher-result.mjs`、`probes/playwright-0b-core/observations/matcher-result.json` |

すなわち spec §3.2 CE-1 の asserted values（expected/actual）は、**構造化された値としては
channel に流れている**。「rendered diff テキストとしてしか手に入らない」という当初の 0b-core-1
記述は、probe の `serializeResult()` が message/stack/location/snippet/value の 5 フィールド
whitelist を通していたために生じた観測漏れであり、PR #54 レビュー指摘を受けて撤回・訂正した
（`probes/playwright-0b-core/README.md` 0b-core-1 節の訂正ブロックと CE-1 asserted values 行）。

### 判定: 不採用（determined）

本 composition は `matcherResult` を **evidence として採用しない**。理由:

1. **型契約の外にある** — `reporter.d.ts` の `TestError` に宣言が無く、公開 API の一部として
   documented されていない。`ExpectError` の内部プロパティを reporter 層へ透過させている
   実装詳細であり、semver の互換性保証の対象外である。
2. **版脆弱性** — 採用すると、record の spec §3.2 CE-1 適合性が「pin した 1.49.1 でのみ成立が
   確認された未公開フィールドの存在」に依存する。Playwright の minor/patch 更新で消失または
   形状変更が起きても検知できるのは記録時ではなく比較時であり、`instrument` の同一性判定
   （spec §6.2 same-instrument rule）では捕捉できない失敗モードになる。
3. 採用しないことによる損失は**限定的**である — asserted values は `message` に
   `text-embedded-in-message` provenance として残り、composition がその区分を明記する限り
   spec §3.6 末尾の silent-omission 要件には抵触しない。

### 記録上の扱い

- 0b-core-1 の CE-1 asserted values 判定は「**満たさない**（型が宣言する公開フィールドの範囲
  では）」を維持する。ただしその根拠は「構造化値が取得できないから」**ではなく**「型契約の外に
  ある証拠に record の適合判定を依存させないため」であることを明示する。
- Phase 2 で方針を変える場合（`matcherResult` を採用する場合）は、本節の 3 点を覆す根拠
  — 具体的には Playwright 側で `matcherResult` が `TestError` に型として追加されたこと —
  を示した上で本節を改訂する。それまでは本節が「検討済みで不採用」の一次記録である
  （§6 変更規律に従い、判断の撤回には同節の改訂を要する）。

## 10. Phase 2 実装の capability 宣言（確定）（issue #55 / F4）

`playwright-native/1` は Phase 2 で実装済みである。本節は §8（`source-region-text`）を
含む `PLAYWRIGHT_CAPABILITIES` 全8項目の確定した宣言文言を一次情報として記載する
（実装: `src/adapters/playwright/recorder.ts` の `PLAYWRIGHT_CAPABILITIES` 定数）。
`vitest-native/2` の `VITEST_CAPABILITIES`（6項目、`src/adapters/vitest/recorder.ts:67-74`）
と同型の `CapabilityDeclaration` だが、playwright は2項目多い —
`source-region-text`/`retry-evidence`/`resolved-config-coverage` の3項目で vitest と
宣言値が異なる（vitest は前者2つを持たず、`resolved-config-coverage` という capability
自体を持たない — vitest の `config_digest` は `instrumentConfigDigest` が resolved config
を直接読めるため、この capability が意味を持つのは playwright 固有の channel-unavailable
問題があるからである）。

```
export const PLAYWRIGHT_CAPABILITIES: CapabilityDeclaration = {
  verdicts: 'pass',
  'source-location': 'pass',
  suppression: 'pass',
  inventory: 'pass',
  'failure-evidence': 'pass',
  'source-region-text': 'pass',       // provenance: tree-reconstructed
  'retry-evidence': 'pass',           // provenance: annex.attempts
  'resolved-config-coverage': 'unsupported', // provenance: channel-unavailable
}
```

各 provenance:

| capability | 値 | provenance | 根拠 |
| --- | --- | --- | --- |
| `source-region-text` | `pass` | `tree-reconstructed` | §8 で確定した宣言をそのまま実装した。`error.location`（channel-provided pointer）+ 記録済みソースツリーから `sourceLineText` を決定的に再構成する。raw `error.snippet`（channel-provided）は line-shift 不安定なため使用しない（0b-core-1/2 実測、`probes/playwright-0b-core/observations/stability-report.json`）。 |
| `retry-evidence` | `pass` | `annex.attempts` | リトライごとの evidence（各 attempt の `errors`/`frames`）を `FailureFinding.annex.attempts` に格納する（schema.ts の optional 追加、architecture_decisions 参照）。outcome 'flaky' の record 側マッピング（D2 実装機構1）はこの evidence を使って構築される。 |
| `resolved-config-coverage` | `unsupported` | `channel-unavailable な expect.timeout の開示` | §4 `expect.timeout` 行が確定した Phase 2 決定6の実装。resolved `FullConfig`/`FullProject` が `expect.timeout` を一切公開しないため（§4 実測）、`instrumentConfigDigest`（`src/adapters/playwright/recorder.ts`）はこのフィールドを covering できないことを capability 宣言で開示する。tree-reconstruction 案（`playwright.config.ts` ソース自体を解析する）は不採用。 |

`resolved-config-coverage` は `schema.ts` の `EVIDENCE_CAPABILITY_NAMES`（`failure-evidence` /
`source-region-text` の2件、CE-1 系の capability に限定）に含まれない — instrument-config
capability であって evidence capability ではないため。したがって `src/compare.ts` の
`evidenceDisclosure` が導出する report の `failure_evidence.degraded_capabilities` には
`resolved-config-coverage` は決して現れない（常に `[]`）。degraded の機械可読な開示は
record の `instrument.capabilities['resolved-config-coverage'] === 'unsupported'` が担う
（`conformance/fixtures/pw-smoke/manifest.json` が record 側のこの宣言と report 側の
`degraded_capabilities` が空であることの両方を conformance で固定している）。
