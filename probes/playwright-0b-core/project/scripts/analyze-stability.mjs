#!/usr/bin/env node
// analyze-stability.mjs — issue #53 (Phase 0b-core) F3: 0b-core-2 (rerun / line-shift
// 安定性) の実測装置。
//
// tests/app.spec.ts の失敗テスト（'object shape mismatch is observed with
// asserted/expected/actual'）を対象に、候補 core フィールド集合（exception type +
// message + error.location からの再構成 source line text + snippet 相当）が
// (i) 同一 tree での rerun、(ii) 対象テスト直前への空行3行挿入（行ズレ）、
// (iii) 無関係ファイル（tests/auth.spec.ts）へのコメント追加
// に対してどう振る舞うかを機械判定する。編集は実行後に必ず元へ戻す
// （このファイル群は F2 で新規作成されただけで git 未 add のため `git restore` は
// 使えない — untracked ファイルには restore 対象の HEAD 版が無い。かわりに
// 実行前の生テキストをメモリに保持し fs.writeFileSync で戻す）。
//
// 結果は observations/stability-report.json に保存する（恒久コミット対象）。
// 使い方: cd probes/playwright-0b-core/project && node scripts/analyze-stability.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(__dirname, '..')
const observationsDir = resolve(projectDir, '..', 'observations')
mkdirSync(observationsDir, { recursive: true })

const appSpecPath = join(projectDir, 'tests/app.spec.ts')
const authSpecPath = join(projectDir, 'tests/auth.spec.ts')

const TARGET_TITLE = 'object shape mismatch is observed with asserted/expected/actual'

function stripAnsi(s) {
  if (typeof s !== 'string') return s
  // biome-ignore lint: ANSI escape stripping requires control-char regex
  return s.replace(/\[[0-9;]*m/g, '')
}

// message の先頭トークン（"TypeError: ..." / "Error: ..." 等）を exception type
// として抽出する。Playwright の matcher エラーは汎用 `Error` のサブクラス名を
// 持たない（TestError 型に構造化された type フィールドは無い — reporter.d.ts 参照）
// ため、これは「channel が真に構造化された exception type を提供しているか」を
// 実測するための最善努力の抽出であり、0b-core-1 の判定に使う。
function extractExceptionType(strippedMessage) {
  if (!strippedMessage) return null
  const firstLine = strippedMessage.split('\n')[0]
  const m = firstLine.match(/^([A-Za-z_$][\w$]*):/)
  return m ? m[1] : null
}

// error.stack の最初の named frame（"at <name> (<file>:<line>:<col>)"）を
// enclosing symbol として採用する。**この関数は最初の named frame を返すだけで、
// それが error.location と同じ file:line:col を指すかは検査しない**（PR #54
// レビュー指摘）。両者の一致は保証ではなく観測事実であり、呼び出し階層が深い
// ケースでは乖離しうる（最初の named frame が error を投げた地点より外側の
// フレームになる）。対象テストでの実際の一致有無は
// `enclosingFrameAgreement()` で実測し report に記録する。
function findEnclosingFrame(stack) {
  if (!stack) return null
  const lines = stripAnsi(stack).split('\n')
  for (const line of lines) {
    const m = line.match(/at\s+([\w$.]+)\s+\(([^)]+):(\d+):(\d+)\)/)
    if (m) {
      return { symbol: m[1], file: m[2], line: Number(m[3]), column: Number(m[4]) }
    }
  }
  return null
}

// symbol の宣言行を、対象ソースファイルを実行時に読み込んで
// `function <symbol>(` パターンで探索する（recorded tree からの決定的再構成 —
// spec §3.6 option (b)）。見つからなければ null（reconstruction 不能）。
function findSymbolDeclarationLine(filePath, symbol) {
  if (!existsSync(filePath) || !symbol) return null
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const re = new RegExp(`function\\s+${symbol.replace(/[.$]/g, '\\$&')}\\s*\\(`)
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1 // 1-based
  }
  return null
}

