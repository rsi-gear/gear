import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { HitchCliEvaluator, HitchEvaluationError } from '../../src/evaluator/hitch-cli.js'
import type { EvaluationSubmissionIntent, EvaluationRerunReservation } from '../../src/types.js'
import { HarnessBuilder, NoopHarnessCompiler, SubstrateExpansionError } from '../../src/harness/builder.js'
import { RefineService } from '../../src/refine/service.js'
import type { MetaSessionController } from '../../src/meta/controller.js'
import { MetaOffloadingStore, type MetaExecutionState } from '../../src/meta/offloading-store.js'
import { resolveOffloadingPolicy } from '../../src/meta/offloading-policy.js'
import { contextMessage } from '../../src/meta/offloading-host.js'
import { digestJson } from '../../src/state/digest.js'
import { RefineStateStore } from '../../src/state/store.js'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import type { DiagnosisReceipt, EvaluationPhase, EvaluationRequest, EvaluationRerunResult, EvaluationRerunSelector, EvaluationReservation, HitchEvaluationEvidence, MetaAttribution, MetaCheckpointRef, MetaTurnObservation, RefineEvaluator, RefinementRound, RoundEvaluationAttempt } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { builtinComponentRef, componentRef } from '../../src/evolution/components.js'
import { evolutionSpec } from '../helpers/research-fixture.js'
import { SkillMetaCoordinator, SkillMetaSessionManager, skillHarnessIdentity } from '../../src/meta/skill.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { renderTrajectoryResult } from '../../src/notebook/tool.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'
import type { HitchTrajectoryReader } from '../../src/types.js'
import { fixtures as searchFixtures, settings as searchSettings } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })))
})

function diagnosisReceipts(runIds: readonly string[]): DiagnosisReceipt[] {
  return runIds.map(runId => ({
    runId,
    bundleDigest: `sha256:${'c'.repeat(64)}`,
    trajectoryDigest: `sha256:${'d'.repeat(64)}`,
    projectionVersion: 1,
    verifierStatus: 'complete',
    sanitizationPolicyDigest: `sha256:${'e'.repeat(64)}`,
    inspectedAt: 'now',
  }))
}

class FakeMeta {
  wakes: string[] = []
  forks: MetaCheckpointRef[] = []
  turnCompletions: MetaTurnObservation[] = []
  private child = 0
  private readonly agents = new Map<string, { id: string }>()
  constructor(private readonly evolutionId: string, readonly store: import('../../src/state/store.js').RefineStateStore, private readonly specDigest: string) {}
  async agent() {
    const id = `meta-${this.evolutionId}`
    await this.store.writeMeta({ evolutionId: this.evolutionId, sessionId: id, metaHarnessRef: 'meta-v1', specDigest: this.specDigest })
    const agent = { id }
    this.agents.set(id, agent)
    return agent
  }
  async wake(round: Readonly<RefinementRound>): Promise<string> { this.wakes.push(round.roundId); return `meta-${this.evolutionId}` }
  async checkpoint(sessionId?: string) {
    const id = sessionId ?? String((await this.agent()).id)
    return { sourceSessionId: id, eventCount: 0, prefixDigest: `sha256:${'0'.repeat(64)}` }
  }
  async fork(checkpoint: MetaCheckpointRef) {
    this.forks.push(structuredClone(checkpoint))
    const id = `meta-${this.evolutionId}-candidate-${++this.child}`
    const agent = { id }
    this.agents.set(id, agent)
    return agent
  }
  async wakeCandidate(round: Readonly<RefinementRound>, _candidate: unknown, _baseline: unknown, agent: { id: string }) {
    this.wakes.push(round.roundId)
    const completion = this.turnCompletions.shift()
    return {
      sessionId: agent.id,
      ...(completion === undefined ? {} : { completion: Promise.resolve(completion) }),
    }
  }
  async cancel(): Promise<void> {}
  async release(sessionId: string): Promise<void> { this.agents.delete(sessionId) }
  async dispose(): Promise<void> {}
}

