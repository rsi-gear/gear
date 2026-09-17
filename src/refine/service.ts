import { resolveParentPolicyRef } from '../search/policies/parents.js'
import { isAbsolute } from 'node:path'
import type { CandidateWorkspaceHandle, CandidateWorkspaceManager } from '../candidate/workspace.js'
import { ComponentRegistry } from '../evolution/components.js'
import type { HarnessBuilder } from '../harness/builder.js'
import { SubstrateExpansionError } from '../harness/builder.js'
import type { MetaSessionController } from '../meta/controller.js'
import { MetaContextError } from '../meta/offloading-policy.js'
import { MetaOffloadingStore, type MetaExecutionState } from '../meta/offloading-store.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson, type EvolutionRegistryStore } from '../state/evolution.js'
import type { RefineStateStore, WorkspaceLock } from '../state/store.js'
import type {
  AdmissionResult, CandidateAssessment, CandidateAssessmentResult, CandidateDecline, CandidateDiffSummary, CandidateFinalization, CandidateRecord, ChampionState,
  CandidateGenerationAttempt, CandidateGenerationSpec, ComponentRef, MetaAgentSpec, EvaluationEvidence, EvaluationRequest, EvaluationRerunResult, EvaluationRerunSelector, EvolutionRegistryEntry, EvolutionSpec, MetaAttribution,
  HitchTrajectoryReader, MetaCheckpointRef, MetaTurnObservation, MetricSet, PairedTrial, PairingAudit, PopulationState, ProposalEvidenceAudit, PromotionPolicy, PublicSeedEvidence, PublicRoundStatus,
  RefineEvaluator, RefinementRound, RefinementFailure, RolloutSpec, RoundEvaluation, RoundEvaluationAttempt, SemanticTarget, PopulationMember,
  MetaPrerequisiteFailure,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import type { EvaluationReservation, PendingEvaluationSubmission, EvaluationFailure } from '../types.js'
import { EvaluationCleanupError, evaluationFailure } from '../evaluator/cleanup.js'
import { finalizationReadiness } from './finalization-readiness.js'
import { BaselineReuseBlockedError } from './baseline-reuse.js'
import { generationBudgetSnapshot } from './generation-budget.js'
import { CandidateDiagnosisStore, type CandidateDiagnosisRecord } from '../state/candidate-diagnosis.js'
import { resolveChampionParent } from './champion-parent.js'
import { join } from 'node:path'
import { FailureClusterSearch, type GeneratedCandidate } from '../search/engine.js'
import { SearchStore } from '../search/store.js'
import { seal, validateSettings, invariant } from '../search/contracts.js'
import { legacySearchEvidence } from '../search/legacy.js'
import { resolveRegressionSettings } from '../search/regression.js'
import type { SearchSettings, Snapshot } from '../search/types.js'
import { attachSearchEvaluation } from '../search/evaluation-adapter.js'
import type { CandidateGenerationBudgetStatus } from '../types.js'
import { prepareSeedExperienceSnapshot } from '../experience/memory.js'
import type { ExperienceUsageReader } from '../experience/usage.js'
import { HitchNativeExperienceUsageReader } from '../experience/hitch-native-usage.js'
import {
  parseBaselineSourceRequest,
  prepareBaselineSource,
  validateBaselineSourceSnapshot,
  type BaselineSourceRequest,
  type BaselineSourceSnapshot,
  type PreparedBaselineSource,
} from './baseline-source.js'

export interface RefineServiceOptions {
  searchSettings?: SearchSettings
  workspaceRoot: string
  metaAgent: MetaAgentSpec
  candidateGeneration: CandidateGenerationSpec
  rollout: RolloutSpec
  evaluation: EvolutionSpec['evaluation']
  selection: EvolutionSpec['selection']
  promotion: { policy: ComponentRef<PromotionPolicy> }
  toolchainRef: string
  sandboxProfileRef: string
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  initialChampion?: ChampionState
  publishedPointer: boolean
  maxLiveMetaSessions: number
  /** Enables the sealed V1 policy for newly-created skill-first evolutions. */
  experienceMemoryEnabled?: boolean
  /** Optional read-only observer used to enrich newly prepared experience snapshots. */
  experienceUsageReader?: ExperienceUsageReader
  createEvaluator?: (spec: EvolutionSpec) => RefineEvaluator
  validateRuntime?: (spec: EvolutionSpec) => void | Promise<void>
}

export interface AdmissionOptions {
  seedTaskRef?: string
  rounds?: number
  taskBudgetMs?: number
  focus?: SemanticTarget[]
  from?: 'initial' | 'published' | string
  name?: string
  baselineSource?: BaselineSourceRequest
}

export interface ContinueOptions { rounds?: number; focus?: SemanticTarget[]; roundId?: string }
/** Construct an inert controller; admission inspects capabilities before creating its state directory. */
export type MetaSessionFactory = (
  spec: EvolutionSpec,
  specDigest: string,
  store: RefineStateStore,
) => MetaSessionController | Promise<MetaSessionController>

interface EvolutionRuntime {
  spec: EvolutionSpec
  specDigest: string
  store: RefineStateStore
  meta: MetaSessionController
  evaluator: RefineEvaluator
  lastUsedAt: number
}

interface FinalizationValue {
  finalization: CandidateFinalization | null
  decline?: CandidateDecline
  diff?: CandidateDiffSummary
  meta: MetaAttribution
  evidence: ProposalEvidenceAudit
}

interface CandidateExecution {
  candidateId: string
  abort: AbortController
  signal: AbortSignal
  finalization: PromiseWithResolvers<FinalizationValue>
  finalizationPersisted: PromiseWithResolvers<void>
  finalizationSubmitted: boolean
  workspace?: CandidateWorkspaceHandle
  metaSessionId?: string
  baseline?: EvaluationEvidence
  preserveWorkspace?: boolean
  generationBudget?: CandidateGenerationBudgetStatus
  evidenceWrites?: Set<Promise<void>>
  prerequisiteWrite?: Promise<void>
}

type CandidatePatch = { [Key in keyof CandidateRecord]?: CandidateRecord[Key] | undefined }
type RoundPatch = { [Key in keyof RefinementRound]?: RefinementRound[Key] | undefined }

interface ActiveRound {
  evolution: EvolutionRuntime
  lock: WorkspaceLock
  abort: AbortController
  executions: Map<string, CandidateExecution>
  currentCandidateId?: string
  contextResume?: MetaExecutionState
  batchId: string
  roundIndex: number
  roundCount: number
  advisoryFocus?: SemanticTarget[]
  source: RefinementRound['source']
  repairAttempt?: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>
  resumeHeldOut?: boolean
  drive?: Promise<void>
}

interface ActiveEvaluationRepair {
  evolution: EvolutionRuntime
  roundId: string
  lock: WorkspaceLock
  abort: AbortController
  attempt: RoundEvaluationAttempt
  handedToDrive: boolean
  completion?: Promise<EvaluationRerunResult>
}

interface PendingEvaluationResume {
  evolutionId: string
  roundId: string
  attempt: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>
}

interface ReusableBaseline {
  evidence: EvaluationEvidence
  sourceRoundId: string
  sourceEvolutionId?: string
  currentInvocationFingerprint?: string
}

const TERMINAL = new Set<RefinementRound['status']>(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])
function now(): string { return new Date().toISOString() }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function reuseInvocationAudit(reusable: ReusableBaseline): Pick<RoundEvaluationAttempt, 'reuseAudit'> {
  const source = reusable.evidence.invocationFingerprint
  const current = reusable.currentInvocationFingerprint
  if (source === undefined || current === undefined) return {}
  return {
    reuseAudit: {
      sourceInvocationFingerprint: source,
      currentInvocationFingerprint: current,
      invocationFingerprintChanged: source !== current,
    },
  }
}

class CandidateGenerationTimeoutError extends Error {
  constructor(readonly scope: 'attempt' | 'round', readonly budgetMs: number) {
    super(`candidate generation exceeded its ${budgetMs}ms ${scope} budget`)
    this.name = 'CandidateGenerationTimeoutError'
  }
}

class MetaTurnEndedWithoutProposalError extends Error {
  constructor(readonly observation: MetaTurnObservation) {
    const details = [
      `reason=${observation.reason}`,
      observation.error?.code === undefined ? undefined : `code=${observation.error.code}`,
      observation.effectiveMaxTokens === undefined ? undefined : `effectiveMaxTokens=${observation.effectiveMaxTokens}`,
      observation.usage?.outputTokens === undefined ? undefined : `outputTokens=${observation.usage.outputTokens}`,
      observation.usage?.reasoningTokens === undefined ? undefined : `reasoningTokens=${observation.usage.reasoningTokens}`,
      observation.durationMs === undefined ? undefined : `durationMs=${observation.durationMs}`,
    ].filter((value): value is string => value !== undefined)
    super(`Meta turn ended without candidate.finalize or candidate.decline (${details.join(', ')})${observation.error === undefined ? '' : `: ${observation.error.message}`}`)
    this.name = 'MetaTurnEndedWithoutProposalError'
  }
}

class ExternalMetaFailureError extends Error {
  constructor(readonly reason: string, readonly prerequisite?: MetaPrerequisiteFailure) {
    super(prerequisite === undefined
      ? `external Meta failed: ${reason}`
      : `external Meta blocked: ${prerequisite.code} (${prerequisite.blockedRuns
          .map(item => `${item.runId}:${item.cause ?? item.code}`).join(', ')})`)
    this.name = 'ExternalMetaFailureError'
  }
}

function refinementFailure(phase: string, error: unknown): RefinementFailure {
  return {
    phase,
    message: errorMessage(error),
    ...(error instanceof ExternalMetaFailureError && error.prerequisite !== undefined
      ? { prerequisite: structuredClone(error.prerequisite) }
      : {}),
  }
}

function runningPrerequisite(round: RefinementRound): MetaPrerequisiteFailure | undefined {
  return round.candidatePool.flatMap(candidate => candidate.generationAttempts ?? [])
    .find(attempt => attempt.status === 'running' && attempt.prerequisiteBlocker !== undefined)
    ?.prerequisiteBlocker
}

function preferredFailure(phase: string, error: unknown, round: RefinementRound): RefinementFailure {
  if (error instanceof ExternalMetaFailureError && error.prerequisite !== undefined) {
    return refinementFailure(phase, error)
  }
  const prerequisite = runningPrerequisite(round)
  return refinementFailure(
    phase,
    prerequisite === undefined ? error : new ExternalMetaFailureError(errorMessage(error), prerequisite),
  )
}

function effectiveCandidateGenerationBudget(spec: CandidateGenerationSpec): {
  attemptTimeoutMs: number
  maxAttemptsPerCandidate: number
  roundTimeoutMs: number
} {
  const { budget } = spec
  if (budget.attemptTimeoutMs !== undefined
    && budget.maxAttemptsPerCandidate !== undefined
    && budget.roundTimeoutMs !== undefined) {
    return {
      attemptTimeoutMs: budget.attemptTimeoutMs,
      maxAttemptsPerCandidate: budget.maxAttemptsPerCandidate,
      roundTimeoutMs: budget.roundTimeoutMs,
    }
  }
  if (budget.timeoutMs !== undefined) {
    return { attemptTimeoutMs: budget.timeoutMs, maxAttemptsPerCandidate: 1, roundTimeoutMs: budget.timeoutMs }
  }
  throw new Error('candidate generation budget is incomplete')
}

function patchGenerationAttempt(
  attempts: readonly CandidateGenerationAttempt[],
  attempt: number,
  patch: Partial<CandidateGenerationAttempt>,
): CandidateGenerationAttempt[] {
  let found = false
  const updated = attempts.map(value => {
    if (value.attempt !== attempt) return value
    found = true
    return { ...value, ...patch, attempt: value.attempt }
  })
  if (!found) throw new Error(`unknown candidate generation attempt: ${attempt}`)
  return updated
}

function settleInterruptedCandidateGeneration(
  round: RefinementRound,
  completedAt: string,
  source: string | RefinementFailure,
): CandidateRecord[] {
  return round.candidatePool.map(candidate => {
    if (!candidate.generationAttempts?.some(attempt => attempt.status === 'running')) return candidate
    const prerequisite = candidate.generationAttempts.find(attempt => attempt.status === 'running')?.prerequisiteBlocker
    const baseFailure = typeof source === 'string'
      ? { phase: 'candidate-generation', message: source }
      : { ...source, phase: 'candidate-generation' }
    const failure = prerequisite === undefined || baseFailure.prerequisite !== undefined
      ? baseFailure
      : refinementFailure(
          'candidate-generation',
          new ExternalMetaFailureError(baseFailure.message, prerequisite),
        )
    return {
      ...candidate,
      status: 'failed',
      failure,
      generationAttempts: candidate.generationAttempts.map(attempt => attempt.status !== 'running' ? attempt : {
        ...attempt,
        status: 'failed' as const,
        completedAt,
        failure,
      }),
    }
  })
}

function resumableContextExecutions(
  round: RefinementRound,
  executions: readonly MetaExecutionState[],
): MetaExecutionState[] {
  return executions.filter(execution => execution.roundId === round.roundId
    && execution.candidateId !== undefined
    && execution.recovery !== undefined
    && execution.deadlineAt > Date.now()
    && (execution.status === 'rotating' || execution.status === 'running'
      && (execution.intent?.phase === 'activated' || execution.intent?.phase === 'delivered')))
}

function hasContextRecoveryRoundStage(round: RefinementRound): boolean {
  return ['candidate-editing', 'preparing-candidate', 'baseline-running'].includes(round.status)
}

function contextRecoveryOwnerMatches(
  round: RefinementRound,
  execution: MetaExecutionState,
  specDigest: string,
): boolean {
  return execution.specDigest === specDigest
    && round.candidatePool.some(candidate => candidate.candidateId === execution.candidateId
      && candidate.status === 'generating')
}

function finalizationResolvers(): PromiseWithResolvers<FinalizationValue> {
  const value = Promise.withResolvers<FinalizationValue>()
  void value.promise.catch(() => {})
  return value
}

function completionResolvers(): PromiseWithResolvers<void> {
  const value = Promise.withResolvers<void>()
  void value.promise.catch(() => {})
  return value
}

function normalizeFocus(values: readonly SemanticTarget[] | undefined): SemanticTarget[] | undefined {
  return values === undefined || values.length === 0 ? undefined : [...new Set(values)]
}

function validateCount(rounds: number): number {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new TypeError('rounds must be an integer between 1 and 100')
  return rounds
}

