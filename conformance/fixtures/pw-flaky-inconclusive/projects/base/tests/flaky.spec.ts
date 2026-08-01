// pw-flaky-inconclusive（issue #60 / Phase 2 F3）: deterministic
// attempt-counting test driven by a gitignored counter file (outside the git
// tree, so tree_digest stays unchanged across runs -- same technique as
// adv-flaky-no-inference's `alt-state.txt`, `../adv-flaky-no-inference/
// projects/base/tests/alt.test.ts`). Only the 4th overall attempt passes.
//
// With `retries: 1`:
//   run A: attempt 1 fails, attempt 2 (retry) fails -> final failed (red)
//   run B: attempt 3 fails, attempt 4 (retry) passes -> Playwright outcome
//          'flaky' (final verdict pass, with a finding from the failing
//          attempt -- src/adapters/playwright/recorder.ts toReportedObservation)
//   run C: attempt 5 fails, attempt 6 (retry) fails -> final failed (red)
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('flaky on the fourth attempt', ({}, testInfo) => {
  const counterFile = join(testInfo.config.rootDir, 'attempts.txt')
  const n = existsSync(counterFile)
    ? Number(readFileSync(counterFile, 'utf8'))
    : 0
  const next = n + 1
  writeFileSync(counterFile, String(next))
  expect(next).toBe(4)
})
