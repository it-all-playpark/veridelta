// browserless smoke（page fixture は使わない — architecture_decisions 参照）。
import { expect, test } from '@playwright/test'

test('green: deterministic pass', () => {
  expect(1 + 1).toBe(2)
})
