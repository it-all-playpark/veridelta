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

  it('keeps the installed lockfile vitest pinned at 4.1.10', () => {
    const lock = JSON.parse(
      readFileSync(join(root, 'package-lock.json'), 'utf8'),
    ) as {
      packages: Record<string, { version?: string }>
    }
    expect(lock.packages['node_modules/vitest']?.version).toBe('4.1.10')
  })

  it('adds a vitest 5 cell to the CI job matrix without removing vitest 4 coverage', () => {
    const ci = readFileSync(
      join(root, '.github/workflows/ci.yml'),
      'utf8',
    )
    expect(ci).toMatch(/vitest:\s*\[4\]/)
    expect(ci).toMatch(
      /include:\s*\n(?:.*\n)*?\s*- os: ubuntu-latest\s*\n\s*node-version: 24\s*\n\s*vitest: 5/,
    )
    expect(ci).toMatch(
      /if: matrix\.vitest != 4\s*\n\s*run: npm install --no-save "vitest@\^\$\{\{ matrix\.vitest \}\}\.0\.0"/,
    )
  })
})
