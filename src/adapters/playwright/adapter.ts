/**
 * playwright adapter, descriptor side: the runner-facing half of the seam
 * (`src/adapter.ts`). Everything playwright-specific about *invoking* a run
 * lives here — locating the playwright binary in the child argv, injecting
 * the capture reporter, and splitting inclusion intent out of the command
 * (§6.4) using playwright's own CLI surface. The recorder half (capture →
 * RunRecord) stays in `./recorder.ts`; this module only owns reading and
 * parsing the channel. Structured 1:1 on `../vitest/adapter.ts`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Adapter,
  AdapterCaptureError,
  type CaptureChannel,
  type CommandSelector,
} from '../../adapter.js'
import type { Capture } from './capture.js'
import {
  ADAPTER_NAME,
  buildRunRecord,
  COMPOSITION_ID,
  DECLARED_ENV_VARS,
  PLAYWRIGHT_CAPABILITIES,
} from './recorder.js'

/**
 * Re-exported from the recorder (§3.4): the declaration lives in
 * `recorder.ts` so `buildRunRecord` can write it into
 * `instrument.capabilities` without an import cycle. Kept here too so
 * existing consumers of this descriptor module keep importing it from
 * `adapter.js` (same convention as `../vitest/adapter.ts`).
 */
export { PLAYWRIGHT_CAPABILITIES }

/**
 * Absolute path of the in-process playwright reporter that writes the
 * capture. Resolved relative to this module so it points at the built
 * sibling (`dist/adapters/playwright/reporter.cjs`) rather than a source
 * path. `.cjs`, not `.js`: an ESM reporter file makes playwright 1.49.1's
 * loader (`node_modules/playwright/lib/util.js` `fileIsModule()` →
 * `transform.js` `requireOrImport()`'s `eval("import(...)")` branch) hang
 * indefinitely in this environment. `.cjs` is unconditionally treated as
 * CommonJS and loads via `require()` instead (`reporter.cts`'s doc comment
 * has the full account).
 */
function reporterModulePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'reporter.cjs')
}

/** The one env var the capture reporter reads (`reporter.ts` — active/inert gate). */
const CAPTURE_FILE_ENV = 'VDELTA_CAPTURE_FILE'

function channelEnv(channel: CaptureChannel): Record<string, string> {
  return { [CAPTURE_FILE_ENV]: channel.path }
}

/** Parse the channel, or `undefined` when there is nothing readable in it. */
function readCapture(channel: CaptureChannel): Capture | undefined {
  try {
    return JSON.parse(readFileSync(channel.path, 'utf8')) as Capture
  } catch {
    return undefined
  }
}

function isPlaywrightBinaryToken(token: string): boolean {
  return (
    token === 'playwright' ||
    /(^|[\\/])playwright(\.m?js)?$/.test(token) ||
    /[\\/]@playwright[\\/]test[\\/]cli\.(m?)js$/.test(token)
  )
}

/**
 * Locate the playwright `test` invocation inside the child argv; `null` when
 * absent. Unlike vitest, a matching binary token alone is not enough: only
 * a binary token *immediately followed (modulo flags) by the `test`
 * subcommand* counts. Injecting `--reporter` into e.g. `playwright install`
 * would kill that child outright (INV-5 — veridelta is never worse than its
 * absence).
 */
export function findPlaywrightToken(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!isPlaywrightBinaryToken(token)) continue
    let j = i + 1
    while (j < argv.length && argv[j]!.startsWith('-')) j++
    if (j < argv.length && argv[j] === 'test') return i
  }
  return null
}

/**
 * playwright 1.49.x CLI flags that always take their value as a *separate*
 * argv token (`--flag value`), never combined into the flag token itself.
 * Same role/limitation as `../vitest/adapter.ts`'s `VITEST_VALUE_FLAGS`:
 * flags with an optional value are deliberately excluded, so a
 * space-separated token after them stays a selector token rather than being
 * silently swallowed.
 */
const PLAYWRIGHT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--project',
  '--config',
  '-c',
  '--grep',
  '-g',
  '--grep-invert',
  '--workers',
  '-j',
  '--retries',
  '--repeat-each',
  '--timeout',
  '--global-timeout',
  '--max-failures',
  '--shard',
  '--reporter',
  '--output',
  '--tsconfig',
])

/**
 * The invocation's selector is its inclusion intent (§6.4): the playwright
 * CLI positional filters. The canonical command excludes them (§5.1), and
 * keeps the `test` subcommand token (mirrors `../vitest/adapter.ts`'s
 * treatment of the `run` subcommand token).
 */
export function splitCommandSelector(cmd: readonly string[]): CommandSelector {
  const idx = findPlaywrightToken(cmd)
  if (idx === null) return { command: [...cmd], selector: [] }
  const command: string[] = cmd.slice(0, idx + 1)
  const selector: string[] = []
  for (let i = idx + 1; i < cmd.length; i++) {
    const token = cmd[i]!
    if (token === 'test' && i === idx + 1) {
      command.push(token)
      continue
    }
    if (!token.startsWith('-')) {
      selector.push(token)
      continue
    }
    if (token.includes('=')) {
      command.push(token)
      continue
    }
    const next = cmd[i + 1]
    if (
      PLAYWRIGHT_VALUE_FLAGS.has(token) &&
      next !== undefined &&
      !next.startsWith('-')
    ) {
      command.push(`${token}=${next}`)
      i++
      continue
    }
    command.push(token)
  }
  return { command, selector }
}

export const playwrightAdapter: Adapter = {
  name: ADAPTER_NAME,
  compositionId: COMPOSITION_ID,
  declaredCapabilities: PLAYWRIGHT_CAPABILITIES,
  declaredEnvVars: DECLARED_ENV_VARS,

  detect(argv) {
    const i = findPlaywrightToken(argv)
    return i === null ? null : { tokenIndex: i }
  },

  channelEnv,

  instrument(argv, channel) {
    return {
      argv: [...argv, `--reporter=list,${reporterModulePath()}`],
      env: channelEnv(channel),
    }
  },

  splitCommandSelector,

  claimsCapture(channel) {
    // Authorship only, from the payload's own self-identification
    // (`capture.ts` — a literal `'playwright'`). Not a version/shape check:
    // a capture this adapter wrote but cannot read must reach `record` so
    // the run degrades with *that* diagnostic instead of the generic
    // "is the child a playwright invocation?" (same division as vitest's).
    return readCapture(channel)?.runner === 'playwright'
  },

  record(channel, ctx) {
    const capture = readCapture(channel)
    if (capture === undefined) {
      throw new AdapterCaptureError(
        'no capture from the playwright reporter — is the child a playwright invocation?',
      )
    }
    return buildRunRecord(capture, ctx)
  },
}
