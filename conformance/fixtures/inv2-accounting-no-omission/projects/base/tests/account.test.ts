import { test, expect } from 'vitest'

test('alpha passes', () => {
  expect(1).toBe(1)
})

test('beta fails', () => {
  expect(500).toBe(200)
})

test('gamma passes', () => {
  expect(2).toBe(2)
})
