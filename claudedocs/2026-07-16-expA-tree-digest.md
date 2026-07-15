# veridelta `tree_digest` — 実測確定レポート (expA)

対象: git worktree の内容（tracked + uncommitted + untracked、ignored 除外）を
bit-exact に識別する `tree_digest` の算出アルゴリズムを実測で確定する。
用途: TOCTOU 検証（記録した run の tree と gate 判定対象 PR HEAD の完全一致）。

実験環境: macOS (Darwin 25.5.0, arm64) / git 2.54.0 / bash 5.3。
実験リポジトリ群は `$TMPDIR/expA/` 配下に生成（ジョブ tmp は sandbox 書込不可のため）。
検証スクリプト: `$TMPDIR/expA/exp_*.sh`、確定版関数: `$TMPDIR/expA/tree_digest_final.sh`。

---

## 1. 確定版アルゴリズム

要点は 3 つ。**(a)** 専用 `GIT_INDEX_FILE` で実 index を汚さない、
**(b)** `read-tree HEAD` で seed してから `add -A` することで未 checkout の
submodule gitlink を保持する、**(c)** 環境依存を生む git 設定を明示的に pin する。

```sh
tree_digest() {
  # 引数: <worktree-dir>（省略時 .） / 出力: 40hex の tree OID を stdout に
  wt="${1:-.}"
  idx="$(mktemp "${TMPDIR:-/tmp}/vd-idx.XXXXXX")" || return 1

  # 環境非依存化の pin:
  #   core.autocrlf=false / core.eol=lf  -> マシンの改行正規化設定を無効化
  #   core.excludesFile=/dev/null        -> global gitignore の混入を無効化
  #   advice.addEmbeddedRepo=false       -> 埋め込みリポジトリ警告を抑制
  G="git -c core.autocrlf=false -c core.eol=lf -c core.excludesFile=/dev/null -c advice.addEmbeddedRepo=false -C $wt"

  # HEAD があれば seed（gitlink 継承のため必須）。unborn なら空 index。
  if $G rev-parse --verify -q HEAD >/dev/null 2>&1; then
    GIT_INDEX_FILE="$idx" $G read-tree HEAD   || { rm -f "$idx"; return 1; }
  else
    GIT_INDEX_FILE="$idx" $G read-tree --empty || { rm -f "$idx"; return 1; }
  fi
  GIT_INDEX_FILE="$idx" $G add -A             || { rm -f "$idx"; return 1; }
  GIT_INDEX_FILE="$idx" $G write-tree          # ← この tree OID が tree_digest
  rc=$?; rm -f "$idx"; return $rc
}
```

コピペ用（関数を使わない素のコマンド列。`$WT` は対象 worktree）:

```sh
IDX="$(mktemp "${TMPDIR:-/tmp}/vd-idx.XXXXXX")"
G="git -c core.autocrlf=false -c core.eol=lf -c core.excludesFile=/dev/null -c advice.addEmbeddedRepo=false -C $WT"
if $G rev-parse --verify -q HEAD >/dev/null 2>&1; then
  GIT_INDEX_FILE="$IDX" $G read-tree HEAD
else
  GIT_INDEX_FILE="$IDX" $G read-tree --empty
fi
GIT_INDEX_FILE="$IDX" $G add -A
GIT_INDEX_FILE="$IDX" $G write-tree   # => tree_digest
rm -f "$IDX"
```

元の候補アルゴリズム（`read-tree HEAD; add -A; write-tree`）は**骨子として正しい**。
確定版で加えた差分は次の 3 点、いずれも実測で必要性を確認済み:

1. `read-tree HEAD` の seed が **submodule 未 checkout 時に load-bearing**（§3 EXP-seed）。
   これが無いと未 checkout submodule の gitlink が digest から欠落し、
   clean checkout でも `HEAD^{tree}` と一致しなくなる（CI の非 recursive checkout で頻発）。
2. `core.autocrlf=false -c core.eol=lf` の pin で改行正規化のマシン依存を排除（§3 EXP-autocrlf）。
3. `core.excludesFile=/dev/null` の pin で global gitignore の混入を排除（§3 EXP-excludes）。
4. unborn HEAD（コミット無し）分岐と、専用 index による実 index 非汚染は候補どおり。

