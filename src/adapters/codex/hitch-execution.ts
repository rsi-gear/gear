import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { prepareSandbox } from './sandbox.js'

/** The trusted Hitch worker owns the model process and its budget gateway. */
export async function executeHitchMeta(
  prepared: Awaited<ReturnType<typeof prepareSandbox>>,
  directory: string,
  timeoutMs: number,
  started: () => void,
) {
  const events = await open(join(directory, 'events.jsonl'), 'wx', 0o600)
  const diagnostics = await open(join(directory, 'stderr.log'), 'wx', 0o600)
  try {
    return await new Promise<{
      runId: string
      usage: Record<string, number | null>
      outcome: string
      complete: boolean
    }>((resolve, reject) => {
      const child = spawn(prepared.argv[0]!, prepared.argv.slice(1), {
        env: prepared.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (child.pid !== undefined) started()
      child.stdin.on('error', () => {})
      const chunks: Buffer[] = []
      let bytes = 0,
        errorBytes = 0,
        reason: string | undefined,
        writes = Promise.resolve()
      let force: ReturnType<typeof setTimeout> | undefined
      const stop = (code: string) => {
        reason ??= code
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        force ??= setTimeout(() => child.kill('SIGKILL'), 15000)
      }
      const timer = setTimeout(() => stop('codex-timeout'), timeoutMs)
      let checking = false
      const polling = setInterval(() => {
        if (checking) return
        checking = true
        void stat(join(directory, 'cancel.json'))
          .then(() => stop('codex-cancelled'))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') stop('codex-cancel-check-failed')
          })
          .finally(() => {
            checking = false
          })
      }, 100)
      const terminate = () => stop('codex-controller-stopped')
      process.once('SIGTERM', terminate)
      process.once('SIGINT', terminate)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 32 * 1024 * 1024) {
          stop('codex-output-too-large')
          return
        }
        chunks.push(chunk)
        writes = writes
          .then(async () => {
            await events.write(chunk)
          })
          .catch(() => stop('codex-log-failed'))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const bounded = chunk.subarray(0, Math.max(0, 64 * 1024 - errorBytes))
        errorBytes += bounded.length
        writes = writes
          .then(async () => {
            await diagnostics.write(bounded)
          })
          .catch(() => stop('codex-log-failed'))
      })
      let spawnError: Error | undefined
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        clearTimeout(force)
        clearInterval(polling)
        process.removeListener('SIGTERM', terminate)
        process.removeListener('SIGINT', terminate)
        void writes
          .then(() => {
            if (spawnError || signal) throw new Error('hitch-meta-state-unknown')
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              schema_version?: string
              run_id?: string
              status?: string
              execution?: { stopped?: boolean }
              generation_usage?: Record<string, number | null>
              error?: { code?: string }
            }
            if (
              result.schema_version !== '1' ||
              !result.run_id ||
              !/^run_[a-f0-9]{32}$/u.test(result.run_id) ||
              result.execution?.stopped !== true ||
              !result.generation_usage ||
              typeof result.generation_usage !== 'object' ||
              Array.isArray(result.generation_usage)
            )
              throw new Error('hitch-meta-state-unknown')
            return {
              runId: result.run_id,
              usage: result.generation_usage,
              complete: !reason && code === 0 && result.status === 'succeeded',
              outcome:
                reason ??
                (result.status === 'succeeded'
                  ? 'complete'
                  : result.error?.code === 'generation_budget_exhausted'
                    ? 'generation-budget-exhausted'
                    : 'hitch-meta-failed'),
            }
          })
          .then(resolve, reject)
      })
    })
  } finally {
    await events.close()
    await diagnostics.close()
  }
}
