// chromium project にマッチ。0b-core-3 用の決定的 flaky テスト。
// testInfo.retry（Playwright が保証する attempt 番号）で分岐するため、
// fullyParallel による worker 再利用・ファイル/プロセス状態に依存しない
// （edge_cases 参照）。retries: 2 の config 下で attempt0 fail → attempt1 pass
// となり TestCase.outcome() === 'flaky' になる想定。
import { expect, test } from '@playwright/test'

test('flaky: first attempt fails, retry passes', async ({}, testInfo) => {
  if (testInfo.retry === 0) {
    throw new Error('flaky: first attempt fails')
  }
  expect(true).toBe(true)
})
