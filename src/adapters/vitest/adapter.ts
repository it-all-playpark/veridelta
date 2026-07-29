/**
 * vitest adapter, descriptor side: the runner-facing half of the seam
 * (`src/adapter.ts`). Everything vitest-specific about *invoking* a run lives
 * here — locating the vitest binary in the child argv, injecting the capture
 * reporter, and splitting inclusion intent out of the command (§6.4) using
 * vitest's own CLI surface. The recorder half (capture → RunRecord) stays in
 * `./recorder.ts`; this module only owns reading and parsing the channel.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Adapter,
  AdapterCaptureError,
  type CapabilityDeclaration,
  type CaptureChannel,
  type CommandSelector,
} from '../../adapter.js'
import type { Capture } from './capture.js'
import {
  ADAPTER_NAME,
  buildRunRecord,
  COMPOSITION_ID,
  DECLARED_ENV_VARS,
} from './recorder.js'

/**
 * Absolute path of the in-process vitest reporter that writes the capture.
 * Resolved relative to this module so it points at the built sibling
 * (`dist/adapters/vitest/reporter.js`) rather than at a source path.
 */
function reporterModulePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'reporter.js')
}

/**
 * The one env var the capture reporter reads (`reporter.ts:61`). Held here
 * rather than inline so `channelEnv` and the reporter's contract stay a single
 * fact; the reporter is inert without it, by design, so that it can sit
 * permanently in a project's vitest config (spec §4.2 ambient recording).
 */
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

/** Locate the vitest invocation inside the child argv; null when absent. */
function findVitestToken(cmd: readonly string[]): number | null {
  for (let i = 0; i < cmd.length; i++) {
    const token = cmd[i]!
    if (/(^|[\\/])vitest(\.mjs|\.js)?$/.test(token) || token === 'vitest')
      return i
  }
  return null
}

/**
 * vitest 4.x CLI flags that always take their value as a *separate* argv
 * token (`--flag value`), never combined into the flag token itself. Used
 * by {@link splitCommandSelector} to recognize `--flag value` pairs and fold
 * them into a single `--flag=value` canonical token so that space-separated
 * and `=`-joined invocations normalize to the same command array (and
 * therefore the same stream key — see `streamKey` in src/compare.ts).
 *
 * Deliberately excludes flags whose value is *optional*
 * (`--changed`, `--silent`, `--coverage`, `--browser`, `--inspect`, etc.):
 * for those, the token following the flag cannot be distinguished from a
 * positional selector without vitest's own arg-parsing rules, so folding
 * them here would risk silently swallowing a selector token. Flags outside
 * this list keep the historical (pre-fix) behavior: a space-separated value
 * is treated as a selector token, which may cause selector-based stream
 * splitting and an abstain (`comparability: 'none'`) rather than a
 * false-positive comparison.
 *
 * Maintenance: this list targets vitest 4.x. Revisit when bumping the
 * vitest minor/major version (see issue #15 Open Question — no automated
 * mechanism keeps this in sync with vitest's own CLI surface).
 */
const VITEST_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--project',
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--reporter',
  '--outputFile',
  '--pool',
  '--maxWorkers',
  '--minWorkers',
  '--environment',
  '--testNamePattern',
  '-t',
  '--testTimeout',
  '--hookTimeout',
  '--teardownTimeout',
  '--retry',
  '--bail',
  '--maxConcurrency',
  '--shard',
  '--exclude',
  '--mode',
  '--workspace',
])

/**
 * The invocation's selector is its inclusion intent (§6.4): the vitest CLI
 * positional filters. The canonical command excludes them (§5.1).
 *
 * `--flag value` pairs for known value-taking flags (see
 * {@link VITEST_VALUE_FLAGS}) are folded into a single `--flag=value`
 * canonical token so that this form and the pre-joined `--flag=value` form
 * produce byte-identical `command` arrays (and thus the same stream key).
 */
export function splitCommandSelector(cmd: readonly string[]): CommandSelector {
  const idx = findVitestToken(cmd)
  if (idx === null) return { command: [...cmd], selector: [] }
  const command: string[] = cmd.slice(0, idx + 1)
  const selector: string[] = []
  for (let i = idx + 1; i < cmd.length; i++) {
    const token = cmd[i]!
    if (token === 'run' && i === idx + 1) {
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
      VITEST_VALUE_FLAGS.has(token) &&
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

/**
 * Capability declaration for the `vitest-native` composition series (§3.4).
 * Unchanged since `/1`, and still true under `/2`: only `source-region-text`
 * is degraded (CE-1 — vitest's structured channel carries no failing-source
 * region text), everything else this composition claims is met. The `/2`
 * version bump (record shape: 9-item config_digest covering +
 * `completeness.module_errors`) does not touch this declaration.
 */
export const VITEST_CAPABILITIES: CapabilityDeclaration = {
  verdicts: 'pass',
  'source-location': 'pass',
  suppression: 'pass',
  inventory: 'pass',
  'failure-evidence': 'pass',
  'source-region-text': 'unsupported',
}

export const vitestAdapter: Adapter = {
  name: ADAPTER_NAME,
  compositionId: COMPOSITION_ID,
  declaredCapabilities: VITEST_CAPABILITIES,
  declaredEnvVars: DECLARED_ENV_VARS,

  detect(argv) {
    const i = findVitestToken(argv)
    return i === null ? null : { tokenIndex: i }
  },

  channelEnv,

  instrument(argv, channel) {
    return {
      argv: [
        ...argv,
        '--reporter=default',
        `--reporter=${reporterModulePath()}`,
        '--includeTaskLocation',
      ],
      env: channelEnv(channel),
    }
  },

  splitCommandSelector,

  claimsCapture(channel) {
    // Authorship only, and from the payload's own self-identification
    // (`capture.ts:34`, a literal `'vitest'`). Deliberately not a version or
    // shape check: a capture this adapter wrote but cannot read must reach
    // `record` so the run degrades with *that* diagnostic ("unsupported
    // capture version N") instead of the generic "is the child a vitest
    // invocation?", which is what the pre-seam code path said.
    return readCapture(channel)?.runner === 'vitest'
  },

  record(channel, ctx) {
    const capture = readCapture(channel)
    if (capture === undefined) {
      throw new AdapterCaptureError(
        'no capture from the vitest reporter — is the child a vitest invocation?',
      )
    }
    return buildRunRecord(capture, ctx)
  },
}
