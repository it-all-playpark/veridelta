// pw-resolved-vs-file-config（issue #55 / P3）: 単一 project、retries 未指定
// の合成 playwright プロジェクト。CLI flag（--retries=1）が config ファイルを
// 書き換えずに resolved 値だけを変える最小ケース（`projects` を省略している
// ため resolved config は単一の既定 project（name: ''）を持つ）。reporter は
// vdelta run が --reporter=list,<recorder path> を注入するためここでは指定
// しない。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  fullyParallel: true,
  timeout: 30000,
})
