import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { CandidateWorkspaceHandle, CandidateWorkspaceManager } from '../candidate/workspace.js'
import type { HarnessBuilder } from '../harness/builder.js'
import { SubstrateExpansionError } from '../harness/builder.js'
import type { MetaSessionManager } from '../meta/session.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson, type EvolutionRegistryStore } from '../state/evolution.js'
import type { RefineStateStore, WorkspaceLock } from '../state/store.js'
import type {
  AdmissionResult, CandidateDecline, CandidateDiffSummary, CandidateFinalization, ChampionState,
  EvolutionRegistryEntry, EvolutionSpec, HitchEvaluationEvidence, MetaAttribution,
  ProposalEvidenceAudit, PromotionPolicy, PublicSeedEvidence, PublicRoundStatus,
  RefineEvaluator, RefinementRound, RoundEvaluation, SemanticTarget,
} from '../types.js'
import { isExactGitCommit } from '../types.js'

export interface RefineServiceOptions {
  workspaceRoot: string
  metaHarnessRef: string
  metaModel: AgentOptions
  metaSampling?: Record<string, string | number | boolean>
  toolchainRef: string
  sandboxProfileRef: string
  promotion: PromotionPolicy
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  initialChampion?: ChampionState
  publishedPointer: boolean
  maxLiveMetaSessions: number
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
export type MetaSessionFactory = (spec: EvolutionSpec, specDigest: string, store: RefineStateStore) => MetaSessionManager

interface EvolutionRuntime {
  spec: EvolutionSpec
  specDigest: string
  store: RefineStateStore
  meta: MetaSessionManager
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

function taskRewards(evidence: HitchEvaluationEvidence): Map<string, number> {
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

function trialReward(trial: HitchEvaluationEvidence['trials'][number]): number | undefined {
  return trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

function publicSeedEvidence(evidence: HitchEvaluationEvidence): PublicSeedEvidence {
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
  ) {}

  async initialize(): Promise<void> {
    await this.registry.initialize()
    await this.workspaceManager.initialize()
    for (const entry of await this.registry.list()) {
      const store = this.registry.stateStore(entry.evolutionId)
      await store.initialize()
      for (const round of await store.listRounds()) {
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
      schemaVersion: 1, evolutionId, source: 'native', createdAt: now(),
      initialHarnessRef: initial.ref, initialHarnessDigest: initial.manifestDigest,
      seedTaskRef, seedTaskDigest: await digestDatasetRef(seedTaskRef),
      heldOutRef: this.options.heldOutRef, heldOutDigest: await digestDatasetRef(this.options.heldOutRef),
      metaHarnessRef: this.options.metaHarnessRef,
      metaModel: JSON.parse(JSON.stringify(this.options.metaModel)) as never,
      ...(this.options.metaSampling === undefined ? {} : { metaSampling: JSON.parse(JSON.stringify(this.options.metaSampling)) as never }),
      promotionPolicy: { ...this.options.promotion }, taskBudgetMs,
      toolchainRef: this.options.toolchainRef, sandboxProfileRef: this.options.sandboxProfileRef,
    }
    await this.registry.createEvolution({ spec, champion: initial, ...(options.name === undefined ? {} : { name: options.name }) })
    return this.startBatch(await this.runtime(evolutionId), source, batchId, roundCount, normalizeFocus(options.focus))
  }

  async continueEvolution(source: RefinementRound['source'], evolutionId: string, options: ContinueOptions = {}): Promise<AdmissionResult> {
    this.assertAvailable()
    const entry = await this.registry.readEntry(evolutionId)
    if (entry === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    if (entry.status !== 'active') throw new Error(`evolution is archived and cannot continue: ${evolutionId}`)
    const evolution = await this.runtime(evolutionId)
    if (evolution.spec.source === 'legacy-migration') throw new Error('legacy migrated evolution cannot continue')
    const [seedDigest, heldOutDigest] = await Promise.all([
      digestDatasetRef(evolution.spec.seedTaskRef), digestDatasetRef(evolution.spec.heldOutRef),
    ])
    if (seedDigest !== evolution.spec.seedTaskDigest || heldOutDigest !== evolution.spec.heldOutDigest) {
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
      const verified = (await evolution.store.listRounds()).find(round =>
        round.status === 'accepted' && round.decision === 'accepted' && round.candidateRef === verifiedHarnessRef
        && round.candidateDigest !== undefined && round.evaluation?.heldOutCandidate?.actualCommit === verifiedHarnessRef)
      if (verified === undefined) throw new Error(`harness ref was not accepted by evolution ${evolutionId}: ${verifiedHarnessRef}`)
      const current = await this.requireChampion(evolution.store)
      const restored: ChampionState = {
        schemaVersion: 2, ref: verified.candidateRef!, manifestDigest: verified.candidateDigest!,
        updatedAt: now(), roundId: `rollback:${verified.roundId}`,
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
      const accepted = (await evolution.store.listRounds()).find(round => round.status === 'accepted'
        && round.candidateRef === verifiedHarnessRef && round.candidateDigest !== undefined)
      if (accepted === undefined) throw new Error('publish ref is not accepted history of this evolution')
      selected = { schemaVersion: 2, ref: verifiedHarnessRef, manifestDigest: accepted.candidateDigest!, updatedAt: now(), roundId: accepted.roundId }
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
    const round = this.newRound(evolution.spec, champion, source, batchId, roundId, 1, roundCount, advisoryFocus)
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
    source: RefinementRound['source'],
    batchId: string,
    roundId: string,
    roundIndex: number,
    roundCount: number,
    advisoryFocus?: SemanticTarget[],
  ): RefinementRound {
    const timestamp = now()
    return {
      schemaVersion: 3, evolutionId: spec.evolutionId, roundId, workspaceRoot: this.options.workspaceRoot,
      status: 'queued', source, createdAt: timestamp, updatedAt: timestamp,
      metaHarnessRef: spec.metaHarnessRef, targetHarnessRef: champion.ref, targetHarnessDigest: champion.manifestDigest,
      sandboxProfileRef: spec.sandboxProfileRef, seedTaskRef: spec.seedTaskRef, heldOutRef: spec.heldOutRef,
      taskBudgetMs: spec.taskBudgetMs, promotionPolicy: { ...spec.promotionPolicy },
      batchId, roundIndex, roundCount, ...(advisoryFocus === undefined ? {} : { advisoryFocus }),
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
      const baseline = await this.evaluator.evaluate(round, {
        phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: round.targetHarnessRef,
      }, active.abort.signal)
      round = await this.transition(store, roundId, { status: 'preparing-candidate', baseline })
      const workspace = await this.workspaceManager.create(round, active.abort.signal)
      active.workspace = workspace
      round = await this.transition(store, roundId, { status: 'candidate-editing', candidateWorkspaceId: workspace.workspaceId })
      const agent = await meta.agent()
      active.metaSessionId = String(agent.id)
      this.workspaceManager.bind(workspace.workspaceId, active.metaSessionId)
      await meta.wake(round)
      const proposal = await active.finalization.promise
      round = await this.transition(store, roundId, {
        finalization: proposal.finalization,
        ...(proposal.decline === undefined ? {} : { decline: proposal.decline }),
        ...(proposal.diff === undefined ? {} : { candidateDiff: proposal.diff }),
        meta: proposal.meta, proposalEvidence: proposal.evidence,
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
        status: 'candidate-seed-running', candidateRef: candidate.ref, candidateDigest: candidate.digest,
      })
      const seedCandidate = await this.evaluator.evaluate(round, {
        phase: 'seed-candidate', dataset: round.seedTaskRef, harnessRef: candidate.ref,
      }, active.abort.signal)
      this.assertParity(baseline, seedCandidate, 'seed')
      let evaluation: RoundEvaluation = {
        seedBaseline: baseline, seedCandidate,
        scoreDelta: seedCandidate.primaryReward - baseline.primaryReward,
        requiredRegressions: this.requiredRegressions(round, baseline, seedCandidate),
      }
      round = await this.transition(store, roundId, { evaluation })
      if (!this.passesSeed(round, evaluation)) {
        await this.transition(store, roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'held-out-running' })
      const heldOutBaseline = await this.evaluator.evaluate(round, {
        phase: 'held-out-baseline', dataset: round.heldOutRef, harnessRef: round.targetHarnessRef,
      }, active.abort.signal)
      evaluation = { ...evaluation, heldOutBaseline }
      round = await this.transition(store, roundId, { evaluation })
      const heldOutCandidate = await this.evaluator.evaluate(round, {
        phase: 'held-out-candidate', dataset: round.heldOutRef, harnessRef: candidate.ref,
      }, active.abort.signal)
      this.assertParity(heldOutBaseline, heldOutCandidate, 'held-out')
      evaluation = {
        ...evaluation, heldOutCandidate,
        heldOutScoreDelta: heldOutCandidate.primaryReward - heldOutBaseline.primaryReward,
        requiredRegressions: evaluation.requiredRegressions + this.requiredRegressions(round, heldOutBaseline, heldOutCandidate),
      }
      round = await this.transition(store, roundId, { evaluation })
      if (!this.passesHeldOut(round, evaluation)) {
        await this.transition(store, roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }
      round = await this.transition(store, roundId, { status: 'promoting' })
      await store.compareAndSwapChampion(round.targetHarnessRef, {
        schemaVersion: 2, ref: candidate.ref, manifestDigest: candidate.digest, updatedAt: now(), roundId,
      })
      await this.transition(store, roundId, { status: 'accepted', decision: 'accepted' })
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
    const roundId = crypto.randomUUID()
    const index = previous.roundIndex + 1
    const round = this.newRound(previous.evolution.spec, champion, previous.source, previous.batchId, roundId, index, previous.roundCount, previous.advisoryFocus)
    const active = this.newActive(previous.evolution, previous.lock, previous.source, previous.batchId, index, previous.roundCount, previous.advisoryFocus)
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
    const runtime = { spec, specDigest, store, meta: this.createMetaSession(spec, specDigest, store), lastUsedAt: Date.now() }
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
    return evaluation.seedCandidate.primaryReward >= promotion.minimumCandidateScore
      && evaluation.scoreDelta >= promotion.minimumAbsoluteGain
      && evaluation.requiredRegressions <= promotion.maxRequiredRegressions
      && (!promotion.requireNoRegression || evaluation.seedCandidate.summary.passed >= evaluation.seedBaseline.summary.passed)
      && round.candidateRef === evaluation.seedCandidate.actualCommit
  }

  private passesHeldOut(round: RefinementRound, evaluation: RoundEvaluation): boolean {
    const baseline = evaluation.heldOutBaseline
    const candidate = evaluation.heldOutCandidate
    return baseline !== undefined && candidate !== undefined && evaluation.heldOutScoreDelta !== undefined
      && evaluation.heldOutScoreDelta >= -round.promotionPolicy.maxHeldOutRegression
      && evaluation.requiredRegressions <= round.promotionPolicy.maxRequiredRegressions
      && (!round.promotionPolicy.requireNoRegression || candidate.summary.passed >= baseline.summary.passed)
      && round.candidateRef === candidate.actualCommit
  }

  private requiredRegressions(round: RefinementRound, baseline: HitchEvaluationEvidence, candidate: HitchEvaluationEvidence): number {
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

  private assertParity(baseline: HitchEvaluationEvidence, candidate: HitchEvaluationEvidence, partition: string): void {
    if (baseline.invocationFingerprint !== candidate.invocationFingerprint) throw new Error(`${partition} baseline/candidate Hitch invocation parity mismatch`)
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

  private assertAvailable(): void { if (this.disposed) throw new Error('RefineService is disposed') }
}
