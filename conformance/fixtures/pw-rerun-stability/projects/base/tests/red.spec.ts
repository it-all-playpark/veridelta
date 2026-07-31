// pw-rerun-stability（issue #55 / P5）: 決定的に失敗する browserless テスト。
// `shifted` プロジェクトはこのファイルの test 宣言行より上に無害なコメントを
// 3 行挿入しただけのコピー（テスト本文・失敗行テキストは 1 バイトも変えない）。
import { expect, test } from '@playwright/test'

function computeValue(): string {
  return 'actual'
}

test('deterministic red', () => {
  expect(computeValue()).toBe('expected')
})
