import { spawn } from 'node:child_process'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HarnessCompiler } from './builder.js'

export interface SubprocessCompilerOptions {
  command: string
  args?: string[]
  timeoutMs?: number
  env?: Record<string, string>
  sandboxMode?: 'required' | 'disabled'
  targetRoot?: string
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function systemReadPaths(): string[] {
  return process.platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/dev']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev']
}

export class SubprocessHarnessCompiler implements HarnessCompiler {
  constructor(private readonly options: SubprocessCompilerOptions) {}

  async compile(worktree: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    let command = this.options.command
    let args = this.options.args ?? []
    if (this.options.sandboxMode === 'required') {
      if (!isAbsolute(command)) throw new Error('sandboxed harness compiler command must be an absolute fixed toolchain path')
      const canonicalCommand = await realpath(command)
      const targetPath = join(resolve(worktree), ...(this.options.targetRoot ?? 'harness').split('/'))
      const config: SandboxRuntimeConfig = {
        network: { allowedDomains: [], deniedDomains: ['*'], allowUnixSockets: [], allowLocalBinding: false },
        filesystem: {
          denyRead: ['/'], allowRead: [
            ...systemReadPaths(), resolve(worktree), dirname(resolve(command)), dirname(dirname(canonicalCommand)),
          ],
          allowWrite: [targetPath], denyWrite: [], allowGitConfig: false,
        },
        allowAppleEvents: false,
      }
      const line = [command, ...args].map(shellQuote).join(' ')
      const wrapped = await SandboxManager.wrapWithSandboxArgv(line, '/bin/bash', config)
      command = wrapped.argv[0]!
      args = wrapped.argv.slice(1)
    }
    const child = spawn(command, args, {
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
