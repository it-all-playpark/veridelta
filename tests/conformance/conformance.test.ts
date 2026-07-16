/**
 * The published conformance suite (spec §13): every fixture under
 * conformance/fixtures/ runs against the built vdelta CLI. The suite itself
 * mechanically decides the class-5 claims: all recall fixtures green ⇒
 * detection recall 100% and zero false green on the cheat corpus.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFixture, type Manifest } from './runner.js'

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'conformance', 'fixtures')

const fixtureNames = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(FIXTURES_DIR, e.name, 'manifest.json')))
  .map((e) => e.name)
  .sort()

const manifests = new Map<string, Manifest>(
  fixtureNames.map((name) => [
    name,
    JSON.parse(readFileSync(join(FIXTURES_DIR, name, 'manifest.json'), 'utf8')) as Manifest,
  ]),
)

const passed = new Set<string>()

describe('veridelta/1 conformance', () => {
  for (const name of fixtureNames) {
    it(name, async () => {
      await runFixture(join(FIXTURES_DIR, name))
      passed.add(name)
    })
  }

  it('recall: 100% detection, zero false green on the cheat corpus (§13.2.5)', () => {
    const recall = fixtureNames.filter((n) => manifests.get(n)?.class === 'recall')
    expect(recall.length).toBeGreaterThanOrEqual(10)
    const failedRecall = recall.filter((n) => !passed.has(n))
    expect(failedRecall, 'recall fixtures that did not pass').toEqual([])
  })

  it('coverage: all five fixture classes are present (§13.2)', () => {
    const classes = new Set([...manifests.values()].map((m) => m.class))
    expect([...classes].sort()).toEqual(
      ['adversarial', 'consumer', 'invariant', 'pitfall', 'recall'].sort(),
    )
  })
})
