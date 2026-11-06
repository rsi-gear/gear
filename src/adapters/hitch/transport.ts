import { spawn } from 'node:child_process'
import { GearError } from '../../domain/errors.js'
import { hitchControlTimeoutMs } from './settings.js'

/** One bounded CLI call. A timeout is an unknown remote outcome, never a failed trial. */
export function hitchJson(
  executable: string,
  root: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = hitchControlTimeoutMs,
  maxBytes = 32 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0,
      stopped = false
    let force: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      stopped = true
      child.kill('SIGTERM')
      force ??= setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    const timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    child.on('error', reject)
    child.stderr.on('data', () => {}) // Credentials and provider diagnostics never enter Meta errors.
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) stop()
      else if (!stopped) chunks.push(chunk)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      signal.removeEventListener('abort', stop)
      if (code !== 0 || stopped) {
        reject(
          new GearError('hitch-call-failed', `Hitch ${args.slice(0, 2).join(' ')} did not complete`, {
            retryable: true,
          }),
        )
        return
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolve(value as Record<string, unknown>)
      } catch {
        reject(new GearError('hitch-invalid-json', 'Hitch returned an invalid object'))
      }
    })
  })
}
