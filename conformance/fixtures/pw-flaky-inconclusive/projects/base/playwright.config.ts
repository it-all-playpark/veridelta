// pw-flaky-inconclusive（issue #60 / Phase 2 F3）の browserless 合成 playwright
// プロジェクト。reporter は vdelta run が --reporter=list,<recorder path> を注入
// するためここでは指定しない。retries:1 が run B（3回目 attempt が fail、4回目
// の retry が pass）を Playwright outcome 'flaky' にする鍵。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  retries: 1,
  projects: [{ name: 'chromium' }],
})
