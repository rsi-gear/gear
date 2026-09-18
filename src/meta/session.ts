import { consumptionReceipt } from '../search/diagnosis.js'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {
  CandidateRecord, DiagnosisReceipt, DshMetaAgentSpec, EvaluationEvidence, MetaAttribution, MetaCheckpointRef,
  MetaTurnObservation, ProposalEvidenceAudit, RefinementRound,
} from '../types.js'
import type { RefineStateStore } from '../state/store.js'
import { digestJson } from '../state/digest.js'
import type { MetaAgentSession, MetaSessionController, MetaExecutionBinding } from './controller.js'
import { validateMetaSampling } from './sampling.js'
import { DshOffloadingHost, type MetaOffloadingHost } from './offloading-host.js'
import { DshContextExecution } from './offloading-execution.js'
import { MetaOffloadingStore } from './offloading-store.js'
import { MetaContextError } from './offloading-policy.js'
import { generationBudgetSnapshot } from '../refine/generation-budget.js'
import { DshGenerationExecution, type MetaGenerationBudgetHost } from './generation-execution.js'

export interface MetaAgentHost {
  generationBudget?: MetaGenerationBudgetHost
  /** Positive proof that the owned session is absent from both live and durable state. */
  isSessionAbsent?(sessionId: string): Promise<boolean>
  offloading?: MetaOffloadingHost
  retire?(sessionId: string): Promise<void>
  quiesce?(sessionId: string): Promise<void>
  events?(checkpoint: MetaCheckpointRef): Promise<readonly SessionEvent[]>
  prepareFresh?(sessionId: string, spec: DshMetaAgentSpec, candidate: boolean): Promise<AgentHandle>
  getLive(sessionId: string): Agent | undefined
  resume(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle>
  create(sessionId: string, spec: DshMetaAgentSpec, candidate?: boolean): Promise<AgentHandle>
  checkpoint(agent: Agent): Promise<MetaCheckpointRef>
  fork(sessionId: string, spec: DshMetaAgentSpec, checkpoint: MetaCheckpointRef): Promise<AgentHandle>
  cancelAndFlush(agent: Agent, reason: string): Promise<void>
}

export interface MetaSessionOptions {
  evolutionId: string
  specDigest: string
  metaAgent: DshMetaAgentSpec
}

interface RoundWake {
  roundId: string
  candidateId?: string
  sessionId: string
  firstObservedSeq: number
}

interface RoundEvidenceAccess {
  baselineEvalId: string
  summaryAccessed: boolean
  accessedRefs: Set<string>
  diagnosedRunRefs: Set<string>
  diagnosisReceipts: Map<string, DiagnosisReceipt>
}

function reward(rewards: Record<string, number>): number | undefined {
  return rewards.reward ?? Object.values(rewards)[0]
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function cannotResumePersistedSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:not found|unknown session|does not exist|missing|unknown to this harness|not marked ignorable)/iu.test(message)
}

function observeTurn(events: readonly SessionEvent[], firstObservedSeq: number): MetaTurnObservation {
  const owned = events.filter(event => event.seq >= firstObservedSeq)
  const end = owned.findLast(event => event.type === 'turn/end')
  if (end === undefined || end.type !== 'turn/end') return { reason: 'missing-turn-end' }
  const turn = end.data.turn
  const start = owned.find(event => event.type === 'turn/start' && event.data.turn === turn)
  const assistant = owned.findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
  const header = owned.findLast(event => event.type === 'request/header')
  const effectiveMaxTokens = header?.type === 'request/header' && typeof header.data.header.config.maxTokens === 'number'
    ? header.data.header.config.maxTokens
    : undefined
  return {
    reason: end.data.reason?.kind ?? 'unknown',
    ...(end.data.reason?.kind === 'error' ? { error: {
      message: end.data.reason.error.message,
      ...(end.data.reason.error.code === undefined ? {} : { code: String(end.data.reason.error.code) }),
    } } : {}),
    turn,
    ...(start === undefined ? {} : { durationMs: Math.max(0, end.time - start.time) }),
    ...(effectiveMaxTokens === undefined ? {} : { effectiveMaxTokens }),
    ...(assistant?.type !== 'assistant/message' || assistant.data.usage === undefined
      ? {}
      : { usage: { ...assistant.data.usage } }),
  }
}

