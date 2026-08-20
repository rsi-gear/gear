import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { MetaSessionManager, type MetaAgentHost } from '../../src/meta/session.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { RefinementRound } from '../../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fakeAgent(id: string): Agent {
  const events: Array<Record<string, unknown>> = [{
    type: 'request/header', seq: 0, data: { header: { provider: 'p', model: 'm' }, reason: 'initial' },
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
  return {
    id,
    options: { provider: 'p', model: 'm', maxTokens: 100 },
    session,
    followup() {},
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
  return {
    schemaVersion: 1, roundId: 'round-1', workspaceRoot: '/workspace', status: 'waiting-proposal', source: 'api',
    createdAt: 'now', updatedAt: 'now', metaHarnessRef: 'meta-v1', targetHarnessRef: 'parent',
    targetHarnessDigest: 'sha256:parent', sandboxProfileRef: 'sandbox-v1',
    seedTaskRef: 'seed', heldOutRef: 'held-out', taskBudgetMs: 60_000,
    promotionPolicy: {
      minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true,
      maxHeldOutRegression: 0, maxRequiredRegressions: 0,
    },
    batchId: 'batch-1', roundIndex: 1, roundCount: 1,
    baseline: {
      ref: 'evidence:base', trajectoryRefs: [], runtimeFingerprint: 'runtime',
      summary: { total: 1, passed: 1, failed: 0, score: 1 },
    },
  }
}

describe('MetaSessionManager', () => {
  it('resumes the persisted fixed-harness session and reuses it across wakes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    await store.writeMeta({ sessionId: 'persisted', metaHarnessRef: 'meta-v1' })
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, {
      metaHarnessRef: 'meta-v1', model: { provider: 'p', model: 'm' }, sampling: { temperature: 0 },
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
    await store.writeMeta({ sessionId: 'old', metaHarnessRef: 'meta-old' })
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, { metaHarnessRef: 'meta-v2', model: {} })
    const agent = await manager.agent()
    expect(agent.id).not.toBe('old')
    expect((await store.readMeta())?.metaHarnessRef).toBe('meta-v2')
    expect(host.resumes).toEqual([])
    expect(host.creates).toHaveLength(1)
    await manager.dispose()
  })

  it('attributes a proposal to one effective request header and appends a durable event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const host = new FakeHost()
    const manager = new MetaSessionManager(store, host, {
      metaHarnessRef: 'meta-v1', model: { provider: 'p', model: 'm' }, sampling: { temperature: 0 },
    })
    const agent = await manager.agent()
    await manager.wake(round())
    ;(agent.session.events as unknown as Array<unknown>).push({
      type: 'request/header', seq: 1, data: { header: { provider: 'p', model: 'm' }, reason: 'change' },
    })
    const attribution = manager.proposalAttribution('round-1', agent, null)
    expect(attribution).toMatchObject({ sessionId: String(agent.id), requestHeaderSeq: 1, proposalEventSeq: 2 })
    expect([...agent.session.events].at(-1)?.type).toBe('refine/proposal')
    await manager.dispose()
  })
})
