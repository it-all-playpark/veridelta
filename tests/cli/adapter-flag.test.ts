/**
 * `vdelta run --adapter <name>` (§4.3-4, §4.3-5): explicit adapter selection.
 * Spawns the built CLI (see tests/cli/stdout-flush.test.ts) so the exit-code
 * and stderr contract is exercised end to end, not just the flag parser.
 *
 * The child is a plain node script that reports back the argv and the capture
 * channel it was handed, which makes "was the child instrumented, and by
 * which adapter's surface" observable without any runner being installed —
 * and makes an unregistered name provably fatal *before* the child starts.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

const workspaces: string[] = []

afterEach(() => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()!
    rmSync(ws, { recursive: true, force: true })
  }
})

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

function spawnCli(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

interface ChildReport {
  captureFile: string
  argv: string[]
}

/**
 * A workspace plus a child that records how it was invoked. The script's
 * filename carries no runner token, so detection declines it — every
 * instrumentation this test observes came from an explicit `--adapter`.
 */
function makeWorkspace(): {
  workspace: string
  script: string
  marker: string
  report: () => ChildReport
} {
  const workspace = mkdtempSync(join(tmpdir(), 'vdelta-adapter-flag-'))
  workspaces.push(workspace)
  const marker = join(workspace, 'child-ran.json')
  const script = join(workspace, 'child.js')
  writeFileSync(
    script,
    [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      "  captureFile: process.env.VDELTA_CAPTURE_FILE ?? '',",
      '  argv: process.argv.slice(2),',
      '}))',
      "process.stdout.write('child output\\n')",
      '',
    ].join('\n'),
  )
  return {
    workspace,
    script,
    marker,
    report: () => JSON.parse(readFileSync(marker, 'utf8')) as ChildReport,
  }
}

describe('vdelta run --adapter (§4.3)', () => {
  it('rejects an unregistered adapter name before the child starts', async () => {
    const { workspace, script, marker } = makeWorkspace()

    const result = await spawnCli(
      ['run', '--adapter', 'playwright', '--', process.execPath, script],
      workspace,
    )

    // §4.3-5: user input error, not a degradation — exit 1, nothing on stdout.
    // The message is asserted whole: a name that only fails deeper in the run
    // surfaces as `internal error: …` with a stack, which is the same exit
    // code but not a usable answer to "which names may I pass".
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      "vdelta: unknown adapter 'playwright' — known adapters: vitest\n",
    )
    expect(result.stdout).toBe('')
    // Degrading instead would have run the child and swallowed the typo.
    expect(result.stderr).not.toContain('degraded to raw passthrough')
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects the --adapter=<name> form the same way', async () => {
    const { workspace, script, marker } = makeWorkspace()

    const result = await spawnCli(
      ['run', '--adapter=nope', '--', process.execPath, script],
      workspace,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("unknown adapter 'nope'")
    expect(result.stderr).toContain('known adapters: vitest')
    expect(result.stderr).not.toContain('internal error')
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects an empty adapter name instead of falling back to detection', async () => {
    const { workspace, script, marker } = makeWorkspace()

    const result = await spawnCli(
      ['run', '--adapter=', '--', process.execPath, script],
      workspace,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("unknown adapter ''")
    expect(result.stderr).not.toContain('internal error')
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects --adapter with no value', async () => {
    const { workspace, script, marker } = makeWorkspace()

    const result = await spawnCli(
      ['run', '--adapter', '--', process.execPath, script],
      workspace,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--adapter expects an adapter name')
    expect(existsSync(marker)).toBe(false)
  })

  it('injects the named adapter’s reporter into an argv it recognizes', async () => {
    const { workspace, script, marker, report } = makeWorkspace()

    // A vitest token in the argv, so the named adapter recognizes the command
    // and instruments it. `--adapter` and detection agree here; the point of
    // the case is that injection happens at all and lands the real reporter.
    const vitestish = join(workspace, 'vitest.js')
    writeFileSync(vitestish, readFileSync(script, 'utf8'))
    const result = await spawnCli(
      ['run', '--adapter', 'vitest', '--', process.execPath, vitestish],
      workspace,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child output')
    expect(existsSync(marker)).toBe(true)

    const child = report()
    expect(child.captureFile).not.toBe('')
    expect(child.argv).toContain('--includeTaskLocation')
    const reporterFlag = child.argv.find(
      (a) => a.startsWith('--reporter=') && a !== '--reporter=default',
    )
    // The injected reporter path is resolved relative to the adapter module,
    // which moved during the seam extraction — a stale base directory would
    // still look like a plausible flag, so assert the file is really there.
    expect(reporterFlag).toBeDefined()
    expect(existsSync(reporterFlag!.slice('--reporter='.length))).toBe(true)

    // The child cannot produce a capture, so the run still degrades (INV-5).
    expect(result.stderr).toContain('vdelta: degraded to raw passthrough')
  })

  it('never injects runner flags into an argv the named adapter declines', async () => {
    const { workspace, script, marker, report } = makeWorkspace()

    // §4.3-4 lets `--adapter` overrule detection about *who reads the
    // channel*, but the argv still belongs to the user. `--reporter=…` handed
    // to a child that is not that runner aborts it before it does any work
    // ("node: bad option: --reporter=default", exit 9), which is veridelta
    // being worse than its absence — the one thing INV-5 forbids. A wrapper
    // could not forward the flags to the runner anyway (§4.3-7), so this
    // costs nothing and the ambient channel below still records the run.
    const result = await spawnCli(
      ['run', '--adapter', 'vitest', '--', process.execPath, script],
      workspace,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child output')
    expect(existsSync(marker)).toBe(true)

    const child = report()
    expect(child.argv).toEqual([])
    // The channel is still offered: naming an adapter for a wrapper is how a
    // project with an ambiently configured reporter gets recorded (§4.2).
    expect(child.captureFile).not.toBe('')
    expect(result.stderr).toContain('vdelta: degraded to raw passthrough')
  })

  it('offers the capture channel to a child no adapter detected', async () => {
    const { workspace, script, report } = makeWorkspace()

    const result = await spawnCli(
      ['run', '--', process.execPath, script],
      workspace,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child output')
    const child = report()
    // Argv untouched — nothing recognized this command…
    expect(child.argv).toEqual([])
    // …but the channel env is exported regardless. A reporter registered in
    // the project's own config (spec §4.2 ambient recording, the RECOMMENDED
    // deployment) is inert without it, so gating it on detection silently
    // stops recording every wrapper invocation — `vdelta run -- npm test` —
    // which is precisely the severed stream §4.2 exists to prevent.
    expect(child.captureFile).not.toBe('')
    expect(result.stderr).toContain(
      'vdelta: degraded to raw passthrough (no capture from the vitest reporter',
    )
  })
})