export class DshMetaAgentHost implements MetaAgentHost {
  readonly offloading: MetaOffloadingHost
  readonly generationBudget: MetaGenerationBudgetHost
  private readonly permitted = new Set<string>()
  private readonly quiesced = new Set<string>()
  constructor(
    private readonly ctx: Context,
    private readonly setupMetaCapabilities: (agentCtx: Context, sessionId: string) => void | Promise<void>,
    private readonly retireRuntime?: (sessionId: string) => Promise<void>,
  ) {
    this.offloading = new DshOffloadingHost(ctx, this.permitted)
    this.generationBudget = { pressure: (...args) => this.offloading.pressure(...args), flush: agent => this.offloading.flush(agent),
      permit: agent => { this.permitted.add(String(agent.id)) }, revoke: id => { this.permitted.delete(id) } }
  }

  async isSessionAbsent(sessionId: string): Promise<boolean> {
    if (this.getLive(sessionId)) return false
    const persistence = this.ctx.get('sessionPersistence')
    return persistence !== undefined && !(await persistence.list()).some(header => String(header.id) === sessionId)
  }

  async quiesce(sessionId: string): Promise<void> {
    if (this.quiesced.has(sessionId)) return
    await this.retireRuntime?.(sessionId)
    this.quiesced.add(sessionId)
  }
  async retire(sessionId: string): Promise<void> {
    this.permitted.delete(sessionId)
    await this.offloading.retire?.(sessionId)
    await this.quiesce(sessionId)
    this.quiesced.delete(sessionId)
  }

