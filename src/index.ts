import { resolveSearchSettings } from './search/config.js'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as ToolFs from '../assets/gear-tool-fs.js'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import type { DshMetaAgentSpec, EvaluationRerunSelector, MetaAgentSpec, SemanticTarget } from './types.js'
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
import { resolveOffloadingPolicy } from './meta/offloading-policy.js'
import { assertMetaPresetOffloadingCoordinator } from './meta/isolation.js'
import { assertMetaReasoningEffortMatches, validateMetaSampling } from './meta/sampling.js'
import { compatibleSkillMetaAgent } from './meta/controller.js'
import {
  assertMetaPresetComposesCapabilities,
  assertMetaPresetIsolation,
  resolveDshPresetRef,
  resolveDshRuntimeIdentity,
} from './meta/isolation.js'
import { RefineService } from './refine/service.js'
import {
  builtinComponentRef,
  componentRef,
  ComponentRegistry,
  rolloutProviderSemanticDigest,
} from './evolution/components.js'
import { hitchCliImplementation, stableLlmVerifierImplementation } from './evolution/component-identity.js'
import {
  LlmVerifierCandidateAssessor,
  resolveLlmVerifierRuntime,
  type LlmVerifierAssessorConfig,
} from './selection/llm-verifier.js'
import { RefineCapabilities } from './capabilities.js'
import { HitchCliEvaluator } from './evaluator/hitch-cli.js'
import { ConfigSchema, type Config as PluginConfig, type HitchConfig } from './config.js'
import { TargetWorkerRegistry } from './worker/registry.js'
import { skillHarnessIdentity, SkillMetaCoordinator, SkillMetaSessionManager } from './meta/skill.js'
import { SkillCandidateFiles } from './skill/files.js'
import { RefineSkillGateway } from './skill/gateway.js'
import { RefineSkillServer } from './skill/server.js'
import { loadBundledRefineSkill, mountDshRefineSkill } from './skill/dsh.js'
import './context.js'

export * from './types.js'
export * from './objective/index.js'
export * from './config.js'
export * from './capabilities.js'
export * from './harness/builder.js'
export * from './harness/compiler.js'
export * from './harness/check-report.js'
export * from './evaluator/hitch-cli.js'
export * from './meta/session.js'
export * from './meta/controller.js'
export * from './meta/skill.js'
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
export * from './selection/llm-verifier.js'
export * from './candidate/workspace.js'
export * from './candidate/filesystem.js'
export * from './candidate/subprocess.js'
export * from './candidate/shell.js'
export * from './candidate/context.js'
export * from './worker/manager.js'
export * from './worker/registry.js'
export * from './skill/files.js'
export * from './skill/gateway.js'
export * from './skill/server.js'
export * from './skill/client.js'
export * from './skill/control-plane.js'
export * from './skill/dsh.js'

export const name = 'refine'
export const inject = ['agents', 'sessions', 'agentPresets', 'commands', 'tools', 'skills', 'systemPrompt', 'subprocess']
export const Config = ConfigSchema

const SHA256 = /^sha256:[0-9a-f]{64}$/u

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

