/** Build dist/ before conformance runs — fixtures exercise the built CLI. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileP = promisify(execFile)

export default async function setup(): Promise<void> {
  const repoRoot = join(import.meta.dirname, '..', '..')
  await execFileP(
    process.execPath,
    [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: repoRoot },
  )
}
