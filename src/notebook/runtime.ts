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
}

export interface SessionAwareNotebookOptions {
  pythonExecutable?: string
  helperPath?: string
  bridge?: NotebookBridgeHandler
  allowedMethods?: Partial<Record<SessionRole, readonly string[]>>
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

  constructor(options: SessionAwareNotebookOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? 'python3'
    this.helperPath = options.helperPath ?? defaultHelperPath()
    this.bridge = options.bridge ?? (async (method) => { throw new Error(`notebook host bridge method is unavailable: ${method}`) })
    this.allowedMethods = options.allowedMethods ?? {}
  }

  async execute(request: NotebookExecuteRequest): Promise<NotebookExecuteResult> {
    if (request.signal?.aborted === true) throw request.signal.reason
    const kernel = this.kernels.get(request.sessionId) ?? this.spawnKernel(request.sessionId)
    if (kernel.pending.size > 0) throw new Error(`notebook session ${request.sessionId} is already executing`)
    const requestId = crypto.randomUUID()
    const completion = new Promise<NotebookExecuteResult>((resolvePromise, reject) => {
      kernel.pending.set(requestId, { resolve: resolvePromise, reject, request, concludesTurn: false })
    })
    const abort = (): void => { void this.interrupt(request.sessionId) }
    request.signal?.addEventListener('abort', abort, { once: true })
    kernel.child.stdin.write(`${JSON.stringify({
      type: 'execute', requestId, code: request.code, cwd: request.cwd,
      allowedMethods: this.allowedMethods[request.role] ?? [],
    })}\n`)
    try {
      return await completion
    } finally {
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
    this.spawnKernel(sessionId)
  }

  async disposeSession(sessionId: string): Promise<void> {
    const kernel = this.kernels.get(sessionId)
    if (kernel === undefined) return
    this.kernels.delete(sessionId)
    kernel.child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
    await new Promise<void>((resolvePromise) => {
      if (kernel.child.exitCode !== null) return resolvePromise()
      const timeout = setTimeout(() => kernel.child.kill('SIGTERM'), 1_000)
      kernel.child.once('exit', () => { clearTimeout(timeout); resolvePromise() })
    })
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.kernels.keys()].map(sessionId => this.disposeSession(sessionId)))
  }

  private spawnKernel(sessionId: string): Kernel {
    const child = spawn(this.pythonExecutable, ['-u', this.helperPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    const kernel: Kernel = { child, lines, pending: new Map(), stderr: [] }
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