function normalizeEvaluationRerunSelector(selector: EvaluationRerunSelector): EvaluationRerunSelector {
  if (typeof selector !== 'object' || selector === null || Array.isArray(selector)) {
    throw new TypeError('evaluation rerun selector must be an object')
  }
  if (selector.mode === 'invalid') return { mode: 'invalid' }
  if (selector.mode !== 'tasks' || !Array.isArray(selector.taskNames)
    || selector.taskNames.length === 0
    || selector.taskNames.some(task => typeof task !== 'string' || task.trim().length === 0)) {
    throw new TypeError('task evaluation rerun requires at least one non-empty task name')
  }
  return { mode: 'tasks', taskNames: [...new Set(selector.taskNames)] }
}
function trialReward(trial: EvaluationEvidence['trials'][number]): number | undefined {
  return trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

function validMetricSet(value: MetricSet): boolean {
  return Number.isFinite(value.quality) && Number.isFinite(value.taskSuccessRate)
    && [value.cost, value.latency, value.safety, value.trajectoryDiversity]
      .every(metric => metric === undefined || Number.isFinite(metric))
    && (value.descriptors === undefined || Object.values(value.descriptors)
      .every(item => typeof item === 'string' || Number.isFinite(item)))
}

function sealAssessment(
  component: ComponentRef<unknown>,
  candidates: readonly import('../types.js').CandidateSelectionInput[],
  result: CandidateAssessmentResult,
): CandidateAssessment {
  const candidateIds = candidates.map(candidate => candidate.candidateId).sort()
  const metricIds = Object.keys(result.candidateMetrics).sort()
  if (JSON.stringify(candidateIds) !== JSON.stringify(metricIds)
    || Object.values(result.candidateMetrics).some(metrics => !validMetricSet(metrics))) {
    throw new Error('candidate assessor returned invalid or incomplete metrics')
  }
  if (result.rankingCandidateIds !== undefined
    && JSON.stringify([...result.rankingCandidateIds].sort()) !== JSON.stringify(candidateIds)) {
    throw new Error('candidate assessor ranking is not a candidate permutation')
  }
  if (result.reason.length === 0) throw new Error('candidate assessor must provide a reason')
  if (result.usage !== undefined) {
    const usage = [result.usage.modelRequests, result.usage.inputTokens, result.usage.outputTokens,
      result.usage.cachedInputTokens, result.usage.reasoningTokens]
    if (usage.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw new Error('candidate assessor returned invalid usage')
    }
  }
  const identity = {
    component,
    candidateMetrics: result.candidateMetrics,
    ...(result.rankingCandidateIds === undefined ? {} : { rankingCandidateIds: result.rankingCandidateIds }),
    reason: result.reason,
    evidence: result.evidence,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
  return { ...identity, digest: digestJson(identity) }
}

function trajectoryReader(evaluator: RefineEvaluator): HitchTrajectoryReader | undefined {
  const value = evaluator as Partial<HitchTrajectoryReader>
  return typeof value.inspectCapabilities === 'function'
    && typeof value.inspectTrajectoryAnalysis === 'function'
    && typeof value.inspectTrajectoryEvents === 'function'
    ? value as HitchTrajectoryReader
    : undefined
}

function publicSeedEvidence(evidence: EvaluationEvidence): PublicSeedEvidence {
  return {
    evalId: evidence.evalId,
    completeness: evidence.completeness,
    plannedTrialCount: evidence.plannedTrialCount,
    primaryReward: evidence.primaryReward,
    ...(evidence.processScore === undefined ? {} : { processScore: evidence.processScore }),
    summary: evidence.summary,
    trials: [
      ...evidence.trials.map(trial => {
        const reward = trialReward(trial)
        return {
          taskName: trial.taskName,
          ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
          ...(trial.runId === undefined ? {} : { runId: trial.runId }),
          ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
          status: trial.status,
          ...(reward === undefined ? {} : { reward }),
          ...(trial.scores === undefined ? {} : { scores: trial.scores }),
        }
      }),
      ...evidence.invalidTrials.map(trial => ({ ...trial })),
    ],
  }
}

function trialIdentity(trial: { taskName: string; attempt?: number }): string {
  return JSON.stringify([trial.taskName, trial.attempt ?? null])
}

function plannedTrialKeys(evidence: EvaluationEvidence): string[] {
  return [...evidence.trials, ...evidence.invalidTrials]
    .map(trialIdentity)
    .sort((left, right) => left.localeCompare(right))
}

function pairedTrials(baseline: EvaluationEvidence, candidate: EvaluationEvidence): PairedTrial[] {
  const index = new Map<string, EvaluationEvidence['trials'][number]>()
  for (const trial of baseline.trials) {
    const trialKey = trialIdentity(trial)
    if (index.has(trialKey)) throw new Error(`baseline has ambiguous duplicate trial identity: ${trialKey}`)
    index.set(trialKey, trial)
  }
  const result: PairedTrial[] = []
  for (const trial of candidate.trials) {
    const trialKey = trialIdentity(trial)
    const before = index.get(trialKey)
    if (before === undefined) continue
    const baselineReward = trialReward(before)
    const candidateReward = trialReward(trial)
    if (baselineReward === undefined || candidateReward === undefined) {
      throw new Error(`paired trial has no reward: ${trialKey}`)
    }
    const baselineProcessScore = before.scores?.processScore
    const candidateProcessScore = trial.scores?.processScore
    result.push({
      conditionId: baseline.conditionId,
      trialKey,
      taskName: trial.taskName,
      ...(before.trialName === undefined ? {} : { baselineTrialName: before.trialName }),
      ...(trial.trialName === undefined ? {} : { candidateTrialName: trial.trialName }),
      ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
      ...(before.runId === undefined ? {} : { baselineRunId: before.runId }),
      ...(trial.runId === undefined ? {} : { candidateRunId: trial.runId }),
      baselineReward,
      candidateReward,
      rewardDelta: candidateReward - baselineReward,
      ...(baselineProcessScore === undefined ? {} : { baselineProcessScore }),
      ...(candidateProcessScore === undefined ? {} : { candidateProcessScore }),
      ...(baselineProcessScore === undefined || candidateProcessScore === undefined
        ? {}
        : { processScoreDelta: candidateProcessScore - baselineProcessScore }),
    })
  }
  return result.sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

function pairingAudit(
  baseline: EvaluationEvidence,
  candidate: EvaluationEvidence,
  pairs: readonly PairedTrial[],
): PairingAudit {
  return {
    planned: baseline.plannedTrialCount,
    paired: pairs.length,
    excluded: baseline.plannedTrialCount - pairs.length,
    baselineInvalid: baseline.invalidTrials.length,
    candidateInvalid: candidate.invalidTrials.length,
  }
}

function pairedAggregate(pairs: readonly PairedTrial[], side: 'baseline' | 'candidate'): {
  score: number
  passed: number
  total: number
} {
  const rewards = pairs.map(pair => side === 'baseline' ? pair.baselineReward : pair.candidateReward)
  return {
    score: rewards.length === 0 ? 0 : rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
    passed: rewards.filter(reward => reward > 0).length,
    total: rewards.length,
  }
}

function pairedProcessAggregate(pairs: readonly PairedTrial[], side: 'baseline' | 'candidate'): number | undefined {
  const scores = pairs.map(pair => side === 'baseline' ? pair.baselineProcessScore : pair.candidateProcessScore)
  if (scores.length === 0 || scores.some(score => score === undefined)) return undefined
  const available = scores as number[]
  return available.reduce((sum, score) => sum + score, 0) / available.length
}

function pairedProcessDelta(pairs: readonly PairedTrial[]): number | undefined {
  const baseline = pairedProcessAggregate(pairs, 'baseline')
  const candidate = pairedProcessAggregate(pairs, 'candidate')
  return baseline === undefined || candidate === undefined ? undefined : candidate - baseline
}

function projectPairedEvidence(
  evidence: EvaluationEvidence,
  pairs: readonly PairedTrial[],
  side: 'baseline' | 'candidate',
): EvaluationEvidence {
  const keys = new Set(pairs.map(pair => pair.trialKey))
  const trials = evidence.trials.filter(trial => keys.has(trialIdentity(trial)))
  const aggregate = pairedAggregate(pairs, side)
  const processScore = pairedProcessAggregate(pairs, side)
  return {
    ...evidence,
    completeness: 'complete',
    plannedTrialCount: pairs.length,
    primaryReward: aggregate.score,
    ...(processScore === undefined ? {} : { processScore }),
    summary: {
      total: aggregate.total,
      passed: aggregate.passed,
      failed: aggregate.total - aggregate.passed,
      score: aggregate.score,
      metrics: { primaryReward: aggregate.score, totalScore: aggregate.score, ...(processScore === undefined ? {} : { processScore }) },
      ...(processScore === undefined ? {} : { process: { score: processScore } }),
    },
    trials,
    invalidTrials: [],
  }
}

export class RefineService {
  private readonly active = new Map<string, ActiveRound>()
  private readonly repairs = new Map<string, ActiveEvaluationRepair>()
  private readonly runtimes = new Map<string, EvolutionRuntime>()
  private readonly drives = new Set<Promise<void>>()
  private readonly nativeExperienceUsageReaders = new Map<string, ExperienceUsageReader>()
  private disposed = false

  constructor(
    readonly registry: EvolutionRegistryStore,
    readonly builder: HarnessBuilder,
    readonly workspaceManager: CandidateWorkspaceManager,
    readonly createMetaSession: MetaSessionFactory,
    readonly evaluator: RefineEvaluator,
    readonly options: RefineServiceOptions,
    readonly components = new ComponentRegistry(),
  ) {}

  private experienceUsageReader(spec: Readonly<EvolutionSpec>): ExperienceUsageReader | undefined {
    if (this.options.experienceUsageReader !== undefined) return this.options.experienceUsageReader
    if (spec.rollout.provider.id !== 'hitch-cli') return undefined
    const config = typeof spec.rollout.provider.config === 'object' && spec.rollout.provider.config !== null
      && !Array.isArray(spec.rollout.provider.config)
      ? spec.rollout.provider.config as Record<string, unknown>
      : undefined
    const controlPlane = typeof config?.controlPlane === 'object' && config.controlPlane !== null
      && !Array.isArray(config.controlPlane)
      ? config.controlPlane as Record<string, unknown>
      : undefined
    const root = config?.root
    if (config?.harnessId !== 'deepseek' || typeof root !== 'string' || !isAbsolute(root)
      || controlPlane?.mode === 'daemon') return undefined
    let reader = this.nativeExperienceUsageReaders.get(root)
    if (reader === undefined) {
      reader = new HitchNativeExperienceUsageReader({ root })
      this.nativeExperienceUsageReaders.set(root, reader)
    }
    return reader
  }

  async initialize(): Promise<void> {
    this.assertAvailable()
    await this.registry.initialize()
    await this.workspaceManager.initialize()
    const pendingResumes: PendingEvaluationResume[] = []
    const searchResumes: Array<{ evolutionId: string; roundId: string }> = []
    const contextResumes: Array<{ evolutionId: string; roundId: string; execution: MetaExecutionState }> = []
    for (const entry of await this.registry.list()) {
      const store = this.registry.stateStore(entry.evolutionId)
      await store.initialize()
      const contextStore = new MetaOffloadingStore(store.root)
      const contextExecutions = await contextStore.list()
      const preservedWorkspaces = new Set(contextExecutions.flatMap(execution => {
        const controller = execution.recovery?.controller as { workspaceId?: string } | undefined
        return controller?.workspaceId === undefined ? [] : [controller.workspaceId]
      }))
      for (let round of await store.listRounds()) {
        if (round.searchMode && (!TERMINAL.has(round.status) || round.status === 'failed')) {
          for (const candidate of round.candidatePool) if (candidate.workspaceId && candidate.generationAttempts?.some(a => a.status === 'running')) preservedWorkspaces.add(candidate.workspaceId)
          searchResumes.push({ evolutionId: entry.evolutionId, roundId: round.roundId })
          continue
        }
        if (round.pendingEvaluationRerun !== undefined) {
          const spec = await this.registry.requireSpec(entry.evolutionId)
          this.resolveComponents(spec)
          round = await this.cleanupEvaluationRerun(store, round, this.evaluatorForSpec(spec), {
            code: 'evaluation_rerun_interrupted_by_restart', message: 'control plane restarted during a remote rerun',
          })
        }
        if (round.evaluationAttempts?.some(attempt => attempt.submissionIntent !== undefined && attempt.status === 'rerunning')) {
          throw new Error('cannot recover an interrupted daemon rerun without its durable rerun identity')
        }
        if ((round.pendingEvaluationSubmissions?.length ?? 0) > 0
          || round.evaluationAttempts?.some(attempt => attempt.submissionIntent !== undefined
            && attempt.status === 'running')) {
          const spec = await this.registry.requireSpec(entry.evolutionId)
          this.resolveComponents(spec)
          const evaluator = this.evaluatorForSpec(spec)
          round = await this.recoverEvaluationSubmissions(store, round, evaluator)
        }
        for (const candidate of round.candidatePool) {
          if (candidate.sealedVersion !== undefined) await this.builder.verifySealedCandidate(candidate.sealedVersion)
        }
        const pendingRepair = this.pendingRepairAttempt(round)
        if (pendingRepair !== undefined) {
          const interruptedDuringResume = (round.evaluationAttempts ?? []).filter(attempt =>
            !this.sameAttempt(attempt, pendingRepair)
            && (attempt.status === 'running' || attempt.status === 'rerunning'))
          if (interruptedDuringResume.length > 0) {
            const completedAt = now()
            const { evaluationRepairResume: _resume, ...withoutResume } = round
            await store.writeRound({
              ...withoutResume,
              status: 'failed',
              updatedAt: completedAt,
              failure: preferredFailure('recovery', 'control plane restarted during an evaluation resumed from repair', round),
              candidatePool: settleInterruptedCandidateGeneration(
                round, completedAt, 'control plane restarted during candidate generation',
              ),
              evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => this.sameAttempt(attempt, pendingRepair)
                ? (() => {
                    const { failure: _failure, ...owned } = attempt
                    return { ...owned, status: 'settled' as const, completedAt: attempt.completedAt ?? completedAt }
                  })()
                : attempt.status === 'running' || attempt.status === 'rerunning'
                  ? {
                      ...attempt,
                      status: 'failed' as const,
                      completedAt,
                      failure: {
                        code: attempt.status === 'rerunning'
                          ? 'evaluation_rerun_interrupted_by_restart'
                          : 'evaluation_interrupted_by_restart',
                        message: 'control plane restarted during an evaluation resumed from repair',
                      },
                    }
                  : attempt),
            })
            continue
          }
          const completedAt = pendingRepair.completedAt ?? now()
          if (pendingRepair.status === 'rerunning' || round.evaluationRepairResume === undefined) {
            await store.writeRound({
              ...round,
              updatedAt: completedAt,
              evaluationRepairResume: {
                provider: pendingRepair.provider,
                evalId: pendingRepair.evalId,
                completedAt,
              },
              evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => this.sameAttempt(attempt, pendingRepair)
                ? (() => {
                    const { failure: _failure, ...owned } = attempt
                    return { ...owned, status: 'repair-completed' as const, completedAt }
                  })()
                : attempt),
            })
          }
          if (entry.status === 'active') {
            pendingResumes.push({
              evolutionId: entry.evolutionId,
              roundId: round.roundId,
              attempt: { provider: pendingRepair.provider, evalId: pendingRepair.evalId },
            })
          }
          continue
        }
        const interruptedAttempts = (round.evaluationAttempts ?? []).some(
          attempt => attempt.status === 'running' || attempt.status === 'rerunning',
        )
        if (round.commitIntent === undefined && interruptedAttempts) {
          const completedAt = now()
          await store.writeRound({
            ...round,
            status: 'failed',
            updatedAt: completedAt,
            failure: preferredFailure('recovery', 'control plane restarted during an evaluation', round),
            candidatePool: settleInterruptedCandidateGeneration(
              round, completedAt, 'control plane restarted during candidate generation',
            ),
            evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => {
              if (attempt.status !== 'running' && attempt.status !== 'rerunning') return attempt
              const rerunning = attempt.status === 'rerunning'
              return {
                ...attempt,
                status: 'failed' as const,
                completedAt,
                failure: {
                  code: rerunning ? 'evaluation_rerun_interrupted_by_restart' : 'evaluation_interrupted_by_restart',
                  message: rerunning
                    ? 'control plane restarted during evaluation repair'
                    : 'control plane restarted during evaluation',
                },
              }
            }),
          })
        } else if (round.commitIntent !== undefined
          && (round.status !== round.commitIntent.decision || round.commitIntent.phase !== 'champion-committed')) {
          await this.reconcileCommitIntent(store, round).catch(async error => store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'recovery', message: errorMessage(error) },
          }))
        } else if (!TERMINAL.has(round.status)) {
          const resumable = resumableContextExecutions(round, contextExecutions)
          if (resumable.length === 1 && hasContextRecoveryRoundStage(round)) {
            const spec = await this.registry.requireSpec(entry.evolutionId)
            const execution = resumable[0]!
            if (spec.metaAgent.contextOffloading !== undefined
              && contextRecoveryOwnerMatches(round, execution, digestJson(spec))) {
              contextResumes.push({ evolutionId: entry.evolutionId, roundId: round.roundId, execution })
              continue
            }
          }
          for (const context of contextExecutions.filter(context => context.roundId === round.roundId
            && (context.status === 'running' || context.status === 'rotating'))) {
            await contextStore.cas(context.revision, { ...context, revision: context.revision + 1, status: 'stopped',
              failure: 'context-handoff-failed: restart outside a recoverable handoff boundary',
            })
          }
          const completedAt = now()
          await store.writeRound({
            ...round, status: 'failed', updatedAt: completedAt,
            failure: preferredFailure('recovery', 'control plane restarted before the round reached a durable commit intent', round),
            candidatePool: settleInterruptedCandidateGeneration(
              round, completedAt, 'control plane restarted during candidate generation',
            ),
          })
        }
      }
      await this.workspaceManager.recoverOrphans(entry.evolutionId, preservedWorkspaces)
    }
    await this.evaluator.preflight?.()
    const resumedRoundIds: string[] = []
    try {
      for (const pending of searchResumes) {
        const evolution = await this.runtime(pending.evolutionId)
        const lock = await evolution.store.acquireRoundLock(pending.roundId)
        const round = await this.requireRound(evolution.store, pending.roundId)
        await this.transition(evolution.store, pending.roundId, { status: 'baseline-running', failure: undefined })
        this.active.set(pending.roundId, this.newActive(evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus))
        resumedRoundIds.push(pending.roundId)
      }
      for (const pending of contextResumes) {
        const evolution = await this.runtime(pending.evolutionId)
        const lock = await evolution.store.acquireRoundLock(pending.roundId)
        const round = await this.requireRound(evolution.store, pending.roundId)
        const active = this.newActive(evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus)
        active.contextResume = pending.execution
        this.active.set(pending.roundId, active)
        resumedRoundIds.push(pending.roundId)
      }
      for (const pending of pendingResumes) {
        await this.resumeCompletedEvaluationRepair(pending)
        resumedRoundIds.push(pending.roundId)
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
    for (const roundId of resumedRoundIds) queueMicrotask(() => this.startDrive(roundId))
  }

  async admit(source: RefinementRound['source'], options: AdmissionOptions = {}): Promise<AdmissionResult> {
    this.assertAvailable()
    const roundCount = validateCount(options.rounds ?? 1)
    const taskBudgetMs = options.taskBudgetMs ?? this.options.taskBudgetMs
    if (!Number.isSafeInteger(taskBudgetMs) || taskBudgetMs <= 0) throw new TypeError('taskBudgetMs must be a positive integer')
    const baselineSource = options.baselineSource === undefined
      ? undefined
      : parseBaselineSourceRequest(options.baselineSource)
    const evolutionId = crypto.randomUUID()
    const batchId = crypto.randomUUID()
    let from = options.from
    if (from === undefined && baselineSource !== undefined) {
      const sourceRound = await this.registry.stateStore(baselineSource.evolutionId).readRound(baselineSource.roundId)
      if (sourceRound === undefined) {
        throw new Error(`baseline source is incompatible: unknown source round: ${baselineSource.roundId}`)
      }
      from = sourceRound.targetHarnessRef
    }
    const initial = await this.resolveInitialChampion(from)
    const seedTaskRef = options.seedTaskRef ?? this.options.seedTaskRef
    const spec: EvolutionSpec = {
      ...(this.options.searchSettings === undefined ? {} : { searchSettings: structuredClone(this.options.searchSettings) }),
      evolutionId, createdAt: now(),
      initialHarness: { ref: initial.ref, digest: initial.manifestDigest },
      datasets: {
        seed: { ref: seedTaskRef, digest: await digestDatasetRef(seedTaskRef, this.options.workspaceRoot) },
        heldOut: { ref: this.options.heldOutRef, digest: await digestDatasetRef(this.options.heldOutRef, this.options.workspaceRoot) },
      },
      metaAgent: structuredClone(this.options.metaAgent),
      candidateGeneration: structuredClone(this.options.candidateGeneration),
      rollout: structuredClone(this.options.rollout),
      evaluation: structuredClone(this.options.evaluation),
      selection: structuredClone(this.options.selection),
      promotion: structuredClone(this.options.promotion),
      taskBudgetMs,
      toolchainRef: this.options.toolchainRef, sandboxProfileRef: this.options.sandboxProfileRef,
      ...((this.options.experienceMemoryEnabled === true || source === 'skill')
        ? { experienceMemory: { schemaVersion: 1 as const, enabled: true } }
        : {}),
    }
    this.resolveComponents(spec)
    if (spec.searchSettings) {
      const search = this.evaluatorForSpec(spec).search
      if (!search || !search.provider.capabilities.taskSubsetPlans || !search.provider.capabilities.batchIndependentCells || !search.provider.capabilities.idempotentExecution) {
        throw new Error('failure-cluster-gepa-v1 requires provider-verified subset plans, cell reuse, idempotent execution and a diagnosis provider')
      }
      const [seed, heldOut] = await Promise.all([search.provider.describe('seed'), search.provider.describe('held-out')])
      spec.searchSettings = resolveRegressionSettings(spec.searchSettings, seed, heldOut)
      validateSettings(spec.searchSettings, seed, heldOut, spec.candidateGeneration.maxCandidates)
      if (spec.searchSettings.regression.suiteRef) invariant(await search.provider.verifyRegressionSuite?.(spec.searchSettings.regression.suiteRef, seed), 'provider must verify the frozen regression suite was included at new admission')
    }
    let preparedBaseline: PreparedBaselineSource | undefined
    if (baselineSource !== undefined) {
      preparedBaseline = await this.prepareExternalBaseline(spec, initial, baselineSource)
      spec.rollout.providerSemanticDigest = preparedBaseline.inheritedRolloutProviderDigest
      spec.baselineConditionSource = preparedBaseline.conditionSource
    }
    const state = this.registry.stateStore(evolutionId)
    const meta = await this.createMetaSession(spec, digestJson(spec), state)
    try {
      this.assertGenerationBudgetCapability(spec, meta)
      await this.registry.createEvolution({ spec, champion: initial, ...(options.name === undefined ? {} : { name: options.name }) })
      return await this.startBatch(await this.runtime(evolutionId, { meta, store: state }), source, batchId, roundCount, normalizeFocus(options.focus), preparedBaseline?.snapshot)
    } catch (error) { await meta.dispose(); throw error }
  }

  async continueEvolution(source: RefinementRound['source'], evolutionId: string, options: ContinueOptions = {}): Promise<AdmissionResult> {
    this.assertAvailable()
    if (options.roundId !== undefined && (options.rounds !== undefined || options.focus !== undefined)) {
      throw new TypeError('roundId cannot be combined with rounds or focus')
    }
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    if (entry.status !== 'active') throw new Error(`evolution is archived and cannot continue: ${evolutionId}`)
    const evolution = await this.runtime(evolutionId)
    if (evolution.spec.searchSettings) {
      const journal = new SearchStore(join(evolution.store.root, 'search'))
      for (const round of await evolution.store.listRounds()) {
        if (round.searchMode && !await journal.read(`rounds/${round.roundId}/terminal`)) throw new Error('search has an unresolved round; resume or repair it before admitting another round')
      }
    }
    this.resolveComponents(evolution.spec)
    await this.options.validateRuntime?.(evolution.spec)
    const [seedDigest, heldOutDigest] = await Promise.all([
      digestDatasetRef(evolution.spec.datasets.seed.ref, this.options.workspaceRoot),
      digestDatasetRef(evolution.spec.datasets.heldOut.ref, this.options.workspaceRoot),
    ])
    if (seedDigest !== evolution.spec.datasets.seed.digest || heldOutDigest !== evolution.spec.datasets.heldOut.digest) {
      throw new Error('evolution dataset content changed; create a new evolution')
    }
    if (options.roundId !== undefined) return this.recoverSelectedRound(evolution, options.roundId)
    const baselineSource = await this.recoverUnstagedBaselineSource(evolution)
    return this.startBatch(
      evolution, source, crypto.randomUUID(), validateCount(options.rounds ?? 1), normalizeFocus(options.focus), baselineSource,
    )
  }

  private async recoverSelectedRound(evolution: EvolutionRuntime, roundId: string): Promise<AdmissionResult> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(roundId)) throw new TypeError('roundId is invalid')
    if (this.repairs.has(roundId)) throw new Error(`refinement round is already active: ${roundId}`)
    const live = this.active.get(roundId)
    if (live !== undefined) {
      const persisted = await live.evolution.store.readRound(roundId)
      if (persisted === undefined || !TERMINAL.has(persisted.status)) {
        throw new Error(`refinement round is already active: ${roundId}`)
      }
      await live.drive
      if (this.active.has(roundId)) throw new Error(`refinement round is already active: ${roundId}`)
    }
    const lock = await evolution.store.acquireRoundLock(roundId)
    let handedToDrive = false
    try {
      const entry = await this.registry.readEntry(evolution.spec.evolutionId)
      if (entry?.status !== 'active') {
        throw new Error(`evolution is archived and cannot continue: ${evolution.spec.evolutionId}`)
      }
      let round = await this.requireRound(evolution.store, roundId)
      if (round.evolutionId !== evolution.spec.evolutionId || round.status !== 'failed') {
        throw new Error(`round ${roundId} is not a failed selected round`)
      }
      if (round.decision !== undefined || round.commitIntent !== undefined) {
        throw new Error(`round ${roundId} already has a durable decision or commit intent`)
      }
      if ((round.pendingEvaluationSubmissions?.length ?? 0) > 0
        || round.pendingEvaluationRerun !== undefined
        || round.evaluationRepairResume !== undefined
        || round.evaluationAttempts?.some(attempt => attempt.status === 'running'
          || attempt.status === 'rerunning' || attempt.status === 'repair-completed')) {
        throw new Error(`round ${roundId} has unresolved evaluation or repair work`)
      }
      const [population, champion] = await Promise.all([
        evolution.store.readPopulation(), evolution.store.readChampion(),
      ])
      if (population === undefined || population.digest !== round.parentPopulationDigest
        || champion?.ref !== round.targetHarnessRef
        || champion?.manifestDigest !== round.targetHarnessDigest) {
        throw new Error(`round ${roundId} no longer matches its admitted population or champion`)
      }
      const selection = round.selection
      const evaluation = round.evaluation
      const finalist = round.candidatePool.find(candidate => candidate.candidateId === round.promotionCandidateId)
      if (round.selectionAssessment === undefined || selection === undefined
        || selection.assessmentDigest !== round.selectionAssessment.digest
        || !selection.selectedCandidateIds.includes(selection.promotionCandidateId)
        || round.promotionCandidateId !== selection.promotionCandidateId
        || finalist?.status !== 'selected' || finalist.sealedVersion === undefined
        || finalist.seedEvaluation === undefined || finalist.seedComparison === undefined
        || evaluation === undefined || round.baseline === undefined
        || digestJson(evaluation.seedBaseline) !== digestJson(round.baseline)
        || digestJson(evaluation.seedCandidate) !== digestJson(finalist.seedEvaluation)) {
        throw new Error(`round ${roundId} has no complete selected seed state to recover`)
      }
      for (const selectedId of selection.selectedCandidateIds) {
        const selected = round.candidatePool.find(candidate => candidate.candidateId === selectedId)
        if (selected?.status !== 'selected' || selected.sealedVersion === undefined
          || selected.seedEvaluation === undefined || selected.seedComparison === undefined
          || selected.metrics === undefined || selected.metaSessionId === undefined
          || selected.resultCheckpoint === undefined) {
          throw new Error(`round ${roundId} has incomplete selected candidate state: ${selectedId}`)
        }
      }
      // Prove all selected parent links and population inputs before the one
      // allowed held-out submission can be admitted.
      this.nextPopulation(round, population, selection.selectedCandidateIds)
      this.assertParity(evaluation.seedBaseline, evaluation.seedCandidate, 'seed')
      const seedRequiredRegressions = evaluation.seedPairedTrials.length === 0
        ? 0 : this.requiredRegressions(round, evaluation.seedPairedTrials)
      if (!this.passesSeed(round, { ...evaluation, requiredRegressions: seedRequiredRegressions })) {
        throw new Error(`round ${roundId} no longer passes its original seed gate`)
      }

      const selectedCommit = finalist.sealedVersion.commitOid
      let reusableBaseline: ReusableBaseline | undefined
      if (evaluation.heldOutBaseline === undefined) {
        const starts = round.evaluationStarts?.some(start => start.phase === 'held-out-baseline'
          && start.harnessRef === round.targetHarnessRef) ?? false
        const attempts = (round.evaluationAttempts ?? []).filter(attempt => attempt.phase === 'held-out-baseline'
          && attempt.owner.role === 'baseline' && attempt.requestedCommit === round.targetHarnessRef)
        const failed = round.failedEvaluations?.some(record => record.phase === 'held-out-baseline'
          && record.owner.role === 'baseline' && record.evidence.requestedCommit === round.targetHarnessRef) ?? false
        if (starts || attempts.length > 0 || failed) {
          const ownedFailure = attempts.find(attempt => attempt.status === 'failed')
          if (ownedFailure !== undefined) {
            throw new Error(`round ${roundId} already started its held-out baseline; use control.rerun for owned failed evaluation ${ownedFailure.evalId}`)
          }
          throw new Error(`round ${roundId} already started its held-out baseline and cannot replace it with historical evidence`)
        }
        const staged = round.baselineSource?.partitions.heldOut
        reusableBaseline = staged === undefined
          ? await this.findReusableBaseline(
              evolution.store, evolution.evaluator, round, round.targetHarnessRef, 'held-out', AbortSignal.timeout(30_000),
            )
          : {
              evidence: structuredClone(staged.evidence),
              sourceEvolutionId: round.baselineSource!.source.evolutionId,
              sourceRoundId: round.baselineSource!.source.roundId,
              ...(staged.currentInvocationFingerprint === undefined
                ? {}
                : { currentInvocationFingerprint: staged.currentInvocationFingerprint }),
            }
        if (reusableBaseline === undefined) {
          throw new Error(`round ${roundId} has no reusable held-out baseline; explicit recovery will not start a fresh baseline`)
        }
      }
      const heldOutBaseline = evaluation.heldOutBaseline ?? reusableBaseline!.evidence
      if (evaluation.heldOutBaseline !== undefined) {
        const attempt = round.evaluationAttempts?.find(value => value.provider === heldOutBaseline.provider
          && value.evalId === heldOutBaseline.evalId)
        if (heldOutBaseline.trials.length === 0 || attempt?.status !== 'settled'
          || attempt.phase !== 'held-out-baseline' || attempt.owner.role !== 'baseline'
          || attempt.owner.harnessRef !== round.targetHarnessRef
          || attempt.requestedModelId !== round.plan.heldOut.model) {
          throw new Error(`round ${roundId} has no eligible settled held-out baseline evidence`)
        }
      }
      const signal = AbortSignal.timeout(30_000)
      const heldOutBaselineIdentity = await this.recoveryEvaluationIdentity(
        evolution.evaluator, round, 'held-out-baseline', round.targetHarnessRef, signal,
      )
      this.assertRecoveryEvidenceIdentity(round, heldOutBaseline, 'held-out-baseline', round.targetHarnessRef, heldOutBaselineIdentity)
      const heldOutCandidateIdentity = await this.recoveryEvaluationIdentity(
        evolution.evaluator, round, 'held-out-candidate', selectedCommit, signal,
      )
      if (heldOutCandidateIdentity.provider !== heldOutBaseline.provider
        || heldOutCandidateIdentity.effectiveConfigDigest !== heldOutBaseline.effectiveConfigDigest) {
        throw new Error(`round ${roundId} held-out candidate evaluator identity is incompatible with its baseline`)
      }
      if (evaluation.heldOutCandidate !== undefined && finalist.heldOutEvaluation !== undefined
        && digestJson(evaluation.heldOutCandidate) !== digestJson(finalist.heldOutEvaluation)) {
        throw new Error(`round ${roundId} has conflicting selected held-out evidence`)
      }
      const existingHeldOutCandidate = evaluation.heldOutCandidate ?? finalist.heldOutEvaluation
      if (existingHeldOutCandidate !== undefined) {
        this.assertRecoveryEvidenceIdentity(
          round, existingHeldOutCandidate, 'held-out-candidate', selectedCommit, heldOutCandidateIdentity,
        )
        this.assertParity(heldOutBaseline, existingHeldOutCandidate, 'held-out')
      } else {
        const starts = round.evaluationStarts?.some(start => start.phase === 'held-out-candidate'
          && start.harnessRef === selectedCommit) ?? false
        const attempts = (round.evaluationAttempts ?? []).filter(attempt => attempt.phase === 'held-out-candidate'
          && attempt.requestedCommit === selectedCommit)
        const failed = round.failedEvaluations?.some(record => record.phase === 'held-out-candidate'
          && record.evidence.requestedCommit === selectedCommit) ?? false
        if (starts || attempts.length > 0 || failed) {
          const ownedFailure = attempts.find(attempt => attempt.status === 'failed')
          if (ownedFailure !== undefined) {
            throw new Error(`round ${roundId} already started the selected held-out evaluation; use control.rerun for owned failed evaluation ${ownedFailure.evalId}`)
          }
          throw new Error(`round ${roundId} already started the selected held-out evaluation and cannot safely submit it again`)
        }
      }

      // Every check above is read-only. Mutate the existing round only after the
      // original selected state and any reusable baseline are proven compatible.
      this.assertAvailable()
      if (reusableBaseline !== undefined) {
        const championCandidateId = round.parentAllocations
          ?.find(allocation => allocation.parentHarnessRef === round.targetHarnessRef)?.parentCandidateId
          ?? `champion-${round.targetHarnessRef}`
        round = await this.persistReusableHeldOutBaseline(
          evolution.store, round, championCandidateId, round.targetHarnessRef, reusableBaseline,
        )
      }
      this.assertAvailable()
      await this.registry.touch(evolution.spec.evolutionId, { batchId: round.batchId, roundId })
      this.assertAvailable()
      const priorFailure = round.failure
      const priorBaselineReuseBlocker = round.baselineReuseBlocker
      round = await this.transition(evolution.store, roundId, {
        status: 'held-out-running', failure: undefined, baselineReuseBlocker: undefined,
      })
      try {
        this.assertAvailable()
      } catch (error) {
        await this.transition(evolution.store, roundId, {
          status: 'failed', failure: priorFailure, baselineReuseBlocker: priorBaselineReuseBlocker,
        })
        throw error
      }
      const active = this.newActive(
        evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus,
      )
      active.resumeHeldOut = true
      this.active.set(roundId, active)
      handedToDrive = true
      queueMicrotask(() => this.startDrive(roundId))
      return { evolutionId: evolution.spec.evolutionId, batchId: round.batchId, roundId, status: 'queued' }
    } finally {
      if (!handedToDrive) await lock.release().catch(() => {})
    }
  }

  private async recoveryEvaluationIdentity(
    evaluator: RefineEvaluator,
    round: RefinementRound,
    phase: 'held-out-baseline' | 'held-out-candidate',
    harnessRef: string,
    signal: AbortSignal,
  ): Promise<{ provider: string; effectiveConfigDigest: string }> {
    const identity = await evaluator.evaluationIdentity?.(round, {
      phase, dataset: round.heldOutRef, harnessRef, condition: round.plan.heldOut,
    }, signal)
    signal.throwIfAborted()
    if (identity === undefined) throw new Error(`round ${round.roundId} evaluator identity is unresolved for ${phase}`)
    return identity
  }

  private assertRecoveryEvidenceIdentity(
    round: RefinementRound,
    evidence: EvaluationEvidence,
    phase: 'held-out-baseline' | 'held-out-candidate',
    harnessRef: string,
    identity: { provider: string; effectiveConfigDigest: string },
  ): void {
    if (evidence.provider !== identity.provider
      || evidence.effectiveConfigDigest !== identity.effectiveConfigDigest
      || evidence.conditionId !== round.plan.heldOut.conditionId
      || evidence.dataset !== round.heldOutRef
      || evidence.requestedCommit !== harnessRef
      || evidence.actualCommit !== harnessRef) {
      throw new Error(`round ${round.roundId} ${phase} evidence is incompatible with the current evaluator identity`)
    }
  }

  /** Replay only the frozen round and its original external operations. */
  async resumeSearchRound(evolutionId: string, roundId: string): Promise<{ roundId: string; resumed: boolean }> {
    this.assertAvailable()
    const evolution = await this.runtime(evolutionId)
    if (this.active.has(roundId)) throw new Error('search round is already active')
    const lock = await evolution.store.acquireRoundLock(roundId)
    let adopted = false
    try {
      const round = await this.requireRound(evolution.store, roundId)
      if (!round.searchMode || !evolution.spec.searchSettings || !evolution.evaluator.search) throw new Error('not a staged search round')
      if (round.searchOutcome) return { roundId, resumed: false }
      await this.transition(evolution.store, roundId, { status: 'baseline-running', failure: undefined })
      this.active.set(roundId, this.newActive(evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus))
      adopted = true
      queueMicrotask(() => this.startDrive(roundId))
      return { roundId, resumed: true }
    } finally { if (!adopted) await lock.release() }
  }

  async repairSearchStage(evolutionId: string, roundId: string, repairId: string, originalEvidenceDigest: string): Promise<import('../search/types.js').StageResult> {
    const evolution = await this.runtime(evolutionId)
    const adapter = evolution.evaluator.search
    if (!evolution.spec.searchSettings || !adapter) throw new Error('this evolution has no staged search repair capability')
    const lock = await evolution.store.acquireRoundLock(roundId)
    let adopted = false
    try {
      const round = await this.requireRound(evolution.store, roundId)
      if (!round.searchMode) throw new Error('not a staged search round')
      const engine = new FailureClusterSearch(new SearchStore(join(evolution.store.root, 'search')), adapter.provider, adapter.diagnosis, {
        verifySnapshot: async snapshot => {
          const actual = await this.builder.searchSnapshot(snapshot.candidateId, snapshot.commit, snapshot.parentIds)
          invariant(actual.tree === snapshot.tree && actual.manifestDigest === snapshot.manifestDigest, 'repair snapshot mismatch')
        },
        generate: async () => { throw new Error('evidence repair cannot generate candidates') },
        commitChampion: async () => { throw new Error('evidence repair cannot promote') },
      }, this.components)
      const result = await engine.repairEvaluation(roundId, repairId, originalEvidenceDigest, new AbortController().signal)
      await this.transition(evolution.store, roundId, { status: 'baseline-running', failure: undefined })
      this.active.set(roundId, this.newActive(evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus))
      adopted = true
      queueMicrotask(() => this.startDrive(roundId))
      return result
    } finally { if (!adopted) await lock.release() }
  }

  async rerunEvaluation(
    evolutionId: string,
    roundId: string,
    evalId: string,
    selector: EvaluationRerunSelector,
  ): Promise<EvaluationRerunResult> {
    this.assertAvailable()
    const normalizedSelector = normalizeEvaluationRerunSelector(selector)
    if (this.repairs.has(roundId)) throw new Error(`refinement round already has an active evaluation repair: ${roundId}`)
    const live = this.active.get(roundId)
    if (live !== undefined) {
      const persisted = await live.evolution.store.readRound(roundId)
      if (persisted === undefined || !TERMINAL.has(persisted.status)) {
        throw new Error(`refinement round is already active: ${roundId}`)
      }
      await live.drive
      if (this.active.has(roundId)) throw new Error(`refinement round is already active: ${roundId}`)
    }
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    if (entry.status !== 'active') throw new Error(`evolution is archived and cannot repair evaluations: ${evolutionId}`)
    const evolution = await this.runtime(evolutionId)
    const lock = await evolution.store.acquireRoundLock(roundId)
    try {
      const lockedEntry = await this.registry.readEntry(evolutionId)
      if (lockedEntry?.status !== 'active') {
        throw new Error(`evolution is archived and cannot repair evaluations: ${evolutionId}`)
      }
      const round = await this.requireRound(evolution.store, roundId)
      if (round.evolutionId !== evolutionId || round.status !== 'failed') {
        throw new Error(`round ${roundId} is not a failed evaluation round`)
      }
      if (round.decision !== undefined || round.commitIntent !== undefined) {
        throw new Error(`round ${roundId} already has a durable decision or commit intent`)
      }
      if (round.pendingEvaluationRerun !== undefined) throw new Error('previous rerun cleanup must finish before another repair')
      const [population, champion] = await Promise.all([
        evolution.store.readPopulation(), evolution.store.readChampion(),
      ])
      if (population?.digest !== round.parentPopulationDigest
        || champion?.ref !== round.targetHarnessRef
        || champion?.manifestDigest !== round.targetHarnessDigest) {
        throw new Error(`round ${roundId} no longer matches its admitted population or champion`)
      }
      const attempt = round.evaluationAttempts?.find(value => value.evalId === evalId && value.provider === 'hitch-cli')
      if (attempt === undefined) throw new Error(`round ${roundId} does not own Hitch eval ${evalId}`)
      if (attempt.status !== 'failed') throw new Error(`Hitch eval ${evalId} is not failed`)
      if (this.attemptHasEvidence(round, attempt)) throw new Error(`Hitch eval ${evalId} already has durable evidence`)
      if (evolution.evaluator.rerun === undefined) throw new Error('configured evaluator does not support task rerun')
      const request = this.evaluationRequest(round, attempt)
      this.assertAvailable()
      const repair: ActiveEvaluationRepair = {
        evolution, roundId, lock, abort: new AbortController(), attempt, handedToDrive: false,
      }
      this.repairs.set(roundId, repair)
      repair.completion = this.runEvaluationRepair(repair, round, request, normalizedSelector)
      return repair.completion
    } catch (error) {
      await lock.release().catch(() => {})
      throw error
    }
  }

  private async runEvaluationRepair(
    repair: ActiveEvaluationRepair,
    initialRound: RefinementRound,
    request: EvaluationRequest,
    selector: EvaluationRerunSelector,
  ): Promise<EvaluationRerunResult> {
    const { evolution, attempt } = repair
    const { roundId } = initialRound
    try {
      const reservation = evolution.evaluator.prepareRerun?.(initialRound, request, attempt, selector)
      if (reservation !== undefined && evolution.evaluator.cancelRerun === undefined) {
        throw new Error('durable rerun requires cancellation support')
      }
      let round = await this.transition(evolution.store, roundId, {
        status: 'repairing-evaluation',
        failure: undefined,
        baselineReuseBlocker: undefined,
        pendingEvaluationRerun: reservation === undefined ? undefined : { reservation },
        evaluationAttempts: (initialRound.evaluationAttempts ?? []).map(value => this.sameAttempt(value, attempt)
          ? (() => {
              const { completedAt: _completedAt, failure: _failure, ...owned } = value
              return { ...owned, status: 'rerunning' as const }
            })()
          : value),
      })
      const rerun = evolution.evaluator.rerun
      if (rerun === undefined) throw new Error('configured evaluator does not support task rerun')
      const result = await rerun.call(evolution.evaluator, round, request, attempt, selector, repair.abort.signal, reservation)
      if (result.provider !== attempt.provider || result.evalId !== attempt.evalId) {
        throw new Error('evaluation rerun result does not match Gear ownership')
      }
      if (result.evidence === undefined) {
        const slots = result.remainingInvalidTrials?.map(slot => `${slot.taskId}#${slot.attempt}`) ?? []
        const invalid = slots.length > 0 ? slots : result.remainingInvalidTasks
        const message = invalid.length === 0
          ? 'evaluation rerun did not produce inspectable evidence'
          : `evaluation still has invalid trials: ${invalid.join(', ')}`
        await this.failEvaluationRepair(
          repair,
          Object.assign(new Error(message), { code: 'evaluation_has_invalid_tasks' }),
        )
        return result
      }
      this.assertRepairedEvidence(attempt, result.evidence)
      const current = await this.requireRound(evolution.store, roundId)
      const evidencePatch = await this.repairedEvidencePatch(current, attempt, result.evidence, evolution.spec)
      const repairCompletedAt = now()
      round = await this.transition(evolution.store, roundId, {
        ...evidencePatch,
        status: 'repairing-evaluation',
        failure: undefined,
        evaluationRepairResume: {
          provider: attempt.provider,
          evalId: attempt.evalId,
          completedAt: repairCompletedAt,
        },
        pendingEvaluationRerun: undefined,
        evaluationAttempts: (current.evaluationAttempts ?? []).map(value => this.sameAttempt(value, attempt)
          ? (() => {
              const { failure: _failure, ...owned } = value
              return { ...owned, status: 'repair-completed' as const, completedAt: repairCompletedAt }
            })()
          : value),
      })
      if (this.disposed || repair.abort.signal.aborted) {
        throw repair.abort.signal.reason ?? new Error('RefineService disposed')
      }
      const active = this.newActive(
        evolution, repair.lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus,
      )
      active.repairAttempt = { provider: attempt.provider, evalId: attempt.evalId }
      this.active.set(roundId, active)
      repair.handedToDrive = true
      queueMicrotask(() => this.startDrive(roundId))
      return result
    } catch (error) {
      await this.failEvaluationRepair(repair, error)
      throw error
    } finally {
      this.repairs.delete(roundId)
      if (!repair.handedToDrive) await repair.lock.release().catch(() => {})
    }
  }

  private async failEvaluationRepair(repair: ActiveEvaluationRepair, error: unknown): Promise<void> {
    let round = await repair.evolution.store.readRound(repair.roundId).catch(() => undefined)
    if (round?.status !== 'repairing-evaluation') return
    const attempt = round.evaluationAttempts?.find(value => this.sameAttempt(value, repair.attempt))
    if (attempt?.status === 'repair-completed' && this.attemptHasEvidence(round, attempt)) return
    const aborted = repair.abort.signal.aborted
    const code = aborted
      ? 'evaluation_rerun_aborted'
      : typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'evaluation_rerun_failed'
    const completedAt = now()
    let cleanupFailure: EvaluationFailure | undefined
    if (round.pendingEvaluationRerun !== undefined) {
      try {
        round = await this.cleanupEvaluationRerun(repair.evolution.store, round, repair.evolution.evaluator, { code, message: errorMessage(error) })
      } catch (cleanupError) {
        cleanupFailure = evaluationFailure(cleanupError)
        round = await this.requireRound(repair.evolution.store, repair.roundId)
      }
    }
    await repair.evolution.store.writeRound({
      ...round,
      status: 'failed',
      updatedAt: completedAt,
      failure: { phase: 'repairing-evaluation', message: errorMessage(error) },
      evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => this.sameAttempt(attempt, repair.attempt)
        ? {
            ...attempt, status: 'failed' as const, completedAt, failure: { code, message: errorMessage(error) },
            ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
          }
        : attempt),
    })
  }

  private async cleanupEvaluationRerun(
    store: RefineStateStore,
    round: RefinementRound,
    evaluator: RefineEvaluator,
    failure: EvaluationFailure,
  ): Promise<RefinementRound> {
    const pending = round.pendingEvaluationRerun
    if (pending === undefined) return round
    try {
      if (evaluator.cancelRerun === undefined) throw new Error('cannot recover durable rerun: evaluator has no rerun cancellation support')
      await evaluator.cancelRerun(pending.reservation)
      return await this.transition(store, round.roundId, {
        pendingEvaluationRerun: undefined,
        evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => {
          if (!this.sameAttempt(attempt, pending.reservation)) return attempt
          const { cleanupFailure: _cleanupFailure, ...owned } = attempt
          return { ...owned, status: 'failed' as const, completedAt: now(), failure: attempt.failure ?? failure }
        }),
      })
    } catch (error) {
      await this.transition(store, round.roundId, {
        pendingEvaluationRerun: { ...pending, cleanupFailure: evaluationFailure(error) },
      }).catch(() => {})
      throw error
    }
  }

  private sameAttempt(left: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>, right: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>): boolean {
    return left.provider === right.provider && left.evalId === right.evalId
  }

  private attemptHasEvidence(round: RefinementRound, attempt: RoundEvaluationAttempt): boolean {
    const matches = (evidence: EvaluationEvidence | undefined): boolean =>
      evidence?.provider === attempt.provider && evidence.evalId === attempt.evalId
    if (attempt.phase === 'seed-baseline') {
      return matches(round.baseline)
        || round.parentBaselines?.some(value => matches(value.evidence)) === true
    }
    if (attempt.phase === 'seed-candidate') {
      return round.candidatePool.some(candidate => matches(candidate.seedEvaluation))
    }
    if (attempt.phase === 'held-out-baseline') return matches(round.evaluation?.heldOutBaseline)
    return matches(round.evaluation?.heldOutCandidate)
      || round.candidatePool.some(candidate => matches(candidate.heldOutEvaluation))
  }

  private pendingRepairAttempt(round: RefinementRound): RoundEvaluationAttempt | undefined {
    if (round.commitIntent !== undefined || round.decision !== undefined || TERMINAL.has(round.status)) return undefined
    if (round.evaluationRepairResume !== undefined) {
      const attempt = round.evaluationAttempts?.find(value => this.sameAttempt(value, round.evaluationRepairResume!))
      if (attempt?.status !== 'repair-completed' || attempt.completedAt !== round.evaluationRepairResume.completedAt
        || !this.attemptHasEvidence(round, attempt)) {
        throw new Error(`round ${round.roundId} has an invalid evaluation repair resume intent`)
      }
      return attempt
    }
    if (round.status !== 'repairing-evaluation') return undefined
    const pending = (round.evaluationAttempts ?? []).filter(attempt => (
      attempt.status === 'repair-completed' || attempt.status === 'rerunning'
    ) && this.attemptHasEvidence(round, attempt))
    if (pending.length > 1) throw new Error(`round ${round.roundId} has multiple completed evaluation repairs`)
    return pending[0]
  }

  private async resumeCompletedEvaluationRepair(pending: PendingEvaluationResume): Promise<void> {
    if (this.active.has(pending.roundId) || this.repairs.has(pending.roundId)) {
      throw new Error(`refinement round is already active: ${pending.roundId}`)
    }
    const evolution = await this.runtime(pending.evolutionId)
    const lock = await evolution.store.acquireRoundLock(pending.roundId)
    let handedToDrive = false
    try {
      const round = await this.requireRound(evolution.store, pending.roundId)
      const attempt = round.evaluationAttempts?.find(value => this.sameAttempt(value, pending.attempt))
      if (round.evaluationRepairResume === undefined
        || !this.sameAttempt(round.evaluationRepairResume, pending.attempt)
        || attempt?.status !== 'repair-completed'
        || !this.attemptHasEvidence(round, attempt)) {
        throw new Error(`round ${pending.roundId} no longer has a completed evaluation repair to resume`)
      }
      const active = this.newActive(
        evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus,
      )
      active.repairAttempt = { ...pending.attempt }
      this.active.set(pending.roundId, active)
      handedToDrive = true
    } finally {
      if (!handedToDrive) await lock.release().catch(() => {})
    }
  }

  private repairableAttempts(round: RefinementRound): RoundEvaluationAttempt[] {
    if (round.decision !== undefined || round.commitIntent !== undefined) return []
    return (round.evaluationAttempts ?? []).filter(attempt =>
      attempt.provider === 'hitch-cli'
      && attempt.status === 'failed'
      && !this.attemptHasEvidence(round, attempt)
      && (attempt.phase !== 'seed-candidate' || round.candidatePool.some(candidate =>
        candidate.candidateId === attempt.owner.candidateId
        && candidate.sealedVersion?.commitOid === attempt.requestedCommit
        && candidate.seedEvaluation === undefined)),
    )
  }

  async submitFinalization(
    evolutionId: string,
    roundId: string,
    finalization: CandidateFinalization | null,
    decline: CandidateDecline | undefined,
    meta: MetaAttribution,
    evidence: ProposalEvidenceAudit,
  ): Promise<CandidateDiffSummary | undefined> {
    const active = this.active.get(roundId)
    if (active === undefined || active.evolution.spec.evolutionId !== evolutionId) throw new Error(`stale or unknown refinement round: ${roundId}`)
    const execution = [...active.executions.values()].find(value => value.metaSessionId === meta.sessionId)
    if (execution === undefined) throw new Error('finalization Meta session does not own an active candidate')
    const round = await this.requireRound(active.evolution.store, roundId)
    execution.signal.throwIfAborted()
    if (execution.metaSessionId !== meta.sessionId) throw new Error('stale finalization Meta session generation')
    if (round.status !== 'candidate-editing') throw new Error(`round ${roundId} is not accepting a finalization`)
    if (execution.finalizationSubmitted) throw new Error(`candidate ${execution.candidateId} already received a finalization`)
    if (meta.evolutionId !== evolutionId || evidence.candidateId !== execution.candidateId) {
      throw new Error('finalization Meta session does not own this evolution candidate')
    }
    const candidate = round.candidatePool.find(value => value.candidateId === execution.candidateId)
    const baseline = round.parentBaselines?.find(value => value.parentCandidateId === candidate?.parentCandidateIds[0])?.evidence
    if (candidate === undefined || baseline === undefined) throw new Error('candidate parent baseline is unavailable')
    if (round.searchMode && (candidate.workplanDelivery?.digest !== evidence.workplanDelivery?.digest
      || evidence.workplanReceipt?.sessionId !== meta.sessionId)) throw new Error('workplan receipt is not bound to the active candidate/session')
    this.validateFinalizationEvidence(round, baseline, finalization, decline, evidence)
    let diff: CandidateDiffSummary | undefined
    if (finalization !== null) {
      if (execution.workspace === undefined) throw new Error('candidate has no workspace')
      diff = await this.workspaceManager.seal(execution.workspace.workspaceId, execution.signal)
      if (diff.files.length === 0) throw new Error('candidate has no changes; use decline_candidate')
    }
    execution.signal.throwIfAborted()
    if (execution.metaSessionId !== meta.sessionId || execution.finalizationSubmitted) throw new Error('stale or duplicate candidate finalization')
    execution.finalizationSubmitted = true
    execution.finalization.resolve({
      finalization,
      ...(decline === undefined ? {} : { decline }),
      ...(diff === undefined ? {} : { diff }),
      meta,
      evidence,
    })
    if (meta.source?.kind === 'skill-lease') await execution.finalizationPersisted.promise
    return diff
  }

  async failMetaExecution(
    evolutionId: string,
    roundId: string,
    candidateId: string,
    sessionId: string,
    reason: string,
  ): Promise<{ failed: true; evolutionId: string; roundId: string; candidateId: string }> {
    const active = this.active.get(roundId)
    if (active === undefined || active.evolution.spec.evolutionId !== evolutionId) {
      throw new Error(`stale or unknown refinement round: ${roundId}`)
    }
    const execution = active.executions.get(candidateId)
    if (execution === undefined || execution.metaSessionId !== sessionId) {
      throw new Error('Meta failure lease does not own the active candidate')
    }
    if (execution.finalizationSubmitted) {
      throw new Error('candidate already received a finalization; inspect control.status')
    }
    if (active.abort.signal.aborted || execution.signal.aborted) {
      throw new Error('candidate generation is already stopping; inspect control.status')
    }
    await Promise.allSettled([...(execution.evidenceWrites ?? [])])
    const persisted = await active.evolution.store.readRound(roundId)
    const prerequisite = persisted?.candidatePool.find(candidate => candidate.candidateId === candidateId)
      ?.generationAttempts?.find(attempt => attempt.metaSessionId === sessionId && attempt.status === 'running')
      ?.prerequisiteBlocker
    const failure = new ExternalMetaFailureError(reason, prerequisite)
    execution.abort.abort(failure)
    execution.finalization.reject(failure)
    execution.finalizationPersisted.reject(failure)
    active.abort.abort(failure)
    const drive = active.drive
    if (drive === undefined) throw new Error('active Meta execution has no owning drive')
    await drive
    const round = await active.evolution.store.readRound(roundId)
    const attempt = round?.candidatePool.find(candidate => candidate.candidateId === candidateId)
      ?.generationAttempts?.at(-1)
    if (round?.status !== 'failed' || attempt?.status !== 'failed') {
      throw new Error('Meta failure did not reach durable failed state; inspect control.status')
    }
    return { failed: true, evolutionId, roundId, candidateId }
  }

  async recordMetaPrerequisiteBlocker(
    sessionId: string,
    prerequisite: MetaPrerequisiteFailure,
  ): Promise<void> {
    const entry = this.activeEntryForSession(sessionId)
    if (entry === undefined) throw new Error('stale candidate prerequisite owner')
    const execution = this.active.get(entry.roundId)?.executions.get(entry.candidateId)
    if (execution === undefined || execution.metaSessionId !== sessionId) throw new Error('stale candidate prerequisite owner')
    await this.enqueueMetaPrerequisiteWrite(execution, async () => {
      const round = await entry.store.readRound(entry.roundId)
      if (round === undefined) throw new Error(`unknown refinement round: ${entry.roundId}`)
      const candidate = round.candidatePool.find(value => value.candidateId === entry.candidateId)
      if (candidate?.generationAttempts === undefined) throw new Error('candidate generation attempt is unavailable')
      const attempt = candidate.generationAttempts.find(value => value.metaSessionId === sessionId && value.status === 'running')
      if (attempt === undefined) throw new Error('stale candidate prerequisite attempt')
      await this.transition(entry.store, entry.roundId, {
        candidatePool: this.patchCandidate(round, entry.candidateId, {
          generationAttempts: patchGenerationAttempt(candidate.generationAttempts, attempt.attempt, {
            prerequisiteBlocker: structuredClone(prerequisite),
          }),
        }),
      })
    })
  }

  async clearMetaPrerequisiteBlocker(sessionId: string, runId?: string): Promise<void> {
    const entry = this.activeEntryForSession(sessionId)
    if (entry === undefined) return
    const execution = this.active.get(entry.roundId)?.executions.get(entry.candidateId)
    if (execution === undefined || execution.metaSessionId !== sessionId) return
    await this.enqueueMetaPrerequisiteWrite(execution, async () => {
      const round = await entry.store.readRound(entry.roundId)
      const candidate = round?.candidatePool.find(value => value.candidateId === entry.candidateId)
      const attempts = candidate?.generationAttempts
      const attempt = attempts?.find(value => value.metaSessionId === sessionId && value.status === 'running')
      const current = attempt?.prerequisiteBlocker
      if (round === undefined || candidate === undefined || attempts === undefined || attempt === undefined || current === undefined) return
      const blockedRuns = runId === undefined
        ? []
        : current.blockedRuns.filter(value => value.runId !== runId)
      const generationAttempts = attempts.map(value => {
        if (value.attempt !== attempt.attempt) return value
        if (blockedRuns.length > 0) return { ...value, prerequisiteBlocker: { ...current, blockedRuns } }
        const { prerequisiteBlocker: _prerequisiteBlocker, ...cleared } = value
        return cleared
      })
      await this.transition(entry.store, entry.roundId, {
        candidatePool: this.patchCandidate(round, entry.candidateId, {
          generationAttempts,
        }),
      })
    })
  }

  private async enqueueMetaPrerequisiteWrite(
    execution: CandidateExecution,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = execution.prerequisiteWrite
    const write = (previous === undefined ? Promise.resolve() : previous.catch(() => {})).then(operation)
    execution.prerequisiteWrite = write
    const writes = execution.evidenceWrites ??= new Set()
    writes.add(write)
    try { await write }
    finally {
      writes.delete(write)
      if (execution.prerequisiteWrite === write) delete execution.prerequisiteWrite
    }
  }

  async status(evolutionId: string, roundId?: string): Promise<PublicRoundStatus> {
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    const evolution = await this.runtime(evolutionId)
    const round = roundId === undefined
      ? (await evolution.store.listRounds()).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
      : await evolution.store.readRound(roundId)
    if (round === undefined) throw new Error(`evolution has no matching refinement round: ${evolutionId}`)
    let repairableEvaluations: PublicRoundStatus['repairableEvaluations']
    if (entry.status === 'active' && round.status === 'failed'
      && round.decision === undefined && round.commitIntent === undefined) {
      const [population, champion] = await Promise.all([
        evolution.store.readPopulation(), evolution.store.readChampion(),
      ])
      if (population?.digest === round.parentPopulationDigest
        && champion?.ref === round.targetHarnessRef
        && champion.manifestDigest === round.targetHarnessDigest) {
        repairableEvaluations = this.repairableAttempts(round).map(attempt => ({
          provider: attempt.provider,
          evalId: attempt.evalId,
          phase: attempt.phase,
          candidateId: attempt.owner.candidateId,
          repetitions: attempt.phase.startsWith('seed-')
            ? round.plan.seed.repetitions
            : round.plan.heldOut.repetitions,
        }))
      }
    }
    const candidateGeneration = round.candidatePool.flatMap(candidate => candidate.generationAttempts === undefined
      ? []
      : [{
          candidateId: candidate.candidateId,
          status: candidate.status,
          ...this.activeGenerationBudget(round.roundId, candidate.candidateId),
          attempts: candidate.generationAttempts.map(attempt => ({
            attempt: attempt.attempt,
            status: attempt.status,
            startedAt: attempt.startedAt,
            ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
            ...(attempt.preparationCompletedAt === undefined ? {} : { preparationCompletedAt: attempt.preparationCompletedAt }),
            ...(attempt.proposalCompletedAt === undefined ? {} : { proposalCompletedAt: attempt.proposalCompletedAt }),
            ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
            ...(attempt.metaSessionId === undefined ? {} : { metaSessionId: attempt.metaSessionId }),
            ...(attempt.metaTurn === undefined ? {} : { metaTurn: structuredClone(attempt.metaTurn) }),
            ...(attempt.failure === undefined ? {} : { failure: { ...attempt.failure } }),
          })),
        }])
    const pendingSearchEvidence = round.searchMode && !round.searchOutcome
      ? await new SearchStore(join(this.registry.stateStore(evolutionId).root, 'search')).read<{ planDigest: string; resultRefs: string[] }>(`rounds/${round.roundId}/pending-evidence`)
      : undefined
    const pendingSearchOperation = round.searchMode && !round.searchOutcome
      ? await new SearchStore(join(this.registry.stateStore(evolutionId).root, 'search')).read<import('../search/types.js').PendingSearchOperation | null>(`rounds/${round.roundId}/pending-operation`)
      : undefined
    const searchProgress = round.searchMode
      ? await new SearchStore(join(evolution.store.root, 'search')).read<import('../search/types.js').SearchProgress>(`rounds/${round.roundId}/progress`)
      : undefined
    return {
      evolutionId, batchId: round.batchId, roundId: round.roundId, status: round.status,
      ...(pendingSearchOperation ? { searchPendingOperation: pendingSearchOperation } : {}),
      ...(pendingSearchEvidence ? { searchPendingEvidence: pendingSearchEvidence } : {}),
      ...(searchProgress ? { searchProgress } : {}),
      ...(round.searchOutcome ? { search: structuredClone(round.searchOutcome) } : {}),
      ...(round.decision === undefined ? {} : { decision: round.decision }),
      ...(round.evaluation?.seedCandidate !== undefined
        ? { seedSummary: round.evaluation.seedCandidate.summary }
        : round.baseline === undefined ? {} : { seedSummary: round.baseline.summary }),
      ...(round.baseline === undefined ? {} : { seedBaseline: publicSeedEvidence(round.baseline) }),
      ...(round.evaluation?.seedCandidate === undefined ? {} : { seedCandidate: publicSeedEvidence(round.evaluation.seedCandidate) }),
      ...(round.failure === undefined ? {} : { failure: round.failure.phase }),
      ...(round.baselineReuseBlocker === undefined ? {} : { baselineReuseBlocker: { ...round.baselineReuseBlocker } }),
      ...((round.pendingEvaluationSubmissions ?? []).some(value => value.cleanupFailure !== undefined)
        || round.pendingEvaluationRerun?.cleanupFailure !== undefined ? {
        evaluationCleanupFailures: [...(round.pendingEvaluationSubmissions ?? []).flatMap(value => value.cleanupFailure === undefined ? [] : [{
          provider: value.intent.provider,
          ...(value.reservation === undefined ? {} : { evalId: value.reservation.evalId }),
          code: value.cleanupFailure.code,
        }]), ...(round.pendingEvaluationRerun?.cleanupFailure === undefined ? [] : [{
          provider: round.pendingEvaluationRerun.reservation.provider,
          evalId: round.pendingEvaluationRerun.reservation.evalId,
          rerunId: round.pendingEvaluationRerun.reservation.rerunId,
          code: round.pendingEvaluationRerun.cleanupFailure.code,
        }])],
      } : {}),
      ...(candidateGeneration.length === 0 ? {} : { candidateGeneration }),
      ...(repairableEvaluations === undefined ? {} : { repairableEvaluations }),
    }
  }

  listEvolutions(): Promise<EvolutionRegistryEntry[]> { return this.registry.list() }

  private activeGenerationBudget(roundId: string, candidateId: string): { budget?: CandidateGenerationBudgetStatus } {
    const execution = this.active.get(roundId)?.executions.get(candidateId)
    return execution?.generationBudget === undefined ? {} : { budget: generationBudgetSnapshot(execution.generationBudget) }
  }

  async rollback(evolutionId: string, verifiedHarnessRef: string): Promise<ChampionState> {
    const evolution = await this.runtime(evolutionId)
    const lock = await evolution.store.acquireRoundLock(`rollback-${crypto.randomUUID()}`)
    try {
      const verified = (await evolution.store.listRounds()).flatMap(round => round.candidatePool.map(candidate => ({ round, candidate })))
        .find(({ round, candidate }) => round.status === 'accepted' && round.decision === 'accepted'
          && candidate.sealedVersion?.commitOid === verifiedHarnessRef
          && candidate.heldOutEvaluation?.actualCommit === verifiedHarnessRef)
      if (verified?.candidate.sealedVersion === undefined) {
        throw new Error(`harness ref was not accepted by evolution ${evolutionId}: ${verifiedHarnessRef}`)
      }
      const current = await this.requireChampion(evolution.store)
      const restored: ChampionState = {
        schemaVersion: 2, ref: verified.candidate.sealedVersion.commitOid,
        manifestDigest: verified.candidate.sealedVersion.manifestDigest,
        updatedAt: now(), roundId: `rollback:${verified.round.roundId}`,
      }
      await evolution.store.compareAndSwapChampion(current.ref, restored)
      return restored
    } finally { await lock.release() }
  }

  async publish(evolutionId: string, verifiedHarnessRef?: string): Promise<void> {
    if (!this.options.publishedPointer) throw new Error('workspace-wide published pointer is disabled')
    const evolution = await this.runtime(evolutionId)
    const champion = await this.requireChampion(evolution.store)
    let selected = champion
    if (verifiedHarnessRef !== undefined && verifiedHarnessRef !== champion.ref) {
      const accepted = (await evolution.store.listRounds()).flatMap(round => round.candidatePool.map(candidate => ({ round, candidate })))
        .find(({ round, candidate }) => round.status === 'accepted' && candidate.sealedVersion?.commitOid === verifiedHarnessRef)
      if (accepted?.candidate.sealedVersion === undefined) throw new Error('publish ref is not accepted history of this evolution')
      selected = {
        schemaVersion: 2, ref: verifiedHarnessRef,
        manifestDigest: accepted.candidate.sealedVersion.manifestDigest, updatedAt: now(), roundId: accepted.round.roundId,
      }
    }
    const current = await this.registry.readPublished()
    await this.registry.compareAndSwapPublished(current?.ref, {
      schemaVersion: 1, ref: selected.ref, manifestDigest: selected.manifestDigest,
      publishedAt: now(), sourceEvolutionId: evolutionId,
      ...(selected.roundId === undefined ? {} : { roundId: selected.roundId }),
    })
  }

  async champion(evolutionId: string): Promise<ChampionState> { return this.requireChampion((await this.runtime(evolutionId)).store) }

  activeEntry(roundId: string): { evolutionId: string; store: RefineStateStore; meta: MetaSessionController; workspace?: CandidateWorkspaceHandle } | undefined {
    const active = this.active.get(roundId)
    const execution = active?.currentCandidateId === undefined ? undefined : active.executions.get(active.currentCandidateId)
    return active === undefined ? undefined : {
      evolutionId: active.evolution.spec.evolutionId, store: active.evolution.store, meta: active.evolution.meta,
      ...(execution?.workspace === undefined ? {} : { workspace: execution.workspace }),
    }
  }

  activeEntryForSession(sessionId: string): {
    evolutionId: string
    spec: EvolutionSpec
    roundId: string
    store: RefineStateStore
    meta: MetaSessionController
    workspace: CandidateWorkspaceHandle
    candidateId: string
    parentHarnessRef: string
    parentHarnessDigest: string
    baseline: EvaluationEvidence
    signal: AbortSignal
    generationBudget?: CandidateGenerationBudgetStatus
  } | undefined {
    for (const [roundId, active] of this.active) {
      const execution = [...active.executions.values()].find(value => value.metaSessionId === sessionId)
      if (execution?.workspace === undefined || execution.signal.aborted || execution.finalizationSubmitted) continue
      // activeEntryForSession is synchronous; generation stores this routing on
      // the workspace and candidate execution, so derive the immutable parent
      // from the handle and use the in-memory baseline snapshot below.
      const baseline = execution.baseline
      if (baseline === undefined) continue
      return {
        evolutionId: active.evolution.spec.evolutionId,
        spec: active.evolution.spec,
        roundId,
        store: active.evolution.store,
        meta: active.evolution.meta,
        workspace: execution.workspace,
        candidateId: execution.candidateId,
        parentHarnessRef: execution.workspace.parentRef,
        parentHarnessDigest: execution.workspace.parentDigest,
        baseline,
        signal: execution.signal,
        ...(execution.generationBudget === undefined ? {} : {
          generationBudget: generationBudgetSnapshot(execution.generationBudget),
        }),
      }
    }
    return undefined
  }

  private diagnosisStoreForSession(sessionId: string): CandidateDiagnosisStore {
    const active = this.activeEntryForSession(sessionId)
    if (active === undefined) throw new Error('stale candidate diagnosis owner')
    return new CandidateDiagnosisStore(active.store.root, {
      evolutionId: active.evolutionId, specDigest: digestJson(active.spec), roundId: active.roundId,
      candidateId: active.candidateId, parentHarnessDigest: active.parentHarnessDigest,
      baselineDigest: digestJson(active.baseline),
    })
  }

  async readCandidateDiagnoses(sessionId: string): Promise<CandidateDiagnosisRecord[]> {
    const records = await this.diagnosisStoreForSession(sessionId).read()
    if (this.activeEntryForSession(sessionId) === undefined) throw new Error('stale candidate diagnosis owner')
    return records
  }

  async recordCandidateDiagnosis(sessionId: string, record: Omit<CandidateDiagnosisRecord, 'source'>): Promise<void> {
    const active = this.activeEntryForSession(sessionId)
    if (active === undefined) throw new Error('stale candidate diagnosis owner')
    const execution = this.active.get(active.roundId)!.executions.get(active.candidateId)!
    const assertOwner = () => {
      execution.signal.throwIfAborted()
      if (execution.metaSessionId !== sessionId || execution.finalizationSubmitted) throw new Error('stale candidate diagnosis owner')
    }
    const operation = this.diagnosisStoreForSession(sessionId).write({ ...record,
      source: { sessionId, attempt: execution.generationBudget!.attempt },
    }, assertOwner)
    const writes = execution.evidenceWrites ??= new Set()
    writes.add(operation)
    try { await operation }
    finally { writes.delete(operation) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const error = new Error('RefineService disposed')
    const runningDrives = [...this.drives]
    for (const repair of this.repairs.values()) repair.abort.abort(error)
    for (const active of this.active.values()) {
      active.abort.abort(error)
      for (const execution of active.executions.values()) {
        execution.abort.abort(error)
        execution.finalization.reject(error)
        execution.finalizationPersisted.reject(error)
      }
    }
    await Promise.allSettled([...this.repairs.values()].flatMap(repair => repair.completion === undefined ? [] : [repair.completion]))
    const drives = [...new Set([...runningDrives, ...this.drives])]
    const driveResults = await Promise.allSettled(drives)
    await Promise.all([...this.repairs.values()].map(repair => repair.lock.release().catch(() => {})))
    this.repairs.clear()
    await Promise.all([...this.active.values()].map(active => active.lock.release().catch(() => {})))
    this.active.clear()
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.meta.dispose()))
    this.runtimes.clear()
    const failures = driveResults.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'failed to settle refinement rounds during dispose')
  }

  private async startBatch(
    evolution: EvolutionRuntime,
    source: RefinementRound['source'],
    batchId: string,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
    baselineSource?: BaselineSourceSnapshot,
  ): Promise<AdmissionResult> {
    const roundId = crypto.randomUUID()
    const lock = await evolution.store.acquireRoundLock(roundId)
    const champion = await this.requireChampion(evolution.store).catch(async (error: unknown) => { await lock.release(); throw error })
    const population = await evolution.store.readPopulation().catch(async (error: unknown) => { await lock.release(); throw error })
    if (population === undefined) { await lock.release(); throw new Error('evolution has no research population') }
    let round = await this.newRound(
      evolution.store, evolution.spec, champion, population, source, batchId, roundId, 1, roundCount, advisoryFocus,
    ).catch(async (error: unknown) => { await lock.release(); throw error })
    if (baselineSource !== undefined) {
      try {
        round = this.attachBaselineSource(evolution.spec, round, baselineSource)
      } catch (error) {
        await lock.release()
        throw error
      }
    }
    const active = this.newActive(evolution, lock, source, batchId, 1, roundCount, advisoryFocus)
    this.active.set(roundId, active)
    try {
      if (evolution.spec.experienceMemory?.enabled === true) {
        const usageReader = this.experienceUsageReader(evolution.spec)
        round = {
          ...round,
          experienceSnapshot: await prepareSeedExperienceSnapshot(evolution.spec, evolution.store, roundId, {
            artifactReader: this.builder,
            ...(usageReader === undefined ? {} : { usageReader }),
            signal: active.abort.signal,
          }),
        }
      }
      await evolution.store.writeRound(round)
      await this.registry.touch(evolution.spec.evolutionId, { batchId, roundId })
    } catch (error) {
      this.active.delete(roundId)
      await lock.release()
      throw error
    }
    queueMicrotask(() => this.startDrive(roundId))
    return { evolutionId: evolution.spec.evolutionId, batchId, roundId, status: 'queued' }
  }

  private async newRound(
    store: RefineStateStore,
    spec: EvolutionSpec,
    champion: ChampionState,
    population: PopulationState,
    source: RefinementRound['source'],
    batchId: string,
    roundId: string,
    roundIndex: number,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
  ): Promise<RefinementRound> {
    const championParent = spec.searchSettings ? undefined : await resolveChampionParent(spec, champion, store)
    const timestamp = now()
    const taskSampler = this.components.taskSampler(spec.rollout.taskSampler)
    const plan = taskSampler.resolve(roundId, spec.datasets, spec.rollout, spec.taskBudgetMs)
    const priorArchive = spec.searchSettings ? await new SearchStore(join(store.root, 'search')).archive() : undefined
    const savedAnchor = priorArchive?.snapshots.find(s => s.commit === champion.ref && s.manifestDigest === champion.manifestDigest)
    const slots = spec.searchSettings ? [] : this.components.candidateGenerator(spec.candidateGeneration.strategy)
      .plan(roundId, [championParent!].map(member => ({
        candidateId: member.candidateId,
        harnessRef: member.harnessRef,
        harnessDigest: member.harnessDigest,
        parentCandidateIds: [...member.parentCandidateIds],
        lineageRootId: member.lineageRootId,
        metrics: { ...member.metrics },
      })), spec.candidateGeneration.maxCandidates)
    if (!spec.searchSettings && slots.length !== spec.candidateGeneration.maxCandidates) throw new Error('candidate generator returned the wrong number of slots')
    const parentAllocations = slots.map(slot => {
      if (slot.parentCandidateIds.length !== 1) throw new Error('each candidate must have exactly one research parent')
      const parent = championParent!
      if (parent.candidateId !== slot.parentCandidateIds[0] || parent.harnessRef !== slot.parentHarnessRef) {
        throw new Error('candidate generator must use the pinned champion parent')
      }
      return {
        candidateId: slot.candidateId,
        parentCandidateId: parent.candidateId,
        parentHarnessRef: parent.harnessRef,
        parentHarnessDigest: parent.harnessDigest,
      }
    })
    return {
      evolutionId: spec.evolutionId, roundId, workspaceRoot: this.options.workspaceRoot,
      status: 'queued', source, createdAt: timestamp, updatedAt: timestamp,
      metaHarnessRef: spec.metaAgent.preset.id, targetHarnessRef: champion.ref, targetHarnessDigest: champion.manifestDigest,
      sandboxProfileRef: spec.sandboxProfileRef, seedTaskRef: spec.datasets.seed.ref, heldOutRef: spec.datasets.heldOut.ref,
      ...(spec.evaluation.mode === undefined ? {} : { evaluationMode: spec.evaluation.mode }),
      taskBudgetMs: spec.taskBudgetMs, promotionPolicy: { ...spec.promotion.policy.config },
      batchId, roundIndex, roundCount, plan,
      parentPopulationDigest: population.digest,
      ...(championParent ? { championParent: structuredClone(championParent) } : {}),
      ...(spec.searchSettings ? {
        searchMode: 'failure-cluster-gepa-v1' as const,
        searchAnchor: { snapshot: savedAnchor ?? await this.builder.searchSnapshot(`champion-${champion.ref}`, champion.ref), championRevisionDigest: digestJson(champion) },
      } : {}),
      parentAllocations,
      candidatePool: slots.map(slot => ({ ...slot, roundId, status: 'generating' })),
      ...(advisoryFocus === undefined ? {} : { advisoryFocus }),
    }
  }

  private newActive(
    evolution: EvolutionRuntime,
    lock: WorkspaceLock,
    source: RefinementRound['source'],
    batchId: string,
    roundIndex: number,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
  ): ActiveRound {
    return {
      evolution, lock, source, batchId, roundIndex, roundCount,
      abort: new AbortController(), executions: new Map(),
      ...(advisoryFocus === undefined ? {} : { advisoryFocus }),
    }
  }

  private async drive(roundId: string): Promise<void> {
    const active = this.active.get(roundId)
    if (active === undefined) return
    const { store, meta } = active.evolution
    let continueBatch = false
    try {
      if (active.evolution.spec.searchSettings) {
        await this.driveSearch(active, roundId)
        continueBatch = true
        return
      }
      active.abort.signal.throwIfAborted()
      const beforeResume = await this.requireRound(store, roundId)
      active.abort.signal.throwIfAborted()
      if (active.repairAttempt !== undefined) {
        const repairAttempt = beforeResume.evaluationAttempts?.find(attempt => this.sameAttempt(attempt, active.repairAttempt!))
        if (beforeResume.evaluationRepairResume === undefined
          || !this.sameAttempt(beforeResume.evaluationRepairResume, active.repairAttempt)
          || repairAttempt?.status !== 'repair-completed'
          || !this.attemptHasEvidence(beforeResume, repairAttempt)) {
          throw new Error(`round ${roundId} has no completed evaluation repair to resume`)
        }
      }
      let round = beforeResume
      if (active.resumeHeldOut === true) {
        if (round.status !== 'held-out-running' || round.selection === undefined || round.baseline === undefined) {
          throw new Error(`round ${roundId} lost its selected held-out recovery state`)
        }
        const population = await store.readPopulation()
        active.abort.signal.throwIfAborted()
        if (population === undefined || population.digest !== round.parentPopulationDigest) throw new Error('research population changed during round admission')
        const championCandidateId = round.parentAllocations
          ?.find(allocation => allocation.parentHarnessRef === round.targetHarnessRef)?.parentCandidateId
          ?? `champion-${round.targetHarnessRef}`
        await this.finishSelectedRound(active, round, population, round.selection, round.baseline, championCandidateId)
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'baseline-running' })
      active.abort.signal.throwIfAborted()
      const population = await store.readPopulation()
      active.abort.signal.throwIfAborted()
      if (population === undefined || population.digest !== round.parentPopulationDigest) throw new Error('research population changed during round admission')
      // New rounds pin the champion independently of research survivors. Legacy
      // rounds retain their original parents when explicit repair resumes them.
      const generationParents = round.championParent === undefined ? population.members : [round.championParent]
      const championCandidateId = round.parentAllocations?.find(allocation => allocation.parentHarnessRef === round.targetHarnessRef)?.parentCandidateId
        ?? `champion-${round.targetHarnessRef}`
      let championBaseline = round.baseline
        ?? round.parentBaselines?.find(value => value.parentCandidateId === championCandidateId)?.evidence
      if (championBaseline === undefined) {
        const reusable = await this.findReusableBaseline(
          store, active.evolution.evaluator, round, round.targetHarnessRef, 'seed', active.abort.signal, championCandidateId,
        )
        if (reusable !== undefined) {
          active.abort.signal.throwIfAborted()
          round = await this.persistReusableSeedBaseline(
            store, round, championCandidateId, round.targetHarnessRef, reusable, true,
          )
          championBaseline = reusable.evidence
        } else {
          const champion = await this.evaluateWithAttempt(active, round, {
            phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: round.targetHarnessRef,
            condition: round.plan.seed,
          }, {
            candidateId: championCandidateId, role: 'baseline', harnessRef: round.targetHarnessRef,
          }, (current, evidence) => ({
            baseline: evidence,
            parentBaselines: [
              ...(current.parentBaselines ?? []).filter(value => value.parentCandidateId !== championCandidateId),
              { parentCandidateId: championCandidateId, parentHarnessRef: round.targetHarnessRef, evidence },
            ],
          }))
          round = champion.round
          championBaseline = champion.evidence
        }
      }
      let parentBaselines = round.parentBaselines ?? []
      const allocatedParentIds = [...new Set((round.parentAllocations ?? []).map(allocation => allocation.parentCandidateId))]
      for (const parentCandidateId of allocatedParentIds) {
        const parent = generationParents.find(member => member.candidateId === parentCandidateId)
        if (parent === undefined) throw new Error(`allocated research parent is unavailable: ${parentCandidateId}`)
        if (parentBaselines.some(value => value.parentCandidateId === parent.candidateId)) continue
        const reusable = await this.findReusableBaseline(
          store, active.evolution.evaluator, round, parent.harnessRef, 'seed', active.abort.signal, parent.candidateId,
        )
        if (reusable !== undefined) {
          active.abort.signal.throwIfAborted()
          round = await this.persistReusableSeedBaseline(
            store, round, parent.candidateId, parent.harnessRef, reusable, false,
          )
        } else {
          const evaluated = await this.evaluateWithAttempt(active, round, {
            phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: parent.harnessRef, condition: round.plan.seed,
          }, {
            candidateId: parent.candidateId, role: 'baseline', harnessRef: parent.harnessRef,
          }, (current, evidence) => ({
            parentBaselines: [...(current.parentBaselines ?? []), {
              parentCandidateId: parent.candidateId, parentHarnessRef: parent.harnessRef, evidence,
            }],
          }))
          round = evaluated.round
        }
        parentBaselines = round.parentBaselines ?? []
      }
      round = await this.transition(store, roundId, {
        status: 'preparing-candidate',
      })
      active.abort.signal.throwIfAborted()

      round = await this.generateCandidates(active, round, generationParents)

      round = await this.transition(store, roundId, { status: 'candidate-seed-running' })
      active.abort.signal.throwIfAborted()
      for (const candidate of round.candidatePool.filter(value => value.sealedVersion !== undefined && value.status !== 'failed')) {
        active.abort.signal.throwIfAborted()
        const parentBaseline = parentBaselines.find(value => value.parentCandidateId === candidate.parentCandidateIds[0])?.evidence
        if (parentBaseline === undefined || candidate.sealedVersion === undefined) throw new Error('candidate seed baseline is unavailable')
        if (candidate.seedEvaluation !== undefined) {
          this.assertParity(parentBaseline, candidate.seedEvaluation, 'seed')
          if (candidate.seedComparison === undefined || candidate.metrics === undefined || candidate.status !== 'ready') {
            const seedPairs = pairedTrials(parentBaseline, candidate.seedEvaluation)
            const baselineAggregate = pairedAggregate(seedPairs, 'baseline')
            const candidateAggregate = pairedAggregate(seedPairs, 'candidate')
            const comparisonBase = {
              parentBaselineEvalId: parentBaseline.evalId,
              pairedTrials: seedPairs,
              pairing: pairingAudit(parentBaseline, candidate.seedEvaluation, seedPairs),
              scoreDelta: candidateAggregate.score - baselineAggregate.score,
              ...(pairedProcessDelta(seedPairs) === undefined ? {} : { processScoreDelta: pairedProcessDelta(seedPairs)! }),
            }
            if (seedPairs.length === 0) {
              round = await this.transition(store, roundId, {
                candidatePool: this.patchCandidate(round, candidate.candidateId, {
                  seedComparison: { ...comparisonBase, requiredRegressions: 0 },
                  metrics: undefined,
                  status: 'failed',
                  failure: { phase: 'candidate-seed-running', message: 'seed baseline/candidate have no valid paired trials' },
                }),
              })
              continue
            }
            const comparison = { ...comparisonBase, requiredRegressions: this.requiredRegressions(round, seedPairs) }
            const metrics = await this.evaluateJudges(
              active.evolution.spec,
              projectPairedEvidence(candidate.seedEvaluation, seedPairs, 'candidate'),
            )
            active.abort.signal.throwIfAborted()
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidate.candidateId, {
                seedComparison: comparison,
                metrics,
                status: 'ready',
                failure: undefined,
              }),
            })
          }
          continue
        }
        round = await this.transition(store, roundId, {
          candidatePool: this.patchCandidate(round, candidate.candidateId, { status: 'evaluating' }),
        })
        try {
          const evaluated = await this.evaluateWithAttempt(active, round, {
            phase: 'seed-candidate', dataset: round.seedTaskRef, harnessRef: candidate.sealedVersion.commitOid,
            condition: round.plan.seed,
          }, {
            candidateId: candidate.candidateId, role: 'candidate', harnessRef: candidate.sealedVersion.commitOid,
          }, async (current, seedCandidate) => {
            this.assertParity(parentBaseline, seedCandidate, 'seed')
            const seedPairs = pairedTrials(parentBaseline, seedCandidate)
            const baselineAggregate = pairedAggregate(seedPairs, 'baseline')
            const candidateAggregate = pairedAggregate(seedPairs, 'candidate')
            const comparisonBase = {
              parentBaselineEvalId: parentBaseline.evalId,
              pairedTrials: seedPairs,
              pairing: pairingAudit(parentBaseline, seedCandidate, seedPairs),
              scoreDelta: candidateAggregate.score - baselineAggregate.score,
              ...(pairedProcessDelta(seedPairs) === undefined ? {} : { processScoreDelta: pairedProcessDelta(seedPairs)! }),
            }
            if (seedPairs.length === 0) return {
              candidatePool: this.patchCandidate(current, candidate.candidateId, {
                seedEvaluation: seedCandidate,
                seedComparison: { ...comparisonBase, requiredRegressions: 0 },
                status: 'failed',
                failure: { phase: 'candidate-seed-running', message: 'seed baseline/candidate have no valid paired trials' },
              }),
            }
            const comparison = { ...comparisonBase, requiredRegressions: this.requiredRegressions(current, seedPairs) }
            return {
              candidatePool: this.patchCandidate(current, candidate.candidateId, {
                seedEvaluation: seedCandidate,
                seedComparison: comparison,
                metrics: await this.evaluateJudges(
                  active.evolution.spec,
                  projectPairedEvidence(seedCandidate, seedPairs, 'candidate'),
                ),
                status: 'ready',
              }),
            }
          })
          round = evaluated.round
        } catch (error) {
          active.abort.signal.throwIfAborted()
          round = await this.transition(store, roundId, {
            candidatePool: this.patchCandidate(round, candidate.candidateId, {
              status: 'failed', failure: { phase: 'candidate-seed-running', message: errorMessage(error) },
            }),
          })
        }
      }

      const selectable = round.candidatePool.flatMap(candidate => candidate.sealedVersion !== undefined
        && candidate.seedEvaluation !== undefined && candidate.seedComparison !== undefined && candidate.metrics !== undefined
        ? [{
            candidateId: candidate.candidateId, parentHarnessRef: candidate.parentHarnessRef,
            parentCandidateIds: candidate.parentCandidateIds, sealedVersion: candidate.sealedVersion,
            seedEvaluation: projectPairedEvidence(
              candidate.seedEvaluation,
              candidate.seedComparison.pairedTrials,
              'candidate',
            ),
            seedComparison: candidate.seedComparison, metrics: candidate.metrics,
          }]
        : [])
      active.abort.signal.throwIfAborted()
      if (selectable.length < active.evolution.spec.selection.survivors) {
        const repairableSeedAttempts = this.repairableAttempts(round).filter(attempt => attempt.phase === 'seed-candidate')
        if (repairableSeedAttempts.length > 0) {
          await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
            status: 'failed',
            failure: {
              phase: 'candidate-seed-running',
              message: `candidate evaluations can be repaired: ${repairableSeedAttempts.map(attempt => attempt.evalId).join(', ')}`,
            },
          }))
          return
        }
        const substrateCandidates = round.candidatePool.filter(candidate => candidate.status === 'failed'
          && candidate.failure?.phase === 'rejected-for-substrate')
        if (substrateCandidates.length > 0) {
          await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
            status: 'rejected-for-substrate', decision: 'rejected-for-substrate',
            failure: {
              phase: 'rejected-for-substrate',
              message: substrateCandidates.map(candidate => `${candidate.candidateId}: ${candidate.failure!.message}`).join('; '),
            },
          }))
          return
        }
        const failedGenerationCandidates = round.candidatePool.filter(candidate => candidate.status === 'failed'
          && (candidate.failure?.phase === 'candidate-generation' || candidate.failure?.phase === 'building-candidate'))
        if (failedGenerationCandidates.length > 0) {
          const prerequisite = failedGenerationCandidates
            .map(candidate => candidate.failure?.prerequisite)
            .find(value => value !== undefined)
          await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
            status: 'failed',
            failure: {
              phase: 'candidate-generation',
              message: failedGenerationCandidates
                .map(candidate => `${candidate.candidateId}: ${candidate.failure!.message}`)
                .join('; '),
              ...(prerequisite === undefined ? {} : { prerequisite: structuredClone(prerequisite) }),
            },
          }))
          return
        }
        await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
          status: 'rejected', decision: 'no-change',
          failure: { phase: 'selection', message: `only ${selectable.length} candidates were evaluable` },
        }))
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'selection-running' })
      const assessmentSignal = AbortSignal.any([
        active.abort.signal,
        AbortSignal.timeout(active.evolution.spec.selection.timeoutMs),
      ])
      const assessor = this.components.assessor(active.evolution.spec.selection.assessor)
      const reader = trajectoryReader(active.evolution.evaluator)
      const assessment = sealAssessment(assessor.ref, selectable, await assessor.assess({
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        candidates: selectable,
      }, {
        ...(reader === undefined ? {} : { trajectoryReader: reader }),
      }, assessmentSignal))
      const assessedSelectable = selectable.map(candidate => ({
        ...candidate,
        metrics: assessment.candidateMetrics[candidate.candidateId]!,
      }))
      round = await this.transition(store, roundId, {
        selectionAssessment: assessment,
        candidatePool: round.candidatePool.map(candidate => {
          const metrics = assessment.candidateMetrics[candidate.candidateId]
          return metrics === undefined ? candidate : { ...candidate, metrics }
        }),
      })
      const selection = this.components.selector(active.evolution.spec.selection.strategy)
        .select({
          candidates: assessedSelectable,
          survivors: active.evolution.spec.selection.survivors,
          assessment,
        })
      if (selection.assessmentDigest !== assessment.digest) throw new Error('selector decision is not bound to the current assessment')
      if (!selection.selectedCandidateIds.includes(selection.promotionCandidateId)) throw new Error('promotion finalist must be a survivor')
      round = await this.transition(store, roundId, {
        selection, promotionCandidateId: selection.promotionCandidateId,
        candidatePool: round.candidatePool.map(candidate => selection.selectedCandidateIds.includes(candidate.candidateId)
          ? { ...candidate, status: 'selected' as const }
          : candidate.status === 'ready' ? { ...candidate, status: 'discarded' as const } : candidate),
      })
      await this.finishSelectedRound(active, round, population, selection, championBaseline, championCandidateId)
      continueBatch = true
      return
    } catch (error) {
      const round = await store.readRound(roundId)
      const pendingRepair = active.abort.signal.aborted && active.repairAttempt !== undefined
        ? round?.evaluationAttempts?.find(attempt => this.sameAttempt(attempt, active.repairAttempt!))
        : undefined
      if (!(error instanceof ExternalMetaFailureError) && round !== undefined && round.evaluationRepairResume !== undefined
        && active.repairAttempt !== undefined
        && this.sameAttempt(round.evaluationRepairResume, active.repairAttempt)
        && pendingRepair?.status === 'repair-completed'
        && this.attemptHasEvidence(round, pendingRepair)) return
      if (!(error instanceof ExternalMetaFailureError) && round !== undefined
        && await this.hasDurableContextRecovery(active, round)) return
      if (round !== undefined && !TERMINAL.has(round.status)) {
        if (round.commitIntent !== undefined) {
          await this.reconcileCommitIntent(store, round).catch(async recoveryError => store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'commit-recovery', message: errorMessage(recoveryError) },
          }))
        } else {
          const completedAt = now()
          const failure = preferredFailure(round.status, error, round)
          const preserveSearchGeneration = round.searchMode && !(error instanceof ExternalMetaFailureError)
            && round.candidatePool.some(candidate => candidate.generationAttempts?.some(attempt => attempt.status === 'running'))
          await this.transition(store, roundId, {
            ...this.completeEvaluationRepairResume(active, round, {}),
            status: preserveSearchGeneration ? round.status : 'failed',
            ...(preserveSearchGeneration ? {} : { candidatePool: settleInterruptedCandidateGeneration(round, completedAt, failure) }),
            failure,
            ...(error instanceof BaselineReuseBlockedError ? { baselineReuseBlocker: error.blocker } : {}),
          })
        }
      }
    } finally {
      for (const execution of active.executions.values()) await this.cleanupExecution(active, execution, 'round stopped').catch(() => {})
      if (continueBatch && active.roundIndex < active.roundCount && !this.disposed) {
        try {
          await this.queueContinuation(active)
          this.active.delete(roundId)
          return
        } catch (error) {
          const round = await store.readRound(roundId)
          if (round !== undefined) await store.writeRound({
            ...round, updatedAt: now(), failure: { phase: 'batch-continuation', message: errorMessage(error) },
          }).catch(() => {})
        }
      }
      await active.lock.release().catch(() => {})
      this.active.delete(roundId)
    }
  }

  /** Stop the original owner even when restoring its session or workspace failed. */
  private async stopRecoveredMeta(evolution: EvolutionRuntime, execution: MetaExecutionState, reason: string): Promise<void> {
    await evolution.meta.cancel(execution.activeSessionId, reason)
    const store = new MetaOffloadingStore(evolution.store.root), current = await store.read(execution.executionId)
    if (current && (current.status === 'running' || current.status === 'rotating')) {
      await store.cas(current.revision, { ...current, revision: current.revision + 1, status: 'stopped', failure: reason })
    }
  }

  /** Resume a verified handoff, or cancel the original owner before settling its attempt. */
  private async recoverSearchGeneration(active: ActiveRound, roundId: string): Promise<void> {
    const { store, spec, meta } = active.evolution
    const round = await this.requireRound(store, roundId)
    const contextStore = new MetaOffloadingStore(store.root), contexts = await contextStore.list()
    const journal = new SearchStore(join(store.root, 'search'))
    const budgetStart = (await journal.read<{ startedAt: number }>('budget'))?.startedAt
    for (const candidate of round.candidatePool) {
      const attempts = candidate.generationAttempts?.filter(attempt => attempt.status === 'running') ?? []
      if (!attempts.length || active.executions.has(candidate.candidateId)) continue
      const owned = contexts.filter(context => context.roundId === roundId && context.candidateId === candidate.candidateId
        && attempts.some(attempt => attempt.attempt === context.attempt))
      const expired = Date.now() >= (candidate.workplanDelivery?.workplan.generationBudget.deadlineAt ?? Infinity)
        || Date.now() >= (round.candidateGenerationDeadlineAt ?? Infinity)
        || budgetStart !== undefined && Date.now() >= budgetStart + spec.searchSettings!.budgets.evolution.timeoutMs
      const resumable = owned.filter(context => !expired && context.deadlineAt > Date.now()
        && context.specDigest === active.evolution.specDigest && context.recovery !== undefined
        && (context.status === 'rotating' || context.status === 'running' && ['activated', 'delivered'].includes(context.intent?.phase ?? ''))
        && attempts.some(attempt => attempt.attempt === context.attempt && attempt.deadlineAt === context.deadlineAt)
        && (context.recovery.controller as { workspaceId?: string }).workspaceId === candidate.workspaceId)
      if (!candidate.sealedVersion && candidate.status === 'generating' && attempts.length === 1 && resumable.length === 1
        && spec.metaAgent.contextOffloading !== undefined && meta.restore) {
        invariant(!active.contextResume, 'multiple concurrent Meta recoveries are not supported')
        active.contextResume = resumable[0]!
        continue
      }
      // A persisted session ID is ownership information, not a liveness observation.
      // Cancellation must acknowledge quiescence; failures leave the round unresolved.
      const sessions = new Set([candidate.metaSessionId, ...attempts.map(a => a.metaSessionId), ...owned.map(c => c.activeSessionId)])
      const message = expired ? 'search budget exhausted: time' : 'search generation stopped after restart outside a recoverable Meta boundary'
      try { for (const session of sessions) if (session) await meta.cancel(session, message) }
      catch (error) {
        await journal.write(`rounds/${roundId}/pending-operation`, {
          operationKey: digestJson([roundId, candidate.workplanDelivery!.workplan.digest, 'generation']), kind: 'generation',
          candidateId: candidate.candidateId, state: 'unknown', reason: errorMessage(error),
        })
        throw error
      }
      for (const context of owned) if (context.status === 'running' || context.status === 'rotating') {
        await contextStore.cas(context.revision, { ...context, revision: context.revision + 1, status: 'stopped', failure: message })
      }
      const current = await this.requireRound(store, roundId), failure = { phase: 'candidate-generation', message }
      await this.transition(store, roundId, { candidatePool: this.patchCandidate(current, candidate.candidateId, {
        ...(candidate.sealedVersion ? {} : { status: 'failed', failure }),
        generationAttempts: candidate.generationAttempts!.map(attempt => attempt.status === 'running'
          ? { ...attempt, status: 'failed', completedAt: now(), failure } : attempt),
      }) })
    }
  }

  private async driveSearch(active: ActiveRound, roundId: string): Promise<void> {
    const { spec, store, evaluator } = active.evolution
    const adapter = evaluator.search
    if (!adapter || !spec.searchSettings) throw new Error('search provider capabilities unavailable')
    await this.recoverSearchGeneration(active, roundId)
    const round = await this.requireRound(store, roundId)
    if (!round.searchAnchor) throw new Error('search round has no pinned champion anchor')
    const journal = new SearchStore(join(store.root, 'search'))
    const generatedResult = async (candidate: RefinementRound['candidatePool'][number], reason?: string): Promise<GeneratedCandidate> => {
      const delivery = candidate.workplanDelivery!
      // Charge the full enforced reservation conservatively. This is an upper
      // bound, not a claim of measured model usage; adapters must enforce it.
      const budget = delivery.workplan.generationBudget
      const usage = { ...(budget.maxTokens === undefined ? {} : { tokens: budget.maxTokens }),
        ...(budget.maxModelRequests === undefined ? {} : { requests: budget.maxModelRequests }) }
      if (!candidate.sealedVersion) return seal({ changedPaths: [], usage, reason: reason ?? candidate.failure?.message ?? candidate.decline?.rationale ?? 'candidate-declined' })
      if (!candidate.proposalEvidence?.workplanReceipt || !candidate.metaSessionId) throw new Error('candidate has no workplan consumption receipt')
      const snapshot = await this.builder.searchSnapshot(candidate.candidateId, candidate.sealedVersion.commitOid, candidate.parentCandidateIds)
      return seal({ snapshot, changedPaths: candidate.diff?.files.map(f => f.path) ?? [], receipt: candidate.proposalEvidence.workplanReceipt, sessionId: candidate.metaSessionId, usage })
    }
    const engine = new FailureClusterSearch(journal, adapter.provider, adapter.diagnosis, {
      verifySnapshot: async snapshot => {
        const actual = await this.builder.searchSnapshot(snapshot.candidateId, snapshot.commit, snapshot.parentIds)
        invariant(actual.tree === snapshot.tree && actual.manifestDigest === snapshot.manifestDigest, 'search snapshot does not match exact Git commit')
      },
      generate: async ({ delivery, parent, baseline, baselineContext, signal }) => {
        let current = await this.requireRound(store, roundId)
        const id = delivery.workplan.candidateId
        const evidence = legacySearchEvidence(baseline, parent, current.plan.seed.conditionId, current.seedTaskRef, baselineContext)
        const previous = current.candidatePool.find(c => c.candidateId === id)
        if (!previous) current = await this.transition(store, roundId, {
          candidatePool: [...current.candidatePool, { candidateId: id, roundId, parentCandidateIds: [parent.candidateId], parentHarnessRef: parent.commit, status: 'generating', workplanDelivery: delivery }],
          parentAllocations: [...(current.parentAllocations ?? []), { candidateId: id, parentCandidateId: parent.candidateId, parentHarnessRef: parent.commit, parentHarnessDigest: parent.manifestDigest }],
          parentBaselines: [...(current.parentBaselines ?? []).filter(b => b.parentCandidateId !== parent.candidateId), { parentCandidateId: parent.candidateId, parentHarnessRef: parent.commit, evidence }],
        })
        const parentRecord = (await store.listRounds()).flatMap(r => r.candidatePool).find(c => c.sealedVersion?.commitOid === parent.commit)
        const member: PopulationMember = { candidateId: parent.candidateId, harnessRef: parent.commit, harnessDigest: parent.manifestDigest, parentCandidateIds: parent.parentIds,
          lineageRootId: parent.parentIds[0] ?? parent.candidateId, metrics: { quality: 0, taskSuccessRate: 0 }, selectedAt: now(),
          ...(parentRecord?.resultCheckpoint && parentRecord.metaSessionId ? { metaCheckpoint: parentRecord.resultCheckpoint, metaSessionId: parentRecord.metaSessionId } : {}) }
        // Restart never silently generates another proposal for a consumed attempt.
        if (previous?.generationAttempts?.some(a => a.status === 'running') && !previous.sealedVersion
          && active.contextResume?.candidateId !== id) {
          throw new Error('search generation interrupted: restore the original Meta attempt before resuming')
        }
        if (previous?.sealedVersion || previous?.status === 'failed' || previous?.decline) return generatedResult(previous)
        current = await this.generateCandidates(active, current, [member], id, signal)
        delete active.contextResume
        const candidate = current.candidatePool.find(c => c.candidateId === id)!
        return generatedResult(candidate)
      },
      inspectGeneration: async (key, signal) => {
        signal.throwIfAborted()
        const current = await this.requireRound(store, roundId)
        const candidate = current.candidatePool.find(c => c.workplanDelivery && digestJson([roundId, c.workplanDelivery.workplan.digest, 'generation']) === key)
        if (!candidate) return { status: 'not-started' }
        if (candidate.sealedVersion || candidate.status === 'failed' || candidate.decline) return { status: 'complete', result: await generatedResult(candidate) }
        if (!candidate.generationAttempts?.length) return { status: 'not-started' }
        const budgetStart = (await journal.read<{ startedAt: number }>('budget'))?.startedAt
        const expired = Date.now() >= candidate.workplanDelivery!.workplan.generationBudget.deadlineAt
          || budgetStart !== undefined && Date.now() >= budgetStart + spec.searchSettings!.budgets.evolution.timeoutMs
        if (expired && candidate.generationAttempts.every(a => a.status !== 'running')) return { status: 'complete', result: await generatedResult(candidate, 'search budget exhausted: time') }
        const execution = active.executions.get(candidate.candidateId)
        if (execution?.metaSessionId && !execution.signal.aborted) return { status: 'running', handle: execution.metaSessionId }
        return { status: 'unknown', reason: 'original Meta attempt needs recovery' }
      },
      commitChampion: async (expected, next, sourceRoundId) => {
        const champion = await this.requireChampion(store)
        if (champion.ref === next.commit && champion.manifestDigest === next.manifestDigest && champion.roundId === sourceRoundId) return
        if (digestJson(champion) !== expected) throw new Error('champion revision CAS conflict; external champion was preserved')
        await store.compareAndSwapChampion(champion.ref, { schemaVersion: 2, ref: next.commit, manifestDigest: next.manifestDigest, updatedAt: now(), roundId: sourceRoundId })
      },
      progress: async phase => {
        const statuses: Record<string, RefinementRound['status']> = { bootstrap: 'baseline-running', 'scope-preparation': 'baseline-running', 'diagnosis-planning': 'baseline-running', local: 'candidate-seed-running', bridge: 'candidate-seed-running', 'global-seed': 'candidate-seed-running', 'held-out': 'held-out-running' }
        if (statuses[phase]) await this.transition(store, roundId, { status: statuses[phase] })
      },
    }, this.components)
    const outcome = await engine.run({ evolutionId: spec.evolutionId, roundId, roundIndex: round.roundIndex - 1,
      maxCandidates: spec.candidateGeneration.maxCandidates, anchor: round.searchAnchor.snapshot, championRevisionDigest: round.searchAnchor.championRevisionDigest, settings: spec.searchSettings }, active.abort.signal)
    await this.transition(store, roundId, { searchOutcome: outcome, status: outcome.championChanged ? 'accepted' : 'rejected', decision: outcome.championChanged ? 'accepted' : 'rejected', ...(outcome.championChanged && outcome.nomineeId ? { promotedCandidateId: outcome.nomineeId } : {}) })
  }

  private async generateCandidates(active: ActiveRound, round: RefinementRound, generationParents: PopulationMember[], onlyCandidateId?: string, generationSignal: AbortSignal = active.abort.signal): Promise<RefinementRound> {
    const { store, meta } = active.evolution
    const roundId = round.roundId
    const parentBaselines = round.parentBaselines ?? []
      const rootCheckpoint = await meta.checkpoint()
      generationSignal.throwIfAborted()
      const parentCheckpoints = new Map<string, MetaCheckpointRef>()
      for (const member of generationParents) parentCheckpoints.set(member.candidateId, member.metaCheckpoint ?? rootCheckpoint)
      const generationBudget = effectiveCandidateGenerationBudget(active.evolution.spec.candidateGeneration)
      const generationDeadline = round.candidateGenerationDeadlineAt ?? Date.now() + generationBudget.roundTimeoutMs
      if (round.candidateGenerationDeadlineAt === undefined) {
        round = await this.transition(store, roundId, { candidateGenerationDeadlineAt: generationDeadline })
      }

      // Generate and seal every sibling before any candidate rollout. This keeps
      // proposal-time evidence independent of sibling evaluation order.
      for (const initialCandidate of round.candidatePool.filter(c => onlyCandidateId === undefined || c.candidateId === onlyCandidateId)) {
        generationSignal.throwIfAborted()
        if (initialCandidate.sealedVersion !== undefined || initialCandidate.status !== 'generating') continue
        const candidateId = initialCandidate.candidateId
        const workBudget = initialCandidate.workplanDelivery?.workplan.generationBudget
        const allowedGenerationAttempts = workBudget
          ? Math.min(generationBudget.maxAttemptsPerCandidate, workBudget.maxModelRequests ?? Infinity, workBudget.maxTokens ?? Infinity)
          : generationBudget.maxAttemptsPerCandidate
        const allocation = round.parentAllocations?.find(value => value.candidateId === candidateId)
        if (allocation === undefined) throw new Error(`candidate has no parent allocation: ${candidateId}`)
        const parentBaseline = parentBaselines.find(value => value.parentCandidateId === allocation.parentCandidateId)?.evidence
        const currentParentCheckpoint = parentCheckpoints.get(allocation.parentCandidateId)
        if (parentBaseline === undefined || currentParentCheckpoint === undefined) throw new Error('candidate parent state is incomplete')
        let generationComplete = false
        const resuming = active.contextResume?.candidateId === candidateId ? active.contextResume : undefined
        for (let attemptNumber = resuming?.attempt ?? (round.searchMode ? (initialCandidate.generationAttempts?.length ?? 0) + 1 : 1); attemptNumber <= allowedGenerationAttempts; attemptNumber += 1) {
          const recovered = attemptNumber === resuming?.attempt ? resuming : undefined
          generationSignal.throwIfAborted()
          const startedAt = now()
          const previousCandidate = round.candidatePool.find(value => value.candidateId === candidateId)!
          const generationAttempts: CandidateGenerationAttempt[] = [
            ...(previousCandidate.generationAttempts ?? []),
            ...(recovered === undefined ? [{ attempt: attemptNumber, status: 'running' as const, startedAt }] : []),
          ]
          round = await this.transition(store, roundId, {
            status: 'preparing-candidate',
            candidatePool: this.patchCandidate(round, candidateId, {
              status: 'generating', failure: undefined,
              ...(recovered === undefined ? { workspaceId: undefined, metaSessionId: undefined } : {}),
              generationAttempts,
            }),
          })
          const remainingBeforeAttempt = generationDeadline - Date.now()
          if (remainingBeforeAttempt <= 0) {
            const timeout = new CandidateGenerationTimeoutError('round', generationBudget.roundTimeoutMs)
            if (recovered) await this.stopRecoveredMeta(active.evolution, recovered, timeout.message)
            const failure = { phase: 'candidate-generation', message: timeout.message }
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidateId, {
                status: 'failed', failure,
                generationAttempts: patchGenerationAttempt(generationAttempts, attemptNumber, {
                  status: 'failed', completedAt: now(), failure,
                }),
              }),
            })
            break
          }

          const executionAbort = new AbortController()
          const execution: CandidateExecution = {
            candidateId,
            abort: executionAbort,
            signal: AbortSignal.any([generationSignal, executionAbort.signal]),
            finalization: finalizationResolvers(),
            finalizationPersisted: completionResolvers(),
            finalizationSubmitted: false, baseline: parentBaseline,
          }
          active.executions.set(candidateId, execution)
          active.currentCandidateId = candidateId
          const timerStartedAt = Date.now()
          const attemptLimitAt = Math.min(recovered?.deadlineAt ?? timerStartedAt + generationBudget.attemptTimeoutMs,
            initialCandidate.workplanDelivery?.workplan.generationBudget.deadlineAt ?? Infinity)
          const timeoutScope = generationDeadline <= attemptLimitAt ? 'round' : 'attempt'
          const timeoutBudgetMs = timeoutScope === 'round'
            ? generationBudget.roundTimeoutMs
            : generationBudget.attemptTimeoutMs
          const attemptDeadlineAt = Math.min(attemptLimitAt, generationDeadline)
          const timeoutMs = Math.max(0, attemptDeadlineAt - timerStartedAt)
          execution.generationBudget = generationBudgetSnapshot({
            ...generationBudget, attempt: attemptNumber, deadlineAt: attemptDeadlineAt,
            roundDeadlineAt: generationDeadline, remainingMs: 0, roundRemainingMs: 0, diagnosisAvailableMs: 0,
            finalizationReserveMs: active.evolution.spec.candidateGeneration.budget.finalizationReserveMs
              ?? Math.min(300_000, Math.floor(generationBudget.attemptTimeoutMs / 5)),
          })
          const deadlineError = new CandidateGenerationTimeoutError(timeoutScope, timeoutBudgetMs)
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined
          let rejectAttempt: (reason: unknown) => void = () => {}
          const deadline = new Promise<never>((_resolve, reject) => {
            rejectAttempt = reject
            deadlineTimer = setTimeout(() => {
              reject(deadlineError)
              executionAbort.abort(deadlineError)
            }, timeoutMs)
          })
          const stopForRoundAbort = () => rejectAttempt(generationSignal.reason ?? new Error('refinement round aborted'))
          if (generationSignal.aborted) stopForRoundAbort()
          else generationSignal.addEventListener('abort', stopForRoundAbort, { once: true })
          void deadline.catch(() => {})
          let completedCheckpoint = false
          let shouldRetry = false
          try {
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidateId, {
                generationAttempts: patchGenerationAttempt(generationAttempts, attemptNumber, { deadlineAt: attemptDeadlineAt }),
              }),
            })
            execution.signal.throwIfAborted()
            // The default root can be empty and unmaterialized. Recreating it
            // after restart must not change an already-running attempt's parent.
            const sealedController = recovered?.recovery?.controller as { parentCheckpoint?: MetaCheckpointRef } | undefined
            const parentCheckpoint = recovered === undefined ? currentParentCheckpoint : sealedController?.parentCheckpoint
            if (parentCheckpoint === undefined || parentCheckpoint === null || typeof parentCheckpoint.sourceSessionId !== 'string'
              || !parentCheckpoint.sourceSessionId || !Number.isSafeInteger(parentCheckpoint.eventCount)
              || parentCheckpoint.eventCount < 0 || !/^sha256:[a-f0-9]{64}$/u.test(parentCheckpoint.prefixDigest)
              || recovered !== undefined && previousCandidate.parentCheckpoint !== undefined
                && digestJson(parentCheckpoint) !== digestJson(previousCandidate.parentCheckpoint)) {
              throw new MetaContextError('context-unrecoverable', 'sealed candidate parent checkpoint is missing or inconsistent')
            }
            const workspaceInput = {
              evolutionId: round.evolutionId,
              roundId,
              parentHarnessRef: allocation.parentHarnessRef,
              parentHarnessDigest: allocation.parentHarnessDigest,
            }
            const workspacePromise = recovered === undefined
              ? this.workspaceManager.create(workspaceInput, execution.signal)
              : this.workspaceManager.restore(previousCandidate.workspaceId!, workspaceInput)
            let workspace: CandidateWorkspaceHandle
            try {
              workspace = await Promise.race([workspacePromise, deadline])
            } catch (error) {
              void workspacePromise.then(lateWorkspace => this.workspaceManager.dispose(lateWorkspace.workspaceId)).catch(() => {})
              throw error
            }
            execution.workspace = workspace
            execution.signal.throwIfAborted()
            const forkPromise = recovered === undefined ? meta.fork(parentCheckpoint)
              : meta.restore === undefined ? Promise.reject(new Error('Meta adapter cannot restore context execution'))
                : meta.restore(recovered.activeSessionId, recovered.executionId)
            let agent: Awaited<ReturnType<MetaSessionController['fork']>>
            try {
              agent = await Promise.race([forkPromise, deadline])
            } catch (error) {
              void forkPromise.then(async lateAgent => {
                const lateSessionId = String(lateAgent.id)
                await meta.cancel(lateSessionId, 'candidate generation attempt expired before fork completed').catch(() => {})
                await meta.release(lateSessionId).catch(() => {})
              }).catch(() => {})
              throw error
            }
            execution.metaSessionId = String(agent.id)
            execution.signal.throwIfAborted()
            this.workspaceManager.bind(workspace.workspaceId, execution.metaSessionId)
            const currentAttempts = round.candidatePool.find(value => value.candidateId === candidateId)!.generationAttempts!
            round = await this.transition(store, roundId, {
              status: 'candidate-editing',
              candidatePool: this.patchCandidate(round, candidateId, {
                workspaceId: workspace.workspaceId,
                metaSessionId: execution.metaSessionId,
                parentCheckpoint,
                generationAttempts: patchGenerationAttempt(currentAttempts, attemptNumber, {
                  workspaceId: workspace.workspaceId, metaSessionId: execution.metaSessionId,
                  preparationCompletedAt: recovered === undefined ? now()
                    : currentAttempts.find(value => value.attempt === attemptNumber)?.preparationCompletedAt ?? now(),
                }),
              }),
            })
            execution.signal.throwIfAborted()
            const currentCandidate = round.candidatePool.find(value => value.candidateId === candidateId)!
            const wake = await Promise.race([meta.wakeCandidate(round, currentCandidate, parentBaseline, agent, {
              executionId: recovered?.executionId ?? crypto.randomUUID(), attempt: attemptNumber, deadlineAt: attemptDeadlineAt,
              generationBudget: execution.generationBudget,
              signal: execution.signal, budget: {
                ...active.evolution.spec.candidateGeneration.budget,
                ...(workBudget?.maxTokens === undefined ? {} : { maxTokens: Math.min(active.evolution.spec.candidateGeneration.budget.maxTokens ?? Infinity, Math.floor(workBudget.maxTokens / allowedGenerationAttempts)) }),
                ...(workBudget?.maxModelRequests === undefined ? {} : { maxModelRequests: Math.min(active.evolution.spec.candidateGeneration.budget.maxModelRequests ?? Infinity, Math.floor(workBudget.maxModelRequests / allowedGenerationAttempts)) }),
              },
              isComplete: () => execution.finalizationSubmitted,
              snapshot: async () => {
                execution.signal.throwIfAborted()
                await this.workspaceManager.drain(workspace.workspaceId)
                const diff = await this.workspaceManager.preflight(workspace.workspaceId, execution.signal)
                return {
                  evolutionId: round.evolutionId, roundId, candidateId, attempt: attemptNumber,
                  workspaceId: workspace.workspaceId, parentHarnessRef: allocation.parentHarnessRef,
                  parentCheckpoint, baselineEvalId: parentBaseline.evalId, diff,
                  specDigest: active.evolution.specDigest,
                }
              },
              activate: async (sourceId, successorId) => {
                execution.signal.throwIfAborted()
                if (execution.finalizationSubmitted || execution.metaSessionId !== sourceId) throw new Error('stale candidate session activation')
                this.workspaceManager.rotateBinding(workspace.workspaceId, sourceId, successorId)
                execution.metaSessionId = successorId
                round = await this.transition(store, roundId, {
                  candidatePool: this.patchCandidate(round, candidateId, {
                    metaSessionId: successorId,
                    generationAttempts: patchGenerationAttempt(round.candidatePool.find(value => value.candidateId === candidateId)!.generationAttempts!, attemptNumber, {
                      metaSessionId: successorId,
                    }),
                  }),
                })
              },
            }), deadline])
            execution.signal.throwIfAborted()
            const turnSettlement = wake.completion?.then(observation => {
              if (!execution.finalizationSubmitted) throw new MetaTurnEndedWithoutProposalError(observation)
              return execution.finalization.promise
            })
            const proposal = await Promise.race([
              execution.finalization.promise,
              deadline,
              ...(turnSettlement === undefined ? [] : [turnSettlement]),
            ])
            const resultCheckpoint = await Promise.race([meta.checkpoint(execution.metaSessionId), deadline])
            const metaTurn = wake.completion === undefined
              ? undefined
              : await Promise.race([wake.completion, deadline])
            execution.signal.throwIfAborted()
            completedCheckpoint = true
            const completedAttempts = round.candidatePool.find(value => value.candidateId === candidateId)!.generationAttempts!
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidateId, {
                metaSessionId: execution.metaSessionId,
                ...(proposal.finalization === null ? {} : { proposal: proposal.finalization }),
                ...(proposal.decline === undefined ? {} : { decline: proposal.decline }),
                ...(proposal.diff === undefined ? {} : { diff: proposal.diff }),
                meta: proposal.meta, proposalEvidence: proposal.evidence, resultCheckpoint,
                generationAttempts: patchGenerationAttempt(completedAttempts, attemptNumber, {
                  metaSessionId: execution.metaSessionId,
                  status: 'succeeded', completedAt: now(),
                  proposalCompletedAt: now(),
                  ...(metaTurn === undefined ? {} : { metaTurn }),
                }),
                ...(proposal.finalization === null ? { status: 'discarded' as const } : {}),
              }),
            })
            execution.finalizationPersisted.resolve()
            execution.signal.throwIfAborted()
            if (proposal.finalization !== null && proposal.diff !== undefined) {
              round = await this.transition(store, roundId, { status: 'building-candidate' })
              this.workspaceManager.markFinalizing(workspace.workspaceId)
              const verifiedDiff = await this.workspaceManager.verifySealed(workspace.workspaceId, proposal.diff, execution.signal)
              const sealed = await this.builder.finalizeWorkspace(workspace, verifiedDiff, execution.signal)
              execution.signal.throwIfAborted()
              await this.workspaceManager.markCommitted(workspace.workspaceId)
              round = await this.transition(store, roundId, {
                candidatePool: this.patchCandidate(round, candidateId, {
                  status: 'ready',
                  sealedVersion: {
                    commitOid: sealed.ref, treeOid: sealed.treeOid, manifestDigest: sealed.digest,
                    patchDigest: proposal.diff.patchDigest, immutableRef: sealed.immutableRef,
                  },
                  ...(sealed.validation === undefined ? {} : { validation: sealed.validation }),
                }),
              })
            }
            generationComplete = true
          } catch (error) {
            execution.finalizationPersisted.reject(error)
            if (!(error instanceof ExternalMetaFailureError)
              && active.evolution.spec.metaAgent.contextOffloading !== undefined && !completedCheckpoint) execution.preserveWorkspace = true
            active.abort.signal.throwIfAborted()
            // Restoration can fail before this controller adopts the session.
            // Do not declare its durable attempt failed until the old owner stops.
            if (recovered && execution.metaSessionId === undefined) await this.stopRecoveredMeta(active.evolution, recovered, errorMessage(error))
            await Promise.allSettled([...(execution.evidenceWrites ?? [])])
            const persistedRound = await store.readRound(roundId)
            const persistedAttempt = persistedRound?.candidatePool.find(value => value.candidateId === candidateId)
              ?.generationAttempts?.find(value => value.attempt === attemptNumber)
            if (persistedAttempt?.prerequisiteBlocker !== undefined) round = persistedRound!
            // Close the attempt before persisting retry state so a late tool call
            // from the timed-out child cannot seal or submit the disposed workspace.
            execution.finalizationSubmitted = true
            execution.abort.abort(error instanceof Error ? error : new Error(errorMessage(error)))
            const phase = error instanceof SubstrateExpansionError
              ? 'rejected-for-substrate'
              : round.status === 'building-candidate' ? 'building-candidate' : 'candidate-generation'
            const failure = preferredFailure(phase, error, round)
            shouldRetry = failure.prerequisite === undefined && (error instanceof CandidateGenerationTimeoutError
              || error instanceof MetaTurnEndedWithoutProposalError
              || error instanceof MetaContextError && error.code === 'context-handoff-failed')
              && !completedCheckpoint && !generationSignal.aborted
              && attemptNumber < allowedGenerationAttempts
              && Date.now() < generationDeadline
              && Date.now() < (workBudget?.deadlineAt ?? Infinity)
            const failedAttempts = round.candidatePool.find(value => value.candidateId === candidateId)!.generationAttempts!
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidateId, {
                status: shouldRetry ? 'generating' : 'failed',
                failure: shouldRetry ? undefined : failure,
                ...(shouldRetry ? { workspaceId: undefined, metaSessionId: undefined } : {}),
                generationAttempts: patchGenerationAttempt(failedAttempts, attemptNumber, {
                  status: 'failed', completedAt: now(), failure,
                  ...(error instanceof MetaTurnEndedWithoutProposalError ? { metaTurn: error.observation } : {}),
                }),
              }),
            })
          } finally {
            generationSignal.removeEventListener('abort', stopForRoundAbort)
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
            await this.cleanupExecution(active, execution, completedCheckpoint ? undefined : 'candidate generation stopped')
          }
          if (generationComplete || !shouldRetry) break
        }
      }
      active.abort.signal.throwIfAborted()
      delete active.currentCandidateId

    return round
  }

  private async finishSelectedRound(
    active: ActiveRound,
    initialRound: RefinementRound,
    population: PopulationState,
    selection: NonNullable<RefinementRound['selection']>,
    championBaseline: EvaluationEvidence,
    championCandidateId: string,
  ): Promise<void> {
    const { store } = active.evolution
    const roundId = initialRound.roundId
    let round = initialRound
    active.abort.signal.throwIfAborted()
    const finalist = round.candidatePool.find(value => value.candidateId === selection.promotionCandidateId)
    if (finalist?.sealedVersion === undefined || finalist.seedEvaluation === undefined) throw new Error('promotion finalist is not evaluable')
    this.assertParity(championBaseline, finalist.seedEvaluation, 'seed')
    const seedPairs = pairedTrials(championBaseline, finalist.seedEvaluation)
    const seedBaselineAggregate = pairedAggregate(seedPairs, 'baseline')
    const seedCandidateAggregate = pairedAggregate(seedPairs, 'candidate')
    // A repaired seed candidate can change the finalist. Keep raw baseline
    // evidence, but rebuild pairing/metrics for the newly selected candidate.
    const priorHeldOutBaseline = round.evaluation?.heldOutBaseline
    const priorHeldOutCandidate = round.evaluation?.heldOutCandidate?.actualCommit === finalist.sealedVersion.commitOid
      ? round.evaluation.heldOutCandidate : finalist.heldOutEvaluation
    let evaluation: RoundEvaluation = {
      ...(priorHeldOutBaseline === undefined ? {} : { heldOutBaseline: priorHeldOutBaseline }),
      seedBaseline: championBaseline,
      seedCandidate: finalist.seedEvaluation,
      seedPairedTrials: seedPairs,
      seedPairing: pairingAudit(championBaseline, finalist.seedEvaluation, seedPairs),
      scoreDelta: seedCandidateAggregate.score - seedBaselineAggregate.score,
      ...(pairedProcessDelta(seedPairs) === undefined ? {} : { processScoreDelta: pairedProcessDelta(seedPairs)! }),
      requiredRegressions: seedPairs.length === 0 ? 0 : this.requiredRegressions(round, seedPairs),
    }
    round = await this.transition(store, roundId, { evaluation })
    active.abort.signal.throwIfAborted()
    let accepted = false
    if (this.passesSeed(round, evaluation) && active.evolution.spec.evaluation.mode === 'reuse-seed') {
      // Reuse the observed seed evidence, including invalid cells. Never claim an
      // independent evaluation or create a second evaluation attempt for it.
      const { conditionId: _seedId, partition: _seedPartition, ...seedCondition } = round.plan.seed
      const { conditionId: _heldOutId, partition: _heldOutPartition, ...heldOutCondition } = round.plan.heldOut
      if (digestJson(seedCondition) !== digestJson(heldOutCondition)) {
        throw new Error('reuse-seed requires identical evaluation conditions')
      }
      evaluation = {
        ...evaluation,
        heldOutReusedFromSeed: true,
        heldOutBaseline: championBaseline,
        heldOutCandidate: finalist.seedEvaluation,
        heldOutPairedTrials: seedPairs,
        heldOutPairing: evaluation.seedPairing,
        heldOutScoreDelta: evaluation.scoreDelta,
        ...(evaluation.processScoreDelta === undefined ? {} : { heldOutProcessScoreDelta: evaluation.processScoreDelta }),
        promotionMetrics: await this.evaluateJudges(active.evolution.spec,
          projectPairedEvidence(finalist.seedEvaluation, seedPairs, 'candidate')),
      }
      round = await this.transition(store, roundId, {
        evaluation,
        candidatePool: this.patchCandidate(round, finalist.candidateId, { heldOutEvaluation: finalist.seedEvaluation }),
      })
      accepted = this.passesHeldOut(round, evaluation, active.evolution.spec)
    } else if (this.passesSeed(round, evaluation)) {
      round = await this.transition(store, roundId, { status: 'held-out-running' })
      active.abort.signal.throwIfAborted()
      let heldOutBaseline = evaluation.heldOutBaseline
      if (heldOutBaseline === undefined) {
        const staged = round.baselineSource?.partitions.heldOut
        const reusable = staged === undefined ? await this.findReusableBaseline(
          store, active.evolution.evaluator, round, round.targetHarnessRef, 'held-out', active.abort.signal,
        ) : {
          evidence: structuredClone(staged.evidence),
          sourceEvolutionId: round.baselineSource!.source.evolutionId,
          sourceRoundId: round.baselineSource!.source.roundId,
          ...(staged.currentInvocationFingerprint === undefined
            ? {}
            : { currentInvocationFingerprint: staged.currentInvocationFingerprint }),
        }
        if (reusable !== undefined) {
          active.abort.signal.throwIfAborted()
          round = await this.persistReusableHeldOutBaseline(
            store, round, championCandidateId, round.targetHarnessRef, reusable,
          )
          heldOutBaseline = reusable.evidence
        } else {
          if (active.resumeHeldOut === true) {
            throw new Error(`round ${roundId} recovery will not start a fresh held-out baseline`)
          }
          const baselineEvaluation = await this.evaluateWithAttempt(active, round, {
            phase: 'held-out-baseline', dataset: round.heldOutRef, harnessRef: round.targetHarnessRef,
            condition: round.plan.heldOut,
          }, {
            candidateId: championCandidateId, role: 'baseline', harnessRef: round.targetHarnessRef,
          }, (current, evidence) => ({ evaluation: { ...current.evaluation!, heldOutBaseline: evidence } }))
          round = baselineEvaluation.round
          heldOutBaseline = baselineEvaluation.evidence
        }
      }
      // Candidate evidence remains durable in candidatePool while its paired
      // projection is rebuilt below in one validated state transition.
      let heldOutCandidate = priorHeldOutCandidate
      if (heldOutCandidate === undefined) {
        const candidateEvaluation = await this.evaluateWithAttempt(active, round, {
          phase: 'held-out-candidate', dataset: round.heldOutRef, harnessRef: finalist.sealedVersion.commitOid,
          condition: round.plan.heldOut,
        }, {
          candidateId: finalist.candidateId, role: 'candidate', harnessRef: finalist.sealedVersion.commitOid,
        }, async (current, evidence) => {
          this.assertParity(heldOutBaseline, evidence, 'held-out')
          const heldOutPairs = pairedTrials(heldOutBaseline, evidence)
          const heldOutBaselineAggregate = pairedAggregate(heldOutPairs, 'baseline')
          const heldOutCandidateAggregate = pairedAggregate(heldOutPairs, 'candidate')
          const completeEvaluation = {
            ...evaluation, heldOutBaseline, heldOutCandidate: evidence,
            heldOutPairedTrials: heldOutPairs,
            heldOutPairing: pairingAudit(heldOutBaseline, evidence, heldOutPairs),
            promotionMetrics: heldOutPairs.length === 0
              ? { quality: 0, taskSuccessRate: 0 }
              : await this.evaluateJudges(
                  active.evolution.spec,
                  projectPairedEvidence(evidence, heldOutPairs, 'candidate'),
                ),
            heldOutScoreDelta: heldOutCandidateAggregate.score - heldOutBaselineAggregate.score,
            ...(pairedProcessDelta(heldOutPairs) === undefined ? {} : { heldOutProcessScoreDelta: pairedProcessDelta(heldOutPairs)! }),
            requiredRegressions: evaluation.requiredRegressions
              + (heldOutPairs.length === 0 ? 0 : this.requiredRegressions(current, heldOutPairs)),
          }
          return {
            evaluation: completeEvaluation,
            candidatePool: this.patchCandidate(current, finalist.candidateId, { heldOutEvaluation: evidence }),
          }
        })
        round = candidateEvaluation.round
        heldOutCandidate = candidateEvaluation.evidence
        evaluation = round.evaluation!
      } else {
        this.assertParity(heldOutBaseline, heldOutCandidate, 'held-out')
        const heldOutPairs = pairedTrials(heldOutBaseline, heldOutCandidate)
        const heldOutBaselineAggregate = pairedAggregate(heldOutPairs, 'baseline')
        const heldOutCandidateAggregate = pairedAggregate(heldOutPairs, 'candidate')
        const promotionMetrics = heldOutPairs.length === 0
          ? { quality: 0, taskSuccessRate: 0 }
          : await this.evaluateJudges(
              active.evolution.spec,
              projectPairedEvidence(heldOutCandidate, heldOutPairs, 'candidate'),
            )
        active.abort.signal.throwIfAborted()
        evaluation = {
          ...evaluation, heldOutBaseline, heldOutCandidate,
          heldOutPairedTrials: heldOutPairs,
          heldOutPairing: pairingAudit(heldOutBaseline, heldOutCandidate, heldOutPairs),
          promotionMetrics,
          heldOutScoreDelta: heldOutCandidateAggregate.score - heldOutBaselineAggregate.score,
          ...(pairedProcessDelta(heldOutPairs) === undefined ? {} : { heldOutProcessScoreDelta: pairedProcessDelta(heldOutPairs)! }),
          requiredRegressions: evaluation.requiredRegressions
            + (heldOutPairs.length === 0 ? 0 : this.requiredRegressions(round, heldOutPairs)),
        }
        round = await this.transition(store, roundId, {
          evaluation,
          candidatePool: this.patchCandidate(round, finalist.candidateId, { heldOutEvaluation: heldOutCandidate }),
        })
      }
      accepted = this.passesHeldOut(round, evaluation, active.evolution.spec)
    }

    active.abort.signal.throwIfAborted()
    const nextPopulation = this.nextPopulation(round, population, selection.selectedCandidateIds)
    const nextChampion = accepted ? {
      schemaVersion: 2 as const,
      ref: finalist.sealedVersion.commitOid,
      manifestDigest: finalist.sealedVersion.manifestDigest,
      updatedAt: now(), roundId,
    } : undefined
    round = await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
      status: 'promoting',
      commitIntent: {
        expectedPopulationDigest: population.digest, nextPopulation,
        expectedChampionRef: round.targetHarnessRef,
        ...(nextChampion === undefined ? {} : { nextChampion }),
        decision: accepted ? 'accepted' : 'rejected',
        promotionCandidateId: finalist.candidateId,
        phase: 'prepared',
      },
    }))
    active.abort.signal.throwIfAborted()
    await store.compareAndSwapPopulation(population.digest, nextPopulation)
    active.abort.signal.throwIfAborted()
    round = await this.transition(store, roundId, {
      commitIntent: { ...round.commitIntent!, phase: 'population-committed' },
    })
    active.abort.signal.throwIfAborted()
    if (nextChampion !== undefined) await store.compareAndSwapChampion(round.targetHarnessRef, nextChampion)
    active.abort.signal.throwIfAborted()
    round = await this.transition(store, roundId, {
      commitIntent: { ...round.commitIntent!, phase: 'champion-committed' },
    })
    await this.transition(store, roundId, accepted
      ? { status: 'accepted', decision: 'accepted', promotedCandidateId: finalist.candidateId }
      : { status: 'rejected', decision: 'rejected' })
  }

  private async findReusableBaseline(
    store: RefineStateStore,
    evaluator: RefineEvaluator,
    round: RefinementRound,
    harnessRef: string,
    partition: 'seed' | 'held-out',
    signal: AbortSignal,
    parentCandidateId?: string,
  ): Promise<ReusableBaseline | undefined> {
    signal.throwIfAborted()
    const condition = partition === 'seed' ? round.plan.seed : round.plan.heldOut
    const dataset = partition === 'seed' ? round.seedTaskRef : round.heldOutRef
    const championHead = await store.readChampion()
    const preferredRoundId = championHead?.ref === harnessRef
      ? championHead.roundId?.replace(/^rollback:/u, '')
      : undefined
    const historyRounds = (await store.listRounds())
      // Prefer the promotion's original evidence, then stable history order.
      // A later cancelled duplicate must not displace the champion's results.
      .sort((left, right) => Number(right.roundId === preferredRoundId)
        - Number(left.roundId === preferredRoundId)
        || left.createdAt.localeCompare(right.createdAt)
        || left.roundId.localeCompare(right.roundId))
    const sources: Array<{
      previous: RefinementRound
      evidence: EvaluationEvidence
      attempt?: RoundEvaluationAttempt
      sourceEvolutionId?: string
      sourceRoundId?: string
    }> = []
    let hasPriorAttempt = false
    for (const previous of historyRounds) {
      signal.throwIfAborted()
      hasPriorAttempt ||= previous.evaluationStarts?.some(start => (
        start.harnessRef === harnessRef && start.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.evaluationAttempts?.some(attempt => (
        attempt.owner.harnessRef === harnessRef && attempt.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.pendingEvaluationSubmissions?.some(pending => (
        pending.request.harnessRef === harnessRef && pending.request.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.failedEvaluations?.some(failed => (
        failed.owner.harnessRef === harnessRef && failed.phase.startsWith(`${partition}-`)
      )) ?? false
      // The resumed round may already own a failed baseline. It must prevent
      // fresh execution even though it cannot be its own historical reuse source.
      if (previous.roundId === round.roundId) continue
      const matchingParent = partition === 'seed' && parentCandidateId !== undefined
        ? previous.parentBaselines
          ?.filter(value => value.parentCandidateId === parentCandidateId && value.parentHarnessRef === harnessRef)
          .map(value => value.evidence) ?? []
        : []
      const matchingHarness = partition === 'seed'
        ? previous.parentBaselines
          ?.filter(value => value.parentCandidateId !== parentCandidateId && value.parentHarnessRef === harnessRef)
          .map(value => value.evidence) ?? []
        : []
      const champion = previous.targetHarnessRef === harnessRef
        ? partition === 'seed'
          ? previous.baseline === undefined ? [] : [previous.baseline]
          : previous.evaluation?.heldOutBaseline === undefined ? [] : [previous.evaluation.heldOutBaseline]
        : []
      const candidates = previous.candidatePool.flatMap(candidate => candidate.sealedVersion?.commitOid !== harnessRef
        ? []
        : partition === 'seed'
          ? candidate.seedEvaluation === undefined ? [] : [candidate.seedEvaluation]
          : candidate.heldOutEvaluation === undefined ? [] : [candidate.heldOutEvaluation])
      for (const evidence of [...matchingParent, ...matchingHarness, ...champion, ...candidates]) {
        const attempt = previous.evaluationAttempts?.find(value => (
          value.provider === evidence.provider && value.evalId === evidence.evalId
        ))
        sources.push({ previous, evidence, ...(attempt === undefined ? {} : { attempt }) })
      }
      const imported = partition === 'seed'
        ? previous.baselineSource?.partitions.seed
        : previous.baselineSource?.partitions.heldOut
      if (imported !== undefined && previous.baselineSource?.target.harnessRef === harnessRef) {
        sources.push({
          previous,
          evidence: imported.evidence,
          attempt: imported.sourceAttempt,
          sourceEvolutionId: previous.baselineSource.source.evolutionId,
          sourceRoundId: previous.baselineSource.source.roundId,
        })
      }
    }
    // Only genuinely missing history authorizes a fresh baseline. Identity
    // resolution failures, partial results and failed attempts are not misses.
    if (sources.length === 0 && !hasPriorAttempt) return undefined
    let evaluationIdentity: Awaited<ReturnType<NonNullable<RefineEvaluator['evaluationIdentity']>>>
    try {
      if (await digestDatasetRef(dataset, round.workspaceRoot) !== condition.dataset.digest) {
        throw new BaselineReuseBlockedError({
          code: 'BASELINE_CONDITION_MISMATCH',
          reason: `The frozen ${partition} dataset has changed; no baseline refresh was started.`,
          requiredAction: 'Restore the frozen dataset, or explicitly start a new evolution for changed conditions.',
        })
      }
      evaluationIdentity = await evaluator.evaluationIdentity?.(round, {
        phase: partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
        dataset, harnessRef, condition,
      }, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof BaselineReuseBlockedError) throw error
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_IDENTITY_UNRESOLVED',
        reason: `Cannot verify the existing ${partition} baseline identity; no baseline refresh was started.`,
        requiredAction: 'Restore evaluator identity resolution before continuing this evolution.',
      }, { cause: error })
    }
    signal.throwIfAborted()
    if (evaluationIdentity === undefined) {
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_IDENTITY_UNRESOLVED',
        reason: `Cannot verify the existing ${partition} baseline identity before execution; no baseline refresh was started.`,
        requiredAction: 'Use an evaluator that can resolve the frozen evaluation identity without starting Target trials.',
      })
    }
    let hasCompatibleEvidence = false
    for (const { previous, evidence, attempt, sourceEvolutionId, sourceRoundId } of sources) {
      if (evidence.provider !== evaluationIdentity.provider
        || evidence.conditionId !== condition.conditionId
        || evidence.dataset !== dataset
        || evidence.effectiveConfigDigest !== evaluationIdentity.effectiveConfigDigest
        || evidence.requestedCommit !== harnessRef
        || evidence.actualCommit !== harnessRef) continue
      hasCompatibleEvidence = true
      if (evidence.trials.length === 0
        || attempt?.status !== 'settled'
        || attempt.phase !== `${partition}-${attempt.owner.role}`
        || attempt.owner.harnessRef !== harnessRef
        || attempt.requestedModelId !== condition.model) continue
      return {
        evidence: structuredClone(evidence),
        sourceRoundId: sourceRoundId ?? previous.roundId,
        ...(sourceEvolutionId === undefined ? {} : { sourceEvolutionId }),
        ...(evaluationIdentity.invocationFingerprint === undefined
          ? {}
          : { currentInvocationFingerprint: evaluationIdentity.invocationFingerprint }),
      }
    }
    if (hasCompatibleEvidence || sources.length === 0) {
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_EVIDENCE_UNAVAILABLE',
        reason: `The existing ${partition} evaluation has no verifiable settled baseline with a valid trial; no baseline refresh was started.`,
        requiredAction: 'Recover settled evidence with at least one valid trial for the original evaluation. Unsettled or zero-valid evidence requires a provider-supported repair that preserves valid trials.',
      })
    }
    throw new BaselineReuseBlockedError({
      code: 'BASELINE_CONDITION_MISMATCH',
      reason: `The existing ${partition} baseline is incompatible with the frozen evaluation identity; no baseline refresh was started.`,
      requiredAction: 'Restore compatible evaluation conditions, or explicitly start a new evolution for changed conditions.',
    })
  }

  private async persistReusableSeedBaseline(
    store: RefineStateStore,
    round: RefinementRound,
    parentCandidateId: string,
    parentHarnessRef: string,
    reusable: ReusableBaseline,
    champion: boolean,
  ): Promise<RefinementRound> {
    const current = await this.requireRound(store, round.roundId)
    const evidence = structuredClone(reusable.evidence)
    const existingAttempt = current.evaluationAttempts?.find(value => (
      value.provider === evidence.provider && value.evalId === evidence.evalId
    ))
    if (existingAttempt !== undefined && existingAttempt.owner.harnessRef !== parentHarnessRef) {
      throw new Error(`reused evaluation identity has conflicting ownership: ${evidence.provider}/${evidence.evalId}`)
    }
    const timestamp = now()
    const evaluationAttempts = existingAttempt === undefined
      ? [...(current.evaluationAttempts ?? []), {
          provider: evidence.provider,
          evalId: evidence.evalId,
          phase: 'seed-baseline' as const,
          owner: { candidateId: parentCandidateId, role: 'baseline' as const, harnessRef: parentHarnessRef },
          conditionId: current.plan.seed.conditionId,
          dataset: current.seedTaskRef,
          requestedModelId: current.plan.seed.model,
          requestedCommit: parentHarnessRef,
          status: 'settled' as const,
          startedAt: timestamp,
          completedAt: timestamp,
          ...(reusable.sourceEvolutionId === undefined
            ? {}
            : { reusedFromEvolutionId: reusable.sourceEvolutionId }),
          reusedFromRoundId: reusable.sourceRoundId,
          ...reuseInvocationAudit(reusable),
        }]
      : current.evaluationAttempts
    return this.transition(store, current.roundId, {
      ...(champion ? { baseline: evidence } : {}),
      parentBaselines: [
        ...(current.parentBaselines ?? []).filter(value => value.parentCandidateId !== parentCandidateId),
        { parentCandidateId, parentHarnessRef, evidence },
      ],
      evaluationAttempts,
    })
  }

  private async persistReusableHeldOutBaseline(
    store: RefineStateStore,
    round: RefinementRound,
    championCandidateId: string,
    championHarnessRef: string,
    reusable: ReusableBaseline,
  ): Promise<RefinementRound> {
    const current = await this.requireRound(store, round.roundId)
    if (current.evaluation === undefined) throw new Error('held-out baseline reuse requires seed evaluation state')
    const evidence = structuredClone(reusable.evidence)
    const existingAttempt = current.evaluationAttempts?.find(value => (
      value.provider === evidence.provider && value.evalId === evidence.evalId
    ))
    if (existingAttempt !== undefined && existingAttempt.owner.harnessRef !== championHarnessRef) {
      throw new Error(`reused evaluation identity has conflicting ownership: ${evidence.provider}/${evidence.evalId}`)
    }
    const timestamp = now()
    const evaluationAttempts = existingAttempt === undefined
      ? [...(current.evaluationAttempts ?? []), {
          provider: evidence.provider,
          evalId: evidence.evalId,
          phase: 'held-out-baseline' as const,
          owner: { candidateId: championCandidateId, role: 'baseline' as const, harnessRef: championHarnessRef },
          conditionId: current.plan.heldOut.conditionId,
          dataset: current.heldOutRef,
          requestedModelId: current.plan.heldOut.model,
          requestedCommit: championHarnessRef,
          status: 'settled' as const,
          startedAt: timestamp,
          completedAt: timestamp,
          ...(reusable.sourceEvolutionId === undefined
            ? {}
            : { reusedFromEvolutionId: reusable.sourceEvolutionId }),
          reusedFromRoundId: reusable.sourceRoundId,
          ...reuseInvocationAudit(reusable),
        }]
      : current.evaluationAttempts
    return this.transition(store, current.roundId, {
      evaluation: { ...current.evaluation, heldOutBaseline: evidence },
      evaluationAttempts,
    })
  }

  private async queueContinuation(previous: ActiveRound): Promise<void> {
    previous.abort.signal.throwIfAborted()
    const champion = await this.requireChampion(previous.evolution.store)
    previous.abort.signal.throwIfAborted()
    const population = await previous.evolution.store.readPopulation()
    previous.abort.signal.throwIfAborted()
    if (population === undefined) throw new Error('evolution has no research population')
    const roundId = crypto.randomUUID()
    const index = previous.roundIndex + 1
    let round = await this.newRound(
      previous.evolution.store, previous.evolution.spec, champion, population, previous.source, previous.batchId, roundId, index, previous.roundCount,
      previous.advisoryFocus,
    )
    const active = this.newActive(
      previous.evolution, previous.lock, previous.source, previous.batchId, index, previous.roundCount,
      previous.advisoryFocus,
    )
    if (previous.evolution.spec.experienceMemory?.enabled === true) {
      const usageReader = this.experienceUsageReader(previous.evolution.spec)
      round = {
        ...round,
        experienceSnapshot: await prepareSeedExperienceSnapshot(previous.evolution.spec, previous.evolution.store, roundId, {
          artifactReader: this.builder,
          ...(usageReader === undefined ? {} : { usageReader }),
          signal: active.abort.signal,
        }),
      }
    }
    await previous.evolution.store.writeRound(round)
    previous.abort.signal.throwIfAborted()
    await previous.lock.retarget(roundId)
    previous.abort.signal.throwIfAborted()
    await this.registry.touch(previous.evolution.spec.evolutionId, { batchId: previous.batchId, roundId })
    // Disposal is waiting for the current drive; do not hand its lock to a
    // new drive that was not included in disposal's active-work snapshot.
    previous.abort.signal.throwIfAborted()
    this.active.set(roundId, active)
    queueMicrotask(() => this.startDrive(roundId))
  }

  private startDrive(roundId: string): void {
    const drive = this.drive(roundId)
    const active = this.active.get(roundId)
    if (active !== undefined) active.drive = drive
    this.drives.add(drive)
    void drive.finally(() => this.drives.delete(drive)).catch(() => {})
  }

  private async runtime(evolutionId: string, admitted?: { meta: MetaSessionController; store: RefineStateStore }): Promise<EvolutionRuntime> {
    const existing = this.runtimes.get(evolutionId)
    if (existing !== undefined) { existing.lastUsedAt = Date.now(); return existing }
    await this.evictRuntimeIfNeeded()
    const spec = await this.registry.requireSpec(evolutionId)
    const specDigest = digestJson(spec)
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined || entry.specDigest !== specDigest) throw new Error(`evolution spec digest mismatch: ${evolutionId}`)
    const store = admitted?.store ?? this.registry.stateStore(evolutionId)
    await store.initialize()
    this.resolveComponents(spec)
    const evaluator = this.evaluatorForSpec(spec)
    await evaluator.preflight?.()
    const meta = admitted?.meta ?? await this.createMetaSession(spec, specDigest, store)
    try { this.assertGenerationBudgetCapability(spec, meta) }
    catch (error) { await meta.dispose(); throw error }
    const runtime = {
      spec,
      specDigest,
      store,
      meta,
      evaluator,
      lastUsedAt: Date.now(),
    }
    this.runtimes.set(evolutionId, runtime)
    return runtime
  }

  private async prepareExternalBaseline(
    spec: EvolutionSpec,
    initialChampion: ChampionState,
    source: BaselineSourceRequest,
  ): Promise<PreparedBaselineSource> {
    const evaluator = this.evaluatorForSpec(spec)
    const reader = trajectoryReader(evaluator)
    if (reader === undefined) {
      throw new Error('baseline source is incompatible: current evaluator cannot read bounded Hitch trajectories')
    }
    const providerConfig = spec.rollout.provider.config as { allowUnavailableVerifierDiagnosis?: unknown }
    return prepareBaselineSource({
      registry: this.registry,
      source,
      newSpec: spec,
      initialChampion,
      evaluator,
      trajectoryReader: reader,
      workspaceRoot: this.options.workspaceRoot,
      allowUnavailableVerifierDiagnosis: providerConfig.allowUnavailableVerifierDiagnosis === true,
    })
  }

  private async recoverUnstagedBaselineSource(
    evolution: EvolutionRuntime,
  ): Promise<BaselineSourceSnapshot | undefined> {
    const conditionSource = evolution.spec.baselineConditionSource
    if (conditionSource === undefined) return undefined
    const history = await evolution.store.listRounds()
    if (history.some(round => round.baselineSource?.conditionSource.digest === conditionSource.digest)) return undefined
    if (history.length > 0) {
      throw new Error('baseline source snapshot is missing from evolution history; no baseline evaluation was started')
    }
    const champion = await this.requireChampion(evolution.store)
    const prepared = await this.prepareExternalBaseline(evolution.spec, champion, {
      evolutionId: conditionSource.source.evolutionId,
      roundId: conditionSource.source.roundId,
      partitions: conditionSource.partitions,
    })
    if (prepared.conditionSource.digest !== conditionSource.digest) {
      throw new Error('baseline source condition proof changed; no baseline evaluation was started')
    }
    return prepared.snapshot
  }

  private attachBaselineSource(
    spec: EvolutionSpec,
    round: RefinementRound,
    input: BaselineSourceSnapshot,
  ): RefinementRound {
    const snapshot = validateBaselineSourceSnapshot(input)
    const proof = spec.baselineConditionSource
    const seed = snapshot.partitions.seed
    if (proof === undefined || proof.digest !== snapshot.conditionSource.digest
      || proof.inheritedRolloutProviderDigest !== round.plan.seed.rolloutProviderDigest
      || snapshot.source.evolutionId === round.evolutionId
      || snapshot.target.harnessRef !== round.targetHarnessRef
      || snapshot.target.manifestDigest !== round.targetHarnessDigest
      || digestJson(seed.condition) !== digestJson(round.plan.seed)
      || (snapshot.partitions.heldOut !== undefined
        && digestJson(snapshot.partitions.heldOut.condition) !== digestJson(round.plan.heldOut))) {
      throw new Error('baseline source snapshot does not match the admitted round')
    }
    const championCandidateId = round.championParent?.candidateId ?? `champion-${round.targetHarnessRef}`
    const timestamp = now()
    const reusable: ReusableBaseline = {
      evidence: seed.evidence,
      sourceEvolutionId: snapshot.source.evolutionId,
      sourceRoundId: snapshot.source.roundId,
      ...(seed.currentInvocationFingerprint === undefined
        ? {}
        : { currentInvocationFingerprint: seed.currentInvocationFingerprint }),
    }
    const attempt: RoundEvaluationAttempt = {
      provider: seed.evidence.provider,
      evalId: seed.evidence.evalId,
      phase: 'seed-baseline',
      owner: { candidateId: championCandidateId, role: 'baseline', harnessRef: round.targetHarnessRef },
      conditionId: round.plan.seed.conditionId,
      dataset: round.seedTaskRef,
      requestedModelId: round.plan.seed.model,
      requestedCommit: round.targetHarnessRef,
      status: 'settled',
      startedAt: timestamp,
      completedAt: timestamp,
      reusedFromEvolutionId: snapshot.source.evolutionId,
      reusedFromRoundId: snapshot.source.roundId,
      ...reuseInvocationAudit(reusable),
    }
    return {
      ...round,
      baselineSource: snapshot,
      baseline: structuredClone(seed.evidence),
      parentBaselines: [{
        parentCandidateId: championCandidateId,
        parentHarnessRef: round.targetHarnessRef,
        evidence: structuredClone(seed.evidence),
      }],
      evaluationAttempts: [attempt],
    }
  }

  private evaluatorForSpec(spec: EvolutionSpec): RefineEvaluator {
    const evaluator = this.components.hasRolloutProvider(spec.rollout.provider.id)
      ? this.components.rolloutProvider(spec.rollout.provider).createEvaluator(spec)
      : this.options.createEvaluator?.(spec) ?? this.evaluator
    if (!spec.searchSettings || evaluator.search) return evaluator
    const state = this.registry.stateStore(spec.evolutionId), root = join(state.root, 'search')
    const roundId = 'search-evaluation-identity'
    const identityRound: RefinementRound = {
      evolutionId: spec.evolutionId, roundId, workspaceRoot: this.options.workspaceRoot, status: 'queued', source: 'api',
      createdAt: spec.createdAt, updatedAt: spec.createdAt, metaHarnessRef: spec.metaAgent.preset.id,
      targetHarnessRef: spec.initialHarness.ref, targetHarnessDigest: spec.initialHarness.digest,
      sandboxProfileRef: spec.sandboxProfileRef, seedTaskRef: spec.datasets.seed.ref, heldOutRef: spec.datasets.heldOut.ref,
      taskBudgetMs: spec.taskBudgetMs, promotionPolicy: spec.promotion.policy.config,
      batchId: roundId, roundIndex: 1, roundCount: 1, candidatePool: [], parentPopulationDigest: digestJson([]),
      plan: this.components.taskSampler(spec.rollout.taskSampler).resolve(roundId, spec.datasets, spec.rollout, spec.taskBudgetMs),
    }
    return attachSearchEvaluation(evaluator, { spec, workspaceRoot: this.options.workspaceRoot, stateRoot: root,
      identityRound,
      manifest: snapshot => this.builder.readManifest(snapshot.commit),
      round: async () => {
        const current = await new SearchStore(root).read<{ roundId: string | null }>('active-round')
        invariant(current?.roundId, 'staged evaluation has no active Gear round')
        return this.requireRound(state, current.roundId)
      },
    })
  }

  private async evictRuntimeIfNeeded(): Promise<void> {
    if (this.runtimes.size < this.options.maxLiveMetaSessions) return
    const activeEvolutionIds = new Set([
      ...[...this.active.values()].map(value => value.evolution.spec.evolutionId),
      ...[...this.repairs.values()].map(value => value.evolution.spec.evolutionId),
    ])
    const candidate = [...this.runtimes.entries()]
      .filter(([evolutionId]) => !activeEvolutionIds.has(evolutionId))
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0]
    if (candidate === undefined) throw new Error(`all ${this.options.maxLiveMetaSessions} Meta session slots are active`)
    this.runtimes.delete(candidate[0])
    await candidate[1].meta.dispose()
  }

  private async resolveInitialChampion(from: AdmissionOptions['from']): Promise<ChampionState> {
    if (from === undefined || from === 'initial') {
      if (this.options.initialChampion === undefined) throw new Error('initialChampion is required to create a new evolution')
      return { ...this.options.initialChampion, updatedAt: now() }
    }
    if (from === 'published') {
      const published = await this.registry.readPublished()
      if (published === undefined) throw new Error('no published harness is available')
      return {
        schemaVersion: 2, ref: published.ref, manifestDigest: published.manifestDigest, updatedAt: now(),
        ...(published.roundId === undefined ? {} : { roundId: published.roundId }),
      }
    }
    if (!isExactGitCommit(from)) throw new TypeError('--from must be initial, published, or an exact Git commit')
    const manifest = await this.builder.readManifest(from)
    return { schemaVersion: 2, ref: from, manifestDigest: manifest.digest, updatedAt: now() }
  }

  private passesSeed(round: RefinementRound, evaluation: RoundEvaluation): boolean {
    const promotion = round.promotionPolicy
    const candidate = round.candidatePool.find(value => value.candidateId === round.promotionCandidateId)
    const baseline = pairedAggregate(evaluation.seedPairedTrials, 'baseline')
    const pairedCandidate = pairedAggregate(evaluation.seedPairedTrials, 'candidate')
    return evaluation.seedPairedTrials.length > 0
      && pairedCandidate.score >= promotion.minimumCandidateScore
      && evaluation.scoreDelta >= promotion.minimumAbsoluteGain
      && evaluation.requiredRegressions <= promotion.maxRequiredRegressions
      && (!promotion.requireNoRegression || pairedCandidate.passed >= baseline.passed)
      && candidate?.sealedVersion?.commitOid === evaluation.seedCandidate.actualCommit
  }

  private passesHeldOut(round: RefinementRound, evaluation: RoundEvaluation, spec: EvolutionSpec): boolean {
    const baseline = evaluation.heldOutBaseline
    const candidate = evaluation.heldOutCandidate
    const selected = round.candidatePool.find(value => value.candidateId === round.promotionCandidateId)
    if (baseline === undefined || candidate === undefined || evaluation.heldOutScoreDelta === undefined
      || selected?.sealedVersion?.commitOid !== candidate.actualCommit) return false
    return this.components.promotionPolicy(spec.promotion.policy).decide({
      policy: spec.promotion.policy.config,
      seedBaseline: evaluation.seedBaseline,
      seedCandidate: evaluation.seedCandidate,
      heldOutBaseline: baseline,
      heldOutCandidate: candidate,
      pairedTrials: {
        seed: evaluation.seedPairedTrials,
        heldOut: evaluation.heldOutPairedTrials ?? [],
      },
      metrics: evaluation.promotionMetrics ?? {
        quality: candidate.primaryReward,
        taskSuccessRate: candidate.summary.total === 0 ? 0 : candidate.summary.passed / candidate.summary.total,
      },
      requiredRegressions: evaluation.requiredRegressions,
    }).accepted
  }

  private requiredRegressions(round: RefinementRound, pairs: readonly PairedTrial[]): number {
    const required = round.promotionPolicy.requiredTaskIds ?? []
    const grouped = new Map<string, PairedTrial[]>()
    for (const pair of pairs) grouped.set(pair.taskName, [...(grouped.get(pair.taskName) ?? []), pair])
    let regressions = 0
    for (const task of required) {
      const taskPairs = grouped.get(task)
      if (taskPairs === undefined || taskPairs.length === 0) {
        throw new Error(`required task has no valid paired rollout cell: ${task}`)
      }
      const left = taskPairs.reduce((sum, pair) => sum + pair.baselineReward, 0) / taskPairs.length
      const right = taskPairs.reduce((sum, pair) => sum + pair.candidateReward, 0) / taskPairs.length
      if (right < left) regressions += 1
    }
    return regressions
  }

  private assertParity(baseline: EvaluationEvidence, candidate: EvaluationEvidence, partition: string): void {
    if (baseline.conditionId !== candidate.conditionId) throw new Error(`${partition} baseline/candidate condition identity mismatch`)
    if (baseline.provider !== candidate.provider) throw new Error(`${partition} baseline/candidate rollout provider mismatch`)
    if (baseline.effectiveConfigDigest !== candidate.effectiveConfigDigest) {
      throw new Error(`${partition} baseline/candidate effective rollout config mismatch`)
    }
    if (baseline.benchmark?.id !== candidate.benchmark?.id
      || baseline.benchmark?.revision !== candidate.benchmark?.revision) {
      throw new Error(`${partition} baseline/candidate benchmark scoring identity mismatch`)
    }
    if (baseline.dataset !== candidate.dataset) throw new Error(`${partition} baseline/candidate dataset mismatch`)
    if (baseline.plannedTrialCount !== candidate.plannedTrialCount) {
      throw new Error(`${partition} baseline/candidate planned trial count mismatch`)
    }
    const baselineKeys = plannedTrialKeys(baseline)
    const candidateKeys = plannedTrialKeys(candidate)
    if (new Set(baselineKeys).size !== baselineKeys.length || new Set(candidateKeys).size !== candidateKeys.length) {
      throw new Error(`${partition} baseline/candidate have ambiguous planned trial identity`)
    }
    if (JSON.stringify(baselineKeys) !== JSON.stringify(candidateKeys)) {
      throw new Error(`${partition} baseline/candidate rollout cell identity mismatch`)
    }
  }

  private validateFinalizationEvidence(
    round: RefinementRound,
    baseline: EvaluationEvidence,
    finalization: CandidateFinalization | null,
    decline: CandidateDecline | undefined,
    audit: ProposalEvidenceAudit,
  ): void {
    if (audit.evolutionId !== round.evolutionId || audit.roundId !== round.roundId || audit.baselineEvalId !== baseline.evalId) {
      throw new Error('finalization evidence does not belong to the current evolution/round baseline')
    }
    if (round.searchMode && !audit.workplanDelivery) throw new Error('search candidate requires its assigned workplan')
    const readiness = finalizationReadiness(baseline, audit)
    if (round.searchMode && !readiness.ready) throw new Error('search workplan/dossier consumption is incomplete')
    if (!readiness.summaryAccessed) throw new Error('finalization requires the current baseline summary')
    if (finalization === null && decline === undefined) throw new Error('decline rationale is required')
    const cited = finalization?.evidenceRefs ?? decline?.evidenceRefs ?? []
    if (finalization !== null && cited.length === 0) throw new Error('finalization must cite current baseline evidence')
    if (JSON.stringify(cited) !== JSON.stringify(audit.citedRefs)) throw new Error('finalization evidence audit does not match evidenceRefs')
    const allowed = new Set([
      ...(audit.workplanDelivery?.workplan.requiredDiagnosisRefs ?? []),
      baseline.evalId,
      ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...baseline.invalidTrials.map(trial => trial.runId),
    ])
    const accessed = new Set(audit.accessedRefs)
    for (const ref of cited) {
      if (!allowed.has(ref)) throw new Error(`finalization evidence ref is not from the current seed baseline: ${ref}`)
      if (!accessed.has(ref)) throw new Error(`finalization cites seed evidence that Meta did not access: ${ref}`)
    }
    if (readiness.missing.length > 0) {
      throw new Error(`finalization requires trajectory diagnostics for every failed baseline run: ${readiness.missing.map(item => item.runId).join(', ')}`)
    }
  }

  private nextPopulation(round: RefinementRound, previous: PopulationState, selectedIds: readonly string[]): PopulationState {
    const parents = round.championParent === undefined ? previous.members : [round.championParent]
    const members: PopulationMember[] = selectedIds.map(candidateId => {
      const candidate = round.candidatePool.find(value => value.candidateId === candidateId)
      if (candidate?.sealedVersion === undefined || candidate.metrics === undefined
        || candidate.metaSessionId === undefined || candidate.resultCheckpoint === undefined) {
        throw new Error(`selected candidate is missing durable seed state: ${candidateId}`)
      }
      const parent = parents.find(value => value.candidateId === candidate.parentCandidateIds[0])
      if (parent === undefined) throw new Error(`selected candidate has unknown parent: ${candidateId}`)
      return {
        candidateId,
        harnessRef: candidate.sealedVersion.commitOid,
        harnessDigest: candidate.sealedVersion.manifestDigest,
        parentCandidateIds: [...candidate.parentCandidateIds],
        lineageRootId: parent.lineageRootId,
        metaSessionId: candidate.metaSessionId,
        metaCheckpoint: candidate.resultCheckpoint,
        metrics: { ...candidate.metrics },
        selectedAt: now(),
      }
    })
    const identity = { evolutionId: round.evolutionId, generation: previous.generation + 1, members }
    return { ...identity, digest: digestJson(identity) }
  }

  private async cleanupExecution(
    active: ActiveRound,
    execution: CandidateExecution,
    cancelReason?: string,
  ): Promise<void> {
    const { meta } = active.evolution
    const sessionId = execution.metaSessionId
    const workspace = execution.workspace
    if (cancelReason !== undefined) execution.finalizationPersisted.reject(new Error(cancelReason))
    await Promise.allSettled([...(execution.evidenceWrites ?? [])])
    if (cancelReason !== undefined && sessionId !== undefined) await meta.cancel(sessionId, cancelReason).catch(() => {})
    if (sessionId !== undefined && workspace !== undefined) {
      try { this.workspaceManager.unbind(sessionId, workspace.workspaceId) } catch {}
    }
    if (workspace !== undefined) await this.workspaceManager.drain(workspace.workspaceId).catch(() => {})
    if (sessionId !== undefined) await meta.release(sessionId).catch(() => {})
    if (workspace !== undefined && execution.preserveWorkspace !== true) await this.workspaceManager.dispose(workspace.workspaceId).catch(() => {})
    active.executions.delete(execution.candidateId)
    if (active.currentCandidateId === execution.candidateId) delete active.currentCandidateId
  }

  private async hasDurableContextRecovery(active: ActiveRound, round: RefinementRound): Promise<boolean> {
    if (!this.disposed || active.evolution.spec.metaAgent.contextOffloading === undefined) return false
    const executions = await new MetaOffloadingStore(active.evolution.store.root).list()
    const resumable = resumableContextExecutions(round, executions)
    return resumable.length === 1
      && hasContextRecoveryRoundStage(round)
      && contextRecoveryOwnerMatches(round, resumable[0]!, active.evolution.specDigest)
  }

  private async reconcileCommitIntent(store: RefineStateStore, round: RefinementRound): Promise<void> {
    const intent = round.commitIntent
    if (intent === undefined) throw new Error('round has no commit intent')
    const population = await store.readPopulation()
    if (population?.digest === intent.expectedPopulationDigest) {
      await store.compareAndSwapPopulation(intent.expectedPopulationDigest, intent.nextPopulation)
    } else if (population?.digest !== intent.nextPopulation.digest) {
      throw new Error('population does not match either side of the commit intent')
    }
    const champion = await this.requireChampion(store)
    if (intent.nextChampion !== undefined) {
      if (champion.ref === intent.expectedChampionRef) {
        await store.compareAndSwapChampion(intent.expectedChampionRef, intent.nextChampion)
      } else if (champion.ref !== intent.nextChampion.ref) {
        throw new Error('champion does not match either side of the commit intent')
      }
    } else if (champion.ref !== intent.expectedChampionRef) {
      throw new Error('rejected commit intent observed an unexpected champion')
    }
    const { failure: _failure, ...recovered } = round
    await store.writeRound({
      ...recovered,
      status: intent.decision,
      decision: intent.decision,
      ...(intent.decision === 'accepted' ? { promotedCandidateId: intent.promotionCandidateId } : {}),
      commitIntent: { ...intent, phase: 'champion-committed' },
      updatedAt: now(),
    })
  }

  private async transition(store: RefineStateStore, roundId: string, patch: RoundPatch): Promise<RefinementRound> {
    const round = await this.requireRound(store, roundId)
    const updated = { ...round, ...patch, updatedAt: now() } as RefinementRound & Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete updated[key]
    }
    await store.writeRound(updated)
    return updated
  }

  private async evaluateWithAttempt(
    active: ActiveRound,
    round: RefinementRound,
    request: EvaluationRequest,
    owner: RoundEvaluationAttempt['owner'],
    settledPatch: (
      current: RefinementRound,
      evidence: EvaluationEvidence,
    ) => Partial<RefinementRound> | Promise<Partial<RefinementRound>>,
  ): Promise<{ round: RefinementRound; evidence: EvaluationEvidence }> {
    const { evaluator, store } = active.evolution
    active.abort.signal.throwIfAborted()
    // Record possible execution before calling provider code, including providers
    // without reserve() and failures before a reservation response is persisted.
    const beforeStart = await this.requireRound(store, round.roundId)
    round = await this.transition(store, round.roundId, {
      evaluationStarts: [...(beforeStart.evaluationStarts ?? []), {
        phase: request.phase, harnessRef: request.harnessRef,
        conditionId: request.condition.conditionId, startedAt: now(),
      }],
    })
    active.abort.signal.throwIfAborted()
    const intent = evaluator.prepareSubmission?.(round, request)
    let pending: PendingEvaluationSubmission | undefined
    if (intent !== undefined) {
      if (evaluator.reserve === undefined || evaluator.cancelReservation === undefined) {
        throw new Error('durable evaluation submission requires reservation and cancellation support')
      }
      pending = { intent, request: structuredClone(request), owner: { ...owner }, startedAt: now() }
      const current = await this.requireRound(store, round.roundId)
      round = await this.transition(store, round.roundId, {
        pendingEvaluationSubmissions: [...(current.pendingEvaluationSubmissions ?? []), pending],
      })
    }
    let reservation: EvaluationReservation | undefined
    let attempt: RoundEvaluationAttempt | undefined
    let evidence: EvaluationEvidence
    try {
      active.abort.signal.throwIfAborted()
      reservation = await evaluator.reserve?.(round, request, active.abort.signal, intent)
      active.abort.signal.throwIfAborted()
      if (reservation !== undefined) {
        if (typeof reservation.provider !== 'string' || reservation.provider.length === 0
          || typeof reservation.evalId !== 'string' || reservation.evalId.length === 0
          || (intent !== undefined && reservation.provider !== intent.provider)) {
          throw new Error('evaluator returned an invalid evaluation reservation')
        }
        const current = await this.requireRound(store, round.roundId)
        if ((current.evaluationAttempts ?? []).some(value => value.provider === reservation!.provider && value.evalId === reservation!.evalId)) {
          throw new Error(`evaluation reservation was reused: ${reservation.provider}/${reservation.evalId}`)
        }
        attempt = {
          provider: reservation.provider, evalId: reservation.evalId,
          phase: request.phase, owner: { ...owner },
          conditionId: request.condition.conditionId, dataset: request.dataset,
          requestedModelId: request.condition.model, requestedCommit: request.harnessRef,
          status: 'running', startedAt: pending?.startedAt ?? now(),
          ...(intent === undefined ? {} : { submissionIntent: intent }),
        }
        round = await this.transition(store, round.roundId, {
          evaluationAttempts: [...(current.evaluationAttempts ?? []), attempt],
          ...(pending === undefined ? {} : {
            pendingEvaluationSubmissions: (current.pendingEvaluationSubmissions ?? []).map(value =>
              this.sameSubmission(value, pending!) ? { ...value, reservation: reservation! } : value),
          }),
        })
      } else if (pending !== undefined) {
        throw new Error('durable evaluation submission returned no reservation')
      }
      evidence = await evaluator.evaluate(round, request, active.abort.signal, reservation)
      if (reservation !== undefined
        && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
        throw new Error(`evaluation evidence does not match reservation: ${reservation.provider}/${reservation.evalId}`)
      }
    } catch (error) {
      let failure = error
      if (pending !== undefined) {
        try {
          await this.cleanupEvaluationSubmission(store, round, evaluator, pending, reservation, evaluationFailure(error))
        } catch (cleanupError) {
          failure = new EvaluationCleanupError(error, cleanupError)
        }
      }
      if (attempt !== undefined) {
        try {
          const current = await this.requireRound(store, round.roundId)
          const status = active.abort.signal.aborted ? 'cancelled' as const : 'failed' as const
          await this.transition(store, round.roundId, {
            evaluationAttempts: (current.evaluationAttempts ?? []).map(value => this.sameAttempt(value, attempt!)
              ? {
                  ...value, status, completedAt: now(), failure: evaluationFailure(failure),
                  ...(failure instanceof EvaluationCleanupError ? { cleanupFailure: failure.cleanupFailure } : {}),
                } : value),
          })
        } catch (persistError) {
          throw new EvaluationCleanupError(failure, persistError)
        }
      }
      throw failure
    }

    let patch: Partial<RefinementRound>
    try {
      patch = await settledPatch(round, evidence)
      active.abort.signal.throwIfAborted()
    } catch (error) {
      if (attempt !== undefined) {
        const current = await this.requireRound(store, round.roundId)
        await this.transition(store, round.roundId, {
          ...(pending === undefined ? {} : {
            pendingEvaluationSubmissions: (current.pendingEvaluationSubmissions ?? []).filter(value => !this.sameSubmission(value, pending!)),
          }),
          evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
            ? { ...value, status: 'settled', completedAt: now() }
            : value),
        })
      }
      throw error
    }
    const current = await this.requireRound(store, round.roundId)
    const evaluationAttempts = attempt === undefined ? current.evaluationAttempts : (current.evaluationAttempts ?? []).map(value => (
      value.provider === attempt!.provider && value.evalId === attempt!.evalId
        ? { ...value, status: 'settled' as const, completedAt: now() }
        : value
    ))
    round = await this.transition(store, round.roundId, {
      ...patch,
      ...(pending === undefined ? {} : {
        pendingEvaluationSubmissions: (current.pendingEvaluationSubmissions ?? []).filter(value => !this.sameSubmission(value, pending!)),
      }),
      ...(evaluationAttempts === undefined ? {} : { evaluationAttempts }),
    })
    return { round, evidence }
  }

  private sameSubmission(left: PendingEvaluationSubmission, right: PendingEvaluationSubmission): boolean {
    return left.intent.provider === right.intent.provider && left.intent.idempotencyKey === right.intent.idempotencyKey
  }

  private async cleanupEvaluationSubmission(
    store: RefineStateStore,
    round: RefinementRound,
    evaluator: RefineEvaluator,
    pending: PendingEvaluationSubmission,
    knownReservation: EvaluationReservation | undefined,
    failure: EvaluationFailure,
  ): Promise<void> {
    let reservation = knownReservation ?? pending.reservation
    try {
      if (evaluator.cancelReservation === undefined || evaluator.reserve === undefined) {
        throw new Error('cannot recover durable evaluation: evaluator has no reservation/cancellation support')
      }
      // The original caller may already be aborted. Replay the persisted key with
      // an independent bound to recover an accepted submission whose reply was lost.
      if (reservation === undefined) {
        const recover = evaluator.recoverReservation ?? evaluator.reserve
        reservation = await recover.call(evaluator, round, pending.request, AbortSignal.timeout(30_000), pending.intent)
      }
      if (reservation.provider !== pending.intent.provider || !reservation.evalId) {
        throw new Error('recovered evaluation reservation does not match its durable intent')
      }
      await evaluator.cancelReservation(reservation, pending.intent)
      const current = await this.requireRound(store, round.roundId)
      const existing = current.evaluationAttempts?.find(value => this.sameAttempt(value, reservation!))
      const cancelled: RoundEvaluationAttempt = {
        ...reservation, phase: pending.request.phase, owner: pending.owner,
        conditionId: pending.request.condition.conditionId, dataset: pending.request.dataset,
        requestedModelId: pending.request.condition.model, requestedCommit: pending.request.harnessRef,
        startedAt: pending.startedAt, status: 'cancelled', completedAt: now(), failure,
        submissionIntent: pending.intent,
      }
      await this.transition(store, round.roundId, {
        pendingEvaluationSubmissions: (current.pendingEvaluationSubmissions ?? []).filter(value => !this.sameSubmission(value, pending)),
        evaluationAttempts: existing === undefined
          ? [...(current.evaluationAttempts ?? []), cancelled]
          : (current.evaluationAttempts ?? []).map(value => {
              if (!this.sameAttempt(value, reservation!)) return value
              const { cleanupFailure: _cleanupFailure, ...owned } = value
              return value.status === 'running' || value.status === 'rerunning' ? cancelled : owned
            }),
      })
    } catch (error) {
      // Never discard the intent on failed cleanup. A future startup retries it,
      // including when the round itself has already been marked failed.
      try {
        const current = await this.requireRound(store, round.roundId)
        await this.transition(store, round.roundId, {
          pendingEvaluationSubmissions: (current.pendingEvaluationSubmissions ?? []).map(value =>
            this.sameSubmission(value, pending) ? {
              ...value,
              ...(reservation === undefined ? {} : { reservation }),
              cleanupFailure: evaluationFailure(error),
            } : value),
        })
      } catch { /* The original persisted intent still owns the submission. */ }
      throw error
    }
  }

  private async recoverEvaluationSubmissions(
    store: RefineStateStore,
    round: RefinementRound,
    evaluator: RefineEvaluator,
  ): Promise<RefinementRound> {
    const pending = [...(round.pendingEvaluationSubmissions ?? [])]
    for (const attempt of round.evaluationAttempts ?? []) {
      if (attempt.submissionIntent === undefined || attempt.status !== 'running') continue
      const submission: PendingEvaluationSubmission = {
        intent: attempt.submissionIntent, request: this.evaluationRequest(round, attempt),
        owner: attempt.owner, startedAt: attempt.startedAt,
        reservation: { provider: attempt.provider, evalId: attempt.evalId },
      }
      if (!pending.some(value => this.sameSubmission(value, submission))) pending.push(submission)
    }
    round = await this.transition(store, round.roundId, { pendingEvaluationSubmissions: pending })
    for (const submission of pending) {
      await this.cleanupEvaluationSubmission(store, round, evaluator, submission, submission.reservation, {
        code: 'evaluation_interrupted_by_restart', message: 'control plane restarted during a remote evaluation',
      })
    }
    return this.requireRound(store, round.roundId)
  }

  private evaluationRequest(round: RefinementRound, attempt: RoundEvaluationAttempt): EvaluationRequest {
    const condition = attempt.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    const dataset = attempt.phase.startsWith('seed-') ? round.seedTaskRef : round.heldOutRef
    if (attempt.conditionId !== condition.conditionId || attempt.dataset !== dataset
      || attempt.requestedModelId !== condition.model || attempt.requestedCommit !== attempt.owner.harnessRef) {
      throw new Error(`evaluation attempt ${attempt.evalId} no longer matches its frozen condition`)
    }
    return { phase: attempt.phase, dataset, harnessRef: attempt.requestedCommit, condition }
  }

  private assertRepairedEvidence(attempt: RoundEvaluationAttempt, evidence: EvaluationEvidence): void {
    if (evidence.provider !== attempt.provider || evidence.evalId !== attempt.evalId
      || evidence.conditionId !== attempt.conditionId || evidence.dataset !== attempt.dataset
      || evidence.requestedCommit !== attempt.requestedCommit || evidence.actualCommit !== attempt.owner.harnessRef) {
      throw new Error(`repaired evaluation evidence does not match attempt ${attempt.evalId}`)
    }
  }

  private completeEvaluationRepairResume(
    active: ActiveRound,
    round: RefinementRound,
    patch: RoundPatch,
  ): RoundPatch {
    if (active.repairAttempt === undefined) return patch
    const intent = round.evaluationRepairResume
    if (intent === undefined || !this.sameAttempt(intent, active.repairAttempt)) {
      throw new Error(`round ${round.roundId} lost its durable evaluation repair resume intent`)
    }
    let found = false
    const evaluationAttempts = (round.evaluationAttempts ?? []).map(attempt => {
      if (!this.sameAttempt(attempt, active.repairAttempt!)) return attempt
      if (attempt.status !== 'repair-completed' || !this.attemptHasEvidence(round, attempt)) {
        throw new Error(`round ${round.roundId} cannot settle an incomplete evaluation repair`)
      }
      found = true
      const { failure: _failure, ...owned } = attempt
      return { ...owned, status: 'settled' as const, completedAt: intent.completedAt }
    })
    if (!found) throw new Error(`round ${round.roundId} lost its repaired evaluation attempt`)
    return { ...patch, evaluationRepairResume: undefined, evaluationAttempts }
  }

  private async repairedEvidencePatch(
    round: RefinementRound,
    attempt: RoundEvaluationAttempt,
    evidence: EvaluationEvidence,
    spec: EvolutionSpec,
  ): Promise<RoundPatch> {
    if (attempt.phase === 'seed-baseline') {
      const parentBaselines = [
        ...(round.parentBaselines ?? []).filter(value => value.parentCandidateId !== attempt.owner.candidateId),
        { parentCandidateId: attempt.owner.candidateId, parentHarnessRef: attempt.owner.harnessRef, evidence },
      ]
      return {
        parentBaselines,
        ...(attempt.owner.harnessRef === round.targetHarnessRef ? { baseline: evidence } : {}),
      }
    }
    if (attempt.phase === 'seed-candidate') {
      const candidate = round.candidatePool.find(value => value.candidateId === attempt.owner.candidateId)
      if (candidate?.sealedVersion?.commitOid !== attempt.owner.harnessRef) throw new Error('repaired seed candidate owner is unavailable')
      return {
        // The assessable set changes when a failed seed eval is repaired.
        selectionAssessment: undefined,
        selection: undefined,
        promotionCandidateId: undefined,
        candidatePool: this.patchCandidate(round, candidate.candidateId, {
          seedEvaluation: evidence,
          seedComparison: undefined,
          metrics: undefined,
          status: 'evaluating',
          failure: undefined,
        }),
      }
    }
    if (round.evaluation === undefined) throw new Error('repaired held-out evaluation has no seed evaluation state')
    if (attempt.phase === 'held-out-baseline') {
      return { evaluation: { ...round.evaluation, heldOutBaseline: evidence } }
    }
    const candidate = round.candidatePool.find(value => value.candidateId === attempt.owner.candidateId)
    if (candidate?.sealedVersion?.commitOid !== attempt.owner.harnessRef) throw new Error('repaired held-out candidate owner is unavailable')
    const heldOutBaseline = round.evaluation.heldOutBaseline
    if (heldOutBaseline === undefined) throw new Error('repaired held-out candidate has no paired baseline')
    this.assertParity(heldOutBaseline, evidence, 'held-out')
    const heldOutPairs = pairedTrials(heldOutBaseline, evidence)
    const heldOutBaselineAggregate = pairedAggregate(heldOutPairs, 'baseline')
    const heldOutCandidateAggregate = pairedAggregate(heldOutPairs, 'candidate')
    const evaluation = {
      ...round.evaluation,
      heldOutCandidate: evidence,
      heldOutPairedTrials: heldOutPairs,
      heldOutPairing: pairingAudit(heldOutBaseline, evidence, heldOutPairs),
      promotionMetrics: heldOutPairs.length === 0
        ? { quality: 0, taskSuccessRate: 0 }
        : await this.evaluateJudges(spec, projectPairedEvidence(evidence, heldOutPairs, 'candidate')),
      heldOutScoreDelta: heldOutCandidateAggregate.score - heldOutBaselineAggregate.score,
      ...(pairedProcessDelta(heldOutPairs) === undefined ? {} : { heldOutProcessScoreDelta: pairedProcessDelta(heldOutPairs)! }),
      requiredRegressions: round.evaluation.requiredRegressions
        + (heldOutPairs.length === 0 ? 0 : this.requiredRegressions(round, heldOutPairs)),
    }
    return {
      evaluation,
      candidatePool: this.patchCandidate(round, candidate.candidateId, { heldOutEvaluation: evidence, failure: undefined }),
    }
  }

  private async requireRound(store: RefineStateStore, roundId: string): Promise<RefinementRound> {
    const round = await store.readRound(roundId)
    if (round === undefined) throw new Error(`unknown refinement round: ${roundId}`)
    return round
  }

  private async requireChampion(store: RefineStateStore): Promise<ChampionState> {
    const champion = await store.readChampion()
    if (champion === undefined) throw new Error('evolution has no champion')
    return champion
  }

  private patchCandidate(
    round: Readonly<RefinementRound>,
    candidateId: string,
    patch: CandidatePatch,
  ): CandidateRecord[] {
    let found = false
    const candidates = round.candidatePool.map(candidate => {
      if (candidate.candidateId !== candidateId) return candidate
      found = true
      const updated = { ...candidate, ...patch, candidateId: candidate.candidateId, roundId: candidate.roundId } as CandidateRecord & Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete updated[key]
      }
      return updated
    })
    if (!found) throw new Error(`unknown candidate in round ${round.roundId}: ${candidateId}`)
    return candidates
  }

  private async evaluateJudges(
    spec: EvolutionSpec,
    evidence: EvaluationEvidence,
  ): Promise<import('../types.js').MetricSet> {
    const values = await Promise.all(spec.evaluation.judges.map(async ref => this.components.judge(ref).evaluate(evidence)))
    const merged = Object.assign({
      quality: evidence.primaryReward,
      taskSuccessRate: evidence.summary.total === 0 ? 0 : evidence.summary.passed / evidence.summary.total,
    }, ...values)
    if (!Number.isFinite(merged.quality) || !Number.isFinite(merged.taskSuccessRate)) {
      throw new Error('judge produced invalid quality metrics')
    }
    return merged
  }

  private resolveComponents(spec: EvolutionSpec): void {
    if (spec.searchSettings) this.components.parentSelectionPolicy(resolveParentPolicyRef(spec.searchSettings.search))
    else this.components.candidateGenerator(spec.candidateGeneration.strategy)
    this.components.taskSampler(spec.rollout.taskSampler)
    if (!spec.searchSettings) {
      this.components.assessor(spec.selection.assessor)
      this.components.selector(spec.selection.strategy)
      this.components.promotionPolicy(spec.promotion.policy)
    }
    if (this.components.hasRolloutProvider(spec.rollout.provider.id)) {
      this.components.rolloutProvider(spec.rollout.provider)
    } else if (this.options.createEvaluator === undefined && spec.rollout.provider.id !== 'hitch-cli') {
      throw new Error(`unsupported rollout provider: ${spec.rollout.provider.id}`)
    }
    if (!spec.searchSettings) for (const judge of spec.evaluation.judges) this.components.judge(judge)
    if (spec.rollout.seeds !== undefined) throw new Error('current Hitch adapter does not support typed rollout seeds')
    if (spec.rollout.sampling.temperature !== undefined) {
      throw new Error('current Hitch adapter does not support typed rollout temperature')
    }
  }

  private assertGenerationBudgetCapability(spec: EvolutionSpec, meta: MetaSessionController): void {
    const searchHasLimits = spec.searchSettings && [spec.searchSettings.budgets.round, spec.searchSettings.budgets.evolution]
      .some(budget => budget.maxGenerationTokens !== undefined || budget.maxGenerationRequests !== undefined)
    if ((searchHasLimits || spec.candidateGeneration.budget.maxModelRequests !== undefined
      || spec.candidateGeneration.budget.maxTokens !== undefined) && meta.capabilities?.aggregateGenerationBudget !== true) {
      throw new Error('Meta adapter cannot enforce aggregate generation budgets; omit unsupported token/request limits or use a metered adapter')
    }
  }

  private assertAvailable(): void { if (this.disposed) throw new Error('RefineService is disposed') }
}
