import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Process-level tests must execute the same production entrypoints as the package.
export default function buildRuntime() {
  execFileSync('npm', ['run', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'pipe',
  })
}
