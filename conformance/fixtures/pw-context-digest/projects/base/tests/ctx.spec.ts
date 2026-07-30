// project 'chromium' にマッチ（browserless — page fixture 不使用）。
// attachment body だけが PW_ATTACH_BODY で変わり、assertion は env 非依存の
// 固定値失敗（expect(1).toBe(2)）にする -- attachment body の変化が
// evidence_digest ではなく context_digest にだけ現れることを保証するため
// （manifest.json の notes / spec §3.6 §7.3 参照）。
import { expect, test } from '@playwright/test'

test('red: context digest sensitivity', async ({}, testInfo) => {
  await testInfo.attach('ctx', {
    body: process.env.PW_ATTACH_BODY ?? 'stable',
    contentType: 'text/plain',
  })
  expect(1).toBe(2)
})
