// chromium project にマッチ。0b-core-2（§3.3-6 の事前登録警告）の観測用。
// ブラウザ起動を要するため PROBE_LOCATOR=1 のときのみ実行し、それ以外は
// test.skip() で明示的に飛ばす（このファイルの存在自体が browserless-first
// 方針の例外であることを示す）。1.49.1 と新しめの Chromium 間の CDP 非互換で
// 起動に失敗する可能性がある — その場合は F3 で environment-blocked として
// 記録する（捏造禁止。architecture_decisions / edge_cases 参照）。
import { expect, test } from '@playwright/test'

// `page` fixture はモジュールロード時に構文上バインドすると（引数の分割代入に
// 現れるだけで）ブラウザ起動が eager に走ってしまう（実測で確認 — test.skip() を
// body 内で呼んでも防げない）。PROBE_LOCATOR が立っていない全シナリオで
// ブラウザを起動しないよう、宣言そのものを load 時点の環境変数で分岐する。
if (process.env.PROBE_LOCATOR === '1') {
  test('locator: waiting for nonexistent element produces volatile retry log', async ({
    page,
  }) => {
    await page.goto('data:text/html,<div>x</div>')
    await expect(page.locator('#nonexistent')).toBeVisible({ timeout: 2000 })
  })
} else {
  test.skip(
    'locator: waiting for nonexistent element produces volatile retry log',
    () => {},
  )
}
