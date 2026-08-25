import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { DshMetaAgentSpec, MetaAttribution, ProposalEvidenceAudit, RefinementRound } from '../types.js'
import type { RefineStateStore } from '../state/store.js'

export interface MetaAgentHost {
  getLive(sessionId: string): Agent | undefined
  resume(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle>
  create(sessionId: string, spec: DshMetaAgentSpec): Promise<AgentHandle>
}

export interface MetaSessionOptions {
  evolutionId: string
  specDigest: string
  metaAgent: DshMetaAgentSpec
}

interface RoundWake {
  sessionId: string
  firstObservedSeq: number
}

interface RoundEvidenceAccess {
  baselineEvalId: string
  summaryAccessed: boolean
  accessedRefs: Set<string>
  diagnosedRunRefs: Set<string>
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

  private installSampling(agentCtx: Context, spec: DshMetaAgentSpec): void {
    const { temperature } = spec.sampling
    if (temperature === undefined) return
    agentCtx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature }))
  }
}

export class MetaSessionManager {
  private handle: AgentHandle | undefined
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
        return this.handle.agent
      } catch (error) {
        if (!cannotResumePersistedSession(error)) throw error
      }
    }
    const sessionId = crypto.randomUUID()
    this.handle = await this.host.create(sessionId, this.options.metaAgent)
    await this.store.writeMeta({
      evolutionId: this.options.evolutionId,
      sessionId,
      metaHarnessRef: this.options.metaAgent.preset.id,
      specDigest: this.options.specDigest,
    })
    return this.handle.agent
  }

  async wake(round: Readonly<RefinementRound>): Promise<string> {
    if (round.evolutionId !== this.options.evolutionId) {
      throw new Error(`Meta session for evolution ${this.options.evolutionId} cannot wake round from ${round.evolutionId}`)
    }
    const agent = await this.agent()
    this.wakes.set(round.roundId, { sessionId: String(agent.id), firstObservedSeq: agent.session.seq })
    const baselineRefs = [
      ...(round.baseline === undefined ? [] : [round.baseline.evalId]),
      ...(round.baseline?.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]) ?? []),
    ]
    this.evidenceAccess.set(round.roundId, {
      baselineEvalId: round.baseline?.evalId ?? '',
      summaryAccessed: round.baseline !== undefined,
      accessedRefs: new Set(baselineRefs),
      diagnosedRunRefs: new Set(),
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        kind: 'refinement-round',
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        targetHarnessRef: round.targetHarnessRef,
        targetHarnessDigest: round.targetHarnessDigest,
        candidateWorkspace: round.candidatePool.find(candidate => candidate.status === 'generating')?.workspaceId === undefined ? undefined : {
          workspaceId: round.candidatePool.find(candidate => candidate.status === 'generating')!.workspaceId,
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
        baseline: round.baseline === undefined ? undefined : {
          evalId: round.baseline.evalId,
          primaryReward: round.baseline.primaryReward,
          summary: round.baseline.summary,
          trials: round.baseline.trials.map(trial => ({
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
    return String(agent.id)
  }

  activeRoundId(sessionId: string): string | undefined {
    return [...this.wakes].findLast(([, wake]) => wake.sessionId === sessionId)?.[0]
  }

  recordEvidenceAccess(
    roundId: string,
    sessionId: string,
    access: { summary?: boolean; refs?: readonly string[]; diagnosedRunRefs?: readonly string[] },
  ): void {
    const wake = this.wakes.get(roundId)
    const current = this.evidenceAccess.get(roundId)
    if (wake === undefined || current === undefined || wake.sessionId !== sessionId) {
      return
    }
    if (access.summary === true) current.summaryAccessed = true
    for (const ref of access.refs ?? []) current.accessedRefs.add(ref)
    for (const ref of access.diagnosedRunRefs ?? []) current.diagnosedRunRefs.add(ref)
  }

  proposalEvidenceAudit(roundId: string, sessionId: string, citedRefs: readonly string[]): ProposalEvidenceAudit {
    const wake = this.wakes.get(roundId)
    const access = this.evidenceAccess.get(roundId)
    if (wake === undefined || access === undefined || wake.sessionId !== sessionId) {
      throw new Error('proposal evidence did not originate from the active round meta session')
    }
    return {
      evolutionId: this.options.evolutionId,
      roundId,
      baselineEvalId: access.baselineEvalId,
      summaryAccessed: access.summaryAccessed,
      accessedRefs: [...access.accessedRefs].sort(),
      diagnosedRunRefs: [...access.diagnosedRunRefs].sort(),
      citedRefs: [...citedRefs],
    }
  }

  proposalAttribution(roundId: string, agent: Agent, _mutation: unknown): MetaAttribution {
    const wake = this.wakes.get(roundId)
    if (wake === undefined || wake.sessionId !== String(agent.id)) throw new Error('proposal did not originate from the round meta session')
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
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined ? {} : { sampling: { temperature: config.temperature } }),
    }
  }

  async dispose(): Promise<void> {
    await this.handle?.dispose()
    this.handle = undefined
    this.wakes.clear()
    this.evidenceAccess.clear()
  }
}
