// proj-a / proj-b 両方の testMatch にマッチする1本の spec。browserless smoke
// （page fixture は使わない — pw-smoke と同様）で決定的に green。
import { expect, test } from '@playwright/test'

test('shared title across projects', () => {
  expect(1 + 1).toBe(2)
})
