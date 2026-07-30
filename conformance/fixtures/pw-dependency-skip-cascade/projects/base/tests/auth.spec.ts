// auth-tests project にマッチ（testMatch: /auth\.spec\.ts/, deps: ['setup']）。
// 依存先 setup が緑の run（A）では両方とも onTestEnd に到達して reported になる
// （authored skip は suppression.marker 'skip'）。setup が赤の run（B）では
// project 全体が block され、両方とも onTestEnd に到達しない unreported になる
// （authored skip 含め区別不能 — suppression.marker 'dependency' に合流する。
// probes/playwright-0b-core/observations/setup-cascade.json 実測、
// src/adapters/playwright/recorder.ts の toUnreportedObservation 参照）。
// browserless（page fixture 不使用）。
import { expect, test } from '@playwright/test'

test('auth: always passes', async () => {
  expect(1 + 1).toBe(2)
})

test('auth: authored skip', async () => {
  test.skip()
})
