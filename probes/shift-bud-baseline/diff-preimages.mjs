#!/usr/bin/env node
// baseline preimage の構造 diff。
//
// 用途: record 形状を変える変更を入れたあと、旧 baseline の preimage と
// 新しく記録した preimage を突き合わせ、**差分パスを列挙**する。
// 設計 §8.3 が各 Step に課す「run_id の変化が <想定した group> の差分としてのみ
// 説明可能であること」という完了条件を、主張ではなく機械判定で示すための道具。
//
// 使い方:
//   # 旧 baseline を git 履歴から取り出す（例: v0.5.0 時点の 0.4.0 baseline）
//   mkdir -p /tmp/old && cd /tmp/old
//   git -C <repo> show <old-rev>:probes/shift-bud-baseline/runs/<run_id>.json.gz > <run_id>.json.gz
//
//   node probes/shift-bud-baseline/diff-preimages.mjs /tmp/old <新しい runs/ のパス> \
//     instrument.adapter_version instrument.capabilities
//
// 第3引数以降が「説明可能」として許容する差分パス。省略すると
// instrument.adapter_version のみを許容する（release ごとに必ず動くため）。
//
// 注意: 旧側・新側それぞれに baseline 6ストリームのみを置くこと。superseded を
// 混ぜると repo.cwd が backend/frontend で重複し、後勝ちで取り違える。
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [, , OLD_DIR, NEW_DIR, ...allowed] = process.argv
if (!OLD_DIR || !NEW_DIR) {
  console.error(
    'usage: diff-preimages.mjs <old runs dir> <new runs dir> [allowed.diff.path ...]',
  )
  process.exit(2)
}
const EXPECTED = allowed.length > 0 ? allowed : ['instrument.adapter_version']

/**
 * 許容パスは **prefix 一致**で判定する。
 *
 * diff は object 同士を再帰するため、既存 object にキーが増えた場合は
 * 親ではなく子のパスで報告される（例: `instrument.capabilities` に項目が増えると
 * `instrument.capabilities.selector-relation` として出る）。
 * 完全一致だけで判定すると、親を許容指定したのに FAIL になって混乱する
 * — 実際 0.7.0 → 0.8.0 の判定で踏んだ。
 *
 * prefix 一致なら `instrument.capabilities` の指定で配下すべてを許容できる。
 * 粒度を絞りたければ子パスまで書けばよい（`instrument.capabilities.selector-relation`）。
 */
function isExpected(path) {
  return EXPECTED.some((e) => path === e || path.startsWith(`${e}.`))
}

function load(dir) {
  const out = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json.gz'))) {
    const p = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'))
    if (out.has(p.repo.cwd)) {
      console.error(
        `FATAL: ${dir} に repo.cwd="${p.repo.cwd}" の preimage が複数ある（superseded が混ざっている可能性）`,
      )
      process.exit(2)
    }
    out.set(p.repo.cwd, { preimage: p, file: basename(f, '.json.gz') })
  }
  return out
}

function diffPaths(a, b, prefix = '', acc = []) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k
    const av = a?.[k]
    const bv = b?.[k]
    const bothObj =
      av &&
      bv &&
      typeof av === 'object' &&
      typeof bv === 'object' &&
      !Array.isArray(av) &&
      !Array.isArray(bv)
    if (bothObj) diffPaths(av, bv, path, acc)
    else if (JSON.stringify(av) !== JSON.stringify(bv))
      acc.push({ path, old: av, new: bv })
  }
  return acc
}

const oldRuns = load(OLD_DIR)
const newRuns = load(NEW_DIR)
let unexplained = 0

for (const [pkg, oldE] of oldRuns) {
  const newE = newRuns.get(pkg)
  if (!newE) {
    console.log(`MISSING  ${pkg} — 新側に対応する run が無い`)
    unexplained++
    continue
  }
  const o = { ...oldE.preimage }
  const n = { ...newE.preimage }
  const oObs = o.observations
  const nObs = n.observations
  // observations は巨大なので diff 対象から外し、完全一致を別途 assert する
  o.observations = `<${oObs.length}>`
  n.observations = `<${nObs.length}>`

  const diffs = diffPaths(o, n)
  const unexpected = diffs.filter((d) => !isExpected(d.path))
  const obsSame = JSON.stringify(oObs) === JSON.stringify(nObs)

  console.log(`\n=== ${pkg}`)
  console.log(`  ${oldE.file.slice(0, 12)} → ${newE.file.slice(0, 12)}`)
  console.log(`  observations 完全一致: ${obsSame} (${oObs.length} → ${nObs.length})`)
  for (const d of diffs) {
    const fmt = (v) => (v === undefined ? '(なし)' : JSON.stringify(v))
    console.log(
      `  ${isExpected(d.path) ? 'OK  ' : 'XXX '}${d.path}: ${fmt(d.old)} → ${fmt(d.new)}`,
    )
  }
  if (!obsSame) {
    console.log('  XXX observations が一致しない — 検証面が動いている')
    unexplained++
  }
  unexplained += unexpected.length
}

console.log(
  `\n${unexplained === 0 ? 'PASS' : 'FAIL'}: 説明できない差分 ${unexplained} 件`,
)
process.exit(unexplained === 0 ? 0 : 1)
