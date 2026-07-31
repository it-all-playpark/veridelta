// setup project にマッチ（testMatch: /.*\.setup\.ts/）。
// PW_FAIL_SETUP=1 のときだけ故意に失敗し、dependencies:['setup'] な
// auth-tests project 全体を block してカスケードを発生させる
// （run A: 環境変数なし=緑、run B: PW_FAIL_SETUP=1=赤）。
import { test as setup } from '@playwright/test'

setup('provision', async () => {
  if (process.env.PW_FAIL_SETUP === '1') {
    throw new Error('setup intentionally failed')
  }
})
