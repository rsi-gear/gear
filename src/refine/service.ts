import type { HarnessBuilder } from '../harness/builder.js'
import { SubstrateExpansionError } from '../harness/builder.js'
import type { MetaSessionManager } from '../meta/session.js'
import { RoundAlreadyRunningError, type RefineStateStore, type WorkspaceLock } from '../state/store.js'
import type {
  AdmissionResult,
  ChampionState,
  HarnessMutation,
  HitchEvaluationEvidence,
  MetaAttribution,
  PromotionPolicy,
  PublicRoundStatus,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluation,
  SemanticTarget,
} from '../types.js'

export interface RefineServiceOptions {
  workspaceRoot: string
  metaHarnessRef: string
  sandboxProfileRef: string
  promotion: PromotionPolicy
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
}

export interface AdmissionOptions {
  seedTaskRef?: string
  rounds?: number
  taskBudgetMs?: number
  target?: SemanticTarget
}

interface ActiveRound {
  lock: WorkspaceLock
  abort: AbortController
  proposal: PromiseWithResolvers<{ mutation: HarnessMutation | null; meta: MetaAttribution }>
  proposalSubmitted: boolean
  batchId: string
  roundIndex: number
  roundCount: number
  seedTaskRef: string
  taskBudgetMs: number
  requestedTarget?: SemanticTarget
  source: RefinementRound['source']
}

const TERMINAL = new Set<RefinementRound['status']>(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  return new Map([...grouped].map(([task, values]) => [
    task,
    values.reduce((total, value) => total + value, 0) / values.length,
  ]))
}

export class RefineService {
  private readonly active = new Map<string, ActiveRound>()
  private disposed = false

  constructor(
    readonly store: RefineStateStore,
    readonly builder: HarnessBuilder,
    readonly meta: MetaSessionManager,
    readonly evaluator: RefineEvaluator,
    readonly options: RefineServiceOptions,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize()
    for (const round of await this.store.listRounds()) {
      if (!TERMINAL.has(round.status)) {
        await this.store.writeRound({
          ...round,
          status: 'failed',
          updatedAt: now(),
          failure: { phase: 'recovery', message: 'control plane restarted before the round reached a durable terminal state' },
        })
      }
    }
  }

  async admit(source: RefinementRound['source'], options: AdmissionOptions = {}): Promise<AdmissionResult> {
    if (this.disposed) throw new Error('RefineService is disposed')
    const roundCount = options.rounds ?? 1
    const taskBudgetMs = options.taskBudgetMs ?? this.options.taskBudgetMs
    if (!Number.isSafeInteger(roundCount) || roundCount < 1 || roundCount > 100) {
      throw new TypeError('rounds must be an integer between 1 and 100')
    }
    if (!Number.isSafeInteger(taskBudgetMs) || taskBudgetMs <= 0) {
      throw new TypeError('taskBudgetMs must be a positive integer')
    }
    const roundId = crypto.randomUUID()
    const batchId = crypto.randomUUID()
    let lock: WorkspaceLock
    try {
      lock = await this.store.acquireRoundLock(roundId)
    } catch (error) {
      if (error instanceof RoundAlreadyRunningError && error.owner?.roundId !== undefined) {
        return { roundId: error.owner.roundId, status: 'queued' }
      }
      throw error
    }
    const champion = await this.requireChampion().catch(async (error: unknown) => {
      await lock.release()
      throw error
    })
    const timestamp = now()
    const round: RefinementRound = {
      schemaVersion: 2,
      roundId,
      workspaceRoot: this.options.workspaceRoot,
      status: 'queued',
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
      metaHarnessRef: this.options.metaHarnessRef,
      targetHarnessRef: champion.ref,
      targetHarnessDigest: champion.manifestDigest,
      sandboxProfileRef: this.options.sandboxProfileRef,
      seedTaskRef: options.seedTaskRef ?? this.options.seedTaskRef,
      heldOutRef: this.options.heldOutRef,
      taskBudgetMs,
      promotionPolicy: { ...this.options.promotion },
      batchId,
      roundIndex: 1,
      roundCount,
      ...(options.target === undefined ? {} : { requestedTarget: options.target }),
    }
    const active: ActiveRound = {
      lock,
      abort: new AbortController(),
      proposal: Promise.withResolvers(),
      proposalSubmitted: false,
      batchId,
      roundIndex: 1,
      roundCount,
      seedTaskRef: options.seedTaskRef ?? this.options.seedTaskRef,
      taskBudgetMs,
      ...(options.target === undefined ? {} : { requestedTarget: options.target }),
      source,
    }
    this.active.set(roundId, active)
    try {
      await this.store.writeRound(round)
    } catch (error) {
      this.active.delete(roundId)
      await lock.release()
      throw error
    }
    queueMicrotask(() => { void this.drive(roundId) })
    return { roundId, status: 'queued' }
  }

