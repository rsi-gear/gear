import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { RefineEvaluator } from './types.js'
import type { SemanticTarget } from './types.js'
import type {} from '@deepseek-ai/dsh-commands'
import { HarnessBuilder } from './harness/builder.js'
import { SubprocessHarnessCompiler } from './harness/compiler.js'
import { RefineStateStore } from './state/store.js'
import { SessionAwareNotebookRuntime } from './notebook/runtime.js'
import { mountNotebookTool } from './notebook/tool.js'
import { DshMetaAgentHost, MetaSessionManager } from './meta/session.js'
import { assertMetaPresetIsolation } from './meta/isolation.js'
import { RefineService } from './refine/service.js'
import { RefineCapabilities } from './capabilities.js'
import { ConfigSchema, type Config as PluginConfig } from './config.js'
import './context.js'

export * from './types.js'
export * from './config.js'
export * from './capabilities.js'
export * from './harness/builder.js'
export * from './harness/compiler.js'
export * from './meta/session.js'
export * from './meta/isolation.js'
export * from './notebook/runtime.js'
export * from './notebook/tool.js'
export * from './refine/service.js'
export * from './state/store.js'
export * from './worker/manager.js'

export const name = 'refine'
export const inject = ['agents', 'agentPresets', 'commands', 'tools', 'systemPrompt']
export const Config = ConfigSchema

const SEMANTIC_TARGETS = new Set<SemanticTarget>([
  'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
  'skill', 'tool', 'workflow', 'compaction',
])

export function parseAdmissionInput(words: string[]): {
  seedTaskRef?: string
  rounds?: number
  taskBudgetMs?: number
  target?: SemanticTarget
} {
  const parsed: { seedTaskRef?: string; rounds?: number; taskBudgetMs?: number; target?: SemanticTarget } = {}
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (!word.startsWith('--')) {
      if (parsed.seedTaskRef !== undefined) throw new TypeError(`unexpected argument: ${word}`)
      parsed.seedTaskRef = word
      continue
    }
    const value = words[++index]
    if (value === undefined) throw new TypeError(`${word} requires a value`)
    if (word === '--rounds') parsed.rounds = Number(value)
    else if (word === '--budget') parsed.taskBudgetMs = Number(value)
    else if (word === '--target') {
      if (!SEMANTIC_TARGETS.has(value as SemanticTarget)) throw new TypeError(`unknown semantic target: ${value}`)
      parsed.target = value as SemanticTarget
    } else throw new TypeError(`unknown refine option: ${word}`)
  }
  return parsed
}

export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.dsh-refine')
  const artifactRoot = config.artifactRoot ?? join(config.harnessRoot, 'artifacts')
  const store = new RefineStateStore(stateRoot)
  const metaPreset = await ctx.agentPresets.resolve(config.metaPreset)
  await assertMetaPresetIsolation(metaPreset, [config.harnessRoot, artifactRoot])
  const compiler = new SubprocessHarnessCompiler(config.compiler)
  const builder = new HarnessBuilder({
    harnessRoot: config.harnessRoot,
    artifactRoot,
    dshRevision: config.dshRevision,
    toolchainRef: config.toolchainRef,
    sandboxProfileRef: config.sandboxProfileRef,
    allowedImports: config.allowedImports,
    compiler,
  })

  let capabilities: RefineCapabilities | undefined
  const notebook = new SessionAwareNotebookRuntime({
    ...(config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable }),
    allowedMethods: {
      'refine-meta': [
        'harness.current', 'harness.read', 'seed_tasks.load', 'trajectory.query', 'hitch.status',
        'submit_refinement_proposal',
      ],
      target: ['refine.run', 'refine.status'],
      rollout: [],
    },
    bridge: async (method, params, request) => {
      if (capabilities === undefined) throw new Error('refine capabilities are not initialized')
      return capabilities.call(request.role, request.sessionId, method, params)
    },
  })
  const host = new DshMetaAgentHost(ctx, config.metaPreset, config.metaModel, (agentCtx) => {
    mountNotebookTool(agentCtx, notebook, 'refine-meta', config.workspaceRoot)
  })
  const meta = new MetaSessionManager(store, host, {
    metaHarnessRef: config.metaHarnessRef,
    model: config.metaModel,
    ...(config.metaSampling === undefined ? {} : { sampling: config.metaSampling }),
  })
  const service = new RefineService(
    store,
    builder,
    meta,
    () => ctx.get('refineEvaluator') as RefineEvaluator | undefined,
    {
      workspaceRoot: config.workspaceRoot,
      metaHarnessRef: config.metaHarnessRef,
      sandboxProfileRef: config.sandboxProfileRef,
      promotion: config.promotion,
      seedTaskRef: config.seedTaskRef,
      heldOutRef: config.heldOutRef,
      taskBudgetMs: config.taskBudgetMs,
    },
  )
  capabilities = new RefineCapabilities(service, store, meta, sessionId => ctx.agents.get(sessionId as never), {
    ...(config.seedTasksPath === undefined ? {} : { seedTasksPath: config.seedTasksPath }),
  })

  await store.initialize()
  if (await store.readChampion() === undefined && config.initialChampion !== undefined) {
    await store.writeChampion(config.initialChampion)
  }
  await service.initialize()
  ctx.provide('notebookRuntime', notebook)
  ctx.provide('refine', service)
  ctx.effect(() => () => service.dispose(), 'refine.dispose()')
  ctx.commands.register({
    name: 'refine',
    description: 'Queue a target harness refinement round.',
    input: { hint: 'optional reason' },
    async handler(invocation) {
      try {
        const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        if (words[0] === 'status') {
          const status = words[1] === undefined ? await service.latestStatus() : await service.status(words[1])
          return { kind: 'success', text: status === undefined ? 'no refinement rounds' : JSON.stringify(status) }
        }
        if (words[0] === 'rollback') {
          if (words[1] === undefined) return { kind: 'error', text: 'usage: /refine rollback <verified-harness-ref>' }
          const champion = await service.rollback(words[1])
          return { kind: 'success', text: `champion now points to ${champion.ref}` }
        }
        const accepted = await service.admit('command', parseAdmissionInput(words))
        return { kind: 'success', text: `queued refinement round ${accepted.roundId}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
