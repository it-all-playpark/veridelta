#!/usr/bin/env node
// run-scenarios.mjs — issue #53 (Phase 0b-core) のシナリオ行列実行装置。
//
// F1 README の「probe 実測計画」に事前登録された期待観測を、実測で機械判定する。
// `npx playwright test`（cwd=project/）を各シナリオごとに実行し、
// PROBE_OUT=../observations/<scenario>.json に probe-reporter.ts が書き出した
// 観測 JSON を読み込んで assert する。playwright test は失敗テストを含む
// シナリオで exit code 非0 を返すため、シナリオごとに許容 exit code を持つ
// （成否判定は playwright の exit code ではなく観測 JSON の内容 assert で行う）。
//
// 使い方: cd probes/playwright-0b-core/project && node scripts/run-scenarios.mjs
// 観測 JSON はここでは $TMPDIR 相当の一時扱い（恒久保存は F3 が行う）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(__dirname, '..')
const observationsDir = resolve(projectDir, '..', 'observations')

mkdirSync(observationsDir, { recursive: true })

// ~/Library/Caches/ms-playwright/chromium_headless_shell-<rev>/ 配下の
// 実行バイナリを探索する（1.49.1 の期待バージョンは実測で変わりうるため
// バージョン番号を決め打ちしない）。見つからなければ null を返し、
// locator シナリオを environment-blocked として扱う。
function findChromiumHeadlessShell() {
  const cacheDir = resolve(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
  if (!existsSync(cacheDir)) return null

  const candidates = readdirSync(cacheDir).filter((name) =>
    name.startsWith('chromium_headless_shell-'),
  )
  for (const candidate of candidates) {
    const found = findFileRecursive(
      join(cacheDir, candidate),
      /^(chrome-headless-shell|headless_shell)$/,
    )
    if (found) return found
  }
  return null
}

function findFileRecursive(dir, nameRe, depth = 0) {
  if (depth > 6) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, nameRe, depth + 1)
      if (found) return found
    } else if (nameRe.test(entry.name)) {
      return full
    }
  }
  return null
}

function runPlaywright(scenario) {
  const outRelative = `../observations/${scenario.name}.json`
  const env = {
    ...process.env,
    ...scenario.env,
    PROBE_SCENARIO: scenario.name,
    PROBE_OUT: outRelative,
  }
  const args = ['playwright', 'test', ...(scenario.specs ?? [])]
  const result = spawnSync('npx', args, {
    cwd: projectDir,
    env,
    encoding: 'utf8',
  })
  return { result, outPath: resolve(projectDir, outRelative) }
}

function loadObservation(outPath) {
  if (!existsSync(outPath)) return null
  return JSON.parse(readFileSync(outPath, 'utf8'))
}

// titlePath() の慣例: [ '', <project name>, <file>, ...describe, <test title> ]
function projectOf(entry) {
  return entry.test.titlePath?.[1] ?? null
}

// onTestEnd は attempt（retry）ごとに1回呼ばれるため、同一 test.id に対して
// observation は複数エントリを持つ（例: flaky テストは retry:0 の failed 呼び出しと
// retry:1 の passed 呼び出しの2件）。test.outcome() は「最後の attempt 時点での
// 最終判定」であり、attempt 途中の呼び出しでは 'unexpected' 等の暫定値になりうる。
// 判定は必ず各 test.id の最終（retry が最大の）エントリのみを使う。
function finalEntriesOf(obs) {
  const byId = new Map()
  for (const entry of obs.tests) {
    const id = entry.test.id
    const prev = byId.get(id)
    if (!prev || entry.result.retry >= prev.result.retry) byId.set(id, entry)
  }
  return [...byId.values()]
}

const failures = []

function assertTrue(condition, message) {
  if (!condition) failures.push(message)
}

