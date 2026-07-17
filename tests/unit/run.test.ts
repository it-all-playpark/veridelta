import { describe, expect, it } from 'vitest'
import { splitCommandSelector } from '../../src/run.js'

describe('splitCommandSelector (§5.1, §6.4)', () => {
  it('normalizes a space-separated value flag into a single --flag=value token', () => {
    expect(
      splitCommandSelector(['npx', 'vitest', 'run', '--project', 'unit']),
    ).toEqual({
      command: ['npx', 'vitest', 'run', '--project=unit'],
      selector: [],
    })
  })

  it('produces the same canonical command for an already-joined --flag=value form', () => {
    const spaceForm = splitCommandSelector([
      'npx',
      'vitest',
      'run',
      '--project',
      'unit',
    ])
    const joinedForm = splitCommandSelector([
      'npx',
      'vitest',
      'run',
      '--project=unit',
    ])
    expect(joinedForm.command).toEqual(spaceForm.command)
  })

  it('keeps only trailing positionals as selector, not a value-flag argument', () => {
    expect(
      splitCommandSelector([
        'node',
        '/x/vitest.mjs',
        'run',
        '--project',
        'unit',
        'tests/a.test.ts',
      ]),
    ).toEqual({
      command: ['node', '/x/vitest.mjs', 'run', '--project=unit'],
      selector: ['tests/a.test.ts'],
    })
  })

  it('leaves boolean flags untouched and captures trailing positional as selector', () => {
    expect(
      splitCommandSelector(['vitest', 'run', '--coverage', 'tests/a.test.ts']),
    ).toEqual({
      command: ['vitest', 'run', '--coverage'],
      selector: ['tests/a.test.ts'],
    })
  })

  it('does not crash when a value flag is the last token (missing value)', () => {
    expect(splitCommandSelector(['vitest', 'run', '--project'])).toEqual({
      command: ['vitest', 'run', '--project'],
      selector: [],
    })
  })

  it('leaves a value flag untouched when immediately followed by another flag', () => {
    expect(
      splitCommandSelector(['vitest', 'run', '--project', '--coverage']),
    ).toEqual({
      command: ['vitest', 'run', '--project', '--coverage'],
      selector: [],
    })
  })

  it('normalizes a short value flag with a multi-word value', () => {
    expect(splitCommandSelector(['vitest', 'run', '-t', 'my test'])).toEqual({
      command: ['vitest', 'run', '-t=my test'],
      selector: [],
    })
  })

  it('passes through a non-vitest command unchanged', () => {
    expect(splitCommandSelector(['npm', 'test'])).toEqual({
      command: ['npm', 'test'],
      selector: [],
    })
  })

  it('preserves an already-joined flag whose value itself contains "="', () => {
    expect(
      splitCommandSelector(['vitest', 'run', '--outputFile=a=b.json']),
    ).toEqual({
      command: ['vitest', 'run', '--outputFile=a=b.json'],
      selector: [],
    })
  })
})
