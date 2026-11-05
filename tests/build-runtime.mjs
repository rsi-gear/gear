import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Process-level tests must execute the same production entrypoints as the package.
export default function buildRuntime() {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'pipe',
    ...(process.platform === 'win32' ? { shell: true } : {}),
  })
}
