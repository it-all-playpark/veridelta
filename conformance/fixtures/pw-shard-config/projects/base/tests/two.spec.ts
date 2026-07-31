// browserless smoke（page fixture は使わない — architecture_decisions 参照）。
import { expect, test } from '@playwright/test'

test('two: deterministic pass', () => {
  expect(2 + 2).toBe(4)
})