---

## 2. 実測結果表

| # | 項目 | 期待 | 実測 | 判定 |
|---|------|------|------|------|
| 1 | 同一 worktree で2回実行 | 同一 OID | 同一 | PASS |
| 2 | untracked 追加が OID に反映 | 変化 | 変化（再現性も有） | PASS |
| 3 | ignored（`*.log`, `.veridelta/`）は OID 不変 | 不変 | 不変（非 ignored 追加は変化） | PASS |
| 4 | symlink 追加 / リンク先変更（mode 120000） | 変化 | 追加・retarget とも変化 | PASS |
| 5 | 実行 bit（100644→100755, blob 同一） | 変化 | mode のみ差で tree OID 変化 | PASS |
| 6 | 空ディレクトリ | 無視（不変） | 不変（git は空 dir を追跡不可） | PASS (制限) |
| 7a | clean checkout の digest == `HEAD^{tree}` | 一致 | 一致 | PASS |
| 7b | 別ディレクトリ・別作成順で同一内容 → 同一 OID | 一致 | 一致（clone dirty 再現も一致） | PASS |
| 8a | submodule gitlink が OID に含まれる | 含む | 160000 commit エントリで含む | PASS |
| 8a2 | submodule の checkout commit 変更 | 反映 | gitlink 変化で OID 変化 | PASS |
| 8b | submodule 内部 dirty（未コミット） | 検出されない | 検出されない | 制限（確認済） |
| 9 | tracked 削除（rm のみ、git rm せず） | 反映 | エントリ消滅で OID 変化 | PASS |
| 10 | mtime のみ変更（touch） | 不変 | 不変 | PASS |
| 11 | 実 index / `git status` を汚さない | 不変 | 前後で status・write-tree 不変 | PASS |
| E1 | autocrlf 設定差で OID が変わるか（pin 前） | 変わりうる | false vs input で OID 相違（**リスク**） | 確認 |
| E2 | pin 後は local autocrlf 設定に非依存 | 安定 | true/input/unset で同一 OID | PASS |
| E3 | pin が clean==`HEAD^{tree}` を壊さないか | 壊さない | attr 有/無・CRLF checkout 全ケース一致 | PASS |
| E4 | global excludesFile 混入（pin 前） | 混入する | 対象ファイルが欠落（**リスク**） | 確認 |
| E5 | pin 後は global excludesFile に非依存 | 安定 | local 設定より pin が優先 | PASS |
| E6 | unborn HEAD + untracked | 決定的、commit 後 `HEAD^{tree}` と一致 | 一致 | PASS |
| E7 | 空 worktree | git empty-tree OID | `4b825dc6…4904` | PASS |

補足エビデンス:
- **5 (実行 bit)**: 同一 blob `4163036e…` に対し `100644` と `100755` で親 tree OID が変化。
  git tree はモードを含むため、内容不変でも権限差を bit-exact に捉える。
- **7b (クロス checkout)**: 作成順 AB の repo と BA の repo、および clone 先で同一 dirty を
  再現した 3 者すべてで `e7bf610f…` に一致。digest は絶対パス・作成順に非依存
  （git が index エントリを名前順にソートするため）。
- **8b (submodule 内部 dirty)**: superproject の `git status` は `S.MU`（submodule に
  modified + untracked あり）を表示するが、gitlink OID は不変のため digest は変化しない。

---

## 3. 環境依存リスクと制限事項

### 3.1 digest に反映されない（構造的制限）
- **空ディレクトリ**: git はファイルを持たない空 dir を追跡できない。空 dir の有無は
  digest に現れない。運用上は `.gitkeep` 等のプレースホルダで回避する前提。
- **submodule 内部の未コミット変更**: superproject の digest は submodule の
  **gitlink（コミット OID）のみ**を記録する。submodule worktree 内の tracked 変更・
  untracked ファイルは反映されない。TOCTOU で submodule 内部まで固定したい場合は、
  各 submodule に対して再帰的に `tree_digest` を取り、親の gitlink 差分と併せて検証する
  設計が別途必要（本 digest 単体では submodule 内部改竄を検知できない）。

