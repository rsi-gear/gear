import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import type { SemanticTarget } from './types.js'
import type {} from '@deepseek-ai/dsh-commands'
import { HarnessBuilder } from './harness/builder.js'
import { SubprocessHarnessCompiler } from './harness/compiler.js'
import { EvolutionRegistryStore } from './state/evolution.js'
import { migrateLegacyState } from './state/migration.js'
import { CandidateWorkspaceManager } from './candidate/workspace.js'
import { CandidateFileSystem } from './candidate/filesystem.js'
import { CandidateSearchSubprocess } from './candidate/subprocess.js'
import { CandidateShellExecutor } from './candidate/shell.js'
import { isolateCandidateProviderContext } from './candidate/context.js'
import { SessionAwareNotebookRuntime } from './notebook/runtime.js'
import { mountMetaCapabilityTools, mountNotebookTool } from './notebook/tool.js'
import { DshMetaAgentHost, MetaSessionManager } from './meta/session.js'
import { assertMetaPresetIsolation } from './meta/isolation.js'
import { RefineService } from './refine/service.js'
import { RefineCapabilities } from './capabilities.js'
import { HitchCliEvaluator } from './evaluator/hitch-cli.js'
import { ConfigSchema, type Config as PluginConfig } from './config.js'
import { TargetWorkerRegistry } from './worker/registry.js'
import './context.js'

export * from './types.js'
export * from './config.js'
export * from './capabilities.js'
export * from './harness/builder.js'
export * from './harness/compiler.js'
export * from './evaluator/hitch-cli.js'
export * from './meta/session.js'
export * from './meta/isolation.js'
export * from './notebook/runtime.js'
export * from './notebook/sandbox.js'
export * from './notebook/tool.js'
export * from './refine/service.js'
export * from './state/store.js'
export * from './state/evolution.js'
export * from './state/dataset.js'
export * from './state/migration.js'
export * from './candidate/workspace.js'
export * from './candidate/filesystem.js'
export * from './candidate/subprocess.js'
export * from './candidate/shell.js'
export * from './candidate/context.js'
export * from './worker/manager.js'
export * from './worker/registry.js'

export const name = 'refine'
export const inject = ['agents', 'agentPresets', 'commands', 'tools', 'systemPrompt', 'subprocess']
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
  focus?: SemanticTarget[]
  from?: 'initial' | 'published' | string
  name?: string
} {
  const parsed: { seedTaskRef?: string; rounds?: number; taskBudgetMs?: number; target?: SemanticTarget; focus?: SemanticTarget[]; from?: 'initial' | 'published' | string; name?: string } = {}
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
    else if (word === '--target' || word === '--focus') {
      const values = value.split(',').filter(Boolean)
      if (values.length === 0 || values.some(item => !SEMANTIC_TARGETS.has(item as SemanticTarget))) throw new TypeError(`unknown semantic focus: ${value}`)
      parsed.focus = [...new Set([...(parsed.focus ?? []), ...values as SemanticTarget[]])]
      if (word === '--target' && values.length === 1) parsed.target = values[0] as SemanticTarget
    } else if (word === '--from') {
      parsed.from = value
    } else if (word === '--name') {
      if (value.trim().length === 0) throw new TypeError('--name must be non-empty')
      parsed.name = value
    } else throw new TypeError(`unknown refine option: ${word}`)
  }
  return parsed
}

