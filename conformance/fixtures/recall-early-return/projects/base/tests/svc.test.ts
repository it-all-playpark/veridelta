import { test, expect } from 'vitest'
import { getStatus } from '../src'

test('status is ok', () => {
  expect(getStatus()).toBe(200)
})