class FakeEvaluator implements RefineEvaluator {
  calls: EvaluationPhase[] = []
  private reservations = 0
  failurePhase?: EvaluationPhase
  readonly partialInvalidByPhase = new Map<EvaluationPhase, number[]>()
  readonly partialInvalidByCall = new Map<number, number[]>()
  useRequiredTaskRepetitions = false
  runtimeConfigDigest?: string
  diagnosticInvocationFingerprint?: string
  constructor(
    private readonly candidateScore = 0.8,
    private readonly heldOutDelta = 0,
    private readonly mismatchSeedCondition = false,
  ) {}
  prepareSubmission(_round: Readonly<RefinementRound>, _request: Readonly<EvaluationRequest>): EvaluationSubmissionIntent | undefined {
    return undefined
  }
  async cancelReservation(_reservation: Readonly<EvaluationReservation>, _intent?: Readonly<EvaluationSubmissionIntent>): Promise<void> {}
  async reserve(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
    _signal?: AbortSignal,
    _intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    this.reservations += 1
    return { provider: 'fake', evalId: `eval_fake_${this.reservations}` }
  }
  evaluationIdentity(
    _round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): { provider: string; effectiveConfigDigest: string; invocationFingerprint: string } {
    const digest = this.runtimeConfigDigest ?? request.condition.rolloutProviderDigest
    return {
      provider: 'fake',
      effectiveConfigDigest: digest,
      invocationFingerprint: this.diagnosticInvocationFingerprint ?? digest,
    }
  }
  async evaluate(
    _round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    _signal?: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    this.calls.push(request.phase)
    const evaluationIdentity = this.evaluationIdentity(_round, request)
    const baseline = request.phase.endsWith('baseline')
    const heldOut = request.phase.startsWith('held-out')
    const score = heldOut ? (baseline ? 0.6 : 0.6 + this.heldOutDelta) : (baseline ? 0.5 : this.candidateScore)
    const passed = Math.round(score * 10)
    const serial = this.calls.length.toString(16).padStart(32, '0')
    const evidence: HitchEvaluationEvidence = {
      provider: reservation?.provider ?? 'fake',
      conditionId: this.mismatchSeedCondition && request.phase === 'seed-candidate'
        ? `sha256:${'f'.repeat(64)}` : request.condition.conditionId,
      effectiveConfigDigest: evaluationIdentity.effectiveConfigDigest,
      evalId: reservation?.evalId ?? `eval_${serial}`, dataset: request.dataset,
      requestedCommit: request.harnessRef, actualCommit: request.harnessRef,
      revisionIdentity: `sha256:${serial.padEnd(64, '0')}`,
      invocationFingerprint: evaluationIdentity.invocationFingerprint,
      completeness: 'complete', plannedTrialCount: 10,
      primaryReward: score, summary: { total: 10, passed, failed: 10 - passed, score },
      trials: Array.from({ length: 10 }, (_, index) => ({
        taskName: this.useRequiredTaskRepetitions && index >= 8 ? 'task-required' : `task-${index}`,
        trialName: `${request.phase}-trial-${index}`,
        attempt: this.useRequiredTaskRepetitions && index >= 8 ? index - 7 : 1,
        runId: `run_${`${serial}${index}`.slice(-32).padStart(32, '0')}`,
        status: 'completed' as const, rewards: { reward: index < passed ? 1 : 0 },
      })),
      invalidTrials: [],
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${serial.padEnd(64, '0')}`,
        commit: request.harnessRef, tree: 'f'.repeat(40), payloadSha256: `sha256:${'1'.repeat(64)}`, payloadBytes: 1,
      },
    }
    if (this.failurePhase === request.phase) {
      const trials = evidence.trials.map((trial, index) => ({
        taskName: trial.taskName,
        trialName: trial.trialName!,
        runId: trial.runId!,
        attempt: trial.attempt!,
        status: index === evidence.trials.length - 1 ? 'errored' as const : 'completed' as const,
        ...(index === evidence.trials.length - 1 ? { invalidReason: 'infrastructure_failure' } : {}),
      }))
      throw new HitchEvaluationError('fake invalid run observations', 'hitch_infrastructure_failure', {
        provider: evidence.provider,
        conditionId: evidence.conditionId,
        effectiveConfigDigest: evidence.effectiveConfigDigest,
        evalId: evidence.evalId,
        dataset: evidence.dataset,
        requestedCommit: evidence.requestedCommit,
        actualCommit: evidence.actualCommit,
        revisionIdentity: evidence.revisionIdentity,
        invocationFingerprint: evidence.invocationFingerprint,
        runSetComplete: true,
        trials,
        localSourceTransport: evidence.localSourceTransport,
      })
    }
    const invalidIndexes = new Set(
      this.partialInvalidByCall.get(this.calls.length) ?? this.partialInvalidByPhase.get(request.phase) ?? [],
    )
    if (invalidIndexes.size > 0) {
      const validTrials = evidence.trials.filter((_trial, index) => !invalidIndexes.has(index))
      const invalidTrials = evidence.trials.flatMap((trial, index) => !invalidIndexes.has(index) ? [] : [{
        taskName: trial.taskName,
        trialName: trial.trialName!,
        runId: trial.runId!,
        attempt: trial.attempt!,
        status: 'errored' as const,
        invalidReason: 'infrastructure_failure',
      }])
      const rewards = validTrials.map(trial => trial.rewards.reward!)
      const validScore = rewards.length === 0 ? 0 : rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length
      const validPassed = rewards.filter(reward => reward > 0).length
      return {
        ...evidence,
        completeness: 'partial',
        primaryReward: validScore,
        summary: {
          total: validTrials.length,
          passed: validPassed,
          failed: validTrials.length - validPassed,
          score: validScore,
        },
        trials: validTrials,
        invalidTrials,
      }
    }
    return evidence
  }
  async rerun(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
  ): Promise<EvaluationRerunResult> {
    const evidence = await this.evaluate(round, request, signal, { provider: attempt.provider, evalId: attempt.evalId })
    const tasks = selector.mode === 'invalid' ? ['task-1'] : selector.taskNames
    const remainingInvalidTasks = [...new Set(evidence.invalidTrials.map(trial => trial.taskName))]
    return {
      provider: attempt.provider,
      evalId: attempt.evalId,
      selectedTasks: [...tasks],
      repairedTasks: tasks.filter(task => !remainingInvalidTasks.includes(task)),
      remainingInvalidTasks,
      remainingInvalidTrials: evidence.invalidTrials.map(trial => ({ taskId: trial.taskName, attempt: trial.attempt })),
      evalStatus: evidence.completeness === 'complete' ? 'succeeded' : 'failed',
      evidence,
    }
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  } while (Date.now() < deadline)
  throw new Error('condition not reached')
}

async function setup(
  candidateScore = 0.8,
  mismatchSeedCondition = false,
  maxCandidates = 1,
  generationAttemptTimeoutMs = 300_000,
  survivors = 1,
  heldOutDelta = 0,
  maxGenerationAttempts = 2,
  generationRoundTimeoutMs = generationAttemptTimeoutMs * maxGenerationAttempts * maxCandidates,
  skillCoordinator?: SkillMetaCoordinator,
) {
  const git = await createGitHarnessFixture()
  roots.push(git.root)
  const registry = new EvolutionRegistryStore(join(git.root, 'state'))
  const builder = new HarnessBuilder({
    repositoryPath: git.repository, targetRoot: git.targetRoot, dshBaseRef: git.baseRef,
    toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
  })
  const workspaces = new CandidateWorkspaceManager({
    repositoryPath: git.repository, targetRoot: git.targetRoot,
    rootForEvolution: id => join(registry.evolutionRoot(id), 'candidate-worktrees'),
    maxFiles: 64, maxBytes: 2_000_000, maxDiffBytes: 1_000_000,
  })
  const evaluator = new FakeEvaluator(candidateScore, heldOutDelta, mismatchSeedCondition)
  const defaults = evolutionSpec()
  const promotionPolicy = {
    minimumCandidateScore: 0.7, minimumAbsoluteGain: 0.1, requireNoRegression: true,
    maxHeldOutRegression: 0, maxRequiredRegressions: 0,
  }
  const metas = new Map<string, FakeMeta>()
  const service = new RefineService(registry, builder, workspaces, (spec, digest, store) => {
    if (skillCoordinator !== undefined) return new SkillMetaSessionManager(store, skillCoordinator, {
      evolutionId: spec.evolutionId, specDigest: digest, metaAgent: spec.metaAgent,
    })
    const meta = new FakeMeta(spec.evolutionId, store, digest)
    metas.set(spec.evolutionId, meta)
    return meta as never
  }, evaluator, {
    workspaceRoot: git.root, metaAgent: defaults.metaAgent,
    candidateGeneration: {
      ...defaults.candidateGeneration,
      maxCandidates,
      budget: {
        attemptTimeoutMs: generationAttemptTimeoutMs,
        maxAttemptsPerCandidate: maxGenerationAttempts,
        roundTimeoutMs: generationRoundTimeoutMs,
      },
    },
    rollout: defaults.rollout,
    evaluation: defaults.evaluation, selection: { ...defaults.selection, survivors },
    toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', promotionPolicy) },
    seedTaskRef: 'seed', heldOutRef: 'held-out', taskBudgetMs: 60_000,
    initialChampion: { schemaVersion: 2, ref: git.championRef, manifestDigest: git.manifest.digest, updatedAt: 'initial' },
    publishedPointer: true, maxLiveMetaSessions: 4,
  })
  await builder.initialize()
  await service.initialize()
  return { git, registry, service, evaluator, metas }
}

async function editing(service: RefineService, evolutionId: string, roundId: string): Promise<RefinementRound> {
  const store = service.registry.stateStore(evolutionId)
  return eventually(() => store.readRound(roundId) as Promise<RefinementRound>, round => round?.status === 'candidate-editing')
}

async function finalize(service: RefineService, round: RefinementRound): Promise<void> {
  const active = service.activeEntry(round.roundId)
  if (active?.workspace === undefined || round.baseline === undefined) throw new Error('round is not editable')
  const current = await active.store.readRound(round.roundId)
  const candidate = current?.candidatePool.find(value => value.workspaceId === active.workspace?.workspaceId)
  const sessionId = candidate?.metaSessionId
  if (sessionId === undefined || candidate === undefined) throw new Error('candidate Meta session is unavailable')
  await eventually(async () => {
    try { return service.workspaceManager.resolve(sessionId).workspaceId }
    catch { return undefined }
  }, value => value === active.workspace!.workspaceId)
  await mkdir(join(active.workspace.targetPath, 'prompts'), { recursive: true })
  await writeFile(join(active.workspace.targetPath, 'prompts', `${candidate.candidateId}.md`), 'improved context\n')
  const meta: MetaAttribution = { evolutionId: round.evolutionId, sessionId, requestHeaderSeq: 1, proposalEventSeq: 2 }
  const runRefs = [
    ...round.baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
    ...round.baseline.invalidTrials.map(trial => trial.runId),
  ]
  const failed = [
    ...round.baseline.trials.flatMap(trial => (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : []),
  ]
  await service.submitFinalization(round.evolutionId, round.roundId, {
    rationale: 'fix observed failures', expectedOutcome: 'higher reward', evidenceRefs: [round.baseline.evalId], semanticTargets: ['context', 'routing'],
  }, undefined, meta, {
    evolutionId: round.evolutionId, roundId: round.roundId, candidateId: candidate.candidateId, baselineEvalId: round.baseline.evalId,
    summaryAccessed: true, accessedRefs: [round.baseline.evalId, ...runRefs], diagnosedRunRefs: failed,
    diagnosisReceipts: diagnosisReceipts(failed), citedRefs: [round.baseline.evalId],
  })
}

async function decline(service: RefineService, round: RefinementRound): Promise<void> {
  const active = service.activeEntry(round.roundId)
  if (active?.workspace === undefined || round.baseline === undefined) throw new Error('round is not editable')
  const current = await active.store.readRound(round.roundId)
  const candidate = current?.candidatePool.find(value => value.workspaceId === active.workspace?.workspaceId)
  const sessionId = candidate?.metaSessionId
  if (sessionId === undefined || candidate === undefined) throw new Error('candidate Meta session is unavailable')
  const failed = round.baseline.trials.flatMap(trial => (
    (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : []
  ))
  await service.submitFinalization(round.evolutionId, round.roundId, null, {
    rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [],
  }, {
    evolutionId: round.evolutionId, sessionId, requestHeaderSeq: 1, proposalEventSeq: 2,
  }, {
    evolutionId: round.evolutionId,
    roundId: round.roundId,
    candidateId: candidate.candidateId,
    baselineEvalId: round.baseline.evalId,
    summaryAccessed: true,
    accessedRefs: [round.baseline.evalId, ...failed],
    diagnosedRunRefs: failed,
    diagnosisReceipts: diagnosisReceipts(failed),
    citedRefs: [],
  })
}

async function continueWithLegacyPopulationParent(
  service: RefineService,
  evolutionId: string,
  parent: import('../../src/types.js').PopulationMember,
) {
  const write = RefineStateStore.prototype.writeRound
  const legacyWrite = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (this: RefineStateStore, value: RefinementRound) {
    if (value.evolutionId === evolutionId && value.status === 'queued') {
      const legacy = structuredClone(value)
      delete legacy.championParent
      legacy.parentAllocations = legacy.candidatePool.map(candidate => ({ candidateId: candidate.candidateId,
        parentCandidateId: parent.candidateId, parentHarnessRef: parent.harnessRef, parentHarnessDigest: parent.harnessDigest }))
      legacy.candidatePool = legacy.candidatePool.map(candidate => ({ ...candidate,
        parentCandidateIds: [parent.candidateId], parentHarnessRef: parent.harnessRef }))
      return write.call(this, legacy)
    }
    return write.call(this, value)
  })
  try { return await service.continueEvolution('api', evolutionId) }
  finally { legacyWrite.mockRestore() }
}

describe('RefineService evolution workspaces', () => {
  function durable(evaluator: FakeEvaluator): void {
    evaluator.prepareSubmission = (round, request) => ({
      provider: 'fake', idempotencyKey: `intent-${round.roundId}-${request.phase}`,
      parameters: { frozen: 'original' },
    })
  }

  function restart(service: RefineService, evaluator: RefineEvaluator): RefineService {
    return new RefineService(service.registry, service.builder, service.workspaceManager,
      service.createMetaSession, evaluator, service.options, service.components)
  }

  it('persists submission ownership before the first remote side effect', async () => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    const originalReserve = evaluator.reserve.bind(evaluator)
    evaluator.reserve = async (round, request, signal, intent) => {
      const stored = await service.registry.stateStore(round.evolutionId).readRound(round.roundId)
      expect(stored?.pendingEvaluationSubmissions).toMatchObject([{ intent, request,
        owner: { role: 'baseline', harnessRef: request.harnessRef } }])
      expect(stored?.evaluationAttempts ?? []).toHaveLength(0)
      expect(signal?.aborted).toBe(false)
      return originalReserve(round, request)
    }
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    expect(round.pendingEvaluationSubmissions).toEqual([])
    expect(round.evaluationAttempts?.[0]?.submissionIntent?.parameters).toEqual({ frozen: 'original' })
    await service.dispose()
  })

  it('recovers and cancels a submitted evaluation when the acknowledgement is lost', async () => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    const submissions: string[] = []
    const cancellations: string[] = []
    evaluator.reserve = async (_round, _request, _signal, intent) => {
      submissions.push(intent!.idempotencyKey)
      if (submissions.length === 1) throw Object.assign(new Error('submission reply lost'), { code: 'reply_lost' })
      return { provider: 'fake', evalId: 'remote-eval' }
    }
    evaluator.cancelReservation = async reservation => { cancellations.push(reservation.evalId) }
    const admission = await service.admit('api')
    const round = await eventually(() => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId), value => value?.status === 'failed')
    expect(submissions).toHaveLength(2)
    expect(new Set(submissions).size).toBe(1)
    expect(cancellations).toEqual(['remote-eval'])
    expect(round).toMatchObject({ pendingEvaluationSubmissions: [],
      evaluationAttempts: [{ evalId: 'remote-eval', status: 'cancelled', failure: { code: 'reply_lost' } }] })
    expect(evaluator.calls).toEqual([])
    await service.dispose()
  })

  it('cancels accepted work if writing the returned eval ownership fails', async () => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    const cancelled: string[] = []
    evaluator.reserve = async round => {
      const store = service.activeEntry(round.roundId)!.store
      const write = store.writeRound.bind(store)
      let injected = false
      store.writeRound = async value => {
        if (!injected && value.evaluationAttempts?.some(attempt => attempt.status === 'running')) {
          injected = true
          throw new Error('ownership write failed')
        }
        return write(value)
      }
      return { provider: 'fake', evalId: 'remote-eval' }
    }
    evaluator.cancelReservation = async reservation => { cancelled.push(reservation.evalId) }
    const admission = await service.admit('api')
    const round = await eventually(() => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId), value => value?.status === 'failed')
    expect(cancelled).toEqual(['remote-eval'])
    expect(round?.pendingEvaluationSubmissions).toEqual([])
    expect(round?.failure?.message).toBe('ownership write failed')
    expect(evaluator.calls).toEqual([])
    await service.dispose()
  })

  it('propagates abort into reservation and cleans up with an independent signal', async () => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    const started = Promise.withResolvers<void>()
    let calls = 0
    let cancelled = false
    evaluator.reserve = async (_round, _request, signal) => {
      expect(signal?.aborted).toBe(false)
      calls += 1
      if (calls === 1) {
        started.resolve()
        await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
      }
      return { provider: 'fake', evalId: 'remote-eval' }
    }
    evaluator.cancelReservation = async () => { cancelled = true }
    const admission = await service.admit('api')
    await started.promise
    await service.dispose()
    expect(calls).toBe(2)
    expect(cancelled).toBe(true)
    const round = await service.registry.stateStore(admission.evolutionId).readRound(admission.roundId)
    expect(round?.pendingEvaluationSubmissions).toEqual([])
    expect(evaluator.calls).toEqual([])
  })

  it.each([false, true])('recovers unresolved ownership after restart (server ID saved: %s)', async knownId => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    let unavailable = true
    const keys: string[] = []
    const cancelled: string[] = []
    evaluator.reserve = async (_round, _request, _signal, intent) => {
      keys.push(intent!.idempotencyKey)
      expect(intent!.parameters).toEqual({ frozen: 'original' })
      if (unavailable && !knownId) throw new Error('submission reply unavailable')
      return { provider: 'fake', evalId: 'remote-eval' }
    }
    evaluator.evaluate = async () => { throw Object.assign(new Error('observer failed'), { code: 'observer_failed' }) }
    evaluator.cancelReservation = async reservation => {
      if (unavailable) throw Object.assign(new Error('cancel unavailable'), { code: 'cancel_unavailable' })
      cancelled.push(reservation.evalId)
    }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    expect(failed?.pendingEvaluationSubmissions).toHaveLength(1)
    expect(failed?.pendingEvaluationSubmissions?.[0]?.reservation !== undefined).toBe(knownId)
    expect(failed?.pendingEvaluationSubmissions?.[0]?.cleanupFailure).toBeDefined()
    expect((await service.status(admission.evolutionId, admission.roundId)).evaluationCleanupFailures).toHaveLength(1)
    if (knownId) expect(failed?.evaluationAttempts?.[0]).toMatchObject({
      failure: { code: 'observer_failed', message: 'observer failed' },
      cleanupFailure: { code: 'cancel_unavailable' },
    })
    await service.dispose()
    unavailable = false
    evaluator.prepareSubmission = () => { throw new Error('must replay persisted intent, not prepare a new one') }
    const recovering = restart(service, evaluator)
    await recovering.initialize()
    expect(cancelled).toEqual(['remote-eval'])
    expect(new Set(keys).size).toBe(1)
    expect((await store.readRound(admission.roundId))?.pendingEvaluationSubmissions).toEqual([])
    await recovering.initialize()
    expect(cancelled).toHaveLength(1)
    await recovering.dispose()
  })

  it('recovers an interrupted owned attempt before validating the current runtime', async () => {
    const { service, evaluator } = await setup()
    durable(evaluator)
    evaluator.evaluate = async () => { throw new Error('observer stopped') }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    await service.dispose()
    if (failed === undefined) throw new Error('missing failed round')
    const { failure: _roundFailure, ...interrupted } = failed
    await store.writeRound({
      ...interrupted, status: 'baseline-running', pendingEvaluationSubmissions: [],
      evaluationAttempts: failed.evaluationAttempts!.map(attempt => {
        const { failure: _failure, completedAt: _completedAt, ...owned } = attempt
        return { ...owned, status: 'running' as const }
      }),
    })
    const cancelled: string[] = []
    evaluator.cancelReservation = async reservation => { cancelled.push(reservation.evalId) }
    Object.assign(evaluator, { preflight: async () => { throw new Error('current runtime unavailable') } })
    const recovering = restart(service, evaluator)
    await expect(recovering.initialize()).rejects.toThrow('current runtime unavailable')
    expect(cancelled).toEqual([failed.evaluationAttempts![0]!.evalId])
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'failed', pendingEvaluationSubmissions: [], evaluationAttempts: [{ status: 'cancelled' }],
    })
    Object.assign(evaluator, { preflight: async () => {} })
    await recovering.initialize()
    expect(cancelled).toHaveLength(1)
    await recovering.dispose()
  })

  it('persists a running evaluation attempt before invoking the reserved evaluator', async () => {
    const { service, evaluator } = await setup()
    const original = evaluator.evaluate.bind(evaluator)
    const gate = Promise.withResolvers<void>()
    let held = true
    evaluator.evaluate = async (...args) => {
      if (held) {
        held = false
        await gate.promise
      }
      return original(...args)
    }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const running = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.evaluationAttempts?.some(attempt => attempt.status === 'running') === true,
    )
    if (running === undefined) throw new Error('running round disappeared')
    expect(running?.evaluationAttempts).toMatchObject([{
      provider: 'fake', phase: 'seed-baseline', status: 'running',
      owner: { role: 'baseline', harnessRef: running.targetHarnessRef },
    }])
    gate.resolve()
    await editing(service, admission.evolutionId, admission.roundId)
    expect((await store.readRound(admission.roundId))?.evaluationAttempts?.[0]).toMatchObject({ status: 'settled' })
    await service.dispose()
  })

  it('retains a failed reserved evaluation attempt for diagnosis', async () => {
    const { service, evaluator } = await setup()
    evaluator.evaluate = async () => { throw Object.assign(new Error('reserved evaluation failed'), { code: 'fixture_failure' }) }
    const admission = await service.admit('api')
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'failed',
    )
    expect(terminal?.evaluationAttempts).toMatchObject([{
      provider: 'fake', phase: 'seed-baseline', status: 'failed',
      completedAt: expect.any(String),
      failure: { code: 'fixture_failure', message: 'reserved evaluation failed' },
    }])
    await service.dispose()
  })

  it.each(['observer', 'dispose', 'evidence-write'] as const)('owns and cancels the rerun itself after %s failure', async failure => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'7'.repeat(32)}`
    const rerunReservation: EvaluationRerunReservation = {
      provider: 'hitch-cli', evalId, rerunId: `rerun_${'9'.repeat(32)}`, parameters: { root: 'original-root' },
    }
    const evaluate = evaluator.evaluate.bind(evaluator)
    let first = true
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async (...args) => {
      if (first) { first = false; throw new Error('invalid baseline') }
      return evaluate(...args)
    }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    let remoteActive = false
    const cancelRerun = vi.fn(async (owned: EvaluationRerunReservation) => {
      expect(owned).toEqual(rerunReservation)
      remoteActive = false
    })
    Object.assign(evaluator, { prepareRerun: () => rerunReservation, cancelRerun })
    const rerun = evaluator.rerun.bind(evaluator)
    evaluator.rerun = async (...args) => {
      expect((await store.readRound(admission.roundId))?.pendingEvaluationRerun?.reservation).toEqual(rerunReservation)
      remoteActive = true
      if (failure === 'observer') throw Object.assign(new Error('rerun observer failed'), { code: 'observer_failed' })
      if (failure === 'dispose') await new Promise<void>((_resolve, reject) => args[4].addEventListener('abort', () => reject(args[4].reason), { once: true }))
      return rerun(...args)
    }
    const write = RefineStateStore.prototype.writeRound
    const writeSpy = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (this: RefineStateStore, value) {
      if (failure === 'evidence-write' && value.roundId === admission.roundId && value.evaluationRepairResume !== undefined) {
        throw new Error('repaired evidence write failed')
      }
      return write.call(this, value)
    })
    try {
      const pending = service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
      const rejected = expect(pending).rejects.toThrow(failure === 'observer' ? /observer failed/u : failure === 'evidence-write' ? /evidence write failed/u : /disposed/u)
      if (failure === 'dispose') {
        await eventually(async () => remoteActive, value => value)
        await service.dispose()
      }
      await rejected
      expect(cancelRerun).toHaveBeenCalledTimes(1)
      expect(remoteActive).toBe(false)
      expect((await store.readRound(admission.roundId))?.pendingEvaluationRerun).toBeUndefined()
      expect((await store.readRound(admission.roundId))?.evaluationAttempts?.[0]?.status).toBe('failed')
    } finally { writeSpy.mockRestore(); await service.dispose() }
  })

  it('retains failed rerun cleanup and retries the same identity on restart', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'6'.repeat(32)}`
    const reservation: EvaluationRerunReservation = { provider: 'hitch-cli', evalId, rerunId: `rerun_${'8'.repeat(32)}`, parameters: { root: 'frozen-root' } }
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async () => { throw new Error('invalid baseline') }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    let unavailable = true
    const cancelled: EvaluationRerunReservation[] = []
    Object.assign(evaluator, {
      prepareRerun: () => reservation,
      cancelRerun: async (owned: EvaluationRerunReservation) => {
        cancelled.push(owned)
        if (unavailable) throw Object.assign(new Error('daemon unavailable'), { code: 'cancel_unavailable' })
      },
    })
    const cancelEval = vi.spyOn(evaluator, 'cancelReservation')
    evaluator.rerun = async () => { throw Object.assign(new Error('reply lost'), { code: 'reply_lost' }) }
    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })).rejects.toThrow('reply lost')
    expect(await store.readRound(admission.roundId)).toMatchObject({
      pendingEvaluationRerun: { reservation, cleanupFailure: { code: 'cancel_unavailable' } },
      evaluationAttempts: [{ failure: { code: 'reply_lost' }, cleanupFailure: { code: 'cancel_unavailable' } }],
    })
    expect(await service.status(admission.evolutionId, admission.roundId)).toMatchObject({
      evaluationCleanupFailures: [{ evalId, rerunId: reservation.rerunId, code: 'cancel_unavailable' }],
    })
    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })).rejects.toThrow(/cleanup/u)
    await expect(service.initialize()).rejects.toThrow('daemon unavailable')
    unavailable = false
    await service.initialize()
    const recovered = await store.readRound(admission.roundId)
    expect(recovered?.pendingEvaluationRerun).toBeUndefined()
    expect(recovered?.evaluationAttempts?.[0]?.cleanupFailure).toBeUndefined()
    expect(recovered?.evaluationAttempts?.[0]?.failure?.code).toBe('reply_lost')
    expect(cancelled).toEqual([reservation, reservation, reservation])
    expect(cancelEval).not.toHaveBeenCalled()
    await service.initialize()
    expect(cancelled).toHaveLength(3)
    await service.dispose()
  })

  it('reruns a failed Hitch attempt under the same eval id and continues the round', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'7'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let firstReservation = true
    let reservation = 0
    let firstEvaluation = true
    evaluator.reserve = async () => {
      if (firstReservation) {
        firstReservation = false
        return { provider: 'hitch-cli', evalId }
      }
      return {
        provider: 'hitch-cli',
        evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}`,
      }
    }
    evaluator.evaluate = async (...args) => {
      if (firstEvaluation) {
        firstEvaluation = false
        throw Object.assign(new Error('invalid task observation'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    const rerunReservation: EvaluationRerunReservation = { provider: 'hitch-cli', evalId, rerunId: `rerun_${'4'.repeat(32)}`, parameters: { root: '' } }
    const cancelRerun = vi.fn(async () => {})
    Object.assign(evaluator, { prepareRerun: () => rerunReservation, cancelRerun })
    const rerun = await service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    expect(rerun).toMatchObject({ evalId, evalStatus: 'succeeded', remainingInvalidTasks: [] })
    const resumed = await editing(service, admission.evolutionId, admission.roundId)
    expect(resumed.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({
      provider: 'hitch-cli', status: 'repair-completed', completedAt: expect.any(String),
    })
    expect(resumed.evaluationRepairResume).toMatchObject({ provider: 'hitch-cli', evalId })
    expect(resumed.pendingEvaluationRerun).toBeUndefined()
    expect(cancelRerun).not.toHaveBeenCalled()
    expect(resumed.baseline).toMatchObject({ evalId })
    await service.dispose()
  })

  it('continues the round when a rerun still has invalid cells but yields partial evidence', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'3'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let firstReservation = true
    let reservation = 0
    let firstEvaluation = true
    evaluator.reserve = async () => firstReservation
      ? (firstReservation = false, { provider: 'hitch-cli', evalId })
      : { provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}` }
    evaluator.evaluate = async (...args) => {
      if (firstEvaluation) {
        firstEvaluation = false
        throw Object.assign(new Error('invalid task observation'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    evaluator.partialInvalidByCall.set(1, [9])

    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    const rerun = await service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    expect(rerun).toMatchObject({
      evalId,
      evalStatus: 'failed',
      remainingInvalidTasks: ['task-9'],
      evidence: { completeness: 'partial', plannedTrialCount: 10, invalidTrials: [{ taskName: 'task-9' }] },
    })

    const resumed = await editing(service, admission.evolutionId, admission.roundId)
    expect(resumed.baseline).toMatchObject({ evalId, completeness: 'partial' })
    expect(resumed.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'repair-completed' })
    await finalize(service, resumed)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    expect(terminal?.evaluation?.seedPairing).toMatchObject({ planned: 10, paired: 9, excluded: 1, baselineInvalid: 1 })
    expect(terminal?.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'settled' })
    await service.dispose()
  })

  it('rejects an invalid rerun selector before mutating durable round state', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'6'.repeat(32)}`
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async () => { throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' }) }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')

    await expect(service.rerunEvaluation(
      admission.evolutionId,
      admission.roundId,
      evalId,
      { mode: 'tasks', taskNames: [] },
    )).rejects.toThrow(/at least one non-empty task name/u)
    expect(await store.readRound(admission.roundId)).toEqual(failed)
    await service.dispose()
  })

  it('rejects evaluation repair for an archived evolution before invoking Hitch', async () => {
    const { service, evaluator, registry, metas } = await setup()
    const evalId = `eval_${'4'.repeat(32)}`
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async () => { throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' }) }
    let rerunCalled = false
    evaluator.rerun = async () => {
      rerunCalled = true
      throw new Error('Hitch must not be invoked for an archived evolution')
    }
    const admission = await service.admit('api')
    const store = metas.get(admission.evolutionId)?.store
    if (store === undefined) throw new Error('evolution runtime store is unavailable')
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    await registry.archive(admission.evolutionId)

    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .rejects.toThrow(/archived/u)
    expect(rerunCalled).toBe(false)
    expect(await store.readRound(admission.roundId)).toEqual(failed)
    await expect(service.status(admission.evolutionId, admission.roundId)).resolves.not.toHaveProperty('repairableEvaluations')
    await service.dispose()
  })

  it('rejects evaluation repair when the champion manifest identity changed', async () => {
    const { service, evaluator, registry, metas } = await setup()
    const evalId = `eval_${'5'.repeat(32)}`
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async () => { throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' }) }
    let rerunCalled = false
    evaluator.rerun = async () => {
      rerunCalled = true
      throw new Error('Hitch must not be invoked for stale champion identity')
    }
    const admission = await service.admit('api')
    const store = metas.get(admission.evolutionId)?.store
    if (store === undefined) throw new Error('evolution runtime store is unavailable')
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    const champion = await store.readChampion()
    if (champion === undefined) throw new Error('test evolution has no champion')
    await store.writeChampion({ ...champion, manifestDigest: `sha256:${'f'.repeat(64)}` })

    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .rejects.toThrow(/no longer matches/u)
    expect(rerunCalled).toBe(false)
    expect(await store.readRound(admission.roundId)).toEqual(failed)
    await expect(service.status(admission.evolutionId, admission.roundId)).resolves.not.toHaveProperty('repairableEvaluations')
    await service.dispose()
  })

  it('keeps a failed seed candidate repairable and resumes selection after rerun', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'8'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let failedSeed = false
    let reservation = 0
    evaluator.reserve = async (_round, request) => request?.phase === 'seed-candidate'
      ? { provider: 'hitch-cli', evalId }
      : { provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, 'b')}` }
    evaluator.evaluate = async (...args) => {
      if (args[1].phase === 'seed-candidate' && !failedSeed) {
        failedSeed = true
        throw Object.assign(new Error('invalid seed candidate observation'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    const admission = await service.admit('api')
    const initial = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, initial)
    const store = service.registry.stateStore(admission.evolutionId)
    const repairable = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    expect(repairable?.status).toBe('failed')
    expect(repairable?.decision).toBeUndefined()
    expect(repairable?.candidatePool[0]?.status).toBe('failed')
    expect(repairable?.candidatePool[0]?.seedEvaluation).toBeUndefined()
    await expect(service.status(admission.evolutionId, admission.roundId)).resolves.toMatchObject({
      repairableEvaluations: [{ provider: 'hitch-cli', evalId, phase: 'seed-candidate', repetitions: 1 }],
    })
    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .resolves.toMatchObject({ evalStatus: 'succeeded', evalId })
    const terminal = await eventually(
      () => store.readRound(admission.roundId),
      value => value !== undefined && ['accepted', 'rejected', 'failed'].includes(value.status),
    )
    expect(terminal?.status, terminal?.failure?.message).toBe('accepted')
    expect(terminal?.candidatePool[0]).toMatchObject({ seedEvaluation: { evalId } })
    expect(terminal?.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'settled' })
    expect(terminal?.evaluationRepairResume).toBeUndefined()
    await service.dispose()
  })

  it('aborts and waits for an active evaluation repair during dispose', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'9'.repeat(32)}`
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async () => { throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' }) }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    evaluator.rerun = async (_round, _request, _attempt, _selector, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const pending = service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    let rejection: unknown
    const observed = pending.catch(error => { rejection = error })
    await eventually(() => store.readRound(admission.roundId), value =>
      value?.status === 'repairing-evaluation' && value.evaluationAttempts?.[0]?.status === 'rerunning')
    await service.dispose()
    await observed
    expect(rejection).toMatchObject({ message: 'RefineService disposed' })
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'failed',
      evaluationAttempts: [{ status: 'failed', failure: { code: 'evaluation_rerun_aborted' } }],
    })
  })

  it('does not start a new active drive when dispose overlaps the repair-completed write', async () => {
    const { service, evaluator, registry, metas } = await setup()
    const evalId = `eval_${'e'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let first = true
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async (...args) => {
      if (first) {
        first = false
        throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    const admission = await service.admit('api')
    const store = metas.get(admission.evolutionId)?.store
    if (store === undefined) throw new Error('evolution runtime store is unavailable')
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')

    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const originalWriteRound = store.writeRound.bind(store)
    let blockCompletedRepair = true
    store.writeRound = async value => {
      if (blockCompletedRepair && value.status === 'repairing-evaluation'
        && value.evaluationAttempts?.some(attempt => attempt.status === 'repair-completed')) {
        blockCompletedRepair = false
        writeStarted.resolve()
        await releaseWrite.promise
      }
      await originalWriteRound(value)
    }

    const pending = service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    let rejection: unknown
    const observed = pending.catch(error => { rejection = error })
    await writeStarted.promise
    const disposing = service.dispose()
    releaseWrite.resolve()
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        disposing,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('dispose did not finish after repair handoff was stopped')), 2_000)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    await observed

    expect(rejection).toMatchObject({ message: 'RefineService disposed' })
    expect(service.activeEntry(admission.roundId)).toBeUndefined()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'repairing-evaluation',
      baseline: { evalId },
      evaluationRepairResume: { provider: 'hitch-cli', evalId, completedAt: expect.any(String) },
      evaluationAttempts: [{ status: 'repair-completed', completedAt: expect.any(String) }],
    })
    const lock = await store.acquireRoundLock(admission.roundId)
    await lock.release()

    await registry.archive(admission.evolutionId)
    const recovering = new RefineService(
      registry,
      service.builder,
      service.workspaceManager,
      (spec, digest, runtimeStore) => new FakeMeta(spec.evolutionId, runtimeStore, digest) as never,
      evaluator,
      service.options,
      service.components,
    )
    await recovering.initialize()
    expect(recovering.activeEntry(admission.roundId)).toBeUndefined()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'repairing-evaluation',
      evaluationRepairResume: { evalId },
      evaluationAttempts: [{ status: 'repair-completed' }],
    })
    await recovering.dispose()
  })

  it('preserves and restarts a durable repair when dispose starts after the resumed drive transition', async () => {
    const { service, evaluator, registry, metas } = await setup()
    const evalId = `eval_${'f'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let firstReservation = true
    let reservation = 0
    let first = true
    evaluator.reserve = async () => {
      if (firstReservation) {
        firstReservation = false
        return { provider: 'hitch-cli', evalId }
      }
      return {
        provider: 'hitch-cli',
        evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}`,
      }
    }
    evaluator.evaluate = async (...args) => {
      if (first) {
        first = false
        throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    const admission = await service.admit('api')
    const store = metas.get(admission.evolutionId)?.store
    if (store === undefined) throw new Error('evolution runtime store is unavailable')
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')

    const populationReadStarted = Promise.withResolvers<void>()
    const releasePopulationRead = Promise.withResolvers<void>()
    const originalReadPopulation = store.readPopulation.bind(store)
    let blockResumedPopulationRead = true
    store.readPopulation = async () => {
      const value = await originalReadPopulation()
      const current = await store.readRound(admission.roundId)
      if (blockResumedPopulationRead && current?.status === 'baseline-running'
        && current.evaluationRepairResume?.evalId === evalId) {
        blockResumedPopulationRead = false
        populationReadStarted.resolve()
        await releasePopulationRead.promise
      }
      return value
    }

    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .resolves.toMatchObject({ evalStatus: 'succeeded' })
    await populationReadStarted.promise
    expect(service.activeEntry(admission.roundId)?.workspace).toBeUndefined()
    const disposing = service.dispose()
    releasePopulationRead.resolve()
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        disposing,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('dispose did not stop the handed-off drive')), 2_000)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }

    expect(service.activeEntry(admission.roundId)).toBeUndefined()
    expect((await store.readRound(admission.roundId))?.candidatePool[0]?.workspaceId).toBeUndefined()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'baseline-running',
      baseline: { evalId },
      evaluationRepairResume: { provider: 'hitch-cli', evalId, completedAt: expect.any(String) },
      evaluationAttempts: [{ status: 'repair-completed' }],
    })
    const lock = await store.acquireRoundLock(admission.roundId)
    await lock.release()

    const recovering = new RefineService(
      registry,
      service.builder,
      service.workspaceManager,
      (spec, digest, runtimeStore) => new FakeMeta(spec.evolutionId, runtimeStore, digest) as never,
      evaluator,
      service.options,
      service.components,
    )
    await recovering.initialize()
    const resumed = await editing(recovering, admission.evolutionId, admission.roundId)
    expect(resumed.evaluationRepairResume).toMatchObject({ evalId })
    expect(resumed.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'repair-completed' })
    await finalize(recovering, resumed)
    const terminal = await eventually(
      () => store.readRound(admission.roundId),
      value => value !== undefined && ['accepted', 'rejected', 'failed'].includes(value.status),
    )
    expect(terminal?.status, JSON.stringify(terminal?.candidatePool)).toBe('accepted')
    expect(terminal?.evaluationRepairResume).toBeUndefined()
    expect(terminal?.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'settled' })
    await recovering.dispose()
  })

  it('recovers an interrupted rerun atomically and idempotently on startup', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'a'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let first = true
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluate = async (...args) => {
      if (first) {
        first = false
        throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    if (failed === undefined) throw new Error('failed round disappeared')
    if (failed.evaluationAttempts === undefined) throw new Error('failed round has no evaluation attempt')
    const { failure: _roundFailure, ...interrupted } = failed
    const reservation: EvaluationRerunReservation = { provider: 'hitch-cli', evalId, rerunId: `rerun_${'5'.repeat(32)}`, parameters: { root: 'saved-root' } }
    const cancelRerun = vi.fn(async () => {})
    Object.assign(evaluator, { cancelRerun })
    const cancelEval = vi.spyOn(evaluator, 'cancelReservation')
    await store.writeRound({
      ...interrupted,
      status: 'repairing-evaluation',
      pendingEvaluationRerun: { reservation },
      evaluationAttempts: failed.evaluationAttempts.map(attempt => {
        const { completedAt: _completedAt, failure: _failure, ...running } = attempt
        return { ...running, status: 'rerunning' as const }
      }),
    })
    await service.initialize()
    expect(cancelRerun).toHaveBeenCalledExactlyOnceWith(reservation)
    expect(cancelEval).not.toHaveBeenCalled()
    const recovered = await store.readRound(admission.roundId)
    expect(recovered).toMatchObject({
      status: 'failed',
      evaluationAttempts: [{ status: 'failed', failure: { code: 'evaluation_rerun_interrupted_by_restart' } }],
    })
    await service.initialize()
    expect(await store.readRound(admission.roundId)).toEqual(recovered)
    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .resolves.toMatchObject({ evalStatus: 'succeeded' })
    await editing(service, admission.evolutionId, admission.roundId)
    await service.dispose()
  })

  it.each(['rerunning', 'repair-completed'] as const)(
    'resumes a repaired evaluation after restart from durable %s state',
    async repairStatus => {
      const { service, evaluator } = await setup()
      const evalId = `eval_${(repairStatus === 'rerunning' ? 'c' : 'd').repeat(32)}`
      const originalEvaluate = evaluator.evaluate.bind(evaluator)
      evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
      evaluator.evaluate = async () => { throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' }) }
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
      const attempt = failed?.evaluationAttempts?.[0]
      if (failed === undefined || attempt === undefined) throw new Error('failed round has no evaluation attempt')
      const request: EvaluationRequest = {
        phase: attempt.phase,
        dataset: attempt.dataset,
        harnessRef: attempt.requestedCommit,
        condition: failed.plan.seed,
      }
      const evidence = await originalEvaluate(
        failed,
        request,
        new AbortController().signal,
        { provider: attempt.provider, evalId: attempt.evalId },
      )
      const { failure: _roundFailure, ...pending } = failed
      const { completedAt: _completedAt, failure: _attemptFailure, ...repairing } = attempt
      await store.writeRound({
        ...pending,
        status: 'repairing-evaluation',
        baseline: evidence,
        parentBaselines: [{
          parentCandidateId: attempt.owner.candidateId,
          parentHarnessRef: attempt.owner.harnessRef,
          evidence,
        }],
        evaluationAttempts: [{
          ...repairing,
          status: repairStatus,
          ...(repairStatus === 'repair-completed' ? { completedAt: 'repair-finished' } : {}),
        }],
      })

      await expect(service.initialize()).resolves.toBeUndefined()
      const resumed = await editing(service, admission.evolutionId, admission.roundId)
      expect(resumed.baseline).toMatchObject({ evalId })
      expect(resumed.evaluationAttempts?.[0]).toMatchObject({ status: 'repair-completed', completedAt: expect.any(String) })
      expect(resumed.evaluationRepairResume).toMatchObject({ provider: 'hitch-cli', evalId })
      await service.dispose()
    },
  )

  it('cleans up prepared pending resumes when a later startup resume fails', async () => {
    const { service, evaluator, registry } = await setup()
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let reservation = 0
    let failures = 2
    evaluator.reserve = async () => ({
      provider: 'hitch-cli',
      evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}`,
    })
    evaluator.evaluate = async (...args) => {
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error('invalid baseline'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }

    const admissions = []
    for (let index = 0; index < 2; index += 1) {
      const admission = await service.admit('api')
      admissions.push(admission)
      const store = registry.stateStore(admission.evolutionId)
      const failed = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
      const attempt = failed?.evaluationAttempts?.[0]
      if (failed === undefined || attempt === undefined) throw new Error('failed round has no evaluation attempt')
      const request: EvaluationRequest = {
        phase: attempt.phase,
        dataset: attempt.dataset,
        harnessRef: attempt.requestedCommit,
        condition: failed.plan.seed,
      }
      const evidence = await originalEvaluate(
        failed,
        request,
        new AbortController().signal,
        { provider: attempt.provider, evalId: attempt.evalId },
      )
      const { failure: _roundFailure, ...pending } = failed
      const { completedAt: _completedAt, failure: _attemptFailure, ...repairing } = attempt
      await store.writeRound({
        ...pending,
        status: 'repairing-evaluation',
        baseline: evidence,
        parentBaselines: [{
          parentCandidateId: attempt.owner.candidateId,
          parentHarnessRef: attempt.owner.harnessRef,
          evidence,
        }],
        evaluationAttempts: [{ ...repairing, status: 'repair-completed', completedAt: 'repair-finished' }],
      })
    }
    await service.dispose()

    let metaCreations = 0
    const recovering = new RefineService(
      registry,
      service.builder,
      service.workspaceManager,
      (spec, digest, store) => {
        metaCreations += 1
        if (metaCreations === 2) throw new Error('second pending runtime failed')
        return new FakeMeta(spec.evolutionId, store, digest) as never
      },
      evaluator,
      service.options,
      service.components,
    )
    await expect(recovering.initialize()).rejects.toThrow(/second pending runtime failed/u)

    for (const admission of admissions) {
      expect(recovering.activeEntry(admission.roundId)).toBeUndefined()
      const store = registry.stateStore(admission.evolutionId)
      const lock = await store.acquireRoundLock(admission.roundId)
      await lock.release()
    }
    expect(await registry.stateStore(admissions[0]!.evolutionId).readRound(admissions[0]!.roundId)).toMatchObject({
      status: 'repairing-evaluation',
      evaluationAttempts: [{ status: 'repair-completed' }],
    })
  })

  it('creates a fresh isolated evolution for every admission', async () => {
    const { service } = await setup()
    const first = await service.admit('api', { name: 'first' })
    const second = await service.admit('api', { name: 'second', focus: ['context', 'routing'] })
    expect(first.evolutionId).not.toBe(second.evolutionId)
    const [left, right] = await Promise.all([editing(service, first.evolutionId, first.roundId), editing(service, second.evolutionId, second.roundId)])
    expect(left.advisoryFocus).toBeUndefined()
    expect(right.advisoryFocus).toEqual(['context', 'routing'])
    expect(service.activeEntry(first.roundId)?.workspace?.worktreePath).not.toBe(service.activeEntry(second.roundId)?.workspace?.worktreePath)
    await service.dispose()
  })

  it('commits the sealed tree and promotes only its evolution champion', async () => {
    const { service, evaluator, git } = await setup()
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    const terminalCandidate = terminal?.candidatePool[0]
    if (terminalCandidate === undefined) throw new Error('accepted round has no candidate')
    expect(terminal?.candidatePool[0]?.diff?.files).toContainEqual(expect.objectContaining({
      path: `prompts/${terminalCandidate.candidateId}.md`, change: 'created',
    }))
    expect(terminal?.candidatePool[0]?.sealedVersion).toMatchObject({
      commitOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
      treeOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    })
    expect((await store.readChampion())?.ref).not.toBe(git.championRef)
    expect(await store.readPopulation()).toMatchObject({
      generation: 1,
      members: [{
        candidateId: terminal?.promotedCandidateId,
        parentCandidateIds: [`initial-${git.championRef}`],
      }],
    })
    const indexed = await eventually(async () => {
      const [header, row] = (await readFile(service.registry.experimentsPath, 'utf8')).trimEnd().split('\n')
      return Object.fromEntries(header!.split('\t').map((field, index) => [field, row!.split('\t')[index]]))
    }, value => value.decision === 'promoted')
    expect(indexed).toMatchObject({
      evolution_id: admission.evolutionId,
      round_id: admission.roundId,
      candidate_id: terminal?.promotedCandidateId,
      status: 'selected',
      candidate_commit: terminal?.candidatePool[0]?.sealedVersion?.commitOid,
      decision: 'promoted',
      record_path: `evolutions/${admission.evolutionId}/rounds/${admission.roundId}.json`,
    })
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
    expect(terminal?.evaluationAttempts).toHaveLength(4)
    expect(terminal?.evaluationAttempts?.every(attempt => attempt.status === 'settled' && attempt.completedAt !== undefined)).toBe(true)
    expect(terminal?.evaluationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'seed-baseline', owner: expect.objectContaining({ role: 'baseline' }) }),
      expect.objectContaining({ phase: 'seed-candidate', owner: expect.objectContaining({ role: 'candidate', candidateId: terminalCandidate.candidateId }) }),
    ]))
    await service.dispose()
  })

  it('continues candidate generation and promotion using only the valid paired intersection', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByPhase.set('seed-baseline', [9])
    evaluator.partialInvalidByPhase.set('seed-candidate', [8])
    evaluator.partialInvalidByPhase.set('held-out-baseline', [9])
    evaluator.partialInvalidByPhase.set('held-out-candidate', [8])
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    expect(round.baseline).toMatchObject({
      completeness: 'partial', plannedTrialCount: 10,
      summary: { total: 9 }, invalidTrials: [{ taskName: 'task-9' }],
    })
    await finalize(service, round)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    expect(terminal?.failedEvaluations).toBeUndefined()
    expect(terminal?.evaluation).toMatchObject({
      seedPairing: { planned: 10, paired: 8, excluded: 2, baselineInvalid: 1, candidateInvalid: 1 },
      heldOutPairing: { planned: 10, paired: 8, excluded: 2, baselineInvalid: 1, candidateInvalid: 1 },
      seedPairedTrials: expect.arrayContaining([expect.objectContaining({ taskName: 'task-0' })]),
      heldOutPairedTrials: expect.arrayContaining([expect.objectContaining({ taskName: 'task-0' })]),
    })
    expect(terminal?.evaluation?.seedPairedTrials).toHaveLength(8)
    expect(terminal?.evaluation?.heldOutPairedTrials).toHaveLength(8)
    expect(terminal?.candidatePool[0]?.seedComparison?.pairing).toEqual({
      planned: 10, paired: 8, excluded: 2, baselineInvalid: 1, candidateInvalid: 1,
    })
    await service.dispose()
  })

  it('drops only a zero-pair seed candidate while another candidate continues', async () => {
    const { service, evaluator } = await setup(0.8, false, 2)
    const policy = { ...service.options.promotion.policy.config, requiredTaskIds: ['task-0'] }
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', policy)
    evaluator.partialInvalidByCall.set(2, Array.from({ length: 10 }, (_, index) => index))
    const admission = await service.admit('api')
    let previousWorkspace: string | undefined
    for (let index = 0; index < 2; index += 1) {
      const round = await eventually(
        () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && service.activeEntry(value.roundId)?.workspace?.workspaceId !== previousWorkspace,
      )
      previousWorkspace = service.activeEntry(round.roundId)?.workspace?.workspaceId
      await finalize(service, round)
    }
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    expect(terminal?.candidatePool).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'failed',
        seedEvaluation: expect.objectContaining({ completeness: 'partial', summary: { total: 0, passed: 0, failed: 0, score: 0 } }),
        seedComparison: expect.objectContaining({
          pairedTrials: [],
          pairing: { planned: 10, paired: 0, excluded: 10, baselineInvalid: 0, candidateInvalid: 10 },
        }),
        failure: { phase: 'candidate-seed-running', message: expect.stringMatching(/no valid paired/) },
      }),
      expect.objectContaining({ status: 'selected', seedComparison: expect.objectContaining({ pairing: expect.objectContaining({ paired: 10 }) }) }),
    ]))
    await service.dispose()
  })

  it('rejects stably when held-out has zero pairs without invoking judges on empty evidence', async () => {
    const { service, evaluator } = await setup()
    const implementation = { package: 'test-empty-judge', version: '1.0.0', integrity: `sha256:${'d'.repeat(64)}` }
    const judge = componentRef('judge', 'reject-empty', implementation, {})
    service.components.registerJudge('reject-empty', implementation, ref => ({
      ref,
      async evaluate(value) {
        if (value.summary.total === 0) throw new Error('judge must not receive empty paired evidence')
        return { quality: value.primaryReward, taskSuccessRate: value.summary.passed / value.summary.total }
      },
    }))
    service.options.evaluation.judges = [judge]
    const policy = { ...service.options.promotion.policy.config, requiredTaskIds: ['task-0'] }
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', policy)
    evaluator.partialInvalidByCall.set(4, Array.from({ length: 10 }, (_, index) => index))
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    expect(terminal?.failure).toBeUndefined()
    expect(terminal?.evaluation).toMatchObject({
      heldOutPairing: { planned: 10, paired: 0, excluded: 10, baselineInvalid: 0, candidateInvalid: 10 },
      promotionMetrics: { quality: 0, taskSuccessRate: 0 },
    })
    await service.dispose()
  })

  it('requires every protected task to have a common valid paired repetition', async () => {
    const { service, evaluator } = await setup()
    evaluator.useRequiredTaskRepetitions = true
    evaluator.partialInvalidByPhase.set('seed-baseline', [9])
    evaluator.partialInvalidByPhase.set('seed-candidate', [8])
    const policy = { ...service.options.promotion.policy.config, requiredTaskIds: ['task-required'] }
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', policy)
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    expect(terminal?.candidatePool[0]?.failure?.message).toMatch(/required task has no valid paired rollout cell/)
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    await service.dispose()
  })

  it('continues a multi-round batch with a fresh workspace and persistent evolution', async () => {
    const { service } = await setup()
    const admission = await service.admit('command', { rounds: 2, focus: ['workflow'] })
    const first = await editing(service, admission.evolutionId, admission.roundId)
    const active = service.activeEntry(first.roundId)!
    const current = await active.store.readRound(first.roundId)
    const candidate = current?.candidatePool.find(value => value.workspaceId === active.workspace?.workspaceId)
    const sessionId = candidate?.metaSessionId
    if (sessionId === undefined || candidate === undefined) throw new Error('candidate Meta session is unavailable')
    await eventually(async () => {
      try { return service.workspaceManager.resolve(sessionId).workspaceId }
      catch { return undefined }
    }, value => value === active.workspace?.workspaceId)
    const failed = first.baseline!.trials.flatMap(trial => (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : [])
    await service.submitFinalization(first.evolutionId, first.roundId, null, {
      rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [],
    }, {
      evolutionId: first.evolutionId, sessionId, requestHeaderSeq: 1, proposalEventSeq: 2,
    }, {
      evolutionId: first.evolutionId, roundId: first.roundId, candidateId: candidate.candidateId, baselineEvalId: first.baseline!.evalId,
      summaryAccessed: true, accessedRefs: [first.baseline!.evalId, ...failed], diagnosedRunRefs: failed,
      diagnosisReceipts: diagnosisReceipts(failed), citedRefs: [],
    })
    expect(active.workspace).toBeDefined()
    const store = service.registry.stateStore(admission.evolutionId)
    const second = await eventually(async () => (await store.listRounds()).find(value => value.roundIndex === 2), value => value?.status === 'candidate-editing')
    expect(await store.readRound(first.roundId)).toMatchObject({
      decision: 'no-change',
      candidatePool: [{ decline: { rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [] } }],
    })
    expect(second).toMatchObject({ batchId: admission.batchId, advisoryFocus: ['workflow'], roundCount: 2 })
    expect(service.activeEntry(second!.roundId)?.workspace?.workspaceId).not.toBe(active.workspace?.workspaceId)
    await service.dispose()
  })

  it('continues from the immutable EvolutionSpec after global defaults change', async () => {
    const { service } = await setup()
    const admission = await service.admit('api')
    const first = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, first)
    await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    service.options.metaAgent.preset.id = 'changed-global-preset'
    service.options.rollout.model = 'changed-global-model'
    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await editing(service, admission.evolutionId, continued.roundId)
    expect(second.metaHarnessRef).toBe('meta-v1')
    expect(second.plan.seed.model).toBe('deepseek-chat')
    await service.dispose()
  })

  it.each(['automatic', 'appended', 'restart'] as const)('continues from champion after a rejected candidate has four invalid trials (%s)', async mode => {
    const { service, evaluator } = await setup(0.8, false, 1, 300_000, 1, -0.2)
    evaluator.partialInvalidByPhase.set('seed-candidate', [6, 7, 8, 9])
    let resumed = service
    try {
      const admission = await service.admit('api', { rounds: mode === 'automatic' ? 2 : 1 })
      const store = service.registry.stateStore(admission.evolutionId)
      const champion = await service.champion(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const rejected = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'rejected')
      const candidate = rejected!.candidatePool[0]!
      expect(candidate.seedEvaluation?.invalidTrials).toHaveLength(4)
      expect((await store.readPopulation())?.members[0]?.harnessRef).toBe(candidate.sealedVersion!.commitOid)
      expect((await service.champion(admission.evolutionId)).ref).toBe(champion.ref)
      if (mode !== 'automatic') {
        await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
        if (mode === 'restart') {
          await service.dispose()
          resumed = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
          await resumed.initialize()
        }
        await resumed.continueEvolution('api', admission.evolutionId)
      }
      const next = await eventually(async () => (await store.listRounds()).find(r => r.roundId !== admission.roundId),
        r => r?.status === 'candidate-editing' || r?.status === 'failed')
      expect(next?.failure).toBeUndefined()
      expect(next?.status).toBe('candidate-editing')
      expect(next?.candidatePool.every(value => value.parentHarnessRef === champion.ref)).toBe(true)
      expect(resumed.activeEntry(next!.roundId)?.workspace?.parentRef).toBe(champion.ref)
      expect(next?.baseline).toEqual(rejected?.baseline)
      expect(next?.parentBaselines).toHaveLength(1)
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(await store.readRound(admission.roundId)).toEqual(rejected)
      expect(next?.candidatePool[0]?.parentCheckpoint).not.toEqual(candidate.resultCheckpoint)
      await finalize(resumed, next!)
      const completed = await eventually(() => store.readRound(next!.roundId), r => r?.status === 'rejected' || r?.status === 'failed')
      expect(completed?.status).toBe('rejected')
      expect((await store.readPopulation())?.generation).toBe(2)
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
      expect(await store.readRound(admission.roundId)).toEqual(rejected)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('restores an evicted champion parent and its checkpoint across rejected rounds and restart', async () => {
    const { service, evaluator } = await setup()
    let resumed = service
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const accepted = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'accepted')
      const championCandidate = accepted!.candidatePool.find(candidate => candidate.candidateId === accepted!.promotedCandidateId)!
      const originParent = accepted!.commitIntent!.nextPopulation.members.find(member => member.candidateId === championCandidate.candidateId)!
      const specBefore = await service.registry.requireSpec(admission.evolutionId)
      evaluator.partialInvalidByPhase.set('seed-candidate', [6, 7, 8, 9])
      const rejectedRounds: RefinementRound[] = []
      for (let index = 0; index < 2; index++) {
        await eventually(async () => resumed.activeEntry(index === 0 ? admission.roundId : rejectedRounds[index - 1]!.roundId), value => value === undefined)
        if (index === 1) {
          await service.dispose()
          resumed = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
          await resumed.initialize()
        }
        const next = await resumed.continueEvolution('api', admission.evolutionId)
        const current = await editing(resumed, admission.evolutionId, next.roundId)
        expect(current.championParent).toEqual(originParent)
        expect(current.candidatePool[0]?.parentHarnessRef).toBe(championCandidate.sealedVersion!.commitOid)
        expect(current.candidatePool[0]?.parentCheckpoint).toEqual(championCandidate.resultCheckpoint)
        expect(current.baseline).toEqual(championCandidate.seedEvaluation)
        await finalize(resumed, current)
        const rejected = await eventually(() => store.readRound(next.roundId), r => r?.status === 'rejected' || r?.status === 'failed')
        expect(rejected?.status).toBe('rejected')
        rejectedRounds.push(rejected!)
        expect((await store.readPopulation())?.members.every(member => member.harnessRef !== championCandidate.sealedVersion!.commitOid)).toBe(true)
        expect((await resumed.champion(admission.evolutionId)).ref).toBe(championCandidate.sealedVersion!.commitOid)
      }
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(await store.readRound(admission.roundId)).toEqual(accepted)
      expect(await service.registry.requireSpec(admission.evolutionId)).toEqual(specBefore)
      for (const rejected of rejectedRounds) expect(await store.readRound(rejected.roundId)).toEqual(rejected)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('uses only the promoted champion when several research survivors are retained', async () => {
    const { service, evaluator } = await setup(0.8, false, 3, 300_000, 2)
    try {
      const admission = await service.admit('api', { rounds: 2 })
      const store = service.registry.stateStore(admission.evolutionId)
      let previousWorkspace: string | undefined
      for (let index = 0; index < 3; index++) {
        const current = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'candidate-editing'
          && service.activeEntry(admission.roundId)?.workspace?.workspaceId !== previousWorkspace)
        previousWorkspace = service.activeEntry(admission.roundId)!.workspace!.workspaceId
        await finalize(service, current!)
      }
      const accepted = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'accepted')
      expect(accepted?.commitIntent?.nextPopulation.members).toHaveLength(2)
      const championCandidate = accepted!.candidatePool.find(candidate => candidate.candidateId === accepted!.promotedCandidateId)!
      const next = await eventually(async () => (await store.listRounds()).find(r => r.roundIndex === 2), r => r?.status === 'candidate-editing')
      expect(next?.candidatePool).toHaveLength(3)
      expect(next?.candidatePool.every(candidate => candidate.parentHarnessRef === championCandidate.sealedVersion!.commitOid
        && candidate.parentCandidateIds.length === 1 && candidate.parentCandidateIds[0] === championCandidate.candidateId)).toBe(true)
      expect(next?.parentBaselines).toHaveLength(1)
      expect(next?.baseline).toEqual(championCandidate.seedEvaluation)
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
    } finally { await service.dispose() }
  })

  it('continues from a rolled-back champion without using the latest research survivor', async () => {
    const { service, evaluator } = await setup()
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
    })
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const original = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'accepted')
      const restoredCandidate = original!.candidatePool.find(candidate => candidate.candidateId === original!.promotedCandidateId)!
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      const second = await service.continueEvolution('api', admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, second.roundId))
      const latest = await eventually(() => store.readRound(second.roundId), r => r?.status === 'accepted')
      await eventually(async () => service.activeEntry(second.roundId), value => value === undefined)
      await service.rollback(admission.evolutionId, restoredCandidate.sealedVersion!.commitOid)
      const continuation = await service.continueEvolution('api', admission.evolutionId)
      const next = await editing(service, admission.evolutionId, continuation.roundId)
      expect(next.championParent?.candidateId).toBe(restoredCandidate.candidateId)
      expect(next.candidatePool[0]?.parentHarnessRef).toBe(restoredCandidate.sealedVersion!.commitOid)
      expect(next.candidatePool[0]?.parentCheckpoint).toEqual(restoredCandidate.resultCheckpoint)
      expect(next.baseline).toEqual(restoredCandidate.seedEvaluation)
      await finalize(service, next)
      const completed = await eventually(() => store.readRound(next.roundId), r => r?.status === 'accepted' || r?.status === 'failed')
      expect(completed?.status).toBe('accepted')
      expect(completed?.evaluation?.heldOutBaseline).toEqual(restoredCandidate.heldOutEvaluation)
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
      expect(await store.readRound(admission.roundId)).toEqual(original)
      expect(await store.readRound(second.roundId)).toEqual(latest)
    } finally { await service.dispose() }
  })

  it('releases admission ownership if the champion promotion source cannot be verified', async () => {
    const { service } = await setup()
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      await eventually(() => store.readRound(admission.roundId), r => r?.status === 'accepted')
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      const champion = await store.readChampion()
      await store.writeChampion({ ...champion!, roundId: 'missing-promotion-source' })
      await expect(service.continueEvolution('api', admission.evolutionId)).rejects.toThrow(/champion parent/)
      await store.writeChampion(champion!)
      const next = await service.continueEvolution('api', admission.evolutionId)
      expect((await editing(service, admission.evolutionId, next.roundId)).championParent?.harnessRef).toBe(champion!.ref)
    } finally { await service.dispose() }
  })

  it('preserves the sealed parent of a legacy round when an explicit repair resumes after restart', async () => {
    const { service, evaluator } = await setup(0.1)
    let reservation = 0
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}` })
    const identity = evaluator.evaluationIdentity.bind(evaluator)
    evaluator.evaluationIdentity = (round, request) => ({ ...identity(round, request), provider: 'hitch-cli' })
    let resumed = service
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const rejected = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'rejected')
      const researchParent = rejected!.commitIntent!.nextPopulation.members[0]!
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      // Reconstruct a pre-upgrade admission; subsequent writes use normal code.
      const continuation = await continueWithLegacyPopulationParent(service, admission.evolutionId, researchParent)
      const editable = await editing(service, admission.evolutionId, continuation.roundId)
      expect(editable.championParent).toBeUndefined()
      expect(service.activeEntry(editable.roundId)?.workspace?.parentRef).toBe(researchParent.harnessRef)
      evaluator.failurePhase = 'seed-candidate'
      const parentBaseline = editable.parentBaselines!.find(value => value.parentCandidateId === researchParent.candidateId)!.evidence
      await finalize(service, { ...editable, baseline: parentBaseline })
      const failed = await eventually(() => store.readRound(editable.roundId), r => r?.status === 'failed')
      const candidate = failed!.candidatePool[0]!
      const attempt = failed!.evaluationAttempts!.find(value => value.phase === 'seed-candidate' && value.status === 'failed')!
      expect((await service.builder.readManifest(candidate.sealedVersion!.commitOid)).parentRef).toBe(researchParent.harnessRef)
      await service.dispose()
      delete evaluator.failurePhase
      resumed = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
      await resumed.initialize()
      await resumed.rerunEvaluation(admission.evolutionId, failed!.roundId, attempt.evalId, { mode: 'invalid' })
      const terminal = await eventually(() => store.readRound(failed!.roundId), r => r?.status === 'rejected' || r?.status === 'failed')
      expect(terminal?.status).toBe('rejected')
      expect(terminal?.championParent).toBeUndefined()
      expect(terminal?.parentAllocations).toEqual(failed?.parentAllocations)
      expect(terminal?.candidatePool[0]?.sealedVersion).toEqual(candidate.sealedVersion)
      expect(terminal?.candidatePool[0]?.parentCheckpoint).toEqual(candidate.parentCheckpoint)
      expect(terminal?.candidatePool[0]?.seedEvaluation?.evalId).toBe(attempt.evalId)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('continues a legacy evolution already blocked by a rejected partial research parent', async () => {
    const { service, evaluator } = await setup(0.8, false, 1, 300_000, 1, -0.2)
    evaluator.partialInvalidByPhase.set('seed-candidate', [6, 7, 8, 9])
    let resumed = service
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const original = await eventually(() => store.readRound(admission.roundId), r => r?.status === 'rejected')
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      const legacy = await continueWithLegacyPopulationParent(service, admission.evolutionId, original!.commitIntent!.nextPopulation.members[0]!)
      const blocked = await eventually(() => store.readRound(legacy.roundId), r => r?.status === 'failed')
      expect(blocked?.championParent).toBeUndefined()
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
      const spec = await service.registry.requireSpec(admission.evolutionId)
      await service.dispose()
      resumed = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
      await resumed.initialize()
      const appended = await resumed.continueEvolution('api', admission.evolutionId)
      const next = await editing(resumed, admission.evolutionId, appended.roundId)
      expect(next.championParent?.harnessRef).toBe(original!.targetHarnessRef)
      expect(next.candidatePool[0]?.parentHarnessRef).toBe(original!.targetHarnessRef)
      expect(next.baseline).toEqual(original?.baseline)
      expect(next.parentBaselines).toHaveLength(1)
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(await store.readRound(legacy.roundId)).toEqual(blocked)
      expect(await store.readRound(admission.roundId)).toEqual(original)
      expect(await service.registry.requireSpec(admission.evolutionId)).toEqual(spec)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('reuses an exact prior seed baseline when continuing the same harness and condition', async () => {
    const { service, evaluator } = await setup()
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await decline(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    if (first?.baseline === undefined) throw new Error('first round has no baseline')
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

    evaluator.diagnosticInvocationFingerprint = `sha256:${'d'.repeat(64)}`
    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await editing(service, admission.evolutionId, continued.roundId)

    expect(second.baseline?.evalId).toBe(first.baseline.evalId)
    expect(second.baseline?.conditionId).toBe(first.plan.seed.conditionId)
    expect(second.baseline?.actualCommit).toBe(first.targetHarnessRef)
    expect(second.baseline?.invocationFingerprint).toBe(first.baseline.invocationFingerprint)
    expect(second.evaluationAttempts?.find(attempt => attempt.evalId === first.baseline!.evalId)).toMatchObject({
      status: 'settled',
      reusedFromRoundId: first.roundId,
      reuseAudit: {
        sourceInvocationFingerprint: first.baseline.invocationFingerprint,
        currentInvocationFingerprint: `sha256:${'d'.repeat(64)}`,
        invocationFingerprintChanged: true,
      },
    })
    expect(evaluator.calls).toEqual(['seed-baseline'])
    await service.dispose()
  })

  it('blocks without rerunning the baseline when the evaluator runtime identity changes', async () => {
    const { service, evaluator } = await setup()
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await decline(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    if (first?.baseline === undefined) throw new Error('first round has no baseline')
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

    evaluator.runtimeConfigDigest = `sha256:${'e'.repeat(64)}`
    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await eventually(() => store.readRound(continued.roundId), value => value?.status === 'failed')

    expect(second?.baselineReuseBlocker?.code).toBe('BASELINE_CONDITION_MISMATCH')
    expect(second?.baseline).toBeUndefined()
    expect(second?.evaluationAttempts ?? []).toEqual([])
    expect(await store.readRound(first.roundId)).toEqual(first)
    expect(evaluator.calls).toEqual(['seed-baseline'])
    await service.dispose()
  })

  it('blocks legacy seed and held-out baselines after the Hitch scoring contract upgrade', async () => {
    const { git, service, evaluator } = await setup()
    try {
      const executable = join(git.root, 'fake-hitch-version.mjs')
      await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('0.2.8\\n')\n")
      await chmod(executable, 0o755)
      const hitch = new HitchCliEvaluator({
        executable, repositoryPath: git.repository, root: '', harnessId: 'deepseek',
        model: 'deepseek-chat', attempts: 1, maxConcurrent: 2, setupTimeoutMs: 10_000,
        terminationGraceMs: 100, maxOutputBytes: 1024 * 1024, maxTrajectoryOutputBytes: 1024 * 1024,
        sampling: {}, agentArgs: [], passEnv: [],
      })
      // Freeze the pre-upgrade digest algorithm to model evidence already on disk.
      evaluator.evaluationIdentity = (round, request) => {
        const effectiveConfigDigest = `sha256:${createHash('sha256').update(JSON.stringify({
          provider: 'hitch-cli', conditionId: request.condition.conditionId, backend: 'harbor',
          harnessId: hitch.options.harnessId, sandboxProfileRef: round.sandboxProfileRef,
        })).digest('hex')}`
        return { provider: 'fake', effectiveConfigDigest, invocationFingerprint: effectiveConfigDigest }
      }
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const first = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
      const promoted = first?.candidatePool.find(candidate => candidate.candidateId === first.promotedCandidateId)
      if (first === undefined || promoted?.sealedVersion === undefined
        || promoted.seedEvaluation === undefined || promoted.heldOutEvaluation === undefined) {
        throw new Error('first round did not persist promoted candidate evidence')
      }
      expect(promoted.seedEvaluation.benchmark).toBeUndefined()
      expect(promoted.heldOutEvaluation.benchmark).toBeUndefined()
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

      // Resolve the real current Hitch identity while keeping task execution local.
      // The dataset paths have no standard manifest, so normal cache lookup runs.
      const identities = new Map<string, NonNullable<Awaited<ReturnType<typeof hitch.evaluationIdentity>>>>()
      for (const [phase, condition] of [['seed-baseline', first.plan.seed], ['held-out-baseline', first.plan.heldOut]] as const) {
        const identity = await hitch.evaluationIdentity(first, {
          phase, condition, dataset: condition.dataset.ref, harnessRef: promoted.sealedVersion.commitOid,
        })
        if (identity === undefined) throw new Error('current Hitch evaluation identity is unavailable')
        identities.set(condition.conditionId, identity)
      }
      evaluator.evaluationIdentity = (_round, request) => ({ ...identities.get(request.condition.conditionId)!, provider: 'fake' })
      const originalEvaluate = evaluator.evaluate.bind(evaluator)
      evaluator.evaluate = async (...args) => ({
        ...await originalEvaluate(...args),
        benchmark: { id: `benchmark-${args[1].dataset}`, revision: 'revision-1' },
      })

      const continued = await service.continueEvolution('api', admission.evolutionId)
      const second = await eventually(() => store.readRound(continued.roundId), value => value?.status === 'failed')
      expect(second?.baselineReuseBlocker?.code).toBe('BASELINE_CONDITION_MISMATCH')
      expect(second?.evaluationAttempts ?? []).toEqual([])
      expect(evaluator.calls).toEqual([
        'seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate',
      ])
      expect(await store.readRound(first.roundId)).toEqual(first)
      expect((await store.readRound(first.roundId))?.baseline?.benchmark).toBeUndefined()
    } finally {
      await service.dispose()
    }
  })

  it.each(['automatic', 'appended'] as const)('reuses a promoted candidate as the %s round seed and held-out baseline', async mode => {
    const { service, evaluator } = await setup()
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config,
      minimumAbsoluteGain: 0,
    })
    const admission = await service.admit('api', { rounds: mode === 'automatic' ? 2 : 1 })
    const store = service.registry.stateStore(admission.evolutionId)
    await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    const promoted = first?.candidatePool.find(candidate => candidate.candidateId === first.promotedCandidateId)
    if (first === undefined || promoted?.sealedVersion === undefined
      || promoted.seedEvaluation === undefined || promoted.heldOutEvaluation === undefined) {
      throw new Error('first round did not persist promoted candidate evidence')
    }
    if (mode === 'appended') {
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      await service.continueEvolution('api', admission.evolutionId)
    }
    const second = await eventually(
      async () => (await store.listRounds()).find(value => value.roundId !== first.roundId),
      value => value?.status === 'candidate-editing',
    )
    expect(second?.targetHarnessRef).toBe(promoted.sealedVersion.commitOid)
    expect(second?.baseline?.evalId).toBe(promoted.seedEvaluation.evalId)
    expect(second?.evaluationAttempts?.find(attempt => attempt.evalId === promoted.seedEvaluation!.evalId)).toMatchObject({
      phase: 'seed-baseline',
      owner: { role: 'baseline', harnessRef: promoted.sealedVersion.commitOid },
      status: 'settled',
      reusedFromRoundId: first.roundId,
    })
    expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)

    await finalize(service, second!)
    const terminal = await eventually(
      () => store.readRound(second!.roundId),
      value => value?.status === 'accepted',
    )
    expect(terminal?.evaluation?.heldOutBaseline?.evalId).toBe(promoted.heldOutEvaluation.evalId)
    expect(terminal?.evaluationAttempts?.find(attempt => attempt.evalId === promoted.heldOutEvaluation!.evalId)).toMatchObject({
      phase: 'held-out-baseline',
      owner: { role: 'baseline', harnessRef: promoted.sealedVersion.commitOid },
      status: 'settled',
      reusedFromRoundId: first.roundId,
    })
    expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
    await service.dispose()
  })

  it('blocks a promoted candidate baseline when its prior seed evidence was partial', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByPhase.set('seed-candidate', [9])
    const admission = await service.admit('api', { rounds: 2 })
    const store = service.registry.stateStore(admission.evolutionId)
    await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    const promoted = first?.candidatePool.find(candidate => candidate.candidateId === first.promotedCandidateId)
    if (promoted?.seedEvaluation === undefined) throw new Error('first round did not persist promoted seed evidence')
    expect(promoted.seedEvaluation.completeness).toBe('partial')

    const second = await eventually(
      async () => (await store.listRounds()).find(value => value.roundIndex === 2),
      value => value?.status === 'failed',
    )
    expect(second?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
    expect(second?.evaluationAttempts ?? []).toEqual([])
    expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
    expect(await store.readRound(first!.roundId)).toEqual(first)
    await service.dispose()
  })

  it('reuses a complete seed baseline after rerun repair and round completion', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'a'.repeat(32)}`
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    const originalIdentity = evaluator.evaluationIdentity.bind(evaluator)
    let firstEvaluation = true
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId })
    evaluator.evaluationIdentity = (round, request) => ({
      ...originalIdentity(round, request),
      provider: 'hitch-cli',
    })
    evaluator.evaluate = async (...args) => {
      if (firstEvaluation) {
        firstEvaluation = false
        throw Object.assign(new Error('invalid task observation'), { code: 'hitch_infrastructure_failure' })
      }
      return originalEvaluate(...args)
    }

    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    await service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    await decline(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    expect(first?.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({ status: 'settled' })
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await editing(service, admission.evolutionId, continued.roundId)

    expect(second.baseline?.evalId).toBe(evalId)
    expect(second.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({
      status: 'settled',
      reusedFromRoundId: first!.roundId,
    })
    expect(evaluator.calls).toEqual(['seed-baseline'])
    await service.dispose()
  })

  it('preserves partial baseline trials and blocks instead of starting a fresh evaluation', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByCall.set(1, [9])
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    await decline(service, await editing(service, admission.evolutionId, admission.roundId))
    const first = await eventually(
      () => store.readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    if (first?.baseline === undefined) throw new Error('first round has no baseline')
    expect(first.baseline.completeness).toBe('partial')
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await eventually(() => store.readRound(continued.roundId), value => value?.status === 'failed')

    expect(second?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
    expect(second?.evaluationAttempts ?? []).toEqual([])
    expect(evaluator.calls).toEqual(['seed-baseline'])
    expect(await store.readRound(first.roundId)).toEqual(first)
    await service.dispose()
  })

  it.each(['unknown', 'throws', 'missing-method'] as const)('blocks %s identity resolution without reserving trials or waking Meta', async mode => {
    const { service, evaluator, metas } = await setup()
    if (mode === 'missing-method') {
      service.options.createEvaluator = () => ({
        reserve: evaluator.reserve.bind(evaluator), evaluate: evaluator.evaluate.bind(evaluator),
      })
    }
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await decline(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'rejected')
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      if (mode === 'unknown') vi.spyOn(evaluator, 'evaluationIdentity').mockReturnValueOnce(undefined as never)
      if (mode === 'throws') vi.spyOn(evaluator, 'evaluationIdentity').mockImplementationOnce(() => { throw new Error('private provider error') })
      const reserve = vi.spyOn(evaluator, 'reserve')
      const wakes = metas.get(first.evolutionId)!.wakes.length
      const next = await service.continueEvolution('api', first.evolutionId, { rounds: 2 })
      const blocked = await eventually(() => store.readRound(next.roundId), r => r?.status === 'failed')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_IDENTITY_UNRESOLVED')
      expect(blocked?.evaluationAttempts ?? []).toEqual([])
      expect(reserve).not.toHaveBeenCalled()
      expect(evaluator.calls).toEqual(['seed-baseline'])
      expect(metas.get(first.evolutionId)!.wakes).toHaveLength(wakes)
      expect(await store.readRound(first.roundId)).toEqual(original)
      const status = await service.status(first.evolutionId, next.roundId)
      expect(status).toMatchObject({ baselineReuseBlocker: { code: 'BASELINE_IDENTITY_UNRESOLVED', requiredAction: expect.any(String) } })
      expect(JSON.stringify(status)).not.toContain('private provider error')
      expect(await store.listRounds()).toHaveLength(2)
    } finally { await service.dispose() }
  })

  it('blocks a previous failed evaluation without durable evidence instead of retrying every trial', async () => {
    const { service, evaluator } = await setup()
    try {
      evaluator.failurePhase = 'seed-baseline'
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'failed')
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      delete evaluator.failurePhase
      const next = await service.continueEvolution('api', first.evolutionId)
      const blocked = await eventually(() => store.readRound(next.roundId), r => r?.status === 'failed')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
      expect(evaluator.calls).toEqual(['seed-baseline'])
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await service.dispose() }
  })

  it.each([false, true])('blocks an unreserved provider failure without repeating execution (restart=%s)', async restart => {
    const { service, evaluator } = await setup()
    const execute = vi.fn(async () => { throw new Error('provider failed after starting trials') })
    service.options.createEvaluator = () => ({
      evaluationIdentity: evaluator.evaluationIdentity.bind(evaluator), evaluate: execute,
    })
    let resumed = service
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'failed')
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      expect(original?.evaluationAttempts).toBeUndefined()
      expect(original?.evaluationStarts).toEqual([expect.objectContaining({ phase: 'seed-baseline', harnessRef: original!.targetHarnessRef })])
      if (restart) {
        await service.dispose()
        resumed = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
        await resumed.initialize()
      }
      const next = await resumed.continueEvolution('api', first.evolutionId)
      const blocked = await eventually(() => store.readRound(next.roundId), r => r?.status === 'failed')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('keeps a failed current-round baseline blocked after repairing only a seed candidate', async () => {
    const { service, evaluator } = await setup(0.8, false, 2)
    let reservation = 0
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}` })
    const identity = evaluator.evaluationIdentity.bind(evaluator)
    evaluator.evaluationIdentity = (round, request) => ({ ...identity(round, request), provider: 'hitch-cli' })
    const evaluate = evaluator.evaluate.bind(evaluator)
    const failOnce = new Set<EvaluationPhase>(['seed-candidate', 'held-out-baseline'])
    evaluator.evaluate = async (...args) => {
      if (failOnce.delete(args[1].phase)) {
        evaluator.failurePhase = args[1].phase
        try { return await evaluate(...args) }
        finally { delete evaluator.failurePhase }
      }
      return evaluate(...args)
    }
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      const first = await editing(service, admission.evolutionId, admission.roundId)
      const workspaceId = service.activeEntry(first.roundId)!.workspace!.workspaceId
      await finalize(service, first)
      const second = await eventually(() => store.readRound(first.roundId), r => r?.status === 'candidate-editing'
        && service.activeEntry(first.roundId)?.workspace?.workspaceId !== workspaceId)
      await finalize(service, second!)
      const failed = await eventually(() => store.readRound(first.roundId), r => r?.status === 'failed')
      const seedAttempt = failed!.evaluationAttempts!.find(attempt => attempt.phase === 'seed-candidate' && attempt.status === 'failed')!
      const baselineAttempt = failed!.evaluationAttempts!.find(attempt => attempt.phase === 'held-out-baseline')!
      expect(baselineAttempt.status).toBe('failed')
      const seedBaseline = structuredClone(failed!.baseline)
      await service.rerunEvaluation(first.evolutionId, first.roundId, seedAttempt.evalId, { mode: 'invalid' })
      const blocked = await eventually(() => store.readRound(first.roundId), r => r?.status === 'failed' || r?.status === 'accepted')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
      expect(blocked?.status).toBe('failed')
      expect(blocked?.evaluationAttempts?.filter(attempt => attempt.phase === 'held-out-baseline')).toEqual([baselineAttempt])
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
      expect(blocked?.baseline).toEqual(seedBaseline)
      expect((await service.status(first.evolutionId, first.roundId)).repairableEvaluations).toEqual([
        expect.objectContaining({ evalId: baselineAttempt.evalId, phase: 'held-out-baseline' }),
      ])

      // Explicitly repairing that baseline is still allowed and keeps its eval ID.
      await service.rerunEvaluation(first.evolutionId, first.roundId, baselineAttempt.evalId, { mode: 'invalid' })
      const terminal = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted' || r?.status === 'failed')
      expect(terminal?.failure).toBeUndefined()
      expect(terminal?.status).toBe('accepted')
      expect(terminal?.baselineReuseBlocker).toBeUndefined()
      expect(terminal?.baseline).toEqual(seedBaseline)
      expect(terminal?.evaluation?.heldOutBaseline?.evalId).toBe(baselineAttempt.evalId)
      expect(terminal?.evaluationAttempts?.filter(attempt => attempt.phase === 'held-out-baseline')).toEqual([
        expect.objectContaining({ evalId: baselineAttempt.evalId, status: 'settled' }),
      ])
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(2)
    } finally { await service.dispose() }
  })

  it('resumes a repaired held-out candidate without repeating either baseline', async () => {
    const { service, evaluator } = await setup()
    let reservation = 0
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}` })
    evaluator.failurePhase = 'held-out-candidate'
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await finalize(service, await editing(service, first.evolutionId, first.roundId))
      const failed = await eventually(() => store.readRound(first.roundId), r => r?.status === 'failed')
      const baseline = structuredClone(failed!.evaluation!.heldOutBaseline)
      const attempt = failed!.evaluationAttempts!.find(value => value.phase === 'held-out-candidate')!
      delete evaluator.failurePhase
      await service.rerunEvaluation(first.evolutionId, first.roundId, attempt.evalId, { mode: 'invalid' })
      const terminal = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted' || r?.status === 'failed')
      expect(terminal?.failure).toBeUndefined()
      expect(terminal?.status).toBe('accepted')
      expect(terminal?.evaluation?.heldOutBaseline).toEqual(baseline)
      expect(terminal?.evaluation?.heldOutCandidate?.evalId).toBe(attempt.evalId)
      expect(terminal?.evaluation?.heldOutPairedTrials).toHaveLength(10)
      expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate', 'held-out-candidate'])
    } finally { await service.dispose() }
  })

  it.each([false, true])('allows explicit candidate repair after a held-out reuse blocker (identity restored=%s)', async restoreIdentity => {
    const { service, evaluator } = await setup(0.8, false, 2)
    let reservation = 0
    evaluator.reserve = async () => ({ provider: 'hitch-cli', evalId: `eval_${(++reservation).toString(16).padStart(32, '0')}` })
    const identity = evaluator.evaluationIdentity.bind(evaluator)
    let blockHeldOut = false
    evaluator.evaluationIdentity = (round, request) => blockHeldOut && request.phase === 'held-out-baseline'
      ? undefined as never : { ...identity(round, request), provider: 'hitch-cli' }
    const evaluate = evaluator.evaluate.bind(evaluator)
    let failOneCandidate = false
    evaluator.evaluate = async (...args) => {
      if (failOneCandidate && args[1].phase === 'seed-candidate') {
        failOneCandidate = false
        throw Object.assign(new Error('candidate infrastructure failure'), { code: 'hitch_infrastructure_failure' })
      }
      return evaluate(...args)
    }
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
    })
    async function generate(evolutionId: string, roundId: string) {
      const first = await editing(service, evolutionId, roundId)
      const workspaceId = service.activeEntry(roundId)!.workspace!.workspaceId
      await finalize(service, first)
      const second = await eventually(
        () => service.registry.stateStore(evolutionId).readRound(roundId),
        r => r?.status === 'candidate-editing' && service.activeEntry(roundId)?.workspace?.workspaceId !== workspaceId,
      )
      await finalize(service, second!)
    }
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await generate(first.evolutionId, first.roundId)
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted')
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      blockHeldOut = true
      failOneCandidate = true
      const next = await service.continueEvolution('api', first.evolutionId)
      await generate(first.evolutionId, next.roundId)
      const blocked = await eventually(() => store.readRound(next.roundId), r => r?.status === 'failed')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_IDENTITY_UNRESOLVED')
      const attempt = blocked!.evaluationAttempts!.find(value => value.status === 'failed')!
      expect((await service.status(first.evolutionId, next.roundId)).repairableEvaluations).toEqual([
        expect.objectContaining({ evalId: attempt.evalId }),
      ])
      blockHeldOut = !restoreIdentity
      await expect(service.rerunEvaluation(first.evolutionId, next.roundId, attempt.evalId, { mode: 'invalid' })).resolves.toMatchObject({ evalId: attempt.evalId })
      const terminal = await eventually(() => store.readRound(next.roundId), r => r?.status === 'accepted' || r?.status === 'failed')
      expect(terminal?.failure?.message).toEqual(restoreIdentity ? undefined : expect.stringContaining('Cannot verify'))
      expect(terminal?.status).toBe(restoreIdentity ? 'accepted' : 'failed')
      if (restoreIdentity) expect(terminal?.baselineReuseBlocker).toBeUndefined()
      else expect(terminal?.baselineReuseBlocker?.code).toBe('BASELINE_IDENTITY_UNRESOLVED')
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await service.dispose() }
  })

  it('uses original promotion evidence despite a newer cancelled duplicate baseline', async () => {
    const { service, evaluator } = await setup()
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await finalize(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted')
      const promoted = original!.candidatePool.find(candidate => candidate.candidateId === original!.promotedCandidateId)!
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      vi.spyOn(evaluator, 'evaluationIdentity').mockReturnValueOnce(undefined as never)
      const duplicate = await service.continueEvolution('api', first.evolutionId)
      const blocked = await eventually(() => store.readRound(duplicate.roundId), r => r?.status === 'failed')
      await eventually(async () => service.activeEntry(duplicate.roundId), r => r === undefined)
      // Reconstruct the legacy failure from the incident: a cancelled duplicate
      // has attempt ownership, while the promotion's full evidence still exists.
      const cancelled: RefinementRound = { ...blocked!, evaluationAttempts: [{
        provider: 'fake', evalId: 'eval_cancelled_duplicate', phase: 'seed-baseline',
        owner: { candidateId: `champion-${blocked!.targetHarnessRef}`, role: 'baseline', harnessRef: blocked!.targetHarnessRef },
        conditionId: blocked!.plan.seed.conditionId, dataset: blocked!.seedTaskRef,
        requestedModelId: blocked!.plan.seed.model, requestedCommit: blocked!.targetHarnessRef,
        status: 'cancelled', startedAt: blocked!.createdAt, completedAt: blocked!.updatedAt,
        failure: { code: 'cancelled', message: 'Cancelled duplicate baseline.' },
      }] }
      delete cancelled.baselineReuseBlocker
      await store.writeRound(cancelled)
      const next = await service.continueEvolution('api', first.evolutionId)
      const continued = await editing(service, first.evolutionId, next.roundId)
      expect(continued.baseline).toEqual(promoted.seedEvaluation)
      expect(continued.evaluationAttempts?.[0]?.reusedFromRoundId).toBe(first.roundId)
      expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
      expect(await store.readRound(first.roundId)).toEqual(original)
      expect(await store.readRound(duplicate.roundId)).toEqual(cancelled)
    } finally { await service.dispose() }
  })

  it('reuses complete zero-reward results without replacing any trial', async () => {
    const { service, evaluator } = await setup()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => {
      const evidence = await evaluate(...args)
      return { ...evidence, primaryReward: 0, summary: { total: 10, passed: 0, failed: 10, score: 0 },
        trials: evidence.trials.map(trial => ({ ...trial, rewards: { reward: 0 } })) }
    }
    try {
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await decline(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'rejected')
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      const next = await service.continueEvolution('api', first.evolutionId)
      const continued = await editing(service, first.evolutionId, next.roundId)
      expect(continued.baseline).toEqual(original?.baseline)
      expect(continued.baseline?.summary).toMatchObject({ total: 10, score: 0 })
      expect(evaluator.calls).toEqual(['seed-baseline'])
    } finally { await service.dispose() }
  })

  it('blocks partial promoted held-out evidence without rerunning its valid trials', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByCall.set(4, [9])
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
    })
    try {
      const first = await service.admit('api', { rounds: 2 })
      const store = service.registry.stateStore(first.evolutionId)
      await finalize(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted')
      const next = await eventually(async () => (await store.listRounds()).find(r => r.roundIndex === 2), r => r?.status === 'candidate-editing')
      await finalize(service, next!)
      const blocked = await eventually(() => store.readRound(next!.roundId), r => r?.status === 'failed')
      expect(blocked?.baselineReuseBlocker?.code).toBe('BASELINE_EVIDENCE_UNAVAILABLE')
      expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate', 'seed-candidate'])
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await service.dispose() }
  })

  it.each(['absolute', 'relative'] as const)('reuses promoted standard benchmark evidence after restart with %s dataset paths', async pathMode => {
    const { service, evaluator, git } = await setup()
    let restarted: RefineService | undefined
    try {
      for (const partition of ['seed', 'held-out']) {
        const dir = join(git.root, partition)
        await mkdir(dir)
        await writeFile(join(dir, 'benchmark.adapter.json'), JSON.stringify({ benchmark: { id: partition, revision: '1' } }))
        await writeFile(join(dir, 'task.txt'), 'immutable fixture task')
      }
      service.options.seedTaskRef = pathMode === 'absolute' ? join(git.root, 'seed') : 'seed'
      service.options.heldOutRef = pathMode === 'absolute' ? join(git.root, 'held-out') : 'held-out'
      const executable = join(git.root, 'hitch-version.mjs')
      await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('0.2.8\\n')\n")
      await chmod(executable, 0o755)
      const hitch = new HitchCliEvaluator({
        executable, repositoryPath: git.repository, root: '', harnessId: 'deepseek', model: 'deepseek-chat',
        attempts: 1, maxConcurrent: 2, setupTimeoutMs: 10000, terminationGraceMs: 100,
        maxOutputBytes: 1024 * 1024, maxTrajectoryOutputBytes: 1024 * 1024, sampling: {}, agentArgs: [], passEnv: [],
      })
      service.options.createEvaluator = () => ({
        reserve: evaluator.reserve.bind(evaluator),
        evaluationIdentity: async (...args) => {
          const identity = await hitch.evaluationIdentity(...args)
          return identity === undefined ? undefined : { ...identity, provider: 'fake' }
        },
        evaluate: async (...args) => {
          const evidence = await evaluator.evaluate(...args)
          const identity = await hitch.evaluationIdentity(args[0], args[1], args[2])
          if (identity === undefined) throw new Error('fixture expected a resolved direct identity')
          return { ...evidence, effectiveConfigDigest: identity.effectiveConfigDigest,
            invocationFingerprint: identity.invocationFingerprint, benchmark: { id: args[1].dataset, revision: '1' } }
        },
      })
      service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
        ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
      })
      const first = await service.admit('api')
      const store = service.registry.stateStore(first.evolutionId)
      await finalize(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted')
      const promoted = original!.candidatePool[0]!
      await eventually(async () => service.activeEntry(first.roundId), r => r === undefined)
      await service.dispose()
      restarted = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
      await restarted.initialize()
      const next = await restarted.continueEvolution('api', first.evolutionId)
      const round = await editing(restarted, first.evolutionId, next.roundId)
      expect(round.baseline).toEqual(promoted.seedEvaluation)
      await finalize(restarted, round)
      const terminal = await eventually(() => store.readRound(next.roundId), r => r?.status === 'accepted')
      expect(terminal?.evaluation?.heldOutBaseline).toEqual(promoted.heldOutEvaluation)
      expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate', 'seed-candidate', 'held-out-candidate'])
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await restarted?.dispose(); await service.dispose() }
  })

  it('revalidates the resolved Meta runtime before every continue', async () => {
    const { service } = await setup()
    const admission = await service.admit('api')
    const first = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, first)
    await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    service.options.validateRuntime = async () => { throw new Error('preset digest mismatch') }
    await expect(service.continueEvolution('api', admission.evolutionId)).rejects.toThrow(/preset digest mismatch/)
    await service.dispose()
  })

  it('rejects below the seed gate without spending held-out evaluations', async () => {
    const { service, evaluator } = await setup(0.55)
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'rejected')
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    await service.dispose()
  })

  it('fails the candidate closed when baseline and candidate do not share the same evaluation condition identity', async () => {
    const { service, evaluator } = await setup(0.8, true)
    const admission = await service.admit('api')
    const state = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, state)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    expect(terminal?.candidatePool[0]?.failure?.message).toMatch(/condition identity mismatch/)
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    await service.dispose()
  })

  it('generates all best-of-N proposals before running candidate evaluations', async () => {
    const { service, evaluator } = await setup(0.8, false, 2)
    const admission = await service.admit('api')
    const first = await editing(service, admission.evolutionId, admission.roundId)
    const firstWorkspace = service.activeEntry(first.roundId)?.workspace?.workspaceId
    await finalize(service, first)
    const second = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId) as Promise<RefinementRound>,
      value => value?.status === 'candidate-editing'
        && service.activeEntry(value.roundId)?.workspace?.workspaceId !== firstWorkspace,
    )
    expect(evaluator.calls).toEqual(['seed-baseline'])
    await finalize(service, second)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    expect(terminal?.candidatePool).toHaveLength(2)
    expect(terminal?.candidatePool.every(candidate => candidate.seedEvaluation !== undefined)).toBe(true)
    await service.dispose()
  })

  it('persists an asynchronous cross-candidate assessment before applying the pure selection policy', async () => {
    const { service } = await setup(0.8, false, 2)
    const implementation = {
      package: 'test-selection-assessor', version: '1.0.0', integrity: `sha256:${'e'.repeat(64)}`,
    }
    const assessorRef = componentRef('candidate-assessor', 'async-test', implementation, { model: 'test' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    service.components.registerCandidateAssessor('async-test', implementation, ref => ({
      ref,
      async assess(request, _context, signal) {
        entered.resolve()
        await release.promise
        signal.throwIfAborted()
        const ordered = [...request.candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
        return {
          candidateMetrics: Object.fromEntries(ordered.map((candidate, index) => [candidate.candidateId, {
            ...candidate.metrics,
            quality: index === ordered.length - 1 ? 0.9 : 0.1,
          }])),
          rankingCandidateIds: ordered.map(candidate => candidate.candidateId).reverse(),
          reason: 'test asynchronous pairwise assessment',
          evidence: { kind: 'test-pairwise', requestCount: 1 },
          usage: { modelRequests: 1, inputTokens: 10, outputTokens: 2 },
        }
      },
    }))
    service.options.selection.assessor = assessorRef
    const admission = await service.admit('api')
    let previousWorkspace: string | undefined
    for (let index = 0; index < 2; index += 1) {
      const round = await eventually(
        () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && service.activeEntry(value.roundId)?.workspace?.workspaceId !== previousWorkspace,
      )
      previousWorkspace = service.activeEntry(round.roundId)?.workspace?.workspaceId
      await finalize(service, round)
    }
    await entered.promise
    const store = service.registry.stateStore(admission.evolutionId)
    expect(await store.readRound(admission.roundId)).toMatchObject({ status: 'selection-running' })
    release.resolve()
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    expect(terminal?.selectionAssessment).toMatchObject({
      component: { id: 'async-test' },
      rankingCandidateIds: [expect.stringMatching(/candidate-2$/), expect.stringMatching(/candidate-1$/)],
      usage: { modelRequests: 1, inputTokens: 10, outputTokens: 2 },
      digest: expect.stringMatching(/^sha256:/),
    })
    expect(terminal?.selection?.assessmentDigest).toBe(terminal?.selectionAssessment?.digest)
    expect(terminal?.promotionCandidateId).toMatch(/candidate-2$/)
    expect(terminal?.candidatePool.find(candidate => candidate.candidateId.endsWith('candidate-2'))?.metrics?.quality).toBe(0.9)
    await service.dispose()
  })

  it('keeps multiple seed-selected survivors while promotion still has one finalist', async () => {
    const { service, git } = await setup(0.8, false, 3, 300_000, 2, -0.2)
    const admission = await service.admit('api')
    let previousWorkspace: string | undefined
    for (let index = 0; index < 3; index += 1) {
      const round = await eventually(
        () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && service.activeEntry(value.roundId)?.workspace?.workspaceId !== previousWorkspace,
      )
      previousWorkspace = service.activeEntry(round.roundId)?.workspace?.workspaceId
      await finalize(service, round)
    }
    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'rejected')
    expect(terminal?.selection?.selectedCandidateIds).toHaveLength(2)
    expect(terminal?.selection?.promotionCandidateId).toBe(terminal?.promotionCandidateId)
    expect(terminal?.promotedCandidateId).toBeUndefined()
    expect((await store.readChampion())?.ref).toBe(git.championRef)
    const population = await store.readPopulation()
    expect(population?.generation).toBe(1)
    expect(population?.members).toHaveLength(2)
    expect(population?.members.every(member => member.metrics.quality === 0.8)).toBe(true)
    expect(population?.members.every(member => member.metaCheckpoint?.sourceSessionId === member.metaSessionId)).toBe(true)
    await service.dispose()
  })

  it('persists the failed reserved baseline attempt before failing the round', async () => {
    const { service, evaluator } = await setup()
    evaluator.failurePhase = 'seed-baseline'
    const admission = await service.admit('api')
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'failed',
    )
    expect(terminal?.baseline).toBeUndefined()
    expect(terminal?.evaluationAttempts).toEqual([expect.objectContaining({
      phase: 'seed-baseline',
      owner: expect.objectContaining({ role: 'baseline', harnessRef: terminal?.targetHarnessRef }),
      status: 'failed',
      failure: { code: 'hitch_infrastructure_failure', message: 'fake invalid run observations' },
    })])
    expect(terminal?.failedEvaluations).toBeUndefined()
    expect(terminal?.failure).toMatchObject({ phase: 'baseline-running' })
    await service.dispose()
  })

  it('retains a successful held-out baseline when the held-out candidate evaluation fails', async () => {
    const { service, evaluator } = await setup()
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    evaluator.failurePhase = 'held-out-candidate'
    await finalize(service, round)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'failed',
    )
    expect(terminal?.evaluation?.heldOutBaseline).toBeDefined()
    expect(terminal?.evaluation?.heldOutCandidate).toBeUndefined()
    expect(terminal?.evaluationAttempts).toEqual(expect.arrayContaining([expect.objectContaining({
      phase: 'held-out-candidate',
      owner: expect.objectContaining({ role: 'candidate' }),
      status: 'failed',
      failure: { code: 'hitch_infrastructure_failure', message: 'fake invalid run observations' },
    })]))
    expect(terminal?.failedEvaluations).toBeUndefined()
    await service.dispose()
  })

  it('reconciles a prepared population/champion commit intent idempotently on startup', async () => {
    const { service } = await setup()
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const initialChampion = await store.readChampion()
    const initialPopulation = await store.readPopulation()
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    if (terminal?.commitIntent === undefined || initialChampion === undefined || initialPopulation === undefined) {
      throw new Error('test round is missing durable commit state')
    }
    const { decision: _decision, promotedCandidateId: _promoted, ...nonTerminal } = terminal
    await store.writeChampion(initialChampion)
    await store.writePopulation(initialPopulation)
    await store.writeRound({
      ...nonTerminal,
      status: 'failed',
      commitIntent: { ...terminal.commitIntent, phase: 'prepared' },
      updatedAt: 'interrupted',
    })
    await service.initialize()
    expect(await store.readPopulation()).toEqual(terminal.commitIntent.nextPopulation)
    expect((await store.readChampion())?.ref).toBe(terminal.commitIntent.nextChampion?.ref)
    expect(await store.readRound(admission.roundId)).toMatchObject({ status: 'accepted', decision: 'accepted' })
    await service.initialize()
    expect(await store.readRound(admission.roundId)).toMatchObject({ status: 'accepted', decision: 'accepted' })
    await service.dispose()
  })

  it('rejects proposal usage budgets that the Meta harness adapter cannot verify instead of recording them as effective', async () => {
    const { service } = await setup()
    service.options.candidateGeneration.budget.maxModelRequests = 2
    await expect(service.admit('api')).rejects.toThrow(/aggregate proposal usage/)
    expect(await service.listEvolutions()).toEqual([])
    await service.dispose()
  })

  it('keeps one attempt and the same uncommitted workspace through two session activations', async () => {
    const { service, evaluator, metas } = await setup()
    const gate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => { await gate.promise; return evaluate(...args) }
    const admission = await service.admit('api')
    const meta = metas.get(admission.evolutionId)! as unknown as MetaSessionController
    const idle = Promise.withResolvers<MetaTurnObservation>()
    const oldIds: string[] = []
    const workspaceIds: string[] = []
    meta.wakeCandidate = async (_round, _candidate, _baseline, agent, binding) => {
      let id = agent.id
      for (let generation = 1; generation <= 2; generation += 1) {
        const workspace = service.workspaceManager.resolve(id)
        workspaceIds.push(workspace.workspaceId)
        const path = join(workspace.targetPath, 'prompts', 'rotation.md')
        await mkdir(join(workspace.targetPath, 'prompts'), { recursive: true })
        if (generation === 2) expect(await readFile(path, 'utf8')).toBe('edit 1')
        await service.workspaceManager.withOpenWorkspace(id, true, async () => writeFile(path, `edit ${generation}`))
        await binding!.snapshot()
        expect(binding!.signal.aborted).toBe(false)
        const next = `${agent.id}-rotated-${generation}`
        await binding!.activate(id, next, generation)
        expect(service.activeEntryForSession(id)).toBeUndefined()
        expect(() => service.workspaceManager.resolve(id)).toThrow(/no active/)
        oldIds.push(id)
        id = next
      }
      return { sessionId: agent.id, completion: idle.promise }
    }
    gate.resolve()
    const store = service.registry.stateStore(admission.evolutionId)
    const round = await eventually(() => store.readRound(admission.roundId) as Promise<RefinementRound>,
      round => round.candidatePool[0]?.metaSessionId?.endsWith('-rotated-2') === true)
    expect(new Set(workspaceIds).size).toBe(1)
    expect(round.candidatePool[0]!.generationAttempts).toHaveLength(1)
    await finalize(service, round)
    idle.resolve({ reason: 'completed' })
    const completed = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'accepted')
    expect(completed!.candidatePool[0]!.meta?.sessionId).toBe(round.candidatePool[0]!.metaSessionId)
    expect(completed!.candidatePool[0]!.resultCheckpoint?.sourceSessionId).toBe(round.candidatePool[0]!.metaSessionId)
    expect(completed!.candidatePool[0]!.generationAttempts).toHaveLength(1)
    expect(oldIds).toHaveLength(2)
    await service.dispose()
  })

  it('restores the sealed attempt parent when the default root checkpoint changes after restart', async () => {
    const { service, evaluator, metas, registry } = await setup()
    service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
    const gate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => { await gate.promise; return evaluate(...args) }
    const admission = await service.admit('api')
    const store = registry.stateStore(admission.evolutionId)
    const meta = metas.get(admission.evolutionId)! as unknown as MetaSessionController
    let saved: MetaExecutionState | undefined
    meta.wakeCandidate = async (round, candidate, baseline, agent, binding) => {
      const workspace = service.workspaceManager.resolve(agent.id)
      await mkdir(join(workspace.targetPath, 'prompts'), { recursive: true })
      await writeFile(join(workspace.targetPath, 'prompts', 'before-crash.md'), 'uncommitted work')
      const checkpointState: MetaExecutionState = {
        schemaVersion: 1, executionId: binding!.executionId, evolutionId: round.evolutionId,
        specDigest: digestJson(await registry.requireSpec(round.evolutionId)), roundId: round.roundId,
        candidateId: candidate!.candidateId, attempt: binding!.attempt, generation: 0, revision: 0,
        activeSessionId: agent.id, sessions: [agent.id], status: 'rotating', deadlineAt: binding!.deadlineAt,
        usage: { modelRequests: 1, tokens: 100, summaryRequests: 0, summaryTokens: 0 },
        pending: [], deliveredIds: [], handoffs: [],
        intent: { trigger: 'pressure', pressure: 9000, source: candidate!.parentCheckpoint!, successorSessionId: 'successor', phase: 'intent' },
        recovery: { envelope: contextMessage('Continue the current candidate'), controller: await binding!.snapshot(),
          evidence: { evolutionId: round.evolutionId, roundId: round.roundId, baselineEvalId: baseline!.evalId,
            summaryAccessed: true, accessedRefs: [], diagnosedRunRefs: [], citedRefs: [] } },
      }
      await new MetaOffloadingStore(store.root).cas(undefined, checkpointState)
      saved = checkpointState
      return { sessionId: agent.id }
    }
    gate.resolve()
    await eventually(async () => saved, value => value !== undefined)
    const original = (await store.readRound(admission.roundId))!
    const parent = original.candidatePool[0]!.parentCheckpoint!
    expect((await store.readPopulation())!.members[0]!.metaCheckpoint).toBeUndefined()
    await service.dispose()
    const workspaces = new CandidateWorkspaceManager(service.workspaceManager.options)
    let snapshot: unknown
    let restoredExecutionId: string | undefined
    const recovering = new RefineService(registry, service.builder, workspaces, (spec, digest, stateStore) => {
      const cold = new FakeMeta(spec.evolutionId, stateStore, digest) as unknown as MetaSessionController
      const checkpoint = cold.checkpoint.bind(cold)
      cold.checkpoint = async id => id === undefined ? { ...parent, sourceSessionId: 'new-empty-root-after-restart' } : checkpoint(id)
      cold.restore = async (id, executionId) => { restoredExecutionId = executionId; return { id } }
      cold.wakeCandidate = async (_round, _candidate, _baseline, agent, binding) => {
        snapshot = await binding!.snapshot()
        return { sessionId: agent.id }
      }
      return cold
    }, evaluator, service.options, service.components)
    try {
      await recovering.initialize()
      await eventually(async () => snapshot, value => value !== undefined)
      expect(snapshot).toEqual(saved!.recovery!.controller)
      expect(restoredExecutionId).toBe(saved!.executionId)
      const resumed = (await store.readRound(admission.roundId))!
      expect(resumed.candidatePool[0]!.parentCheckpoint).toEqual(parent)
      expect(resumed.candidatePool[0]!.generationAttempts).toHaveLength(1)
      const workspace = workspaces.resolve(resumed.candidatePool[0]!.metaSessionId!)
      expect(workspace.workspaceId).toBe(original.candidatePool[0]!.workspaceId)
      expect(await readFile(join(workspace.targetPath, 'prompts', 'before-crash.md'), 'utf8')).toBe('uncommitted work')
      expect(evaluator.calls).toEqual(['seed-baseline'])
      await finalize(recovering, resumed)
      await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    } finally { await recovering.dispose() }
  })

  it.each(['max-tokens', 'error'])('retries when a Meta turn ends with %s and retains the cause', async reason => {
    const { service, evaluator, metas } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000)
    const baselineGate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    let blockBaseline = true
    evaluator.evaluate = async (...args) => {
      if (blockBaseline) {
        blockBaseline = false
        await baselineGate.promise
      }
      return evaluate(...args)
    }
    const admission = await service.admit('api')
    const meta = metas.get(admission.evolutionId)
    if (meta === undefined) throw new Error('Meta fixture is unavailable')
    const error = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Your input exceeds the context window of this model.' }
    meta.turnCompletions.push({
      reason, ...(reason === 'error' ? { error } : {}), turn: 1, durationMs: 69_000, effectiveMaxTokens: 8192,
      usage: { inputTokens: 11_074, outputTokens: 8192, cacheReadTokens: 18_688, reasoningTokens: 8192 },
    })
    baselineGate.resolve()

    const store = service.registry.stateStore(admission.evolutionId)
    const retried = await eventually(
      () => store.readRound(admission.roundId) as Promise<RefinementRound>,
      value => value?.status === 'candidate-editing'
        && value.candidatePool[0]?.generationAttempts?.length === 2,
    )
    expect(retried.candidatePool[0]?.generationAttempts?.[0]).toMatchObject({
      status: 'failed',
      metaTurn: {
        reason, ...(reason === 'error' ? { error } : {}), effectiveMaxTokens: 8192,
        usage: { outputTokens: 8192, reasoningTokens: 8192 },
      },
      failure: { message: expect.stringContaining('without candidate.finalize or candidate.decline') },
    })
    if (reason === 'error') {
      expect(retried.candidatePool[0]?.generationAttempts?.[0]?.failure?.message).toContain(error.code)
      expect(retried.candidatePool[0]?.generationAttempts?.[0]?.failure?.message).toContain(error.message)
    }
    expect((await service.status(admission.evolutionId, admission.roundId)).candidateGeneration)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        attempts: expect.arrayContaining([expect.objectContaining({
          status: 'failed', metaTurn: expect.objectContaining({ reason }),
        })]),
      })]))
    await finalize(service, retried)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    await service.dispose()
  })

  it('restores 40 of 56 diagnoses after a real attempt timeout and completes only the remaining 16', async () => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator } = await setup(0.8, false, 1, 30_000, 1, 0, 2, 90_000, coordinator)
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => {
      const result = await evaluate(...args)
      result.trials = Array.from({ length: 56 }, (_, index) => ({
        taskName: `task-${index}`, trialName: `trial-${index}`, attempt: 1,
        runId: `run_${index.toString(16).padStart(32, '0')}`, status: 'completed' as const, rewards: { reward: 0 },
      }))
      result.plannedTrialCount = 56
      result.primaryReward = 0
      result.summary = { total: 56, failed: 56, passed: 0, score: 0 }
      return result
    }
    const inspected: string[] = []
    const reader: HitchTrajectoryReader = {
      async inspectCapabilities() { return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 } },
      async inspectTrajectoryAnalysis(runId) {
        inspected.push(runId)
        return trajectoryAnalysis(runId, [
          { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `Task for ${runId}` }] } },
          { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Observed failed attempt' }] } } },
        ])
      },
      async inspectTrajectoryEvents() { throw new Error('no detail fetch needed') },
      async inspectVerifierEvidence(runId) { return { runId, verifier: { status: 'result_only' } } },
    }
    let capabilities = new RefineCapabilities(service, service.builder, { trajectoryReader: reader })
    const originalSetTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const handle = originalSetTimeout(...args)
      if (args[1] === 30_000 && expire === undefined) expire = () => { clearTimeout(handle); args[0]() }
      return handle
    })
    try {
      const admission = await service.admit('skill')
      const first = await editing(service, admission.evolutionId, admission.roundId)
      const claim = await eventually(async () => coordinator.claim('same-client', skillHarnessIdentity(service.options.metaAgent)), value => value !== undefined)
      const sessionId = claim!.sessionId
      const baseline = first.baseline!
      const refs = baseline.trials.map(value => value.runId!)
      for (let index = 0; index < 40; index += 5) {
        await capabilities.call('refine-meta', sessionId, 'trajectory.query', { refs: refs.slice(index, index + 5) })
      }
      expect(await service.readCandidateDiagnoses(sessionId)).toHaveLength(40)
      expect(await capabilities.call('refine-meta', sessionId, 'trajectory.query', {})).toMatchObject({
        diagnosisProgress: { diagnosed: 40, required: 56 },
      })
      const reconnect = coordinator.claim('same-client', skillHarnessIdentity(service.options.metaAgent))!
      expect(reconnect.generationBudget?.deadlineAt).toBe(claim!.generationBudget?.deadlineAt)
      expect(reconnect.generationBudget!.remainingMs).toBeLessThanOrEqual(claim!.generationBudget!.remainingMs)
      expire!()
      const store = service.registry.stateStore(admission.evolutionId)
      await eventually(() => store.readRound(admission.roundId), value => value?.status === 'candidate-editing'
        && value.candidatePool[0]?.generationAttempts?.length === 2 && value.candidatePool[0]?.metaSessionId !== sessionId)
      const retry = await eventually(async () => coordinator.claim('same-client', skillHarnessIdentity(service.options.metaAgent)), value => value !== undefined)
      expect(retry!.retryRecovery).toEqual({ workspace: 'fresh', diagnosis: 'query-current-baseline' })
      expect(retry!.generationBudget?.roundDeadlineAt).toBe(claim!.generationBudget?.roundDeadlineAt)
      expect(retry!.workspaceId).not.toBe(claim!.workspaceId)
      await expect(capabilities.call('refine-meta', sessionId, 'trajectory.query', {})).rejects.toThrow(/no active/)
      // Recreate the capability layer to prove recovery reads disk, not its caches.
      capabilities = new RefineCapabilities(service, service.builder, { trajectoryReader: reader })
      const result = await capabilities.call('refine-meta', retry!.sessionId, 'trajectory.query', {}) as {
        diagnosisRecovery: { restored: Array<{ runId: string; detailRef: string }> }; diagnosisProgress: { diagnosed: number }
      }
      expect(result.diagnosisRecovery.restored).toHaveLength(40)
      expect(result).toMatchObject({ diagnosisProgress: { diagnosed: 40, required: 56, remainingRunIds: refs.slice(40) } })
      expect(renderTrajectoryResult(result as never)).toContain('Observed failed attempt')
      expect(renderTrajectoryResult(result as never)).toContain('GENERATION BUDGET')
      const detail = await capabilities.call('refine-meta', retry!.sessionId, 'trajectory.query', {
        detailRef: result.diagnosisRecovery.restored[0]!.detailRef,
      })
      expect(JSON.stringify(detail)).toContain('Observed failed attempt')
      expect(inspected).toHaveLength(80) // 40 original reads + 40 content checks, no model rediagnosis.
      for (let index = 40; index < 56; index += 5) {
        await capabilities.call('refine-meta', retry!.sessionId, 'trajectory.query', { refs: refs.slice(index, index + 5) })
      }
      expect(await capabilities.call('refine-meta', retry!.sessionId, 'candidate.decline', {
        rationale: 'All 56 failures inspected; no safe intervention in this test.', evidenceRefs: [baseline.evalId],
      })).toMatchObject({ accepted: true })
      const settled = await eventually(() => store.readRound(admission.roundId), value => value?.candidatePool[0]?.generationAttempts?.[1]?.status === 'succeeded')
      expect(settled!.candidatePool[0]!.proposalEvidence!.diagnosisReceipts).toHaveLength(56)
      expect(inspected).toHaveLength(96)
    } finally { timer.mockRestore(); await service.dispose() }
  })

  it('retries a timed-out candidate in the same round with a fresh workspace', async () => {
    const attemptBudgetMs = 30_000
    const { service, evaluator, metas } = await setup(0.8, false, 1, attemptBudgetMs, 1, 0, 2, 90_000)
    // Expire the first real deadline callback explicitly. A 500ms wall-clock
    // budget also races the retry's Git/file operations on slower CI runners.
    const originalSetTimeout = globalThis.setTimeout
    let expireFirstAttempt: (() => void) | undefined
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args)
      if (args[1] === attemptBudgetMs && expireFirstAttempt === undefined) {
        expireFirstAttempt = () => { clearTimeout(timer); args[0]() }
      }
      return timer
    })
    try {
      const admission = await service.admit('api', { rounds: 2 })
      const first = await editing(service, admission.evolutionId, admission.roundId)
      const firstWorkspaceId = service.activeEntry(first.roundId)?.workspace?.workspaceId
      const firstSessionId = first.candidatePool[0]?.metaSessionId
      if (firstWorkspaceId === undefined || firstSessionId === undefined) throw new Error('first generation attempt is unavailable')

      if (expireFirstAttempt === undefined) throw new Error('candidate deadline was not scheduled')
      expireFirstAttempt()
      const store = service.registry.stateStore(admission.evolutionId)
      const retried = await eventually(
        () => store.readRound(admission.roundId) as Promise<RefinementRound>,
        value => {
          const retrySessionId = value?.candidatePool[0]?.metaSessionId
          const retryWorkspaceId = value === undefined ? undefined : service.activeEntry(value.roundId)?.workspace?.workspaceId
          return value?.status === 'candidate-editing'
            && retrySessionId !== undefined && retrySessionId !== firstSessionId
            && retryWorkspaceId !== undefined && retryWorkspaceId !== firstWorkspaceId
        },
      )
      expect(await store.listRounds()).toHaveLength(1)
      await finalize(service, retried)
      const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
      expect(terminal?.roundIndex).toBe(1)
      expect(terminal?.candidatePool[0]?.generationAttempts).toMatchObject([
        { attempt: 1, status: 'failed', failure: { phase: 'candidate-generation' } },
        { attempt: 2, status: 'succeeded' },
      ])
      const attempts = terminal?.candidatePool[0]?.generationAttempts
      expect(attempts?.[0]?.workspaceId).not.toBe(attempts?.[1]?.workspaceId)
      expect(attempts?.[0]?.metaSessionId).not.toBe(attempts?.[1]?.metaSessionId)
      expect(metas.get(admission.evolutionId)?.forks).toEqual([
        terminal?.candidatePool[0]?.parentCheckpoint,
        terminal?.candidatePool[0]?.parentCheckpoint,
      ])
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
    } finally {
      timerSpy.mockRestore()
      await service.dispose()
    }
  })

  it('does not start a continuation when disposal overlaps its final registry write', async () => {
    const { service, registry, metas } = await setup()
    const admission = await service.admit('api', { rounds: 2 })
    const first = await editing(service, admission.evolutionId, admission.roundId)
    const store = metas.get(admission.evolutionId)!.store
    const touchStarted = Promise.withResolvers<void>()
    const releaseTouch = Promise.withResolvers<void>()
    const originalTouch = registry.touch.bind(registry)
    const originalReadRound = store.readRound.bind(store)
    let continuationRoundId: string | undefined
    let disposing = false
    let continuationReads = 0
    const touchSpy = vi.spyOn(registry, 'touch').mockImplementation(async (evolutionId, update) => {
      await originalTouch(evolutionId, update)
      if (update.roundId !== undefined && update.roundId !== admission.roundId) {
        continuationRoundId = update.roundId
        touchStarted.resolve()
        await releaseTouch.promise
      }
    })
    const readSpy = vi.spyOn(store, 'readRound').mockImplementation(async roundId => {
      if (disposing && roundId === continuationRoundId) {
        // A late drive would access this round after shutdown began. Refuse
        // that access so a failing regression cannot leave a background writer.
        continuationReads += 1
        return undefined
      }
      return originalReadRound(roundId)
    })
    try {
      await finalize(service, first)
      await touchStarted.promise
      disposing = true
      const pendingDisposal = service.dispose()
      releaseTouch.resolve()
      await pendingDisposal

      expect(continuationReads).toBe(0)
      expect(continuationRoundId).toBeDefined()
      expect(await originalReadRound(continuationRoundId!)).toMatchObject({ status: 'queued' })
      expect(service.activeEntry(continuationRoundId!)).toBeUndefined()
      const lock = await store.acquireRoundLock()
      await lock.release()
    } finally {
      releaseTouch.resolve()
      await service.dispose()
      touchSpy.mockRestore()
      readSpy.mockRestore()
    }
  })

  it('enforces the attempt deadline while Meta fork is still pending', async () => {
    const { service, evaluator, metas } = await setup(0.8, false, 1, 40, 1, 0, 1, 100)
    const baselineGate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => {
      await baselineGate.promise
      return evaluate(...args)
    }
    const admission = await service.admit('api')
    const meta = metas.get(admission.evolutionId)
    if (meta === undefined) throw new Error('Meta fixture is unavailable')
    meta.fork = async () => new Promise<never>(() => {})
    baselineGate.resolve()

    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    expect(terminal?.candidatePool[0]?.generationAttempts).toMatchObject([
      { attempt: 1, status: 'failed', failure: { message: expect.stringMatching(/40ms attempt budget/) } },
    ])
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    await service.dispose()
  })

  it('continues with a successful sibling when another candidate times out', async () => {
    const attemptBudgetMs = 30_000
    const { service } = await setup(0.8, false, 2, attemptBudgetMs, 1, 0, 1, 90_000)
    // Trigger only the first sibling's deadline; finalizing the successful
    // sibling includes Git and evidence checks that must not race a 500ms timer.
    const originalSetTimeout = globalThis.setTimeout
    let expireFirstAttempt: (() => void) | undefined
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args)
      if (args[1] === attemptBudgetMs && expireFirstAttempt === undefined) {
        expireFirstAttempt = () => { clearTimeout(timer); args[0]() }
      }
      return timer
    })
    try {
      const admission = await service.admit('api')
      const first = await editing(service, admission.evolutionId, admission.roundId)
      const firstCandidateId = first.candidatePool.find(candidate => candidate.metaSessionId !== undefined)?.candidateId
      if (firstCandidateId === undefined) throw new Error('first sibling is unavailable')
      if (expireFirstAttempt === undefined) throw new Error('candidate deadline was not scheduled')
      expireFirstAttempt()
      const store = service.registry.stateStore(admission.evolutionId)
      const second = await eventually(
        () => store.readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && value.candidatePool.some(candidate => candidate.candidateId !== firstCandidateId
            && candidate.metaSessionId !== undefined
            && service.activeEntry(value.roundId)?.workspace?.workspaceId === candidate.workspaceId),
      )
      await finalize(service, second)
      const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
      expect(terminal?.candidatePool.find(candidate => candidate.candidateId === firstCandidateId)).toMatchObject({
        status: 'failed', failure: { phase: 'candidate-generation' },
      })
      expect(terminal?.candidatePool.filter(candidate => candidate.status === 'selected')).toHaveLength(1)
    } finally {
      timerSpy.mockRestore()
      await service.dispose()
    }
  })

  it('preserves rejected-for-substrate instead of reporting retry exhaustion', async () => {
    const { service } = await setup()
    service.builder.finalizeWorkspace = async () => {
      throw new SubstrateExpansionError('candidate requires a fixed substrate change')
    }
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'rejected-for-substrate',
    )
    expect(terminal?.decision).toBe('rejected-for-substrate')
    expect(terminal?.failure).toMatchObject({
      phase: 'rejected-for-substrate', message: expect.stringMatching(/fixed substrate change/),
    })
    await service.dispose()
  })

  it('fails the round and stops the batch after candidate generation retries are exhausted', async () => {
    const { service } = await setup(0.8, false, 1, 40, 1, 0, 2, 200)
    const admission = await service.admit('api', { rounds: 2 })
    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
    expect(terminal?.decision).toBeUndefined()
    expect(terminal?.failure).toMatchObject({ phase: 'candidate-generation' })
    expect(terminal?.candidatePool[0]?.generationAttempts).toHaveLength(2)
    expect(terminal?.candidatePool[0]?.generationAttempts?.every(attempt => attempt.status === 'failed')).toBe(true)
    expect(await store.listRounds()).toHaveLength(1)
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    await service.dispose()
  })

  it('settles a running candidate generation attempt when recovering after restart', async () => {
    const { service, evaluator, registry } = await setup()
    const admission = await service.admit('api')
    await editing(service, admission.evolutionId, admission.roundId)
    const store = registry.stateStore(admission.evolutionId)
    await service.dispose()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'candidate-editing',
      candidatePool: [{ generationAttempts: [{ status: 'running' }] }],
    })

    const recovering = new RefineService(
      registry,
      service.builder,
      service.workspaceManager,
      (spec, digest, runtimeStore) => new FakeMeta(spec.evolutionId, runtimeStore, digest) as never,
      evaluator,
      service.options,
      service.components,
    )
    await recovering.initialize()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'failed',
      failure: { phase: 'recovery' },
      candidatePool: [{
        status: 'failed',
        generationAttempts: [{
          status: 'failed', completedAt: expect.any(String),
          failure: { phase: 'candidate-generation', message: 'control plane restarted during candidate generation' },
        }],
      }],
    })
    await recovering.dispose()
  })
})

