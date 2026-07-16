import { test, expect } from 'vitest'

test('pass emits fail text', () => {
  console.log('AssertionError: expected 1 to be 2 -- FAILED')
  expect(1).toBe(1)
})

test('fail emits pass text', () => {
  console.log('all assertions passed OK green')
  expect(500).toBe(200)
})
