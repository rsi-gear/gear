import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { TrainingContractError, requireContract } from './schema.js'

export class ProcessResponseError extends TrainingContractError {
  constructor(code: string, message: string, readonly exitCode: number | null) { super(code, message) }
}

/** Structured argv/stdin only. Secrets and child stderr never enter public errors. */
export function jsonProcess(command: readonly string[], args: readonly string[], payload?: unknown, timeoutMs = 60_000): Promise<unknown> {
  requireContract(command.length > 0 && command.every(s => typeof s === 'string' && s.length > 0), 'invalid-command', 'command must be a nonempty argv array')
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; let bytes = 0; let problem: Error | undefined
    const diagnostics = process.env.GEAR_TRAINING_PROCESS_DIAGNOSTICS
    let stderr = Buffer.alloc(0), stderrBytes = 0
    const timer = setTimeout(() => { problem = new TrainingContractError('process-timeout', 'operation timed out; reconcile its original idempotency key'); child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) { problem = new TrainingContractError('process-output-limit', 'JSON output exceeded 32 MiB'); child.kill('SIGKILL') }
      else output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (diagnostics && stderr.length < 65536) stderr = Buffer.concat([stderr, chunk.subarray(0, 65536 - stderr.length)])
    })
    child.stdin.on('error', () => {})
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', async (code, signal) => {
      clearTimeout(timer)
      if (problem) { reject(problem); return }
      try {
        let value: { error?: { code?: string; message?: string } }
        try { value = JSON.parse(output) }
        catch {
          if (diagnostics) {
            // Opt-in private diagnostics omit argv, stdin and model output.
            // Failure to write diagnostics must not hide the original failure.
            try {
              const directory = await lstat(diagnostics)
              if (directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0
                && (!process.getuid || directory.uid === process.getuid())) {
                await writeFile(join(diagnostics, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({
                  executable: basename(command[0]!), exitCode: code, signal, stdoutBytes: bytes, stderrBytes,
                  stderr: stderr.toString('utf8'),
                }), { flag: 'wx', mode: 0o600 })
              }
            } catch { /* Preserve the process failure. */ }
          }
          throw new ProcessResponseError(code === 0 ? 'invalid-process-json' : 'process-failed',
            `subprocess returned invalid JSON (exit=${code}, signal=${signal ?? 'none'}, stdoutBytes=${bytes}, stderrBytes=${stderrBytes}); inspect private diagnostics`, code)
        }
        if (code !== 0 || value.error) throw new TrainingContractError(value.error?.code ?? 'process-failed', value.error?.message ?? 'subprocess failed; inspect its private logs')
        resolve(value)
      } catch (error) { reject(error) }
    })
    child.stdin.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}
