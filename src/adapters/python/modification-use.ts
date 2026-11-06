import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { packageRoot, resolvePythonExecutable } from './interpreter.js'
import { capturePolicySources } from './packaged-policy.js'
import { builtinPolicySources } from './builtin-policy.js'

const sources = Object.freeze({
  ...builtinPolicySources,
  ...capturePolicySources(packageRoot, ['gear/observations']),
})
const bootstrap = readFileSync(join(packageRoot, 'python/gear/observations/worker.py'), 'utf8')
export const modificationUseIdentity = canonicalDigest({ sources, bootstrap })

/** Independent bounded I/O worker; the algorithm worker stays free of filesystem access. */
export async function observeModificationUse(
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Json> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), ['-I', '-B', '-c', bootstrap], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    })
    const chunks: Buffer[] = []
    let bytes = 0,
      stopped = false
    const stop = () => {
      stopped = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(stop, 60_000)
    signal.addEventListener('abort', stop, { once: true })
    child.on('error', reject)
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) stop()
      else if (!stopped) chunks.push(chunk)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (code !== 0 || stopped) {
        reject(
          new GearError(
            'modification-observation-unavailable',
            'Native modification observations could not be verified',
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json)
      } catch {
        reject(
          new GearError('modification-observation-invalid', 'Native observer returned an invalid response'),
        )
      }
    })
    child.stdin.end(JSON.stringify({ ...input, sources }))
  })
}