function sourceLineTextAt(filePath, line) {
  if (!existsSync(filePath) || !line) return null
  const lines = readFileSync(filePath, 'utf8').split('\n')
  return lines[line - 1]?.trim() ?? null
}

// candidate core digest: CE-1 の4要素のうち exception type / message / failing
// source region text / (簡易) traceback を、line-shift-stable な形（symbol +
// symbol-relative offset + source line text）で構成する。duration・retry・
// 絶対パス・raw snippet の gutter 行番号は含めない（CE-2/CE-3/CE-5 の実測対象）。
function buildCandidateDigest(errorEntry) {
  const strippedMessage = stripAnsi(errorEntry.message)
  const frame = findEnclosingFrame(errorEntry.stack)
  const declLine = frame ? findSymbolDeclarationLine(frame.file, frame.symbol) : null
  const offset = frame && declLine ? frame.line - declLine : null
  const lineText = frame ? sourceLineTextAt(frame.file, frame.line) : null
  return {
    exceptionType: extractExceptionType(strippedMessage),
    message: strippedMessage,
    location: {
      enclosingSymbol: frame?.symbol ?? null,
      symbolRelativeOffsetLine: offset,
      sourceLineText: lineText,
      column: frame?.column ?? null,
    },
  }
}

// stable stringify: キーを再帰的にソートしてから JSON.stringify する
// （フィールド順の非決定性を比較対象から排除する自前実装）。
function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k])
    return out
  }
  return value
}

function finalEntriesOf(obs) {
  const byId = new Map()
  for (const entry of obs.tests) {
    const id = entry.test.id
    const prev = byId.get(id)
    if (!prev || entry.result.retry >= prev.result.retry) byId.set(id, entry)
  }
  return [...byId.values()]
}