  async prepareFresh(sessionId: string, spec: DshMetaAgentSpec, candidate: boolean): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined && (await persistence.list()).some(header => String(header.id) === sessionId)) {
      const handle = await this.resume(sessionId, spec)
      if (handle.agent.session.events.some(event => event.type === 'tool/call' || event.type === 'step/start')) {
        await handle.dispose()
        throw new Error('prepared successor already performed work')
      }
      return handle
    }
    return this.create(sessionId, spec, candidate)
  }

  async events(checkpoint: MetaCheckpointRef): Promise<readonly SessionEvent[]> {
    const live = this.getLive(checkpoint.sourceSessionId)
    const events = live?.session.events
      ?? (await this.ctx.sessionPersistence.inspect(SessionId(checkpoint.sourceSessionId))).events
    const prefix = structuredClone(events.slice(0, checkpoint.eventCount))
    if (prefix.length !== checkpoint.eventCount || digestJson(prefix) !== checkpoint.prefixDigest) throw new Error('Meta checkpoint prefix identity mismatch')
    return prefix
  }

  getLive(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  resume(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle> {
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: spec.model,
      setup: agentCtx => this.setupAgent(agentCtx, sessionId, spec),
    })
  }

  create(sessionId: string, spec: DshMetaAgentSpec, candidate = false): Promise<AgentHandle> {
    return this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: spec.model,
      meta: { agentPreset: spec.preset.id, ...(candidate ? { cwd: '/candidate/harness' } : {}) },
      setup: agentCtx => this.setupAgent(agentCtx, sessionId, spec),
    })
  }

  async checkpoint(agent: Agent): Promise<MetaCheckpointRef> {
    await agent.whenIdle()
    return agent.runMaintenance(async () => {
      const participated = await this.ctx.sessions.flush(agent.session)
      if (!participated) throw new Error('durable Meta session persistence is required for candidate forks')
      const prefix = structuredClone([...agent.session.events])
      return {
        sourceSessionId: String(agent.id),
        eventCount: prefix.length,
        prefixDigest: digestJson(prefix),
      }
    })
  }

  async fork(sessionId: string, spec: DshMetaAgentSpec, checkpoint: MetaCheckpointRef): Promise<AgentHandle> {
    const prefix = await this.events(checkpoint)
    return this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      seed: prefix,
      agentOptions: spec.model,
      meta: {
        parentSession: SessionId(checkpoint.sourceSessionId),
        seedLength: checkpoint.eventCount,
        // Candidate tools expose a stable virtual filesystem identity. Giving
        // the fork that cwd also makes DSH's ordinary bash/search defaulting
        // resolve inside the candidate instead of the control-plane workspace.
        cwd: '/candidate/harness',
        agentPreset: spec.preset.id,
      },
      setup: agentCtx => this.setupAgent(agentCtx, sessionId, spec),
    })
  }

  async cancelAndFlush(agent: Agent, reason: string): Promise<void> {
    this.permitted.delete(String(agent.id))
    agent.cancel({ kind: 'hook', reason })
    await agent.whenIdle()
    const participated = await this.ctx.sessions.flush(agent.session)
    if (!participated) throw new Error('durable Meta session persistence is required before cleanup')
  }

  private async setupAgent(agentCtx: Context, sessionId: string, spec: DshMetaAgentSpec): Promise<void> {
    validateMetaSampling(spec.sampling)
    await this.ctx.agentPresets.mount(agentCtx, spec.preset.id)
    await this.setupMetaCapabilities(agentCtx, sessionId)
    {
      agentCtx.on('tools/pre-execute', async (exec, next) => {
        if (exec.agent === undefined || !this.permitted.has(String(exec.agent.id))) throw new Error('Meta session has no active execution permission')
        return next()
      }, { prepend: true })
      agentCtx.on('agent/pre-step', async (payload, next) => {
        if (this.permitted.has(String(payload.agent.id))) return next()
        // Preset startup/resume hooks may wake a staged agent. Park claimed input
        // durably until the logical controller has installed ownership checks.
        payload.agent.cancel({ kind: 'hook', reason: 'Meta execution activation pending' }, { keepInbox: true })
        const ids = new Set([...payload.agent.inbox.nextStep, ...payload.agent.inbox.nextTurn].map(message => message.id))
        for (const message of payload.messages) if (!ids.has(message.id)) payload.agent.inject(message)
        return { kind: 'reject' }
      }, { prepend: true })
    }
    const { temperature, reasoningEffort } = spec.sampling
    if (temperature === undefined && reasoningEffort === undefined && spec.contextOffloading === undefined) return
    // Run outside preset/model-selection hooks: those can otherwise clear or
    // replace effort after next(). Resumed/forked headers must use the sealed
    // explicit sampling, while omitted fields retain provider defaults.
    agentCtx.on('agent/request', async (_payload, next) => ({
      ...await next(),
      ...(temperature === undefined ? {} : { temperature }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
      ...(spec.contextOffloading === undefined || spec.model.maxTokens !== undefined
        ? {} : { maxTokens: spec.contextOffloading.reserveTokens }),
    }), { prepend: true })
  }
}

export class MetaSessionManager implements MetaSessionController {
  private handle: AgentHandle | undefined
  private readonly handles = new Map<string, AgentHandle>()
  private readonly wakes = new Map<string, RoundWake>()
  private readonly evidenceAccess = new Map<string, RoundEvidenceAccess>()
  private readonly workplanDeliveries = new Map<string, NonNullable<CandidateRecord['workplanDelivery']>>()
  private readonly executions = new Map<string, DshContextExecution | DshGenerationExecution>()

  get capabilities() {
    return { aggregateGenerationBudget: this.host.generationBudget !== undefined
      || this.options.metaAgent.contextOffloading !== undefined && this.host.offloading !== undefined }
  }

  constructor(
    private readonly store: RefineStateStore,
    private readonly host: MetaAgentHost,
    readonly options: MetaSessionOptions,
  ) {}