### 3.2 pin で無効化済み（環境非依存を担保）
- **改行正規化（autocrlf/eol）**: pin 前は `core.autocrlf=false` と `=input/true` で
  同一 worktree から**異なる** digest（`8e0b8f…` vs `063edf…`）。
  `-c core.autocrlf=false -c core.eol=lf` の pin で local 設定 true/input/unset に非依存化。
  重要: この pin は clean==`HEAD^{tree}` を壊さない。`.gitattributes` の `text=auto` は
  content 由来（tree に含まれる）ため常に決定的に効き、Windows 風 CRLF checkout でも
  pinned digest は `HEAD^{tree}` に一致することを実測（EXP-pin CASE A/B/C/D 全 PASS）。
- **global gitignore（core.excludesFile）**: pin 前はマシンの `~/.config/git/ignore` 等が
  untracked の採否に混入。`-c core.excludesFile=/dev/null` で無効化（local 設定より pin 優先）。

### 3.3 残存する軽微な非決定要因
- **`.git/info/exclude`**: git は常にこれを読むため `-c` では無効化できない。
  ただし `git init`/`clone` が生成するデフォルトは**コメントのみ（アクティブパターン 0 行）で
  inert**であることを確認済み。手動でパターンを追記した場合のみ digest に影響する。
  厳密な cross-machine 決定性が要る場合の**strict オプション**として、計算中だけ
  `.git/info/exclude` を空にして直後に復元する方式が機能することを実測
  （data.secret が digest に含まれるようになり、ファイルは復元される）。
  ただしこれは一時的なリポジトリ metadata の書換えを伴うため、既定は非採用を推奨。
- **repo ローカル `.gitattributes`**: これは tree content の一部なので同一内容なら
  リポジトリ間で一貫する（非決定要因ではない）。念のため記録。

---

## 4. gate 側の対応式

TOCTOU の gate は「記録された run の `tree_digest`」と「判定対象 PR HEAD の tree」を比較する。

- **PR HEAD が clean（コミット済み状態そのもの）の場合** — 最も一般的:
  ```sh
  git -C "$WT" rev-parse 'HEAD^{tree}'      # == 記録された tree_digest
  ```
  実測で `tree_digest(clean) == HEAD^{tree}` を全ケースで確認済み。gate は `add` 不要で
  この 1 コマンドで足りる。CI が submodule を非 recursive で checkout していても
  （submodule dir が空でも）、`HEAD^{tree}` は commit 由来の gitlink を含むため一致する。

- **PR HEAD 側でも dirty 状態を厳密検証したい場合**（gate が worktree を直接見る等）:
  §1 の `tree_digest` を gate 側でも同一に適用し、OID を突き合わせる。
  同一内容なら絶対パス・OS・作成順・改行設定・global gitignore に依存せず一致する。

- **submodule を含む repo で内部まで固定する場合**: §3.1 の通り、親 digest に加えて
  各 submodule の再帰 digest を別途照合する（親 digest 単体では submodule 内部を担保しない）。

---

## 5. spec に書くべき normative 文（英語, proposal）

> The `tree_digest` of a git worktree MUST be computed as a git tree object id
> over the union of tracked, staged, unstaged, and untracked files, excluding
> paths ignored by committed `.gitignore`/`.gitattributes` rules. Implementations
> MUST compute it against a dedicated, throwaway index (`GIT_INDEX_FILE`) seeded
> from `HEAD` (`git read-tree HEAD`, or `read-tree --empty` for an unborn `HEAD`),
> followed by `git add -A` and `git write-tree`, so that the operation never
> mutates the repository's real index or working tree. To keep the digest
> deterministic and independent of host and time, the computation MUST pin
> `core.autocrlf=false`, `core.eol=lf`, and `core.excludesFile=/dev/null`, and it
> MUST NOT depend on file mtimes. For a clean checkout the resulting id is
> identical to `git rev-parse HEAD^{tree}`, which a verifier MAY use directly as
> the canonical form. The digest records submodules solely by their gitlink commit
> id; it does NOT capture uncommitted changes inside a submodule working tree, and
> it cannot represent empty directories — both are explicit, documented limitations.