export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  for (const [name, value] of Object.entries({
    taskBudgetMs: config.taskBudgetMs,
    maxLiveMetaSessions: config.evolutionState.maxLiveMetaSessions,
    maxFiles: config.candidateWorkspace.maxFiles,
    maxBytes: config.candidateWorkspace.maxBytes,
    maxDiffBytes: config.candidateWorkspace.maxDiffBytes,
    maxReadBytes: config.candidateWorkspace.maxReadBytes,
    shellTimeoutMs: config.candidateWorkspace.shellTimeoutMs,
    shellOutputBytes: config.candidateWorkspace.shellOutputBytes,
    compilerTimeoutMs: config.compiler.timeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (config.metaSandbox.mode === 'required' && !isAbsolute(config.compiler.command)) {
    throw new TypeError('compiler.command must be an absolute fixed toolchain path when sandboxing is required')
  }
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.dsh-refine')
  const registry = new EvolutionRegistryStore(stateRoot)
  const metaPreset = await ctx.agentPresets.resolve(config.metaPreset)
  await assertMetaPresetIsolation(metaPreset, [config.dshRepository])
  const compiler = new SubprocessHarnessCompiler({
    ...config.compiler, sandboxMode: config.metaSandbox.mode, targetRoot: config.targetRoot,
  })
  const builder = new HarnessBuilder({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    dshBaseRef: config.dshBaseRef,
    toolchainRef: config.toolchainRef,
    sandboxProfileRef: config.sandboxProfileRef,
    allowedImports: config.allowedImports,
    compiler,
  })
  const evaluator = new HitchCliEvaluator({ ...config.hitch, repositoryPath: config.dshRepository })

  let capabilities: RefineCapabilities | undefined
  const notebook = new SessionAwareNotebookRuntime({
    ...(config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable }),
    sandbox: {
      roles: ['refine-meta'],
      mode: config.metaSandbox.mode,
      scratchRoot: join(stateRoot, 'meta-notebooks'),
      protectedPaths: [
        stateRoot,
        config.dshRepository,
        config.heldOutRef,
        config.hitch.root,
        ...(config.seedTasksPath === undefined ? [] : [config.seedTasksPath]),
      ],
    },
    allowedMethods: {
      'refine-meta': [
        'harness.current', 'harness.read', 'seed_tasks.load', 'trajectory.query', 'hitch.status',
        'candidate.diff', 'candidate.check', 'candidate.finalize', 'candidate.decline',
      ],
      target: ['refine.run', 'refine.status'],
      rollout: [],
    },
    bridge: async (method, params, request) => {
      if (capabilities === undefined) throw new Error('refine capabilities are not initialized')
      return capabilities.call(request.role, request.sessionId, method, params, request.signal)
    },
  })
  let workspaceManager: CandidateWorkspaceManager
  const upstreamSubprocess = ctx.subprocess
  const host = new DshMetaAgentHost(ctx, config.metaPreset, config.metaModel, async (agentCtx, sessionId) => {
    const candidateCtx = isolateCandidateProviderContext(agentCtx)
    new CandidateFileSystem(candidateCtx, workspaceManager, sessionId, config.candidateWorkspace.maxReadBytes)
    new CandidateSearchSubprocess(candidateCtx, upstreamSubprocess, workspaceManager, sessionId)
    await candidateCtx.plugin(FsObservationPolicy)
    await candidateCtx.plugin(ToolFs, { readMaxBytes: config.candidateWorkspace.maxReadBytes })
    await candidateCtx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
    if (config.candidateWorkspace.shellEnabled) {
      new CandidateShellExecutor(
        candidateCtx, workspaceManager, sessionId,
        config.candidateWorkspace.shellTimeoutMs, config.candidateWorkspace.shellOutputBytes,
      )
      await candidateCtx.plugin(ToolBash, { enableRunInBackground: false })
    }
    mountNotebookTool(candidateCtx, notebook, 'refine-meta', config.workspaceRoot)
    mountMetaCapabilityTools(candidateCtx, async (sessionId, method, params, signal) => {
      if (capabilities === undefined) throw new Error('refine capabilities are not initialized')
      return capabilities.call('refine-meta', sessionId, method, params, signal)
    })
  })
  workspaceManager = new CandidateWorkspaceManager({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    rootForEvolution: evolutionId => join(registry.evolutionRoot(evolutionId), config.candidateWorkspace.rootName),
    maxFiles: config.candidateWorkspace.maxFiles,
    maxBytes: config.candidateWorkspace.maxBytes,
    maxDiffBytes: config.candidateWorkspace.maxDiffBytes,
  })
  const service = new RefineService(
    registry,
    builder,
    workspaceManager,
    (spec, specDigest, store) => new MetaSessionManager(store, host, {
      evolutionId: spec.evolutionId,
      specDigest,
      metaHarnessRef: spec.metaHarnessRef,
      model: config.metaModel,
      ...(config.metaSampling === undefined ? {} : { sampling: config.metaSampling }),
    }),
    evaluator,
    {
      workspaceRoot: config.workspaceRoot,
      metaHarnessRef: config.metaHarnessRef,
      metaModel: config.metaModel,
      ...(config.metaSampling === undefined ? {} : { metaSampling: config.metaSampling }),
      toolchainRef: config.toolchainRef,
      sandboxProfileRef: config.sandboxProfileRef,
      promotion: config.promotion,
      seedTaskRef: config.seedTaskRef,
      heldOutRef: config.heldOutRef,
      taskBudgetMs: config.taskBudgetMs,
      ...(config.initialChampion === undefined ? {} : { initialChampion: config.initialChampion }),
      publishedPointer: config.evolutionState.publishedPointer,
      maxLiveMetaSessions: config.evolutionState.maxLiveMetaSessions,
    },
  )
  capabilities = new RefineCapabilities(service, builder, sessionId => ctx.agents.get(sessionId as never), {
    ...(config.seedTasksPath === undefined ? {} : { seedTasksPath: config.seedTasksPath }),
    configuredSeedTaskRef: config.seedTaskRef,
    trajectoryReader: evaluator,
    secretValues: config.hitch.passEnv.flatMap(name => {
      const value = process.env[name]
      return value === undefined || value.length === 0 ? [] : [value]
    }),
  })
  const targetWorkers = new TargetWorkerRegistry(service, builder)

  await migrateLegacyState(registry)
  await registry.initialize()
  await builder.initialize()
  if (config.candidateWorkspace.shellEnabled && config.metaSandbox.mode !== 'required') {
    throw new Error('candidateWorkspace.shellEnabled requires the air-gapped Meta sandbox')
  }
  await notebook.initialize()
  if (config.initialChampion !== undefined) {
    const manifest = await builder.readManifest(config.initialChampion.ref)
    if (manifest.digest !== config.initialChampion.manifestDigest) {
      throw new Error('initial champion manifestDigest does not match its exact Git commit')
    }
  }
  await service.initialize()
  ctx.provide('notebookRuntime', notebook)
  ctx.provide('refine', service)
  ctx.provide('targetWorkers', targetWorkers)
  ctx.effect(() => async () => {
    await targetWorkers.dispose()
    await service.dispose()
    await notebook.dispose()
  }, 'refine.dispose()')
  ctx.commands.register({
    name: 'refine',
    description: 'Queue a target harness refinement round.',
    input: { hint: 'optional reason' },
    async handler(invocation) {
      try {
        const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        if (words[0] === 'status') {
          if (words[1] === undefined) return { kind: 'success', text: JSON.stringify(await service.listEvolutions()) }
          return { kind: 'success', text: JSON.stringify(await service.status(words[1], words[2])) }
        }
        if (words[0] === 'continue') {
          if (words[1] === undefined) return { kind: 'error', text: 'usage: /refine continue <evolution-id> [--rounds N] [--focus FOCUS]' }
          const parsed = parseAdmissionInput(words.slice(2))
          if (parsed.seedTaskRef !== undefined || parsed.taskBudgetMs !== undefined || parsed.from !== undefined || parsed.name !== undefined) {
            return { kind: 'error', text: 'continue accepts only --rounds and --focus' }
          }
          const accepted = await service.continueEvolution('command', words[1], {
            ...(parsed.rounds === undefined ? {} : { rounds: parsed.rounds }),
            ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
          })
          return { kind: 'success', text: `queued evolution ${accepted.evolutionId}, batch ${accepted.batchId}, round ${accepted.roundId}` }
        }
        if (words[0] === 'publish') {
          if (words[1] === undefined) return { kind: 'error', text: 'usage: /refine publish <evolution-id> [verified-harness-ref]' }
          await service.publish(words[1], words[2])
          return { kind: 'success', text: `published champion from evolution ${words[1]}` }
        }
        if (words[0] === 'rollback') {
          if (words[1] === undefined || words[2] === undefined) return { kind: 'error', text: 'usage: /refine rollback <evolution-id> <verified-harness-ref>' }
          const champion = await service.rollback(words[1], words[2])
          return { kind: 'success', text: `champion now points to ${champion.ref}` }
        }
        const parsed = parseAdmissionInput(words)
        const accepted = await service.admit('command', {
          ...(parsed.seedTaskRef === undefined ? {} : { seedTaskRef: parsed.seedTaskRef }),
          ...(parsed.rounds === undefined ? {} : { rounds: parsed.rounds }),
          ...(parsed.taskBudgetMs === undefined ? {} : { taskBudgetMs: parsed.taskBudgetMs }),
          ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
          ...(parsed.from === undefined ? {} : { from: parsed.from }),
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
        })
        return { kind: 'success', text: `queued evolution ${accepted.evolutionId}, batch ${accepted.batchId}, round ${accepted.roundId}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
