import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GearError } from '../../domain/errors.js'
import { hitchControlTimeoutMs } from './settings.js'

/** One bounded CLI call. A timeout is an unknown remote outcome, never a failed trial. */
const observations = new Map<string, Promise<unknown>>()
class ObservationBusy extends Error {}

export async function hitchJson(
  executable: string,
  root: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = hitchControlTimeoutMs,
  maxBytes = 32 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (args[0] !== 'worker' || args[1] !== 'observe')
    return invokeHitchJson(executable, root, args, signal, timeoutMs, maxBytes)
  // The daemon admits one fresh host probe at a time. Coordinate across all
  // providers/operations using it, without sharing or caching nonce responses.
  const key = resolve(root),
    deadline = Date.now() + timeoutMs
  const observe = async () => {
    for (;;) {
      signal.throwIfAborted()
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new GearError('hitch-call-failed', 'Hitch worker observe did not complete', { retryable: true })
      try {
        return await invokeHitchJson(executable, root, args, signal, remaining, maxBytes)
      } catch (error) {
        // Another process may own the probe. Only this explicit read-only busy
        // response can be retried; submissions and unknown outcomes never are.
        if (!(error instanceof ObservationBusy)) throw error
        await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal })
      }
    }
  }
  const result = (observations.get(key) ?? Promise.resolve()).catch(() => {}).then(observe)
  observations.set(key, result)
  return new Promise((accept, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new GearError('hitch-call-failed', 'Hitch worker observe did not complete', { retryable: true }),
        ),
      Math.max(1, deadline - Date.now()),
    )
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      if (observations.get(key) === result) observations.delete(key)
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    // Keep the queue position until it drains, even if this caller cancels.
    result.then(
      (value) => {
        cleanup()
        accept(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function invokeHitchJson(
  executable: string,
  root: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const diagnostics: Buffer[] = []
    let diagnosticBytes = 0
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
    child.stderr.on('data', (chunk: Buffer) => {
      // Retain only a bounded structured error for the host-probe busy code.
      // Raw diagnostics and their messages never enter Meta errors.
      if (args[0] !== 'worker' || args[1] !== 'observe') return
      diagnosticBytes += chunk.length
      if (diagnosticBytes <= 8192) diagnostics.push(chunk)
    })
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
        if (code === 12 && !stopped && diagnosticBytes <= 8192) {
          try {
            const value = JSON.parse(Buffer.concat(diagnostics).toString('utf8'))
            if (
              value.schema_version === '1' &&
              value.kind === 'error' &&
              value.error?.code === 'execution_observation_busy' &&
              value.error?.exit_code === 12
            ) {
              reject(new ObservationBusy())
              return
            }
          } catch {
            /* Non-protocol diagnostics are intentionally discarded. */
          }
        }
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
