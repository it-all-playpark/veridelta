// 合成 Playwright プロジェクト（issue #53 / Phase 0b-core probe）。
//
// spec/veridelta-1.md §3.3 が shift-bud の packages/e2e/playwright.config.ts から
// 逐語引用した config 形状を再現する。シナリオ切替は環境変数（PROBE_FAIL_*, PROBE_LOCATOR）
// で行い、config ファイルはこの1本のみとする（architecture_decisions 参照 — fork すると
// resolved config が変わり 0b-core-2 / 0b-core-6 の前提が崩れる）。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'auth-tests',
      testMatch: /(auth|session)\.spec\.ts/,
      dependencies: ['setup'],
    },
    {
      name: 'chromium',
      testIgnore: /(auth|session)\.spec\.ts/,
      dependencies: ['setup'],
    },
  ],
  // 実物 shift-bud は `process.env.CI ? 2 : 0` だが、本 probe はローカルでも
  // flaky（0b-core-3）を観測する必要があるため retries: 2 を明示する
  // （設計 doc §12-8 の事前登録された罠。architecture_decisions 参照）。
  retries: 2,
  fullyParallel: true,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  reporter: [['./probe-reporter.ts'], ['list']],
  use: {
    launchOptions: process.env.PROBE_CHROMIUM_PATH
      ? { executablePath: process.env.PROBE_CHROMIUM_PATH }
      : {},
  },
})
