# expB: pytest failure-evidence フィールド感度実測レポート

## 環境
- pytest **9.1.1** / CPython **3.14.6** / venv
- 作業ディレクトリ実体: `/tmp/claude-501/expB/`（job tmp `$CLAUDE_JOB_DIR/tmp` は sandbox 書込不可のため TMPDIR 側に構築。raw dump は下記パス一覧参照）
- 構造化チャネル: `pytest_runtest_logreport(report)` フック（conftest.py）。各 report(setup/call/teardown) の `longrepr` 構造・`report.sections`・`report.location`・`duration`・`keywords` を JSON 化。
- サンプル: 6 失敗パターン（素の assert 失敗 / call 例外 / setup fixture error / parametrize 一部失敗 / captured 非決定値付き失敗 / xfail(strict) の xpass）

## 実測シナリオ
| ID | 操作 | 目的 |
|----|------|------|
| S0 | baseline | 基準 dump |
| S1 | コード無変更で再実行 | 再実行安定性 |
| S2 | ファイル先頭に無関係コメント3行挿入 | 行シフト感度 |
| S3 | 末尾ヘルパ関数の中身を in-place 変更（行数不変・対象テストに無影響） | 無関係編集の不変性 |
| S4 | `get_status()` の返値 500→404（in-place・行シフト無し） | 真のシグナル変化 |
| S5 | `--tb=auto/long/short/line/native` | runner config が evidence に与える影響 |
| AR | `--assert=plain` / `python -O` | assertion rewriting 依存性 |

---

## 1. フィールド一覧表（× S1再実行感度 × S2行シフト感度 × S4シグナル性）

凡例: **不変**=値が変わらない / **変化**=値が変わる。「シグナル性=YES」は本物のコード変化(S4)を運ぶフィールド。

| フィールド | S1 再実行 | S2 行シフト | S4 シグナル性 | 分類 |
|-----------|:--------:|:----------:|:------------:|------|
| `nodeid` / `when`(phase) | 不変 | 不変 | 不変(識別子) | identity |
| `outcome` | 不変 | 不変 | 不変(*) | signal(状態遷移時のみ) |
| `duration` | **変化(毎回)** | 変化 | 変化 | **pure noise** |
| `location[0]`(path rel) | 不変 | 不変 | 不変 | core |
| `location[1]`(関数def行, 0-idx) | 不変 | **変化 +3** | 不変 | positional |
| `location[2]`(関数名) | 不変 | 不変 | 不変 | **core (symbol)** |
| `keywords`/markers | 不変 | 不変 | 不変 | core |
| `sections_report[].name` | 不変 | 不変 | 不変 | core |
| `sections_report[].content`(captured stdout/stderr/log) | **変化** | 不変 | 変化しうる | **volatile** |
| `longrepr.type` | 不変 | 不変 | 不変(tb=native時のみ変化) | core |
| `longrepr.reprcrash.path`(**絶対**パス) | 不変 | 不変 | 不変 | volatile(env依存) |
| `longrepr.reprcrash.lineno` | 不変 | **変化 +3** | 不変 | positional |
| `longrepr.reprcrash.message` | 不変 | 不変 | **変化** | **CORE signal** |
| `…reprtraceback.entries[].reprfileloc.path`(rel) | 不変 | 不変 | 不変 | core |
| `…entries[].reprfileloc.lineno` | 不変 | **変化 +3** | 不変 | positional |
| `…entries[].reprfileloc.message`(frame例外ラベル) | 不変 | 不変 | 不変(型不変時) | **CORE (exc type)** |
| `…entries[].lines`(ソース行テキスト+`>`/`E`/`^^^`注釈) | 不変 | **不変** | **変化(Eライン)** | **CORE signal (lineno-free)** |
| `…entries[].reprfuncargs` | 不変 | 不変 | 変化しうる | **CORE signal** |
| `…entries[].style` | 不変 | 不変 | 不変(tb config で変化) | presentation |
| `…entries[].reprlocals` | (既定off) | – | – | volatile(showlocals時) |
| `longrepr.chain_len` | 不変 | 不変 | 不変 | core |
| `longreprtext`(longrepr の str()) | 不変 | **変化**(`file:NN`埋込) | **変化**(message埋込) | **derived/fragile** |

