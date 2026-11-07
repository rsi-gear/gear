import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Process-level tests must execute the same production entrypoints as the package.
export default function buildRuntime() {
  // On Windows, npm is exposed as npm.cmd rather than a directly executable
  // `npm` binary. Reuse the CLI that launched this test process when available.
  const npmExecPath = process.env.npm_execpath
  execFileSync(
    npmExecPath ? process.execPath : 'npm',
    npmExecPath ? [npmExecPath, 'run', 'build'] : ['run', 'build'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'pipe',
    },
  )
}
