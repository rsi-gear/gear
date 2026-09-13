import { isAbsolute, join } from 'node:path'
import { RefineCapabilities } from '../capabilities.js'
import { CandidateWorkspaceManager } from '../candidate/workspace.js'
import type { Config, HitchConfig } from '../config.js'
import {
  builtinComponentRef,
  componentRef,
  ComponentRegistry,
  rolloutProviderSemanticDigest,
} from '../evolution/components.js'
import { hitchCliImplementation, stableLlmVerifierImplementation } from '../evolution/component-identity.js'
import { HitchCliEvaluator } from '../evaluator/hitch-cli.js'
import { HarnessBuilder, type HarnessCompiler } from '../harness/builder.js'
import { SubprocessHarnessCompiler } from '../harness/compiler.js'
import { acquireAirGappedSandbox } from '../sandbox.js'
import { SkillMetaCoordinator, SkillMetaSessionManager } from '../meta/skill.js'
import { compatibleSkillMetaAgent } from '../meta/controller.js'
import { validateMetaSampling } from '../meta/sampling.js'
import { RefineService } from '../refine/service.js'
import {
  LlmVerifierCandidateAssessor,
  resolveLlmVerifierRuntime,
  type LlmVerifierAssessorConfig,
} from '../selection/llm-verifier.js'
import { EvolutionRegistryStore } from '../state/evolution.js'
import type { HitchTrajectoryReader, MetaAgentSpec, RefineEvaluator } from '../types.js'
import { SkillCandidateFiles } from './files.js'
import { RefineSkillGateway } from './gateway.js'
import { RefineSkillServer } from './server.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u

export interface SkillControlPlaneDependencies {
  evaluator?: RefineEvaluator & Partial<HitchTrajectoryReader>
  compiler?: HarnessCompiler
  components?: ComponentRegistry
}

export interface SkillControlPlane {
  service: RefineService
  gateway: RefineSkillGateway
  server: RefineSkillServer
  socketPath: string
  dispose(): Promise<void>
}

function positive(value: number | undefined, name: string, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return selected
}

export function skillMetaAgent(config: Config): MetaAgentSpec {
  if (config.metaAdapter.kind !== 'skill') throw new TypeError('standalone Gear requires metaAdapter.kind="skill"')
  if (config.metaPreset !== undefined) throw new TypeError('metaPreset is not valid in standalone skill mode')
  validateMetaSampling(config.metaSampling)
  const fields = {
    runtimeType: config.metaAdapter.runtimeType,
    runtimeVersion: config.metaAdapter.runtimeVersion,
    harnessId: config.metaAdapter.harnessId,
  }
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`metaAdapter.${name} is required`)
  }
  if (!SHA256.test(config.metaAdapter.runtimeIntegrity ?? '')) throw new TypeError('metaAdapter.runtimeIntegrity must be sha256')
  if (!SHA256.test(config.metaAdapter.harnessDigest ?? '')) throw new TypeError('metaAdapter.harnessDigest must be sha256')
  if (config.metaModel.provider === undefined || config.metaModel.provider.length === 0
    || config.metaModel.model === undefined || config.metaModel.model.length === 0) {
    throw new TypeError('metaModel.provider and metaModel.model are required')
  }
  const harnessDigest = config.metaAdapter.harnessDigest!
  return {
    runtime: {
      type: config.metaAdapter.runtimeType!,
      version: config.metaAdapter.runtimeVersion!,
      integrity: config.metaAdapter.runtimeIntegrity!,
    },
    preset: {
      id: config.metaAdapter.harnessId!,
      digest: harnessDigest,
      resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: harnessDigest }],
    },
    model: {
      provider: config.metaModel.provider,
      model: config.metaModel.model,
      ...(config.metaModel.maxTokens === undefined ? {} : { maxTokens: config.metaModel.maxTokens }),
    },
    sampling: { ...config.metaSampling },
  }
}

