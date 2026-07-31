// pw-context-digest（issue #55 / P4）の合成 playwright プロジェクト。
// browserless smoke（page fixture 不使用）。単一 project 'chromium' に
// 固定し、test_id（`${rel}::${project}::${titles}`, recorder.ts testId）を
// 予測可能にする。reporter は vdelta run が --reporter=list,<recorder path>
// を注入するためここでは指定しない（pw-smoke と同じ約束）。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  projects: [{ name: 'chromium' }],
})
