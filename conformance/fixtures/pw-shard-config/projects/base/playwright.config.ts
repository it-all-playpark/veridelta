// pw-shard-config（issue #55 / P3）: 単一 project、2 test file の合成
// playwright プロジェクト。`--shard=1/2` は config ファイルを書き換えずに
// resolved FullConfig.shard だけを変える（§4 判定表 shard 行の covering 証明）。
// reporter は vdelta run が --reporter=list,<recorder path> を注入するため
// ここでは指定しない。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  fullyParallel: true,
  timeout: 30000,
})