  async agent(): Promise<Agent> {
    if (this.handle !== undefined) return this.handle.agent
    const state = await this.store.readMeta()
    if (state?.evolutionId === this.options.evolutionId
      && state.specDigest === this.options.specDigest
      && state.metaHarnessRef === this.options.metaAgent.preset.id) {
      const live = this.host.getLive(state.sessionId)
      if (live !== undefined) return live
      try {
        this.handle = await this.host.resume(state.sessionId, this.options.metaAgent)
        this.handles.set(state.sessionId, this.handle)
        return this.handle.agent
      } catch (error) {
        if (!cannotResumePersistedSession(error)) throw error
      }
    }
    const sessionId = crypto.randomUUID()
    this.handle = await this.host.create(sessionId, this.options.metaAgent)
    this.handles.set(sessionId, this.handle)
    await this.store.writeMeta({
      evolutionId: this.options.evolutionId,
      sessionId,
      metaHarnessRef: this.options.metaAgent.preset.id,
      specDigest: this.options.specDigest,
    })
    return this.handle.agent
  }

  async checkpoint(sessionId?: string): Promise<MetaCheckpointRef> {
    const agent = sessionId === undefined ? await this.agent() : await this.ensureAgent(sessionId)
    const checkpoint = await this.host.checkpoint(agent)
    const state = await this.store.readMeta()
    if (state?.sessionId === String(agent.id)) await this.store.writeMeta({ ...state, checkpoint })
    return checkpoint
  }

