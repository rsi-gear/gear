import { link, mkdir, open, readFile, rename, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MetaCheckpointRef, ProposalEvidenceAudit } from '../types.js'
import { digestJson } from '../state/digest.js'

export interface HandoffIntent {
  trigger: 'pressure' | 'overflow'
  pressure: number
  measurementBasis?: string
  source: MetaCheckpointRef
  successorSessionId: string
  phase: 'intent' | 'prepared' | 'activated' | 'delivered'
  bundleDigest?: string
  bootstrapPressure?: number
}

export interface MetaExecutionState {
  schemaVersion: 1
  executionId: string
  evolutionId: string
  specDigest: string
  roundId: string
  candidateId?: string
  attempt: number
  generation: number
  revision: number
  activeSessionId: string
  sessions: string[]
  status: 'running' | 'rotating' | 'completed' | 'stopped'
  deadlineAt: number
  usage: { modelRequests: number; tokens: number; summaryRequests: number; summaryTokens: number }
  pending: UserMessage[]
  continuation?: UserMessage[]
  deliveredIds: string[]
  handoffs: string[]
  intent?: HandoffIntent
  failure?: string
  workSteps?: number
  progressAtRotation?: number
  emergencyWithoutProgress?: boolean
  recovery?: {
    envelope: UserMessage
    controller: unknown
    evidence: ProposalEvidenceAudit
  }
}

export interface HandoffBundle {
  manifest: {
    schemaVersion: 1
    executionId: string
    evolutionId: string
    specDigest: string
    generation: number
    source: MetaCheckpointRef
    successorSessionId: string
    stateDigest: string
    summaryDigest: string
    coverage: { firstSeq: number; lastSeq: number; omittedEvents: number; truncatedEvents?: number }
    summaryUsage: { tokens: number; durationMs: number }
  }
  state: {
    controller: unknown
    evidence: ProposalEvidenceAudit
    envelope: UserMessage
    exactInputs: UserMessage[]
    pending: UserMessage[]
    deadlineAt: number
    usage: MetaExecutionState['usage']
    runtime: 'fresh-notebook-kernel'
  }
  summary: string
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('invalid offloading artifact identity')
  return value
}

async function read<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** One CAS file is the authority for owner, journal and delivery cursor. */
export class MetaOffloadingStore {
  readonly root: string
  constructor(stateRoot: string) { this.root = join(stateRoot, 'meta-context') }

  async read(executionId: string): Promise<MetaExecutionState | undefined> {
    const state = await read<MetaExecutionState>(join(this.root, 'executions', `${safeId(executionId)}.json`))
    if (state !== undefined && (state.schemaVersion !== 1 || state.executionId !== executionId
      || !Number.isSafeInteger(state.revision) || !state.sessions.includes(state.activeSessionId))) {
      throw new Error('invalid context execution state')
    }
    return state
  }

