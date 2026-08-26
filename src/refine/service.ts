import type { CandidateWorkspaceHandle, CandidateWorkspaceManager } from '../candidate/workspace.js'
import { ComponentRegistry } from '../evolution/components.js'
import type { HarnessBuilder } from '../harness/builder.js'
import { SubstrateExpansionError } from '../harness/builder.js'
import type { MetaSessionManager } from '../meta/session.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson, type EvolutionRegistryStore } from '../state/evolution.js'
import type { RefineStateStore, WorkspaceLock } from '../state/store.js'
import type {
  AdmissionResult, CandidateDecline, CandidateDiffSummary, CandidateFinalization, CandidateRecord, ChampionState,
  CandidateGenerationSpec, ComponentRef, DshMetaAgentSpec, EvaluationEvidence, EvaluationRequest, EvaluationRerunResult, EvaluationRerunSelector, EvolutionRegistryEntry, EvolutionSpec, MetaAttribution,
  MetaCheckpointRef, PairedTrial, PopulationState, ProposalEvidenceAudit, PromotionPolicy, PublicSeedEvidence, PublicRoundStatus,
  RefineEvaluator, RefinementRound, RolloutSpec, RoundEvaluation, RoundEvaluationAttempt, SemanticTarget, PopulationMember,
} from '../types.js'
import { isExactGitCommit } from '../types.js'

export interface RefineServiceOptions {
  workspaceRoot: string
  metaAgent: DshMetaAgentSpec
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
) => MetaSessionManager | Promise<MetaSessionManager>

interface EvolutionRuntime {
  spec: EvolutionSpec
  specDigest: string
  store: RefineStateStore
  meta: MetaSessionManager
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
  drive?: Promise<void>
}

const TERMINAL = new Set<RefinementRound['status']>(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])
function now(): string { return new Date().toISOString() }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

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

function taskRewards(evidence: EvaluationEvidence): Map<string, number> {
  const grouped = new Map<string, number[]>()
  for (const trial of evidence.trials) {
    const reward = trial.rewards.reward ?? Object.values(trial.rewards)[0]
    if (reward === undefined) continue
    const values = grouped.get(trial.taskName) ?? []
    values.push(reward)
    grouped.set(trial.taskName, values)
  }
  return new Map([...grouped].map(([task, values]) => [task, values.reduce((sum, value) => sum + value, 0) / values.length]))
}

