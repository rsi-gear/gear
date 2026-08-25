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
  CandidateGenerationSpec, ComponentRef, DshMetaAgentSpec, EvaluationEvidence, EvolutionRegistryEntry, EvolutionSpec, MetaAttribution,
  PairedTrial, ProposalEvidenceAudit, PromotionPolicy, PublicSeedEvidence, PublicRoundStatus,
  RefineEvaluator, RefinementRound, RolloutSpec, RoundEvaluation, SemanticTarget,
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

interface ActiveRound {
  evolution: EvolutionRuntime
  lock: WorkspaceLock
  abort: AbortController
  finalization: PromiseWithResolvers<FinalizationValue>
  finalizationSubmitted: boolean
  batchId: string
  roundIndex: number
  roundCount: number
  advisoryFocus?: SemanticTarget[]
  source: RefinementRound['source']
  candidateId: string
  workspace?: CandidateWorkspaceHandle
  metaSessionId?: string
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
        if (!TERMINAL.has(round.status)) {
          await store.writeRound({
            ...round, status: 'failed', updatedAt: now(),
            failure: { phase: 'recovery', message: 'control plane restarted before the round reached a durable terminal state' },
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
    const round = await this.requireRound(active.evolution.store, roundId)
    if (round.status !== 'candidate-editing') throw new Error(`round ${roundId} is not accepting a finalization`)
    if (active.finalizationSubmitted) throw new Error(`round ${roundId} already received a finalization`)
    const persistedMeta = await active.evolution.store.readMeta()
    if (persistedMeta?.sessionId !== meta.sessionId || meta.evolutionId !== evolutionId) {
      throw new Error('finalization Meta session does not own this evolution workspace')
    }
    this.validateFinalizationEvidence(round, finalization, decline, evidence)
    let diff: CandidateDiffSummary | undefined
    if (finalization !== null) {
      if (active.workspace === undefined) throw new Error('round has no candidate workspace')
      diff = await this.workspaceManager.seal(active.workspace.workspaceId, active.abort.signal)
      if (diff.files.length === 0) throw new Error('candidate has no changes; use decline_candidate')
    }
    active.finalizationSubmitted = true
    active.finalization.resolve({
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
    return active === undefined ? undefined : {
      evolutionId: active.evolution.spec.evolutionId, store: active.evolution.store, meta: active.evolution.meta,
      ...(active.workspace === undefined ? {} : { workspace: active.workspace }),
    }
  }

  activeEntryForSession(sessionId: string): {
    evolutionId: string
    spec: EvolutionSpec
    roundId: string
    store: RefineStateStore
    meta: MetaSessionManager
    workspace: CandidateWorkspaceHandle
  } | undefined {
    for (const [roundId, active] of this.active) {
      if (active.metaSessionId !== sessionId || active.workspace === undefined) continue
      return {
        evolutionId: active.evolution.spec.evolutionId,
        spec: active.evolution.spec,
        roundId,
        store: active.evolution.store,
        meta: active.evolution.meta,
        workspace: active.workspace,
      }
    }
    return undefined
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const active of this.active.values()) {
      const error = new Error('RefineService disposed')
      active.abort.abort(error)
      active.finalization.reject(error)
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
    const parentCandidateIds = population?.members.filter(member => member.harnessRef === champion.ref).map(member => member.candidateId) ?? []
    const round = this.newRound(
      evolution.spec, champion, source, batchId, roundId, 1, roundCount, parentCandidateIds, advisoryFocus,
    )
    const active = this.newActive(evolution, lock, source, batchId, 1, roundCount, round.candidatePool[0]!.candidateId, advisoryFocus)
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
    source: RefinementRound['source'],
    batchId: string,
    roundId: string,
    roundIndex: number,
    roundCount: number,
    parentCandidateIds: string[],
    advisoryFocus?: SemanticTarget[],
  ): RefinementRound {
    const timestamp = now()
    const taskSampler = this.components.taskSampler(spec.rollout.taskSampler)
    const plan = taskSampler.resolve(roundId, spec.datasets, spec.rollout, spec.taskBudgetMs)
    const slots = this.components.candidateGenerator(spec.candidateGeneration.strategy)
      .plan(roundId, champion.ref, spec.candidateGeneration.maxCandidates)
    if (slots.length !== 1) {
      throw new Error('current DSH runtime cannot fork a durable Meta session; candidateGeneration.maxCandidates must be 1')
    }
    return {
      evolutionId: spec.evolutionId, roundId, workspaceRoot: this.options.workspaceRoot,
      status: 'queued', source, createdAt: timestamp, updatedAt: timestamp,
      metaHarnessRef: spec.metaAgent.preset.id, targetHarnessRef: champion.ref, targetHarnessDigest: champion.manifestDigest,
      sandboxProfileRef: spec.sandboxProfileRef, seedTaskRef: spec.datasets.seed.ref, heldOutRef: spec.datasets.heldOut.ref,
      taskBudgetMs: spec.taskBudgetMs, promotionPolicy: { ...spec.promotion.policy.config },
      batchId, roundIndex, roundCount, plan,
      candidatePool: slots.map(slot => ({ ...slot, parentCandidateIds: [...parentCandidateIds], roundId, status: 'generating' })),
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
    candidateId: string,
    advisoryFocus?: SemanticTarget[],
  ): ActiveRound {
    return {
      evolution, lock, source, batchId, roundIndex, roundCount, candidateId,
      abort: new AbortController(), finalization: finalizationResolvers(), finalizationSubmitted: false,
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
      const baseline = await active.evolution.evaluator.evaluate(round, {
        phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: round.targetHarnessRef,
        condition: round.plan.seed,
      }, active.abort.signal)
      round = await this.transition(store, roundId, { status: 'preparing-candidate', baseline })
      const workspace = await this.workspaceManager.create(round, active.abort.signal)
      active.workspace = workspace
      round = await this.transition(store, roundId, {
        status: 'candidate-editing',
        candidatePool: this.patchCandidate(round, active.candidateId, { workspaceId: workspace.workspaceId }),
      })
      const agent = await meta.agent()
      active.metaSessionId = String(agent.id)
      this.workspaceManager.bind(workspace.workspaceId, active.metaSessionId)
      await meta.wake(round)
      const generationTimeoutMs = active.evolution.spec.candidateGeneration.budget.timeoutMs
      let generationTimer: ReturnType<typeof setTimeout> | undefined
      const generationTimeout = new Promise<never>((_resolve, reject) => {
        generationTimer = setTimeout(() => {
          const error = new Error(`candidate generation exceeded its ${generationTimeoutMs}ms budget`)
          active.abort.abort(error)
          reject(error)
        }, generationTimeoutMs)
      })
      let proposal: FinalizationValue
      try {
        proposal = await Promise.race([active.finalization.promise, generationTimeout])
      } finally {
        if (generationTimer !== undefined) clearTimeout(generationTimer)
      }
      round = await this.transition(store, roundId, {
        finalization: proposal.finalization,
        ...(proposal.decline === undefined ? {} : { decline: proposal.decline }),
        meta: proposal.meta, proposalEvidence: proposal.evidence,
        candidatePool: this.patchCandidate(round, active.candidateId, {
          ...(proposal.finalization === null ? {} : { proposal: proposal.finalization }),
          ...(proposal.diff === undefined ? {} : { diff: proposal.diff }),
          meta: proposal.meta,
          proposalEvidence: proposal.evidence,
        }),
      })
      if (proposal.finalization === null || proposal.diff === undefined) {
        await this.transition(store, roundId, { status: 'rejected', decision: 'no-change' })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'building-candidate' })
      let candidate
      try {
        this.workspaceManager.markFinalizing(workspace.workspaceId)
        const verifiedDiff = await this.workspaceManager.verifySealed(workspace.workspaceId, proposal.diff, active.abort.signal)
        candidate = await this.builder.finalizeWorkspace(workspace, verifiedDiff, active.abort.signal)
        await this.workspaceManager.markCommitted(workspace.workspaceId)
      } catch (error) {
        if (!(error instanceof SubstrateExpansionError)) throw error
        await this.transition(store, roundId, {
          status: 'rejected-for-substrate', decision: 'rejected-for-substrate',
          failure: { phase: 'building-candidate', message: error.message },
        })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, {
        status: 'candidate-seed-running',
        candidatePool: this.patchCandidate(round, active.candidateId, {
          status: 'evaluating',
          sealedVersion: {
            commitOid: candidate.ref,
            treeOid: candidate.treeOid,
            manifestDigest: candidate.digest,
            patchDigest: proposal.diff.patchDigest,
            immutableRef: candidate.immutableRef,
          },
        }),
      })
      const seedCandidate = await active.evolution.evaluator.evaluate(round, {
        phase: 'seed-candidate', dataset: round.seedTaskRef, harnessRef: candidate.ref,
        condition: round.plan.seed,
      }, active.abort.signal)
      this.assertParity(baseline, seedCandidate, 'seed')
      let evaluation: RoundEvaluation = {
        seedBaseline: baseline, seedCandidate,
        seedPairedTrials: pairedTrials(baseline, seedCandidate),
        scoreDelta: seedCandidate.primaryReward - baseline.primaryReward,
        requiredRegressions: this.requiredRegressions(round, baseline, seedCandidate),
      }
      round = await this.transition(store, roundId, {
        evaluation,
        candidatePool: this.patchCandidate(round, active.candidateId, {
          seedEvaluation: seedCandidate,
          metrics: await this.evaluateJudges(active.evolution.spec, seedCandidate),
          status: 'ready',
        }),
      })
      const selection = this.components.selector(active.evolution.spec.selection.strategy)
        .select(round.candidatePool, active.evolution.spec.selection.survivors)
      if (selection.selectedCandidateIds.length !== 1 || selection.selectedCandidateIds[0] !== active.candidateId) {
        throw new Error('single-candidate runtime received an invalid selection decision')
      }
      round = await this.transition(store, roundId, {
        selection,
        candidatePool: this.patchCandidate(round, active.candidateId, { status: 'selected' }),
      })
      if (!this.passesSeed(round, evaluation)) {
        await this.transition(store, roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'held-out-running' })
      const heldOutBaseline = await active.evolution.evaluator.evaluate(round, {
        phase: 'held-out-baseline', dataset: round.heldOutRef, harnessRef: round.targetHarnessRef,
        condition: round.plan.heldOut,
      }, active.abort.signal)
      evaluation = { ...evaluation, heldOutBaseline }
      round = await this.transition(store, roundId, { evaluation })
      const heldOutCandidate = await active.evolution.evaluator.evaluate(round, {
        phase: 'held-out-candidate', dataset: round.heldOutRef, harnessRef: candidate.ref,
        condition: round.plan.heldOut,
      }, active.abort.signal)
      this.assertParity(heldOutBaseline, heldOutCandidate, 'held-out')
      evaluation = {
        ...evaluation, heldOutCandidate,
        heldOutPairedTrials: pairedTrials(heldOutBaseline, heldOutCandidate),
        promotionMetrics: await this.evaluateJudges(active.evolution.spec, heldOutCandidate),
        heldOutScoreDelta: heldOutCandidate.primaryReward - heldOutBaseline.primaryReward,
        requiredRegressions: evaluation.requiredRegressions + this.requiredRegressions(round, heldOutBaseline, heldOutCandidate),
      }
      round = await this.transition(store, roundId, {
        evaluation,
        candidatePool: this.patchCandidate(round, active.candidateId, { heldOutEvaluation: heldOutCandidate }),
      })
      if (!this.passesHeldOut(round, evaluation, active.evolution.spec)) {
        await this.transition(store, roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'promoting' })
      await store.compareAndSwapChampion(round.targetHarnessRef, {
        schemaVersion: 2, ref: candidate.ref, manifestDigest: candidate.digest, updatedAt: now(), roundId,
      })
      const previousPopulation = await store.readPopulation()
      const candidateRecord = round.candidatePool.find(value => value.candidateId === active.candidateId)!
      const parentMember = previousPopulation?.members.find(member => candidateRecord.parentCandidateIds.includes(member.candidateId))
      const populationIdentity = {
        evolutionId: round.evolutionId,
        generation: (previousPopulation?.generation ?? 0) + 1,
        members: [{
          candidateId: active.candidateId,
          harnessRef: candidate.ref,
          harnessDigest: candidate.digest,
          parentCandidateIds: [...candidateRecord.parentCandidateIds],
          lineageRootId: parentMember?.lineageRootId ?? active.candidateId,
          ...(active.metaSessionId === undefined ? {} : { metaSessionId: active.metaSessionId }),
          metrics: {
            ...(evaluation.promotionMetrics ?? {
              quality: heldOutCandidate.primaryReward,
              taskSuccessRate: heldOutCandidate.summary.total === 0 ? 0 : heldOutCandidate.summary.passed / heldOutCandidate.summary.total,
            }),
          },
          selectedAt: now(),
        }],
      }
      await store.writePopulation({ ...populationIdentity, digest: digestJson(populationIdentity) })
      await this.transition(store, roundId, {
        status: 'accepted', decision: 'accepted', promotedCandidateId: active.candidateId,
      })
      continueBatch = true
    } catch (error) {
      const round = await store.readRound(roundId)
      if (round !== undefined && !TERMINAL.has(round.status)) {
        await store.writeRound({
          ...round, status: 'failed', updatedAt: now(), failure: { phase: round.status, message: errorMessage(error) },
        }).catch(() => {})
      }
    } finally {
      if (active.metaSessionId !== undefined && active.workspace !== undefined) {
        try { this.workspaceManager.unbind(active.metaSessionId, active.workspace.workspaceId) } catch {}
      }
      if (active.workspace !== undefined) await this.workspaceManager.dispose(active.workspace.workspaceId).catch(() => {})
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
    const parentCandidateIds = population?.members.filter(member => member.harnessRef === champion.ref).map(member => member.candidateId) ?? []
    const roundId = crypto.randomUUID()
    const index = previous.roundIndex + 1
    const round = this.newRound(
      previous.evolution.spec, champion, previous.source, previous.batchId, roundId, index, previous.roundCount,
      parentCandidateIds, previous.advisoryFocus,
    )
    const active = this.newActive(
      previous.evolution, previous.lock, previous.source, previous.batchId, index, previous.roundCount,
      round.candidatePool[0]!.candidateId, previous.advisoryFocus,
    )
    await previous.evolution.store.writeRound(round)
    await previous.lock.retarget(roundId)
    await this.registry.touch(previous.evolution.spec.evolutionId, { batchId: previous.batchId, roundId })
    this.active.set(roundId, active)
    queueMicrotask(() => this.startDrive(roundId))
  }

  private startDrive(roundId: string): void {
    const drive = this.drive(roundId)
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
    const candidate = round.candidatePool.find(value => value.status === 'selected')
    return evaluation.seedCandidate.primaryReward >= promotion.minimumCandidateScore
      && evaluation.scoreDelta >= promotion.minimumAbsoluteGain
      && evaluation.requiredRegressions <= promotion.maxRequiredRegressions
      && (!promotion.requireNoRegression || evaluation.seedCandidate.summary.passed >= evaluation.seedBaseline.summary.passed)
      && candidate?.sealedVersion?.commitOid === evaluation.seedCandidate.actualCommit
  }

  private passesHeldOut(round: RefinementRound, evaluation: RoundEvaluation, spec: EvolutionSpec): boolean {
    const baseline = evaluation.heldOutBaseline
    const candidate = evaluation.heldOutCandidate
    const selected = round.candidatePool.find(value => value.status === 'selected')
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
    finalization: CandidateFinalization | null,
    decline: CandidateDecline | undefined,
    audit: ProposalEvidenceAudit,
  ): void {
    const baseline = round.baseline
    if (baseline === undefined) throw new Error('finalization has no current baseline evidence')
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

  private async transition(store: RefineStateStore, roundId: string, patch: Partial<RefinementRound>): Promise<RefinementRound> {
    const round = await this.requireRound(store, roundId)
    const updated = { ...round, ...patch, updatedAt: now() }
    await store.writeRound(updated)
    return updated
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
    patch: Partial<CandidateRecord>,
  ): CandidateRecord[] {
    let found = false
    const candidates = round.candidatePool.map(candidate => {
      if (candidate.candidateId !== candidateId) return candidate
      found = true
      return { ...candidate, ...patch, candidateId: candidate.candidateId, roundId: candidate.roundId }
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
    if (spec.candidateGeneration.maxCandidates !== 1 || spec.selection.survivors !== 1) {
      throw new Error('current DSH runtime does not support durable session fork; maxCandidates and survivors must be 1')
    }
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
