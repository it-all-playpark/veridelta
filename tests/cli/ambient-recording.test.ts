/**
 * Ambient recording through a wrapper command (spec §4.2).
 *
 * §4.2 makes recording "ambient-first": the RECOMMENDED deployment registers
 * the reporter in the project's own configuration, where it is inert until
 * `VDELTA_CAPTURE_FILE` names a channel (`src/adapters/vitest/reporter.ts`).
 * `vdelta run --` is then just one recorder, and the command it wraps need not
 * mention the runner at all — `npm test`, `pnpm -r test`, `sh ./ci.sh`.
 *
 * Nothing else can cover this. Every conformance fixture invokes vitest
 * directly (so argv detection always succeeds) and none may set `reporters`
 * at all (`conformance/README.md`), so the whole ambient path — channel env
 * exported to an undetected child, capture claimed from its payload rather
 * than from argv — is invisible to the 46-fixture suite and to the A/B replay
 * built on it. It regressed there silently once already.
 */
import { execFile, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileP = promisify(execFile)

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const CLI = join(REPO_ROOT, 'dist', 'cli.js')
const REPORTER = join(REPO_ROOT, 'dist', 'adapters', 'vitest', 'reporter.js')
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

const workspaces: string[] = []

afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop()!, { recursive: true, force: true })
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

/**
 * A real vitest project whose config registers the vdelta reporter (ambient),
 * reached through a wrapper whose argv names node and a script — never the
 * runner. `node wrapper.mjs` rather than a shell script so the command is
 * spelled the same way on every platform.
 */
async function makeAmbientWorkspace(): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), 'vdelta-ambient-'))
  workspaces.push(workspace)
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(workspace, 'node_modules'))
  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'ambient-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  writeFileSync(join(workspace, '.gitignore'), 'node_modules\n.veridelta\n')
  writeFileSync(
    join(workspace, 'vitest.config.ts'),
    [
      "import { defineConfig } from 'vitest/config'",
      'export default defineConfig({',
      `  test: { reporters: ['default', ${JSON.stringify(REPORTER)}] },`,
      '})',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(workspace, 'sample.test.ts'),
    [
      "import { expect, test } from 'vitest'",
      "test('green', () => { expect(1).toBe(1) })",
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(workspace, 'wrapper.mjs'),
    [
      "import { spawnSync } from 'node:child_process'",
      `const r = spawnSync(process.execPath, [${JSON.stringify(VITEST_BIN)}, 'run'], { stdio: 'inherit' })`,
      'process.exit(r.status ?? 1)',
      '',
    ].join('\n'),
  )
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], {
    cwd: workspace,
  })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: workspace })
  await execFileP('git', ['add', '-A'], { cwd: workspace })
  await execFileP(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'],
    { cwd: workspace },
  )
  return workspace
}

function recordFiles(workspace: string): string[] {
  try {
    return readdirSync(join(workspace, '.veridelta', 'runs'))
  } catch {
    return []
  }
}

describe('ambient recording through a wrapper (spec §4.2)', () => {
  it('records a child whose argv names no runner', async () => {
    const workspace = await makeAmbientWorkspace()

    const result = await spawnCli(
      ['run', '--report', 'json', '--', process.execPath, 'wrapper.mjs'],
      workspace,
    )

    // No adapter can claim this argv, yet the reporter in the project's own
    // config wrote a capture — so there is evidence, and a report.
    expect(result.stderr).not.toContain('degraded to raw passthrough')
    expect(result.code).toBe(0)
    expect(recordFiles(workspace)).toHaveLength(1)

    const report = JSON.parse(result.stdout) as {
      current: { run_id: string }
      failure_evidence: { composition_id: string }
    }
    expect(report.current.run_id).toMatch(/^run_[0-9a-f]{64}$/)
    // The capture named its own author, so the record is a vitest record.
    expect(report.failure_evidence.composition_id).toBe('vitest-native/2')
  })

  it('records the same run whether or not --adapter names the reader', async () => {
    const workspace = await makeAmbientWorkspace()

    const bare = await spawnCli(
      ['run', '--report', 'json', '--', process.execPath, 'wrapper.mjs'],
      workspace,
    )
    const [bareRecord] = recordFiles(workspace)
    rmSync(join(workspace, '.veridelta'), { recursive: true, force: true })

    const named = await spawnCli(
      [
        'run',
        '--report',
        'json',
        '--adapter',
        'vitest',
        '--',
        process.execPath,
        'wrapper.mjs',
      ],
      workspace,
    )
    const [namedRecord] = recordFiles(workspace)

    expect(bare.code).toBe(0)
    expect(named.code).toBe(0)
    // `run_id` is the record's content address minus the `recording` group
    // (§3.5), so equal ids mean the two paths produced the same evidence:
    // naming the adapter decides who reads the channel, never what is read.
    expect(namedRecord).toBe(bareRecord)
  })
})