function runAppSpecOnce(label) {
  const outPath = join(tmpdir(), `playwright-0b-core-stability-${label}.json`)
  const env = {
    ...process.env,
    PROBE_FAIL_APP: '1',
    PROBE_SCENARIO: `stability-${label}`,
    PROBE_OUT: outPath,
  }
  const result = spawnSync('npx', ['playwright', 'test', 'tests/app.spec.ts'], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
  })
  if (result.error) {
    throw new Error(`${label}: failed to spawn npx playwright (${result.error.message})`)
  }
  if (!existsSync(outPath)) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${label}: observation file not found at ${outPath} (exit=${result.status})`)
  }
  return JSON.parse(readFileSync(outPath, 'utf8'))
}

function targetEntryOf(obs) {
  const finals = finalEntriesOf(obs)
  const entry = finals.find((t) => t.test.titlePath.includes(TARGET_TITLE))
  if (!entry) throw new Error(`target test '${TARGET_TITLE}' not found in observation`)
  return entry
}

function rawSnippetOf(entry) {
  return entry.result.errors?.[0]?.snippet ?? null
}

function digestOf(entry) {
  const errorEntry = entry.result.errors?.[0]
  if (!errorEntry) throw new Error('target test has no error entry')
  return buildCandidateDigest(errorEntry)
}

// `findEnclosingFrame()` が返す最初の named frame と channel-provided な
// `error.location` が同じ file:line:col を指すかを**実測**する（assert はしない —
// 乖離しうること自体が記録すべき観測結果であり、乖離を failure 扱いにすると
// 「対象テストでは一致した」という事実が report から失われるため）。
function enclosingFrameAgreement(errorEntry) {
  const frame = findEnclosingFrame(errorEntry.stack)
  const loc = errorEntry.location ?? null
  if (!frame || !loc) return { frame, error_location: loc, matches: null }
  return {
    frame,
    error_location: loc,
    matches: frame.file === loc.file && frame.line === loc.line && frame.column === loc.column,
  }
}

const report = { playwright_version: '1.49.1', steps: {} }
const failures = []

function assertTrue(condition, message) {
  if (!condition) failures.push(message)
}

// --- (i) 同一 tree での rerun 不変性 -----------------------------------
console.log('=== step (i): same-tree rerun ===')
const runA = targetEntryOf(runAppSpecOnce('rerun-a'))
const runB = targetEntryOf(runAppSpecOnce('rerun-b'))
const digestA = digestOf(runA)
const digestB = digestOf(runB)
const rerunStable = stableStringify(digestA) === stableStringify(digestB)
assertTrue(rerunStable, 'rerun: candidate core digest changed across two same-tree runs')
// digestA / digestB tree-reconstruct sourceLineText/offset by re-reading the
// source file from disk at call time. Snapshot digestA now, while
// tests/app.spec.ts is still in its original (unshifted) state, and reuse this
// frozen value in steps (ii)/(iii) below — calling digestOf(runA) again after
// the file has been temporarily edited would silently re-read the *mutated*
// file and reconstruct against the wrong line, corrupting the "before" baseline.
const referenceDigest = digestA
report.steps.rerun = {
  stable: rerunStable,
  location_line_run_a: runA.result.errors[0].location?.line ?? null,
  location_line_run_b: runB.result.errors[0].location?.line ?? null,
  digest: stableStringify(digestA) === stableStringify(digestB) ? digestA : { a: digestA, b: digestB },
  raw_snippet_identical: rawSnippetOf(runA) === rawSnippetOf(runB),
}
console.log(`  stable=${rerunStable}`)

// --- (ii) 行ズレ（対象テスト直前に空行3行挿入） ---------------------------
console.log('=== step (ii): line-shift (insert 3 blank lines before target test) ===')
const originalAppSpec = readFileSync(appSpecPath, 'utf8')
let lineShiftResult
try {
  const marker = "test.describe('app assertions (CE-1 observation)', () => {"
  const idx = originalAppSpec.indexOf(marker)
  if (idx === -1) throw new Error('marker not found in tests/app.spec.ts')
  const shiftedAppSpec =
    originalAppSpec.slice(0, idx) + '\n\n\n' + originalAppSpec.slice(idx)
  writeFileSync(appSpecPath, shiftedAppSpec)

  const runShifted = targetEntryOf(runAppSpecOnce('line-shift'))
  const digestShifted = digestOf(runShifted)

  const lineDelta =
    (runShifted.result.errors[0].location?.line ?? 0) -
    (runA.result.errors[0].location?.line ?? 0)
  const locationLineChanged = lineDelta !== 0
  const reconstructedStable =
    stableStringify(referenceDigest) === stableStringify(digestShifted)

  assertTrue(
    locationLineChanged,
    'line-shift: expected error.location.line to change after inserting blank lines',
  )
  assertTrue(
    reconstructedStable,
    'line-shift: expected symbol-relative-offset/source-line-text based digest to stay unchanged',
  )

  lineShiftResult = {
    location_line_before: runA.result.errors[0].location?.line ?? null,
    location_line_after: runShifted.result.errors[0].location?.line ?? null,
    line_delta: lineDelta,
    absolute_location_line_changed: locationLineChanged,
    symbol_relative_offset_before: referenceDigest.location.symbolRelativeOffsetLine,
    symbol_relative_offset_after: digestShifted.location.symbolRelativeOffsetLine,
    source_line_text_before: referenceDigest.location.sourceLineText,
    source_line_text_after: digestShifted.location.sourceLineText,
    reconstructed_digest_stable: reconstructedStable,
    raw_snippet_identical: rawSnippetOf(runA) === rawSnippetOf(runShifted),
    raw_snippet_before: rawSnippetOf(runA),
    raw_snippet_after: rawSnippetOf(runShifted),
  }
  console.log(
    `  location.line ${lineShiftResult.location_line_before} -> ${lineShiftResult.location_line_after}` +
      ` (delta=${lineDelta}); reconstructed digest stable=${reconstructedStable};` +
      ` raw snippet identical=${lineShiftResult.raw_snippet_identical}`,
  )
} finally {
  writeFileSync(appSpecPath, originalAppSpec)
}
report.steps.line_shift = lineShiftResult

// --- (iii) 無関係ファイル（tests/auth.spec.ts）へのコメント追加 -----------
console.log('=== step (iii): unrelated file edit (tests/auth.spec.ts) ===')
const originalAuthSpec = readFileSync(authSpecPath, 'utf8')
let unrelatedEditResult
try {
  writeFileSync(
    authSpecPath,
    `// unrelated comment inserted by analyze-stability.mjs (0b-core-2 probe)\n${originalAuthSpec}`,
  )

  const runUnrelated = targetEntryOf(runAppSpecOnce('unrelated-edit'))
  const digestUnrelated = digestOf(runUnrelated)
  const stable = stableStringify(referenceDigest) === stableStringify(digestUnrelated)
  assertTrue(
    stable,
    'unrelated-edit: candidate core digest for tests/app.spec.ts changed after editing tests/auth.spec.ts',
  )
  unrelatedEditResult = {
    stable,
    location_line_before: runA.result.errors[0].location?.line ?? null,
    location_line_after: runUnrelated.result.errors[0].location?.line ?? null,
  }
  console.log(`  stable=${stable}`)
} finally {
  writeFileSync(authSpecPath, originalAuthSpec)
}
report.steps.unrelated_edit = unrelatedEditResult

