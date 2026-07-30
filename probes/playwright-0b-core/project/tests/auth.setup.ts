// setup project。0b-core-5（依存 skip カスケード）の起点。
// PROBE_FAIL_SETUP=1 のとき故意に失敗させ、auth-tests / chromium project への
// 波及を観測する。
import { test as setup } from '@playwright/test'

setup('authenticate', async () => {
  if (process.env.PROBE_FAIL_SETUP === '1') {
    throw new Error('setup intentionally failed')
  }
})
