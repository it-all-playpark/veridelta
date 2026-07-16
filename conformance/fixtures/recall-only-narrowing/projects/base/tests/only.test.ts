import { test, expect } from 'vitest'

test('hidden red', () => {
  expect(500).toBe(200)
})

test('kept green', () => {
  expect(1).toBe(1)
})
