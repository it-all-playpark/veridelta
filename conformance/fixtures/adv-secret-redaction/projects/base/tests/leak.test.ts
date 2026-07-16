import { test, expect } from 'vitest'

test('emits secrets on failure', () => {
  console.log('token=ghp_0123456789abcdefghijklmnopqrstuvwxyz')
  const key = 'AKIAIOSFODNN7EXAMPLE'
  expect(key).toBe('nope')
})