  async submitProposal(roundId: string, mutation: HarnessMutation | null, meta: MetaAttribution): Promise<void> {
    const active = this.active.get(roundId)
    if (active === undefined) throw new Error(`stale or unknown refinement round: ${roundId}`)
    const round = await this.requireRound(roundId)
    if (round.status !== 'waiting-proposal') throw new Error(`round ${roundId} is not waiting for a proposal`)
    if (active.proposalSubmitted) throw new Error(`round ${roundId} already received a proposal`)
    if (meta.sessionId !== (await this.store.readMeta())?.sessionId) throw new Error('proposal meta session does not own this workspace')
    active.proposalSubmitted = true
    active.proposal.resolve({ mutation, meta })
  }

  async status(roundId: string): Promise<PublicRoundStatus> {
    const round = await this.requireRound(roundId)
    return {
      roundId,
      status: round.status,
      ...(round.decision === undefined ? {} : { decision: round.decision }),
      ...(round.evaluation === undefined ? {} : { seedSummary: round.evaluation.seedCandidate.summary }),
      ...(round.failure === undefined ? {} : { failure: round.failure.phase }),
    }
  }

  async latestStatus(): Promise<PublicRoundStatus | undefined> {
    const rounds = await this.store.listRounds()
    const latest = rounds.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
    return latest === undefined ? undefined : this.status(latest.roundId)
  }

  async rollback(verifiedHarnessRef: string): Promise<ChampionState> {
    const lock = await this.store.acquireRoundLock(`rollback-${crypto.randomUUID()}`)
    try {
      const verified = (await this.store.listRounds()).find(round =>
        round.status === 'accepted'
        && round.decision === 'accepted'
        && round.candidateRef === verifiedHarnessRef
        && round.candidateDigest !== undefined
        && round.evaluation?.heldOutCandidate?.actualCommit === verifiedHarnessRef)
      if (verified === undefined) throw new Error(`harness ref was not accepted by a recorded round: ${verifiedHarnessRef}`)
      const current = await this.requireChampion()
      const restored: ChampionState = {
        schemaVersion: 2,
        ref: verified.candidateRef!,
        manifestDigest: verified.candidateDigest!,
        updatedAt: now(),
        roundId: `rollback:${verified.roundId}`,
      }
      await this.store.compareAndSwapChampion(current.ref, restored)
      return restored
    } finally {
      await lock.release()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const active of this.active.values()) {
      const error = new Error('RefineService disposed')
      active.abort.abort(error)
      active.proposal.reject(error)
    }
    await Promise.all([...this.active.values()].map(active => active.lock.release().catch(() => {})))
    this.active.clear()
    await this.meta.dispose()
  }