  async list(): Promise<MetaExecutionState[]> {
    let entries: string[]
    try { entries = await readdir(join(this.root, 'executions')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return Promise.all(entries.filter(name => name.endsWith('.json')).map(async name => (await this.read(name.slice(0, -5)))!))
  }

  async cas(expectedRevision: number | undefined, next: MetaExecutionState): Promise<void> {
    const path = join(this.root, 'executions', `${safeId(next.executionId)}.json`)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const lockPath = `${path}.lock`
    // Publish a fully written PID record with an exclusive hard link. A crash
    // between lock creation and writing must not leave an ownerless empty lock.
    const claimPath = `${lockPath}.${crypto.randomUUID()}.claim`
    const lock = await open(claimPath, 'wx', 0o600)
    let acquired = false
    const deadline = Date.now() + 10_000
    try {
      await lock.writeFile(String(process.pid))
      await lock.sync()
      for (;;) {
        try { await link(claimPath, lockPath); acquired = true; break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''))
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0) }
            catch (probe) {
              if ((probe as NodeJS.ErrnoException).code === 'ESRCH'
                && Number(await readFile(lockPath, 'utf8').catch(() => '')) === pid) {
                await rm(lockPath, { force: true }); continue
              }
            }
          }
          if (Date.now() >= deadline) throw new Error('context execution lock unavailable')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      const current = await this.read(next.executionId)
      if (current?.revision !== expectedRevision || next.revision !== (expectedRevision ?? -1) + 1) {
        throw new Error('context execution CAS conflict')
      }
      if (current !== undefined && (current.specDigest !== next.specDigest || current.evolutionId !== next.evolutionId
        || current.deadlineAt !== next.deadlineAt || current.attempt !== next.attempt
        || current.roundId !== next.roundId || current.candidateId !== next.candidateId
        || (current.status === 'stopped' || current.status === 'completed') && next.status !== current.status)) {
        throw new Error('context execution identity or terminal status changed')
      }
      if (current !== undefined) {
        const switched = current.activeSessionId !== next.activeSessionId
        if (switched ? current.status !== 'rotating' || next.generation !== current.generation + 1
          || next.intent?.phase !== 'activated' || next.activeSessionId !== current.intent?.successorSessionId
          || next.intent.source.sourceSessionId !== current.activeSessionId || next.intent.bundleDigest === undefined
          : next.generation !== current.generation) throw new Error('invalid context ownership transition')
      }
      if (Object.values(next.usage).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid context usage accounting')
      await atomicWrite(path, next)
    } finally {
      await lock.close()
      if (acquired) await rm(lockPath, { force: true })
      await rm(claimPath, { force: true })
    }
  }

  async writeBundle(bundle: HandoffBundle): Promise<string> {
    this.validateBundle(bundle)
    const digest = digestJson(bundle)
    const path = join(this.root, 'handoffs', `${safeId(digest.replace('sha256:', ''))}.json`)
    const existing = await read<HandoffBundle>(path)
    if (existing !== undefined) {
      if (digestJson(existing) !== digest) throw new Error('handoff artifact digest mismatch')
    } else await atomicWrite(path, bundle)
    return digest
  }

  async writeOutput(executionId: string, content: unknown): Promise<string> {
    const digest = digestJson(content).slice(7)
    await atomicWrite(join(this.root, 'outputs', safeId(executionId), `${digest}.json`), content)
    return `output:${digest}`
  }

  async readOutput(executionId: string, ref: string): Promise<unknown> {
    if (!/^output:[a-f0-9]{64}$/u.test(ref)) throw new Error('invalid context output ref')
    const content = await read<unknown>(join(this.root, 'outputs', safeId(executionId), `${ref.slice(7)}.json`))
    if (content === undefined || digestJson(content).slice(7) !== ref.slice(7)) throw new Error('context output is unavailable to this owner')
    return content
  }

  async listOutputs(executionId: string): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'outputs', safeId(executionId))))
        .filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).sort().map(file => `output:${file.slice(0, -5)}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }

  async readBundle(digest: string): Promise<HandoffBundle> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid handoff digest')
    const bundle = await read<HandoffBundle>(join(this.root, 'handoffs', `${digest.slice(7)}.json`))
    if (bundle === undefined || digestJson(bundle) !== digest) throw new Error('handoff artifact digest mismatch')
    this.validateBundle(bundle)
    return bundle
  }

  async findBundle(executionId: string, successorSessionId: string): Promise<string | undefined> {
    let files: string[]
    try { files = await readdir(join(this.root, 'handoffs')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file))) {
      const ref = `sha256:${file.slice(0, -5)}`
      const bundle = await this.readBundle(ref)
      if (bundle.manifest.executionId === executionId && bundle.manifest.successorSessionId === successorSessionId) return ref
    }
    return undefined
  }

  private validateBundle(bundle: HandoffBundle): void {
    if (bundle.manifest.schemaVersion !== 1 || bundle.manifest.stateDigest !== digestJson(bundle.state)
      || bundle.manifest.summaryDigest !== digestJson(bundle.summary) || !bundle.summary.trim()) {
      throw new Error('invalid handoff manifest')
    }
  }
}
