// probe-reporter.ts — issue #53 (Phase 0b-core) の観測装置本体。
//
// built-in json reporter は rendered/整形済みの情報を返すため CE-4（structured
// fields only）の検証に使えない（architecture_decisions 参照）。この reporter は
// Reporter API から得られる生のフィールドをそのまま JSON に落とす。
//
// 出力先: 環境変数 PROBE_OUT のパス（未設定なら書き出さず警告のみ）。
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { writeFileSync } from 'node:fs'

// FullConfig / TestCase 等は RegExp・循環参照・関数を含みうるため、素の
// JSON.stringify では情報が消えたり throw したりする。CE-4 の「構造化フィールドの
// み」を守りつつ観測を落とさないための最小限の safe serializer。
function safeSerialize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (value instanceof RegExp) return { __regexp: value.toString() }
  if (value instanceof Error) {
    return {
      __error: true,
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  const t = typeof value
  if (t === 'function') return undefined
  if (t !== 'object') return value
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)
  if (Array.isArray(value)) {
    return value.map((v) => safeSerialize(v, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = safeSerialize(v, seen)
    if (s !== undefined) out[k] = s
  }
  return out
}

// onBegin(config) で得られる resolved FullConfig から、0b-core-6 が対象とする
// フィールド（instrument.config_digest 候補）を抜き出す。projects[] は
// testMatch/testIgnore が RegExp なので safeSerialize 経由で文字列化する。
function serializeConfig(config: FullConfig) {
  return {
    rootDir: config.rootDir,
    configFile: (config as unknown as { configFile?: string }).configFile,
    fullyParallel: config.fullyParallel,
    workers: config.workers,
    shard: safeSerialize(config.shard),
    forbidOnly: config.forbidOnly,
    maxFailures: config.maxFailures,
    grep: safeSerialize(config.grep),
    grepInvert: safeSerialize(config.grepInvert),
    globalTimeout: config.globalTimeout,
    reporter: safeSerialize(config.reporter),
    projects: config.projects.map((p) => ({
      name: p.name,
      testDir: p.testDir,
      testMatch: safeSerialize(p.testMatch),
      testIgnore: safeSerialize(p.testIgnore),
      dependencies: p.dependencies,
      retries: p.retries,
      timeout: p.timeout,
      fullyParallel: p.fullyParallel,
      expect: safeSerialize(p.expect),
      use: safeSerialize(p.use),
    })),
  }
}

function serializeTestCase(test: TestCase) {
  return {
    id: test.id,
    titlePath: test.titlePath(),
    location: test.location,
    expectedStatus: test.expectedStatus,
    annotations: safeSerialize(test.annotations),
    outcome: test.outcome(),
    tags: (test as unknown as { tags?: string[] }).tags,
  }
}

// `TestError`（`@playwright/test/reporter` の型）は message/stack/location/
// snippet/value の5フィールドのみを宣言するが、issue #53 PR #54 レビュー指摘で
// 判明した通り実行時オブジェクトにはこれ以外のプロパティが載ることがある
// （例: `matcherResult` — jest-style expect matcher の構造化結果。
// `node_modules/playwright/lib/worker/util.js` の `testInfoError()` が
// `ExpectError` の場合に `result.matcherResult = error.matcherResult` として
// 付与する。型定義（`testReporter.d.ts`）には無い＝ドキュメント化されていない
// フィールドであり、5フィールド whitelist の従来コードは黙って落としていた）。
// `matcherResult` を明示的にキャプチャし、型外フィールドの実在を dump から
// 機械的に確認できるようにする（`(error as { matcherResult?: unknown })` で
// TestError 型が宣言しないプロパティへ安全にアクセスする）。
function serializeErrorEntry(error: {
  message?: string
  stack?: string
  location?: unknown
  snippet?: string
  value?: string
}) {
  const matcherResult = (error as { matcherResult?: unknown }).matcherResult
  return {
    message: error.message,
    stack: error.stack,
    location: error.location,
    snippet: error.snippet,
    value: error.value,
    // undocumented / type外フィールド。safeSerialize で ANSI 付き rendered
    // 値や循環参照を機械的に丸めつつ、存在有無をそのまま反映する
    // （存在しなければ undefined → JSON.stringify でキー自体が省略される）。
    matcherResult: safeSerialize(matcherResult),
  }
}

function serializeResult(result: TestResult) {
  return {
    status: result.status,
    retry: result.retry,
    duration: result.duration,
    errors: (result.errors ?? []).map(serializeErrorEntry),
    error: result.error ? serializeErrorEntry(result.error) : undefined,
    hasStdout: (result.stdout ?? []).length > 0,
    hasStderr: (result.stderr ?? []).length > 0,
  }
}

class ProbeReporter implements Reporter {
  private configDump: unknown
  private tests: Array<{
    test: ReturnType<typeof serializeTestCase>
    result: ReturnType<typeof serializeResult>
  }> = []
  private rootSuite: Suite | undefined
  private seenTestIds = new Set<string>()

  onBegin(config: FullConfig, suite: Suite) {
    this.configDump = serializeConfig(config)
    this.rootSuite = suite
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.seenTestIds.add(test.id)
    this.tests.push({
      test: serializeTestCase(test),
      result: serializeResult(result),
    })
  }

  onEnd(_result: FullResult) {
    const outPath = process.env.PROBE_OUT
    if (!outPath) {
      console.error(
        '[probe-reporter] PROBE_OUT is not set; skipping observation dump',
      )
      return
    }

    // edge_cases: setup 失敗時に依存 project のテストが onTestEnd を経由せず
    // 「report されない」可能性がある。allTests() と onTestEnd で見た id の差集合を
    // 記録し、0b-core-5 の判定材料にする。
    const allTests = this.rootSuite ? this.rootSuite.allTests() : []
    const allTestIds = allTests.map((t) => t.id)
    const unreported = allTestIds.filter((id) => !this.seenTestIds.has(id))
    const unreportedTests = allTests
      .filter((t) => unreported.includes(t.id))
      .map((t) => serializeTestCase(t))

    const payload = {
      playwright_version: '1.49.1',
      scenario: process.env.PROBE_SCENARIO ?? null,
      config: this.configDump,
      tests: this.tests,
      all_test_ids: allTestIds,
      unreported_tests: unreportedTests,
    }

    writeFileSync(outPath, JSON.stringify(payload, null, 2))
  }
}

export default ProbeReporter