  private async drive(roundId: string): Promise<void> {
    const active = this.active.get(roundId)
    if (active === undefined) return
    let continueBatch = false
    try {
      let round = await this.transition(roundId, { status: 'baseline-running' })
      const baseline = await this.evaluator.evaluate(round, {
        phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: round.targetHarnessRef,
      }, active.abort.signal)
      round = await this.transition(roundId, { status: 'waiting-proposal', baseline })
      await this.meta.wake(round)
      const proposal = await active.proposal.promise
      round = await this.transition(roundId, { mutation: proposal.mutation, meta: proposal.meta })
      if (proposal.mutation === null) {
        await this.transition(roundId, { status: 'rejected', decision: 'no-change' })
        continueBatch = true
        return
      }
      this.validateProposalParent(round, proposal.mutation)
      if (round.requestedTarget !== undefined && proposal.mutation.target !== round.requestedTarget) {
        throw new Error(`proposal target ${proposal.mutation.target} does not match requested target ${round.requestedTarget}`)
      }
      round = await this.transition(roundId, { status: 'building-candidate' })
      let candidate
      try {
        candidate = await this.builder.build(proposal.mutation, active.abort.signal)
      } catch (error) {
        if (!(error instanceof SubstrateExpansionError)) throw error
        await this.transition(roundId, {
          status: 'rejected-for-substrate',
          decision: 'rejected-for-substrate',
          failure: { phase: 'building-candidate', message: error.message },
        })
        continueBatch = true
        return
      }
      round = await this.transition(roundId, {
        status: 'candidate-seed-running', candidateRef: candidate.ref, candidateDigest: candidate.digest,
      })
      const seedCandidate = await this.evaluator.evaluate(round, {
        phase: 'seed-candidate', dataset: round.seedTaskRef, harnessRef: candidate.ref,
      }, active.abort.signal)
      this.assertParity(baseline, seedCandidate, 'seed')
      let evaluation: RoundEvaluation = {
        seedBaseline: baseline,
        seedCandidate,
        scoreDelta: seedCandidate.primaryReward - baseline.primaryReward,
        requiredRegressions: this.requiredRegressions(round, baseline, seedCandidate),
      }
      round = await this.transition(roundId, { evaluation })
      if (!this.passesSeed(round, evaluation)) {
        await this.transition(roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }

      round = await this.transition(roundId, { status: 'held-out-running' })
      const heldOutBaseline = await this.evaluator.evaluate(round, {
        phase: 'held-out-baseline', dataset: round.heldOutRef, harnessRef: round.targetHarnessRef,
      }, active.abort.signal)
      evaluation = { ...evaluation, heldOutBaseline }
      round = await this.transition(roundId, { evaluation })
      const heldOutCandidate = await this.evaluator.evaluate(round, {
        phase: 'held-out-candidate', dataset: round.heldOutRef, harnessRef: candidate.ref,
      }, active.abort.signal)
      this.assertParity(heldOutBaseline, heldOutCandidate, 'held-out')
      evaluation = {
        ...evaluation,
        heldOutCandidate,
        heldOutScoreDelta: heldOutCandidate.primaryReward - heldOutBaseline.primaryReward,
        requiredRegressions: evaluation.requiredRegressions
          + this.requiredRegressions(round, heldOutBaseline, heldOutCandidate),
      }
      round = await this.transition(roundId, { evaluation })
      if (!this.passesHeldOut(round, evaluation)) {
        await this.transition(roundId, { status: 'rejected', decision: 'rejected' })
        continueBatch = true
        return
      }
      round = await this.transition(roundId, { status: 'promoting' })
      const champion: ChampionState = {
        schemaVersion: 2,
        ref: candidate.ref,
        manifestDigest: candidate.digest,
        updatedAt: now(),
        roundId,
      }
      await this.store.compareAndSwapChampion(round.targetHarnessRef, champion)
      await this.transition(roundId, { status: 'accepted', decision: 'accepted' })
      continueBatch = true
    } catch (error) {
      const round = await this.store.readRound(roundId)
      if (round !== undefined && !TERMINAL.has(round.status)) {
        await this.store.writeRound({
          ...round,
          status: 'failed',
          updatedAt: now(),
          failure: { phase: round.status, message: errorMessage(error) },
        }).catch(() => {})
      }
    } finally {
      this.active.delete(roundId)
      if (continueBatch && active.roundIndex < active.roundCount && !this.disposed) {
        try {
          await this.queueContinuation(active)
          return
        } catch (error) {
          const round = await this.store.readRound(roundId)
          if (round !== undefined) {
            await this.store.writeRound({
              ...round,
              failure: { phase: 'batch-continuation', message: errorMessage(error) },
              updatedAt: now(),
            }).catch(() => {})
          }
        }
      }
      await active.lock.release().catch(() => {})
    }
  }

  private async queueContinuation(previous: ActiveRound): Promise<void> {
    const champion = await this.requireChampion()
    const roundId = crypto.randomUUID()
    const timestamp = now()
    const round: RefinementRound = {
      schemaVersion: 2,
      roundId,
      workspaceRoot: this.options.workspaceRoot,
      status: 'queued',
      source: previous.source,
      createdAt: timestamp,
      updatedAt: timestamp,
      metaHarnessRef: this.options.metaHarnessRef,
      targetHarnessRef: champion.ref,
      targetHarnessDigest: champion.manifestDigest,
      sandboxProfileRef: this.options.sandboxProfileRef,
      seedTaskRef: previous.seedTaskRef,
      heldOutRef: this.options.heldOutRef,
      taskBudgetMs: previous.taskBudgetMs,
      promotionPolicy: { ...this.options.promotion },
      batchId: previous.batchId,
      roundIndex: previous.roundIndex + 1,
      roundCount: previous.roundCount,
      ...(previous.requestedTarget === undefined ? {} : { requestedTarget: previous.requestedTarget }),
    }
    const active: ActiveRound = {
      lock: previous.lock,
      abort: previous.abort,
      proposal: Promise.withResolvers(),
      proposalSubmitted: false,
      batchId: previous.batchId,
      roundIndex: previous.roundIndex + 1,
      roundCount: previous.roundCount,
      seedTaskRef: previous.seedTaskRef,
      taskBudgetMs: previous.taskBudgetMs,
      ...(previous.requestedTarget === undefined ? {} : { requestedTarget: previous.requestedTarget }),
      source: previous.source,
    }
    await this.store.writeRound(round)
    await previous.lock.retarget(roundId)
    this.active.set(roundId, active)
    queueMicrotask(() => { void this.drive(roundId) })
  }

  private passesSeed(round: RefinementRound, evaluation: RoundEvaluation): boolean {
    const { promotion } = this.options
    if (evaluation.seedCandidate.primaryReward < promotion.minimumCandidateScore) return false
    if (evaluation.scoreDelta < promotion.minimumAbsoluteGain) return false
    if (evaluation.requiredRegressions > promotion.maxRequiredRegressions) return false
    if (promotion.requireNoRegression
      && evaluation.seedCandidate.summary.passed < evaluation.seedBaseline.summary.passed) return false
    return round.candidateRef === evaluation.seedCandidate.actualCommit
  }

  private passesHeldOut(round: RefinementRound, evaluation: RoundEvaluation): boolean {
    const heldOutBaseline = evaluation.heldOutBaseline
    const heldOutCandidate = evaluation.heldOutCandidate
    if (heldOutBaseline === undefined || heldOutCandidate === undefined || evaluation.heldOutScoreDelta === undefined) return false
    if (evaluation.heldOutScoreDelta < -this.options.promotion.maxHeldOutRegression) return false
    if (evaluation.requiredRegressions > this.options.promotion.maxRequiredRegressions) return false
    if (this.options.promotion.requireNoRegression
      && heldOutCandidate.summary.passed < heldOutBaseline.summary.passed) return false
    return round.candidateRef === heldOutCandidate.actualCommit
  }

  private requiredRegressions(
    round: RefinementRound,
    baseline: HitchEvaluationEvidence,
    candidate: HitchEvaluationEvidence,
  ): number {
    const required = round.promotionPolicy.requiredTaskIds ?? []
    if (required.length === 0) return 0
    const before = taskRewards(baseline)
    const after = taskRewards(candidate)
    let regressions = 0
    for (const task of required) {
      const baselineReward = before.get(task)
      const candidateReward = after.get(task)
      if (baselineReward === undefined || candidateReward === undefined) {
        throw new Error(`required task is missing from Hitch eval result: ${task}`)
      }
      if (candidateReward < baselineReward) regressions += 1
    }
    return regressions
  }

  private assertParity(baseline: HitchEvaluationEvidence, candidate: HitchEvaluationEvidence, partition: string): void {
    if (baseline.invocationFingerprint !== candidate.invocationFingerprint) {
      throw new Error(`${partition} baseline/candidate Hitch invocation parity mismatch`)
    }
    if (baseline.dataset !== candidate.dataset) throw new Error(`${partition} baseline/candidate dataset mismatch`)
  }

  private validateProposalParent(round: RefinementRound, mutation: HarnessMutation): void {
    if (mutation.parentRef !== round.targetHarnessRef || mutation.parentDigest !== round.targetHarnessDigest) {
      throw new Error('proposal parent does not match the round target harness CAS')
    }
  }

  private async transition(roundId: string, patch: Partial<RefinementRound>): Promise<RefinementRound> {
    const round = await this.requireRound(roundId)
    const updated = { ...round, ...patch, updatedAt: now() }
    await this.store.writeRound(updated)
    return updated
  }

  private async requireRound(roundId: string): Promise<RefinementRound> {
    const round = await this.store.readRound(roundId)
    if (round === undefined) throw new Error(`unknown refinement round: ${roundId}`)
    return round
  }

  private async requireChampion(): Promise<ChampionState> {
    const champion = await this.store.readChampion()
    if (champion === undefined) throw new Error('no champion is initialized for this workspace')
    return champion
  }
}
