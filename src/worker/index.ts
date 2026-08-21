import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Readable, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { JsonRpcPeer } from './peer.js'
import { SessionAwareNotebookRuntime } from '../notebook/runtime.js'
import { mountNotebookTool } from '../notebook/tool.js'
import type { SessionRole } from '../types.js'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { presetIdForManifestDigest } from '../harness/builder.js'
import { isExactGitCommit } from '../types.js'

export * from './peer.js'

export interface WorkerConfig {
  role: Extract<SessionRole, 'target' | 'rollout'>
  targetHarnessRef: string
  targetManifestDigest: string
  targetPreset: string
  sandboxProfileRef: string
  pythonExecutable?: string
  input?: Readable
  output?: Writable
}

export const name = 'refine-worker'
export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt']
export const Config: Schema<WorkerConfig> = Schema.object({
  role: Schema.union(['target', 'rollout'] as const).required(),
  targetHarnessRef: Schema.string().required(),
  targetManifestDigest: Schema.string().required(),
  targetPreset: Schema.string().required(),
  sandboxProfileRef: Schema.string().required(),
  pythonExecutable: Schema.string().default('python3'),
})

interface OpenParams {
  sessionId: string
  mode: 'create' | 'resume'
}

export async function apply(ctx: Context, config: WorkerConfig): Promise<void> {
  if (!isExactGitCommit(config.targetHarnessRef)) throw new Error('targetHarnessRef must be an exact Git commit')
  if (config.targetPreset !== presetIdForManifestDigest(config.targetManifestDigest)) {
    throw new Error('targetPreset must be derived from the target manifest digest')
  }
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const peer = new JsonRpcPeer(input, output)
  const sessions = new Map<string, AgentHandle>()
  let cwd = process.cwd()
  let provider: string | undefined
  let model: string | undefined
  let maxTokens: number | undefined

  const notebook = new SessionAwareNotebookRuntime({
    ...(config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable }),
    allowedMethods: config.role === 'target'
      ? { target: ['refine.run', 'refine.status'] }
      : { rollout: [] },
    bridge: async (method, params, request) => {
      if (config.role !== 'target') throw new Error(`rollout has no control capability: ${method}`)
      return peer.request(`control/${method}`, {
        workerSessionId: request.sessionId,
        targetHarnessRef: config.targetHarnessRef,
        ...(typeof params === 'object' && params !== null ? params as Record<string, unknown> : {}),
      })
    },
  })

  const openSession = async (params: OpenParams): Promise<Record<string, unknown>> => {
    if (sessions.has(params.sessionId)) return { sessionId: params.sessionId, opened: false, targetHarnessRef: config.targetHarnessRef }
    const setup = async (agentCtx: Context): Promise<void> => {
      const mounted = await ctx.agentPresets.mount(agentCtx, config.targetPreset)
      if (mounted.id !== config.targetPreset) throw new Error('worker mounted an unexpected target preset')
      mountNotebookTool(agentCtx, notebook, config.role, cwd)
    }
    const agentOptions = {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    const handle = params.mode === 'resume'
      ? await ctx.agents.resume({ resumeSessionId: SessionId(params.sessionId), agentOptions, setup })
      : await ctx.agents.create({
        sessionId: SessionId(params.sessionId),
        meta: { cwd, agentPreset: config.targetPreset },
        agentOptions,
        setup,
      })
    sessions.set(params.sessionId, handle)
    return { sessionId: params.sessionId, opened: true, targetHarnessRef: config.targetHarnessRef }
  }

  const disposers = [
    ctx.on('session/event', (session, event) => {
      if (sessions.has(String(session.id))) peer.notify('session.event', { sessionId: String(session.id), event })
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      if (sessions.has(String(agent.id))) peer.notify('session.status', { sessionId: String(agent.id), status })
    }),
    peer.handle('initialize', (params) => {
      cwd = resolve(typeof params.cwd === 'string' ? params.cwd : cwd)
      provider = typeof params.provider === 'string' ? params.provider : undefined
      model = typeof params.model === 'string' ? params.model : undefined
      maxTokens = typeof params.maxTokens === 'number' ? params.maxTokens : undefined
      return {
        serverInfo: { name: 'dsh-refine-worker', version: '0.1.0' },
        targetHarnessRef: config.targetHarnessRef,
        targetManifestDigest: config.targetManifestDigest,
        sandboxProfileRef: config.sandboxProfileRef,
      }
    }),
    peer.handle('session/open', params => openSession(params as unknown as OpenParams)),
    peer.handle('session/prompt', async (params) => {
      const sessionId = String(params.sessionId ?? '')
      const handle = sessions.get(sessionId)
      if (handle === undefined) throw new Error(`session is not open: ${sessionId}`)
      const content = Array.isArray(params.contentBlocks) ? params.contentBlocks : []
      const message = createUserMessage({ content: content as never, source: { kind: 'user' } })
      handle.agent.followup(message)
      return { messageId: message.id }
    }),
    peer.handle('session/cancel', (params) => {
      const sessionId = String(params.sessionId ?? '')
      const handle = sessions.get(sessionId)
      if (handle === undefined) throw new Error(`session is not open: ${sessionId}`)
      handle.agent.cancel({ kind: 'user' })
      return {}
    }),
    peer.handle('session/close', async (params) => {
      const sessionId = String(params.sessionId ?? '')
      const handle = sessions.get(sessionId)
      if (handle === undefined) return { closed: false }
      sessions.delete(sessionId)
      await notebook.disposeSession(sessionId)
      await handle.dispose()
      return { closed: true }
    }),
    peer.handle('shutdown', async () => {
      const handles = [...sessions.values()]
      sessions.clear()
      await notebook.dispose()
      await Promise.all(handles.map(handle => handle.dispose()))
      return {}
    }),
  ]

  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) dispose()
    peer.close()
    await notebook.dispose()
    await Promise.all([...sessions.values()].map(handle => handle.dispose()))
    sessions.clear()
  }, 'refine-worker.dispose()')
}