/** Build the full Gear control plane without a DSH Context. */
export async function createSkillControlPlane(
  config: Config,
  dependencies: SkillControlPlaneDependencies = {},
): Promise<SkillControlPlane> {
  const metaAgent = skillMetaAgent(config)
  if (config.hitch.model.length === 0) throw new TypeError('hitch.model is required for reproducible rollout plans')
  if (config.metaSandbox.mode === 'required' && !isAbsolute(config.compiler.command)) {
    throw new TypeError('compiler.command must be absolute when sandboxing is required')
  }
  const attemptTimeoutMs = positive(
    config.candidateGeneration.attemptTimeoutMs ?? config.candidateGeneration.timeoutMs,
    'candidateGeneration.attemptTimeoutMs',
    900_000,
  )
  const legacyBudget = config.candidateGeneration.timeoutMs !== undefined
    && config.candidateGeneration.attemptTimeoutMs === undefined
    && config.candidateGeneration.maxAttemptsPerCandidate === undefined
    && config.candidateGeneration.roundTimeoutMs === undefined
  const maxAttemptsPerCandidate = positive(
    config.candidateGeneration.maxAttemptsPerCandidate,
    'candidateGeneration.maxAttemptsPerCandidate',
    legacyBudget ? 1 : 2,
  )
  const maxCandidates = positive(config.candidateGeneration.maxCandidates, 'candidateGeneration.maxCandidates', 1)
  const roundTimeoutMs = positive(
    config.candidateGeneration.roundTimeoutMs ?? (legacyBudget ? config.candidateGeneration.timeoutMs : undefined),
    'candidateGeneration.roundTimeoutMs',
    attemptTimeoutMs * maxAttemptsPerCandidate * maxCandidates,
  )
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.gear-refine')
  const registry = new EvolutionRegistryStore(stateRoot)
  const components = dependencies.components ?? new ComponentRegistry({
    legacyComponentRoots: config.evolutionState.legacyComponentRoots,
  })
  const candidateGeneration = {
    strategy: builtinComponentRef('candidate-generator', 'meta-forked-proposals', {}),
    maxCandidates,
    budget: {
      ...(config.candidateGeneration.maxModelRequests === undefined ? {} : { maxModelRequests: config.candidateGeneration.maxModelRequests }),
      ...(config.candidateGeneration.maxTokens === undefined ? {} : { maxTokens: config.candidateGeneration.maxTokens }),
      attemptTimeoutMs,
      maxAttemptsPerCandidate,
      roundTimeoutMs,
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
  const evaluator = dependencies.evaluator ?? new HitchCliEvaluator({ ...config.hitch, repositoryPath: config.dshRepository })
  if (dependencies.evaluator === undefined) {
    components.registerRolloutProvider('hitch-cli', rollout.provider.implementation, ref => ({
      ref,
      createEvaluator: spec => new HitchCliEvaluator({
        ...(spec.rollout.provider.config as unknown as HitchConfig),
        repositoryPath: config.dshRepository,
      }),
    }))
  }
  const evaluation = {
    ...(config.evaluationMode === undefined ? {} : { mode: config.evaluationMode }),
    judges: [builtinComponentRef('judge', 'task-reward', {})],
    primaryMetric: 'primaryReward',
  }
  let selectionAssessor = builtinComponentRef('candidate-assessor', 'evaluation-metrics', {})
  if (config.selection.llmVerifier !== undefined) {
    const selected = config.selection.llmVerifier
    const assessorConfig: LlmVerifierAssessorConfig = {
      pythonExecutable: selected.pythonExecutable,
      runtime: await resolveLlmVerifierRuntime(selected.pythonExecutable),
      model: selected.model,
      criteria: structuredClone(selected.criteria),
      ...(selected.groundTruthNote === undefined ? {} : { groundTruthNote: selected.groundTruthNote }),
      nEvaluations: selected.nEvaluations,
      pivots: selected.pivots,
      seed: selected.seed,
      maxWorkers: selected.maxWorkers,
      maxOutputBytes: selected.maxOutputBytes,
      maxTrajectoryEvents: selected.maxTrajectoryEvents,
      maxTrajectoryChars: selected.maxTrajectoryChars,
      passEnv: [...selected.passEnv],
    }
    const implementation = stableLlmVerifierImplementation()
    selectionAssessor = componentRef('candidate-assessor', 'llm-verifier', implementation, assessorConfig)
    components.registerCandidateAssessor('llm-verifier', implementation, ref => new LlmVerifierCandidateAssessor(ref))
  }
  const compiler = dependencies.compiler ?? new SubprocessHarnessCompiler({
    ...config.compiler,
    sandboxMode: config.metaSandbox.mode,
    linuxIsolation: config.metaSandbox.linuxIsolation,
    targetRoot: config.targetRoot,
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
  const workspaces = new CandidateWorkspaceManager({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    rootForEvolution: evolutionId => join(registry.evolutionRoot(evolutionId), config.candidateWorkspace.rootName),
    maxFiles: positive(config.candidateWorkspace.maxFiles, 'candidateWorkspace.maxFiles', 64),
    maxBytes: positive(config.candidateWorkspace.maxBytes, 'candidateWorkspace.maxBytes', 2 * 1024 * 1024),
    maxDiffBytes: positive(config.candidateWorkspace.maxDiffBytes, 'candidateWorkspace.maxDiffBytes', 1024 * 1024),
  })
  const coordinator = new SkillMetaCoordinator()
  const validateRuntime = async (spec: import('../types.js').EvolutionSpec): Promise<void> => {
    if (!compatibleSkillMetaAgent(spec.metaAgent, metaAgent)) throw new Error('skill Meta harness identity changed; evolution cannot continue')
    if (spec.selection.assessor.id === 'llm-verifier') {
      const assessorConfig = spec.selection.assessor.config as LlmVerifierAssessorConfig
      const current = await resolveLlmVerifierRuntime(assessorConfig.pythonExecutable)
      if (JSON.stringify(current) !== JSON.stringify(assessorConfig.runtime)) throw new Error('llm-verifier runtime identity changed; evolution cannot continue')
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
    workspaces,
    async (spec, specDigest, store) => {
      await validateRuntime(spec)
      return new SkillMetaSessionManager(store, coordinator, {
        evolutionId: spec.evolutionId,
        specDigest,
        metaAgent: spec.metaAgent,
      }, secretValues)
    },
    evaluator,
    {
      workspaceRoot: config.workspaceRoot,
      metaAgent,
      candidateGeneration,
      rollout,
      evaluation,
      selection: {
        assessor: selectionAssessor,
        strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}),
        survivors: positive(config.selection.survivors, 'selection.survivors', 1),
        timeoutMs: positive(config.selection.timeoutMs, 'selection.timeoutMs', 300_000),
      },
      promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', structuredClone(config.promotion)) },
      toolchainRef: config.toolchainRef,
      sandboxProfileRef: config.sandboxProfileRef,
      seedTaskRef: config.seedTaskRef,
      heldOutRef: config.heldOutRef,
      taskBudgetMs: positive(config.taskBudgetMs, 'taskBudgetMs', 3_600_000),
      ...(config.initialChampion === undefined ? {} : { initialChampion: config.initialChampion }),
      publishedPointer: config.evolutionState.publishedPointer,
      maxLiveMetaSessions: positive(config.evolutionState.maxLiveMetaSessions, 'evolutionState.maxLiveMetaSessions', 8),
      validateRuntime,
      ...(dependencies.evaluator === undefined ? {} : { createEvaluator: () => dependencies.evaluator! }),
    },
    components,
  )
  const capabilities = new RefineCapabilities(service, builder, {
    ...(config.seedTasksPath === undefined ? {} : { seedTasksPath: config.seedTasksPath }),
    configuredSeedTaskRef: config.seedTaskRef,
    ...('inspectTrajectoryAnalysis' in evaluator && typeof evaluator.inspectTrajectoryAnalysis === 'function'
      && 'inspectTrajectoryEvents' in evaluator && typeof evaluator.inspectTrajectoryEvents === 'function'
      && 'inspectCapabilities' in evaluator && typeof evaluator.inspectCapabilities === 'function'
      ? { trajectoryReader: evaluator as RefineEvaluator & HitchTrajectoryReader }
      : {}),
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
  const gateway = new RefineSkillGateway(
    service,
    coordinator,
    capabilities,
    new SkillCandidateFiles(workspaces, { maxReadBytes: positive(config.candidateWorkspace.maxReadBytes, 'candidateWorkspace.maxReadBytes', 128 * 1024) }),
    { maxRequestBytes: positive(config.metaAdapter.maxRequestBytes, 'metaAdapter.maxRequestBytes', 1024 * 1024) },
  )
  const socketPath = config.metaAdapter.socketPath ?? join(stateRoot, 'refine.sock')
  const server = new RefineSkillServer(socketPath, gateway)
  const sandboxLease = config.metaSandbox.mode === 'required'
    ? await acquireAirGappedSandbox(config.metaSandbox.linuxIsolation, 'refine compiler')
    : undefined
  try {
    await builder.initialize()
    if (config.initialChampion !== undefined) {
      const manifest = await builder.readManifest(config.initialChampion.ref)
      if (manifest.digest !== config.initialChampion.manifestDigest) throw new Error('initial champion manifestDigest does not match its exact Git commit')
    }
    await service.initialize()
    await server.start()
  } catch (error) {
    await service.dispose().catch(() => {})
    await sandboxLease?.release()
    throw error
  }
  let disposed = false
  return {
    service,
    gateway,
    server,
    socketPath,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await server.dispose()
      } finally {
        try {
          await service.dispose()
        } finally {
          await sandboxLease?.release()
        }
      }
    },
  }
}
