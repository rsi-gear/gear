import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import type { EvaluationRerunSelector, SemanticTarget } from './types.js'
import type {} from '@deepseek-ai/dsh-commands'
import { HarnessBuilder } from './harness/builder.js'
import { SubprocessHarnessCompiler } from './harness/compiler.js'
import { EvolutionRegistryStore } from './state/evolution.js'
import { CandidateWorkspaceManager } from './candidate/workspace.js'
import { CandidateFileSystem } from './candidate/filesystem.js'
import { CandidateSearchSubprocess } from './candidate/subprocess.js'
import { CandidateShellExecutor } from './candidate/shell.js'
import { isolateCandidateProviderContext } from './candidate/context.js'
import { SessionAwareNotebookRuntime } from './notebook/runtime.js'
import { mountMetaCapabilityTools, mountNotebookTool } from './notebook/tool.js'
import { DshMetaAgentHost, MetaSessionManager } from './meta/session.js'
import { assertMetaPresetIsolation, resolveDshPresetRef, resolveDshRuntimeIdentity } from './meta/isolation.js'
import { RefineService } from './refine/service.js'
import { builtinComponentRef, ComponentRegistry } from './evolution/components.js'
import { RefineCapabilities } from './capabilities.js'
import { HitchCliEvaluator } from './evaluator/hitch-cli.js'
import { ConfigSchema, type Config as PluginConfig, type HitchConfig } from './config.js'
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
export * from './state/digest.js'
export * from './state/experiments.js'
export * from './evolution/components.js'
export * from './candidate/workspace.js'
export * from './candidate/filesystem.js'
export * from './candidate/subprocess.js'
export * from './candidate/shell.js'
export * from './candidate/context.js'
export * from './worker/manager.js'
export * from './worker/registry.js'

export const name = 'refine'
export const inject = ['agents', 'sessions', 'agentPresets', 'commands', 'tools', 'systemPrompt', 'subprocess']
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

export function parseEvaluationRerunInput(words: string[]): {
  evolutionId: string
  roundId: string
  evalId: string
  selector: EvaluationRerunSelector
} {
  const evolutionId = words[0]
  const roundId = words[1]
  if (evolutionId === undefined || roundId === undefined) {
    throw new TypeError('usage: /refine rerun <evolution-id> <round-id> --eval <eval-id> (--invalid | --task NAME...)')
  }
  let evalId: string | undefined
  let invalid = false
  const taskNames: string[] = []
  for (let index = 2; index < words.length; index += 1) {
    const word = words[index]!
    if (word === '--invalid') { invalid = true; continue }
    const value = words[++index]
    if (value === undefined) throw new TypeError(`${word} requires a value`)
    if (word === '--eval') evalId = value
    else if (word === '--task') taskNames.push(value)
    else throw new TypeError(`unknown refine rerun option: ${word}`)
  }
  if (evalId === undefined || !/^eval_[0-9a-f]{32}$/u.test(evalId)) throw new TypeError('--eval requires a Hitch eval id')
  if (invalid === (taskNames.length > 0)) throw new TypeError('refine rerun requires exactly one of --invalid or --task')
  return {
    evolutionId,
    roundId,
    evalId,
    selector: invalid ? { mode: 'invalid' } : { mode: 'tasks', taskNames: [...new Set(taskNames)] },
  }
}

