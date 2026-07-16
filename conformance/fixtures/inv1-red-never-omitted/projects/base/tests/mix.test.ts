import { test, expect } from 'vitest'

test('green passes', () => {
  expect(1).toBe(1)
})

test('red stays red', () => {
  expect(500).toBe(200)
})