describe('explicit staged search control-plane integration', () => {
  it.each([{ process: false, recovery: 'none' }, { process: true, recovery: 'none' }, { process: true, recovery: 'resume' }, { process: true, recovery: 'restart' }, { process: false, recovery: 'timeout' }])('delivers a scoped workplan and recovers v2 promotion ($process/$recovery)', async ({ process, recovery }) => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator, git } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000, coordinator)
    const fixture = searchFixtures(20, process)
    const evaluate = fixture.provider.evaluate.bind(fixture.provider)
    let ready = recovery === 'none'
    let restarted: RefineService | undefined
    fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'remote-heldout-17' })
    fixture.provider.evaluate = async input => {
      const cells = await evaluate({ ...input, snapshot: { ...input.snapshot, candidateId: input.snapshot.commit === git.championRef ? 'anchor' : input.snapshot.candidateId } })
      if (!ready && input.plan.stage === 'held-out' && input.snapshot.commit !== git.championRef) throw new Error('lost held-out transport')
      return cells
    }
    const diagnose = fixture.diagnosis.diagnose.bind(fixture.diagnosis)
    fixture.diagnosis.diagnose = async input => { const output = await diagnose(input); return { ...output, facts: output.facts.map(f => ({ ...f, modificationPaths: ['prompts'] })) } }
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = searchSettings()
    if (recovery === 'timeout') service.options.searchSettings.budgets.round.timeoutMs = 2500
    try {
      const admitted = await service.admit('api')
      const store = service.registry.stateStore(admitted.evolutionId)
      const current = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'candidate-editing' || r?.status === 'failed' || r?.status === 'rejected')
      expect(current?.status, current?.failure?.message).toBe('candidate-editing')
      const assignment = (await eventually(async () => coordinator.claim('test-client', skillHarnessIdentity(service.options.metaAgent), admitted.evolutionId), a => a !== undefined))!
      expect(assignment.workplanDelivery?.workplan.hypothesis).toBeTruthy()
      expect(assignment.evidencePolicy.diagnoseEveryFailedRunBeforeProposal).toBe(false)
      if (recovery === 'timeout') {
        const terminal = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'failed' || r?.status === 'rejected')
        expect(terminal?.status, terminal?.failure?.message).toBe('rejected')
        expect(terminal?.searchOutcome?.championChanged).toBe(false)
        expect(terminal?.candidatePool[0]?.generationAttempts).toHaveLength(1)
        expect(terminal?.candidatePool[0]?.generationAttempts?.[0]?.status).toBe('failed')
        expect(fixture.executions.every(e => e.participant === 'anchor')).toBe(true)
        expect(await store.readChampion()).toMatchObject({ ref: git.championRef })
        return
      }
      const active = service.activeEntry(admitted.roundId)!
      const workspace = service.workspaceManager.resolve(assignment.sessionId)
      await mkdir(join(workspace.targetPath, 'prompts'), { recursive: true })
      await writeFile(join(workspace.targetPath, 'prompts', 'search-improvement.md'), 'Improve the assigned fixture workflow.\n')
      const refs = [assignment.baseline.evalId]
      const attribution = await active.meta.proposalAttribution(admitted.roundId, assignment.sessionId, {})
      const evidence = active.meta.proposalEvidenceAudit(admitted.roundId, assignment.sessionId, refs)
      expect(evidence.workplanReceipt?.kind).toBe('workplan-dossier-consumed')
      expect(evidence.diagnosisReceipts).toEqual([])
      await service.submitFinalization(admitted.evolutionId, admitted.roundId, { rationale: 'Repair the assigned workflow', expectedOutcome: 'Higher completion', evidenceRefs: refs }, undefined, attribution, evidence)
      if (recovery !== 'none') {
        const failed = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'failed')
        expect(failed?.failure?.message).toContain('operation pending')
        await eventually(async () => service.activeEntry(admitted.roundId), active => !active)
        const status = await service.status(admitted.evolutionId, admitted.roundId)
        expect(status.searchPendingOperation).toMatchObject({ state: 'running', partition: 'held-out', handle: 'remote-heldout-17' })
        ready = true
        if (recovery === 'resume') await service.resumeSearchRound(admitted.evolutionId, admitted.roundId)
        else {
          await service.dispose()
          restarted = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
          await restarted.initialize()
        }
      }
      const terminal = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'accepted' || r?.status === 'failed' || r?.status === 'rejected')
      expect(terminal?.status, JSON.stringify(terminal?.failure ?? terminal?.searchOutcome)).toBe('accepted')
      expect(terminal?.searchOutcome?.championChanged).toBe(true)
      expect(evaluator.calls).toEqual([])
      expect(await store.readChampion()).toMatchObject({ ref: terminal!.candidatePool[0]!.sealedVersion!.commitOid })
    } finally { await restarted?.dispose(); await service.dispose() }
  })
})
