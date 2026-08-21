import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { SessionRole } from '../types.js'

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
  role: SessionRole
}

export interface SessionAwareNotebookOptions {
  pythonExecutable?: string
  helperPath?: string
  bridge?: NotebookBridgeHandler
  allowedMethods?: Partial<Record<SessionRole, readonly string[]>>
  interruptGraceMs?: number
  shutdownGraceMs?: number
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
  private readonly disposals = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: SessionAwareNotebookOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? 'python3'
    this.helperPath = options.helperPath ?? defaultHelperPath()
    this.bridge = options.bridge ?? (async (method) => { throw new Error(`notebook host bridge method is unavailable: ${method}`) })
    this.allowedMethods = options.allowedMethods ?? {}
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000
  }

  async execute(request: NotebookExecuteRequest): Promise<NotebookExecuteResult> {
    if (this.disposed) throw new Error('NotebookRuntime is disposed')
    if (request.signal?.aborted === true) throw request.signal.reason
    await this.disposals.get(request.sessionId)
    const cwd = resolve(request.cwd)
    const kernel = this.kernels.get(request.sessionId) ?? this.spawnKernel(request.sessionId, cwd, request.role)
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
        if (kernel.pending.has(requestId)) kernel.child.kill('SIGKILL')
      }, this.interruptGraceMs)
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    kernel.child.stdin.write(`${JSON.stringify({
      type: 'execute', requestId, code: request.code, cwd: request.cwd,
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
    kernel.child.kill('SIGINT')
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
      const terminate = setTimeout(() => kernel.child.kill('SIGTERM'), this.shutdownGraceMs)
      const kill = setTimeout(() => kernel.child.kill('SIGKILL'), this.shutdownGraceMs + 5_000)
      kernel.child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); resolvePromise() })
    })
    this.disposals.set(sessionId, disposal)
    try {
      await disposal
    } finally {
      if (this.disposals.get(sessionId) === disposal) this.disposals.delete(sessionId)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.kernels.keys()].map(sessionId => this.disposeSession(sessionId)))
    await Promise.all(this.disposals.values())
  }

  private spawnKernel(sessionId: string, cwd: string, role: SessionRole): Kernel {
    const child = spawn(this.pythonExecutable, ['-u', this.helperPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    const kernel: Kernel = { child, lines, pending: new Map(), stderr: [], cwd, role }
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
        if (method === 'submit_refinement_proposal') pending.concludesTurn = true
        kernel.child.stdin.write(`${JSON.stringify({ type: 'bridge_response', requestId, ok: true, result })}\n`)
      } catch (error) {
        kernel.child.stdin.write(`${JSON.stringify({ type: 'bridge_response', requestId, ok: false, error: errorMessage(error) })}\n`)
      }
      return
    }
    kernel.pending.delete(requestId)
    if (message.type === 'result' && message.ok === true && message.result !== undefined) {
      pending.resolve({ ...message.result, ...(pending.concludesTurn ? { concludesTurn: true } : {}) })
    }
    else pending.reject(new Error(message.error?.traceback ?? message.error?.message ?? 'IPython execution failed'))
  }

  private failKernel(sessionId: string, kernel: Kernel, error: Error): void {
    if (this.kernels.get(sessionId) === kernel) this.kernels.delete(sessionId)
    for (const pending of kernel.pending.values()) pending.reject(error)
    kernel.pending.clear()
    kernel.lines.close()
  }
}
