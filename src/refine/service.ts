import type { CandidateWorkspaceHandle, CandidateWorkspaceManager } from '../candidate/workspace.js'
import { ComponentRegistry } from '../evolution/components.js'
import type { HarnessBuilder } from '../harness/builder.js'
import { SubstrateExpansionError } from '../harness/builder.js'
import type { MetaSessionController } from '../meta/controller.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson, type EvolutionRegistryStore } from '../state/evolution.js'
import type { RefineStateStore, WorkspaceLock } from '../state/store.js'
import type {
  AdmissionResult, CandidateAssessment, CandidateAssessmentResult, CandidateDecline, CandidateDiffSummary, CandidateFinalization, CandidateRecord, ChampionState,
  CandidateGenerationAttempt, CandidateGenerationSpec, ComponentRef, MetaAgentSpec, EvaluationEvidence, EvaluationRequest, EvaluationRerunResult, EvaluationRerunSelector, EvolutionRegistryEntry, EvolutionSpec, MetaAttribution,
  HitchTrajectoryReader, MetaCheckpointRef, MetaTurnObservation, MetricSet, PairedTrial, PairingAudit, PopulationState, ProposalEvidenceAudit, PromotionPolicy, PublicSeedEvidence, PublicRoundStatus,
  RefineEvaluator, RefinementRound, RolloutSpec, RoundEvaluation, RoundEvaluationAttempt, SemanticTarget, PopulationMember,
} from '../types.js'
import { isExactGitCommit } from '../types.js'

export interface RefineServiceOptions {
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
}

export interface ContinueOptions { rounds?: number; focus?: SemanticTarget[] }
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
  finalizationSubmitted: boolean
  workspace?: CandidateWorkspaceHandle
  metaSessionId?: string
  baseline?: EvaluationEvidence
}

type CandidatePatch = { [Key in keyof CandidateRecord]?: CandidateRecord[Key] | undefined }
type RoundPatch = { [Key in keyof RefinementRound]?: RefinementRound[Key] | undefined }

interface ActiveRound {
  evolution: EvolutionRuntime
  lock: WorkspaceLock
  abort: AbortController
  executions: Map<string, CandidateExecution>
  currentCandidateId?: string
  batchId: string
  roundIndex: number
  roundCount: number
  advisoryFocus?: SemanticTarget[]
  source: RefinementRound['source']
  repairAttempt?: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>
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
}

