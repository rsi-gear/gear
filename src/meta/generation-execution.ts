import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import { digestJson } from '../state/digest.js'
import type { MetaExecutionBinding } from './controller.js'
import type { MetaTurnObservation } from '../types.js'
import { MetaContextError } from './offloading-policy.js'
import { MetaOffloadingStore, type MetaExecutionState } from './offloading-store.js'
import { usageTokens, type ContextPressure } from './offloading-host.js'

/** Metering and persistence only; no context replacement, summarization or model-window policy. */
export interface MetaGenerationBudgetHost {
  permit(agent: Agent): void
  revoke(sessionId: string): void
  pressure(agent: Agent, pending: readonly UserMessage[], signal: AbortSignal): Promise<ContextPressure>
  flush(agent: Agent): Promise<void>
}

/** One physical DSH attempt, with durable reservations before every model request. */
export class DshGenerationExecution {
  state!: MetaExecutionState
  private stopped?: string
  private fault: unknown
  private agent?: Agent
  private readonly seen = new Set<number>()
  private readonly reservations = new Map<string, number>()
  private readonly requestConfigs = new Map<string, EpochHeader['config']>()

  constructor(private readonly store: MetaOffloadingStore, private readonly host: MetaGenerationBudgetHost,
    private readonly owner: { evolutionId: string; specDigest: string; roundId: string; candidateId?: string },
    private readonly binding: MetaExecutionBinding) {}

  get activeSessionId(): string | undefined { return this.state?.activeSessionId }
  /** Only normalize caps actually applied by this execution; all other config drift stays visible. */
  attributionConfig(config: EpochHeader['config']): EpochHeader['config'] {
    const original = this.requestConfigs.get(digestJson(config))
    if (!original) throw new Error('request config lacks a generation budget reservation')
    return original
  }
  stop(reason: string): void { this.stopped = reason; this.agent?.cancel({ kind: 'hook', reason }) }
  private check(): void {
    this.binding.signal.throwIfAborted()
    if (this.stopped) throw new Error(this.stopped)
    if (Date.now() >= this.binding.deadlineAt) throw new MetaContextError('context-budget-exhausted', 'attempt deadline reached')
  }
  private exhausted(message: string): never { throw new MetaContextError('context-budget-exhausted', message) }
  private async save(patch: Partial<MetaExecutionState>): Promise<void> {
    const next = { ...this.state, ...patch, revision: this.state.revision + 1 }
    await this.store.cas(this.state.revision, next)
    this.state = next
  }
  private async account(agent: Agent, firstSeq: number): Promise<void> {
    let adjustment = 0
    for (const event of agent.session.events) {
      if (event.seq < firstSeq || this.seen.has(event.seq)) continue
      this.seen.add(event.seq)
      if (event.type !== 'assistant/message') continue
      const key = `${event.data.turn}:${event.data.step}`, reserved = this.reservations.get(key) ?? 0
      if (event.data.usage !== undefined) adjustment += usageTokens(event.data.usage) - reserved
      this.reservations.delete(key)
    }
    if (adjustment) await this.save({ usage: { ...this.state.usage, tokens: this.state.usage.tokens + adjustment } })
    if (this.binding.budget.maxTokens !== undefined && this.state.usage.tokens > this.binding.budget.maxTokens) this.exhausted('aggregate candidate token budget exceeded')
  }

  async run(agent: Agent, envelope: UserMessage, firstSeq: number, observe: () => MetaTurnObservation): Promise<MetaTurnObservation> {
    this.agent = agent
    if (await this.store.read(this.binding.executionId)) throw new Error('existing generation execution must be recovered, not restarted')
    this.state = { schemaVersion: 1, executionId: this.binding.executionId, ...this.owner,
      attempt: this.binding.attempt, generation: 0, revision: 0, activeSessionId: String(agent.id), sessions: [String(agent.id)],
      status: 'running', deadlineAt: this.binding.deadlineAt,
      usage: { modelRequests: 0, tokens: 0, summaryRequests: 0, summaryTokens: 0 }, pending: [], deliveredIds: [], handoffs: [] }
    await this.store.cas(undefined, this.state)
    const removers: Array<() => void> = []
    const abort = () => agent.cancel({ kind: 'hook', reason: 'generation execution cancelled' })
    this.binding.signal.addEventListener('abort', abort)
    try {
      this.check()
      removers.push(agent.ctx.on('tools/pre-execute', async (_exec, next) => {
        this.check(); await this.account(agent, firstSeq)
        if (this.fault) throw this.fault
        if (this.binding.isComplete()) throw new Error('generation already finalized')
        return next()
      }, { prepend: true }))
      removers.push(agent.ctx.on('agent/pre-step', async (_payload, next) => {
        try {
          this.check(); await this.account(agent, firstSeq)
          if (this.fault) throw this.fault
          if (this.binding.isComplete()) return { kind: 'reject' }
          return await next()
        } catch (error) { this.fault = error; return { kind: 'reject' } }
      }, { prepend: true }))
      removers.push(agent.ctx.on('agent/request', async (payload, next) => {
        try {
          this.check()
          if (this.binding.isComplete()) throw new Error('generation already finalized')
          const requested = await next()
          // DSH carries the last effective config into the next request. Restore
          // only our own previous cap before calculating the new allowance.
          const config = this.requestConfigs.get(digestJson(requested)) ?? requested
          await this.account(agent, firstSeq)
          const { maxTokens, maxModelRequests } = this.binding.budget
          if (maxModelRequests !== undefined && this.state.usage.modelRequests >= maxModelRequests) this.exhausted('aggregate candidate request budget exhausted')
          const inputTokens = (await this.host.pressure(agent, [], this.binding.signal)).tokens
          const remaining = maxTokens === undefined ? undefined : maxTokens - this.state.usage.tokens - inputTokens
          if (remaining !== undefined && remaining <= 0) this.exhausted('aggregate candidate token budget exhausted')
          const outputLimit = remaining === undefined ? config.maxTokens : Math.min(config.maxTokens ?? remaining, remaining)
          const reservation = inputTokens + (outputLimit ?? 0)
          if (!Number.isSafeInteger(reservation) || reservation < 0) throw new Error('invalid generation token reservation')
          await this.save({ usage: { ...this.state.usage, modelRequests: this.state.usage.modelRequests + 1, tokens: this.state.usage.tokens + reservation } })
          this.reservations.set(`${payload.turn}:${payload.step}`, reservation)
          await this.host.flush(agent)
          const effective = outputLimit === undefined ? config : { ...config, maxTokens: outputLimit }
          this.requestConfigs.set(digestJson(effective), structuredClone(config))
          return effective
        } catch (error) { this.fault = error; throw error }
      }, { prepend: true }))
      this.host.permit(agent)
      agent.followup(envelope)
      await agent.whenIdle()
      await this.account(agent, firstSeq)
      this.check()
      if (this.fault) throw this.fault
      await this.save({ status: 'completed' })
      return observe()
    } catch (error) {
      agent.cancel({ kind: 'hook', reason: 'generation execution stopped' })
      await this.save({ status: 'stopped', failure: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.host.revoke(String(agent.id))
      this.binding.signal.removeEventListener('abort', abort)
      for (const remove of removers) remove()
    }
  }
}