const scenarios = [
  {
    name: 'baseline',
    env: {},
    allowedExitCodes: [0],
    assert(obs) {
      const finals = finalEntriesOf(obs)
      const unexpected = finals.filter((t) => t.test.outcome === 'unexpected')
      assertTrue(
        unexpected.length === 0,
        `baseline: expected no unexpected outcome, got ${unexpected.length}`,
      )
      const flaky = finals.filter((t) => t.test.outcome === 'flaky')
      assertTrue(
        flaky.length >= 1,
        'baseline: expected flaky.spec.ts to fire by default (outcome flaky) even in baseline run',
      )
      const authoredSkip = finals.find(
        (t) => t.test.titlePath.includes('auth: authored skip'),
      )
      assertTrue(
        !!authoredSkip && authoredSkip.test.outcome === 'skipped',
        'baseline: authored test.skip() should report outcome skipped',
      )
    },
  },
  {
    name: 'failures',
    env: { PROBE_FAIL_APP: '1', PROBE_FAIL_AUTH: '1' },
    allowedExitCodes: [1],
    assert(obs) {
      const finals = finalEntriesOf(obs)
      const unexpected = finals.filter((t) => t.test.outcome === 'unexpected')
      // auth: fails when PROBE_FAIL_AUTH=1 (1) + app.spec.ts 4 tests = 5
      assertTrue(
        unexpected.length >= 5,
        `failures: expected >=5 unexpected outcomes (1 auth + 4 app), got ${unexpected.length}`,
      )
      for (const t of unexpected) {
        const lastResult = t.result
        assertTrue(
          Array.isArray(lastResult.errors) && lastResult.errors.length > 0,
          `failures: expected error evidence for ${t.test.titlePath.join(' > ')}`,
        )
      }
    },
  },
  {
    name: 'flaky',
    env: {},
    specs: ['tests/flaky.spec.ts'],
    allowedExitCodes: [0],
    assert(obs) {
      const finals = finalEntriesOf(obs)
      const flakyTests = finals.filter((t) => t.test.outcome === 'flaky')
      assertTrue(
        flakyTests.length === 1,
        `flaky: expected exactly 1 flaky test, got ${flakyTests.length}`,
      )
      if (flakyTests.length === 1) {
        const t = flakyTests[0]
        assertTrue(
          t.result.retry >= 1,
          'flaky: last reported result should be a retried attempt (retry >= 1)',
        )
        assertTrue(
          t.result.status === 'passed',
          `flaky: final attempt should be passed, got ${t.result.status}`,
        )
      }
    },
  },
  {
    name: 'setup-cascade',
    env: { PROBE_FAIL_SETUP: '1' },
    allowedExitCodes: [1],
    assert(obs) {
      const finals = finalEntriesOf(obs)
      const setupTests = finals.filter((t) => projectOf(t) === 'setup')
      assertTrue(
        setupTests.length >= 1 && setupTests.every((t) => t.result.status === 'failed'),
        'setup-cascade: expected setup project test(s) to report status failed',
      )

      const dependentTests = finals.filter((t) => {
        const p = projectOf(t)
        return p === 'auth-tests' || p === 'chromium'
      })
      const cascadeStatuses = new Set(dependentTests.map((t) => t.result.status))
      const unreportedFromDependents = obs.unreported_tests.filter((t) => {
        const p = t.titlePath?.[1]
        return p === 'auth-tests' || p === 'chromium'
      })

      // 事前登録期待: 依存 project の test は skipped/interrupted 系 status で
      // 報告されるか、あるいは onTestEnd を経由せず unreported_tests に載る
      // （edge_cases: 情報欠落の有無自体が 0b-core-5 の観測対象）。
      const cascadeObserved =
        [...cascadeStatuses].some((s) => s === 'skipped' || s === 'interrupted') ||
        unreportedFromDependents.length > 0
      assertTrue(
        cascadeObserved,
        `setup-cascade: expected dependent project tests to be skipped/interrupted/unreported, ` +
          `observed statuses=${[...cascadeStatuses].join(',')} unreported=${unreportedFromDependents.length}`,
      )
    },
  },
  {
    name: 'locator',
    env: {
      PROBE_LOCATOR: '1',
      ...(findChromiumHeadlessShell()
        ? { PROBE_CHROMIUM_PATH: findChromiumHeadlessShell() }
        : {}),
    },
    specs: ['tests/locator.spec.ts'],
    allowedExitCodes: [0, 1],
    // locator シナリオはブラウザ起動可否に応じて結果が変わりうる
    // （edge_cases: CDP 非互換で起動失敗する可能性 — 捏造禁止のため environment-blocked
    // として扱う）。ここでは exit code のみ記録し、詳細判定・記録は F3 に委ねる。
    assert(_obs) {
      // no hard assertion here — F3 determines determined-vs-environment-blocked
    },
  },
]

console.log(`[run-scenarios] chromium headless shell: ${findChromiumHeadlessShell() ?? '(not found)'}`)

for (const scenario of scenarios) {
  console.log(`\n=== scenario: ${scenario.name} ===`)
  const { result, outPath } = runPlaywright(scenario)

  if (result.error) {
    failures.push(`${scenario.name}: failed to spawn npx playwright (${result.error.message})`)
    continue
  }

  const exitOk = scenario.allowedExitCodes.includes(result.status)
  if (!exitOk) {
    console.log(result.stdout)
    console.error(result.stderr)
    failures.push(
      `${scenario.name}: unexpected exit code ${result.status} (allowed: ${scenario.allowedExitCodes.join(',')})`,
    )
    continue
  }

  const obs = loadObservation(outPath)
  if (!obs) {
    failures.push(`${scenario.name}: observation file not found at ${outPath}`)
    continue
  }

  scenario.assert(obs)
  console.log(`[run-scenarios] ${scenario.name}: exit=${result.status} tests=${obs.tests.length}`)
}

console.log('\n=== summary ===')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exitCode = 1
} else {
  console.log('all scenario assertions passed')
  process.exitCode = 0
}
