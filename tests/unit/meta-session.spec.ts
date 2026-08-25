import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { DshMetaAgentHost, MetaSessionManager, type MetaAgentHost } from '../../src/meta/session.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { RefinementRound } from '../../src/types.js'
import { evidence, metaAgent, roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fakeAgent(id: string): Agent {
  const events: Array<Record<string, unknown>> = [{
    type: 'request/header', seq: 0, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  }]
  const session = {
    events,
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