要点:
- **行シフト(S2)で変わるのは lineno 系のみ**: `location[1]` / `reprcrash.lineno` / `reprfileloc.lineno`、および行番号を文字列に埋め込む `longreprtext`。**ソース行テキスト(`lines`)・`message`・frame ラベル・funcargs・entry 構造は完全不変。**
- **S1再実行で変わるのは `duration`(全 report) と captured `content`(非決定値を出すテストのみ)** の 2 種だけ。
- **S4 の真のシグナル(500→404)は `reprcrash.message` と `lines` の `E` 行、そして `longreprtext` にのみ現れる。** lineno は in-place 編集のため不変 → message 変化と lineno 変化は直交。

実測 diff サマリ（`differ.py` の changed-leaf カウント）:
- S0↔S1: `duration`×21, `content`×2 のみ
- S0↔S2: `location`×23, `duration`×19, `lineno`×12, `longreprtext`×5, `content`×2（**`lines`/`message` は変化ゼロ**）
- S0↔S3: `duration`×22, `content`×2 のみ（**構造 evidence 完全不変**）
- S0↔S4: `duration`×23, `message`×2, `lines`×2, `longreprtext`×2, `content`×2（**lineno 変化ゼロ**）

---

## 2. 4つの問いへの実測ベース回答

### Q1. 構造化 evidence を「行番号を除いた core」に分解できるか。core は S1/S2/S3 で安定し S4 で変化するか
**YES（実証済み）。** core を `{outcome, when, reprcrash.message, 各entry:(lines, frame例外ラベル, reprfuncargs, rel_path)}`（lineno・location・duration・sections・絶対path・longreprtext を除外）と定義し、失敗 report 群を sha256 化した結果:

```
S0 e6ae14a9c80f3370
S1 e6ae14a9c80f3370  IDENTICAL
S2 e6ae14a9c80f3370  IDENTICAL   ← 行シフトでも不変
S3 e6ae14a9c80f3370  IDENTICAL   ← 無関係編集でも不変
S4 fec07b699e309c20  DIFFERENT   ← 真のシグナルでのみ変化
```
core は「例外型 + message + ソース行テキスト + entry 構造」で構成でき、狙い通りの感度特性を持つ。

### Q2. captured output(sections)を digest に含めると S1(無変更再実行)で digest が変わる、は事実か
**YES、事実として成立。** テスト5(`print(time.time())`, `id(object())`)の `sections_report[].content` は S1 で
`timestamp: 1784153278.784885 / counter: 4371929120` → `timestamp: 1784153299.341523 / counter: 4342027856`
と変化。digest に sections を含めると **S1 で hash が破れる**:

```
digest variant              S0                S1        S2
core(no sections,no lineno) fb954a2920bb29f3  =SAME     =SAME
+ captured sections         f7150651de28e0e6  BREAKS(S1) BREAKS(S2)
+ reprcrash.lineno          0ae665a8fe4b2b38  =SAME     BREAKS(S2)
```
→ **captured output は digest identity から除外必須**（残すならタイムスタンプ/アドレス等の scrub 正規化が前提）。

### Q3. lineno を除外しても「assertion の位置」を関数相対等の安定形で保持できるか
**YES。** `report.location[1]`(関数def行) と `reprcrash.lineno` から算出した **関数相対オフセット (crash − def) は S0/S2 で全テスト一致**:

| test | S0 (def→crash=rel) | S2 (def→crash=rel) | rel安定 |
|------|-----|-----|:---:|
| test_status_assert | 9→12=**3** | 12→15=**3** | YES |
| test_param[2-5] | 37→40=**3** | 40→43=**3** | YES |
| test_nondeterministic_output | 42→47=**5** | 45→50=**5** | YES |
| test_call_exception | 14→21=**7** | 17→24=**7** | YES |

位置は **(囲む関数シンボル名 `location[2]` + 関数相対行オフセット)** として保持でき、無関係な行シフトに耐える。加えて `lines` のソース行テキスト自体が行番号なしで位置を一意に指す二重のアンカーになる。絶対 lineno は human ナビ用途で annex に残せばよい。

### Q4. 「evidence_digest は同一コード状態での再実行で不変」の normative 要件を pytest で満たせるか。何を除外すべきか
**YES（条件付き）。** S0==S1 の core digest 一致で満たせることを実証。ただし digest 計算で以下を**必ず除外**:
1. `duration`（毎回変化）
2. captured `sections` content（テストが非決定値を出すと変化）
3. `longreprtext`（tb-style・行番号・message を混載する派生文字列。構造化フィールドを使う）

