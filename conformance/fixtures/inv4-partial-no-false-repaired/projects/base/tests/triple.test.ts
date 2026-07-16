import { test, expect } from 'vitest'

test('t1 fails first', () => {
  expect(500).toBe(200)
})

test('t2 also red', () => {
  expect(1).toBe(2)
})

test('t3 also red', () => {
  expect('a').toBe('b')
})
