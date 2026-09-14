import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')

describe('vitest 4/5 support range (issue #78)', () => {
  it('declares devDependencies.vitest as a range spanning 4.x and 5.x', () => {
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies.vitest).toBe('^4.0.0 || ^5.0.0')
  })

  it('keeps the lockfile on vitest 4.x', () => {
    const lock = JSON.parse(
      readFileSync(join(root, 'package-lock.json'), 'utf8'),
    ) as {
      packages: Record<string, { version?: string }>
    }
    expect(lock.packages['node_modules/vitest']?.version).toMatch(/^4\./)
  })

  it('adds a vitest 5 cell to the CI job matrix without removing vitest 4 coverage', () => {
    // Normalize CRLF to LF: on Windows runners git checks this file out with
    // CRLF line endings, and JS regex `.` treats `\r` as a line terminator
    // (so it doesn't match it), which breaks the multiline patterns below.
    const ci = readFileSync(
      join(root, '.github/workflows/ci.yml'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    expect(ci).toMatch(/vitest:\s*\[4\]/)
    expect(ci).toMatch(
      /include:\s*\n(?:.*\n)*?\s*- os: ubuntu-latest\s*\n\s*node-version: 24\s*\n\s*vitest: 5/,
    )
    expect(ci).toMatch(
      /if: matrix\.vitest != 4\s*\n\s*run: npm install --no-save "vitest@\^\$\{\{ matrix\.vitest \}\}\.0\.0"/,
    )
  })
})