さらに **run config を固定**しないと「同一コードでも evidence が変わる」経路が残る（下記 §4 の落とし穴）。lineno 自体は S1 では不変なので digest に入れても S1 要件は壊さないが、S2(無関係行シフト)で壊れるため「同一コード状態」を厳密に取るなら除外が安全。

---

## 3. evidence 分割案（digest core / volatile annex）の素材データ

**digest core（正規化・不変性保証の対象）**
- `outcome`, `when`(phase)
- exception 型: `entries[].reprfileloc.message`（frame ラベル）
- 正規化 message: `reprcrash.message`（例 `assert 500 == 200`, `ValueError: cannot compute for 10`）
- ソース行テキスト: `entries[].lines`（`>`/`E`/`^^^` 注釈込み、**行番号を含まない**）
- 引数: `entries[].reprfuncargs`（例 `x = 10`）
- 位置(安定形): `location[2]`(関数名) + `(reprcrash.lineno − location[1])`(関数相対オフセット)
- 相対 path: `reprfileloc.path`

**volatile annex（人間/デバッグ用に保持、digest identity から除外）**
- `duration`
- captured `sections`（stdout/stderr/log）※非決定値を含みうる
- 絶対 `reprcrash.path`
- 絶対 lineno 群（`reprcrash.lineno`, `reprfileloc.lineno`, `location[1]`）— ナビ用
- `longreprtext`（表示専用の派生文字列）
- `reprlocals`（`--showlocals` 時のみ、揮発性大）

**実測ハッシュ根拠**: core のみ → S0=S1=S2=S3、S4 のみ差分。+sections → S1 で破綻。+lineno → S2 で破綻。

---

## 4. runner config / 環境が evidence を動かす落とし穴（Q4 の前提条件）

| 要因 | 影響 | digest への含意 |
|------|------|----------------|
| `--tb=auto/long/short/line/native` | `entries[].style`・`lines` 行数・`longreprtext` 書式が変化。native は `longrepr.type` を `ExceptionChainRepr`→`ReprExceptionInfo` に変え、venv 内部フレームまで含み dump が 19k→58k に肥大。**ただし `reprcrash.message` は全 style 不変** | longreprtext を使わず構造化フィールド（message/lines）で digest 化すれば tb-style 非依存 |
| `--assert=plain`（rewriting 無効） | `reprcrash.message` が `assert 500 == 200` → **`AssertionError` に退化**し値シグナル消失 | **digest は assertion rewriting ON（pytest 既定）で計算必須。plain 禁止** |
| `python -O` | rewriting が assert を AST 置換済みのため **影響なし**（assert は生き残り message も保持） | -O 環境でも既定 rewriting なら安全 |
| **stale `__pycache__` の rewrite pyc** | **S4 で 500→404 に変えた後 500 に戻すと、pytest が旧 404 の rewrite バイトコードを再利用し `assert 404 == 200` を報告**（同一サイズ変更 + 粗い mtime 解像度で invalidation key 衝突）。`__pycache__` を消すと 500 に復帰。**`-p no:cacheprovider` はこのキャッシュを消さない**（消すのは `.pytest_cache` のみ） | **「同一コード→同一 evidence」を pytest が破る唯一の経路。** digest 生成 run は `PYTHONDONTWRITEBYTECODE=1` か `__pycache__` クリアで rewrite キャッシュを無効化すべき |

---

## 5. raw JSON dump ファイルパス一覧

ベース: `/tmp/claude-501/expB/`（`/private/tmp/claude-501/expB/` と同一実体）

- スクリプト: `conftest.py`(evidence dumper), `test_sample.py`(6ケース), `differ.py`(field-level diff), `core_digest.py`(lineno-free core hash)
- シナリオ dump（`dumps/` 配下）:
  - `S0.json` baseline / `S1.json` 再実行 / `S2.json` 行シフト / `S3.json` 無関係編集 / `S4.json` シグナル変化
  - `S5_auto.json` `S5_long.json` `S5_short.json` `S5_line.json` `S5_native.json` tb-style別 / `S5_clean.json` キャッシュクリア後
  - `AR_default.json` `AR_plain.json` `AR_optimized.json` assertion-rewriting別
  - 各 `*.stdout*` は human 向け pytest 出力
- 各 dump のキー形式: `"<nodeid>::<phase>"`、値は §1 の全フィールドを含む JSON。

注意: job tmp（`/Users/naramotoyuuji/.claude/jobs/e0d8df14/tmp/`）は sandbox 書込不可のため raw 実体は TMPDIR 側にある。本レポート md のみ job tmp に配置（Write ツール経由）。
