// auth-tests project にマッチ（testMatch: /(auth|session)\.spec\.ts/, deps: [setup]）。
// 0b-core-5 の対照群として authored skip（test.skip()）と dependency skip
// （setup 失敗による skip）を同一 project 内に並べる。
import { expect, test } from '@playwright/test'

test('auth: always passes', async () => {
  expect(1 + 1).toBe(2)
})

test('auth: authored skip', async () => {
  test.skip()
})

test('auth: fails when PROBE_FAIL_AUTH=1', async () => {
  const actual = process.env.PROBE_FAIL_AUTH === '1' ? { ok: false } : { ok: true }
  expect(actual).toEqual({ ok: true })
})
