import { test, expect } from 'vitest'
import { getStatus } from '../src'

test('value check', () => {
  expect(getStatus()).toBe(200)
})
