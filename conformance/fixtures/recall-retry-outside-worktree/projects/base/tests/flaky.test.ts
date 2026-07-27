import { test, expect } from 'vitest'

let attempt = 0

test('needs retry', () => {
  attempt += 1
  expect(attempt).toBe(2)
})
