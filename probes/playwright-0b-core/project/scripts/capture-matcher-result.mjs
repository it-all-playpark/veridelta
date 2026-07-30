#!/usr/bin/env node
// capture-matcher-result.mjs — issue #53 / PR #54 レビュー指摘の再実測専用スクリプト。
//
// README.md の CE-1 asserted values 行が「matcherResult 等は errors[] に載らない」
// と誤って結論した（実際は probe-reporter.ts の5フィールド whitelist が dump 前に
// 落としていただけで、実行時オブジェクトには存在する）ことを、拡張済み
// probe-reporter.ts（matcherResult を明示キャプチャ）で再実測し、既存の
// observations/failures.json とは別の専用ファイルに書き出す
// （run-scenarios.mjs のフルスイートは fullyParallel によるテスト順序の
// 非決定性で無関係な diff を生むため、この検証は tests/app.spec.ts 単体・
// workers=1 で決定的に行う）。
//
// 使い方: cd probes/playwright-0b-core/project && node scripts/capture-matcher-result.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(__dirname, '..')
const observationsDir = resolve(projectDir, '..', 'observations')
mkdirSync(observationsDir, { recursive: true })

const outRelative = '../observations/matcher-result.json'
const outPath = resolve(projectDir, outRelative)

const env = {
  ...process.env,
  PROBE_FAIL_APP: '1',
  PROBE_SCENARIO: 'matcher-result',
  PROBE_OUT: outRelative,
}

const result = spawnSync(
  'npx',
  ['playwright', 'test', 'tests/app.spec.ts', '--workers=1'],
  { cwd: projectDir, env, encoding: 'utf8' },
)

console.log(result.stdout)
if (result.stderr) console.error(result.stderr)

if (!existsSync(outPath)) {
  console.error(`[capture-matcher-result] observation file not found at ${outPath}`)
  process.exitCode = 1
} else {
  const obs = JSON.parse(readFileSync(outPath, 'utf8'))
  const withMatcher = obs.tests.filter((t) =>
    t.result.errors.some((e) => e.matcherResult !== undefined),
  )
  console.log(
    `[capture-matcher-result] ${withMatcher.length} test(s) with matcherResult present ` +
      `out of ${obs.tests.length} total onTestEnd entries`,
  )
  for (const t of withMatcher) {
    console.log(
      `  - ${t.test.titlePath.join(' > ')}: matcherResult keys = ` +
        JSON.stringify(Object.keys(t.result.errors.find((e) => e.matcherResult !== undefined).matcherResult)),
    )
  }
}
