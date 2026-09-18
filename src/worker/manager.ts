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
  targetManifestDigest: string
  sandboxProfileRef: string
  provider: string
  model: string
  maxTokens?: number
  onSessionEvent?: (params: Record<string, unknown>) => void
  onSessionStatus?: (params: Record<string, unknown>) => void
}

interface SessionRecord {
  sessionId: string
  mode: 'create' | 'resume'
}

export class TargetWorkerManager {
  private child: ChildProcessWithoutNullStreams | undefined
  private peer: JsonRpcPeer | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private stderr = ''

  constructor(
    readonly launch: TargetWorkerLaunch,
    private readonly refine: RefineService,
    private readonly store: RefineStateStore,
    private readonly evolutionId: string,
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
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_000) })
    peer.handle('control/refine.run', async params => {
      this.assertControlRequest(params)
      return this.refine.continueEvolution('target', this.evolutionId)
    })
    peer.handle('control/refine.status', async params => {
      this.assertControlRequest(params)
      if (params.roundId !== undefined && typeof params.roundId !== 'string') throw new TypeError('roundId must be a string')
      return this.refine.status(this.evolutionId, params.roundId as string | undefined)
    })
    peer.handle('session.event', params => { this.launch.onSessionEvent?.(params); return {} })
    peer.handle('session.status', params => { this.launch.onSessionStatus?.(params); return {} })
    child.once('error', error => peer.close(error))
    child.once('exit', (code, signal) => {
      peer.close(new Error(`target worker ${this.launch.workerId} exited (${signal ?? code ?? 'unknown'}): ${this.stderr}`))
      if (this.child === child) {
        this.child = undefined
        this.peer = undefined
      }
    })
    try {
      const initialized = await peer.request('initialize', {
        cwd: this.launch.cwd,
        provider: this.launch.provider,
        model: this.launch.model,
        ...(this.launch.maxTokens === undefined ? {} : { maxTokens: this.launch.maxTokens }),
      })
      if (typeof initialized !== 'object' || initialized === null
        || (initialized as { targetHarnessRef?: unknown }).targetHarnessRef !== this.launch.targetHarnessRef
        || (initialized as { targetManifestDigest?: unknown }).targetManifestDigest !== this.launch.targetManifestDigest
        || (initialized as { sandboxProfileRef?: unknown }).sandboxProfileRef !== this.launch.sandboxProfileRef) {
        throw new Error('target worker initialized with a different harness, manifest, or sandbox profile ref')
      }
    } catch (error) {
      await this.disposeProcess()
      throw error
    }
  }

  async open(sessionId: string, mode: 'create' | 'resume'): Promise<void> {
    await this.start()
    await this.requirePeer().request('session/open', { sessionId, mode })
    this.sessions.set(sessionId, { sessionId, mode: 'resume' })
    await this.persistRecord()
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
    await this.persistRecord()
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

  private persistRecord(): Promise<void> {
    return this.store.writeWorkerRecord(this.launch.workerId, {
      workerId: this.launch.workerId,
      sessionIds: [...this.sessions.keys()].sort(),
      targetHarnessRef: this.launch.targetHarnessRef,
      targetManifestDigest: this.launch.targetManifestDigest,
      sandboxProfileRef: this.launch.sandboxProfileRef,
      updatedAt: new Date().toISOString(),
    })
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
      const terminate = setTimeout(() => child.kill('SIGTERM'), 1_000)
      const kill = setTimeout(() => child.kill('SIGKILL'), 6_000)
      child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); resolvePromise() })
    })
  }
}