  async fork(checkpoint: MetaCheckpointRef): Promise<Agent> {
    if (this.host.events === undefined) await this.ensureAgent(checkpoint.sourceSessionId)
    const sessionId = crypto.randomUUID()
    const handle = await this.host.fork(sessionId, this.options.metaAgent, checkpoint)
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  async restore(sessionId: string, executionId?: string): Promise<Agent> {
    if (executionId !== undefined) {
      const journal = new MetaOffloadingStore(this.store.root)
      const state = await journal.read(executionId)
      if (state === undefined || state.activeSessionId !== sessionId
        || state.evolutionId !== this.options.evolutionId || state.specDigest !== this.options.specDigest) {
        throw new MetaContextError('context-handoff-failed', 'restore execution owner or sealed identity mismatch')
      }
      if (state.status === 'running' && state.intent?.phase === 'activated') {
        // DSH materializes a session only on its first append. The owner CAS can
        // be durable while its empty successor is still absent from persistence.
        const ref = state.intent.bundleDigest
        if (ref === undefined || !state.handoffs.includes(ref)) {
          throw new MetaContextError('context-handoff-failed', 'activated restore has no committed handoff bundle')
        }
        const bundle = await journal.readBundle(ref)
        if (bundle.manifest.executionId !== executionId || bundle.manifest.evolutionId !== this.options.evolutionId
          || bundle.manifest.specDigest !== this.options.specDigest || bundle.manifest.generation !== state.generation
          || bundle.manifest.successorSessionId !== sessionId || state.intent.successorSessionId !== sessionId) {
          throw new MetaContextError('context-handoff-failed', 'activated restore handoff identity mismatch')
        }
        if (this.host.prepareFresh !== undefined) {
          const handle = await this.host.prepareFresh(sessionId, this.options.metaAgent, state.candidateId !== undefined)
          this.handles.set(sessionId, handle)
          return handle.agent
        }
      }
    }
    return this.ensureAgent(sessionId)
  }

  async cancelAndDispose(sessionId: string, reason: string): Promise<void> {
    await this.cancel(sessionId, reason)
    await this.release(sessionId)
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const execution = this.executions.get(sessionId)
    execution?.stop(reason)
    const ownedId = execution?.activeSessionId ?? sessionId
    let agent: Agent
    try { agent = await this.ensureAgent(ownedId) }
    catch (error) {
      if (await this.host.isSessionAbsent?.(ownedId) !== true) throw error
      await this.host.retire?.(ownedId)
      return
    }
    await this.host.cancelAndFlush(agent, reason)
  }

  async release(sessionId: string): Promise<void> {
    const execution = this.executions.get(sessionId)
    if (execution !== undefined) {
      for (const [id, owner] of this.executions) if (owner === execution) {
        this.executions.delete(id)
        await this.releasePhysical(id)
      }
      return
    }
    await this.releasePhysical(sessionId)
  }

  private async releasePhysical(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    this.wakes.delete(sessionId)
    this.evidenceAccess.delete(sessionId)
    if (handle === undefined || handle === this.handle) return
    this.handles.delete(sessionId)
    await handle.dispose()
    await this.host.retire?.(sessionId)
  }

  async wake(round: Readonly<RefinementRound>): Promise<string> {
    if (this.options.metaAgent.contextOffloading !== undefined) {
      const root = await this.agent()
      const handle = await this.wakeCandidate(round, undefined, round.baseline, root, {
        executionId: crypto.randomUUID(), attempt: 0, deadlineAt: Date.now() + round.taskBudgetMs,
        signal: AbortSignal.timeout(round.taskBudgetMs), budget: {}, isComplete: () => false,
        snapshot: async () => ({ owner: 'root', evolutionId: this.options.evolutionId, specDigest: this.options.specDigest }),
        activate: async (sourceId, nextId) => {
          const current = await this.store.readMeta()
          if (current?.sessionId !== sourceId) throw new Error('root Meta context owner changed')
          const { checkpoint: _checkpoint, ...identity } = current
          await this.store.writeMeta({ ...identity, sessionId: nextId })
          this.handle = this.handles.get(nextId)
        },
      })
      void handle.completion?.catch(() => {})
      return handle.sessionId
    }
    const candidate = round.candidatePool.find(value => value.status === 'generating')
    return (await this.wakeCandidate(round, candidate, round.baseline, await this.agent())).sessionId
  }

  async wakeCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<CandidateRecord> | undefined,
    baseline: EvaluationEvidence | undefined,
    agent: MetaAgentSession,
    execution?: MetaExecutionBinding,
  ): Promise<import('./controller.js').MetaWakeHandle> {
    if ((execution?.budget.maxTokens !== undefined || execution?.budget.maxModelRequests !== undefined)
      && !this.capabilities.aggregateGenerationBudget) throw new Error('Meta adapter cannot enforce aggregate generation budgets')
    if (round.evolutionId !== this.options.evolutionId) {
      throw new Error(`Meta session for evolution ${this.options.evolutionId} cannot wake round from ${round.evolutionId}`)
    }
    const sessionId = String(agent.id)
    const dshAgent = this.requireDshAgent(agent)
    const firstObservedSeq = dshAgent.session.seq
    this.wakes.set(sessionId, {
      roundId: round.roundId,
      ...(candidate === undefined ? {} : { candidateId: candidate.candidateId }),
      sessionId,
      firstObservedSeq,
    })
    const baselineRefs = [
      ...(candidate?.workplanDelivery?.workplan.requiredDiagnosisRefs ?? []),
      ...(baseline === undefined ? [] : [baseline.evalId]),
      ...(baseline?.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]) ?? []),
    ]
    this.evidenceAccess.set(sessionId, {
      baselineEvalId: baseline?.evalId ?? '',
      summaryAccessed: baseline !== undefined,
      accessedRefs: new Set(baselineRefs),
      diagnosedRunRefs: new Set(),
      diagnosisReceipts: new Map(),
    })
    if (candidate?.workplanDelivery) this.workplanDeliveries.set(sessionId, candidate.workplanDelivery)
    const envelope = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        kind: 'refinement-round',
        ...(candidate?.workplanDelivery ? { workplanDelivery: candidate.workplanDelivery } : {}),
        ...(execution?.generationBudget === undefined ? {} : { generationBudget: generationBudgetSnapshot(execution.generationBudget) }),
        ...(execution !== undefined && execution.attempt > 1 ? {
          retryRecovery: { workspace: 'fresh', diagnosis: 'query-current-baseline' },
        } : {}),
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        candidateId: candidate?.candidateId,
        targetHarnessRef: candidate?.parentHarnessRef ?? round.targetHarnessRef,
        candidateWorkspace: candidate?.workspaceId === undefined ? undefined : {
          workspaceId: candidate.workspaceId,
          virtualRoot: '/candidate',
          editableRoot: '/candidate/harness',
          mode: 'git-native',
        },
        evidencePolicy: {
          currentRoundOnly: true,
          citeObservedSeedRefs: true,
          diagnoseEveryFailedRunBeforeProposal: candidate?.workplanDelivery === undefined,
          heldOutUnavailable: true,
        },
        baseline: baseline === undefined ? undefined : {
          evalId: baseline.evalId,
          primaryReward: baseline.primaryReward,
          ...(baseline.processScore === undefined ? {} : { processScore: baseline.processScore }),
          summary: baseline.summary,
          trials: baseline.trials.map(trial => ({
            taskName: trial.taskName,
            trialName: trial.trialName,
            runId: trial.runId,
            attempt: trial.attempt,
            status: trial.status,
            reward: reward(trial.rewards),
            ...(trial.scores === undefined ? {} : { scores: trial.scores }),
          })),
        },
        advisoryFocus: round.advisoryFocus,
        batch: { id: round.batchId, index: round.roundIndex, count: round.roundCount },
      }) }],
      source: { kind: 'plugin', plugin: 'gear' },
    })
    if (this.options.metaAgent.contextOffloading !== undefined) {
      if (this.host.offloading === undefined) throw new Error('DSH host does not implement context offloading')
      if (execution === undefined) throw new Error('context offloading requires a logical execution and deadline')
      const offloader = new DshContextExecution(
        new MetaOffloadingStore(this.store.root), this.host.offloading, {
          fresh: async successorId => {
            const handle = this.handles.get(successorId) ?? await (this.host.prepareFresh === undefined
              ? this.host.create(successorId, this.options.metaAgent, candidate !== undefined)
              : this.host.prepareFresh(successorId, this.options.metaAgent, candidate !== undefined))
            this.handles.set(successorId, handle)
            return handle.agent
          },
          checkpoint: agent => this.host.checkpoint(agent),
          quiesce: id => this.host.quiesce?.(id) ?? Promise.resolve(),
          events: async checkpoint => {
            if (this.host.events !== undefined) return this.host.events(checkpoint)
            const source = await this.ensureAgent(checkpoint.sourceSessionId)
            const events = structuredClone([...source.session.events].slice(0, checkpoint.eventCount))
            if (events.length !== checkpoint.eventCount || digestJson(events) !== checkpoint.prefixDigest) throw new Error('handoff source checkpoint mismatch')
            return events
          },
          evidence: id => this.proposalEvidenceAudit(round.roundId, id, []),
          activate: (sourceId, successor, audit) => {
            const nextId = String(successor.id)
            this.wakes.set(nextId, { ...this.wakes.get(sourceId)!, sessionId: nextId, firstObservedSeq: successor.session.seq })
            this.evidenceAccess.set(nextId, {
              baselineEvalId: audit.baselineEvalId, summaryAccessed: audit.summaryAccessed,
              accessedRefs: new Set(audit.accessedRefs), diagnosedRunRefs: new Set(audit.diagnosedRunRefs),
              diagnosisReceipts: new Map((audit.diagnosisReceipts ?? []).map(receipt => [receipt.runId, structuredClone(receipt)])),
            })
            if (audit.workplanDelivery) this.workplanDeliveries.set(nextId, audit.workplanDelivery)
            if (sourceId !== nextId) {
              this.wakes.delete(sourceId)
              this.evidenceAccess.delete(sourceId)
              this.workplanDeliveries.delete(sourceId)
            }
            this.executions.set(nextId, offloader)
          },
          release: id => this.releasePhysical(id),
          observe: (agent, seq) => observeTurn([...agent.session.events], seq),
        }, this.options.metaAgent, this.options.specDigest, this.options.evolutionId, round.roundId,
        candidate?.candidateId, execution,
      )
      this.executions.set(sessionId, offloader)
      return { sessionId, completion: offloader.run(dshAgent, envelope, firstObservedSeq) }
    }
    if (execution && (execution.budget.maxTokens !== undefined || execution.budget.maxModelRequests !== undefined)) {
      if (!this.host.generationBudget) throw new Error('DSH host does not implement generation metering')
      const bounded = new DshGenerationExecution(new MetaOffloadingStore(this.store.root), this.host.generationBudget,
        { evolutionId: round.evolutionId, specDigest: this.options.specDigest, roundId: round.roundId,
          ...(candidate ? { candidateId: candidate.candidateId } : {}) }, execution)
      this.executions.set(sessionId, bounded)
      return { sessionId, completion: bounded.run(dshAgent, envelope, firstObservedSeq, () => observeTurn([...dshAgent.session.events], firstObservedSeq)) }
    }
    this.host.generationBudget?.permit(dshAgent)
    dshAgent.followup(envelope)
    return {
      sessionId,
      completion: dshAgent.whenIdle().then(() => observeTurn([...dshAgent.session.events], firstObservedSeq))
        .finally(() => this.host.generationBudget?.revoke(sessionId)),
    }
  }

  activeRoundId(sessionId: string): string | undefined {
    return this.wakes.get(sessionId)?.roundId
  }

  recordEvidenceAccess(
    roundId: string,
    sessionId: string,
    access: {
      summary?: boolean
      refs?: readonly string[]
      diagnosedRunRefs?: readonly string[]
      diagnosisReceipts?: readonly DiagnosisReceipt[]
    },
  ): void {
    const wake = this.wakes.get(sessionId)
    const current = this.evidenceAccess.get(sessionId)
    if (wake === undefined || current === undefined || wake.roundId !== roundId) {
      return
    }
    if (access.summary === true) current.summaryAccessed = true
    for (const ref of access.refs ?? []) current.accessedRefs.add(ref)
    for (const ref of access.diagnosedRunRefs ?? []) current.diagnosedRunRefs.add(ref)
    for (const receipt of access.diagnosisReceipts ?? []) {
      current.diagnosedRunRefs.add(receipt.runId)
      current.diagnosisReceipts.set(receipt.runId, structuredClone(receipt))
    }
  }

  proposalEvidenceAudit(roundId: string, sessionId: string, citedRefs: readonly string[]): ProposalEvidenceAudit {
    const wake = this.wakes.get(sessionId)
    const access = this.evidenceAccess.get(sessionId)
    if (wake === undefined || access === undefined || wake.roundId !== roundId) {
      throw new Error('proposal evidence did not originate from the active round meta session')
    }
    return {
      ...(this.workplanDeliveries.has(sessionId) ? {
        workplanDelivery: this.workplanDeliveries.get(sessionId)!,
        workplanReceipt: consumptionReceipt(this.workplanDeliveries.get(sessionId)!, sessionId, [...access.accessedRefs]),
      } : {}),
      evolutionId: this.options.evolutionId,
      roundId,
      ...(wake.candidateId === undefined ? {} : { candidateId: wake.candidateId }),
      baselineEvalId: access.baselineEvalId,
      summaryAccessed: access.summaryAccessed,
      accessedRefs: [...access.accessedRefs].sort(),
      diagnosedRunRefs: [...access.diagnosedRunRefs].sort(),
      diagnosisReceipts: [...access.diagnosisReceipts.values()]
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .map(receipt => structuredClone(receipt)),
      citedRefs: [...citedRefs],
    }
  }

  proposalAttribution(roundId: string, session: string | MetaAgentSession, _mutation: unknown): MetaAttribution {
    const sessionId = typeof session === 'string' ? session : String(session.id)
    const agent = this.requireDshAgentById(sessionId)
    const wake = this.wakes.get(String(agent.id))
    if (wake === undefined || wake.roundId !== roundId) throw new Error('proposal did not originate from the round meta session')
    const events = [...agent.session.events]
    const headers = events.filter(event => event.type === 'request/header')
    const relevant = headers.filter(event => event.seq >= wake.firstObservedSeq)
    const execution = this.executions.get(sessionId)
    const attributionConfig = (config: (typeof headers)[number]['data']['header']['config']) =>
      execution instanceof DshGenerationExecution ? execution.attributionConfig(config) : config
    const distinct = new Set(relevant.map(event => stableJson({
      config: attributionConfig(event.data.header.config),
      system: event.data.header.system,
      tools: event.data.header.tools,
    })))
    if (distinct.size > 1) throw new Error('multiple effective request headers occurred during one proposal round')
    const effective = relevant.at(-1) ?? headers.at(-1)
    if (effective === undefined) throw new Error('proposal has no attributable request/header event')
    // The proposal crosses the typed bridge while the notebook tool call is
    // executing. Point at that existing durable event instead of appending a
    // plugin-owned session event: DSH's cold reader cannot register event types
    // declared by out-of-tree plugins yet.
    const proposal = events.findLast(event => event.type === 'tool/call' && event.seq >= wake.firstObservedSeq)
    if (proposal === undefined) throw new Error('proposal has no attributable tool/call event')
    const config = effective.data.header.config
    const original = attributionConfig(config)
    if (original.provider !== this.options.metaAgent.model.provider || original.model !== this.options.metaAgent.model.model
      || (this.options.metaAgent.model.maxTokens !== undefined && original.maxTokens !== this.options.metaAgent.model.maxTokens)
      || (this.options.metaAgent.sampling.temperature !== undefined
        && original.temperature !== this.options.metaAgent.sampling.temperature)
      || (this.options.metaAgent.sampling.reasoningEffort !== undefined
        && original.reasoningEffort !== this.options.metaAgent.sampling.reasoningEffort)) {
      throw new Error('effective Meta request config does not match immutable evolution spec')
    }
    return {
      evolutionId: this.options.evolutionId,
      sessionId: String(agent.id),
      ...(this.executions.get(sessionId) === undefined ? {} : {
        executionId: this.executions.get(sessionId)!.state.executionId,
        generation: this.executions.get(sessionId)!.state.generation,
        handoffRefs: [...this.executions.get(sessionId)!.state.handoffs],
      }),
      requestHeaderSeq: effective.seq,
      proposalEventSeq: proposal.seq,
      source: { kind: 'dsh-events', requestHeaderSeq: effective.seq, proposalEventSeq: proposal.seq },
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined && config.reasoningEffort === undefined ? {} : {
        sampling: {
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
        },
      }),
    }
  }

  private async ensureAgent(sessionId: string): Promise<Agent> {
    const owned = this.handles.get(sessionId)
    if (owned !== undefined) return owned.agent
    const live = this.host.getLive(sessionId)
    if (live !== undefined) return live
    const handle = await this.host.resume(sessionId, this.options.metaAgent)
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  private requireDshAgent(session: MetaAgentSession): Agent {
    return this.requireDshAgentById(String(session.id))
  }

  private requireDshAgentById(sessionId: string): Agent {
    const owned = this.handles.get(sessionId)?.agent
    const agent = owned ?? this.host.getLive(sessionId)
    if (agent === undefined) throw new Error('meta session is not live')
    return agent
  }

  async dispose(): Promise<void> {
    for (const execution of new Set(this.executions.values())) execution.stop('Meta session manager disposed')
    const handles = [...new Set(this.handles.values())]
    await Promise.allSettled(handles.map(async handle => {
      await handle.dispose()
      await this.host.retire?.(String(handle.agent.id))
    }))
    this.handles.clear()
    this.handle = undefined
    this.wakes.clear()
    this.evidenceAccess.clear()
    this.executions.clear()
  }
}
