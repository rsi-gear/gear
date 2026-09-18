import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, type Message } from '@deepseek-ai/dsh-llm'
import { type EpochHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillHarnessIdentity } from '../../src/meta/skill.js'
import { loadBundledRefineSkill, mountDshRefineSkill } from '../../src/skill/dsh.js'
import * as bundleLoader from '../../src/skill/bundle.js'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const invocation = (text: string) => createUserMessage({
  source: { kind: 'skill-invocation', name: 'refine', form: 'instructions' }, content: [{ type: 'text', text }],
})

async function bridge(maxTokens?: number) {
  const bundled = await loadBundledRefineSkill()
  const identity: SkillHarnessIdentity = {
    runtime: { type: 'dsh', version: 'test', integrity: `sha256:${'1'.repeat(64)}` },
    preset: { id: 'refine', digest: bundled.digest },
    model: { provider: 'test', model: 'test-model', ...(maxTokens === undefined ? {} : { maxTokens }) },
    sampling: {},
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  let tool: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
  ctx.provide('tools', { register(definition: typeof tool) { tool = definition; return () => {} } } as never)
  const call = vi.fn(async () => ({ leaseId: 'lease-1' }))
  await mountDshRefineSkill(ctx, { maxRequestBytes: 1048576, call } as never, identity)
  const skill = (await ctx.skills.get('refine'))!
  const rendered = renderSkillContent(skill)
  let messages: Message[] = [invocation(rendered)]
  let header: EpochHeader = { config: identity.model }
  const events: SessionEvent[] = []
  const agent = {
    id: 'agent-1',
    session: { header: { cwd: '/tmp' }, requestHeader: () => header, deriveMessages: () => messages, events },
  }
  return {
    ctx, call, identity, skill, rendered, agent, events,
    setMessages(value: Message[]) { messages = value },
    setHeader(value: EpochHeader) { header = value },
    execute(method = 'meta.claim', params: unknown = {}) {
      return tool!.execute({ method, params }, { agent, signal: new AbortController().signal })
    },
  }
}

describe('DSH refine skill bridge', () => {
  it('uses the native catalog and binds a claim after explicit skill injection', async () => {
    const b = await bridge()
    expect(await b.ctx.skills.list()).toEqual([expect.objectContaining({ name: 'refine', provider: 'gear-refine-bundled' })])
    expect(b.skill).toMatchObject({ provider: 'gear-refine-bundled', resourceBase: { kind: 'directory' } })
    await b.execute('meta.claim', { evolutionId: 'evo-1', identity: {}, clientId: 'spoofed' })
    expect(b.call).toHaveBeenCalledWith('meta.claim', {
      evolutionId: 'evo-1', clientId: 'dsh:agent-1', identity: b.identity,
    })
  })

  it.each(['success', 'error', 'uncorrelated'])('checks native tool result provenance: %s', async kind => {
    const b = await bridge()
    const callId = CallId('load-refine')
    const assistant = createAssistantMessage({ source: b.identity.model, content: [
      { type: 'tool-call', id: callId, name: 'skill', arguments: '{"name":"refine"}' },
    ] })
    b.setMessages([
      ...(kind === 'uncorrelated' ? [] : [assistant]),
      createToolResultMessage({ callId, isError: kind === 'error', content: [{ type: 'text', text: b.rendered }] }),
    ])
    if (kind === 'success') await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
    else {
      await expect(b.execute()).rejects.toThrow('load the packaged refine skill')
      expect(b.call).not.toHaveBeenCalled()
    }
  })

  it.each(['absent', 'user-text', 'different-content', 'compacted', 'later-override'])('rejects %s instead of self-attesting', async kind => {
    const b = await bridge()
    const content = [{ type: 'text' as const, text: b.rendered }]
    const cases: Record<string, Message[]> = {
      absent: [],
      'user-text': [createUserMessage({ source: { kind: 'user' }, content })],
      'different-content': [invocation('different instructions')],
      compacted: [createUserMessage({ source: { kind: 'plugin', plugin: 'compaction' }, content })],
      'later-override': [invocation(b.rendered), invocation('overridden')],
    }
    b.setMessages(cases[kind]!)
    await expect(b.execute()).rejects.toThrow('load the packaged refine skill')
    expect(b.call).not.toHaveBeenCalled()
  })

  it('checks the current agent scope even after the bundled instructions were loaded', async () => {
    const b = await bridge()
    const get = vi.spyOn(b.ctx.skills, 'get').mockResolvedValue({ ...b.skill, provider: 'workspace' })
    await expect(b.execute()).rejects.toThrow('load the packaged refine skill')
    expect(get).toHaveBeenCalledWith('refine', expect.objectContaining({ scope: b.agent }))
    expect(b.call).not.toHaveBeenCalled()
  })

  it('rejects a bundle changed after startup rather than attesting the cached digest', async () => {
    const b = await bridge()
    const bundled = await loadBundledRefineSkill()
    vi.spyOn(bundleLoader, 'loadBundledRefineSkill').mockResolvedValue({ ...bundled, digest: `sha256:${'9'.repeat(64)}` })
    await expect(b.execute()).rejects.toThrow('packaged refine skill changed')
    expect(b.call).not.toHaveBeenCalled()
  })

  it('accepts code-mode loading only while its successful parent result remains visible', async () => {
    const b = await bridge()
    const callId = CallId('code-load')
    b.events.push({ type: 'tool/code-dispatch', seq: 0, time: 0, data: {
      rootCallId: callId, parentCallId: callId, subCallId: CallId('skill-load'), name: 'skill',
      arguments: { name: 'refine' }, isError: false, content: [{ type: 'text', text: b.rendered }],
    } } as SessionEvent)
    b.setMessages([createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'Loaded skill' }] })])
    await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
    b.setMessages([])
    await expect(b.execute()).rejects.toThrow('load the packaged refine skill')
  })

  it('accepts a real DSH adapter default when Gear omitted maxTokens', async () => {
    const b = await bridge()
    await b.ctx.plugin(LlmRuntime)
    class Adapter extends LlmAdapter {
      async *stream() { yield { type: 'text-delta' as const, index: 0, text: '' } }
      async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model, defaultMaxTokens: 256000 }
      }
    }
    b.ctx.llm.registerAdapter(['test'], new Adapter())
    const prepared = await b.ctx.llm.prepareCall(b.identity.model)
    expect(prepared.config.maxTokens).toBe(256000)
    expect(prepared.adapterDefaults).toEqual({ maxTokens: true })
    b.setHeader(prepared)
    await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
  })

  it.each([
    { configured: undefined, requested: 8192, defaults: false, allowed: false },
    { configured: 8192, requested: 8192, defaults: false, allowed: true },
    { configured: 8192, requested: 16384, defaults: true, allowed: false },
    { configured: 8192, requested: undefined, defaults: false, allowed: false },
  ])('preserves explicit maxTokens identity: $configured / $requested', async row => {
    const b = await bridge(row.configured)
    b.setHeader({ config: { provider: 'test', model: 'test-model', ...(row.requested === undefined ? {} : { maxTokens: row.requested }) },
      ...(row.defaults ? { adapterDefaults: { maxTokens: true } } : {}),
    })
    if (row.allowed) await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
    else await expect(b.execute()).rejects.toThrow('current DSH request identity does not match')
  })

  it.each([{ provider: 'other' }, { model: 'other' }, { temperature: 0.5 }])('rejects changed routing/sampling: %j', async change => {
    const b = await bridge()
    b.setHeader({ config: { ...b.identity.model, ...change } })
    await expect(b.execute('control.status')).rejects.toThrow('current DSH request identity does not match')
    expect(b.call).not.toHaveBeenCalled()
  })

  it.each(['medium', 'low', undefined])('checks explicit Medium against request effort %s', async effort => {
    const b = await bridge()
    b.identity.sampling = { reasoningEffort: 'medium' }
    b.setHeader({ config: {
      ...b.identity.model,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    } })
    if (effort === 'medium') await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
    else {
      await expect(b.execute()).rejects.toThrow('current DSH request identity does not match')
      expect(b.call).not.toHaveBeenCalled()
    }
  })

  it('allows the request default when effort was not configured', async () => {
    const b = await bridge()
    b.setHeader({ config: { ...b.identity.model, reasoningEffort: ReasoningEffortId('medium') } })
    await expect(b.execute()).resolves.toEqual({ leaseId: 'lease-1' })
  })

  it('rejects a configured DSH identity that does not match the packaged skill', async () => {
    const b = await bridge()
    await expect(mountDshRefineSkill({} as never, {} as never, {
      ...b.identity, preset: { id: 'refine', digest: `sha256:${'2'.repeat(64)}` },
    })).rejects.toThrow('DSH skill mode must use the packaged refine skill identity')
  })
})
