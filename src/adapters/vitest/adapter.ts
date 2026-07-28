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
 * Initial capability declaration for `vitest-native/1` (§3.4). Reproduces the
 * composition's documented standing byte for byte: only `source-region-text`
 * is degraded (CE-1 — vitest's structured channel carries no failing-source
 * region text), everything else this composition claims is met.
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

  instrument(argv, channel) {
    return {
      argv: [
        ...argv,
        '--reporter=default',
        `--reporter=${reporterModulePath()}`,
        '--includeTaskLocation',
      ],
      env: { VDELTA_CAPTURE_FILE: channel.path },
    }
  },

  splitCommandSelector,

  record(channel, ctx) {
    let capture: Capture
    try {
      capture = JSON.parse(readFileSync(channel.path, 'utf8')) as Capture
    } catch {
      throw new AdapterCaptureError(
        'no capture from the vitest reporter — is the child a vitest invocation?',
      )
    }
    return buildRunRecord(capture, ctx)
  },
}