export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const components = new ComponentRegistry()
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
    candidateMaxCandidates: config.candidateGeneration.maxCandidates,
    candidateGenerationTimeoutMs: config.candidateGeneration.timeoutMs,
    selectionSurvivors: config.selection.survivors,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (config.selection.survivors > config.candidateGeneration.maxCandidates) {
    throw new TypeError('selection.survivors cannot exceed candidateGeneration.maxCandidates')
  }
  if (config.metaModel.provider === undefined || config.metaModel.provider.length === 0
    || config.metaModel.model === undefined || config.metaModel.model.length === 0) {
    throw new TypeError('metaModel.provider and metaModel.model are required')
  }
  if (config.hitch.model.length === 0) throw new TypeError('hitch.model is required for reproducible rollout plans')
  for (const [name, value] of Object.entries({
    candidateMaxModelRequests: config.candidateGeneration.maxModelRequests,
    candidateMaxTokens: config.candidateGeneration.maxTokens,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (config.metaSampling.temperature !== undefined
    && (!Number.isFinite(config.metaSampling.temperature) || config.metaSampling.temperature < 0 || config.metaSampling.temperature > 2)) {
    throw new TypeError('metaSampling.temperature must be between 0 and 2')
  }
  if (config.metaSandbox.mode === 'required' && !isAbsolute(config.compiler.command)) {
    throw new TypeError('compiler.command must be an absolute fixed toolchain path when sandboxing is required')
  }
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.dsh-refine')
  const registry = new EvolutionRegistryStore(stateRoot)
  const metaPreset = await ctx.agentPresets.resolve(config.metaPreset)
  await assertMetaPresetIsolation(metaPreset, [config.dshRepository])
  const resolvedMetaPreset = await resolveDshPresetRef(metaPreset)
  const dshRuntime = await resolveDshRuntimeIdentity()
  const metaAgent = {
    runtime: dshRuntime,
    preset: resolvedMetaPreset,
    model: {
      provider: config.metaModel.provider,
      model: config.metaModel.model,
      ...(config.metaModel.maxTokens === undefined ? {} : { maxTokens: config.metaModel.maxTokens }),
    },
    sampling: { ...config.metaSampling },
  }
  const candidateGeneration = {
    strategy: builtinComponentRef('candidate-generator', 'dsh-meta-forked-proposals', {}),
    maxCandidates: config.candidateGeneration.maxCandidates,
    budget: {
      ...(config.candidateGeneration.maxModelRequests === undefined ? {} : { maxModelRequests: config.candidateGeneration.maxModelRequests }),
      ...(config.candidateGeneration.maxTokens === undefined ? {} : { maxTokens: config.candidateGeneration.maxTokens }),
      timeoutMs: config.candidateGeneration.timeoutMs,
    },
  }
  const rollout = {
    provider: builtinComponentRef('rollout-provider', 'hitch-cli', structuredClone(config.hitch)),
    taskSampler: builtinComponentRef('task-sampler', 'dataset', {}),
    repetitions: config.hitch.attempts,
    ...(config.hitch.seeds === undefined || config.hitch.seeds.length === 0 ? {} : { seeds: [...config.hitch.seeds] }),
    model: config.hitch.model,
    sampling: { ...config.hitch.sampling },
    agentConfig: { agentArgs: [...config.hitch.agentArgs] },
  }
  components.registerRolloutProvider('hitch-cli', rollout.provider.implementation, ref => ({
    ref,
    createEvaluator: spec => new HitchCliEvaluator({
      ...(spec.rollout.provider.config as unknown as HitchConfig),
      repositoryPath: config.dshRepository,
    }),
  }))
  const evaluation = {
    judges: [builtinComponentRef('judge', 'task-reward', {})],
    primaryMetric: 'primaryReward',
  }
  const selection = {
    strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}),
    survivors: config.selection.survivors,
  }
  const promotion = {
    policy: builtinComponentRef('promotion-policy', 'paired-gate', structuredClone(config.promotion)),
  }
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
  const host = new DshMetaAgentHost(ctx, async (agentCtx, sessionId) => {
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
  const validateMetaRuntime = async (spec: import('./types.js').EvolutionSpec): Promise<void> => {
    const currentPreset = await ctx.agentPresets.resolve(spec.metaAgent.preset.id)
    await assertMetaPresetIsolation(currentPreset, [config.dshRepository])
    const currentIdentity = await resolveDshPresetRef(currentPreset)
    if (currentIdentity.digest !== spec.metaAgent.preset.digest) {
      throw new Error('Meta preset content changed; evolution cannot continue')
    }
    const currentRuntime = await resolveDshRuntimeIdentity()
    if (spec.metaAgent.runtime.type !== currentRuntime.type
      || spec.metaAgent.runtime.version !== currentRuntime.version
      || spec.metaAgent.runtime.integrity !== currentRuntime.integrity) {
      throw new Error('DSH Meta runtime identity changed; evolution cannot continue')
    }
  }
  const service = new RefineService(
    registry,
    builder,
    workspaceManager,
    async (spec, specDigest, store) => {
      await validateMetaRuntime(spec)
      return new MetaSessionManager(store, host, { evolutionId: spec.evolutionId, specDigest, metaAgent: spec.metaAgent })
    },
    evaluator,
    {
      workspaceRoot: config.workspaceRoot,
      metaAgent,
      candidateGeneration,
      rollout,
      evaluation,
      selection,
      promotion,
      toolchainRef: config.toolchainRef,
      sandboxProfileRef: config.sandboxProfileRef,
      seedTaskRef: config.seedTaskRef,
      heldOutRef: config.heldOutRef,
      taskBudgetMs: config.taskBudgetMs,
      ...(config.initialChampion === undefined ? {} : { initialChampion: config.initialChampion }),
      publishedPointer: config.evolutionState.publishedPointer,
      maxLiveMetaSessions: config.evolutionState.maxLiveMetaSessions,
      validateRuntime: validateMetaRuntime,
    },
    components,
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
  ctx.provide('evolutionComponents', components)
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
        if (words[0] === 'rerun') {
          const parsed = parseEvaluationRerunInput(words.slice(1))
          const result = await service.rerunEvaluation(parsed.evolutionId, parsed.roundId, parsed.evalId, parsed.selector)
          return {
            kind: 'success',
            text: result.evalStatus === 'succeeded'
              ? `repaired eval ${result.evalId}; continuing round ${parsed.roundId}`
              : `reran ${result.selectedTasks.join(', ') || 'no tasks'}; remaining invalid: ${
                result.remainingInvalidTrials?.map(slot => `${slot.taskId}#${slot.attempt}`).join(', ')
                  || result.remainingInvalidTasks.join(', ')
                  || 'unknown'
              }`,
          }
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
