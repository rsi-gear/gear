import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillHarnessIdentity } from '../meta/skill.js'
import type { RefineSkillGateway } from './gateway.js'
import { loadBundledRefineSkill } from './bundle.js'

export { loadBundledRefineSkill, type BundledRefineSkill } from './bundle.js'

const BUNDLED_SKILL_PROVIDER = 'gear-refine-bundled'

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Check the visible transcript, not user prose or a caller-supplied identity.
 * Compacted-away instructions must be loaded again through DSH's skill mechanism.
 * This verifies skill loading, not the permissions or entire composition of the host. */
function hasLoadedSkill(messages: readonly Message[], events: readonly SessionEvent[], rendered: string): boolean {
  const calls = new Set<string>()
  const codeLoads = new Map<string, boolean>()
  let loaded = false
  const matches = (content: Message['content']): boolean => content.length === 1
    && content[0]?.type === 'text' && content[0].text === rendered
  for (const event of events) {
    if (event.type !== 'tool/code-dispatch') continue
    const data = event.data
    if (data.name === 'skill' && typeof data.arguments === 'object' && data.arguments !== null
      && !Array.isArray(data.arguments) && (data.arguments as Record<string, unknown>).name === 'refine') {
      codeLoads.set(data.rootCallId, !data.isError && matches(data.content))
    }
  }
  for (const message of messages) {
    if (message.role === 'assistant' && message.source.kind === 'model') {
      for (const block of message.content) {
        if (block.type !== 'tool-call' || block.name !== 'skill') continue
        try {
          if (JSON.parse(block.arguments)?.name === 'refine') calls.add(block.id)
        } catch { /* A malformed call cannot prove a skill load. */ }
      }
    } else if (message.role === 'user' && message.source.kind === 'skill-invocation'
      && message.source.name === 'refine' && message.source.form === 'instructions') {
      loaded = matches(message.content)
    } else if (message.role === 'user' && message.source.kind === 'tool'
      && (calls.has(message.source.callId) || codeLoads.has(message.source.callId))) {
      const result = message.content[0]
      loaded = message.content.length === 1 && result?.type === 'tool-result'
        && result.toolCallId === message.source.callId && result.isError !== true
        && (codeLoads.get(message.source.callId) ?? matches(result.content))
    }
  }
  return loaded
}

/**
 * Publish the packaged skill through DSH's native catalog and expose the same
 * structured Gear protocol used by the socket client.
 */
export async function mountDshRefineSkill(
  ctx: Context,
  gateway: RefineSkillGateway,
  identity: SkillHarnessIdentity,
): Promise<void> {
  const skill = await loadBundledRefineSkill()
  // Optional native peer: standalone socket clients do not need a DSH skill service.
  const { renderSkillContent } = await import('@deepseek-ai/dsh-skill')
  if (identity.runtime.type !== 'dsh' || identity.preset.id !== skill.name || identity.preset.digest !== skill.digest) {
    throw new Error('DSH skill mode must use the packaged refine skill identity')
  }

  const candidate = {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: BUNDLED_SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    rank: 0,
    locator: skill.name,
    path: skill.path,
  } as const
  const definition = {
    name: skill.name,
    description: skill.description,
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    resourceBase: candidate.resourceBase,
    content: skill.content,
    path: skill.path,
  } as const
  ctx.skills.registerProvider(() => ({
    name: BUNDLED_SKILL_PROVIDER,
    async list() { return [candidate] },
    async get() { return definition },
  }))

  ctx.tools.register(defineTool({
    name: 'refine_request',
    description: 'Call the Gear Refine protocol from the packaged refine skill. DSH session identity is bound automatically.',
    parameters: {
      method: { type: 'string', required: true, description: 'Exact Gear Refine protocol method.' },
      params: { type: 'json', required: true, description: 'Method parameters. Omit clientId and identity; this tool binds them.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('refine_request requires an agent session')
      const header = exec.agent.session.requestHeader()
      const request = header?.config
      if (request === undefined
        || request.provider !== identity.model.provider
        || request.model !== identity.model.model
        || (request.maxTokens !== identity.model.maxTokens
          && !(identity.model.maxTokens === undefined && header?.adapterDefaults?.maxTokens === true))
        || request.temperature !== identity.sampling?.temperature
        || (identity.sampling?.reasoningEffort !== undefined
          && request.reasoningEffort !== identity.sampling.reasoningEffort)) {
        throw new Error('current DSH request identity does not match the immutable Gear configuration')
      }
      if ((await loadBundledRefineSkill()).digest !== identity.preset.digest) {
        throw new Error('packaged refine skill changed; restart Gear with a new evolution identity')
      }
      const effective = await ctx.skills.get(skill.name, {
        cwd: exec.agent.session.header.cwd, signal: exec.signal, scope: exec.agent,
      })
      const rendered = renderSkillContent(definition)
      if (effective?.provider !== BUNDLED_SKILL_PROVIDER || renderSkillContent(effective) !== rendered
        || !hasLoadedSkill(exec.agent.session.deriveMessages(), exec.agent.session.events, rendered)) {
        throw new Error('load the packaged refine skill through /refine or the native skill tool before using refine_request')
      }
      const params = typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params)
        ? { ...args.params as Record<string, unknown> }
        : (() => { throw new TypeError('params must be an object') })()
      const bytes = Buffer.byteLength(JSON.stringify({ method: args.method, params }), 'utf8')
      if (bytes > gateway.maxRequestBytes) throw new Error('refine request exceeds maxRequestBytes')
      const clientId = `dsh:${String(exec.agent.id)}`
      if (args.method === 'meta.claim') params.identity = identity
      if (args.method === 'meta.claim' || args.method === 'meta.call' || args.method.startsWith('candidate.')) {
        params.clientId = clientId
      }
      return jsonValue(await gateway.call(args.method, params))
    },
  }))
}
