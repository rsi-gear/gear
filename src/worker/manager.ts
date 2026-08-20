import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonRpcPeer } from './peer.js'
import type { RefineService } from '../refine/service.js'
import type { RefineStateStore } from '../state/store.js'

export interface TargetWorkerLaunch {
  workerId: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  targetHarnessRef: string
  sandboxProfileRef: string
  provider: string
  model: string
  maxTokens?: number
}

interface SessionRecord {
  sessionId: string
  mode: 'create' | 'resume'
}

export class TargetWorkerManager {
  private child: ChildProcessWithoutNullStreams | undefined
  private peer: JsonRpcPeer | undefined
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(
    readonly launch: TargetWorkerLaunch,
    private readonly refine: RefineService,
    private readonly store: RefineStateStore,
  ) {}

  async start(): Promise<void> {
    if (this.child !== undefined) return
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: this.launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const peer = new JsonRpcPeer(child.stdout, child.stdin)
    this.child = child
    this.peer = peer
    peer.handle('control/refine.run', async params => {
      this.assertControlRequest(params)
      return this.refine.admit('target')
    })
    peer.handle('control/refine.status', async params => {
      this.assertControlRequest(params)
      if (typeof params.roundId !== 'string') throw new TypeError('roundId is required')
      return this.refine.status(params.roundId)
    })
    child.once('exit', () => {
      peer.close(new Error(`target worker ${this.launch.workerId} exited`))
      if (this.child === child) {
        this.child = undefined
        this.peer = undefined
      }
    })
    const initialized = await peer.request('initialize', {
      cwd: this.launch.cwd,
      provider: this.launch.provider,
      model: this.launch.model,
      ...(this.launch.maxTokens === undefined ? {} : { maxTokens: this.launch.maxTokens }),
    })
    if (typeof initialized !== 'object' || initialized === null
      || (initialized as { targetHarnessRef?: unknown }).targetHarnessRef !== this.launch.targetHarnessRef
      || (initialized as { sandboxProfileRef?: unknown }).sandboxProfileRef !== this.launch.sandboxProfileRef) {
      throw new Error('target worker initialized with a different harness or sandbox profile ref')
    }
  }

  async open(sessionId: string, mode: 'create' | 'resume'): Promise<void> {
    await this.start()
    await this.requirePeer().request('session/open', { sessionId, mode })
    this.sessions.set(sessionId, { sessionId, mode: 'resume' })
    await this.store.writeWorkerRecord(this.launch.workerId, {
      workerId: this.launch.workerId,
      sessionIds: [...this.sessions.keys()].sort(),
      targetHarnessRef: this.launch.targetHarnessRef,
      sandboxProfileRef: this.launch.sandboxProfileRef,
      updatedAt: new Date().toISOString(),
    })
  }

  async prompt(sessionId: string, contentBlocks: unknown[]): Promise<unknown> {
    return this.requirePeer().request('session/prompt', { sessionId, contentBlocks })
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requirePeer().request('session/cancel', { sessionId })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.requirePeer().request('session/close', { sessionId })
    this.sessions.delete(sessionId)
  }

  async restart(): Promise<void> {
    await this.disposeProcess()
    await this.start()
    for (const record of this.sessions.values()) {
      await this.requirePeer().request('session/open', { sessionId: record.sessionId, mode: 'resume' })
    }
  }

  async dispose(): Promise<void> {
    await this.disposeProcess()
    this.sessions.clear()
  }

  private assertControlRequest(params: Record<string, unknown>): void {
    if (params.targetHarnessRef !== this.launch.targetHarnessRef) throw new Error('worker control request has the wrong target harness ref')
    const sessionId = params.workerSessionId
    if (typeof sessionId !== 'string' || !this.sessions.has(sessionId)) throw new Error('worker control request has no owned session')
  }

  private requirePeer(): JsonRpcPeer {
    if (this.peer === undefined) throw new Error('target worker is not running')
    return this.peer
  }

  private async disposeProcess(): Promise<void> {
    const child = this.child
    const peer = this.peer
    this.child = undefined
    this.peer = undefined
    if (child === undefined || peer === undefined) return
    await peer.request('shutdown').catch(() => {})
    peer.close()
    child.stdin.end()
    await new Promise<void>(resolvePromise => {
      if (child.exitCode !== null) return resolvePromise()
      const timeout = setTimeout(() => child.kill('SIGTERM'), 1_000)
      child.once('exit', () => { clearTimeout(timeout); resolvePromise() })
    })
  }
}