function trialReward(trial: EvaluationEvidence['trials'][number]): number | undefined {
  return trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

function publicSeedEvidence(evidence: EvaluationEvidence): PublicSeedEvidence {
  return {
    evalId: evidence.evalId,
    primaryReward: evidence.primaryReward,
    summary: evidence.summary,
    trials: evidence.trials.map(trial => {
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
  }
}

function pairedTrials(baseline: EvaluationEvidence, candidate: EvaluationEvidence): PairedTrial[] {
  const index = new Map<string, EvaluationEvidence['trials'][number]>()
  const key = (trial: EvaluationEvidence['trials'][number]): string => JSON.stringify([
    trial.taskName, trial.attempt ?? null,
  ])
  for (const trial of baseline.trials) {
    const trialKey = key(trial)
    if (index.has(trialKey)) throw new Error(`baseline has ambiguous duplicate trial identity: ${trialKey}`)
    index.set(trialKey, trial)
  }
  const result: PairedTrial[] = []
  for (const trial of candidate.trials) {
    const trialKey = key(trial)
    const before = index.get(trialKey)
    if (before === undefined) throw new Error(`candidate trial has no paired baseline identity: ${trialKey}`)
    index.delete(trialKey)
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
  if (index.size > 0) throw new Error(`candidate is missing ${index.size} paired baseline trial(s)`)
  return result.sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

export class RefineService {
  private readonly active = new Map<string, ActiveRound>()
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
    await this.registry.initialize()
    await this.workspaceManager.initialize()
    for (const entry of await this.registry.list()) {
      const store = this.registry.stateStore(entry.evolutionId)
      await store.initialize()
      for (const round of await store.listRounds()) {
        for (const candidate of round.candidatePool) {
          if (candidate.sealedVersion !== undefined) await this.builder.verifySealedCandidate(candidate.sealedVersion)
        }
        if (round.commitIntent !== undefined
          && (round.status !== round.commitIntent.decision || round.commitIntent.phase !== 'champion-committed')) {
          await this.reconcileCommitIntent(store, round).catch(async error => store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'recovery', message: errorMessage(error) },
          }))
        } else if (!TERMINAL.has(round.status)) {
          await store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'recovery', message: 'control plane restarted before the round reached a durable commit intent' },
          })
        }
      }
      await this.workspaceManager.recoverOrphans(entry.evolutionId)
    }
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
    const live = this.active.get(roundId)
    if (live !== undefined) {
      const persisted = await live.evolution.store.readRound(roundId)
      if (persisted === undefined || !TERMINAL.has(persisted.status)) {
        throw new Error(`refinement round is already active: ${roundId}`)
      }
      await live.drive
      if (this.active.has(roundId)) throw new Error(`refinement round is already active: ${roundId}`)
    }
    const evolution = await this.runtime(evolutionId)
    const lock = await evolution.store.acquireRoundLock(roundId)
    let handedToDrive = false
    let attempt: RoundEvaluationAttempt | undefined
    try {
      let round = await this.requireRound(evolution.store, roundId)
      if (round.evolutionId !== evolutionId || round.status !== 'failed') {
        throw new Error(`round ${roundId} is not a failed evaluation round`)
      }
      attempt = round.evaluationAttempts?.find(value => value.evalId === evalId && value.provider === 'hitch-cli')
      if (attempt === undefined) throw new Error(`round ${roundId} does not own Hitch eval ${evalId}`)
      if (attempt.status !== 'failed') throw new Error(`Hitch eval ${evalId} is not failed`)
      if (evolution.evaluator.rerun === undefined) throw new Error('configured evaluator does not support task rerun')
      const request = this.evaluationRequest(round, attempt)
      round = await this.transition(evolution.store, roundId, {
        status: 'repairing-evaluation',
        failure: undefined,
        evaluationAttempts: (round.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
          ? (() => {
              const { completedAt: _completedAt, failure: _failure, ...owned } = value
              return { ...owned, status: 'rerunning' as const }
            })()
          : value),
      })
      let result: EvaluationRerunResult
      try {
        result = await evolution.evaluator.rerun(round, request, attempt, selector, new AbortController().signal)
      } catch (error) {
        const current = await this.requireRound(evolution.store, roundId)
        await this.transition(evolution.store, roundId, {
          status: 'failed',
          failure: { phase: 'repairing-evaluation', message: errorMessage(error) },
          evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
            ? {
                ...value, status: 'failed' as const, completedAt: now(),
                failure: {
                  code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'evaluation_rerun_failed',
                  message: errorMessage(error),
                },
              }
            : value),
        })
        throw error
      }
      if (result.provider !== attempt.provider || result.evalId !== attempt.evalId) {
        throw new Error('evaluation rerun result does not match Gear ownership')
      }
      if (result.evalStatus !== 'succeeded' || result.evidence === undefined) {
        const current = await this.requireRound(evolution.store, roundId)
        const message = result.remainingInvalidTasks.length === 0
          ? 'evaluation rerun did not produce complete evidence'
          : `evaluation still has invalid tasks: ${result.remainingInvalidTasks.join(', ')}`
        await this.transition(evolution.store, roundId, {
          status: 'failed',
          failure: { phase: 'repairing-evaluation', message },
          evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
            ? { ...value, status: 'failed' as const, completedAt: now(), failure: { code: 'evaluation_has_invalid_tasks', message } }
            : value),
        })
        return result
      }
      this.assertRepairedEvidence(attempt, result.evidence)
      const current = await this.requireRound(evolution.store, roundId)
      const evidencePatch = await this.repairedEvidencePatch(current, attempt, result.evidence, evolution.spec)
      round = await this.transition(evolution.store, roundId, {
        ...evidencePatch,
        status: 'repairing-evaluation',
        failure: undefined,
        evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
          ? (() => {
              const { failure: _failure, ...owned } = value
              return { ...owned, status: 'settled' as const, completedAt: now() }
            })()
          : value),
      })
      const active = this.newActive(
        evolution, lock, round.source, round.batchId, round.roundIndex, round.roundCount, round.advisoryFocus,
      )
      this.active.set(roundId, active)
      handedToDrive = true
      queueMicrotask(() => this.startDrive(roundId))
      return result
    } catch (error) {
      if (attempt !== undefined && !handedToDrive) {
        const current = await evolution.store.readRound(roundId).catch(() => undefined)
        if (current?.status === 'repairing-evaluation') {
          await evolution.store.writeRound({
            ...current,
            status: 'failed',
            updatedAt: now(),
            failure: { phase: 'repairing-evaluation', message: errorMessage(error) },
            evaluationAttempts: (current.evaluationAttempts ?? []).map(value => value.provider === attempt!.provider && value.evalId === attempt!.evalId
              ? {
                  ...value, status: 'failed' as const, completedAt: now(),
                  failure: {
                    code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'evaluation_rerun_failed',
                    message: errorMessage(error),
                  },
                }
              : value),
          }).catch(() => {})
        }
      }
      throw error
    } finally {
      if (!handedToDrive) await lock.release().catch(() => {})
    }
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
      diff = await this.workspaceManager.seal(execution.workspace.workspaceId, execution.abort.signal)
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
    const evolution = await this.runtime(evolutionId)
    const round = roundId === undefined
      ? (await evolution.store.listRounds()).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
      : await evolution.store.readRound(roundId)
    if (round === undefined) throw new Error(`evolution has no matching refinement round: ${evolutionId}`)
    return {
      evolutionId, batchId: round.batchId, roundId: round.roundId, status: round.status,
      ...(round.decision === undefined ? {} : { decision: round.decision }),
      ...(round.evaluation?.seedCandidate !== undefined
        ? { seedSummary: round.evaluation.seedCandidate.summary }
        : round.baseline === undefined ? {} : { seedSummary: round.baseline.summary }),
      ...(round.baseline === undefined ? {} : { seedBaseline: publicSeedEvidence(round.baseline) }),
      ...(round.evaluation?.seedCandidate === undefined ? {} : { seedCandidate: publicSeedEvidence(round.evaluation.seedCandidate) }),
      ...(round.failure === undefined ? {} : { failure: round.failure.phase }),
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

  activeEntry(roundId: string): { evolutionId: string; store: RefineStateStore; meta: MetaSessionManager; workspace?: CandidateWorkspaceHandle } | undefined {
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
    meta: MetaSessionManager
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
    for (const active of this.active.values()) {
      const error = new Error('RefineService disposed')
      active.abort.abort(error)
      for (const execution of active.executions.values()) {
        execution.abort.abort(error)
        execution.finalization.reject(error)
      }
    }
    await Promise.allSettled([...this.drives])
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
      let round = await this.transition(store, roundId, { status: 'baseline-running' })
      const population = await store.readPopulation()
      if (population === undefined || population.digest !== round.parentPopulationDigest) throw new Error('research population changed during round admission')
      const championCandidateId = round.parentAllocations?.find(allocation => allocation.parentHarnessRef === round.targetHarnessRef)?.parentCandidateId
        ?? `champion-${round.targetHarnessRef}`
      let championBaseline = round.baseline
        ?? round.parentBaselines?.find(value => value.parentCandidateId === championCandidateId)?.evidence
      if (championBaseline === undefined) {
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
      let parentBaselines = round.parentBaselines ?? []
      const allocatedParentIds = [...new Set((round.parentAllocations ?? []).map(allocation => allocation.parentCandidateId))]
      for (const parentCandidateId of allocatedParentIds) {
        const parent = population.members.find(member => member.candidateId === parentCandidateId)
        if (parent === undefined) throw new Error(`allocated research parent is unavailable: ${parentCandidateId}`)
        if (parentBaselines.some(value => value.parentCandidateId === parent.candidateId)) continue
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
        parentBaselines = round.parentBaselines ?? []
      }
      round = await this.transition(store, roundId, {
        status: 'preparing-candidate',
      })

      const rootCheckpoint = await meta.checkpoint()
      const parentCheckpoints = new Map<string, MetaCheckpointRef>()
      for (const member of population.members) parentCheckpoints.set(member.candidateId, member.metaCheckpoint ?? rootCheckpoint)
      const generationBudgetMs = active.evolution.spec.candidateGeneration.budget.timeoutMs
      const generationDeadline = Date.now() + generationBudgetMs

      // Generate and seal every sibling before any candidate rollout. This keeps
      // proposal-time evidence independent of sibling evaluation order.
      for (const initialCandidate of round.candidatePool) {
        if (initialCandidate.sealedVersion !== undefined || initialCandidate.status !== 'generating') continue
        const candidateId = initialCandidate.candidateId
        const allocation = round.parentAllocations?.find(value => value.candidateId === candidateId)
        if (allocation === undefined) throw new Error(`candidate has no parent allocation: ${candidateId}`)
        const parentBaseline = parentBaselines.find(value => value.parentCandidateId === allocation.parentCandidateId)?.evidence
        const parentCheckpoint = parentCheckpoints.get(allocation.parentCandidateId)
        if (parentBaseline === undefined || parentCheckpoint === undefined) throw new Error('candidate parent state is incomplete')
        const execution: CandidateExecution = {
          candidateId, abort: new AbortController(), finalization: finalizationResolvers(),
          finalizationSubmitted: false, baseline: parentBaseline,
        }
        active.executions.set(candidateId, execution)
        active.currentCandidateId = candidateId
        let completedCheckpoint = false
        try {
          const workspace = await this.workspaceManager.create({
            evolutionId: round.evolutionId,
            roundId,
            parentHarnessRef: allocation.parentHarnessRef,
            parentHarnessDigest: allocation.parentHarnessDigest,
          }, execution.abort.signal)
          execution.workspace = workspace
          const agent = await meta.fork(parentCheckpoint)
          execution.metaSessionId = String(agent.id)
          this.workspaceManager.bind(workspace.workspaceId, execution.metaSessionId)
          round = await this.transition(store, roundId, {
            status: 'candidate-editing',
            candidatePool: this.patchCandidate(round, candidateId, {
              workspaceId: workspace.workspaceId,
              metaSessionId: execution.metaSessionId,
              parentCheckpoint,
            }),
          })
          const currentCandidate = round.candidatePool.find(value => value.candidateId === candidateId)!
          await meta.wakeCandidate(round, currentCandidate, parentBaseline, agent)
          const timeoutMs = Math.max(0, generationDeadline - Date.now())
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`candidate generation exceeded its ${generationBudgetMs}ms round budget`)), timeoutMs)
          })
          let proposal: FinalizationValue
          try { proposal = await Promise.race([execution.finalization.promise, timeout]) }
          finally { if (timer !== undefined) clearTimeout(timer) }
          const resultCheckpoint = await meta.checkpoint(execution.metaSessionId)
          completedCheckpoint = true
          round = await this.transition(store, roundId, {
            candidatePool: this.patchCandidate(round, candidateId, {
              ...(proposal.finalization === null ? {} : { proposal: proposal.finalization }),
              ...(proposal.decline === undefined ? {} : { decline: proposal.decline }),
              ...(proposal.diff === undefined ? {} : { diff: proposal.diff }),
              meta: proposal.meta, proposalEvidence: proposal.evidence, resultCheckpoint,
              ...(proposal.finalization === null ? { status: 'discarded' as const } : {}),
            }),
          })
          if (proposal.finalization === null || proposal.diff === undefined) continue
          round = await this.transition(store, roundId, { status: 'building-candidate' })
          this.workspaceManager.markFinalizing(workspace.workspaceId)
          const verifiedDiff = await this.workspaceManager.verifySealed(workspace.workspaceId, proposal.diff, execution.abort.signal)
          const sealed = await this.builder.finalizeWorkspace(workspace, verifiedDiff, execution.abort.signal)
          await this.workspaceManager.markCommitted(workspace.workspaceId)
          round = await this.transition(store, roundId, {
            candidatePool: this.patchCandidate(round, candidateId, {
              sealedVersion: {
                commitOid: sealed.ref, treeOid: sealed.treeOid, manifestDigest: sealed.digest,
                patchDigest: proposal.diff.patchDigest, immutableRef: sealed.immutableRef,
              },
            }),
          })
        } catch (error) {
          round = await this.transition(store, roundId, {
            candidatePool: this.patchCandidate(round, candidateId, {
              status: 'failed',
              failure: { phase: error instanceof SubstrateExpansionError ? 'building-candidate' : 'candidate-generation', message: errorMessage(error) },
            }),
          })
        } finally {
          await this.cleanupExecution(active, execution, completedCheckpoint ? undefined : 'candidate generation stopped')
        }
      }
      delete active.currentCandidateId

      round = await this.transition(store, roundId, { status: 'candidate-seed-running' })
      for (const candidate of round.candidatePool.filter(value => value.sealedVersion !== undefined && value.status !== 'failed')) {
        const parentBaseline = parentBaselines.find(value => value.parentCandidateId === candidate.parentCandidateIds[0])?.evidence
        if (parentBaseline === undefined || candidate.sealedVersion === undefined) throw new Error('candidate seed baseline is unavailable')
        if (candidate.seedEvaluation !== undefined) {
          this.assertParity(parentBaseline, candidate.seedEvaluation, 'seed')
          if (candidate.seedComparison === undefined || candidate.metrics === undefined || candidate.status !== 'ready') {
            const comparison = {
              parentBaselineEvalId: parentBaseline.evalId,
              pairedTrials: pairedTrials(parentBaseline, candidate.seedEvaluation),
              scoreDelta: candidate.seedEvaluation.primaryReward - parentBaseline.primaryReward,
              requiredRegressions: this.requiredRegressions(round, parentBaseline, candidate.seedEvaluation),
            }
            round = await this.transition(store, roundId, {
              candidatePool: this.patchCandidate(round, candidate.candidateId, {
                seedComparison: comparison,
                metrics: await this.evaluateJudges(active.evolution.spec, candidate.seedEvaluation),
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
            const comparison = {
              parentBaselineEvalId: parentBaseline.evalId,
              pairedTrials: pairedTrials(parentBaseline, seedCandidate),
              scoreDelta: seedCandidate.primaryReward - parentBaseline.primaryReward,
              requiredRegressions: this.requiredRegressions(current, parentBaseline, seedCandidate),
            }
            return {
              candidatePool: this.patchCandidate(current, candidate.candidateId, {
                seedEvaluation: seedCandidate,
                seedComparison: comparison,
                metrics: await this.evaluateJudges(active.evolution.spec, seedCandidate),
                status: 'ready',
              }),
            }
          })
          round = evaluated.round
        } catch (error) {
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
            seedEvaluation: candidate.seedEvaluation, seedComparison: candidate.seedComparison, metrics: candidate.metrics,
          }]
        : [])
      if (selectable.length < active.evolution.spec.selection.survivors) {
        await this.transition(store, roundId, {
          status: 'rejected', decision: 'no-change',
          failure: { phase: 'selection', message: `only ${selectable.length} candidates were evaluable` },
        })
        continueBatch = true
        return
      }
      const selection = this.components.selector(active.evolution.spec.selection.strategy)
        .select(selectable, active.evolution.spec.selection.survivors)
      if (!selection.selectedCandidateIds.includes(selection.promotionCandidateId)) throw new Error('promotion finalist must be a survivor')
      round = await this.transition(store, roundId, {
        selection, promotionCandidateId: selection.promotionCandidateId,
        candidatePool: round.candidatePool.map(candidate => selection.selectedCandidateIds.includes(candidate.candidateId)
          ? { ...candidate, status: 'selected' as const }
          : candidate.status === 'ready' ? { ...candidate, status: 'discarded' as const } : candidate),
      })
      const finalist = round.candidatePool.find(value => value.candidateId === selection.promotionCandidateId)
      if (finalist?.sealedVersion === undefined || finalist.seedEvaluation === undefined) throw new Error('promotion finalist is not evaluable')
      let evaluation: RoundEvaluation = {
        ...round.evaluation,
        seedBaseline: championBaseline,
        seedCandidate: finalist.seedEvaluation,
        seedPairedTrials: pairedTrials(championBaseline, finalist.seedEvaluation),
        scoreDelta: finalist.seedEvaluation.primaryReward - championBaseline.primaryReward,
        requiredRegressions: this.requiredRegressions(round, championBaseline, finalist.seedEvaluation),
      }
      round = await this.transition(store, roundId, { evaluation })
      let accepted = false
      if (this.passesSeed(round, evaluation)) {
        round = await this.transition(store, roundId, { status: 'held-out-running' })
        let heldOutBaseline = evaluation.heldOutBaseline
        if (heldOutBaseline === undefined) {
          const baselineEvaluation = await this.evaluateWithAttempt(active, round, {
            phase: 'held-out-baseline', dataset: round.heldOutRef, harnessRef: round.targetHarnessRef,
            condition: round.plan.heldOut,
          }, {
            candidateId: championCandidateId, role: 'baseline', harnessRef: round.targetHarnessRef,
          }, (current, evidence) => ({ evaluation: { ...current.evaluation!, heldOutBaseline: evidence } }))
          round = baselineEvaluation.round
          heldOutBaseline = baselineEvaluation.evidence
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
            const completeEvaluation = {
              ...evaluation, heldOutBaseline, heldOutCandidate: evidence,
              heldOutPairedTrials: pairedTrials(heldOutBaseline, evidence),
              promotionMetrics: await this.evaluateJudges(active.evolution.spec, evidence),
              heldOutScoreDelta: evidence.primaryReward - heldOutBaseline.primaryReward,
              requiredRegressions: evaluation.requiredRegressions + this.requiredRegressions(current, heldOutBaseline, evidence),
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
          evaluation = {
            ...evaluation, heldOutBaseline, heldOutCandidate,
            heldOutPairedTrials: pairedTrials(heldOutBaseline, heldOutCandidate),
            promotionMetrics: await this.evaluateJudges(active.evolution.spec, heldOutCandidate),
            heldOutScoreDelta: heldOutCandidate.primaryReward - heldOutBaseline.primaryReward,
            requiredRegressions: evaluation.requiredRegressions + this.requiredRegressions(round, heldOutBaseline, heldOutCandidate),
          }
          round = await this.transition(store, roundId, {
            evaluation,
            candidatePool: this.patchCandidate(round, finalist.candidateId, { heldOutEvaluation: heldOutCandidate }),
          })
        }
        accepted = this.passesHeldOut(round, evaluation, active.evolution.spec)
      }

      const nextPopulation = this.nextPopulation(round, population, selection.selectedCandidateIds)
      const nextChampion = accepted ? {
        schemaVersion: 2 as const,
        ref: finalist.sealedVersion.commitOid,
        manifestDigest: finalist.sealedVersion.manifestDigest,
        updatedAt: now(), roundId,
      } : undefined
      round = await this.transition(store, roundId, {
        status: 'promoting',
        commitIntent: {
          expectedPopulationDigest: population.digest, nextPopulation,
          expectedChampionRef: round.targetHarnessRef,
          ...(nextChampion === undefined ? {} : { nextChampion }),
          decision: accepted ? 'accepted' : 'rejected',
          promotionCandidateId: finalist.candidateId,
          phase: 'prepared',
        },
      })
      await store.compareAndSwapPopulation(population.digest, nextPopulation)
      round = await this.transition(store, roundId, {
        commitIntent: { ...round.commitIntent!, phase: 'population-committed' },
      })
      if (nextChampion !== undefined) await store.compareAndSwapChampion(round.targetHarnessRef, nextChampion)
      round = await this.transition(store, roundId, {
        commitIntent: { ...round.commitIntent!, phase: 'champion-committed' },
      })
      await this.transition(store, roundId, accepted
        ? { status: 'accepted', decision: 'accepted', promotedCandidateId: finalist.candidateId }
        : { status: 'rejected', decision: 'rejected' })
      continueBatch = true
    } catch (error) {
      const round = await store.readRound(roundId)
      if (round !== undefined && !TERMINAL.has(round.status)) {
        if (round.commitIntent !== undefined) {
          await this.reconcileCommitIntent(store, round).catch(async recoveryError => store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'commit-recovery', message: errorMessage(recoveryError) },
          }).catch(() => {}))
        } else {
          await store.writeRound({
            ...round, status: 'failed', updatedAt: now(), failure: { phase: round.status, message: errorMessage(error) },
          }).catch(() => {})
        }
      }
    } finally {
      for (const execution of active.executions.values()) await this.cleanupExecution(active, execution, 'round stopped').catch(() => {})
      this.active.delete(roundId)
      if (continueBatch && active.roundIndex < active.roundCount && !this.disposed) {
        try { await this.queueContinuation(active); return } catch (error) {
          const round = await store.readRound(roundId)
          if (round !== undefined) await store.writeRound({
            ...round, updatedAt: now(), failure: { phase: 'batch-continuation', message: errorMessage(error) },
          }).catch(() => {})
        }
      }
      await active.lock.release().catch(() => {})
    }
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
    const runtime = {
      spec,
      specDigest,
      store,
      meta: await this.createMetaSession(spec, specDigest, store),
      evaluator: this.components.hasRolloutProvider(spec.rollout.provider.id)
        ? this.components.rolloutProvider(spec.rollout.provider).createEvaluator(spec)
        : this.options.createEvaluator?.(spec) ?? this.evaluator,
      lastUsedAt: Date.now(),
    }
    this.runtimes.set(evolutionId, runtime)
    return runtime
  }

  private async evictRuntimeIfNeeded(): Promise<void> {
    if (this.runtimes.size < this.options.maxLiveMetaSessions) return
    const activeEvolutionIds = new Set([...this.active.values()].map(value => value.evolution.spec.evolutionId))
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
    return evaluation.seedCandidate.primaryReward >= promotion.minimumCandidateScore
      && evaluation.scoreDelta >= promotion.minimumAbsoluteGain
      && evaluation.requiredRegressions <= promotion.maxRequiredRegressions
      && (!promotion.requireNoRegression || evaluation.seedCandidate.summary.passed >= evaluation.seedBaseline.summary.passed)
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

  private requiredRegressions(round: RefinementRound, baseline: EvaluationEvidence, candidate: EvaluationEvidence): number {
    const required = round.promotionPolicy.requiredTaskIds ?? []
    const before = taskRewards(baseline)
    const after = taskRewards(candidate)
    let regressions = 0
    for (const task of required) {
      const left = before.get(task)
      const right = after.get(task)
      if (left === undefined || right === undefined) throw new Error(`required task is missing from Hitch eval result: ${task}`)
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
    if (baseline.invocationFingerprint !== undefined || candidate.invocationFingerprint !== undefined) {
      if (baseline.invocationFingerprint !== candidate.invocationFingerprint) {
        throw new Error(`${partition} baseline/candidate provider invocation parity mismatch`)
      }
    }
    if (baseline.dataset !== candidate.dataset) throw new Error(`${partition} baseline/candidate dataset mismatch`)
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
    const allowed = new Set([baseline.evalId, ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId])])
    const accessed = new Set(audit.accessedRefs)
    for (const ref of cited) {
      if (!allowed.has(ref)) throw new Error(`finalization evidence ref is not from the current seed baseline: ${ref}`)
      if (!accessed.has(ref)) throw new Error(`finalization cites seed evidence that Meta did not access: ${ref}`)
    }
    const diagnosed = new Set(audit.diagnosedRunRefs)
    const missing = baseline.trials
      .filter(trial => trial.status === 'errored' || (trialReward(trial) ?? 0) <= 0)
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
    const reservation = await evaluator.reserve?.(round, request)
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
    const evaluation = {
      ...round.evaluation,
      heldOutCandidate: evidence,
      heldOutPairedTrials: pairedTrials(heldOutBaseline, evidence),
      promotionMetrics: await this.evaluateJudges(spec, evidence),
      heldOutScoreDelta: evidence.primaryReward - heldOutBaseline.primaryReward,
      requiredRegressions: round.evaluation.requiredRegressions + this.requiredRegressions(round, heldOutBaseline, evidence),
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
      throw new Error('current DSH runtime does not expose aggregate proposal usage; maxModelRequests and maxTokens are unsupported')
    }
  }

  private assertAvailable(): void { if (this.disposed) throw new Error('RefineService is disposed') }
}
