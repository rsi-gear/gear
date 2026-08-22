import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { MetaAttribution, MetaHarnessRef, ProposalEvidenceAudit, RefinementRound } from '../types.js'
import type { RefineStateStore } from '../state/store.js'

export interface MetaAgentHost {
  getLive(sessionId: string): Agent | undefined
  resume(sessionId: string): Promise<AgentHandle>
  create(sessionId: string): Promise<AgentHandle>
}

export interface MetaSessionOptions {
  metaHarnessRef: MetaHarnessRef
  model: AgentOptions
  sampling?: unknown
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
    private readonly preset: string,
    private readonly model: AgentOptions,
    private readonly setupMetaCapabilities: (agentCtx: Context) => void,
  ) {}

  getLive(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  resume(sessionId: string): Promise<AgentHandle> {
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.model,
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, this.preset)
        this.setupMetaCapabilities(agentCtx)
      },
    })
  }

  create(sessionId: string): Promise<AgentHandle> {
    return this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: this.model,
      meta: { agentPreset: this.preset },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, this.preset)
        this.setupMetaCapabilities(agentCtx)
      },
    })
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
    if (state?.metaHarnessRef === this.options.metaHarnessRef) {
      const live = this.host.getLive(state.sessionId)
      if (live !== undefined) return live
      try {
        this.handle = await this.host.resume(state.sessionId)
        return this.handle.agent
      } catch (error) {
        if (!cannotResumePersistedSession(error)) throw error
      }
    }
    const sessionId = crypto.randomUUID()
    this.handle = await this.host.create(sessionId)
    await this.store.writeMeta({ sessionId, metaHarnessRef: this.options.metaHarnessRef })
    return this.handle.agent
  }

  async wake(round: Readonly<RefinementRound>): Promise<string> {
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
        roundId: round.roundId,
        targetHarnessRef: round.targetHarnessRef,
        targetHarnessDigest: round.targetHarnessDigest,
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
        requestedTarget: round.requestedTarget,
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
    const options = agent.options
    return {
      sessionId: String(agent.id),
      requestHeaderSeq: effective.seq,
      proposalEventSeq: proposal.seq,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(this.options.sampling === undefined ? {} : { sampling: this.options.sampling as never }),
    }
  }

  async dispose(): Promise<void> {
    await this.handle?.dispose()
    this.handle = undefined
    this.wakes.clear()
    this.evidenceAccess.clear()
  }
}
