import { test, expect } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Deterministic 1st-fail / 2nd-pass driven by a gitignored state file.
// The source tree is byte-identical across both runs; only the ignored
// marker (outside the tree) changes.
const marker = join(import.meta.dirname, 'alt-state.txt')

test('alternates by state', () => {
  if (existsSync(marker)) {
    expect(1).toBe(1)
  } else {
    writeFileSync(marker, 'seen')
    expect(500).toBe(200)
  }
})