// --- まとめ -------------------------------------------------------------
// 「最初の named frame == error.location」は findEnclosingFrame() が保証する性質では
// ないため、対象テストでの一致有無を実測値として残す（PR #54 レビュー指摘）。
report.enclosing_frame_vs_error_location = enclosingFrameAgreement(runA.result.errors[0])

report.candidate_digest_fields = [
  'exceptionType (best-effort message-prefix parse; TestError has no structured type field)',
  'message (ANSI-stripped; whole-field, excluded when volatile per CE-5 — see locator-blocked.md)',
  'location.enclosingSymbol (first named stack frame in error.stack; agreement with error.location file:line:col is NOT asserted by findEnclosingFrame — measured separately, see report.enclosing_frame_vs_error_location)',
  'location.symbolRelativeOffsetLine (error.location.line - symbol declaration line, both tree-reconstructed at run time)',
  'location.sourceLineText (source file line text at error.location.line, tree-reconstructed at run time)',
  'location.column (stable under line-shift; not excluded)',
]
report.excluded_fields = [
  'duration',
  'retry',
  'absolute error.location.line',
  'raw error.snippet (embeds absolute line-number gutter text; see excluded_fields_detail)',
  'error.location.file (absolute path)',
]
report.excluded_fields_detail = {
  raw_error_snippet:
    'error.snippet includes a rendered gutter with the absolute line number ' +
    '(e.g. " 35 |") for the highlighted line and surrounding context lines. ' +
    'Empirically (see steps.line_shift.raw_snippet_identical) this makes the raw ' +
    'snippet field NOT line-shift-stable even though its highlighted source code ' +
    'text is unchanged. A line-shift-stable composition must extract the ' +
    'highlighted line text from the snippet (or from location.sourceLineText, ' +
    'which this script reconstructs directly from the tree) rather than digesting ' +
    'the raw snippet string.',
}

console.log('\n=== summary ===')
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  report.ok = false
} else {
  console.log('all stability assertions passed')
  report.ok = true
}

writeFileSync(
  resolve(observationsDir, 'stability-report.json'),
  JSON.stringify(report, null, 2),
)
console.log(`\nwrote ${resolve(observationsDir, 'stability-report.json')}`)

process.exitCode = failures.length > 0 ? 1 : 0
