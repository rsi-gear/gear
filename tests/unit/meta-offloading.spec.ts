import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CallId, createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { DshMetaAgentHost, MetaSessionManager } from '../../src/meta/session.js'
import { MetaOffloadingStore, type MetaExecutionState, type HandoffBundle } from '../../src/meta/offloading-store.js'
import { handoffPrompt, resolveOffloadingPolicy, validateOffloadingPolicy } from '../../src/meta/offloading-policy.js'
import { RefineStateStore } from '../../src/state/store.js'
import { contextMessage, DshOffloadingHost, usageTokens } from '../../src/meta/offloading-host.js'
import { digestJson } from '../../src/state/digest.js'
import { metaAgent, roundFixture, evidence } from '../helpers/research-fixture.js'
import { MemorySessionBackend, MemorySessionPersistence } from '../helpers/session-persistence.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function summaryFixture() {
  const ctx = new Context()
  new LlmRuntime(ctx)
  cleanups.push(() => ctx.fiber.dispose())
  const calls: GenerateOptions[] = []
  class Adapter extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(request)
      yield { type: 'text-delta', index: 0, text: 'Observed a historical tool error; continue reviewing the remaining evidence.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['p'], new Adapter())
  return { host: new DshOffloadingHost(ctx), calls,
    spec: { ...metaAgent(), contextOffloading: resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 }) } }
}

