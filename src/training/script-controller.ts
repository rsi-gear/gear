import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import { TrainingContentStore, atomicWrite, withTrainingFileLock } from './store.js'
import { ModelNodeTransport, syncContentGraph } from './transport.js'
import { sealScriptSource, type TrainingScript } from './script-source.js'
import type { ModelNodeConnection, NodeIdentity } from './types.js'

export type ScriptNodeConnection = Omit<ModelNodeConnection, 'gateway'> & { gateway?: ModelNodeConnection['gateway'] }
export interface ScriptControllerConfig { schemaVersion: 1; kind: 'training-script-controller'; storeRoot: string; node: ScriptNodeConnection }
export interface ScriptRequest {
  schemaVersion: 1
  script: TrainingScript
  config: { rounds: number; initialCheckpoint: unknown; parameters: Record<string, unknown> }
}
export interface ScriptHandle { schemaVersion: 1; provider: 'python-script'; jobId: string; requestDigest: string }
export interface ScriptStatus {
  handle: ScriptHandle
  execution: 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'interrupted'
  resourcesReleased: boolean
  progress?: unknown; result?: unknown; error?: unknown
}
interface ScriptState {
  schemaVersion: 1; id: string; key: string; request: ScriptRequest; handle: ScriptHandle
  node: NodeIdentity; connection: ScriptNodeConnection; intent: { sequence: number; action: 'start' | 'pause' }
}

export function parseScriptControllerConfig(value: unknown): ScriptControllerConfig {
  const c = value as ScriptControllerConfig | null, n = c?.node
  requireContract(c?.schemaVersion === 1 && c.kind === 'training-script-controller' && typeof c.storeRoot === 'string' && isAbsolute(c.storeRoot)
    && n && typeof n.workspace === 'string' && isAbsolute(n.workspace) && typeof n.configPath === 'string' && isAbsolute(n.configPath)
    && Array.isArray(n.python) && n.python.length > 0 && n.python.every(x => typeof x === 'string' && !!x)
    && (n.transport?.type === 'local' || (n.transport?.type === 'ssh' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(n.transport.host))),
  'invalid-script-controller', 'script controller requires an absolute storeRoot and an explicit local/SSH node connection')
  return structuredClone(c)
}