const TERMINAL = new Set<RefinementRound['status']>(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])
function now(): string { return new Date().toISOString() }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

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
      observation.effectiveMaxTokens === undefined ? undefined : `effectiveMaxTokens=${observation.effectiveMaxTokens}`,
      observation.usage?.outputTokens === undefined ? undefined : `outputTokens=${observation.usage.outputTokens}`,
      observation.usage?.reasoningTokens === undefined ? undefined : `reasoningTokens=${observation.usage.reasoningTokens}`,
      observation.durationMs === undefined ? undefined : `durationMs=${observation.durationMs}`,
    ].filter((value): value is string => value !== undefined)
    super(`Meta turn ended without candidate.finalize or candidate.decline (${details.join(', ')})`)
    this.name = 'MetaTurnEndedWithoutProposalError'
  }
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
  message: string,
): CandidateRecord[] {
  return round.candidatePool.map(candidate => {
    if (!candidate.generationAttempts?.some(attempt => attempt.status === 'running')) return candidate
    const failure = { phase: 'candidate-generation', message }
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

function finalizationResolvers(): PromiseWithResolvers<FinalizationValue> {
  const value = Promise.withResolvers<FinalizationValue>()
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
  return typeof value.inspectTrajectory === 'function' ? value as HitchTrajectoryReader : undefined
}

function publicSeedEvidence(evidence: EvaluationEvidence): PublicSeedEvidence {
  return {
    evalId: evidence.evalId,
    completeness: evidence.completeness,
    plannedTrialCount: evidence.plannedTrialCount,
    primaryReward: evidence.primaryReward,
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

function projectPairedEvidence(
  evidence: EvaluationEvidence,
  pairs: readonly PairedTrial[],
  side: 'baseline' | 'candidate',
): EvaluationEvidence {
  const keys = new Set(pairs.map(pair => pair.trialKey))
  const trials = evidence.trials.filter(trial => keys.has(trialIdentity(trial)))
  const aggregate = pairedAggregate(pairs, side)
  return {
    ...evidence,
    completeness: 'complete',
    plannedTrialCount: pairs.length,
    primaryReward: aggregate.score,
    summary: {
      total: aggregate.total,
      passed: aggregate.passed,
      failed: aggregate.total - aggregate.passed,
      score: aggregate.score,
      metrics: { primaryReward: aggregate.score },
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

  async initialize(): Promise<void> {
    this.assertAvailable()
    await this.evaluator.preflight?.()
    await this.registry.initialize()
    await this.workspaceManager.initialize()
    const pendingResumes: PendingEvaluationResume[] = []
    for (const entry of await this.registry.list()) {
      const store = this.registry.stateStore(entry.evolutionId)
      await store.initialize()
      for (const round of await store.listRounds()) {
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
              failure: { phase: 'recovery', message: 'control plane restarted during an evaluation resumed from repair' },
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
            failure: { phase: 'recovery', message: 'control plane restarted during an evaluation' },
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
          const completedAt = now()
          await store.writeRound({
            ...round, status: 'failed', updatedAt: completedAt,
            failure: { phase: 'recovery', message: 'control plane restarted before the round reached a durable commit intent' },
            candidatePool: settleInterruptedCandidateGeneration(
              round, completedAt, 'control plane restarted during candidate generation',
            ),
          })
        }
      }
      await this.workspaceManager.recoverOrphans(entry.evolutionId)
    }
    const resumedRoundIds: string[] = []
    try {
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
    const evolutionId = crypto.randomUUID()
    const batchId = crypto.randomUUID()
    const initial = await this.resolveInitialChampion(options.from)
    const seedTaskRef = options.seedTaskRef ?? this.options.seedTaskRef
    const spec: EvolutionSpec = {
      evolutionId, createdAt: now(),
      initialHarness: { ref: initial.ref, digest: initial.manifestDigest },
      datasets: {
        seed: { ref: seedTaskRef, digest: await digestDatasetRef(seedTaskRef) },
        heldOut: { ref: this.options.heldOutRef, digest: await digestDatasetRef(this.options.heldOutRef) },
      },
      metaAgent: structuredClone(this.options.metaAgent),
      candidateGeneration: structuredClone(this.options.candidateGeneration),
      rollout: structuredClone(this.options.rollout),
      evaluation: structuredClone(this.options.evaluation),
      selection: structuredClone(this.options.selection),
      promotion: structuredClone(this.options.promotion),
      taskBudgetMs,
      toolchainRef: this.options.toolchainRef, sandboxProfileRef: this.options.sandboxProfileRef,
    }
    this.resolveComponents(spec)
    await this.registry.createEvolution({ spec, champion: initial, ...(options.name === undefined ? {} : { name: options.name }) })
    return this.startBatch(await this.runtime(evolutionId), source, batchId, roundCount, normalizeFocus(options.focus))
  }

  async continueEvolution(source: RefinementRound['source'], evolutionId: string, options: ContinueOptions = {}): Promise<AdmissionResult> {
    this.assertAvailable()
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    if (entry.status !== 'active') throw new Error(`evolution is archived and cannot continue: ${evolutionId}`)
    const evolution = await this.runtime(evolutionId)
    this.resolveComponents(evolution.spec)
    await this.options.validateRuntime?.(evolution.spec)
    const [seedDigest, heldOutDigest] = await Promise.all([
      digestDatasetRef(evolution.spec.datasets.seed.ref), digestDatasetRef(evolution.spec.datasets.heldOut.ref),
    ])
    if (seedDigest !== evolution.spec.datasets.seed.digest || heldOutDigest !== evolution.spec.datasets.heldOut.digest) {
      throw new Error('evolution dataset content changed; create a new evolution')
    }
    return this.startBatch(evolution, source, crypto.randomUUID(), validateCount(options.rounds ?? 1), normalizeFocus(options.focus))
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
      let round = await this.transition(evolution.store, roundId, {
        status: 'repairing-evaluation',
        failure: undefined,
        evaluationAttempts: (initialRound.evaluationAttempts ?? []).map(value => this.sameAttempt(value, attempt)
          ? (() => {
              const { completedAt: _completedAt, failure: _failure, ...owned } = value
              return { ...owned, status: 'rerunning' as const }
            })()
          : value),
      })
      const rerun = evolution.evaluator.rerun
      if (rerun === undefined) throw new Error('configured evaluator does not support task rerun')
      const result = await rerun.call(evolution.evaluator, round, request, attempt, selector, repair.abort.signal)
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
    const round = await repair.evolution.store.readRound(repair.roundId).catch(() => undefined)
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
    await repair.evolution.store.writeRound({
      ...round,
      status: 'failed',
      updatedAt: completedAt,
      failure: { phase: 'repairing-evaluation', message: errorMessage(error) },
      evaluationAttempts: (round.evaluationAttempts ?? []).map(attempt => this.sameAttempt(attempt, repair.attempt)
        ? { ...attempt, status: 'failed' as const, completedAt, failure: { code, message: errorMessage(error) } }
        : attempt),
    })
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
    if (round.status !== 'candidate-editing') throw new Error(`round ${roundId} is not accepting a finalization`)
    if (execution.finalizationSubmitted) throw new Error(`candidate ${execution.candidateId} already received a finalization`)
    if (meta.evolutionId !== evolutionId || evidence.candidateId !== execution.candidateId) {
      throw new Error('finalization Meta session does not own this evolution candidate')
    }
    const candidate = round.candidatePool.find(value => value.candidateId === execution.candidateId)
    const baseline = round.parentBaselines?.find(value => value.parentCandidateId === candidate?.parentCandidateIds[0])?.evidence
    if (candidate === undefined || baseline === undefined) throw new Error('candidate parent baseline is unavailable')
    this.validateFinalizationEvidence(round, baseline, finalization, decline, evidence)
    let diff: CandidateDiffSummary | undefined
    if (finalization !== null) {
      if (execution.workspace === undefined) throw new Error('candidate has no workspace')
      diff = await this.workspaceManager.seal(execution.workspace.workspaceId, execution.signal)
      if (diff.files.length === 0) throw new Error('candidate has no changes; use decline_candidate')
    }
    execution.finalizationSubmitted = true
    execution.finalization.resolve({
      finalization,
      ...(decline === undefined ? {} : { decline }),
      ...(diff === undefined ? {} : { diff }),
      meta,
      evidence,
    })
    return diff
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
          attempts: candidate.generationAttempts.map(attempt => ({
            attempt: attempt.attempt,
            status: attempt.status,
            startedAt: attempt.startedAt,
            ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
            ...(attempt.metaSessionId === undefined ? {} : { metaSessionId: attempt.metaSessionId }),
            ...(attempt.metaTurn === undefined ? {} : { metaTurn: structuredClone(attempt.metaTurn) }),
            ...(attempt.failure === undefined ? {} : { failure: { ...attempt.failure } }),
          })),
        }])
    return {
      evolutionId, batchId: round.batchId, roundId: round.roundId, status: round.status,
      ...(round.decision === undefined ? {} : { decision: round.decision }),
      ...(round.evaluation?.seedCandidate !== undefined
        ? { seedSummary: round.evaluation.seedCandidate.summary }
        : round.baseline === undefined ? {} : { seedSummary: round.baseline.summary }),
      ...(round.baseline === undefined ? {} : { seedBaseline: publicSeedEvidence(round.baseline) }),
      ...(round.evaluation?.seedCandidate === undefined ? {} : { seedCandidate: publicSeedEvidence(round.evaluation.seedCandidate) }),
      ...(round.failure === undefined ? {} : { failure: round.failure.phase }),
      ...(candidateGeneration.length === 0 ? {} : { candidateGeneration }),
      ...(repairableEvaluations === undefined ? {} : { repairableEvaluations }),
    }
  }

  listEvolutions(): Promise<EvolutionRegistryEntry[]> { return this.registry.list() }

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
  } | undefined {
    for (const [roundId, active] of this.active) {
      const execution = [...active.executions.values()].find(value => value.metaSessionId === sessionId)
      if (execution?.workspace === undefined) continue
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
      }
    }
    return undefined
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const error = new Error('RefineService disposed')
    for (const repair of this.repairs.values()) repair.abort.abort(error)
    for (const active of this.active.values()) {
      active.abort.abort(error)
      for (const execution of active.executions.values()) {
        execution.abort.abort(error)
        execution.finalization.reject(error)
      }
    }
    await Promise.allSettled([...this.repairs.values()].flatMap(repair => repair.completion === undefined ? [] : [repair.completion]))
    await Promise.allSettled([...this.drives])
    await Promise.all([...this.repairs.values()].map(repair => repair.lock.release().catch(() => {})))
    this.repairs.clear()
    await Promise.all([...this.active.values()].map(active => active.lock.release().catch(() => {})))
    this.active.clear()
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.meta.dispose()))
    this.runtimes.clear()
  }

  private async startBatch(
    evolution: EvolutionRuntime,
    source: RefinementRound['source'],
    batchId: string,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
  ): Promise<AdmissionResult> {
    const roundId = crypto.randomUUID()
    const lock = await evolution.store.acquireRoundLock(roundId)
    const champion = await this.requireChampion(evolution.store).catch(async (error: unknown) => { await lock.release(); throw error })
    const population = await evolution.store.readPopulation().catch(async (error: unknown) => { await lock.release(); throw error })
    if (population === undefined) { await lock.release(); throw new Error('evolution has no research population') }
    const round = this.newRound(
      evolution.spec, champion, population, source, batchId, roundId, 1, roundCount, advisoryFocus,
    )
    const active = this.newActive(evolution, lock, source, batchId, 1, roundCount, advisoryFocus)
    this.active.set(roundId, active)
    try {
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

  private newRound(
    spec: EvolutionSpec,
    champion: ChampionState,
    population: PopulationState,
    source: RefinementRound['source'],
    batchId: string,
    roundId: string,
    roundIndex: number,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
  ): RefinementRound {
    const timestamp = now()
    const taskSampler = this.components.taskSampler(spec.rollout.taskSampler)
    const plan = taskSampler.resolve(roundId, spec.datasets, spec.rollout, spec.taskBudgetMs)
    const slots = this.components.candidateGenerator(spec.candidateGeneration.strategy)
      .plan(roundId, population.members.map(member => ({
        candidateId: member.candidateId,
        harnessRef: member.harnessRef,
        harnessDigest: member.harnessDigest,
        parentCandidateIds: [...member.parentCandidateIds],
        lineageRootId: member.lineageRootId,
        metrics: { ...member.metrics },
      })), spec.candidateGeneration.maxCandidates)
    if (slots.length !== spec.candidateGeneration.maxCandidates) throw new Error('candidate generator returned the wrong number of slots')
    const parentAllocations = slots.map(slot => {
      if (slot.parentCandidateIds.length !== 1) throw new Error('each candidate must have exactly one research parent')
      const parent = population.members.find(member => member.candidateId === slot.parentCandidateIds[0])
      if (parent === undefined || parent.harnessRef !== slot.parentHarnessRef) throw new Error('candidate generator returned an unknown parent')
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
      taskBudgetMs: spec.taskBudgetMs, promotionPolicy: { ...spec.promotion.policy.config },
      batchId, roundIndex, roundCount, plan,
      parentPopulationDigest: population.digest,
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
      let round = await this.transition(store, roundId, { status: 'baseline-running' })
      active.abort.signal.throwIfAborted()
      const population = await store.readPopulation()
      active.abort.signal.throwIfAborted()
      if (population === undefined || population.digest !== round.parentPopulationDigest) throw new Error('research population changed during round admission')
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
        const parent = population.members.find(member => member.candidateId === parentCandidateId)
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

      const rootCheckpoint = await meta.checkpoint()
      active.abort.signal.throwIfAborted()
      const parentCheckpoints = new Map<string, MetaCheckpointRef>()
      for (const member of population.members) parentCheckpoints.set(member.candidateId, member.metaCheckpoint ?? rootCheckpoint)
      const generationBudget = effectiveCandidateGenerationBudget(active.evolution.spec.candidateGeneration)
      const generationDeadline = Date.now() + generationBudget.roundTimeoutMs

      // Generate and seal every sibling before any candidate rollout. This keeps
      // proposal-time evidence independent of sibling evaluation order.
      for (const initialCandidate of round.candidatePool) {
        active.abort.signal.throwIfAborted()
        if (initialCandidate.sealedVersion !== undefined || initialCandidate.status !== 'generating') continue
        const candidateId = initialCandidate.candidateId
        const allocation = round.parentAllocations?.find(value => value.candidateId === candidateId)
        if (allocation === undefined) throw new Error(`candidate has no parent allocation: ${candidateId}`)
        const parentBaseline = parentBaselines.find(value => value.parentCandidateId === allocation.parentCandidateId)?.evidence
        const parentCheckpoint = parentCheckpoints.get(allocation.parentCandidateId)
        if (parentBaseline === undefined || parentCheckpoint === undefined) throw new Error('candidate parent state is incomplete')
        let generationComplete = false
        for (let attemptNumber = 1; attemptNumber <= generationBudget.maxAttemptsPerCandidate; attemptNumber += 1) {
          active.abort.signal.throwIfAborted()
          const startedAt = now()
          const previousCandidate = round.candidatePool.find(value => value.candidateId === candidateId)!
          const generationAttempts: CandidateGenerationAttempt[] = [
            ...(previousCandidate.generationAttempts ?? []),
            { attempt: attemptNumber, status: 'running', startedAt },
          ]
          round = await this.transition(store, roundId, {
            status: 'preparing-candidate',
            candidatePool: this.patchCandidate(round, candidateId, {
              status: 'generating', failure: undefined, workspaceId: undefined, metaSessionId: undefined,
              generationAttempts,
            }),
          })
          const remainingBeforeAttempt = generationDeadline - Date.now()
          if (remainingBeforeAttempt <= 0) {
            const timeout = new CandidateGenerationTimeoutError('round', generationBudget.roundTimeoutMs)
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
            signal: AbortSignal.any([active.abort.signal, executionAbort.signal]),
            finalization: finalizationResolvers(),
            finalizationSubmitted: false, baseline: parentBaseline,
          }
          active.executions.set(candidateId, execution)
          active.currentCandidateId = candidateId
          const timeoutScope = remainingBeforeAttempt <= generationBudget.attemptTimeoutMs ? 'round' : 'attempt'
          const timeoutBudgetMs = timeoutScope === 'round'
            ? generationBudget.roundTimeoutMs
            : generationBudget.attemptTimeoutMs
          const timeoutMs = Math.min(generationBudget.attemptTimeoutMs, remainingBeforeAttempt)
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
          const stopForRoundAbort = () => rejectAttempt(active.abort.signal.reason ?? new Error('refinement round aborted'))
          if (active.abort.signal.aborted) stopForRoundAbort()
          else active.abort.signal.addEventListener('abort', stopForRoundAbort, { once: true })
          void deadline.catch(() => {})
          let completedCheckpoint = false
          let shouldRetry = false
          try {
            const workspacePromise = this.workspaceManager.create({
              evolutionId: round.evolutionId,
              roundId,
              parentHarnessRef: allocation.parentHarnessRef,
              parentHarnessDigest: allocation.parentHarnessDigest,
            }, execution.signal)
            let workspace: CandidateWorkspaceHandle
            try {
              workspace = await Promise.race([workspacePromise, deadline])
            } catch (error) {
              void workspacePromise.then(lateWorkspace => this.workspaceManager.dispose(lateWorkspace.workspaceId)).catch(() => {})
              throw error
            }
            execution.workspace = workspace
            execution.signal.throwIfAborted()
            const forkPromise = meta.fork(parentCheckpoint)
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
                }),
              }),
            })
            execution.signal.throwIfAborted()
            const currentCandidate = round.candidatePool.find(value => value.candidateId === candidateId)!
            const wake = await Promise.race([meta.wakeCandidate(round, currentCandidate, parentBaseline, agent), deadline])
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
                ...(proposal.finalization === null ? {} : { proposal: proposal.finalization }),
                ...(proposal.decline === undefined ? {} : { decline: proposal.decline }),
                ...(proposal.diff === undefined ? {} : { diff: proposal.diff }),
                meta: proposal.meta, proposalEvidence: proposal.evidence, resultCheckpoint,
                generationAttempts: patchGenerationAttempt(completedAttempts, attemptNumber, {
                  status: 'succeeded', completedAt: now(),
                  ...(metaTurn === undefined ? {} : { metaTurn }),
                }),
                ...(proposal.finalization === null ? { status: 'discarded' as const } : {}),
              }),
            })
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
                  sealedVersion: {
                    commitOid: sealed.ref, treeOid: sealed.treeOid, manifestDigest: sealed.digest,
                    patchDigest: proposal.diff.patchDigest, immutableRef: sealed.immutableRef,
                  },
                }),
              })
            }
            generationComplete = true
          } catch (error) {
            active.abort.signal.throwIfAborted()
            // Close the attempt before persisting retry state so a late tool call
            // from the timed-out child cannot seal or submit the disposed workspace.
            execution.finalizationSubmitted = true
            execution.abort.abort(error instanceof Error ? error : new Error(errorMessage(error)))
            const phase = error instanceof SubstrateExpansionError
              ? 'rejected-for-substrate'
              : round.status === 'building-candidate' ? 'building-candidate' : 'candidate-generation'
            const failure = { phase, message: errorMessage(error) }
            shouldRetry = (error instanceof CandidateGenerationTimeoutError
              || error instanceof MetaTurnEndedWithoutProposalError)
              && !completedCheckpoint
              && attemptNumber < generationBudget.maxAttemptsPerCandidate
              && Date.now() < generationDeadline
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
            active.abort.signal.removeEventListener('abort', stopForRoundAbort)
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
            await this.cleanupExecution(active, execution, completedCheckpoint ? undefined : 'candidate generation stopped')
          }
          if (generationComplete || !shouldRetry) break
        }
      }
      active.abort.signal.throwIfAborted()
      delete active.currentCandidateId

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
          await this.transition(store, roundId, this.completeEvaluationRepairResume(active, round, {
            status: 'failed',
            failure: {
              phase: 'candidate-generation',
              message: failedGenerationCandidates
                .map(candidate => `${candidate.candidateId}: ${candidate.failure!.message}`)
                .join('; '),
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
      active.abort.signal.throwIfAborted()
      const finalist = round.candidatePool.find(value => value.candidateId === selection.promotionCandidateId)
      if (finalist?.sealedVersion === undefined || finalist.seedEvaluation === undefined) throw new Error('promotion finalist is not evaluable')
      this.assertParity(championBaseline, finalist.seedEvaluation, 'seed')
      const seedPairs = pairedTrials(championBaseline, finalist.seedEvaluation)
      const seedBaselineAggregate = pairedAggregate(seedPairs, 'baseline')
      const seedCandidateAggregate = pairedAggregate(seedPairs, 'candidate')
      let evaluation: RoundEvaluation = {
        ...round.evaluation,
        seedBaseline: championBaseline,
        seedCandidate: finalist.seedEvaluation,
        seedPairedTrials: seedPairs,
        seedPairing: pairingAudit(championBaseline, finalist.seedEvaluation, seedPairs),
        scoreDelta: seedCandidateAggregate.score - seedBaselineAggregate.score,
        requiredRegressions: seedPairs.length === 0 ? 0 : this.requiredRegressions(round, seedPairs),
      }
      round = await this.transition(store, roundId, { evaluation })
      active.abort.signal.throwIfAborted()
      let accepted = false
      if (this.passesSeed(round, evaluation)) {
        round = await this.transition(store, roundId, { status: 'held-out-running' })
        active.abort.signal.throwIfAborted()
        let heldOutBaseline = evaluation.heldOutBaseline
        if (heldOutBaseline === undefined) {
          const reusable = await this.findReusableBaseline(
            store, active.evolution.evaluator, round, round.targetHarnessRef, 'held-out', active.abort.signal,
          )
          if (reusable !== undefined) {
            active.abort.signal.throwIfAborted()
            round = await this.persistReusableHeldOutBaseline(
              store, round, championCandidateId, round.targetHarnessRef, reusable,
            )
            heldOutBaseline = reusable.evidence
          } else {
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
        let heldOutCandidate = evaluation.heldOutCandidate
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
      continueBatch = true
    } catch (error) {
      const round = await store.readRound(roundId)
      const pendingRepair = active.abort.signal.aborted && active.repairAttempt !== undefined
        ? round?.evaluationAttempts?.find(attempt => this.sameAttempt(attempt, active.repairAttempt!))
        : undefined
      if (round !== undefined && round.evaluationRepairResume !== undefined
        && active.repairAttempt !== undefined
        && this.sameAttempt(round.evaluationRepairResume, active.repairAttempt)
        && pendingRepair?.status === 'repair-completed'
        && this.attemptHasEvidence(round, pendingRepair)) return
      if (round !== undefined && !TERMINAL.has(round.status)) {
        if (round.commitIntent !== undefined) {
          await this.reconcileCommitIntent(store, round).catch(async recoveryError => store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'commit-recovery', message: errorMessage(recoveryError) },
          }).catch(() => {}))
        } else {
          await this.transition(store, roundId, {
            ...this.completeEvaluationRepairResume(active, round, {}),
            status: 'failed',
            failure: { phase: round.status, message: errorMessage(error) },
          }).catch(() => {})
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
    const evaluationIdentity = evaluator.evaluationIdentity === undefined
      ? undefined
      : await evaluator.evaluationIdentity(round, {
          phase: partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
          dataset,
          harnessRef,
          condition,
        }, signal)
    signal.throwIfAborted()
    if (evaluationIdentity === undefined) return undefined
    const previousRounds = (await store.listRounds())
      .filter(previous => previous.roundId !== round.roundId && TERMINAL.has(previous.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    for (const previous of previousRounds) {
      signal.throwIfAborted()
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
        if (evidence.completeness !== 'complete'
          || attempt?.status !== 'settled'
          || attempt.phase !== `${partition}-${attempt.owner.role}`
          || attempt.owner.harnessRef !== harnessRef
          || attempt.requestedModelId !== condition.model
          || evidence.provider !== evaluationIdentity.provider
          || evidence.conditionId !== condition.conditionId
          || evidence.dataset !== dataset
          || evidence.effectiveConfigDigest !== evaluationIdentity.effectiveConfigDigest
          || evidence.requestedCommit !== harnessRef
          || evidence.actualCommit !== harnessRef) continue
        return { evidence: structuredClone(evidence), sourceRoundId: previous.roundId }
      }
    }
    return undefined
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
          reusedFromRoundId: reusable.sourceRoundId,
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
          reusedFromRoundId: reusable.sourceRoundId,
        }]
      : current.evaluationAttempts
    return this.transition(store, current.roundId, {
      evaluation: { ...current.evaluation, heldOutBaseline: evidence },
      evaluationAttempts,
    })
  }

  private async queueContinuation(previous: ActiveRound): Promise<void> {
    const champion = await this.requireChampion(previous.evolution.store)
    const population = await previous.evolution.store.readPopulation()
    if (population === undefined) throw new Error('evolution has no research population')
    const roundId = crypto.randomUUID()
    const index = previous.roundIndex + 1
    const round = this.newRound(
      previous.evolution.spec, champion, population, previous.source, previous.batchId, roundId, index, previous.roundCount,
      previous.advisoryFocus,
    )
    const active = this.newActive(
      previous.evolution, previous.lock, previous.source, previous.batchId, index, previous.roundCount,
      previous.advisoryFocus,
    )
    await previous.evolution.store.writeRound(round)
    await previous.lock.retarget(roundId)
    await this.registry.touch(previous.evolution.spec.evolutionId, { batchId: previous.batchId, roundId })
    this.active.set(roundId, active)
    queueMicrotask(() => this.startDrive(roundId))
  }

  private startDrive(roundId: string): void {
    const drive = this.drive(roundId)
    const active = this.active.get(roundId)
    if (active !== undefined) active.drive = drive
    this.drives.add(drive)
    void drive.finally(() => this.drives.delete(drive))
  }

  private async runtime(evolutionId: string): Promise<EvolutionRuntime> {
    const existing = this.runtimes.get(evolutionId)
    if (existing !== undefined) { existing.lastUsedAt = Date.now(); return existing }
    await this.evictRuntimeIfNeeded()
    const spec = await this.registry.requireSpec(evolutionId)
    const specDigest = digestJson(spec)
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined || entry.specDigest !== specDigest) throw new Error(`evolution spec digest mismatch: ${evolutionId}`)
    const store = this.registry.stateStore(evolutionId)
    await store.initialize()
    this.resolveComponents(spec)
    const evaluator = this.components.hasRolloutProvider(spec.rollout.provider.id)
      ? this.components.rolloutProvider(spec.rollout.provider).createEvaluator(spec)
      : this.options.createEvaluator?.(spec) ?? this.evaluator
    await evaluator.preflight?.()
    const runtime = {
      spec,
      specDigest,
      store,
      meta: await this.createMetaSession(spec, specDigest, store),
      evaluator,
      lastUsedAt: Date.now(),
    }
    this.runtimes.set(evolutionId, runtime)
    return runtime
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
    if (!audit.summaryAccessed) throw new Error('finalization requires the current baseline summary')
    if (finalization === null && decline === undefined) throw new Error('decline rationale is required')
    const cited = finalization?.evidenceRefs ?? decline?.evidenceRefs ?? []
    if (finalization !== null && cited.length === 0) throw new Error('finalization must cite current baseline evidence')
    if (JSON.stringify(cited) !== JSON.stringify(audit.citedRefs)) throw new Error('finalization evidence audit does not match evidenceRefs')
    const allowed = new Set([
      baseline.evalId,
      ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...baseline.invalidTrials.map(trial => trial.runId),
    ])
    const accessed = new Set(audit.accessedRefs)
    for (const ref of cited) {
      if (!allowed.has(ref)) throw new Error(`finalization evidence ref is not from the current seed baseline: ${ref}`)
      if (!accessed.has(ref)) throw new Error(`finalization cites seed evidence that Meta did not access: ${ref}`)
    }
    const diagnosed = new Set(audit.diagnosedRunRefs)
    const missing = baseline.trials
      .filter(trial => (trialReward(trial) ?? 0) <= 0)
      .flatMap(trial => trial.runId === undefined || diagnosed.has(trial.runId) ? [] : [trial.runId])
    if (missing.length > 0) throw new Error(`finalization requires trajectory diagnostics for every failed baseline run: ${missing.join(', ')}`)
  }

  private nextPopulation(round: RefinementRound, previous: PopulationState, selectedIds: readonly string[]): PopulationState {
    const members: PopulationMember[] = selectedIds.map(candidateId => {
      const candidate = round.candidatePool.find(value => value.candidateId === candidateId)
      if (candidate?.sealedVersion === undefined || candidate.metrics === undefined
        || candidate.metaSessionId === undefined || candidate.resultCheckpoint === undefined) {
        throw new Error(`selected candidate is missing durable seed state: ${candidateId}`)
      }
      const parent = previous.members.find(value => value.candidateId === candidate.parentCandidateIds[0])
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
    if (cancelReason !== undefined && sessionId !== undefined) await meta.cancel(sessionId, cancelReason).catch(() => {})
    if (sessionId !== undefined && workspace !== undefined) {
      try { this.workspaceManager.unbind(sessionId, workspace.workspaceId) } catch {}
    }
    if (workspace !== undefined) await this.workspaceManager.drain(workspace.workspaceId).catch(() => {})
    if (sessionId !== undefined) await meta.release(sessionId).catch(() => {})
    if (workspace !== undefined) await this.workspaceManager.dispose(workspace.workspaceId).catch(() => {})
    active.executions.delete(execution.candidateId)
    if (active.currentCandidateId === execution.candidateId) delete active.currentCandidateId
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
    const reservation = await evaluator.reserve?.(round, request)
    active.abort.signal.throwIfAborted()
    let attempt: RoundEvaluationAttempt | undefined
    if (reservation !== undefined) {
      if (typeof reservation.provider !== 'string' || reservation.provider.length === 0
        || typeof reservation.evalId !== 'string' || reservation.evalId.length === 0) {
        throw new Error('evaluator returned an invalid evaluation reservation')
      }
      const current = await this.requireRound(store, round.roundId)
      if ((current.evaluationAttempts ?? []).some(value => value.provider === reservation.provider && value.evalId === reservation.evalId)) {
        throw new Error(`evaluation reservation was reused: ${reservation.provider}/${reservation.evalId}`)
      }
      attempt = {
        provider: reservation.provider,
        evalId: reservation.evalId,
        phase: request.phase,
        owner: { ...owner },
        conditionId: request.condition.conditionId,
        dataset: request.dataset,
        requestedModelId: request.condition.model,
        requestedCommit: request.harnessRef,
        status: 'running',
        startedAt: now(),
      }
      round = await this.transition(store, round.roundId, {
        evaluationAttempts: [...(current.evaluationAttempts ?? []), attempt],
      })
    }

    let evidence: EvaluationEvidence
    try {
      evidence = await evaluator.evaluate(round, request, active.abort.signal, reservation)
      if (reservation !== undefined
        && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
        throw new Error(`evaluation evidence does not match reservation: ${reservation.provider}/${reservation.evalId}`)
      }
    } catch (error) {
      if (attempt !== undefined) {
        const current = await this.requireRound(store, round.roundId)
        const status = active.abort.signal.aborted ? 'cancelled' as const : 'failed' as const
        await this.transition(store, round.roundId, {
          evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
            ? {
                ...value,
                status,
                completedAt: now(),
                failure: {
                  code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'evaluation_failed',
                  message: errorMessage(error),
                },
              }
            : value),
        })
      }
      throw error
    }

    let patch: Partial<RefinementRound>
    try {
      patch = await settledPatch(round, evidence)
      active.abort.signal.throwIfAborted()
    } catch (error) {
      if (attempt !== undefined) {
        const current = await this.requireRound(store, round.roundId)
        await this.transition(store, round.roundId, {
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
      ...(evaluationAttempts === undefined ? {} : { evaluationAttempts }),
    })
    return { round, evidence }
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
    this.components.candidateGenerator(spec.candidateGeneration.strategy)
    this.components.taskSampler(spec.rollout.taskSampler)
    this.components.assessor(spec.selection.assessor)
    this.components.selector(spec.selection.strategy)
    this.components.promotionPolicy(spec.promotion.policy)
    if (this.components.hasRolloutProvider(spec.rollout.provider.id)) {
      this.components.rolloutProvider(spec.rollout.provider)
    } else if (this.options.createEvaluator === undefined && spec.rollout.provider.id !== 'hitch-cli') {
      throw new Error(`unsupported rollout provider: ${spec.rollout.provider.id}`)
    }
    for (const judge of spec.evaluation.judges) this.components.judge(judge)
    if (spec.rollout.seeds !== undefined) throw new Error('current Hitch adapter does not support typed rollout seeds')
    if (spec.rollout.sampling.temperature !== undefined) {
      throw new Error('current Hitch adapter does not support typed rollout temperature')
    }
    if (spec.candidateGeneration.budget.maxModelRequests !== undefined
      || spec.candidateGeneration.budget.maxTokens !== undefined) {
      throw new Error('current Meta harness adapter does not expose aggregate proposal usage; maxModelRequests and maxTokens are unsupported')
    }
  }

  private assertAvailable(): void { if (this.disposed) throw new Error('RefineService is disposed') }
}
