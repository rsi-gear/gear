import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, LlmRuntime, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { DshMetaAgentHost, MetaSessionManager, type MetaAgentHost } from '../../src/meta/session.js'
import { compatibleSkillMetaAgent } from '../../src/meta/controller.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { RefinementRound } from '../../src/types.js'
import { digestJson } from '../../src/state/digest.js'
import { evidence, metaAgent, roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fakeAgent(id: string): Agent {
  const events: Array<Record<string, unknown>> = [{
    type: 'request/header', seq: 0, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  }]
  const session = {
    events,
    header: { cwd: '/workspace' },
    get seq() { return events.length },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const followups: unknown[] = []
  return {
    id,
    options: { provider: 'p', model: 'm', maxTokens: 100 },
    session,
    followup(message: unknown) { followups.push(message) },
    async whenIdle() {},
    async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) { return task(new AbortController().signal) },
    cancel() {},
    followups,
  } as unknown as Agent
}

class FakeHost implements MetaAgentHost {
  live = new Map<string, Agent>()
  creates: string[] = []
  resumes: string[] = []

  getLive(id: string): Agent | undefined { return this.live.get(id) }
  async resume(id: string): Promise<AgentHandle> {
    this.resumes.push(id)
    const agent = fakeAgent(id)
    this.live.set(id, agent)
    return { agent, dispose: async () => { this.live.delete(id) } }
  }
  async create(id: string): Promise<AgentHandle> {
    this.creates.push(id)
    const agent = fakeAgent(id)
    this.live.set(id, agent)
    return { agent, dispose: async () => { this.live.delete(id) } }
  }
  async checkpoint(agent: Agent) {
    const events = [...agent.session.events]
    return { sourceSessionId: String(agent.id), eventCount: events.length, prefixDigest: digestJson(events) }
  }
  async fork(id: string, _spec: unknown, checkpoint: import('../../src/types.js').MetaCheckpointRef): Promise<AgentHandle> {
    const agent = fakeAgent(id)
    this.live.set(id, agent)
    ;(agent.session.events as unknown as unknown[]).splice(0, 1, ...structuredClone([
      ...this.live.get(checkpoint.sourceSessionId)!.session.events,
    ].slice(0, checkpoint.eventCount)))
    return { agent, dispose: async () => { this.live.delete(id) } }
  }
  async cancelAndFlush(): Promise<void> {}
}

function round(): RefinementRound {
  const value = roundFixture({ status: 'candidate-editing' })
  value.candidatePool[0]!.workspaceId = 'workspace-1'
  value.baseline = evidence(value.plan.seed, value.targetHarnessRef, 1, 'c')
  return value
}

const META_OPTIONS = {
  evolutionId: 'evo-1', specDigest: `sha256:${'9'.repeat(64)}`, metaAgent: metaAgent(),
} as const

function metaState(sessionId: string, metaHarnessRef = 'meta-v1') {
  return { evolutionId: 'evo-1', sessionId, metaHarnessRef, specDigest: META_OPTIONS.specDigest }
}

describe('MetaSessionManager', () => {
  it('lets a new uncapped skill profile resume a legacy evolution using its sealed maxTokens', () => {
    const current = metaAgent()
    const sealed = { ...current, model: { ...current.model, maxTokens: 8192 } }
    expect(compatibleSkillMetaAgent(sealed, current)).toBe(true)
    expect(compatibleSkillMetaAgent(sealed, {
      ...current, model: { ...current.model, maxTokens: 4096 },
    })).toBe(false)
    expect(compatibleSkillMetaAgent(sealed, {
      ...current, model: { ...current.model, model: 'changed' },
    })).toBe(false)
  })

  it('refuses to checkpoint when no durable session listener participates', async () => {
    const host = new DshMetaAgentHost({ sessions: { flush: async () => false } } as never, async () => {})
    await expect(host.checkpoint(fakeAgent('ephemeral'))).rejects.toThrow(/durable Meta session persistence/)
  })

  it('creates a child Agent from the exact checkpoint prefix and records fork lineage', async () => {
    const source = fakeAgent('parent')
    let created: Record<string, unknown> | undefined
    const child = fakeAgent('child')
    const parent = {
      agents: {
        get: (id: string) => String(id) === 'parent' ? source : undefined,
        create: async (options: Record<string, unknown>) => { created = options; return { agent: child, dispose: async () => {} } },
      },
      agentPresets: { mount: async () => {} },
    }
    const host = new DshMetaAgentHost(parent as never, async () => {})
    const prefix = [...source.session.events]
    await host.fork('child', metaAgent(), {
      sourceSessionId: 'parent', eventCount: prefix.length, prefixDigest: digestJson(prefix),
    })
    expect(created?.seed).toEqual(prefix)
    expect(created?.meta).toMatchObject({
      parentSession: 'parent', seedLength: prefix.length, cwd: '/candidate/harness', agentPreset: 'meta-v1',
    })
  })

  it('injects immutable Meta sampling into the effective DSH request', async () => {
    const scoped = new Context()
    let created: Record<string, unknown> | undefined
    let mounted: string | undefined
    const agent = fakeAgent('meta-sampling')
    const parent = {
      agents: {
        get: () => undefined,
        create: async (options: Record<string, unknown>) => {
          created = options
          await (options.setup as (ctx: Context) => Promise<void>)(scoped)
          return { agent, dispose: async () => {} }
        },
      },
      agentPresets: { mount: async (_ctx: Context, preset: string) => { mounted = preset } },
    }
    const host = new DshMetaAgentHost(parent as never, async () => {})
    await host.create('meta-sampling', metaAgent('meta-temperature', 0.75))
    const effective = await (scoped as unknown as {
      waterfall(name: string, payload: unknown, next: () => Promise<unknown>): Promise<Record<string, unknown>>
    }).waterfall('agent/request', {}, async () => ({ provider: 'p', model: 'm' }))
    expect(mounted).toBe('meta-temperature')
    expect(created?.agentOptions).toMatchObject({ provider: 'p', model: 'm' })
    expect(effective).toMatchObject({ provider: 'p', model: 'm', temperature: 0.75 })
  })

  it.each(['create', 'resume', 'fork'] as const)('pins Medium through %s despite persisted and preset effort overrides', async (operation) => {
    const scoped = new Context()
    const source = fakeAgent('parent')
    const spec = { ...metaAgent(), sampling: { temperature: 0.75, reasoningEffort: 'medium' } }
    const spawn = async (options: { setup: (ctx: Context) => Promise<void> }) => {
      await options.setup(scoped)
      return { agent: fakeAgent('meta-medium'), dispose: async () => {} }
    }
    const parent = {
      agents: { get: () => source, create: spawn, resume: spawn },
      agentPresets: {
        mount: async (ctx: Context) => {
          // This real DSH hook clears inherited effort when the selected model
          // has no explicit effort. Gear must be the outermost request hook.
          installModelSelection(ctx, { current: undefined, assembled: { provider: 'p', model: 'm' } })
        },
      },
    }
    const host = new DshMetaAgentHost(parent as never, async (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(), reasoningEffort: ReasoningEffortId('low'), temperature: 0,
      }), { prepend: true })
    })
    if (operation === 'fork') {
      const prefix = [...source.session.events]
      await host.fork('meta-medium', spec, {
        sourceSessionId: 'parent', eventCount: prefix.length, prefixDigest: digestJson(prefix),
      })
    } else await host[operation]('meta-medium', spec)

    const previous: LlmCallConfig = Object.freeze({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') })
    const effective = await (scoped as unknown as {
      waterfall(name: string, payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    }).waterfall('agent/request', {}, async () => previous)
    expect(effective).toEqual({ provider: 'p', model: 'm', temperature: 0.75, reasoningEffort: 'medium' })
    expect(previous.reasoningEffort).toBe('low')

    class CapabilityAdapter extends LlmAdapter {
      supported = ['low', 'medium']
      override async resolveModel(provider: string, model: string) {
        return {
          provider, id: model, name: model,
          reasoning: {
            efforts: this.supported.map(id => ({ id: ReasoningEffortId(id), name: id })),
            defaultEffort: ReasoningEffortId('low'),
          },
        }
      }
      async *stream(): AsyncGenerator<never> { throw new Error('this offline test must never call a model') }
    }
    const llm = new LlmRuntime(scoped)
    const adapter = new CapabilityAdapter()
    const dispose = llm.registerAdapter(['p'], adapter)
    try {
      expect((await llm.prepareCall(effective)).config.reasoningEffort).toBe('medium')
      adapter.supported = ['low']
      await expect(llm.prepareCall(effective)).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    } finally {
      dispose()
      await scoped.fiber.dispose()
    }
  })

  it.each([undefined, 0.75])('preserves adapter effort defaults when a legacy Meta spec only sets temperature %s', async temperature => {
    const scoped = new Context()
    const host = new DshMetaAgentHost({
      agents: {
        create: async (options: { setup: (ctx: Context) => Promise<void> }) => {
          await options.setup(scoped)
          return { agent: fakeAgent('legacy'), dispose: async () => {} }
        },
      },
      agentPresets: { mount: async () => {} },
    } as never, async () => {})
    await host.create('legacy', metaAgent('meta-v1', temperature))
    const defaults = { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') }
    const effective = await (scoped as unknown as {
      waterfall(name: string, payload: unknown, next: () => Promise<unknown>): Promise<unknown>
    }).waterfall('agent/request', {}, async () => defaults)
    expect(effective).toEqual({ ...defaults, ...(temperature === undefined ? {} : { temperature }) })
    await scoped.fiber.dispose()
  })

  it('wakes Meta with the authoritative current baseline and evidence policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const agent = await manager.agent()
    await manager.wake(round())
    const serialized = JSON.stringify((agent as unknown as { followups: unknown[] }).followups)
    expect(serialized).toContain('\\"primaryReward\\":1')
    expect(serialized).toContain('diagnoseEveryFailedRunBeforeProposal')
    expect(manager.activeRoundId(String(agent.id))).toBe('round-1')
    const audit = manager.proposalEvidenceAudit('round-1', String(agent.id), [round().baseline!.evalId])
    expect(audit).toMatchObject({ summaryAccessed: true, baselineEvalId: round().baseline!.evalId })
    await manager.dispose()
  })

  it.each([true, false])('settles a missing session only when host absence is verified (%s)', async absent => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-absent-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host: MetaAgentHost = new FakeHost()
    host.resume = async () => { throw new Error('session restore unavailable') }
    host.isSessionAbsent = async () => absent
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    try {
      const cancelled = manager.cancel('interrupted-original-session', 'recover interrupted attempt')
      if (absent) await expect(cancelled).resolves.toBeUndefined()
      else await expect(cancelled).rejects.toThrow('session restore unavailable')
    } finally { await manager.dispose() }
  })

  it('rejects aggregate generation limits before an unmetered DSH turn can start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-budget-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const manager = new MetaSessionManager(store, new FakeHost(), META_OPTIONS)
    const agent = await manager.agent(), state = round()
    const before = [...agent.session.events]
    try {
      expect(manager.capabilities.aggregateGenerationBudget).toBe(false)
      await expect(manager.wakeCandidate(state, state.candidatePool[0], state.baseline, agent, {
        executionId: 'bounded-attempt', attempt: 1, deadlineAt: Date.now() + 10000, signal: new AbortController().signal,
        budget: { maxTokens: 1, maxModelRequests: 1 }, isComplete: () => false, snapshot: async () => ({}), activate: () => {},
      })).rejects.toThrow('cannot enforce aggregate generation budgets')
      expect([...agent.session.events]).toEqual(before)
    } finally { await manager.dispose() }
  })

  it('observes the owned DSH turn ending with its effective limit and usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const agent = await manager.agent()
    ;(agent as unknown as { whenIdle: () => Promise<void> }).whenIdle = async () => {
      const events = agent.session.events as unknown as Array<Record<string, unknown>>
      events.push(
        { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
        {
          type: 'request/header', seq: 2, time: 101,
          data: { header: { config: { provider: 'p', model: 'm', maxTokens: 8192 } } },
        },
        {
          type: 'assistant/message', seq: 3, time: 69_000,
          data: {
            turn: 1, step: 1, message: { role: 'assistant', content: [] },
            usage: { inputTokens: 11_074, outputTokens: 8192, cacheReadTokens: 18_688, reasoningTokens: 8192 },
          },
        },
        { type: 'turn/end', seq: 4, time: 69_100, data: { turn: 1, reason: { kind: 'max-tokens' } } },
      )
    }
    const state = round()
    const wake = await manager.wakeCandidate(state, state.candidatePool[0], state.baseline, agent)
    await expect(wake.completion).resolves.toEqual({
      reason: 'max-tokens', turn: 1, durationMs: 69_000, effectiveMaxTokens: 8192,
      usage: { inputTokens: 11_074, outputTokens: 8192, cacheReadTokens: 18_688, reasoningTokens: 8192 },
    })
    await manager.dispose()
  })

  it('retains the provider error that ended the owned Meta turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-error-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const manager = new MetaSessionManager(store, new FakeHost(), META_OPTIONS)
    const agent = await manager.agent()
    const error = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Your input exceeds the context window of this model.' }
    ;(agent as unknown as { whenIdle: () => Promise<void> }).whenIdle = async () => {
      const events = agent.session.events as unknown as Array<Record<string, unknown>>
      events.push(
        { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: 200, data: { turn: 1, reason: { kind: 'error', error } } },
      )
    }
    const state = round()
    const wake = await manager.wakeCandidate(state, state.candidatePool[0], state.baseline, agent)
    await expect(wake.completion).resolves.toEqual({ reason: 'error', error, turn: 1, durationMs: 100 })
    await manager.dispose()
  })

  it('isolates sibling wake and evidence state by child session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const checkpoint = await manager.checkpoint()
    const [leftAgent, rightAgent] = await Promise.all([manager.fork(checkpoint), manager.fork(checkpoint)])
    const state = round()
    const left = { ...state.candidatePool[0]!, candidateId: 'left', workspaceId: 'left-workspace' }
    const right = { ...state.candidatePool[0]!, candidateId: 'right', workspaceId: 'right-workspace' }
    state.candidatePool = [left, right]
    await manager.wakeCandidate(state, left, state.baseline, leftAgent)
    await manager.wakeCandidate(state, right, state.baseline, rightAgent)
    expect(manager.proposalEvidenceAudit(state.roundId, String(leftAgent.id), [state.baseline!.evalId]).candidateId).toBe('left')
    expect(manager.proposalEvidenceAudit(state.roundId, String(rightAgent.id), [state.baseline!.evalId]).candidateId).toBe('right')
    await manager.dispose()
  })

  it('resumes the persisted fixed-harness session and reuses it across wakes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    await store.writeMeta(metaState('persisted'))
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, {
      ...META_OPTIONS, metaAgent: metaAgent('meta-v1', 0),
    })
    expect((await manager.agent()).id).toBe('persisted')
    await manager.wake(round())
    await manager.wake({ ...round(), roundId: 'round-2' })
    expect(host.resumes).toEqual(['persisted'])
    expect(host.creates).toEqual([])
    await manager.dispose()
  })

  it('rotates the session when MetaHarnessRef changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    await store.writeMeta(metaState('old', 'meta-old'))
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, { ...META_OPTIONS, metaAgent: metaAgent('meta-v2') })
    const agent = await manager.agent()
    expect(agent.id).not.toBe('old')
    expect((await store.readMeta())?.metaHarnessRef).toBe('meta-v2')
    expect(host.resumes).toEqual([])
    expect(host.creates).toHaveLength(1)
    await manager.dispose()
  })

  it('attributes a proposal to its existing durable notebook tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, {
      ...META_OPTIONS, metaAgent: metaAgent('meta-v1', 0),
    })
    const agent = await manager.agent()
    await manager.wake(round())
    ;(agent.session.events as unknown as Array<unknown>).push({
      type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm', temperature: 0 } }, reason: 'change' },
    })
    ;(agent.session.events as unknown as Array<unknown>).push({
      type: 'tool/call', seq: 2, data: { name: 'ipython_input', arguments: '{}' },
    })
    const attribution = manager.proposalAttribution('round-1', agent, null)
    expect(attribution).toMatchObject({
      sessionId: String(agent.id), requestHeaderSeq: 1, proposalEventSeq: 2,
      provider: 'p', model: 'm', sampling: { temperature: 0 },
    })
    expect([...agent.session.events].at(-1)?.type).toBe('tool/call')
    await manager.dispose()
  })

  it.each(['medium', 'low', undefined])('checks effective proposal effort %s against the sealed Medium spec', async (effort) => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-effort-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const manager = new MetaSessionManager(store, new FakeHost(), {
      ...META_OPTIONS, metaAgent: { ...metaAgent(), sampling: { reasoningEffort: 'medium' } },
    })
    const agent = await manager.agent()
    await manager.wake(round())
    ;(agent.session.events as unknown as unknown[]).push({
      type: 'request/header', seq: 1, data: { header: { config: {
        provider: 'p', model: 'm', ...(effort === undefined ? {} : { reasoningEffort: effort }),
      } }, reason: 'change' },
    }, { type: 'tool/call', seq: 2, data: { name: 'ipython_input', arguments: '{}' } })
    if (effort === 'medium') {
      expect(manager.proposalAttribution('round-1', agent, null)).toMatchObject({
        provider: 'p', model: 'm', sampling: { reasoningEffort: 'medium' },
      })
    } else expect(() => manager.proposalAttribution('round-1', agent, null)).toThrow(/immutable evolution spec/)
    await manager.dispose()
  })

  it('treats adapter-default provenance changes as the same effective request header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const agent = await manager.agent()
    await manager.wake(round())
    const effective = { config: { provider: 'p', model: 'm' }, system: [], tools: [] }
    ;(agent.session.events as unknown as Array<unknown>).push({
      type: 'request/header', seq: 1,
      data: { header: { ...effective, adapterDefaults: { reasoningEffort: true } }, reason: 'initial' },
    }, {
      type: 'request/header', seq: 2,
      data: { header: effective, reason: 'change' },
    }, {
      type: 'tool/call', seq: 3, data: { name: 'ipython_input', arguments: '{}' },
    })
    expect(manager.proposalAttribution('round-1', agent, null)).toMatchObject({
      requestHeaderSeq: 2,
      proposalEventSeq: 3,
    })
    await manager.dispose()
  })

  it('compares effective request headers independent of object property order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const agent = await manager.agent()
    await manager.wake(round())
    ;(agent.session.events as unknown as Array<unknown>).push({
      type: 'request/header', seq: 1,
      data: { header: { config: { provider: 'p', model: 'm', maxTokens: 1 }, system: [], tools: [] } },
    }, {
      type: 'request/header', seq: 2,
      data: { header: { config: { maxTokens: 1, model: 'm', provider: 'p' }, tools: [], system: [] } },
    }, {
      type: 'tool/call', seq: 3, data: { name: 'finalize_candidate', arguments: '{}' },
    })
    expect(manager.proposalAttribution('round-1', agent, null)).toMatchObject({ requestHeaderSeq: 2, proposalEventSeq: 3 })
    await manager.dispose()
  })

  it('rotates a persisted session whose log contains an unsupported plugin event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    await store.writeMeta(metaState('incompatible'))
    const host = new FakeHost()
    host.resume = async (id: string): Promise<AgentHandle> => {
      host.resumes.push(id)
      throw new Error(`session "${id}" contains event type "refine/proposal" unknown to this harness and not marked ignorable`)
    }
    const manager = new MetaSessionManager(store, host, META_OPTIONS)
    const agent = await manager.agent()
    expect(agent.id).not.toBe('incompatible')
    expect(host.resumes).toEqual(['incompatible'])
    expect(host.creates).toHaveLength(1)
    expect((await store.readMeta())?.sessionId).toBe(agent.id)
    await manager.dispose()
  })
})
