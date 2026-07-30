// pw-rerun-stability（issue #55 / P5）の browserless 合成 playwright プロジェクト。
// reporter は vdelta run が --reporter=list,<recorder path> を注入するため
// ここでは指定しない。単一 project（page fixture 不使用）で十分。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  projects: [{ name: 'chromium' }],
})
