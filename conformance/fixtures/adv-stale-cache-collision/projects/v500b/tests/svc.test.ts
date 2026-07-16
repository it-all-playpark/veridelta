import { test, expect } from 'vitest'
import { getStatus } from '../src'

test('status equals expected', () => {
  expect(getStatus()).toBe(200)
})
