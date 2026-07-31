// pw-duplicate-title-projects（issue #55 / P1）の合成 playwright プロジェクト。
// `proj-a` / `proj-b` の2 project が同一 testMatch（tests/dup.spec.ts）を持ち、
// 同一タイトルのテストがそれぞれの project で実行される。dependencies は無く、
// retries: 0（recorder.ts の test id は `${rel}::${project}::${titles.join(' > ')}`
// で project 名を含むため、同一ファイル・同一タイトルでも project が異なれば
// test id は衝突しない — これを確認するのが本 fixture の目的）。
// reporter は vdelta run が --reporter=list,<recorder path> を注入するため
// ここでは指定しない。
import { defineConfig } from '@playwright/test'

export default defineConfig({
  projects: [
    { name: 'proj-a', testMatch: /dup\.spec\.ts/ },
    { name: 'proj-b', testMatch: /dup\.spec\.ts/ },
  ],
  retries: 0,
})
