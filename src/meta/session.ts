import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {
  CandidateRecord, DiagnosisReceipt, DshMetaAgentSpec, EvaluationEvidence, MetaAttribution, MetaCheckpointRef,
  MetaTurnObservation, ProposalEvidenceAudit, RefinementRound,
} from '../types.js'
import type { RefineStateStore } from '../state/store.js'
import { digestJson } from '../state/digest.js'
import type { MetaAgentSession, MetaSessionController } from './controller.js'

export interface MetaAgentHost {
  getLive(sessionId: string): Agent | undefined
  resume(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle>
  create(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle>
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
    turn,
    ...(start === undefined ? {} : { durationMs: Math.max(0, end.time - start.time) }),
    ...(effectiveMaxTokens === undefined ? {} : { effectiveMaxTokens }),
    ...(assistant?.type !== 'assistant/message' || assistant.data.usage === undefined
      ? {}
      : { usage: { ...assistant.data.usage } }),
  }
}

export class DshMetaAgentHost implements MetaAgentHost {
  constructor(
    private readonly ctx: Context,
    private readonly setupMetaCapabilities: (agentCtx: Context, sessionId: string) => void | Promise<void>,
  ) {}

  getLive(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  resume(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle> {
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: spec.model,
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, spec.preset.id)
        this.installSampling(agentCtx, spec)
        await this.setupMetaCapabilities(agentCtx, sessionId)
      },
    })
  }

  create(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle> {
    return this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: spec.model,
      meta: { agentPreset: spec.preset.id },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, spec.preset.id)
        this.installSampling(agentCtx, spec)
        await this.setupMetaCapabilities(agentCtx, sessionId)
      },
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

  fork(sessionId: string, spec: DshMetaAgentSpec, checkpoint: MetaCheckpointRef): Promise<AgentHandle> {
    const source = this.getLive(checkpoint.sourceSessionId)
    if (source === undefined) throw new Error(`Meta checkpoint source is not live: ${checkpoint.sourceSessionId}`)
    const prefix = structuredClone([...source.session.events].slice(0, checkpoint.eventCount))
    if (prefix.length !== checkpoint.eventCount || digestJson(prefix) !== checkpoint.prefixDigest) {
      throw new Error('Meta checkpoint prefix identity mismatch')
    }
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
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, spec.preset.id)
        this.installSampling(agentCtx, spec)
        await this.setupMetaCapabilities(agentCtx, sessionId)
      },
    })
  }

  async cancelAndFlush(agent: Agent, reason: string): Promise<void> {
    agent.cancel({ kind: 'hook', reason })
    await agent.whenIdle()
    const participated = await this.ctx.sessions.flush(agent.session)
    if (!participated) throw new Error('durable Meta session persistence is required before cleanup')
  }

  private installSampling(agentCtx: Context, spec: DshMetaAgentSpec): void {
    const { temperature } = spec.sampling
    if (temperature === undefined) return
    agentCtx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature }))
  }
}

export class MetaSessionManager implements MetaSessionController {
  private handle: AgentHandle | undefined
  private readonly handles = new Map<string, AgentHandle>()
  private readonly wakes = new Map<string, RoundWake>()
  private readonly evidenceAccess = new Map<string, RoundEvidenceAccess>()

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
    await this.ensureAgent(checkpoint.sourceSessionId)
    const sessionId = crypto.randomUUID()
    const handle = await this.host.fork(sessionId, this.options.metaAgent, checkpoint)
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  async cancelAndDispose(sessionId: string, reason: string): Promise<void> {
    await this.cancel(sessionId, reason)
    await this.release(sessionId)
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const agent = await this.ensureAgent(sessionId)
    await this.host.cancelAndFlush(agent, reason)
  }

  async release(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    this.wakes.delete(sessionId)
    this.evidenceAccess.delete(sessionId)
    if (handle === undefined || handle === this.handle) return
    this.handles.delete(sessionId)
    await handle.dispose()
  }

  async wake(round: Readonly<RefinementRound>): Promise<string> {
    const candidate = round.candidatePool.find(value => value.status === 'generating')
    return (await this.wakeCandidate(round, candidate, round.baseline, await this.agent())).sessionId
  }

  async wakeCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<CandidateRecord> | undefined,
    baseline: EvaluationEvidence | undefined,
    agent: MetaAgentSession,
  ): Promise<import('./controller.js').MetaWakeHandle> {
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
    dshAgent.followup(createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        kind: 'refinement-round',
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
          diagnoseEveryFailedRunBeforeProposal: true,
          heldOutUnavailable: true,
        },
        baseline: baseline === undefined ? undefined : {
          evalId: baseline.evalId,
          primaryReward: baseline.primaryReward,
          summary: baseline.summary,
          trials: baseline.trials.map(trial => ({
            taskName: trial.taskName,
            trialName: trial.trialName,
            runId: trial.runId,
            attempt: trial.attempt,
            status: trial.status,
            reward: reward(trial.rewards),
          })),
        },
        advisoryFocus: round.advisoryFocus,
        batch: { id: round.batchId, index: round.roundIndex, count: round.roundCount },
      }) }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-refine' },
    }))
    return {
      sessionId,
      completion: dshAgent.whenIdle().then(() => observeTurn([...dshAgent.session.events], firstObservedSeq)),
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
    const distinct = new Set(relevant.map(event => stableJson({
      config: event.data.header.config,
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
    if (config.provider !== this.options.metaAgent.model.provider || config.model !== this.options.metaAgent.model.model
      || (this.options.metaAgent.model.maxTokens !== undefined && config.maxTokens !== this.options.metaAgent.model.maxTokens)
      || (this.options.metaAgent.sampling.temperature !== undefined
        && config.temperature !== this.options.metaAgent.sampling.temperature)) {
      throw new Error('effective Meta request config does not match immutable evolution spec')
    }
    return {
      evolutionId: this.options.evolutionId,
      sessionId: String(agent.id),
      requestHeaderSeq: effective.seq,
      proposalEventSeq: proposal.seq,
      source: { kind: 'dsh-events', requestHeaderSeq: effective.seq, proposalEventSeq: proposal.seq },
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined ? {} : { sampling: { temperature: config.temperature } }),
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
    const handles = [...new Set(this.handles.values())]
    await Promise.allSettled(handles.map(handle => handle.dispose()))
    this.handles.clear()
    this.handle = undefined
    this.wakes.clear()
    this.evidenceAccess.clear()
  }
}
