import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VDELTA_VERSION } from '../../src/run.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  readFileSync(join(here, '../../package.json'), 'utf8'),
) as { version: string }

describe('VDELTA_VERSION', () => {
  it('matches package.json version exactly', () => {
    expect(VDELTA_VERSION).toBe(pkg.version)
  })
})