export function parseContinueInput(words: string[]): {
  roundId?: string
  rounds?: number
  focus?: SemanticTarget[]
} {
  let roundId: string | undefined
  const admissionWords: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (word !== '--round') {
      admissionWords.push(word)
      continue
    }
    const value = words[++index]
    if (value === undefined || value.length === 0 || value.startsWith('--')) throw new TypeError('--round requires a value')
    if (roundId !== undefined) throw new TypeError('--round may only be specified once')
    roundId = value
  }
  const parsed = parseAdmissionInput(admissionWords)
  if (parsed.seedTaskRef !== undefined || parsed.taskBudgetMs !== undefined || parsed.from !== undefined || parsed.name !== undefined) {
    throw new TypeError('continue accepts only --round, --rounds, and --focus')
  }
  if (roundId !== undefined && (parsed.rounds !== undefined || parsed.focus !== undefined)) {
    throw new TypeError('--round cannot be combined with --rounds or --focus')
  }
  return {
    ...(roundId === undefined ? {} : { roundId }),
    ...(parsed.rounds === undefined ? {} : { rounds: parsed.rounds }),
    ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
  }
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
  const components = new ComponentRegistry({ legacyComponentRoots: config.evolutionState.legacyComponentRoots })
  const legacyCandidateBudget = config.candidateGeneration.timeoutMs !== undefined
    && config.candidateGeneration.attemptTimeoutMs === undefined
    && config.candidateGeneration.maxAttemptsPerCandidate === undefined
    && config.candidateGeneration.roundTimeoutMs === undefined
  const candidateAttemptTimeoutMs = config.candidateGeneration.attemptTimeoutMs
    ?? config.candidateGeneration.timeoutMs
    ?? 900_000
  const candidateMaxAttemptsPerCandidate = config.candidateGeneration.maxAttemptsPerCandidate
    ?? (legacyCandidateBudget ? 1 : 2)
  const derivedRoundTimeoutMs = candidateAttemptTimeoutMs
    * candidateMaxAttemptsPerCandidate
    * config.candidateGeneration.maxCandidates
  const candidateRoundTimeoutMs = config.candidateGeneration.roundTimeoutMs
    ?? (legacyCandidateBudget ? config.candidateGeneration.timeoutMs! : derivedRoundTimeoutMs)
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
    candidateAttemptTimeoutMs,
    candidateMaxAttemptsPerCandidate,
    candidateRoundTimeoutMs,
    selectionSurvivors: config.selection.survivors,
    selectionTimeoutMs: config.selection.timeoutMs,
    skillMaxRequestBytes: config.metaAdapter.maxRequestBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  }
  if (config.selection.survivors > config.candidateGeneration.maxCandidates) {
    throw new TypeError('selection.survivors cannot exceed candidateGeneration.maxCandidates')
  }
  if (config.selection.llmVerifier !== undefined) {
    const llmVerifier = config.selection.llmVerifier
    for (const [name, value] of Object.entries({
      nEvaluations: llmVerifier.nEvaluations,
      pivots: llmVerifier.pivots,
      maxWorkers: llmVerifier.maxWorkers,
      maxOutputBytes: llmVerifier.maxOutputBytes,
      maxTrajectoryEvents: llmVerifier.maxTrajectoryEvents,
      maxTrajectoryChars: llmVerifier.maxTrajectoryChars,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`selection.llmVerifier.${name} must be a positive safe integer`)
    }
    if (!Number.isSafeInteger(llmVerifier.seed) || llmVerifier.seed < 0) {
      throw new TypeError('selection.llmVerifier.seed must be a non-negative safe integer')
    }
    if (!isAbsolute(llmVerifier.pythonExecutable) || llmVerifier.model.length === 0
      || Object.keys(llmVerifier.criteria).length === 0
      || Object.values(llmVerifier.criteria).some(value => value.length === 0)
      || llmVerifier.passEnv.some(name => !/^[A-Z_][A-Z0-9_]*$/u.test(name))) {
      throw new TypeError('selection.llmVerifier requires an absolute Python executable, model, and criteria')
    }
  }
  if (config.metaModel.provider === undefined || config.metaModel.provider.length === 0
    || config.metaModel.model === undefined || config.metaModel.model.length === 0) {
    throw new TypeError('metaModel.provider and metaModel.model are required')
  }
  if (config.metaAdapter.kind === 'skill' && config.metaPreset !== undefined) {
    throw new TypeError('metaPreset is only valid when metaAdapter.kind="dsh"; remove it for skill mode')
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
  validateMetaSampling(config.metaSampling)
  if (config.metaSandbox.mode === 'required' && !isAbsolute(config.compiler.command)) {
    throw new TypeError('compiler.command must be an absolute fixed toolchain path when sandboxing is required')
  }
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.dsh-refine')
  const registry = new EvolutionRegistryStore(stateRoot)
  let metaAgent: MetaAgentSpec
  if (config.metaAdapter.kind === 'dsh') {
    if (config.metaPreset === undefined || config.metaPreset.length === 0) {
      throw new TypeError('metaPreset is required when metaAdapter.kind="dsh"')
    }
    const metaPreset = await ctx.agentPresets.resolve(config.metaPreset)
    await assertMetaPresetIsolation(metaPreset, [config.dshRepository])
    await assertMetaPresetComposesCapabilities(metaPreset)
    const contextOffloading = config.metaContextOffloading === undefined ? undefined : resolveOffloadingPolicy(
      config.metaContextOffloading,
      config.metaContextOffloading.contextWindow === undefined && config.metaContextOffloading.mode === 'proactive'
        ? (await ctx.llm.resolveModelInfo(config.metaModel.provider, config.metaModel.model)).context?.contextWindow
        : undefined,
    )
    if (contextOffloading !== undefined) await assertMetaPresetOffloadingCoordinator(metaPreset)
    metaAgent = {
      runtime: await resolveDshRuntimeIdentity(),
      preset: await resolveDshPresetRef(metaPreset),
      model: {
        provider: config.metaModel.provider,
        model: config.metaModel.model,
        ...(config.metaModel.maxTokens === undefined ? {} : { maxTokens: config.metaModel.maxTokens }),
      },
      sampling: { ...config.metaSampling },
      ...(contextOffloading === undefined ? {} : { contextOffloading }),
    }
  } else {
    if (config.metaContextOffloading !== undefined) throw new Error('metaContextOffloading requires metaAdapter.kind="dsh"')
    const configuredIdentity = {
      runtimeType: config.metaAdapter.runtimeType,
      runtimeVersion: config.metaAdapter.runtimeVersion,
      runtimeIntegrity: config.metaAdapter.runtimeIntegrity,
      harnessId: config.metaAdapter.harnessId,
      harnessDigest: config.metaAdapter.harnessDigest,
    }
    const hasConfiguredIdentity = Object.values(configuredIdentity).some(value => value !== undefined)
    let runtime: MetaAgentSpec['runtime']
    let preset: MetaAgentSpec['preset']
    if (!hasConfiguredIdentity) {
      const [dshRuntime, skill] = await Promise.all([
        resolveDshRuntimeIdentity(),
        loadBundledRefineSkill(),
      ])
      runtime = dshRuntime
      preset = {
        id: skill.name,
        digest: skill.digest,
        resources: skill.resources,
      }
    } else {
      for (const [name, value] of Object.entries({
        runtimeType: config.metaAdapter.runtimeType,
        runtimeVersion: config.metaAdapter.runtimeVersion,
        harnessId: config.metaAdapter.harnessId,
      })) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError(`metaAdapter.${name} is required in configured skill mode`)
      }
      if (!SHA256.test(config.metaAdapter.runtimeIntegrity ?? '')) throw new TypeError('metaAdapter.runtimeIntegrity must be sha256 in configured skill mode')
      if (!SHA256.test(config.metaAdapter.harnessDigest ?? '')) throw new TypeError('metaAdapter.harnessDigest must be sha256 in configured skill mode')
      runtime = {
        type: config.metaAdapter.runtimeType!,
        version: config.metaAdapter.runtimeVersion!,
        integrity: config.metaAdapter.runtimeIntegrity!,
      }
      preset = {
        id: config.metaAdapter.harnessId!,
        digest: config.metaAdapter.harnessDigest!,
        resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: config.metaAdapter.harnessDigest! }],
      }
      if (runtime.type === 'dsh') {
        const skill = await loadBundledRefineSkill()
        if (preset.id !== skill.name || preset.digest !== skill.digest) {
          throw new Error('DSH skill mode must use the packaged refine skill identity')
        }
        preset.resources = skill.resources
      }
    }
    metaAgent = {
      runtime,
      preset,
      model: {
        provider: config.metaModel.provider,
        model: config.metaModel.model,
        ...(config.metaModel.maxTokens === undefined ? {} : { maxTokens: config.metaModel.maxTokens }),
      },
      sampling: { ...config.metaSampling },
    }
  }
  const candidateGeneration = {
    strategy: builtinComponentRef(
      'candidate-generator',
      config.metaAdapter.kind === 'dsh' ? 'dsh-meta-forked-proposals' : 'meta-forked-proposals',
      {},
    ),
    maxCandidates: config.candidateGeneration.maxCandidates,
    budget: {
      ...(config.candidateGeneration.maxModelRequests === undefined ? {} : { maxModelRequests: config.candidateGeneration.maxModelRequests }),
      ...(config.candidateGeneration.maxTokens === undefined ? {} : { maxTokens: config.candidateGeneration.maxTokens }),
      attemptTimeoutMs: candidateAttemptTimeoutMs,
      maxAttemptsPerCandidate: candidateMaxAttemptsPerCandidate,
      roundTimeoutMs: candidateRoundTimeoutMs,
      ...(config.candidateGeneration.finalizationReserveMs === undefined ? {} : { finalizationReserveMs: config.candidateGeneration.finalizationReserveMs }),
    },
  }
  const rolloutProvider = componentRef('rollout-provider', 'hitch-cli', hitchCliImplementation(), structuredClone(config.hitch))
  const rolloutAgentConfig = { agentArgs: [...config.hitch.agentArgs] }
  const rollout = {
    provider: rolloutProvider,
    providerSemanticDigest: rolloutProviderSemanticDigest(
      rolloutProvider,
      { harnessId: config.hitch.harnessId },
      rolloutAgentConfig,
    ),
    taskSampler: builtinComponentRef('task-sampler', 'dataset', {}),
    repetitions: config.hitch.attempts,
    ...(config.hitch.seeds === undefined || config.hitch.seeds.length === 0 ? {} : { seeds: [...config.hitch.seeds] }),
    model: config.hitch.model,
    sampling: { ...config.hitch.sampling },
    agentConfig: rolloutAgentConfig,
  }
  components.registerRolloutProvider('hitch-cli', rollout.provider.implementation, ref => ({
    ref,
    createEvaluator: spec => new HitchCliEvaluator({
      ...(spec.rollout.provider.config as unknown as HitchConfig),
      repositoryPath: config.dshRepository,
    }),
  }))
  const evaluation = {
    ...(config.evaluationMode === undefined ? {} : { mode: config.evaluationMode }),
    judges: [builtinComponentRef('judge', 'task-reward', {})],
    primaryMetric: 'primaryReward',
  }
  let selectionAssessor = builtinComponentRef('candidate-assessor', 'evaluation-metrics', {})
  if (config.selection.llmVerifier !== undefined) {
    const configured = config.selection.llmVerifier
    const assessorConfig: LlmVerifierAssessorConfig = {
      pythonExecutable: configured.pythonExecutable,
      runtime: await resolveLlmVerifierRuntime(configured.pythonExecutable),
      model: configured.model,
      criteria: structuredClone(configured.criteria),
      ...(configured.groundTruthNote === undefined ? {} : { groundTruthNote: configured.groundTruthNote }),
      nEvaluations: configured.nEvaluations,
      pivots: configured.pivots,
      seed: configured.seed,
      maxWorkers: configured.maxWorkers,
      maxOutputBytes: configured.maxOutputBytes,
      maxTrajectoryEvents: configured.maxTrajectoryEvents,
      maxTrajectoryChars: configured.maxTrajectoryChars,
      passEnv: [...configured.passEnv],
    }
    const implementation = stableLlmVerifierImplementation()
    selectionAssessor = componentRef('candidate-assessor', 'llm-verifier', implementation, assessorConfig)
    components.registerCandidateAssessor('llm-verifier', implementation, ref => new LlmVerifierCandidateAssessor(ref))
  }
  const selection = {
    assessor: selectionAssessor,
    strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}),
    survivors: config.selection.survivors,
    timeoutMs: config.selection.timeoutMs,
  }
  const promotion = {
    policy: builtinComponentRef('promotion-policy', 'paired-gate', structuredClone(config.promotion)),
  }
  const compiler = new SubprocessHarnessCompiler({
    ...config.compiler, sandboxMode: config.metaSandbox.mode,
    linuxIsolation: config.metaSandbox.linuxIsolation, targetRoot: config.targetRoot,
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
      linuxIsolation: config.metaSandbox.linuxIsolation,
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
        config.metaSandbox.linuxIsolation,
      )
      await candidateCtx.plugin(ToolBash, { enableRunInBackground: false })
    }
    mountNotebookTool(candidateCtx, notebook, 'refine-meta', config.workspaceRoot)
    mountMetaCapabilityTools(candidateCtx, async (sessionId, method, params, signal) => {
      if (capabilities === undefined) throw new Error('refine capabilities are not initialized')
      return capabilities.call('refine-meta', sessionId, method, params, signal)
    }, {
      shellEnabled: config.candidateWorkspace.shellEnabled,
    })
  }, sessionId => notebook.disposeSession(sessionId))
  workspaceManager = new CandidateWorkspaceManager({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    rootForEvolution: evolutionId => join(registry.evolutionRoot(evolutionId), config.candidateWorkspace.rootName),
    maxFiles: config.candidateWorkspace.maxFiles,
    maxBytes: config.candidateWorkspace.maxBytes,
    maxDiffBytes: config.candidateWorkspace.maxDiffBytes,
  })
  const skillCoordinator = new SkillMetaCoordinator()
  const validateEvolutionRuntime = async (spec: import('./types.js').EvolutionSpec): Promise<void> => {
    if (config.metaAdapter.kind === 'dsh') {
      if (spec.metaAgent.runtime.type !== 'dsh') throw new Error('evolution requires a different Meta harness adapter')
      assertMetaReasoningEffortMatches(spec.metaAgent.sampling, config.metaSampling)
      const currentPreset = await ctx.agentPresets.resolve(spec.metaAgent.preset.id)
      await assertMetaPresetIsolation(currentPreset, [config.dshRepository])
      await assertMetaPresetComposesCapabilities(currentPreset)
      if (spec.metaAgent.contextOffloading !== undefined) await assertMetaPresetOffloadingCoordinator(currentPreset)
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
    } else if (!compatibleSkillMetaAgent(spec.metaAgent, metaAgent)) {
      throw new Error('skill Meta harness identity changed; evolution cannot continue')
    }
    if (config.metaAdapter.kind === 'skill' && metaAgent.runtime.type === 'dsh'
      && (await loadBundledRefineSkill()).digest !== spec.metaAgent.preset.digest) {
      throw new Error('packaged refine skill changed; evolution cannot continue')
    }
    if (spec.selection.assessor.id === 'llm-verifier') {
      const assessorConfig = spec.selection.assessor.config as LlmVerifierAssessorConfig
      const currentVerifier = await resolveLlmVerifierRuntime(assessorConfig.pythonExecutable)
      if (JSON.stringify(currentVerifier) !== JSON.stringify(assessorConfig.runtime)) {
        throw new Error('llm-verifier runtime identity changed; evolution cannot continue')
      }
    }
  }
  const secretValues = [...new Set([
    ...config.hitch.passEnv,
    ...(config.selection.llmVerifier?.passEnv ?? []),
  ])].flatMap(name => {
    const value = process.env[name]
    return value === undefined || value.length === 0 ? [] : [value]
  })
  const service = new RefineService(
    registry,
    builder,
    workspaceManager,
    async (spec, specDigest, store) => {
      await validateEvolutionRuntime(spec)
      if (config.metaAdapter.kind === 'skill') {
        return new SkillMetaSessionManager(store, skillCoordinator, {
          evolutionId: spec.evolutionId,
          specDigest,
          metaAgent: spec.metaAgent,
        }, secretValues)
      }
      return new MetaSessionManager(store, host, {
        evolutionId: spec.evolutionId,
        specDigest,
        metaAgent: spec.metaAgent as DshMetaAgentSpec,
      })
    },
    evaluator,
    {
      workspaceRoot: config.workspaceRoot,
      metaAgent,
      ...(config.datasetStorage ? { datasetStorage: config.datasetStorage } : {}),
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
      ...(config.search === undefined ? {} : { searchSettings: resolveSearchSettings(config)! }),
      publishedPointer: config.evolutionState.publishedPointer,
      maxLiveMetaSessions: config.evolutionState.maxLiveMetaSessions,
      experienceMemoryEnabled: config.metaAdapter.kind === 'skill',
      validateRuntime: validateEvolutionRuntime,
    },
    components,
  )
  capabilities = new RefineCapabilities(service, builder, {
    ...(config.seedTasksPath === undefined ? {} : { seedTasksPath: config.seedTasksPath }),
    configuredSeedTaskRef: config.seedTaskRef,
    trajectoryReader: evaluator,
    maxTrajectoryPageBytes: config.candidateWorkspace.maxReadBytes,
    maxFailureBundleBytes: config.candidateWorkspace.maxReadBytes,
    ...(config.hitch.trajectoryCacheEntries === undefined ? {} : {
      maxTrajectoryCacheEntries: config.hitch.trajectoryCacheEntries,
    }),
    ...(config.hitch.trajectoryCacheBytes === undefined ? {} : {
      maxTrajectoryProjectionCacheBytes: config.hitch.trajectoryCacheBytes,
    }),
    ...(config.hitch.allowUnavailableVerifierDiagnosis === undefined ? {} : {
      allowUnavailableVerifierDiagnosis: config.hitch.allowUnavailableVerifierDiagnosis,
    }),
    secretValues,
  })
  const skillGateway = config.metaAdapter.kind === 'skill'
    ? new RefineSkillGateway(
        service,
        skillCoordinator,
        capabilities,
        new SkillCandidateFiles(workspaceManager, { maxReadBytes: config.candidateWorkspace.maxReadBytes }),
        { maxRequestBytes: config.metaAdapter.maxRequestBytes },
      )
    : undefined
  const skillServer = skillGateway === undefined
    ? undefined
    : new RefineSkillServer(
        config.metaAdapter.socketPath ?? join(stateRoot, 'refine.sock'),
        skillGateway,
      )
  const targetWorkers = new TargetWorkerRegistry(service, builder)

  const disposeRuntime = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const dispose of [
      async () => skillServer?.dispose(),
      async () => targetWorkers.dispose(),
      async () => service.dispose(),
      async () => notebook.dispose(),
    ]) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose refine runtime')
  }

  try {
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
    if (skillGateway !== undefined && metaAgent.runtime.type === 'dsh') {
      await mountDshRefineSkill(ctx, skillGateway, skillHarnessIdentity(metaAgent))
    }
    await skillServer?.start()
  } catch (error) {
    await disposeRuntime().catch(() => {})
    throw error
  }
  ctx.provide('notebookRuntime', notebook)
  ctx.provide('refine', service)
  ctx.provide('targetWorkers', targetWorkers)
  ctx.provide('evolutionComponents', components)
  ctx.effect(() => disposeRuntime, 'refine.dispose()')
  if (config.metaAdapter.kind === 'dsh') {
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
            if (words[1] === undefined) return { kind: 'error', text: 'usage: /refine continue <evolution-id> (--round ROUND-ID | [--rounds N] [--focus FOCUS])' }
            const parsed = parseContinueInput(words.slice(2))
            const accepted = await service.continueEvolution('command', words[1], {
              ...(parsed.roundId === undefined ? {} : { roundId: parsed.roundId }),
              ...(parsed.rounds === undefined ? {} : { rounds: parsed.rounds }),
              ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
            })
            return parsed.roundId === undefined
              ? { kind: 'success', text: `queued evolution ${accepted.evolutionId}, batch ${accepted.batchId}, round ${accepted.roundId}` }
              : { kind: 'success', text: `continuing existing round ${accepted.roundId} in evolution ${accepted.evolutionId} from held-out evaluation` }
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
}
