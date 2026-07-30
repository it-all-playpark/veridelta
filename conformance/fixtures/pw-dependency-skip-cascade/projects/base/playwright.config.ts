// pw-dependency-skip-cascade（issue #55 / P2）の合成 playwright プロジェクト。
// probes/playwright-0b-core/project/playwright.config.ts が実測した shift-bud
// 形状（setup / auth-tests(deps:['setup']) / chromium(deps:['setup']) の3
// project）を再現し、setup を PW_FAIL_SETUP 環境変数で赤/緑に切り替えることで
// 依存 skip カスケードを実測どおりに再現する
// （probes/playwright-0b-core/observations/setup-cascade.json）。
// reporter は vdelta run が --reporter=list,<recorder path> を注入するため
// ここでは指定しない。browserless（page fixture 不使用）。
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
  retries: 0,
})
