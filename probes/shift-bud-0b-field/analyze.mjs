// Kill-1 集計（設計 doc §7 / 0b-core README「Kill-1 集計規則」の実装）
//
//   分母       = 各 run で実際に実行された test case 数（project 展開後）
//   無効 run   = `setup` project が red の run。f_i の集計から除外（件数は記録）
//   発火条件   = median(f_i) >= 2
//              | |F| / 実行 test case 数 >= 5%
//              | すべての有効 run で f_i / 実行数 > 1%
//
// flaky の定義は Playwright の判定に従う（spec §7.7「flaky-class label is permitted
// only from the runner's own retry verdict」）: status !== expectedStatus な attempt が
// ありつつ最終的に expected に落ち着いたもの = Playwright json reporter の
// `specs[].tests[].status === 'flaky'`。
// 入力は2通り取れる:
//   (a) measure.sh が出力した生 run-*.json のディレクトリ（新規計測直後）
//   (b) observations/kill1-runs.json（本 probe に保存した抽出済み観測）
// (b) を受け付けるのは、生 JSON が $TMPDIR にしか無く消えるため。
// これが無いと保存した記録から判定を再現できず、probe が自己完結しない。
//
//   node analyze.mjs <run-*.json のディレクトリ>
//   node analyze.mjs observations/kill1-runs.json
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TARGET = process.argv[2] ?? `${process.env.TMPDIR ?? '/tmp'}/kill1-runs`
const isExtract = statSync(TARGET).isFile()

let files = []
if (!isExtract) {
  files = readdirSync(TARGET)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  if (files.length === 0) {
    console.error(`run-*.json が ${TARGET} に無い`)
    process.exit(2)
  }
}

/** json reporter の suite ツリーを再帰して spec を集める */
function collectSpecs(suite, acc = []) {
  for (const s of suite.suites ?? []) collectSpecs(s, acc)
  for (const spec of suite.specs ?? []) acc.push(spec)
  return acc
}

const runs = []

if (isExtract) {
  // 抽出済み観測から復元する。生 JSON からの集計と同じ形に揃える。
  const extracted = JSON.parse(readFileSync(TARGET, 'utf8'))
  for (const r of extracted.runs) {
    runs.push({
      file: `run-${r.run}`,
      executed: r.executed,
      flaky: r.flaky,
      failed: r.failed,
      setupRed: r.setup_red,
    })
  }
}

for (const f of files) {
  const report = JSON.parse(readFileSync(join(TARGET, f), 'utf8'))
  const specs = (report.suites ?? []).flatMap((s) => collectSpecs(s))

  let executed = 0
  const flaky = []
  const failed = []
  let setupRed = false

  for (const spec of specs) {
    for (const t of spec.tests ?? []) {
      const project = t.projectName ?? ''
      // 実行されなかった（results 空 / 全 skipped）ものは分母に入れない
      const results = t.results ?? []
      const ran = results.some((r) => r.status && r.status !== 'skipped')
      if (!ran) continue
      executed++
      const id = `${project}::${spec.file}::${spec.title}`
      if (t.status === 'flaky') flaky.push(id)
      if (t.status === 'unexpected') {
        failed.push(id)
        if (project === 'setup') setupRed = true
      }
    }
  }

  runs.push({ file: f, executed, flaky, failed, setupRed })
}

const valid = runs.filter((r) => !r.setupRed)
const invalid = runs.filter((r) => r.setupRed)

console.log('=== run 別 ===')
for (const r of runs) {
  console.log(
    `${r.file.padEnd(12)} executed=${String(r.executed).padStart(4)} flaky=${String(r.flaky.length).padStart(3)} failed=${String(r.failed.length).padStart(3)}${r.setupRed ? '  [INVALID: setup red]' : ''}`,
  )
}

if (valid.length === 0) {
  console.log('\n有効 run が 0 件。判定不能。')
  process.exit(1)
}

const fs_ = valid.map((r) => r.flaky.length).sort((a, b) => a - b)
const median =
  fs_.length % 2 === 1
    ? fs_[(fs_.length - 1) / 2]
    : (fs_[fs_.length / 2 - 1] + fs_[fs_.length / 2]) / 2

const F = new Set(valid.flatMap((r) => r.flaky))
// 分母は run ごとに再計測する規則。累積比率には有効 run の実行数の中央値を使う
const execs = valid.map((r) => r.executed).sort((a, b) => a - b)
const execMedian =
  execs.length % 2 === 1
    ? execs[(execs.length - 1) / 2]
    : (execs[execs.length / 2 - 1] + execs[execs.length / 2]) / 2

const c1 = median >= 2
const c2 = execMedian > 0 && F.size / execMedian >= 0.05
const c3 = valid.every((r) => r.executed > 0 && r.flaky.length / r.executed > 0.01)

console.log('\n=== Kill-1 判定 ===')
console.log(`有効 run: ${valid.length} / 全 ${runs.length}（無効 ${invalid.length} = setup red）`)
console.log(`f_i: [${valid.map((r) => r.flaky.length).join(', ')}]  median=${median}`)
console.log(`|F| (累積 distinct flaky) = ${F.size}`)
console.log(`実行 test case 数 median = ${execMedian}`)
console.log('')
console.log(`  median(f_i) >= 2                 : ${c1 ? 'FIRE' : 'no'} (${median})`)
console.log(
  `  |F| / 実行数 >= 5%               : ${c2 ? 'FIRE' : 'no'} (${execMedian ? ((F.size / execMedian) * 100).toFixed(2) : 'n/a'}%)`,
)
console.log(`  全有効 run で f_i/実行数 > 1%    : ${c3 ? 'FIRE' : 'no'}`)
console.log('')
console.log(
  c1 || c2 || c3
    ? '>>> Kill-1 発火: D2 を破棄し veridelta/2 を検討する'
    : '>>> Kill-1 非発火: D2 を維持する',
)

if (F.size > 0) {
  console.log('\n=== 累積 flaky test 一覧 ===')
  for (const id of [...F].sort()) {
    const hits = valid.filter((r) => r.flaky.includes(id)).length
    console.log(`  ${hits}/${valid.length} runs  ${id}`)
  }
}

// 恒常赤（全有効 run で failed）を分離して表示する。A-2 の事前登録対象。
const alwaysFailed = [...new Set(valid.flatMap((r) => r.failed))].filter((id) =>
  valid.every((r) => r.failed.includes(id)),
)
if (alwaysFailed.length > 0) {
  console.log(`\n=== 全有効 run で赤（恒常赤・flaky ではない）: ${alwaysFailed.length} 件 ===`)
  for (const id of alwaysFailed.sort()) console.log(`  ${id}`)
}
