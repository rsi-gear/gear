import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { SessionRole } from '../types.js'
import { NotebookKernelSandbox, type NotebookKernelSandboxOptions } from './sandbox.js'

export interface NotebookExecuteRequest {
  sessionId: string
  cwd: string
  role: SessionRole
  code: string
  signal?: AbortSignal
}

export interface NotebookExecuteResult {
  stdout: string
  stderr: string
  result?: string
  displays: Array<{ mimeType: string; data: string }>
  executionCount: number
  concludesTurn?: boolean
}

export type NotebookBridgeHandler = (method: string, params: unknown, request: NotebookExecuteRequest) => Promise<unknown>

export interface NotebookRuntime {
  initialize(): Promise<void>
  execute(request: NotebookExecuteRequest): Promise<NotebookExecuteResult>
  interrupt(sessionId: string): Promise<void>
  restart(sessionId: string): Promise<void>
  disposeSession(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

interface KernelRequest {
  resolve(value: NotebookExecuteResult): void
  reject(error: Error): void
  request: NotebookExecuteRequest
  concludesTurn: boolean
}

interface KernelMessage {
  type?: string
  requestId?: string
  method?: string
  params?: unknown
  ok?: boolean
  result?: NotebookExecuteResult
  error?: { message?: string; traceback?: string }
}

interface Kernel {
  child: ChildProcessWithoutNullStreams
  lines: ReadlineInterface
  pending: Map<string, KernelRequest>
  stderr: string[]
  cwd: string
  executionCwd: string
  role: SessionRole
  cleanup(): Promise<void>
  cleanupPromise?: Promise<void>
}

function finalizationAccepted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).accepted === true
}

export interface SessionAwareNotebookOptions {
  pythonExecutable?: string
  helperPath?: string
  bridge?: NotebookBridgeHandler
  allowedMethods?: Partial<Record<SessionRole, readonly string[]>>
  interruptGraceMs?: number
  shutdownGraceMs?: number
  sandbox?: NotebookKernelSandboxOptions & { roles: readonly SessionRole[] }
}

function defaultHelperPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/ipython-kernel.py')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SessionAwareNotebookRuntime implements NotebookRuntime {
  private readonly kernels = new Map<string, Kernel>()
  private readonly pythonExecutable: string
  private readonly helperPath: string
  private readonly bridge: NotebookBridgeHandler
  private readonly allowedMethods: Partial<Record<SessionRole, readonly string[]>>
  private readonly interruptGraceMs: number
  private readonly shutdownGraceMs: number
  private readonly sandboxRoles: ReadonlySet<SessionRole>
  private readonly sandbox: NotebookKernelSandbox | undefined
  private readonly disposals = new Map<string, Promise<void>>()
  private readonly starts = new Map<string, Promise<Kernel>>()
  private readonly cleanups = new Set<Promise<void>>()
  private disposed = false

  constructor(options: SessionAwareNotebookOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? 'python3'
    this.helperPath = options.helperPath ?? defaultHelperPath()
    this.bridge = options.bridge ?? (async (method) => { throw new Error(`notebook host bridge method is unavailable: ${method}`) })
    this.allowedMethods = options.allowedMethods ?? {}
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000
    this.sandboxRoles = new Set(options.sandbox?.roles ?? [])
    this.sandbox = options.sandbox === undefined
      ? undefined
      : new NotebookKernelSandbox(this.pythonExecutable, this.helperPath, options.sandbox)
  }

  async initialize(): Promise<void> {
    await this.sandbox?.initialize()
  }

  async execute(request: NotebookExecuteRequest): Promise<NotebookExecuteResult> {
    if (this.disposed) throw new Error('NotebookRuntime is disposed')
    if (request.signal?.aborted === true) throw request.signal.reason
    await this.disposals.get(request.sessionId)
    const cwd = resolve(request.cwd)
    const kernel = this.kernels.get(request.sessionId) ?? await this.getOrSpawnKernel(request.sessionId, cwd, request.role)
    if (kernel.cwd !== cwd || kernel.role !== request.role) {
      throw new Error(`notebook session ${request.sessionId} cannot be rebound to a different cwd or role`)
    }
    if (kernel.pending.size > 0) throw new Error(`notebook session ${request.sessionId} is already executing`)
    const requestId = crypto.randomUUID()
    const completion = new Promise<NotebookExecuteResult>((resolvePromise, reject) => {
      kernel.pending.set(requestId, { resolve: resolvePromise, reject, request, concludesTurn: false })
    })
    let abortTimer: NodeJS.Timeout | undefined
    const abort = (): void => {
      void this.interrupt(request.sessionId)
      abortTimer = setTimeout(() => {
        if (kernel.pending.has(requestId)) this.signalKernel(kernel, 'SIGKILL')
      }, this.interruptGraceMs)
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    kernel.child.stdin.write(`${JSON.stringify({
      type: 'execute', requestId, code: request.code, cwd: kernel.executionCwd,
      allowedMethods: this.allowedMethods[request.role] ?? [],
    })}\n`)
    try {
      return await completion
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      request.signal?.removeEventListener('abort', abort)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const kernel = this.kernels.get(sessionId)
    if (kernel === undefined) return
    this.signalKernel(kernel, 'SIGINT')
  }

  async restart(sessionId: string): Promise<void> {
    await this.disposeSession(sessionId)
  }

  async disposeSession(sessionId: string): Promise<void> {
    const existing = this.disposals.get(sessionId)
    if (existing !== undefined) return existing
    const kernel = this.kernels.get(sessionId)
    if (kernel === undefined) return
    this.kernels.delete(sessionId)
    const disposal = new Promise<void>((resolvePromise) => {
      for (const pending of kernel.pending.values()) pending.reject(new Error(`notebook session ${sessionId} was disposed`))
      kernel.pending.clear()
      kernel.child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
      if (kernel.child.exitCode !== null) return resolvePromise()
      const terminate = setTimeout(() => this.signalKernel(kernel, 'SIGTERM'), this.shutdownGraceMs)
      const kill = setTimeout(() => this.signalKernel(kernel, 'SIGKILL'), this.shutdownGraceMs + 5_000)
      kernel.child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); resolvePromise() })
    })
    this.disposals.set(sessionId, disposal)
    try {
      await disposal
      await this.cleanupKernel(kernel)
    } finally {
      if (this.disposals.get(sessionId) === disposal) this.disposals.delete(sessionId)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    try {
      await Promise.allSettled(this.starts.values())
      await Promise.all([...this.kernels.keys()].map(sessionId => this.disposeSession(sessionId)))
      await Promise.all(this.disposals.values())
      await Promise.all(this.cleanups)
    } finally {
      await this.sandbox?.dispose()
    }
  }

  private async getOrSpawnKernel(sessionId: string, cwd: string, role: SessionRole): Promise<Kernel> {
    const existing = this.starts.get(sessionId)
    if (existing !== undefined) return existing
    const start = this.spawnKernel(sessionId, cwd, role)
    this.starts.set(sessionId, start)
    try {
      return await start
    } finally {
      if (this.starts.get(sessionId) === start) this.starts.delete(sessionId)
    }
  }

  private async spawnKernel(sessionId: string, cwd: string, role: SessionRole): Promise<Kernel> {
    const launch = this.sandbox !== undefined && this.sandboxRoles.has(role)
      ? await this.sandbox.launch(sessionId, cwd)
      : {
          child: spawn(this.pythonExecutable, ['-u', this.helperPath], {
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
          cwd,
          cleanup: async () => {},
        }
    const child = launch.child
    const lines = createInterface({ input: child.stdout })
    const kernel: Kernel = {
      child, lines, pending: new Map(), stderr: [], cwd, executionCwd: launch.cwd, role, cleanup: launch.cleanup,
    }
    this.kernels.set(sessionId, kernel)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      kernel.stderr.push(chunk)
      if (kernel.stderr.length > 100) kernel.stderr.shift()
    })
    lines.on('line', (line) => { void this.onMessage(sessionId, kernel, line) })
    child.once('error', error => this.failKernel(sessionId, kernel, error))
    child.once('exit', (code, signal) => {
      this.failKernel(sessionId, kernel, new Error(
        `IPython kernel exited (${signal ?? code ?? 'unknown'}): ${kernel.stderr.join('').slice(-4000)}`,
      ))
    })
    return kernel
  }

  private async onMessage(sessionId: string, kernel: Kernel, line: string): Promise<void> {
    let message: KernelMessage
    try {
      message = JSON.parse(line) as KernelMessage
    } catch {
      this.failKernel(sessionId, kernel, new Error(`IPython helper emitted invalid JSON: ${line.slice(0, 200)}`))
      return
    }
    const requestId = message.requestId
    if (requestId === undefined) return
    const pending = kernel.pending.get(requestId)
    if (pending === undefined) return
    if (message.type === 'bridge_request') {
      const method = message.method ?? ''
      const allowed = this.allowedMethods[pending.request.role] ?? []
      try {
        if (!allowed.includes(method)) throw new Error(`bridge method is not allowed for ${pending.request.role}: ${method}`)
        const result = await this.bridge(method, message.params, pending.request)
        if ((method === 'candidate.finalize' || method === 'candidate.decline') && finalizationAccepted(result)) {
          pending.concludesTurn = true
        }
        kernel.child.stdin.write(`${JSON.stringify({ type: 'bridge_response', requestId, ok: true, result })}\n`)
      } catch (error) {
        kernel.child.stdin.write(`${JSON.stringify({ type: 'bridge_response', requestId, ok: false, error: errorMessage(error) })}\n`)
      }
      return
    }
    kernel.pending.delete(requestId)
    if (message.type === 'result' && message.ok === true && message.result !== undefined) {
      const execution = message.result
      const { result, ...rest } = execution
      pending.resolve({
        ...rest,
        ...(typeof result === 'string' ? { result } : {}),
        ...(pending.concludesTurn ? { concludesTurn: true } : {}),
      })
    }
    else pending.reject(new Error(message.error?.traceback ?? message.error?.message ?? 'IPython execution failed'))
  }

  private failKernel(sessionId: string, kernel: Kernel, error: Error): void {
    if (this.kernels.get(sessionId) === kernel) this.kernels.delete(sessionId)
    for (const pending of kernel.pending.values()) pending.reject(error)
    kernel.pending.clear()
    kernel.lines.close()
    void this.cleanupKernel(kernel).catch(() => {})
  }

  private cleanupKernel(kernel: Kernel): Promise<void> {
    if (kernel.cleanupPromise !== undefined) return kernel.cleanupPromise
    // A normally exiting kernel may leave child processes in its owned group.
    // A successor session must not race those children against the same worktree.
    this.signalKernel(kernel, 'SIGKILL')
    const cleanup = kernel.cleanup().finally(() => this.cleanups.delete(cleanup))
    kernel.cleanupPromise = cleanup
    this.cleanups.add(cleanup)
    return cleanup
  }

  private signalKernel(kernel: Kernel, signal: NodeJS.Signals): void {
    if (kernel.child.pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-kernel.child.pid, signal)
        return
      } catch {}
    }
    kernel.child.kill(signal)
  }
}