async function setup(options: { summary?: string; overflow?: boolean; offloading?: boolean; requestMaxTokens?: number; maxRequests?: number; maxTokens?: number; abortSummary?: boolean; summaryGate?: Promise<void>; largeOutput?: boolean;
  nonshrinking?: boolean; oversizedFixed?: boolean; persistence?: MemorySessionBackend; abortReason?: unknown;
  restore?: { state: MetaExecutionState; bundle?: HandoffBundle; workText?: string }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-offloading-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx)
  new LlmRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  cleanups.push(() => ctx.fiber.dispose())
  if (options.persistence === undefined) ctx.on('session/flush', async () => {})
  else new MemorySessionPersistence(ctx, options.persistence)
  const archived = new Map<string, readonly SessionEvent[]>()
  ctx.on('agent/disposed', ({ agent }) => { archived.set(String(agent.id), agent.session.events) })
  ctx.provide('agentPresets', { mount: async () => {} } as never)
  const abort = new AbortController()
  const calls: GenerateOptions[] = []
  let work = options.restore === undefined ? 0 : 1
  if (options.restore !== undefined) await writeFile(join(root, 'work.txt'), options.restore.workText ?? '1')
  let completed = false
  let activeId: string
  class Adapter extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(request)
      if (request.purpose === 'compaction') {
        await options.summaryGate
        if (options.abortSummary) abort.abort(options.abortReason ?? new Error('cancel during summary'))
        yield { type: 'text-delta', index: 0, text: options.summary ?? 'Goal: continue editing. Work file holds completed edits. Next: run work tool. Kernel is new.' }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 50 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (options.overflow) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          name: 'ContextOverflow', code: 'CONTEXT_WINDOW_EXCEEDED', message: 'test overflow',
        } as never } }
      } else {
        const id = CallId(`work-${work}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'work', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'work', arguments: '{}' } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
  }
  ctx.llm.registerAdapter(['p'], new Adapter())
  const spec = { ...metaAgent(), ...(options.offloading === false ? {} : { contextOffloading: resolveOffloadingPolicy({
    mode: options.overflow ? 'overflow-only' : 'proactive', contextWindow: 10000,
    summaryMaxTokens: 1000, reserveTokens: 1500,
  }) }) }
  if (options.requestMaxTokens !== undefined) spec.model.maxTokens = options.requestMaxTokens
  const retired: string[] = []
  const setupCapabilities = (agentCtx: Context) => {
    agentCtx.tools.register(defineTool({
      name: 'work', description: 'Make one durable edit.', parameters: {},
      output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
      async execute(_args, exec) {
        expect(String(exec.agent!.id)).toBe(activeId)
        work += 1
        await writeFile(join(root, 'work.txt'), String(work))
        if (work === 3) { completed = true; exec.concludeTurn() }
        return options.largeOutput ? 'large output '.repeat(10000) : `completed edit ${work}`
      },
    }))
  }
  const host = new DshMetaAgentHost(ctx, setupCapabilities, async id => { retired.push(id) })
  const realPressure = host.offloading.pressure.bind(host.offloading)
  vi.spyOn(host.offloading, 'pressure').mockImplementation(async (agent, pending, signal) => {
    const measured = await realPressure(agent, pending, signal)
    return { ...measured,
      ...(options.oversizedFixed ? { fixedTokens: 9000 } : {}),
      tokens: agent.session.events.some(event => event.type === (options.overflow ? 'step/start' : 'tool/result')) && work < 3
        || options.nonshrinking && calls.some(call => call.purpose === 'compaction') ? 9000 : 1500,
    }
  })
  const store = new RefineStateStore(root, 'evo-1')
  await store.initialize()
  const manager = new MetaSessionManager(store, host, { evolutionId: 'evo-1', specDigest: digestJson(spec), metaAgent: spec })
  cleanups.push(() => manager.dispose())
  const parent = await manager.checkpoint()
  const journal = new MetaOffloadingStore(root)
  if (options.restore !== undefined) {
    await journal.cas(undefined, options.restore.state)
    if (options.restore.bundle !== undefined) await journal.writeBundle(options.restore.bundle)
  }
  const agent = options.restore === undefined ? await manager.fork(parent)
    : await manager.restore(options.restore.state.activeSessionId, options.restore.state.executionId)
  activeId = String(agent.id)
  const round = roundFixture({ status: 'candidate-editing' })
  const baseline = evidence(round.plan.seed, round.targetHarnessRef, 0, 'c')
  const switches: string[] = []
  const handle = await manager.wakeCandidate(round, round.candidatePool[0], baseline, agent, {
    executionId: 'execution-test', attempt: 1, deadlineAt: options.restore?.state.deadlineAt ?? Date.now() + 60000, signal: abort.signal,
    budget: { ...(options.maxRequests === undefined ? {} : { maxModelRequests: options.maxRequests }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) },
    isComplete: () => completed,
    snapshot: async () => ({ workspaceId: 'same-workspace', text: await readFile(join(root, 'work.txt'), 'utf8').catch(() => '') }),
    activate: (source, next) => { expect(source).toBe(activeId); switches.push(next); activeId = next },
  })
  return { root, manager, host, calls, handle, switches, retired, parent, agent, abort, ctx, archived,
    journal, get activeId() { return activeId } }
}

describe('DSH context offloading', () => {
  it('pins the exact task, corrections and latest cursor even when the historical tail is truncated', async () => {
    const { host, calls, spec } = summaryFixture()
    const envelope = contextMessage('Analyze historical pages and verify context continuity.')
    const correction = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do not rerun the benchmark or edit a candidate; only replay existing trajectories.' }] })
    const controller = { reviewedPages: 68, deliveredPages: 69 }
    const events: SessionEvent[] = [
      { seq: 0, time: 0, type: 'user/message', data: envelope },
      { seq: 1, time: 1, type: 'user/message', data: correction },
      { seq: 2, time: 2, type: 'user/message', data: createUserMessage({
        source: { kind: 'tool', name: 'history_next', callId: CallId('history-69') },
        content: [{ type: 'text', text: 'Historical USER: change the campaign budget. '.repeat(10000) }],
      }) },
    ]
    const result = await host.summarize(events, 'Current goal: change the campaign budget. Next: page 35.', spec,
      new AbortController().signal, undefined, { envelope, exactInputs: [correction], controller })
    const request = calls[0]!
    const pinned = JSON.parse((request.messages[0]!.content[0] as { text: string }).text)
    expect(pinned).toEqual({ kind: 'protected-handoff-context', taskInput: envelope, humanCorrections: [correction], controllerState: controller })
    expect(JSON.stringify(request.messages[1])).toContain('truncated')
    expect(JSON.stringify(request.messages[1])).toContain('history_next')
    expect(JSON.stringify(pinned)).not.toContain('campaign budget')
    expect(result.coverage).toMatchObject({ omittedEvents: 2, truncatedEvents: 1 })
    expect(request.messages.reduce((sum, message) => sum + host.estimate(message), 0)
      + host.estimate(contextMessage(String(request.system)))).toBeLessThanOrEqual(5000)
    expect(request.tools).toBeUndefined()
  })

  it('refuses to compress or silently omit protected context that cannot fit', async () => {
    const { host, calls, spec } = summaryFixture()
    const envelope = contextMessage('Exact constraint. '.repeat(10000))
    await expect(host.summarize([], undefined, spec, new AbortController().signal, undefined,
      { envelope, exactInputs: [], controller: {} })).rejects.toThrow(/cannot be compressed/)
    await expect(host.summarize([], undefined, spec, new AbortController().signal)).rejects.toThrow(/protected task context is missing/)
    expect(calls).toHaveLength(0)
  })

  it('retains sealed v1 behavior while resolving new policies to v2', async () => {
    const { host, calls, spec } = summaryFixture()
    expect(spec.contextOffloading.summaryPromptVersion).toBe('gear-handoff-v2')
    spec.contextOffloading.summaryPromptVersion = 'gear-handoff-v1'
    validateOffloadingPolicy(spec.contextOffloading)
    await host.summarize([{ seq: 0, time: 0, type: 'user/message', data: contextMessage('prior work') }],
      undefined, spec, new AbortController().signal)
    expect(calls[0]!.system).toBe(handoffPrompt('gear-handoff-v1'))
    expect(calls[0]!.messages).toHaveLength(1)
    expect(() => validateOffloadingPolicy({ ...spec.contextOffloading, summaryPromptVersion: 'unknown' })).toThrow(/unsupported/)
  })

  it('requires explicit capacity for proactive mode and keeps overflow-only explicit', () => {
    expect(() => resolveOffloadingPolicy({ mode: 'proactive' })).toThrow(/contextWindow/)
    expect(resolveOffloadingPolicy({ mode: 'overflow-only' }).contextWindow).toBeUndefined()
    expect(() => resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 1000, reserveTokens: 1000 })).toThrow(/reserve/)
    expect(usageTokens({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 15 })).toBe(160)
  })

  it('continues through two fresh sessions without repeating an edit or settling the logical turn early', async () => {
    const fixture = await setup()
    const result = await fixture.handle.completion!
    expect(result.reason).not.toBe('missing-turn-end')
    expect(await readFile(join(fixture.root, 'work.txt'), 'utf8')).toBe('3')
    expect(fixture.switches).toHaveLength(2)
    expect(fixture.retired).toHaveLength(2)
    const state = await fixture.journal.read('execution-test')
    expect(state).toMatchObject({ status: 'completed', generation: 2, attempt: 1, activeSessionId: fixture.activeId })
    expect(state!.usage).toMatchObject({ modelRequests: 5, summaryRequests: 2, summaryTokens: 350, tokens: 710 })
    expect(fixture.calls.filter(call => call.purpose === 'compaction')).toHaveLength(2)
    for (const [index, ref] of state!.handoffs.entries()) {
      const bundle = await fixture.journal.readBundle(ref)
      expect(bundle.manifest.source.sourceSessionId).not.toBe(fixture.activeId)
      expect(bundle.state.controller).toMatchObject({ workspaceId: 'same-workspace' })
      const request = fixture.calls.filter(call => call.purpose === 'compaction')[index]!
      const pinned = JSON.parse((request.messages[0]!.content[0] as { text: string }).text)
      expect(pinned.taskInput).toEqual(bundle.state.envelope)
      expect(pinned.controllerState).toEqual({ workspaceId: 'same-workspace', text: String(index + 1) })
    }
    expect(fixture.manager.proposalEvidenceAudit('round-1', fixture.activeId, []).baselineEvalId).toBeTruthy()
    expect(() => fixture.manager.proposalEvidenceAudit('round-1', String(fixture.agent.id), [])).toThrow(/active round/)
    expect(fixture.parent.prefixDigest).toBe(digestJson(fixture.ctx.agents.get(fixture.parent.sourceSessionId as never)!.session.events))
  })

  it('bounds overflow recovery without completed work', async () => {
    const fixture = await setup({ overflow: true })
    await expect(fixture.handle.completion).rejects.toThrow(/context-unrecoverable/)
    expect(fixture.switches).toHaveLength(1)
    expect((await fixture.journal.read('execution-test'))!.status).toBe('stopped')
  })

  it.each(['tokens', 'requests', 'complete'] as const)('enforces generation budgets without enabling context offloading (%s)', async mode => {
    const fixture = await setup({ offloading: false,
      ...(mode === 'tokens' ? { maxTokens: 1 } : mode === 'requests' ? { maxRequests: 1 } : { maxTokens: 100000, maxRequests: 3 }) })
    expect(fixture.manager.options.metaAgent.contextOffloading).toBeUndefined()
    expect(fixture.manager.capabilities.aggregateGenerationBudget).toBe(true)
    if (mode === 'complete') await fixture.handle.completion
    else await expect(fixture.handle.completion).rejects.toThrow(/context-budget-exhausted/)
    expect(fixture.switches).toHaveLength(0)
    expect(fixture.calls).toHaveLength(mode === 'tokens' ? 0 : mode === 'requests' ? 1 : 3)
    expect(fixture.calls.some(call => call.purpose === 'compaction')).toBe(false)
    expect(await fixture.journal.read('execution-test')).toMatchObject({ status: mode === 'complete' ? 'completed' : 'stopped',
      usage: { summaryRequests: 0, summaryTokens: 0 } })
    if (mode === 'complete') {
      const attribution = fixture.manager.proposalAttribution('round-1', fixture.activeId, {})
      expect(attribution.maxTokens).toBe(fixture.calls.at(-1)!.maxTokens)
      expect(new Set(fixture.calls.map(call => call.maxTokens)).size).toBeGreaterThan(1)
      expect(await fixture.journal.read('execution-test')).toMatchObject({ usage: { modelRequests: 3, tokens: 360 } })
    }
  })

  it('attributes budget-capped requests to the sealed model while retaining their effective output limit', async () => {
    const fixture = await setup({ offloading: false, maxTokens: 100000, requestMaxTokens: 100000 })
    await fixture.handle.completion
    const attribution = fixture.manager.proposalAttribution('round-1', fixture.activeId, {})
    expect(attribution.maxTokens).toBeLessThan(100000)
    expect(attribution.maxTokens).toBe(fixture.calls.at(-1)!.maxTokens)
    const agent = fixture.host.getLive(fixture.activeId)!
    const effective = agent.session.events.findLast(event => event.type === 'request/header')!
    if (effective.type !== 'request/header') throw new Error('missing request header')
    agent.session.append('request/header', { ...effective.data, header: { ...effective.data.header,
      config: { ...effective.data.header.config, model: 'unsealed-model' } }, reason: 'change' })
    expect(() => fixture.manager.proposalAttribution('round-1', fixture.activeId, {})).toThrow(/lacks a generation budget reservation/)
  })

  it('charges summaries to the original request limit', async () => {
    const fixture = await setup({ maxRequests: 1 })
    await expect(fixture.handle.completion).rejects.toThrow(/context-budget-exhausted/)
    expect(fixture.switches).toHaveLength(0)
    expect(fixture.calls).toHaveLength(1)
  })

  it('blocks the first model request when its token reservation exceeds the aggregate limit', async () => {
    const fixture = await setup({ maxTokens: 1 })
    expect(fixture.manager.capabilities.aggregateGenerationBudget).toBe(true)
    await expect(fixture.handle.completion).rejects.toThrow(/context-budget-exhausted/)
    expect(fixture.calls).toHaveLength(0)
    expect(await fixture.journal.read('execution-test')).toMatchObject({ status: 'stopped', usage: { modelRequests: 0, tokens: 0 } })
  })

  it('does not activate a late summary after cancellation', async () => {
    const fixture = await setup({ abortSummary: true })
    await expect(fixture.handle.completion).rejects.toThrow(/cancel during summary/)
    expect(fixture.switches).toHaveLength(0)
    expect(await fixture.journal.read('execution-test')).toMatchObject({ status: 'stopped', failure: 'context-handoff-failed: cancel during summary' })
  })

  it('preserves a string abort reason in the durable failure', async () => {
    const fixture = await setup({ abortSummary: true, abortReason: 'cancel requested by user' })
    await expect(fixture.handle.completion).rejects.toThrow('cancel requested by user')
    expect(await fixture.journal.read('execution-test')).toMatchObject({ status: 'stopped', failure: 'context-handoff-failed: cancel requested by user' })
    expect(fixture.switches).toHaveLength(0)
  })

  it('preserves steering arriving while the source is in summary maintenance', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await setup({ summaryGate: gate.promise })
    await vi.waitFor(() => expect(fixture.calls.some(call => call.purpose === 'compaction')).toBe(true))
    const steering = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the exact new user constraint: use the existing workspace.' }] })
    fixture.agent.steer(steering)
    gate.resolve()
    await fixture.handle.completion
    const successorRequests = fixture.calls.filter(call => call.purpose === undefined && String(call.sessionId) !== String(fixture.agent.id))
    expect(successorRequests.some(call => call.messages.some(message => message.id === steering.id))).toBe(true)
    for (const request of successorRequests) expect(request.messages.filter(message => message.id === steering.id).length).toBeLessThanOrEqual(1)
    const summaries = fixture.calls.filter(call => call.purpose === 'compaction')
    const pinned = JSON.parse((summaries[1]!.messages[0]!.content[0] as { text: string }).text)
    expect(pinned.humanCorrections).toContainEqual(steering)
    const successorText = JSON.stringify(successorRequests[0]!.messages)
    expect(successorText).toContain('humanCorrectionMessageIds')
    expect(successorText).toContain(steering.id)
    expect((await fixture.journal.read('execution-test'))!.pending).toHaveLength(0)
  })

  it('bounds ordinary tool output and retains its full body under an owner-scoped ref', async () => {
    const fixture = await setup({ largeOutput: true })
    await fixture.handle.completion
    const state = (await fixture.journal.read('execution-test'))!
    const bundle = await fixture.journal.readBundle(state.handoffs[0]!)
    const events = await fixture.host.events(bundle.manifest.source).catch(() => [])
    // Retired transcripts are persisted by production; this fixture intentionally
    // uses a flush listener without a cold backend, so inspect the immutable source snapshot.
    const source = events.length ? events : fixture.agent.session.events
    const result = source.find(event => event.type === 'tool/result')
    expect(JSON.stringify(result)).not.toContain('large output '.repeat(2000))
    const ref = JSON.stringify(result).match(/output:[a-f0-9]{64}/u)?.[0]
    expect(ref).toBeDefined()
    expect(JSON.stringify(await fixture.journal.readOutput('execution-test', ref!))).toContain('large output '.repeat(2000))
  })

  it.each<{
    phase: 'intent' | 'bundle-written' | 'prepared' | 'activated' | 'delivered'
    fault: 'none' | 'missing-session' | 'wrong-owner' | 'already-worked' | 'changed-workspace'
  }>([
    { phase: 'intent', fault: 'none' },
    { phase: 'bundle-written', fault: 'none' },
    { phase: 'prepared', fault: 'none' },
    { phase: 'activated', fault: 'none' },
    { phase: 'delivered', fault: 'none' },
    { phase: 'delivered', fault: 'missing-session' },
    { phase: 'activated', fault: 'wrong-owner' },
    { phase: 'activated', fault: 'already-worked' },
    { phase: 'activated', fault: 'changed-workspace' },
  ])(
    'validates cold recovery at $phase with fault=$fault', async ({ phase, fault }) => {
      const backend = new MemorySessionBackend()
      const original = await setup({ persistence: backend })
      await original.handle.completion
      const finished = (await original.journal.read('execution-test'))!
      const ref = finished.handoffs[0]!
      const bundle = await original.journal.readBundle(ref)
      const activated = phase === 'activated' || phase === 'delivered'
      const successorEvents = original.archived.get(bundle.manifest.successorSessionId)!
      const firstAssistant = successorEvents.findIndex(event => event.type === 'assistant/message')
      const continuation = successorEvents.slice(0, firstAssistant).flatMap(event => event.type === 'user/message' ? [event.data] : [])
      const firstTurn = successorEvents.findIndex(event => event.type === 'turn/start')
      const state: MetaExecutionState = {
        ...finished, revision: 0, generation: activated ? 1 : 0, status: activated ? 'running' : 'rotating',
        activeSessionId: activated ? bundle.manifest.successorSessionId : bundle.manifest.source.sourceSessionId,
        sessions: activated ? [bundle.manifest.source.sourceSessionId, bundle.manifest.successorSessionId] : [bundle.manifest.source.sourceSessionId],
        usage: bundle.state.usage, handoffs: activated ? [ref] : [], pending: phase === 'activated' ? continuation : [], continuation,
        deliveredIds: [],
        recovery: { envelope: bundle.state.envelope, controller: bundle.state.controller, evidence: bundle.state.evidence },
        intent: { trigger: 'pressure', pressure: 9000, source: bundle.manifest.source,
          successorSessionId: bundle.manifest.successorSessionId,
          phase: phase === 'intent' || phase === 'bundle-written' ? 'intent' : phase,
          ...(phase === 'intent' || phase === 'bundle-written' ? {} : { bundleDigest: ref }),
        },
      }
      const seed = activated ? phase === 'delivered' ? successorEvents.slice(0, firstTurn) : []
        : original.agent.session.events.slice(0, bundle.manifest.source.eventCount)
      // Discard all live DSH state. Materialized prefixes are the only data the
      // new coordinator can see; activated-before-delivery has no stored record.
      await original.manager.dispose()
      await original.ctx.fiber.dispose()
      const cold = new MemorySessionBackend()
      const sourceId = SessionId(bundle.manifest.source.sourceSessionId)
      cold.records.set(sourceId, structuredClone(backend.records.get(sourceId)!))
      cold.records.get(sourceId)!.events = structuredClone(original.agent.session.events.slice(0, bundle.manifest.source.eventCount)) as SessionEvent[]
      if (phase === 'delivered') {
        const successorId = SessionId(bundle.manifest.successorSessionId)
        cold.records.set(successorId, structuredClone(backend.records.get(successorId)!))
        expect(seed.length).toBeGreaterThan(0)
      }
      const id = SessionId(state.activeSessionId)
      if (phase === 'activated') cold.records.delete(id)
      else cold.records.get(id)!.events = structuredClone(seed) as SessionEvent[]
      if (fault === 'missing-session') cold.records.delete(id)
      if (fault === 'wrong-owner') state.intent!.successorSessionId = 'other-successor'
      if (fault === 'already-worked') cold.records.set(id, structuredClone(backend.records.get(id)!))
      const resume = setup({ persistence: cold, restore: { state,
        ...(phase === 'intent' ? {} : { bundle }),
        ...(fault === 'changed-workspace' ? { workText: 'unknown side effect' } : {}),
      } })
      if (fault === 'missing-session' || fault === 'wrong-owner' || fault === 'already-worked') {
        const errors = { 'missing-session': /not found/iu, 'wrong-owner': /handoff identity mismatch/u,
          'already-worked': /already performed work/u }
        await expect(resume).rejects.toThrow(errors[fault])
        return
      }
      const resumed = await resume
      if (fault === 'changed-workspace') {
        await expect(resumed.handle.completion).rejects.toThrow(/workspace digest changed/u)
        expect(resumed.calls).toHaveLength(0)
        expect(resumed.switches).toHaveLength(0)
        return
      }
      await resumed.handle.completion
      const recovered = (await resumed.journal.read('execution-test'))!
      expect(recovered).toMatchObject({ status: 'completed', attempt: 1, deadlineAt: finished.deadlineAt })
      expect(recovered.sessions.filter(id => id === bundle.manifest.successorSessionId)).toHaveLength(1)
      expect(original.parent.eventCount).toBe(0)
      expect(resumed.parent.eventCount).toBe(0)
      expect(resumed.parent.prefixDigest).toBe(original.parent.prefixDigest)
      expect(resumed.parent.sourceSessionId).not.toBe(original.parent.sourceSessionId)
      expect(await readFile(join(resumed.root, 'work.txt'), 'utf8')).toBe('3')
      expect(resumed.calls.filter(call => call.purpose === 'compaction')).toHaveLength(phase === 'intent' ? 2 : 1)
    },
  )

  it('fails closed on invalid or nonshrinking summaries', async () => {
    const fixture = await setup({ summary: '' })
    await expect(fixture.handle.completion).rejects.toThrow(/context-handoff-failed/)
    expect(fixture.switches).toHaveLength(0)
  })

  it.each(['nonshrinking', 'oversizedFixed'] as const)('does not activate when %s leaves no continuation space', async mode => {
    const fixture = await setup({ [mode]: true })
    await expect(fixture.handle.completion).rejects.toThrow(/context-unrecoverable/)
    expect(fixture.switches).toHaveLength(0)
    if (mode === 'oversizedFixed') expect(fixture.calls).toHaveLength(0)
  })

  it('enforces owner-scoped output refs and a single CAS winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-context-cas-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const store = new MetaOffloadingStore(root)
    const ref = await store.writeOutput('owner-a', { text: 'private evidence' })
    await expect(store.readOutput('owner-b', ref)).rejects.toThrow(/unavailable/)
    await expect(store.readOutput('owner-a', 'output:../../secret')).rejects.toThrow(/invalid/)
    const state: MetaExecutionState = {
      schemaVersion: 1, executionId: 'exec', evolutionId: 'evo', specDigest: 'sha256:spec', roundId: 'round', attempt: 1,
      generation: 0, revision: 0, activeSessionId: 's0', sessions: ['s0'], status: 'running', deadlineAt: 9999999999999,
      usage: { modelRequests: 0, tokens: 0, summaryRequests: 0, summaryTokens: 0 }, pending: [], deliveredIds: [], handoffs: [],
    }
    await store.cas(undefined, state)
    const intent = { trigger: 'pressure' as const, pressure: 9000,
      source: { sourceSessionId: 's0', eventCount: 0, prefixDigest: digestJson([]) }, successorSessionId: 's1', phase: 'intent' as const }
    await store.cas(0, { ...state, status: 'rotating', revision: 1, intent })
    const results = await Promise.allSettled(['s1', 's2'].map(id => new MetaOffloadingStore(root).cas(1, {
      ...state, revision: 2, generation: 1, activeSessionId: 's1', sessions: ['s0', 's1'],
      intent: { ...intent, phase: 'activated', bundleDigest: digestJson(id) },
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })
})
