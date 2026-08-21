import { spawn } from 'node:child_process'
import type { HarnessCompiler } from './builder.js'

export interface SubprocessCompilerOptions {
  command: string
  args?: string[]
  timeoutMs?: number
  env?: Record<string, string>
}

export class SubprocessHarnessCompiler implements HarnessCompiler {
  constructor(private readonly options: SubprocessCompilerOptions) {}

  async compile(worktree: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: worktree,
      env: this.options.env ?? {},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-16_000) })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (): void => {
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000)
    }
    const abort = (): void => { terminate() }
    signal.addEventListener('abort', abort, { once: true })
    const timeout = this.options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { timedOut = true; terminate() }, this.options.timeoutMs)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
        child.once('error', reject)
        child.once('exit', (code, childSignal) => resolvePromise({ code, signal: childSignal }))
      })
      if (signal.aborted) throw signal.reason
      if (timedOut) throw new Error(`harness compiler timed out after ${this.options.timeoutMs}ms`)
      if (result.code !== 0) {
        throw new Error(`harness compiler failed (${result.signal ?? result.code ?? 'unknown'})\n${stderr || stdout}`)
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
    }
  }
}