export class TrainingScriptController {
  readonly store: TrainingContentStore
  constructor(readonly config: ScriptControllerConfig) { this.store = new TrainingContentStore(config.storeRoot) }
  private path(id: string) {
    requireContract(/^script_[a-f0-9]{32}$/.test(id), 'invalid-script-id', 'expected a script run ID')
    return join(this.store.root, 'script-runs', id, 'state.json')
  }
  private async load(id: string): Promise<ScriptState> {
    const state = JSON.parse(await readFile(this.path(id), 'utf8')) as ScriptState
    requireContract(state.schemaVersion === 1 && state.id === id && state.handle.jobId === id
      && state.handle.requestDigest === digestJson(state.request) && id === `script_${digestJson(state.key).slice(7, 39)}`
      && digestJson(state.connection) === digestJson(this.config.node), 'script-state-drift', 'run configuration or node connection differs from its frozen state')
    return state
  }
  private transport(state: ScriptState) { return new ModelNodeTransport(state.connection as ModelNodeConnection, state.node) }
  private status(value: unknown, state: ScriptState): ScriptStatus {
    const status = value as ScriptStatus
    requireContract(status && digestJson(status.handle) === digestJson(state.handle)
      && ['running', 'pausing', 'paused', 'completed', 'failed', 'interrupted'].includes(status.execution)
      && typeof status.resourcesReleased === 'boolean', 'script-status-drift', 'worker returned invalid status or another run identity')
    return status
  }
  async create(spec: unknown, baseDirectory: string): Promise<string> {
    const s = spec as { schemaVersion: number; kind: string; source: string; entrypoint: string; config: ScriptRequest['config'] }
    requireContract(s?.schemaVersion === 1 && s.kind === 'training-script' && typeof s.source === 'string' && !!s.source
      && s.config && Number.isSafeInteger(s.config.rounds) && s.config.rounds > 0
      && (s.config.parameters === undefined || (s.config.parameters && typeof s.config.parameters === 'object' && !Array.isArray(s.config.parameters))),
    'invalid-script-spec', 'script requires source directory, entrypoint and config with positive rounds')
    const script = await sealScriptSource(this.store, resolve(baseDirectory, s.source), s.entrypoint)
    const request: ScriptRequest = { schemaVersion: 1, script, config: {
      rounds: s.config.rounds, initialCheckpoint: s.config.initialCheckpoint ?? null, parameters: s.config.parameters ?? {},
    } }
    const observed = await new ModelNodeTransport(this.config.node as ModelNodeConnection, null).call('probe', {}) as NodeIdentity
    requireContract(typeof observed.nodeId === 'string' && typeof observed.generation === 'string', 'invalid-script-node', 'node probe did not return a stable identity')
    const node = { nodeId: observed.nodeId, generation: observed.generation }, key = randomUUID()
    const id = `script_${digestJson(key).slice(7, 39)}`
    const state: ScriptState = { schemaVersion: 1, id, key, request, node, connection: this.config.node,
      handle: { schemaVersion: 1, provider: 'python-script', jobId: id, requestDigest: digestJson(request) }, intent: { sequence: 0, action: 'start' } }
    await syncContentGraph(this.transport(state), this.store, [script.sourceRef], 'upload')
    await atomicWrite(this.path(id), state)
    return id
  }
  async inspect(id: string): Promise<ScriptStatus> {
    const state = await this.load(id)
    return this.status(await this.transport(state).call('scripts.inspect', { handle: state.handle }), state)
  }
  async control(id: string, action?: 'start' | 'pause'): Promise<ScriptStatus> {
    return withTrainingFileLock(this.path(id) + '.lock', async () => {
      const state = await this.load(id)
      if (action) {
        requireContract(Number.isSafeInteger(state.intent.sequence + 1), 'script-control-overflow', 'script control sequence exhausted')
        state.intent = { sequence: state.intent.sequence + 1, action }
        await atomicWrite(this.path(id), state)
      }
      return this.status(await this.transport(state).call('scripts.control', { request: state.request, idempotencyKey: state.key, intent: state.intent }), state)
    })
  }
  async follow(id: string, signal?: AbortSignal): Promise<ScriptStatus> {
    let status = await this.control(id), previous = '', pauseRequested = false
    while (true) {
      const progress = JSON.stringify({ id, execution: status.execution, progress: status.progress, error: status.error })
      if (progress !== previous) { process.stderr.write(progress + '\n'); previous = progress }
      if (!['running', 'pausing'].includes(status.execution) && status.resourcesReleased) return status
      if (signal?.aborted && !pauseRequested) { status = await this.control(id, 'pause'); pauseRequested = true; continue }
      await new Promise(resolve => setTimeout(resolve, 500))
      status = await this.inspect(id)
    }
  }
}

export async function scriptCommand(action: string, args: string[], config: ScriptControllerConfig): Promise<unknown> {
  const controller = new TrainingScriptController(config)
  requireContract(args.length === 1 && ['run', 'status', 'pause', 'resume'].includes(action), 'script-usage', 'training run SPEC.json|SCRIPT_ID, or status|pause|resume SCRIPT_ID')
  let id = args[0]!
  if (action === 'run' && !/^script_[a-f0-9]{32}$/.test(id)) {
    const file = resolve(id)
    id = await controller.create(JSON.parse(await readFile(file, 'utf8')), dirname(file))
    process.stderr.write(JSON.stringify({ scriptRunId: id }) + '\n')
  }
  if (action === 'status') return controller.inspect(id)
  if (action === 'pause') return controller.control(id, 'pause')
  if (action === 'resume') await controller.control(id, 'start')
  const signal = new AbortController(), stop = () => signal.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try { return await controller.follow(id, signal.signal) }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
