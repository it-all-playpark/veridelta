# vdelta MVP 実装中に見つけた spec の曖昧点・不足 (findings)

対象: spec/veridelta-1.md revision 0.3.0。spec は変更せず、ここに記録して PR で提案する
（実装規約: 「spec の矛盾・不足を見つけたら spec を黙って変えず findings として記録」）。

各項目: **観察** → **実装の暫定判断**（docs/conformance-harness.md に契約として固定）→ **spec への提案**。

## F-1. `comparability: none` レポートの「structured current-run results」の形が未規定

- **観察**: §6.1 は `none` の permitted claims を "Structured current-run results
  only" とするが、§9.1 の report contract にその形が無い。一方 §14 は unknown
  field の reject を consumer に SHOULD で課すため、実装が独自フィールドを足すと
  consumer 互換性が壊れる。INV-1（red の非省略）は `none` レポートにも及ぶと
  読むべきで、current run の red 一覧をどこかに置く必要がある。
- **暫定判断**: `none` では `baseline: null`、`transitions`/`verification_surface`
  は省略、`current.red`（sorted test_id 配列）で red を全列挙し anchors を張る。
  例外: reason が `instrument-changed` 等で観測可能な surface event がある場合は
  §11.5 の要求どおり `verification_surface.events` を出す。
- **提案**: §9.1 に `none` 時の current-run 結果の normative な形
  （`current.red` 相当）を追加する。

## F-2. §11.1 (report-only の exit) と §11.2 (integrity failure → exit 2) の緊張

- **観察**: §11.2 は record integrity 検証失敗を「→ exit 2」と書くが、§11.1 の
  policy 表は report-only を「Always 0; 2 only if the gate itself cannot
  produce a report」とする。integrity failure でも report は生成可能。
- **暫定判断**: §11.1 の policy 表を正とし、report-only では integrity failure
  も verdict `inconclusive` + `comparability_detail: record-integrity-failed`
  のレポートを出して exit 0。blocking/advisory（MVP 対象外）でのみ exit 2。
- **提案**: §11.2 の exit 記述に「subject to the policy table of §11.1」を付す。

## F-3. degraded_capabilities の per-claim carry の serialization が未規定

- **観察**: §9.1 は「every still_fail_unchanged and updated_fail claim MUST
  carry it」と課すが、still_fail_unchanged のエントリ形は「test-ID 文字列、
  または context_changed 時の object」としか規定されず、degraded を carry する
  object 形が無い。
- **暫定判断**: degraded_capabilities が非空の adapter（vitest は常時
  `["source-region-text"]`）では、still_fail_unchanged エントリを常に
  `{"test_id", "degraded_capabilities", "context_changed"?}` object とし、
  updated_fail エントリにも `degraded_capabilities` フィールドを付ける。
- **提案**: §9.1 のエントリ形定義に degraded carry の object 形を明記する。

## F-4. previous-comparable の「most recent」と timestamp 禁止の緊張

- **観察**: §3.1 は timestamps を「duplicate matching 以外に使うな」とするが、
  §5.2 previous-comparable は「Most recent complete run」を要求する。recency の
  決定手段が timestamp しかないなら矛盾する。
- **暫定判断**: store に append-only の挿入順 index を持ち、「most recent」は
  挿入順（timestamp 非依存・決定的）で解決する。
- **提案**: §5.2 に「recency は store の記録順（挿入順）で決まり、timestamp に
  依存してはならない」を明記する。

## F-5. git-ref baseline の「provenance matches the given ref」の一致条件

- **観察**: §5.2 は git-ref を「Complete run whose provenance matches the
  given ref」とするだけで、head SHA 一致だけで良いのか、dirty tree で記録された
  run（head は一致するが tree が違う）を含むのかが未規定。INV-11 の精神からは
  tree 一致が必要。
- **暫定判断**: `provenance.head == resolve(ref)` **かつ**
  `tree_digest == ref^{tree}` の complete run のみ一致とする（dirty 記録は
  git-ref baseline にならない）。
- **提案**: §5.2 の git-ref 行に tree 一致条件を明記する。

## F-6. xfail への「fail_to_xfail」判定に必要な verdict refine の INV-3 整合

- **観察**: vitest の verdict channel は `test.fails` で実際に失敗したテストを
  `state: "passed"` と報告する（expC 実測）。これを `pass` のまま記録すると
  fail→xfail の cheating が `repaired_with_test_change` としてしか見えない。
  マーカー（`options.fails`、構造化チャネル）で `xfail` に refine することは
  INV-3（テキスト由来禁止）に反しないと解するが、spec に明文がない。
- **暫定判断**: 構造化マーカーによる verdict refine（passed+fails→xfail）を
  行い、composition で宣言する。
- **提案**: §7.1 に「runner の構造化マーカーによる suppression verdict への
  refine は verdict channel の一部とみなす」旨を追記する。

## F-7. `partial` comparability 下の outcome_verdict

- **観察**: §6.1 partial は repaired/missing/unchanged の主張を禁じるが、
  観測できた new_fail/updated_fail がある場合に outcome_verdict を `regressed`
  として良いか、常に `inconclusive` かが未規定。
- **暫定判断**: 観測事実として new_fail/updated_fail があれば `regressed`
  （どちらも両 run の観測事実のみから導ける）、無ければ `inconclusive`
  （unchanged は主張できないため）。
- **提案**: §7.2 に partial 時の verdict 導出規則を明記する。
