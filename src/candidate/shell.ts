import type { Context } from '@deepseek-ai/cordis'
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellProcess, type ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CandidateWorkspaceManager } from './workspace.js'

const SAFE_ENV = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'] as const

function contained(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function systemPaths(): string[] {
  return process.platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/dev']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev']
}

function environment(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'),
    XDG_CACHE_HOME: join(scratch, 'cache'), XDG_CONFIG_HOME: join(scratch, 'config'),
  }
  for (const key of SAFE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}

function appendBounded(chunks: Buffer[], chunk: Buffer, maxBytes: number): boolean {
  chunks.push(chunk)
  let size = chunks.reduce((sum, item) => sum + item.byteLength, 0)
  const truncated = size > maxBytes
  while (size > maxBytes && chunks.length > 0) {
    const first = chunks[0]!
    const excess = size - maxBytes
    if (first.byteLength <= excess) { chunks.shift(); size -= first.byteLength }
    else { chunks[0] = first.subarray(excess); size -= excess }
  }
  return truncated
}

/** Air-gapped candidate bash provider consumed by DSH's standard bash tool. */
export class CandidateShellExecutor extends ShellExecutor {
  constructor(
    ctx: Context,
    private readonly manager: CandidateWorkspaceManager,
    private readonly metaSessionId: string,
    private readonly timeoutCapMs: number,
    private readonly outputCapBytes: number,
  ) { super(ctx) }

  override get sandboxMode(): 'workspace-write' { return 'workspace-write' }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const handle = this.manager.resolve(this.metaSessionId)
    if (handle.state !== 'open') throw new Error('candidate shell is unavailable after workspace sealing')
    const workdir = request.workdir === undefined
      ? handle.targetPath
      : this.resolveWorkdir(handle.targetPath, request.workdir)
    const timeoutMs = Math.min(Math.max(1, request.timeoutMs ?? this.timeoutCapMs), this.timeoutCapMs)
    return {
      command: request.command, workdir, timeoutMs,
      stdoutMaxBytes: Math.min(request.stdoutMaxBytes ?? this.outputCapBytes, this.outputCapBytes),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: handle.targetPath },
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.manager.withOpenWorkspace(this.metaSessionId, true, async handle => {
      if (handle.state !== 'open' || !contained(resolve(spec.workdir), resolve(handle.targetPath))) {
        throw new Error('candidate shell workdir is stale or outside the active target')
      }
      const scratch = join(dirname(handle.worktreePath), 'command-scratch')
      await Promise.all(['home', 'tmp', 'cache', 'config'].map(path => mkdir(join(scratch, path), { recursive: true, mode: 0o700 })))
      const config: SandboxRuntimeConfig = {
        network: { allowedDomains: [], deniedDomains: ['*'], allowUnixSockets: [], allowLocalBinding: false },
        filesystem: {
          denyRead: ['/'], allowRead: [...systemPaths(), handle.worktreePath, scratch],
          allowWrite: [handle.targetPath, scratch], denyWrite: [], allowGitConfig: false,
        },
        allowAppleEvents: false,
      }
      const wrapped = await SandboxManager.wrapWithSandboxArgv(spec.command, '/bin/bash', config)
      const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: spec.workdir, env: environment(scratch), detached: process.platform !== 'win32', shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutTruncated = false
      let stderrTruncated = false
      child.stdout.on('data', chunk => { stdoutTruncated = appendBounded(stdout, Buffer.from(chunk), spec.stdoutMaxBytes) || stdoutTruncated })
      child.stderr.on('data', chunk => { stderrTruncated = appendBounded(stderr, Buffer.from(chunk), this.outputCapBytes) || stderrTruncated })
      let firstCause: 'timeout' | 'abort' | undefined
      let killTimer: NodeJS.Timeout | undefined
      const terminate = (): void => {
        try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGTERM') } catch { child.kill('SIGTERM') }
        killTimer ??= setTimeout(() => {
          try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }, 2_000)
      }
      const onAbort = (): void => { firstCause ??= 'abort'; terminate() }
      spec.signal?.addEventListener('abort', onAbort, { once: true })
      const timeout = setTimeout(() => { firstCause ??= 'timeout'; terminate() }, spec.timeoutMs)
      try {
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolveOutcome({ code, signal }))
        })
        const stdoutText = Buffer.concat(stdout).toString('utf8')
        const stderrText = Buffer.concat(stderr).toString('utf8')
        const denied = /(?:operation not permitted|permission denied|sandbox)/iu.test(stderrText)
        return {
          exitCode: outcome.code, signal: outcome.signal,
          timedOut: firstCause === 'timeout', aborted: firstCause === 'abort', timeoutMs: spec.timeoutMs,
          stdout: { text: stdoutText, truncated: stdoutTruncated }, stderr: { text: stderrText, truncated: stderrTruncated },
          sandbox: { mode: 'workspace-write', denied, enforcement: 'full' },
        }
      } finally {
        clearTimeout(timeout)
        if (killTimer !== undefined) clearTimeout(killTimer)
        spec.signal?.removeEventListener('abort', onAbort)
      }
    })
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('background candidate shell processes are disabled')
  }

  private resolveWorkdir(root: string, requested: string): string {
    let value = requested
    if (value === '/candidate' || value === '/candidate/harness') value = '.'
    else if (value.startsWith('/candidate/harness/')) value = value.slice('/candidate/harness/'.length)
    else if (isAbsolute(value)) throw new Error('candidate shell workdir cannot be an absolute host path')
    const path = resolve(root, value)
    if (!contained(path, resolve(root))) throw new Error('candidate shell workdir escapes the target root')
    return path
  }
}
