/**
 * Regression test for fixture-workspace isolation from ancestor vitest/vite
 * config pollution (see the issue this task addresses). Fixture workspaces
 * live under the shared OS tmp dir, and vitest/vite's config resolution
 * (lilconfig) climbs ancestor directories with no stop boundary until it
 * finds a config file or reaches the filesystem root. A stray
 * vitest.config.* anywhere above the workspace would otherwise leak into
 * the child vitest invocation the runner spawns. The runner guarantees
 * hermeticity via a workspace-root config boundary
 * (see FixtureContext#ensureConfigBoundary in ./runner.ts); this test
 * proves that guarantee holds even when the fixture workspace is nested
 * under a deliberately poisoned ancestor directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runFixture } from './runner.js'

const FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'conformance',
  'fixtures',
)

let ancestor: string

beforeAll(() => {
  ancestor = mkdtempSync(join(tmpdir(), 'vdelta-ancestor-'))
  writeFileSync(
    join(ancestor, 'vitest.config.mjs'),
    "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['**/*.test.mjs'] } })\n",
  )
})

afterAll(() => {
  rmSync(ancestor, { recursive: true, force: true })
})

describe('fixture workspace isolation from ancestor config pollution', () => {
  it('runs a fixture with no own config under a poisoned ancestor (sentinel-boundary path)', async () => {
    await expect(
      runFixture(join(FIXTURES_DIR, 'adv-rerun-stability'), {
        workspaceParent: ancestor,
      }),
    ).resolves.toBeUndefined()
  })

  it('runs a fixture that ships its own config under a poisoned ancestor (own-config unaffected)', async () => {
    await expect(
      runFixture(join(FIXTURES_DIR, 'adv-parallel-order'), {
        workspaceParent: ancestor,
      }),
    ).resolves.toBeUndefined()
  })
})
