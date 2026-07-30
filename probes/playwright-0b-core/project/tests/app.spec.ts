// chromium project にマッチ（testIgnore: /(auth|session)\.spec\.ts/, deps: [setup]）。
// CE-1（signal completeness）観測用の失敗テスト群。PROBE_FAIL_APP=1 のときのみ
// fail する。失敗ロジックは名前付き関数の中に置き、CE-3（enclosing symbol からの
// line-shift-stable な位置再構成）が検証できる構造にする。
import { expect, test } from '@playwright/test'

test.describe('app assertions (CE-1 observation)', () => {
  test('object shape mismatch is observed with asserted/expected/actual', async () => {
    if (process.env.PROBE_FAIL_APP !== '1') return
    assertObjectShape()
  })

  test('string mismatch is observed with asserted/expected/actual', async () => {
    if (process.env.PROBE_FAIL_APP !== '1') return
    assertStringEquality()
  })

  test('custom exception type is preserved', async () => {
    if (process.env.PROBE_FAIL_APP !== '1') return
    throwCustomError()
  })

  test('timeout message is observed', async () => {
    if (process.env.PROBE_FAIL_APP !== '1') return
    test.setTimeout(1000)
    await waitTooLong()
  })
})

// 以下、CE-1 の「exception type / asserted values / traceback 構造」を意図的に
// 発火させる名前付き関数群。呼び出し元の test 本体を挟むことで
// TestCase.titlePath() とは別の enclosing symbol（関数名）を error.stack /
// error.location に残す。
function assertObjectShape() {
  expect({ a: 1, b: 'x' }).toEqual({ a: 2, b: 'y' })
}

function assertStringEquality() {
  expect('actual string').toBe('expected string')
}

function throwCustomError(): never {
  throw new TypeError('custom error')
}

async function waitTooLong() {
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
