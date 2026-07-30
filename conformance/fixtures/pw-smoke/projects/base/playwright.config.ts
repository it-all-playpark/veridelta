// pw-smoke（issue #55 / F4）の合成 playwright プロジェクト。
// probes/playwright-0b-core/project/playwright.config.ts が実測した shift-bud
// 形状（setup / auth-tests(deps:[setup]) / chromium(deps:[setup]) の3 project、
// retries: 2、fullyParallel: true、timeout: 30000、expect.timeout: 5000）を再現する。
// reporter は vdelta run が --reporter=list,<recorder path> を注入するため
// ここでは指定しない。use.launchOptions も browserless smoke には不要。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'auth-tests',
      testMatch: /auth\.spec\.ts/,
      dependencies: ['setup'],
    },
    {
      name: 'chromium',
      testIgnore: /auth\.spec\.ts/,
      dependencies: ['setup'],
    },
  ],
  retries: 2,
  fullyParallel: true,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
})
