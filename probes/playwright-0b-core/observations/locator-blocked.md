# locator シナリオ: environment-blocked

`scripts/run-scenarios.mjs` の `locator` シナリオは `~/Library/Caches/ms-playwright/` 配下の
`chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell` を検出し
`PROBE_CHROMIUM_PATH` として与えて実行した（`observations/locator.json` に生観測を保存済み）。

## 実測された失敗

キャッシュ済み Chromium の起動そのものが失敗した。`observations/locator.json` の
`tests[].result.errors[0].message` に記録された生ログ:

```
Error: browserType.launch: Target page, context or browser has been closed
Browser logs:

<launching> .../chrome-headless-shell ... --no-sandbox --user-data-dir=... --remote-debugging-pipe --no-startup-window
<launched> pid=NNNNN
[pid=NNNNN][err] [...] WARNING:net/dns/dns_config_service_posix.cc:201] Failed to read DnsConfig.
[pid=NNNNN][err] [...] FATAL:base/apple/mach_port_rendezvous_mac.cc:156] Check failed: kr == KERN_SUCCESS.
  bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.NNNNN: Permission denied (1100)
[pid=NNNNN] <process did exit: exitCode=null, signal=SIGTRAP>
```

3リトライ（`retries: 2`）すべてで同一の `bootstrap_check_in ... Permission denied (1100)` で
落ちている（`observations/locator.json` の `retry: 0/1/2` エントリで再現性を確認済み）。

## 判定: environment-blocked（CDP 非互換ではなくサンドボックス起因）

architecture_decisions / edge_cases は「1.49.1 と新しめの Chromium 間の CDP 非互換で起動不能」を
想定していたが、実測されたエラーは CDP プロトコルの不一致ではなく **macOS の mach port
rendezvous（プロセス間の Mach IPC ハンドシェイク）が `Permission denied` で拒否されている**
という、本 probe の実行環境（sandboxed shell）に起因する失敗である。ブラウザプロセス自体は
起動 (`<launched> pid=...`) してから即座に `FATAL` で終了しており、Playwright / Chromium の
バージョン互換性とは別レイヤーの制約である。

これは edge_cases が明示的に許容する「CDP 非互換で起動不能な場合」と同じ扱い
（**environment-blocked として記録し、捏造しない**）に該当する — 原因の特定レイヤーが
事前登録した仮説（CDP 非互換）と異なるだけで、「この実行環境では locator シナリオの
ブラウザ起動を伴う観測ができない」という結論自体は変わらない。sandbox 外（通常の CI /
ローカル端末）で実行すればこの制約は再現しない可能性が高い。

## 0b-core-2 への影響と代替根拠

README「事前登録」節が定めた通り、locator が environment-blocked の場合の代替方針をここで
確定する:

- **timeout シナリオの実測**（`observations/failures.json` の `tests/app.spec.ts` >
  `timeout message is observed`）で、`error.message` は `"Test timeout of 1000ms exceeded."`
  （ANSI 色コード込み）のまま `retry: 0/1/2` の3回とも**一字一句不変**であることを確認した
  （`stability-report.json` の対象ではないが `observations/failures.json` に生記録あり）。
  timeout メッセージ自体は揮発しない安定フィールドである。
- 一方、設計 doc §3.3-6 が事前登録した警告（locator の retry ログ `'locator resolved to'` の
  回数が run 間で揮発しうる）は Playwright の locator 実装（`expect(locator).toBeVisible()` の
  ポーリングリトライ）の性質上の一般的既知動作であり、component 自体が本実行環境で起動できな
  かったことは、その一般的性質を否定する材料にはならない。
- 結論（**determined**）: CE-2 の whole-field 除外規律は「揮発する可能性のあるフィールドは
  値の中身で判定せず丸ごと除外する」という**規範**であり、timeout シナリオの安定性実測と
  設計 doc §3.3-6 の事前登録警告から独立に確定できる。locator の実測が無くても、
  「message フィールドが揮発しうる（locator/timeout 系）場合、CE-2 は whole-field 除外を要求
  し、値レベルの条件付き除外（例: 'resolved to' を含む行だけ削る）は CE-5 違反になる」という
  方針は determined に確定する。
- **補完事項（繰り延べ）**: locator 固有の実測（実際に `'locator resolved to N times'` 形式の
  リトライログが run 間で回数が変動することの直接観測）は、本 sandbox 環境では取得不能なため、
  0b-field または Phase 2 冒頭（実 CI 環境・非 sandboxed 環境）で補完する。これは Kill-1 の
  degraded path 繰り延べと同じ「last responsible moment」原則に従う。
