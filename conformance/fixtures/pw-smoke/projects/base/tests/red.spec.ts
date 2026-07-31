// chromium project にマッチ（testIgnore: /auth\.spec\.ts/, deps: [setup]）。
// 決定的に失敗する assertion（CE-1 source region text の生成対象）。
import { expect, test } from '@playwright/test'

test('red: deterministic fail', () => {
  assertFails()
})

function assertFails() {
  expect(1 + 1).toBe(3)
}
