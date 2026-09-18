import { scopedFrontierPolicy } from '../../src/search/policies/parents.js'
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
import { builtinComponentRef, componentRef, rolloutProviderSemanticDigest } from '../../src/evolution/components.js'
import { hitchCliImplementation } from '../../src/evolution/component-identity.js'
import { evolutionSpec } from '../helpers/research-fixture.js'
import { SkillMetaCoordinator, SkillMetaSessionManager, skillHarnessIdentity } from '../../src/meta/skill.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { RefineSkillGateway } from '../../src/skill/gateway.js'
import { renderTrajectoryResult } from '../../src/notebook/tool.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'
import type { HitchTrajectoryReader } from '../../src/types.js'
import { fixtures as searchFixtures, settings as searchSettings, regressionSuiteFixture, revise } from '../helpers/search-fixture.js'
import { SearchStore } from '../../src/search/store.js'
import { standardSearchDataset } from '../helpers/standard-search-dataset.js'
import { digestDatasetRef } from '../../src/state/dataset.js'

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
  readonly capabilities = { aggregateGenerationBudget: true }
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

function skillSearchSettings() {
  const settings = searchSettings()
  for (const budget of [settings.budgets.round, settings.budgets.evolution]) {
    delete budget.maxGenerationTokens
    delete budget.maxGenerationRequests
  }
  return settings
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

function enableBaselineSources(service: RefineService, evaluator: FakeEvaluator): void {
  const hitchRoot = join(service.options.workspaceRoot, 'hitch-data')
  const agentConfig = { agentArgs: [] as string[] }
  const config = {
    executable: '/test/hitch',
    harnessId: 'test',
    root: hitchRoot,
    model: 'deepseek-chat',
    attempts: 1,
    maxConcurrent: 1,
    seeds: [] as number[],
    sampling: {},
    agentArgs: [] as string[],
    allowUnavailableVerifierDiagnosis: true,
    controlPlane: { mode: 'direct', requireModelCapture: false },
  }
  const provider = componentRef('rollout-provider', 'hitch-cli', hitchCliImplementation(), config)
  service.options.rollout = {
    provider,
    providerSemanticDigest: rolloutProviderSemanticDigest(provider, { harnessId: config.harnessId }, agentConfig),
    taskSampler: builtinComponentRef('task-sampler', 'dataset', {}),
    repetitions: 1,
    model: config.model,
    sampling: {},
    agentConfig,
  }
  Object.assign(evaluator, {
    options: { root: hitchRoot },
    async inspectCapabilities() {
      return { schemaVersion: 1 as const, trajectoryAnalysis: 1 as const, trajectoryEventsPage: 1 as const }
    },
    async inspectTrajectoryAnalysis(runId: string) {
      return trajectoryAnalysis(runId, [])
    },
    async inspectTrajectoryEvents() {
      throw new Error('baseline source admission does not request trajectory event pages')
    },
  })
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

async function skillFinalization(
  service: RefineService,
  round: RefinementRound,
  sessionId: string,
  mode: 'decline' | 'finalize',
): Promise<void> {
  const active = service.activeEntry(round.roundId)
  const candidate = round.candidatePool.find(value => value.metaSessionId === sessionId)
  if (active?.workspace === undefined || round.baseline === undefined || candidate === undefined) {
    throw new Error('skill candidate is not editable')
  }
  if (mode === 'finalize') {
    await mkdir(join(active.workspace.targetPath, 'prompts'), { recursive: true })
    await writeFile(join(active.workspace.targetPath, 'prompts', `${candidate.candidateId}.md`), 'improved context\n')
  }
  const failed = round.baseline.trials.flatMap(trial => (
    (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : []
  ))
  const runRefs = round.baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId])
  const finalization = mode === 'finalize' ? {
    rationale: 'fix observed failures', expectedOutcome: 'higher reward',
    evidenceRefs: [round.baseline.evalId], semanticTargets: ['context' as const],
  } : null
  const decline = mode === 'decline' ? {
    rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [],
  } : undefined
  await service.submitFinalization(round.evolutionId, round.roundId, finalization, decline,
    await active.meta.proposalAttribution(round.roundId, sessionId, finalization), {
    evolutionId: round.evolutionId,
    roundId: round.roundId,
    candidateId: candidate.candidateId,
    baselineEvalId: round.baseline.evalId,
    summaryAccessed: true,
    accessedRefs: [round.baseline.evalId, ...runRefs],
    diagnosedRunRefs: failed,
    diagnosisReceipts: diagnosisReceipts(failed),
    citedRefs: finalization?.evidenceRefs ?? [],
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

  async function reopenAcceptedRoundBeforeHeldOutCandidate(service: RefineService) {
    const admission = await service.admit('api')
    const store = service.registry.stateStore(admission.evolutionId)
    const initialChampion = await store.readChampion()
    const initialPopulation = await store.readPopulation()
    await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
    const accepted = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'accepted')
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    if (accepted?.evaluation?.heldOutBaseline === undefined || initialChampion === undefined || initialPopulation === undefined) {
      throw new Error('accepted fixture is missing durable recovery state')
    }
    const finalist = accepted.candidatePool.find(candidate => candidate.candidateId === accepted.promotionCandidateId)
    if (finalist?.seedComparison === undefined || finalist.sealedVersion === undefined) {
      throw new Error('accepted fixture is missing its selected finalist')
    }
    const reopened = structuredClone(accepted)
    reopened.status = 'failed'
    reopened.failure = { phase: 'held-out-running', message: 'simulated interruption before the selected held-out evaluation' }
    delete reopened.decision
    delete reopened.commitIntent
    delete reopened.promotedCandidateId
    reopened.candidatePool = reopened.candidatePool.map(candidate => {
      if (candidate.candidateId !== finalist.candidateId) return candidate
      const { heldOutEvaluation: _heldOutEvaluation, ...selected } = candidate
      return selected
    })
    const fullEvaluation = accepted.evaluation
    reopened.evaluation = {
      seedBaseline: fullEvaluation.seedBaseline,
      seedCandidate: fullEvaluation.seedCandidate,
      seedPairedTrials: fullEvaluation.seedPairedTrials,
      seedPairing: fullEvaluation.seedPairing,
      heldOutBaseline: fullEvaluation.heldOutBaseline!,
      scoreDelta: fullEvaluation.scoreDelta,
      ...(fullEvaluation.processScoreDelta === undefined ? {} : { processScoreDelta: fullEvaluation.processScoreDelta }),
      requiredRegressions: finalist.seedComparison.requiredRegressions,
    }
    reopened.evaluationStarts = (reopened.evaluationStarts ?? []).filter(start =>
      start.phase !== 'held-out-candidate' || start.harnessRef !== finalist.sealedVersion!.commitOid)
    reopened.evaluationAttempts = (reopened.evaluationAttempts ?? []).filter(attempt =>
      attempt.phase !== 'held-out-candidate' || attempt.requestedCommit !== finalist.sealedVersion!.commitOid)
    await store.writeChampion(initialChampion)
    await store.writePopulation(initialPopulation)
    await store.writeRound(reopened)
    return { admission, store, reopened, finalist, initialChampion, initialPopulation }
  }

  it('seals prior seed candidate outcomes before the next skill proposer starts', async () => {
    const { service } = await setup()
    const admission = await service.admit('skill', { rounds: 2 })
    const store = service.registry.stateStore(admission.evolutionId)
    const first = await editing(service, admission.evolutionId, admission.roundId)
    expect((await service.registry.requireSpec(admission.evolutionId)).experienceMemory).toEqual({
      schemaVersion: 1, enabled: true,
    })
    expect(first.experienceSnapshot).toMatchObject({ schemaVersion: 1, members: [] })
    await finalize(service, first)

    const second = await eventually(
      async () => (await store.listRounds()).find(round => round.roundIndex === 2),
      round => round?.status === 'candidate-editing',
    )
    expect(second?.experienceSnapshot?.members).toHaveLength(1)
    const member = second!.experienceSnapshot!.members[0]!
    expect(member.sourceRoundId).toBe(first.roundId)
    const record = await store.readExperienceRecord(member.recordDigest)
    expect(record).toMatchObject({
      source: {
        evolutionId: admission.evolutionId,
        roundId: first.roundId,
        candidateId: first.candidatePool[0]!.candidateId,
        parentHarnessRef: first.candidatePool[0]!.parentHarnessRef,
      },
      observation: { comparison: 'candidate-vs-its-parent-seed', valid: 10 },
      classification: { execution: 'evaluated' },
    })
    expect(second!.experienceSnapshot!.members.every(value => value.sourceRoundId !== second!.roundId)).toBe(true)
    await finalize(service, second!)
    await eventually(() => store.readRound(second!.roundId), round => round?.status === 'accepted' || round?.status === 'rejected')
    await service.dispose()
  })

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

  it.each(['live', 'restart'] as const)(
    'fails only the leased Meta round and reuses its complete baseline on %s continue',
    async mode => {
      const coordinator = new SkillMetaCoordinator()
      const { service, evaluator, registry } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000, coordinator)
      let resumed: RefineService | undefined
      try {
        const admission = await service.admit('skill')
        const editable = await editing(service, admission.evolutionId, admission.roundId)
        const identity = skillHarnessIdentity(await registry.requireSpec(admission.evolutionId).then(spec => spec.metaAgent))
        const claim = await eventually(
          async () => coordinator.claim('runner-1', identity, admission.evolutionId),
          value => value !== undefined,
        )
        if (claim === undefined) throw new Error('skill assignment was not claimed')
        const gateway = new RefineSkillGateway(service, coordinator, {} as never, {} as never)
        const params = {
          clientId: 'runner-1', leaseId: claim.leaseId, leaseToken: claim.leaseToken,
          reason: 'runner exited without a confirmed submission',
        }

        await expect(gateway.call('meta.fail', { ...params, leaseToken: 'wrong' })).rejects.toThrow(/lease/)
        expect((await registry.stateStore(admission.evolutionId).readRound(admission.roundId))?.status).toBe('candidate-editing')
        await expect(gateway.call('meta.fail', params)).resolves.toMatchObject({
          failed: true,
          evolutionId: admission.evolutionId,
          roundId: admission.roundId,
          candidateId: claim.candidateId,
        })

        const store = registry.stateStore(admission.evolutionId)
        const failed = await store.readRound(admission.roundId)
        expect(failed).toMatchObject({
          status: 'failed',
          failure: { phase: 'candidate-editing', message: expect.stringMatching(/runner exited/) },
          candidatePool: [{
            candidateId: claim.candidateId,
            status: 'failed',
            failure: { phase: 'candidate-generation', message: expect.stringMatching(/runner exited/) },
            generationAttempts: [{
              status: 'failed', completedAt: expect.any(String),
              failure: { phase: 'candidate-generation', message: expect.stringMatching(/runner exited/) },
            }],
          }],
        })
        expect(failed?.decision).toBeUndefined()
        expect((await registry.readEntry(admission.evolutionId))?.status).toBe('active')
        expect(evaluator.calls).toEqual(['seed-baseline'])
        await expect(gateway.call('meta.fail', params)).rejects.toThrow(/stale/)

        let current = service
        if (mode === 'restart') {
          await service.dispose()
          resumed = restart(service, evaluator)
          await resumed.initialize()
          current = resumed
        }
        const continuation = await current.continueEvolution('skill', admission.evolutionId)
        const next = await editing(current, admission.evolutionId, continuation.roundId)
        expect(next.roundId).not.toBe(admission.roundId)
        expect(next.baseline?.evalId).toBe(editable.baseline?.evalId)
        expect(next.baseline?.trials.map(trial => trial.runId)).toEqual(editable.baseline?.trials.map(trial => trial.runId))
        expect(evaluator.calls).toEqual(['seed-baseline'])
        expect(await store.readRound(admission.roundId)).toEqual(failed)

        await expect(new RefineSkillGateway(current, coordinator, {} as never, {} as never)
          .call('meta.fail', params)).rejects.toThrow(/stale/)
        expect((await store.readRound(continuation.roundId))?.status).toBe('candidate-editing')
        const nextGateway = new RefineSkillGateway(current, coordinator, {} as never, {} as never)
        const pendingNextRound = await eventually(
          async () => coordinator.pending(),
          assignments => assignments.some(assignment => assignment.roundId === continuation.roundId),
        )
        expect(pendingNextRound).toEqual([
          expect.objectContaining({ roundId: continuation.roundId, candidateId: next.candidatePool[0]!.candidateId }),
        ])
        expect(await nextGateway.call('meta.claim', {
          clientId: 'runner-1', identity, evolutionId: admission.evolutionId, roundId: admission.roundId,
        })).toEqual({ pending: false })
        expect(coordinator.pending()).toEqual([
          expect.objectContaining({ roundId: continuation.roundId, candidateId: next.candidatePool[0]!.candidateId }),
        ])
        const nextClaim = await eventually(
          async () => nextGateway.call('meta.claim', {
            clientId: 'runner-1', identity, evolutionId: admission.evolutionId, roundId: continuation.roundId,
          }),
          value => typeof value === 'object' && value !== null && 'leaseToken' in value,
        ) as Awaited<ReturnType<SkillMetaCoordinator['claim']>>
        if (nextClaim === undefined) throw new Error('continued skill assignment was not claimed')
        expect(nextClaim.sessionId).not.toBe(claim.sessionId)
        await expect(nextGateway.call('meta.fail', {
          clientId: 'runner-1', leaseId: nextClaim.leaseId, leaseToken: nextClaim.leaseToken,
          reason: 'test cleanup',
        })).resolves.toMatchObject({ failed: true, roundId: continuation.roundId })
      } finally {
        await resumed?.dispose()
        await service.dispose()
      }
    },
  )

  it.each(['timeout', 'process-exit'] as const)(
    'preserves a durable evidence prerequisite when Meta ends by %s', async mode => {
      const attemptBudgetMs = 30_000
      const originalSetTimeout = globalThis.setTimeout
      let expireAttempt: (() => void) | undefined
      const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const timer = originalSetTimeout(...args)
        if (args[1] === attemptBudgetMs && expireAttempt === undefined) {
          expireAttempt = () => { clearTimeout(timer); args[0]() }
        }
        return timer
      })
      const coordinator = new SkillMetaCoordinator()
      const { service, registry } = await setup(0.8, false, 1, attemptBudgetMs, 1, 0, 2, 60_000, coordinator)
      try {
        const admission = await service.admit('skill', { rounds: 2 })
        const editable = await editing(service, admission.evolutionId, admission.roundId)
        const claim = await eventually(
          async () => coordinator.claim('runner-blocked', skillHarnessIdentity(await registry.requireSpec(admission.evolutionId)
            .then(spec => spec.metaAgent)), admission.evolutionId),
          value => value !== undefined,
        )
        if (claim === undefined) throw new Error('skill assignment was not claimed')
        const runId = editable.baseline!.trials[0]!.runId!
        const runtimeStore = service.activeEntry(admission.roundId)!.store
        const originalWrite = runtimeStore.writeRound.bind(runtimeStore)
        const blockerWriteStarted = Promise.withResolvers<void>()
        const releaseBlockerWrite = Promise.withResolvers<void>()
        let gateBlockerWrite = true
        const writeSpy = vi.spyOn(runtimeStore, 'writeRound').mockImplementation(async value => {
          if (gateBlockerWrite && value.candidatePool.some(candidate => candidate.generationAttempts
            ?.some(attempt => attempt.prerequisiteBlocker !== undefined))) {
            gateBlockerWrite = false
            blockerWriteStarted.resolve()
            await releaseBlockerWrite.promise
          }
          return originalWrite(value)
        })
        const recording = service.recordMetaPrerequisiteBlocker(claim.sessionId, {
          schemaVersion: 1,
          code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
          failedOperation: 'trajectory.query',
          blockedRuns: [{
            runId,
            code: 'hitch_verifier_diagnostic_source_incomplete',
            cause: 'legacy_truncated',
            resolution: 'repair-evidence',
          }],
        })
        await blockerWriteStarted.promise
        const settlement = mode === 'timeout'
          ? (() => {
              if (expireAttempt === undefined) throw new Error('candidate deadline was not scheduled')
              expireAttempt()
              return Promise.resolve()
            })()
          : service.failMetaExecution(
              admission.evolutionId,
              admission.roundId,
              claim.candidateId,
              claim.sessionId,
              'codex-process-exited-0',
            )
        releaseBlockerWrite.resolve()
        await Promise.all([recording, settlement])
        writeSpy.mockRestore()

        const failed = await eventually(
          () => registry.stateStore(admission.evolutionId).readRound(admission.roundId),
          value => value?.status === 'failed',
        )
        expect(failed).toMatchObject({
          status: 'failed',
          failure: {
            message: expect.stringContaining('TRAJECTORY_EVIDENCE_UNAVAILABLE'),
            prerequisite: {
              failedOperation: 'trajectory.query',
              blockedRuns: [{ runId, cause: 'legacy_truncated', resolution: 'repair-evidence' }],
            },
          },
          candidatePool: [{
            failure: { prerequisite: { blockedRuns: [{ runId, cause: 'legacy_truncated' }] } },
            generationAttempts: [{
              status: 'failed',
              prerequisiteBlocker: { blockedRuns: [{ runId, cause: 'legacy_truncated' }] },
              failure: { prerequisite: { blockedRuns: [{ runId, cause: 'legacy_truncated' }] } },
            }],
          }],
        })
        expect(failed?.failure?.message).not.toContain('codex-process-exited-0')
        expect(failed?.candidatePool[0]?.generationAttempts).toHaveLength(1)
        expect(await registry.stateStore(admission.evolutionId).listRounds()).toHaveLength(1)
      } finally {
        timerSpy.mockRestore()
        await service.dispose()
      }
    },
  )

  it.each(['decline', 'finalize'] as const)(
    'acknowledges a Skill %s only after its generation settlement is durable',
    async mode => {
      const coordinator = new SkillMetaCoordinator()
      const { service, registry } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000, coordinator)
      try {
        const admission = await service.admit('skill')
        const editable = await editing(service, admission.evolutionId, admission.roundId)
        const identity = skillHarnessIdentity(await registry.requireSpec(admission.evolutionId).then(spec => spec.metaAgent))
        const claim = await eventually(
          async () => coordinator.claim('runner-ack', identity, admission.evolutionId),
          value => value !== undefined,
        )
        if (claim === undefined) throw new Error('skill assignment was not claimed')
        const store = registry.stateStore(admission.evolutionId)
        const runtimeStore = service.activeEntry(admission.roundId)!.store
        const originalWrite = runtimeStore.writeRound.bind(runtimeStore)
        const settlementStarted = Promise.withResolvers<void>()
        const releaseSettlement = Promise.withResolvers<void>()
        let gateSettlement = true
        const writeSpy = vi.spyOn(runtimeStore, 'writeRound').mockImplementation(async value => {
          if (gateSettlement && value.candidatePool.some(candidate => candidate.generationAttempts?.some(attempt => attempt.status === 'succeeded'))) {
            gateSettlement = false
            settlementStarted.resolve()
            await releaseSettlement.promise
          }
          return originalWrite(value)
        })
        try {
          let acknowledged = false
          const submission = skillFinalization(service, editable, claim.sessionId, mode).then(() => { acknowledged = true })
          await settlementStarted.promise
          await Promise.resolve()
          expect(acknowledged).toBe(false)
          expect(await store.readRound(admission.roundId)).toMatchObject({
            status: 'candidate-editing',
            candidatePool: [{ generationAttempts: [{ status: 'running' }] }],
          })
          releaseSettlement.resolve()
          await submission
          const persisted = await store.readRound(admission.roundId)
          expect(persisted?.candidatePool[0]?.generationAttempts?.[0]?.status).toBe('succeeded')
          if (mode === 'decline') {
            expect(persisted?.candidatePool[0]?.decline).toMatchObject({
              rationale: 'No evidence-grounded improvement is safe this round.',
            })
          } else expect(persisted?.candidatePool[0]?.proposal).toMatchObject({ rationale: 'fix observed failures' })

          const gateway = new RefineSkillGateway(service, coordinator, {} as never, {} as never)
          await expect(gateway.call('meta.fail', {
            clientId: 'runner-ack', leaseId: claim.leaseId, leaseToken: claim.leaseToken, reason: 'late failure',
          })).rejects.toThrow(/already received|stale/)
          const expectedStatus = mode === 'decline' ? 'rejected' : 'accepted'
          const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === expectedStatus)
          expect(terminal?.status).toBe(expectedStatus)
          expect(terminal?.candidatePool[0]?.generationAttempts?.[0]?.status).toBe('succeeded')
        } finally {
          releaseSettlement.resolve()
          writeSpy.mockRestore()
        }
      } finally { await service.dispose() }
    },
  )

  it('rejects a Skill acknowledgement when its durable generation settlement cannot be written', async () => {
    const coordinator = new SkillMetaCoordinator()
    const { service, registry } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000, coordinator)
    try {
      const admission = await service.admit('skill')
      const editable = await editing(service, admission.evolutionId, admission.roundId)
      const identity = skillHarnessIdentity(await registry.requireSpec(admission.evolutionId).then(spec => spec.metaAgent))
      const claim = await eventually(
        async () => coordinator.claim('runner-write-failure', identity, admission.evolutionId),
        value => value !== undefined,
      )
      if (claim === undefined) throw new Error('skill assignment was not claimed')
      const store = registry.stateStore(admission.evolutionId)
      const runtimeStore = service.activeEntry(admission.roundId)!.store
      const originalWrite = runtimeStore.writeRound.bind(runtimeStore)
      let failSettlement = true
      const writeSpy = vi.spyOn(runtimeStore, 'writeRound').mockImplementation(async value => {
        if (failSettlement && value.candidatePool.some(candidate => candidate.generationAttempts?.some(attempt => attempt.status === 'succeeded'))) {
          failSettlement = false
          throw new Error('generation settlement storage unavailable')
        }
        return originalWrite(value)
      })
      try {
        await expect(skillFinalization(service, editable, claim.sessionId, 'decline')).rejects.toThrow(/storage unavailable/)
        const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'failed')
        expect(terminal).toMatchObject({
          candidatePool: [{ generationAttempts: [{ status: 'failed' }] }],
        })
      } finally { writeSpy.mockRestore() }
    } finally { await service.dispose() }
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

  it('reuses seed evidence for promotion without submitting held-out evaluations', async () => {
    const { service, evaluator } = await setup()
    service.options.heldOutRef = service.options.seedTaskRef
    service.options.evaluation = { ...service.options.evaluation, mode: 'reuse-seed' }
    evaluator.partialInvalidByPhase.set('seed-baseline', [9])
    evaluator.partialInvalidByPhase.set('seed-candidate', [8])
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => ['accepted', 'failed', 'rejected'].includes(value?.status ?? ''))
    expect(terminal?.status, JSON.stringify(terminal?.failure)).toBe('accepted')
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    expect(terminal?.evaluationAttempts).toHaveLength(2)
    expect(terminal?.evaluation?.heldOutReusedFromSeed).toBe(true)
    expect(terminal?.evaluation?.heldOutBaseline).toEqual(terminal?.evaluation?.seedBaseline)
    expect(terminal?.evaluation?.heldOutCandidate).toEqual(terminal?.evaluation?.seedCandidate)
    expect(terminal?.evaluation?.heldOutPairedTrials).toHaveLength(8)
    expect(terminal?.evaluation?.heldOutPairing).toEqual(terminal?.evaluation?.seedPairing)
    await service.dispose()
  })

  it('runs five reuse-seed rounds with no held-out jobs and rejects forged reuse evidence', async () => {
    const { service, evaluator } = await setup()
    service.options.heldOutRef = service.options.seedTaskRef
    service.options.evaluation = { ...service.options.evaluation, mode: 'reuse-seed' }
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
    })
    const admission = await service.admit('api', { rounds: 5 })
    const store = service.registry.stateStore(admission.evolutionId)
    for (let index = 1; index <= 5; index += 1) {
      const round = await eventually(async () => (await store.listRounds()).find(r => r.roundIndex === index),
        r => r?.status === 'candidate-editing')
      await finalize(service, round!)
      const done = await eventually(() => store.readRound(round!.roundId),
        r => ['accepted', 'rejected', 'failed'].includes(r?.status ?? ''))
      expect(done?.status, JSON.stringify(done?.failure)).toBe('accepted')
      expect(done?.evaluation?.heldOutReusedFromSeed).toBe(true)
      if (index === 5) {
        const forged = structuredClone(done!)
        forged.evaluation!.heldOutCandidate!.primaryReward = 0
        await expect(store.writeRound(forged)).rejects.toThrow('exactly match seed evidence')
      }
    }
    expect(evaluator.calls.filter(phase => phase === 'seed-candidate')).toHaveLength(5)
    expect(evaluator.calls.some(phase => phase.startsWith('held-out'))).toBe(false)
    await service.dispose()
  })

  it('rejects reuse-seed admission for different datasets before evaluating', async () => {
    const { service, evaluator } = await setup()
    service.options.evaluation = { ...service.options.evaluation, mode: 'reuse-seed' }
    await expect(service.admit('api')).rejects.toThrow('reuse-seed requires identical')
    expect(evaluator.calls).toEqual([])
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
      const researchParent = original!.commitIntent!.nextPopulation.members[0]!
      expect(original!.candidatePool.find(candidate => candidate.candidateId === researchParent.candidateId)?.seedEvaluation)
        .toMatchObject({ completeness: 'partial' })
      const identity = evaluator.evaluationIdentity.bind(evaluator)
      let blockResearchParentIdentity = true
      evaluator.evaluationIdentity = (round, request) => {
        if (blockResearchParentIdentity && request.phase === 'seed-baseline'
          && request.harnessRef === researchParent.harnessRef) return undefined as never
        return identity(round, request)
      }
      const legacy = await continueWithLegacyPopulationParent(service, admission.evolutionId, researchParent)
      const identityBlocked = await eventually(() => store.readRound(legacy.roundId), r => r?.status === 'failed')
      blockResearchParentIdentity = false
      await eventually(async () => service.activeEntry(legacy.roundId), value => value === undefined)
      const legacyReason = 'The existing seed evaluation has no verifiable complete baseline; no baseline refresh was started.'
      const blocked: RefinementRound = {
        ...identityBlocked!,
        failure: { ...identityBlocked!.failure!, message: legacyReason },
        baselineReuseBlocker: {
          code: 'BASELINE_EVIDENCE_UNAVAILABLE',
          reason: legacyReason,
          requiredAction: 'Recover complete settled evidence for the original evaluation.',
        },
      }
      await store.writeRound(blocked)
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

  it.each(['automatic', 'appended'] as const)(
    'reuses promoted partial seed and held-out evidence in the %s round',
    async mode => {
      const { service, evaluator } = await setup()
      const rerun = vi.spyOn(evaluator, 'rerun')
      evaluator.partialInvalidByCall.set(2, [8, 9])
      evaluator.partialInvalidByCall.set(4, [8, 9])
      evaluator.partialInvalidByCall.set(5, [0, 9])
      evaluator.partialInvalidByCall.set(6, [0, 9])
      service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
        ...service.options.promotion.policy.config,
        minimumAbsoluteGain: 0,
      })
      try {
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
        const seedEvidence = structuredClone(promoted.seedEvaluation)
        const heldOutEvidence = structuredClone(promoted.heldOutEvaluation)
        expect(seedEvidence).toMatchObject({ completeness: 'partial', plannedTrialCount: 10 })
        expect(heldOutEvidence).toMatchObject({ completeness: 'partial', plannedTrialCount: 10 })

        if (mode === 'appended') {
          await eventually(async () => service.activeEntry(first.roundId), value => value === undefined)
          await service.continueEvolution('api', admission.evolutionId)
        }
        const second = await eventually(
          async () => (await store.listRounds()).find(value => value.roundId !== first.roundId),
          value => value?.status === 'candidate-editing',
        )
        expect(second?.targetHarnessRef).toBe(promoted.sealedVersion.commitOid)
        expect(second?.baseline).toEqual(seedEvidence)
        expect(second?.evaluationAttempts?.find(attempt => attempt.evalId === seedEvidence.evalId)).toMatchObject({
          phase: 'seed-baseline',
          owner: { role: 'baseline', harnessRef: promoted.sealedVersion.commitOid },
          status: 'settled',
          reusedFromRoundId: first.roundId,
        })

        await finalize(service, second!)
        const terminal = await eventually(
          () => store.readRound(second!.roundId),
          value => value?.status === 'accepted',
        )
        expect(terminal?.evaluation?.heldOutBaseline).toEqual(heldOutEvidence)
        expect(terminal?.evaluation?.seedPairing).toEqual({
          planned: 10, paired: 7, excluded: 3, baselineInvalid: 2, candidateInvalid: 2,
        })
        expect(terminal?.evaluation?.heldOutPairing).toEqual({
          planned: 10, paired: 7, excluded: 3, baselineInvalid: 2, candidateInvalid: 2,
        })
        expect(terminal?.evaluationAttempts?.find(attempt => attempt.evalId === heldOutEvidence.evalId)).toMatchObject({
          phase: 'held-out-baseline',
          owner: { role: 'baseline', harnessRef: promoted.sealedVersion.commitOid },
          status: 'settled',
          reusedFromRoundId: first.roundId,
        })
        expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
        expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
        expect(rerun).not.toHaveBeenCalled()
        expect(await store.readRound(first.roundId)).toEqual(first)
      } finally { await service.dispose() }
    },
  )

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

  it('reuses a partial baseline with valid trials without starting a fresh evaluation', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByCall.set(1, [9])
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await decline(service, await editing(service, admission.evolutionId, admission.roundId))
      const first = await eventually(
        () => store.readRound(admission.roundId),
        value => value?.status === 'rejected',
      )
      if (first?.baseline === undefined) throw new Error('first round has no baseline')
      const baseline = structuredClone(first.baseline)
      expect(baseline.completeness).toBe('partial')
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

      const continued = await service.continueEvolution('api', admission.evolutionId)
      const second = await editing(service, admission.evolutionId, continued.roundId)

      expect(second.baseline).toEqual(baseline)
      expect(second.evaluationAttempts?.find(attempt => attempt.evalId === baseline.evalId)).toMatchObject({
        status: 'settled',
        reusedFromRoundId: first.roundId,
      })
      expect(evaluator.calls).toEqual(['seed-baseline'])
      expect(await store.readRound(first.roundId)).toEqual(first)
    } finally { await service.dispose() }
  })

  it('blocks a partial baseline with no valid trials without starting a fresh evaluation', async () => {
    const { service, evaluator } = await setup()
    evaluator.partialInvalidByCall.set(1, Array.from({ length: 10 }, (_, index) => index))
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await decline(service, await editing(service, admission.evolutionId, admission.roundId))
      const first = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'rejected')
      expect(first?.baseline).toMatchObject({ completeness: 'partial', trials: [], plannedTrialCount: 10 })
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

      const continued = await service.continueEvolution('api', admission.evolutionId)
      const second = await eventually(() => store.readRound(continued.roundId), value => value?.status === 'failed')

      expect(second?.baselineReuseBlocker).toMatchObject({
        code: 'BASELINE_EVIDENCE_UNAVAILABLE',
        reason: expect.stringContaining('valid trial'),
      })
      expect(second?.evaluationAttempts ?? []).toEqual([])
      expect(evaluator.calls).toEqual(['seed-baseline'])
      expect(await store.readRound(first!.roundId)).toEqual(first)
    } finally { await service.dispose() }
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

  it('recovers the second selected round and completes the remaining original batch after restart', async () => {
    const { service, evaluator, metas } = await setup()
    evaluator.partialInvalidByCall.set(4, [8, 9])
    service.options.promotion.policy = builtinComponentRef('promotion-policy', 'paired-gate', {
      ...service.options.promotion.policy.config, minimumAbsoluteGain: 0,
    })
    const rerun = vi.spyOn(evaluator, 'rerun')
    let resumed = service
    try {
      const first = await service.admit('api', { rounds: 3, focus: ['context'] })
      const store = service.registry.stateStore(first.evolutionId)
      await finalize(service, await editing(service, first.evolutionId, first.roundId))
      const original = await eventually(() => store.readRound(first.roundId), r => r?.status === 'accepted')
      const promoted = original!.candidatePool.find(candidate => candidate.candidateId === original!.promotedCandidateId)!
      const heldOutEvidence = structuredClone(promoted.heldOutEvaluation!)
      expect(heldOutEvidence.completeness).toBe('partial')
      const secondRounds = await eventually(
        () => store.listRounds(),
        rounds => rounds.some(round => round.batchId === first.batchId
          && round.roundIndex === 2 && round.status === 'candidate-editing'),
      )
      const second = secondRounds.find(round => round.batchId === first.batchId && round.roundIndex === 2)!

      const identity = evaluator.evaluationIdentity.bind(evaluator)
      let blockHeldOutIdentity = true
      evaluator.evaluationIdentity = (round, request) => {
        if (blockHeldOutIdentity && request.phase === 'held-out-baseline') return undefined as never
        return identity(round, request)
      }
      await finalize(service, second)
      const identityBlocked = await eventually(() => store.readRound(second.roundId), r => r?.status === 'failed')
      blockHeldOutIdentity = false
      const legacyReason = 'The existing held-out evaluation has no verifiable complete baseline; no baseline refresh was started.'
      const legacyBlocked: RefinementRound = {
        ...identityBlocked!,
        failure: { ...identityBlocked!.failure!, message: legacyReason },
        baselineReuseBlocker: {
          code: 'BASELINE_EVIDENCE_UNAVAILABLE',
          reason: legacyReason,
          requiredAction: 'Recover complete settled evidence for the original evaluation.',
        },
      }
      await store.writeRound(legacyBlocked)
      const selectedBefore = structuredClone(legacyBlocked.candidatePool.find(candidate =>
        candidate.candidateId === legacyBlocked.promotionCandidateId)!)
      const selectionBefore = structuredClone(legacyBlocked.selection)
      const assessmentBefore = structuredClone(legacyBlocked.selectionAssessment)
      const seedEvaluationBefore = structuredClone(legacyBlocked.evaluation)
      const attemptsBefore = structuredClone(legacyBlocked.evaluationAttempts ?? [])
      const startsBefore = structuredClone(legacyBlocked.evaluationStarts ?? [])
      await eventually(async () => service.activeEntry(second.roundId), r => r === undefined)
      await service.dispose()

      resumed = restart(service, evaluator)
      await resumed.initialize()
      const spec = await resumed.registry.requireSpec(first.evolutionId)
      const assessor = resumed.components.assessor(spec.selection.assessor)
      const selector = resumed.components.selector(spec.selection.strategy)
      const assess = vi.spyOn(assessor, 'assess')
      const select = vi.spyOn(selector, 'select')
      vi.spyOn(resumed.components, 'assessor').mockReturnValue(assessor)
      vi.spyOn(resumed.components, 'selector').mockReturnValue(selector)
      const callsBefore = [...evaluator.calls]
      const nextAdmission = await resumed.continueEvolution('api', first.evolutionId, {
        roundId: second.roundId,
      })
      expect(nextAdmission).toEqual({
        evolutionId: first.evolutionId,
        batchId: first.batchId,
        roundId: second.roundId,
        status: 'queued',
      })
      const terminal = await eventually(() => store.readRound(second.roundId), r => r?.status === 'accepted')
      const thirdRounds = await eventually(
        () => store.listRounds(),
        rounds => rounds.some(round => round.batchId === first.batchId
          && round.roundIndex === 3 && round.status === 'candidate-editing'),
      )
      const third = thirdRounds.find(round => round.batchId === first.batchId && round.roundIndex === 3)!
      const selectedAfter = terminal!.candidatePool.find(candidate => candidate.candidateId === selectedBefore.candidateId)!
      expect(terminal?.evaluation?.heldOutBaseline).toEqual(heldOutEvidence)
      expect(terminal?.selection).toEqual(selectionBefore)
      expect(terminal?.selectionAssessment).toEqual(assessmentBefore)
      expect(terminal?.evaluation).toMatchObject({
        seedBaseline: seedEvaluationBefore!.seedBaseline,
        seedCandidate: seedEvaluationBefore!.seedCandidate,
        seedPairedTrials: seedEvaluationBefore!.seedPairedTrials,
        seedPairing: seedEvaluationBefore!.seedPairing,
        scoreDelta: seedEvaluationBefore!.scoreDelta,
      })
      expect(selectedAfter).toMatchObject({
        candidateId: selectedBefore.candidateId,
        sealedVersion: selectedBefore.sealedVersion,
        seedEvaluation: selectedBefore.seedEvaluation,
        seedComparison: selectedBefore.seedComparison,
        metaSessionId: selectedBefore.metaSessionId,
        resultCheckpoint: selectedBefore.resultCheckpoint,
      })
      expect(terminal?.evaluationAttempts).toEqual(expect.arrayContaining(attemptsBefore))
      expect(terminal?.evaluationStarts?.slice(0, startsBefore.length)).toEqual(startsBefore)
      expect(evaluator.calls.slice(callsBefore.length)).toEqual(['held-out-candidate'])
      expect(evaluator.calls.filter(phase => phase === 'seed-baseline')).toHaveLength(1)
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
      expect(assess).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(rerun).not.toHaveBeenCalled()
      expect(third).toMatchObject({
        batchId: first.batchId, roundIndex: 3, roundCount: 3, advisoryFocus: ['context'],
      })

      await finalize(resumed, third)
      await eventually(() => store.readRound(third.roundId), round => round?.status === 'accepted')
      await eventually(async () => resumed.activeEntry(third.roundId), value => value === undefined)
      const completedBatch = (await store.listRounds()).filter(round => round.batchId === first.batchId)
      expect(completedBatch.map(round => round.roundIndex).sort((left, right) => left - right)).toEqual([1, 2, 3])
      expect(completedBatch.every(round => round.roundCount === 3
        && round.advisoryFocus?.[0] === 'context')).toBe(true)
      expect(evaluator.calls.slice(callsBefore.length)).toEqual([
        'held-out-candidate', 'seed-candidate', 'held-out-candidate',
      ])
      expect(metas.get(first.evolutionId)!.wakes.length).toBeGreaterThan(0)
      expect(new Set(metas.get(first.evolutionId)!.wakes)).toEqual(new Set([third.roundId]))
      expect(assess).toHaveBeenCalledTimes(1)
      expect(select).toHaveBeenCalledTimes(1)
      expect(await store.readRound(first.roundId)).toEqual(original)
    } finally { await resumed.dispose(); await service.dispose() }
  })

  it('recovers with a staged held-out source without starting a new baseline', async () => {
    const { service, evaluator, registry } = await setup()
    enableBaselineSources(service, evaluator)
    const writeRound = RefineStateStore.prototype.writeRound
    let persistence: ReturnType<typeof vi.spyOn> | undefined
    try {
      const source = await service.admit('api')
      await finalize(service, await editing(service, source.evolutionId, source.roundId))
      const sourceRound = await eventually(
        () => registry.stateStore(source.evolutionId).readRound(source.roundId),
        round => round?.status === 'accepted',
      )
      await eventually(async () => service.activeEntry(source.roundId), value => value === undefined)
      const sourceHeldOut = structuredClone(sourceRound!.evaluation!.heldOutBaseline!)
      const destination = await service.admit('api', {
        baselineSource: {
          evolutionId: source.evolutionId,
          roundId: source.roundId,
          partitions: ['seed', 'held-out'],
        },
      })
      const editable = await editing(service, destination.evolutionId, destination.roundId)
      let interrupt = true
      persistence = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (
        this: RefineStateStore,
        value: RefinementRound,
      ) {
        if (interrupt && value.roundId === destination.roundId && value.status === 'held-out-running'
          && value.evaluation?.heldOutBaseline === undefined) {
          interrupt = false
          throw new Error('simulated interruption before staged held-out baseline persistence')
        }
        return writeRound.call(this, value)
      })
      await finalize(service, editable)
      const store = registry.stateStore(destination.evolutionId)
      const blocked = await eventually(() => store.readRound(destination.roundId), round => round?.status === 'failed')
      await eventually(async () => service.activeEntry(destination.roundId), value => value === undefined)
      persistence.mockRestore()
      expect(blocked?.baselineSource?.partitions.heldOut?.evidence).toEqual(sourceHeldOut)
      expect(blocked?.evaluation?.heldOutBaseline).toBeUndefined()
      const callsBeforeRecovery = evaluator.calls.length

      await service.continueEvolution('api', destination.evolutionId, { roundId: destination.roundId })
      const terminal = await eventually(() => store.readRound(destination.roundId), round => round?.status === 'accepted')

      expect(terminal?.evaluation?.heldOutBaseline).toEqual(sourceHeldOut)
      expect(terminal?.evaluationAttempts).toContainEqual(expect.objectContaining({
        evalId: sourceHeldOut.evalId,
        reusedFromEvolutionId: source.evolutionId,
        reusedFromRoundId: source.roundId,
      }))
      expect(evaluator.calls.slice(callsBeforeRecovery)).toEqual(['held-out-candidate'])
      expect(evaluator.calls.filter(phase => phase === 'held-out-baseline')).toHaveLength(1)
    } finally {
      persistence?.mockRestore()
      await service.dispose()
    }
  })

  it('reuses held-out evidence already owned by the selected round', async () => {
    const { service, evaluator } = await setup()
    const writeRound = RefineStateStore.prototype.writeRound
    let stopBeforePromotion = true
    const persistence = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (
      this: RefineStateStore,
      value: RefinementRound,
    ) {
      if (stopBeforePromotion && value.status === 'promoting') {
        stopBeforePromotion = false
        throw new Error('simulated interruption before promotion')
      }
      return writeRound.call(this, value)
    })
    try {
      const admission = await service.admit('api')
      const store = service.registry.stateStore(admission.evolutionId)
      await finalize(service, await editing(service, admission.evolutionId, admission.roundId))
      const failed = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'failed')
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
      persistence.mockRestore()
      const heldOutBaseline = structuredClone(failed!.evaluation!.heldOutBaseline)
      const heldOutCandidate = structuredClone(failed!.evaluation!.heldOutCandidate)
      const attempts = structuredClone(failed!.evaluationAttempts)
      const starts = structuredClone(failed!.evaluationStarts)
      const callsBefore = [...evaluator.calls]

      await service.continueEvolution('api', admission.evolutionId, { roundId: admission.roundId })
      const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'accepted')
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)

      expect(terminal?.evaluation?.heldOutBaseline).toEqual(heldOutBaseline)
      expect(terminal?.evaluation?.heldOutCandidate).toEqual(heldOutCandidate)
      expect(terminal?.evaluationAttempts).toEqual(attempts)
      expect(terminal?.evaluationStarts).toEqual(starts)
      expect(evaluator.calls).toEqual(callsBefore)
      expect(await store.listRounds()).toHaveLength(1)
    } finally {
      persistence.mockRestore()
      await service.dispose()
    }
  })

  it('does not continue the original batch when selected-round recovery fails', async () => {
    const { service, evaluator } = await setup()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const planned = { ...prepared.reopened, roundCount: 2 }
      await prepared.store.writeRound(planned)
      evaluator.failurePhase = 'held-out-candidate'
      const callsBefore = evaluator.calls.length

      await service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      })
      const failed = await eventually(
        () => prepared.store.readRound(prepared.admission.roundId),
        round => round?.status === 'failed' && round.evaluationAttempts?.some(attempt =>
          attempt.phase === 'held-out-candidate' && attempt.status === 'failed') === true,
      )
      await eventually(async () => service.activeEntry(prepared.admission.roundId), value => value === undefined)

      expect(failed?.roundCount).toBe(2)
      expect(evaluator.calls.slice(callsBefore)).toEqual(['held-out-candidate'])
      expect(await prepared.store.listRounds()).toHaveLength(1)
    } finally { await service.dispose() }
  })

  it.each([
    ['identity', /evaluator identity/],
    ['dataset', /dataset content changed/],
    ['champion', /admitted population or champion/],
    ['population', /admitted population or champion/],
    ['no-baseline', /no reusable held-out baseline/],
    ['zero-valid-baseline', /no eligible settled held-out baseline evidence/],
    ['baseline-start', /cannot replace it with historical evidence/],
    ['candidate-start', /cannot safely submit it again/],
    ['candidate-failed', /control\.rerun/],
  ] as const)('rejects unsafe selected-round recovery without mutation: %s', async (mode, expected) => {
    const { service, evaluator } = await setup()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      let expectedRound = structuredClone(prepared.reopened)
      if (mode === 'identity') evaluator.runtimeConfigDigest = `sha256:${'e'.repeat(64)}`
      if (mode === 'dataset') {
        const dataset = join(service.options.workspaceRoot, 'held-out')
        await mkdir(dataset, { recursive: true })
        await writeFile(join(dataset, 'changed.txt'), 'changed after admission')
      }
      if (mode === 'champion') {
        await prepared.store.writeChampion({
          schemaVersion: 2,
          ref: prepared.finalist.sealedVersion!.commitOid,
          manifestDigest: prepared.finalist.sealedVersion!.manifestDigest,
          updatedAt: 'changed',
        })
      }
      if (mode === 'population') {
        const identity = {
          evolutionId: prepared.initialPopulation.evolutionId,
          generation: prepared.initialPopulation.generation + 1,
          members: prepared.initialPopulation.members,
        }
        await prepared.store.writePopulation({ ...identity, digest: digestJson(identity) })
      }
      if (mode === 'no-baseline' || mode === 'baseline-start') {
        const changed = structuredClone(prepared.reopened)
        delete changed.evaluation!.heldOutBaseline
        if (mode === 'no-baseline') {
          changed.evaluationStarts = (changed.evaluationStarts ?? []).filter(start => start.phase !== 'held-out-baseline')
        }
        changed.evaluationAttempts = (changed.evaluationAttempts ?? []).filter(attempt => attempt.phase !== 'held-out-baseline')
        await prepared.store.writeRound(changed)
        expectedRound = changed
      }
      if (mode === 'zero-valid-baseline') {
        const changed = structuredClone(prepared.reopened)
        const baseline = changed.evaluation!.heldOutBaseline!
        changed.evaluation!.heldOutBaseline = {
          ...baseline,
          completeness: 'partial', primaryReward: 0,
          summary: { total: 0, passed: 0, failed: 0, score: 0 },
          trials: [],
          invalidTrials: baseline.trials.map(trial => ({
            taskName: trial.taskName, trialName: trial.trialName!, runId: trial.runId!, attempt: trial.attempt!,
            status: 'errored', invalidReason: 'simulated_failure',
          })),
        }
        await prepared.store.writeRound(changed)
        expectedRound = changed
      }
      if (mode === 'candidate-start' || mode === 'candidate-failed') {
        const changed = structuredClone(prepared.reopened)
        const harnessRef = prepared.finalist.sealedVersion!.commitOid
        changed.evaluationStarts = [...(changed.evaluationStarts ?? []), {
          phase: 'held-out-candidate', harnessRef,
          conditionId: changed.plan.heldOut.conditionId, startedAt: 'simulated',
        }]
        if (mode === 'candidate-failed') {
          changed.evaluationAttempts = [...(changed.evaluationAttempts ?? []), {
            provider: 'fake', evalId: 'eval_failed_recovery', phase: 'held-out-candidate',
            owner: { candidateId: prepared.finalist.candidateId, role: 'candidate', harnessRef },
            conditionId: changed.plan.heldOut.conditionId, dataset: changed.heldOutRef,
            requestedModelId: changed.plan.heldOut.model, requestedCommit: harnessRef,
            status: 'failed', startedAt: 'simulated', completedAt: 'simulated',
            failure: { code: 'simulated_failure', message: 'simulated failed evaluation' },
          }]
        }
        await prepared.store.writeRound(changed)
        expectedRound = changed
      }
      const callsBefore = [...evaluator.calls]

      await expect(service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      })).rejects.toThrow(expected)

      expect(await prepared.store.readRound(prepared.admission.roundId)).toEqual(expectedRound)
      expect(evaluator.calls).toEqual(callsBefore)
      expect(service.activeEntry(prepared.admission.roundId)).toBeUndefined()
    } finally { await service.dispose() }
  })

  it('ignores a failed seed evaluation owned only by an unselected sibling', async () => {
    const { service, evaluator } = await setup()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const changed = structuredClone(prepared.reopened)
      const sibling = structuredClone(prepared.finalist)
      sibling.candidateId = `${sibling.candidateId}-failed-sibling`
      sibling.status = 'failed'
      sibling.failure = { phase: 'candidate-seed-running', message: 'irrelevant sibling failure' }
      delete sibling.seedEvaluation
      delete sibling.seedComparison
      delete sibling.heldOutEvaluation
      delete sibling.metrics
      changed.candidatePool.push(sibling)
      changed.parentAllocations!.push({
        candidateId: sibling.candidateId,
        parentCandidateId: changed.championParent!.candidateId,
        parentHarnessRef: changed.championParent!.harnessRef,
        parentHarnessDigest: changed.championParent!.harnessDigest,
      })
      changed.evaluationStarts = [...(changed.evaluationStarts ?? []), {
        phase: 'seed-candidate', harnessRef: sibling.sealedVersion!.commitOid,
        conditionId: changed.plan.seed.conditionId, startedAt: 'simulated',
      }]
      changed.evaluationAttempts = [...(changed.evaluationAttempts ?? []), {
        provider: 'fake', evalId: 'eval_failed_unselected_seed', phase: 'seed-candidate',
        owner: { candidateId: sibling.candidateId, role: 'candidate', harnessRef: sibling.sealedVersion!.commitOid },
        conditionId: changed.plan.seed.conditionId, dataset: changed.seedTaskRef,
        requestedModelId: changed.plan.seed.model, requestedCommit: sibling.sealedVersion!.commitOid,
        status: 'failed', startedAt: 'simulated', completedAt: 'simulated',
        failure: { code: 'simulated_failure', message: 'irrelevant sibling failure' },
      }]
      await prepared.store.writeRound(changed)
      const callsBefore = evaluator.calls.length

      await service.continueEvolution('api', prepared.admission.evolutionId, { roundId: prepared.admission.roundId })
      await eventually(() => prepared.store.readRound(prepared.admission.roundId), round => round?.status === 'accepted')

      expect(evaluator.calls.slice(callsBefore)).toEqual(['held-out-candidate'])
    } finally { await service.dispose() }
  })

  it('serializes repeated recovery without duplicating the selected held-out evaluation', async () => {
    const { service, evaluator } = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const evaluate = evaluator.evaluate.bind(evaluator)
      evaluator.evaluate = async (...args) => {
        if (args[1].phase === 'held-out-candidate') {
          entered.resolve()
          await release.promise
        }
        return evaluate(...args)
      }
      const callsBefore = evaluator.calls.length
      await service.continueEvolution('api', prepared.admission.evolutionId, { roundId: prepared.admission.roundId })
      await entered.promise

      await expect(service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      })).rejects.toThrow(/already active/)
      release.resolve()
      await eventually(() => prepared.store.readRound(prepared.admission.roundId), round => round?.status === 'accepted')
      await eventually(async () => service.activeEntry(prepared.admission.roundId), value => value === undefined)
      await expect(service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      })).rejects.toThrow(/not a failed selected round/)

      expect(evaluator.calls.slice(callsBefore)).toEqual(['held-out-candidate'])
      expect(await prepared.store.listRounds()).toHaveLength(1)
    } finally {
      release.resolve()
      await service.dispose()
    }
  })

  it('can recover again after a crash before the first selected held-out evaluation', async () => {
    const { service, evaluator } = await setup()
    let resumed = service
    let startDrive: ReturnType<typeof vi.spyOn> | undefined
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      startDrive = vi.spyOn(
        service as unknown as { startDrive(roundId: string): void },
        'startDrive',
      ).mockImplementation(() => {})
      const callsBefore = evaluator.calls.length
      await service.continueEvolution('api', prepared.admission.evolutionId, { roundId: prepared.admission.roundId })
      await Promise.resolve()
      expect(await prepared.store.readRound(prepared.admission.roundId)).toMatchObject({ status: 'held-out-running' })
      expect(evaluator.calls).toHaveLength(callsBefore)
      await service.dispose()
      startDrive.mockRestore()

      resumed = restart(service, evaluator)
      await resumed.initialize()
      expect(await prepared.store.readRound(prepared.admission.roundId)).toMatchObject({
        status: 'failed', failure: { phase: 'recovery' },
      })
      await resumed.continueEvolution('api', prepared.admission.evolutionId, { roundId: prepared.admission.roundId })
      await eventually(() => prepared.store.readRound(prepared.admission.roundId), round => round?.status === 'accepted')

      expect(evaluator.calls.slice(callsBefore)).toEqual(['held-out-candidate'])
    } finally {
      startDrive?.mockRestore()
      await resumed.dispose()
      await service.dispose()
    }
  })

  it('releases recovery admission when dispose wins a pending identity query', async () => {
    const { service, evaluator } = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const original = structuredClone(prepared.reopened)
      const callsBefore = evaluator.calls.length
      const identity = evaluator.evaluationIdentity.bind(evaluator)
      evaluator.evaluationIdentity = (async (
        round: Readonly<RefinementRound>,
        request: Readonly<EvaluationRequest>,
      ) => {
        if (request.phase === 'held-out-candidate') {
          entered.resolve()
          await release.promise
        }
        return identity(round, request)
      }) as unknown as FakeEvaluator['evaluationIdentity']
      const continuation = service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      }).then(value => ({ value }), error => ({ error }))
      await entered.promise

      await service.dispose()
      release.resolve()
      const result = await continuation

      expect(result).toMatchObject({ error: expect.objectContaining({ message: 'RefineService is disposed' }) })
      expect(await prepared.store.readRound(prepared.admission.roundId)).toEqual(original)
      expect(evaluator.calls).toHaveLength(callsBefore)
      const lock = await prepared.store.acquireRoundLock(prepared.admission.roundId)
      await lock.release()
    } finally {
      release.resolve()
      await service.dispose()
    }
  })

  it('restores failed state when dispose wins the held-out admission write', async () => {
    const { service, evaluator } = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writeRound = RefineStateStore.prototype.writeRound
    let persistence: ReturnType<typeof vi.spyOn> | undefined
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const original = structuredClone(prepared.reopened)
      const callsBefore = evaluator.calls.length
      let block = true
      persistence = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (
        this: RefineStateStore,
        value: RefinementRound,
      ) {
        if (block && value.roundId === prepared.admission.roundId && value.status === 'held-out-running') {
          block = false
          entered.resolve()
          await release.promise
        }
        return writeRound.call(this, value)
      })
      const continuation = service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      }).then(value => ({ value }), error => ({ error }))
      await entered.promise

      await service.dispose()
      release.resolve()
      const result = await continuation

      expect(result).toMatchObject({ error: expect.objectContaining({ message: 'RefineService is disposed' }) })
      const restored = await prepared.store.readRound(prepared.admission.roundId)
      expect(restored).toEqual({ ...original, updatedAt: restored!.updatedAt })
      expect(evaluator.calls).toHaveLength(callsBefore)
      const lock = await prepared.store.acquireRoundLock(prepared.admission.roundId)
      await lock.release()
    } finally {
      release.resolve()
      persistence?.mockRestore()
      await service.dispose()
    }
  })

  it('releases the round lock when registry touch rejects recovery admission', async () => {
    const { service, evaluator } = await setup()
    try {
      const prepared = await reopenAcceptedRoundBeforeHeldOutCandidate(service)
      const original = structuredClone(prepared.reopened)
      const callsBefore = evaluator.calls.length
      const touch = vi.spyOn(service.registry, 'touch').mockRejectedValueOnce(new Error('simulated registry failure'))

      await expect(service.continueEvolution('api', prepared.admission.evolutionId, {
        roundId: prepared.admission.roundId,
      })).rejects.toThrow(/simulated registry failure/)
      touch.mockRestore()

      expect(await prepared.store.readRound(prepared.admission.roundId)).toEqual(original)
      expect(evaluator.calls).toHaveLength(callsBefore)
      expect(service.activeEntry(prepared.admission.roundId)).toBeUndefined()
      const lock = await prepared.store.acquireRoundLock(prepared.admission.roundId)
      await lock.release()
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
    const unsupported = new RefineService(service.registry, service.builder, service.workspaceManager, (spec, digest, store) => {
      const meta = new FakeMeta(spec.evolutionId, store, digest)
      meta.capabilities.aggregateGenerationBudget = false
      return meta as never
    }, service.evaluator, service.options)
    await expect(unsupported.admit('api')).rejects.toThrow(/aggregate generation budgets/)
    await unsupported.dispose()
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

  it('terminates an ordinary candidate failure when context offloading is configured', async () => {
    const { service, evaluator, metas } = await setup()
    service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
    const baselineGate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => { await baselineGate.promise; return evaluate(...args) }
    const admission = await service.admit('api')
    const meta = metas.get(admission.evolutionId)
    if (meta === undefined) throw new Error('Meta fixture is unavailable')
    meta.wakeCandidate = async () => { throw new Error('ordinary context generation failure') }
    baselineGate.resolve()

    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'failed')
    expect(terminal).toMatchObject({
      status: 'failed',
      candidatePool: [{
        status: 'failed',
        generationAttempts: [{ status: 'failed', failure: { message: 'ordinary context generation failure' } }],
      }],
    })
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    await service.dispose()
  })

  it.each(['duplicate-recovery', 'wrong-round-stage'] as const)(
    'settles disposal instead of preserving an unusable context boundary (%s)',
    async mode => {
      const { service, evaluator, metas, registry } = await setup()
      service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
      const baselineGate = Promise.withResolvers<void>()
      const evaluate = evaluator.evaluate.bind(evaluator)
      evaluator.evaluate = async (...args) => { await baselineGate.promise; return evaluate(...args) }
      const admission = await service.admit('api')
      const store = registry.stateStore(admission.evolutionId)
      const meta = metas.get(admission.evolutionId)! as unknown as MetaSessionController
      const published = Promise.withResolvers<MetaExecutionState>()
      meta.wakeCandidate = async (round, candidate, baseline, agent, binding) => {
        const state: MetaExecutionState = {
          schemaVersion: 1,
          executionId: binding!.executionId,
          evolutionId: round.evolutionId,
          specDigest: digestJson(await registry.requireSpec(round.evolutionId)),
          roundId: round.roundId,
          candidateId: candidate!.candidateId,
          attempt: binding!.attempt,
          generation: 0,
          revision: 0,
          activeSessionId: agent.id,
          sessions: [agent.id],
          status: 'rotating',
          deadlineAt: binding!.deadlineAt,
          usage: { modelRequests: 1, tokens: 1, summaryRequests: 0, summaryTokens: 0 },
          pending: [],
          deliveredIds: [],
          handoffs: [],
          recovery: {
            envelope: contextMessage('Continue the candidate'),
            controller: await binding!.snapshot(),
            evidence: {
              evolutionId: round.evolutionId,
              roundId: round.roundId,
              candidateId: candidate!.candidateId,
              baselineEvalId: baseline!.evalId,
              summaryAccessed: true,
              accessedRefs: [],
              diagnosedRunRefs: [],
              citedRefs: [],
            },
          },
        }
        await new MetaOffloadingStore(store.root).cas(undefined, state)
        published.resolve(state)
        return { sessionId: agent.id }
      }
      baselineGate.resolve()
      const state = await published.promise
      if (mode === 'duplicate-recovery') {
        await new MetaOffloadingStore(store.root).cas(undefined, {
          ...structuredClone(state), executionId: 'duplicate-execution', revision: 0,
        })
      } else {
        const current = (await store.readRound(admission.roundId))!
        await store.writeRound({ ...current, status: 'candidate-seed-running' })
      }

      await service.dispose()
      expect(await store.readRound(admission.roundId)).toMatchObject({
        status: 'failed',
        candidatePool: [{ status: 'failed', generationAttempts: [{ status: 'failed' }] }],
      })
    },
  )

  it('terminates a downstream failure after a context-enabled generation retry', async () => {
    const { service, evaluator, metas } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000)
    service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
    const baselineGate = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => { await baselineGate.promise; return evaluate(...args) }
    const admission = await service.admit('api')
    const meta = metas.get(admission.evolutionId)
    if (meta === undefined) throw new Error('Meta fixture is unavailable')
    meta.turnCompletions.push({ reason: 'max-tokens', turn: 1, durationMs: 1 })
    baselineGate.resolve()
    const store = service.registry.stateStore(admission.evolutionId)
    const retried = await eventually(
      () => store.readRound(admission.roundId) as Promise<RefinementRound>,
      round => round?.status === 'candidate-editing' && round.candidatePool[0]?.generationAttempts?.length === 2,
    )
    const runtimeStore = service.activeEntry(admission.roundId)!.store
    const originalWrite = runtimeStore.writeRound.bind(runtimeStore)
    let failDownstream = true
    const writeSpy = vi.spyOn(runtimeStore, 'writeRound').mockImplementation(async value => {
      if (failDownstream && value.status === 'candidate-seed-running') {
        failDownstream = false
        throw new Error('downstream transition unavailable')
      }
      return originalWrite(value)
    })
    try {
      await finalize(service, retried)
      const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'failed')
      expect(terminal).toMatchObject({
        status: 'failed',
        failure: { message: 'downstream transition unavailable' },
        candidatePool: [{ generationAttempts: [{ status: 'failed' }, { status: 'succeeded' }] }],
      })
    } finally {
      writeSpy.mockRestore()
      await service.dispose()
    }
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
    const attemptBudgetMs = 30_000
    const { service, evaluator, metas } = await setup(0.8, false, 1, attemptBudgetMs, 1, 0, 1, 90_000)
    const baselineGate = Promise.withResolvers<void>(), forkStarted = Promise.withResolvers<void>()
    const evaluate = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async (...args) => { await baselineGate.promise; return evaluate(...args) }
    const originalSetTimeout = globalThis.setTimeout
    let expireAttempt: (() => void) | undefined
    // Exercise the attempt deadline only after fork has started. Real Git/IO work
    // must not decide whether a tiny round or attempt timer wins this test.
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args)
      if (args[1] === attemptBudgetMs && expireAttempt === undefined) expireAttempt = () => { clearTimeout(timer); args[0]() }
      return timer
    })
    try {
      const admission = await service.admit('api')
      const meta = metas.get(admission.evolutionId)
      if (meta === undefined) throw new Error('Meta fixture is unavailable')
      meta.fork = async () => { forkStarted.resolve(); return new Promise<never>(() => {}) }
      baselineGate.resolve()
      await forkStarted.promise
      if (!expireAttempt) throw new Error('attempt deadline was not scheduled')
      expireAttempt()
      const store = service.registry.stateStore(admission.evolutionId)
      const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'failed')
      expect(terminal?.candidatePool[0]?.generationAttempts).toMatchObject([
        { attempt: 1, status: 'failed', failure: { message: expect.stringMatching(/30000ms attempt budget/) } },
      ])
      await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    } finally {
      baselineGate.resolve()
      timerSpy.mockRestore()
      await service.dispose()
    }
  })

  it('keeps a failed sibling prerequisite isolated from another candidate retry', async () => {
    const attemptBudgetMs = 30_000
    const { service } = await setup(0.8, false, 2, attemptBudgetMs, 1, 0, 2, 120_000)
    const originalSetTimeout = globalThis.setTimeout
    const expireAttempts: Array<() => void> = []
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args)
      if (args[1] === attemptBudgetMs) expireAttempts.push(() => { clearTimeout(timer); args[0]() })
      return timer
    })
    try {
      const admission = await service.admit('api')
      const first = await editing(service, admission.evolutionId, admission.roundId)
      const firstCandidate = first.candidatePool.find(candidate => candidate.metaSessionId !== undefined)
      if (firstCandidate?.metaSessionId === undefined) throw new Error('first sibling is unavailable')
      const blockedRunId = first.baseline!.trials.find(trial => (trial.rewards.reward ?? 0) <= 0)!.runId!
      await service.recordMetaPrerequisiteBlocker(firstCandidate.metaSessionId, {
        schemaVersion: 1,
        code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
        failedOperation: 'trajectory.query',
        blockedRuns: [{
          runId: blockedRunId,
          code: 'hitch_verifier_diagnostic_source_incomplete',
          cause: 'legacy_truncated',
          resolution: 'repair-evidence',
        }],
      })
      const expireFirstAttempt = expireAttempts.shift()
      if (expireFirstAttempt === undefined) throw new Error('first candidate deadline was not scheduled')
      expireFirstAttempt()
      const store = service.registry.stateStore(admission.evolutionId)
      const second = await eventually(
        () => store.readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && value.candidatePool.some(candidate => candidate.candidateId !== firstCandidate.candidateId
            && candidate.metaSessionId !== undefined
            && service.activeEntry(value.roundId)?.workspace?.workspaceId === candidate.workspaceId),
      )
      const secondCandidate = second.candidatePool.find(candidate => candidate.candidateId !== firstCandidate.candidateId
        && candidate.metaSessionId !== undefined)!
      const expireSecondAttempt = expireAttempts.shift()
      if (expireSecondAttempt === undefined) throw new Error('second candidate deadline was not scheduled')
      expireSecondAttempt()
      const retried = await eventually(
        () => store.readRound(admission.roundId) as Promise<RefinementRound>,
        value => value?.status === 'candidate-editing'
          && value.candidatePool.some(candidate => candidate.candidateId === secondCandidate.candidateId
            && candidate.metaSessionId !== secondCandidate.metaSessionId
            && candidate.generationAttempts?.length === 2
            && service.activeEntry(value.roundId)?.workspace?.workspaceId === candidate.workspaceId),
      )
      await finalize(service, retried)
      const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
      expect(terminal?.candidatePool.find(candidate => candidate.candidateId === firstCandidate.candidateId)).toMatchObject({
        status: 'failed',
        failure: { prerequisite: { blockedRuns: [{ runId: blockedRunId, cause: 'legacy_truncated' }] } },
      })
      const settledSecond = terminal?.candidatePool.find(candidate => candidate.candidateId === secondCandidate.candidateId)
      expect(settledSecond?.generationAttempts).toHaveLength(2)
      expect(settledSecond?.generationAttempts?.[0]).toMatchObject({ status: 'failed' })
      expect(settledSecond?.generationAttempts?.[0]?.failure?.prerequisite).toBeUndefined()
      expect(settledSecond?.generationAttempts?.[1]).toMatchObject({ status: 'succeeded' })
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

  it('atomically settles a running candidate generation attempt during disposal', async () => {
    const { service, evaluator, registry } = await setup()
    const admission = await service.admit('api')
    await editing(service, admission.evolutionId, admission.roundId)
    const store = registry.stateStore(admission.evolutionId)
    await service.dispose()
    const settled = await store.readRound(admission.roundId)
    expect(settled).toMatchObject({
      status: 'failed',
      failure: { phase: 'candidate-editing', message: 'RefineService disposed' },
      candidatePool: [{
        status: 'failed',
        generationAttempts: [{
          status: 'failed', completedAt: expect.any(String),
          failure: { phase: 'candidate-generation', message: 'RefineService disposed' },
        }],
      }],
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
    expect(await store.readRound(admission.roundId)).toEqual(settled)
    await recovering.dispose()
  })

  it('reports a disposal settlement write failure after releasing the round lock', async () => {
    const { service, registry } = await setup()
    const admission = await service.admit('api')
    await editing(service, admission.evolutionId, admission.roundId)
    const store = registry.stateStore(admission.evolutionId)
    const runtimeStore = service.activeEntry(admission.roundId)!.store
    const originalWrite = runtimeStore.writeRound.bind(runtimeStore)
    let rejectFailureSettlement = true
    const writeSpy = vi.spyOn(runtimeStore, 'writeRound').mockImplementation(async value => {
      if (rejectFailureSettlement && value.status === 'failed') {
        rejectFailureSettlement = false
        throw new Error('round settlement storage unavailable')
      }
      return originalWrite(value)
    })
    await expect(service.dispose()).rejects.toThrow(/failed to settle refinement rounds during dispose/)
    writeSpy.mockRestore()
    expect(await store.readRound(admission.roundId)).toMatchObject({
      status: 'candidate-editing',
      candidatePool: [{ generationAttempts: [{ status: 'running' }] }],
    })
    const lock = await store.acquireRoundLock()
    await lock.release()
  })

  it('starts a new Meta evolution from explicit source evidence without another Target baseline', async () => {
    const { service, evaluator, registry } = await setup()
    enableBaselineSources(service, evaluator)
    const sourceAdmission = await service.admit('api')
    const sourceEditing = await editing(service, sourceAdmission.evolutionId, sourceAdmission.roundId)
    await decline(service, sourceEditing)
    const sourceRound = await eventually(
      () => registry.stateStore(sourceAdmission.evolutionId).readRound(sourceAdmission.roundId),
      round => round?.status === 'rejected',
    )
    const sourceEvidence = structuredClone(sourceRound!.baseline!)
    const callsBefore = evaluator.calls.length
    service.options.metaAgent = {
      ...structuredClone(service.options.metaAgent),
      preset: { id: 'meta-v2', digest: `sha256:${'9'.repeat(64)}`, resources: [] },
      model: { provider: 'different-meta', model: 'different-meta-model' },
      sampling: { temperature: 0.7 },
    }
    const createMetaSession = service.createMetaSession
    await service.dispose()
    let sourceRuntimeRequested = false
    const current = new RefineService(
      registry, service.builder, service.workspaceManager,
      (spec, digest, store) => {
        if (spec.evolutionId === sourceAdmission.evolutionId) {
          sourceRuntimeRequested = true
          throw new Error('source Meta runtime must not be loaded for baseline import')
        }
        return createMetaSession(spec, digest, store)
      },
      evaluator, service.options, service.components,
    )
    await current.initialize()

    const admission = await current.admit('api', {
      baselineSource: { evolutionId: sourceAdmission.evolutionId, roundId: sourceAdmission.roundId },
    })
    const imported = await editing(current, admission.evolutionId, admission.roundId)
    const spec = await registry.requireSpec(admission.evolutionId)

    expect(evaluator.calls).toHaveLength(callsBefore)
    expect(sourceRuntimeRequested).toBe(false)
    expect(imported.baseline).toEqual(sourceEvidence)
    expect(imported.baselineSource?.partitions.heldOut).toBeUndefined()
    expect(imported.evaluationAttempts).toContainEqual(expect.objectContaining({
      provider: sourceEvidence.provider,
      evalId: sourceEvidence.evalId,
      status: 'settled',
      reusedFromEvolutionId: sourceAdmission.evolutionId,
      reusedFromRoundId: sourceAdmission.roundId,
    }))
    expect(spec.metaAgent.model.model).toBe('different-meta-model')
    expect(spec.baselineConditionSource).toMatchObject({
      partitions: ['seed'],
      source: { evolutionId: sourceAdmission.evolutionId, roundId: sourceAdmission.roundId },
      inheritedRolloutProviderDigest: sourceRound!.plan.seed.rolloutProviderDigest,
    })
    await current.dispose()
  })

  it('keeps an opt-in held-out source sealed until held-out evaluation and reuses it after a failed first round', async () => {
    const { service, evaluator, registry } = await setup()
    enableBaselineSources(service, evaluator)
    const sourceAdmission = await service.admit('api')
    const sourceEditing = await editing(service, sourceAdmission.evolutionId, sourceAdmission.roundId)
    await finalize(service, sourceEditing)
    const sourceRound = await eventually(
      () => registry.stateStore(sourceAdmission.evolutionId).readRound(sourceAdmission.roundId),
      round => round?.status === 'accepted',
    )
    const sourceHeldOut = structuredClone(sourceRound!.evaluation!.heldOutBaseline!)
    const callsBefore = evaluator.calls.length
    service.options.metaAgent = {
      ...structuredClone(service.options.metaAgent),
      preset: { id: 'meta-held-out-v2', digest: `sha256:${'8'.repeat(64)}`, resources: [] },
    }

    const firstAdmission = await service.admit('api', {
      baselineSource: {
        evolutionId: sourceAdmission.evolutionId,
        roundId: sourceAdmission.roundId,
        partitions: ['seed', 'held-out'],
      },
    })
    const first = await editing(service, firstAdmission.evolutionId, firstAdmission.roundId)
    expect(evaluator.calls).toHaveLength(callsBefore)
    expect(first.baselineSource?.partitions.heldOut?.evidence).toEqual(sourceHeldOut)
    expect(first.evaluation).toBeUndefined()
    expect(JSON.stringify(first.experienceSnapshot ?? {})).not.toContain(sourceHeldOut.evalId)
    const firstCandidate = first.candidatePool[0]!
    await service.failMetaExecution(
      first.evolutionId,
      first.roundId,
      firstCandidate.candidateId,
      firstCandidate.metaSessionId!,
      'simulated failure',
    )
    await eventually(
      () => registry.stateStore(firstAdmission.evolutionId).readRound(firstAdmission.roundId),
      round => round?.status === 'failed',
    )

    const continued = await service.continueEvolution('api', firstAdmission.evolutionId)
    const second = await editing(service, continued.evolutionId, continued.roundId)
    expect(evaluator.calls).toHaveLength(callsBefore)
    await finalize(service, second)
    const terminal = await eventually(
      () => registry.stateStore(continued.evolutionId).readRound(continued.roundId),
      round => round?.status === 'accepted',
    )
    expect(evaluator.calls.slice(callsBefore)).toEqual(['seed-candidate', 'held-out-candidate'])
    expect(terminal!.evaluation!.heldOutBaseline).toEqual(sourceHeldOut)
    expect(terminal!.evaluationAttempts).toContainEqual(expect.objectContaining({
      evalId: sourceHeldOut.evalId,
      reusedFromEvolutionId: sourceAdmission.evolutionId,
      reusedFromRoundId: sourceAdmission.roundId,
    }))
    const directAdmission = await service.admit('api', {
      baselineSource: {
        evolutionId: sourceAdmission.evolutionId,
        roundId: sourceAdmission.roundId,
        partitions: ['seed', 'held-out'],
      },
    })
    const directEditing = await editing(service, directAdmission.evolutionId, directAdmission.roundId)
    await finalize(service, directEditing)
    const direct = await eventually(
      () => registry.stateStore(directAdmission.evolutionId).readRound(directAdmission.roundId),
      round => round?.status === 'accepted',
    )
    const tampered = structuredClone(direct!)
    const importedHeldOutAttempt = tampered.evaluationAttempts!.find(attempt => attempt.evalId === sourceHeldOut.evalId)!
    importedHeldOutAttempt.reusedFromRoundId = 'unrelated-round'
    await expect(registry.stateStore(directAdmission.evolutionId).writeRound(tampered))
      .rejects.toThrow('round held-out baseline differs from its source snapshot')
    await service.dispose()
  })

  it('reconstructs a sealed baseline source after a crash before the first round write', async () => {
    const { service, evaluator, registry } = await setup()
    enableBaselineSources(service, evaluator)
    const sourceAdmission = await service.admit('api')
    const sourceEditing = await editing(service, sourceAdmission.evolutionId, sourceAdmission.roundId)
    await decline(service, sourceEditing)
    await eventually(
      () => registry.stateStore(sourceAdmission.evolutionId).readRound(sourceAdmission.roundId),
      round => round?.status === 'rejected',
    )

    const writeRound = RefineStateStore.prototype.writeRound
    let interrupted = true
    const write = vi.spyOn(RefineStateStore.prototype, 'writeRound').mockImplementation(async function (
      this: RefineStateStore,
      round: RefinementRound,
    ) {
      if (interrupted && round.status === 'queued' && round.baselineSource !== undefined) {
        interrupted = false
        throw new Error('simulated crash before first round became durable')
      }
      return writeRound.call(this, round)
    })
    await expect(service.admit('api', {
      baselineSource: { evolutionId: sourceAdmission.evolutionId, roundId: sourceAdmission.roundId },
    })).rejects.toThrow('simulated crash')
    write.mockRestore()
    const destination = (await registry.list()).find(entry => entry.evolutionId !== sourceAdmission.evolutionId)!
    expect(await registry.stateStore(destination.evolutionId).listRounds()).toEqual([])
    const callsBefore = evaluator.calls.length
    const createMetaSession = service.createMetaSession
    await service.dispose()
    const recovering = new RefineService(
      registry, service.builder, service.workspaceManager, createMetaSession,
      evaluator, service.options, service.components,
    )
    await recovering.initialize()

    const continued = await recovering.continueEvolution('api', destination.evolutionId)
    const recovered = await editing(recovering, continued.evolutionId, continued.roundId)
    expect(evaluator.calls).toHaveLength(callsBefore)
    expect(recovered.baselineSource?.source).toMatchObject({
      evolutionId: sourceAdmission.evolutionId,
      roundId: sourceAdmission.roundId,
    })
    expect(recovered.baseline?.evalId).toBe(recovered.baselineSource?.partitions.seed.evidence.evalId)
    await recovering.dispose()
  })

  it('rejects an explicit source Target mismatch before creating an evolution or running Target', async () => {
    const { service, evaluator, registry } = await setup()
    enableBaselineSources(service, evaluator)
    const sourceAdmission = await service.admit('api')
    const sourceEditing = await editing(service, sourceAdmission.evolutionId, sourceAdmission.roundId)
    await decline(service, sourceEditing)
    await eventually(
      () => registry.stateStore(sourceAdmission.evolutionId).readRound(sourceAdmission.roundId),
      round => round?.status === 'rejected',
    )
    const beforeEntries = await registry.list()
    const callsBefore = evaluator.calls.length
    const changedConfig = {
      ...(service.options.rollout.provider.config as Record<string, unknown>),
      model: 'different-target-model',
    }
    const provider = componentRef(
      'rollout-provider', 'hitch-cli', hitchCliImplementation(), changedConfig,
    )
    const agentConfig = structuredClone(service.options.rollout.agentConfig)
    service.options.rollout = {
      ...service.options.rollout,
      provider,
      providerSemanticDigest: rolloutProviderSemanticDigest(provider, { harnessId: 'test' }, agentConfig),
      model: 'different-target-model',
    }

    await expect(service.admit('api', {
      baselineSource: { evolutionId: sourceAdmission.evolutionId, roundId: sourceAdmission.roundId },
    })).rejects.toThrow(/Target parameters differ/u)
    expect(await registry.list()).toEqual(beforeEntries)
    expect(evaluator.calls).toHaveLength(callsBefore)
    await service.dispose()
  })
})

describe('explicit staged search control-plane integration', () => {
  it.each(['skill', 'unmetered', 'unknown'] as const)('rejects search-only token/request budgets before admission with %s Meta', async kind => {
    const { service, evaluator } = await setup(), fixture = searchFixtures(20)
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = searchSettings()
    // A policy flag alone must not let a Skill adapter claim enforcement.
    service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
    const unsupported = new RefineService(service.registry, service.builder, service.workspaceManager, (spec, digest, store) => {
      if (kind === 'skill') return new SkillMetaSessionManager(store, new SkillMetaCoordinator(), { evolutionId: spec.evolutionId, specDigest: digest, metaAgent: spec.metaAgent })
      const meta = new FakeMeta(spec.evolutionId, store, digest)
      meta.capabilities.aggregateGenerationBudget = false
      if (kind === 'unknown') Reflect.deleteProperty(meta, 'capabilities')
      return meta as never
    }, evaluator, service.options)
    try {
      await expect(unsupported.admit('api')).rejects.toThrow('cannot enforce aggregate generation budgets')
      expect(await service.listEvolutions()).toEqual([])
      expect(fixture.executions).toEqual([])
      expect(service.options.candidateGeneration.budget.maxTokens).toBeUndefined()
      expect(service.options.candidateGeneration.budget.maxModelRequests).toBeUndefined()
    } finally { await unsupported.dispose(); await service.dispose() }
  })

  it.each(['restart', 'explicit-resume', 'expired', 'unrecoverable', 'cancel-unknown', 'restore-failed', 'restore-cancel-unknown'] as const)('recovers an interrupted search generation without orphaning its original attempt (%s)', async mode => {
    const { service, evaluator, git, metas } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000)
    const fixture = searchFixtures(20), gate = Promise.withResolvers<void>(), evaluate = fixture.provider.evaluate
    fixture.provider.evaluate = async input => { await gate.promise; return evaluate({ ...input, snapshot: { ...input.snapshot, candidateId: input.snapshot.commit === git.championRef ? 'anchor' : input.snapshot.candidateId } }) }
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = searchSettings()
    service.options.metaAgent.contextOffloading = resolveOffloadingPolicy({ mode: 'proactive', contextWindow: 10000 })
    let recovered: RefineService | undefined, clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const admitted = await service.admit('api'), store = service.registry.stateStore(admitted.evolutionId)
      const meta = metas.get(admitted.evolutionId)! as unknown as MetaSessionController
      let saved: MetaExecutionState | undefined
      meta.wakeCandidate = async (round, candidate, baseline, agent, binding) => {
        const workspace = service.workspaceManager.resolve(agent.id)
        await mkdir(join(workspace.targetPath, 'prompts'), { recursive: true })
        await writeFile(join(workspace.targetPath, 'prompts', 'interrupted.md'), 'original uncommitted proposal')
        saved = {
          schemaVersion: 1, executionId: binding!.executionId, evolutionId: round.evolutionId,
          specDigest: digestJson(await service.registry.requireSpec(round.evolutionId)), roundId: round.roundId,
          candidateId: candidate!.candidateId, attempt: binding!.attempt, generation: 0, revision: 0,
          activeSessionId: agent.id, sessions: [agent.id], status: 'rotating', deadlineAt: binding!.deadlineAt,
          usage: { modelRequests: 1, tokens: 100, summaryRequests: 0, summaryTokens: 0 }, pending: [], deliveredIds: [], handoffs: [],
          ...(mode === 'unrecoverable' || mode === 'cancel-unknown' ? {} : { recovery: {
            envelope: contextMessage('Continue the original proposal'), controller: await binding!.snapshot(),
            evidence: { evolutionId: round.evolutionId, roundId: round.roundId, baselineEvalId: baseline!.evalId,
              summaryAccessed: true, accessedRefs: [], diagnosedRunRefs: [], citedRefs: [] },
          } }),
        }
        await new MetaOffloadingStore(store.root).cas(undefined, saved)
        return { sessionId: agent.id }
      }
      gate.resolve()
      await eventually(async () => saved && await new MetaOffloadingStore(store.root).read(saved.executionId), value => value !== undefined)
      const original = (await store.readRound(admitted.roundId))!, originalCandidate = original.candidatePool[0]!
      await service.dispose()
      if (mode === 'expired') {
        const originalNow = Date.now, offset = originalCandidate.workplanDelivery!.workplan.generationBudget.deadlineAt - originalNow() + 1
        clock = vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + offset)
      }
      let restored: string | undefined, restoredSnapshot: unknown, forks = 0
      const cancellations: string[] = []
      const workspaces = new CandidateWorkspaceManager(service.workspaceManager.options)
      recovered = new RefineService(service.registry, service.builder, workspaces, (spec, digest, state) => {
        const cold = new FakeMeta(spec.evolutionId, state, digest) as unknown as MetaSessionController
        cold.restore = async (id, executionId) => {
          expect(id).toBe(saved!.activeSessionId)
          if (mode.startsWith('restore-')) throw new Error('original session could not be restored')
          restored = executionId; return { id }
        }
        cold.fork = async () => { forks++; throw new Error('recovery must not fork a new attempt') }
        cold.cancel = async id => { if (mode.endsWith('cancel-unknown')) throw new Error('cancellation could not be confirmed'); cancellations.push(id) }
        cold.wakeCandidate = async (_round, _candidate, _baseline, agent, binding) => {
          restoredSnapshot = await binding!.snapshot()
          expect(await readFile(join(workspaces.resolve(agent.id).targetPath, 'prompts', 'interrupted.md'), 'utf8')).toBe('original uncommitted proposal')
          return { sessionId: agent.id, completion: Promise.resolve({ reason: 'max-tokens' }) }
        }
        return cold
      }, evaluator, service.options)
      if (mode === 'explicit-resume') await recovered.resumeSearchRound(admitted.evolutionId, admitted.roundId)
      else await recovered.initialize()
      const journal = new SearchStore(join(store.root, 'search'))
      if (mode.endsWith('cancel-unknown')) {
        await eventually(async () => recovered!.activeEntry(admitted.roundId), active => !active)
        expect((await store.readRound(admitted.roundId))!.failure?.message).toMatch(/cancellation could not be confirmed|operation pending/)
        expect(await journal.read(`rounds/${admitted.roundId}/terminal`)).toBeUndefined()
        expect((await store.readRound(admitted.roundId))!.candidatePool[0]!.generationAttempts![0]!.status).toBe('running')
        return
      }
      const terminal = (await eventually(() => store.readRound(admitted.roundId), round => round?.status === 'rejected'))!
      expect(await journal.read(`rounds/${admitted.roundId}/terminal`)).toBeDefined()
      expect(terminal.candidatePool[0]!.generationAttempts).toHaveLength(1)
      expect(terminal.candidatePool[0]!.generationAttempts![0]).toMatchObject({ attempt: 1, status: 'failed' })
      expect(terminal.candidatePool[0]!.workplanDelivery).toEqual(originalCandidate.workplanDelivery)
      expect(forks).toBe(0)
      if (mode === 'restart' || mode === 'explicit-resume') {
        expect(restored).toBe(saved!.executionId)
        expect(restoredSnapshot).toEqual(saved!.recovery!.controller)
      } else {
        expect(restored).toBeUndefined()
        expect(cancellations).toContain(saved!.activeSessionId)
        expect(await new MetaOffloadingStore(store.root).read(saved!.executionId)).toMatchObject({ status: 'stopped' })
      }
      const count = fixture.executions.length
      await eventually(async () => recovered!.activeEntry(admitted.roundId), active => !active)
      await expect(recovered.resumeSearchRound(admitted.evolutionId, admitted.roundId)).resolves.toMatchObject({ resumed: false })
      expect(fixture.executions).toHaveLength(count)
    } finally { clock?.mockRestore(); gate.resolve(); await recovered?.dispose(); await service.dispose() }
  })

  it.each([false, true])('runs the Gear staging adapter through real Skill workspaces without model usage claims (custom parent policy=%s)', async customPolicy => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator, git } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000, coordinator)
    const seed = await standardSearchDataset(git.root, 20, 'seed', false)
    const heldOut = await standardSearchDataset(git.root, 5, 'held-out', false)
    const requests: EvaluationRequest[] = [], runs = new Map<string, string>()
    evaluator.evaluationIdentity = (_round, request) => ({ provider: 'fake', effectiveConfigDigest: digestJson(request.condition), invocationFingerprint: digestJson(request.condition) })
    ;(evaluator as RefineEvaluator).evaluate = async (_round, request, _signal, reservation) => {
      requests.push(request)
      const manifest = JSON.parse(await readFile(join(request.dataset, 'benchmark.adapter.json'), 'utf8'))
      const trials = manifest.tasks.map((task: { task_id: string }) => {
        const runId = `${reservation!.evalId}-${task.task_id}`; runs.set(runId, task.task_id)
        const score = request.harnessRef === git.championRef ? Number(task.task_id.slice(5)) % 5 === 0 ? 1 : 0.3 : 1
        return { taskName: task.task_id, runId, trialName: runId, attempt: 1, status: 'completed' as const,
          rewards: { reward: score }, scores: { totalScore: score, normalization: 'standard' as const } }
      })
      const score = trials.reduce((sum: number, trial: typeof trials[number]) => sum + trial.scores.totalScore, 0) / trials.length
      return { provider: reservation!.provider, evalId: reservation!.evalId, conditionId: request.condition.conditionId,
        effectiveConfigDigest: digestJson(request.condition), invocationFingerprint: digestJson(request.condition), dataset: request.dataset, requestedCommit: request.harnessRef,
        actualCommit: request.harnessRef, revisionIdentity: request.harnessRef, completeness: 'complete', plannedTrialCount: trials.length,
        primaryReward: score, summary: { total: trials.length, passed: trials.length, failed: 0, score }, trials, invalidTrials: [] }
    }
    ;(evaluator as RefineEvaluator & Partial<HitchTrajectoryReader>).inspectVerifierEvidence = async runId => ({
      runId, observation: { status: 'valid' }, verifier: { status: 'complete', feedback: { schemaVersion: 1,
        items: [{ code: `workflow-${Number(runs.get(runId)!.slice(5)) % 4}`, severity: 'error', message: 'Fixture workflow failure' }] } },
    } as Awaited<ReturnType<NonNullable<HitchTrajectoryReader['inspectVerifierEvidence']>>>)
    service.options.searchSettings = skillSearchSettings()
    let policyCalls = 0
    if (customPolicy) {
      const implementation = { package: 'test-control-plane-policy', version: '1', integrity: digestJson('control-plane-policy') }
      const ref = componentRef('parent-selection', 'control-plane-parent', implementation, { batchCount: 1 })
      service.components.registerParentSelectionPolicy(ref.id, implementation, component => {
        const base = scopedFrontierPolicy(component)
        return { ...base, select(input, random) { policyCalls++; return base.select(input, random) } }
      })
      service.options.searchSettings.search.parentPolicy = ref
      service.options.selection.strategy = componentRef('candidate-selector', 'unused-in-staged-search', implementation, {})
    }
    try {
      const admitted = await service.admit('api'), store = service.registry.stateStore(admitted.evolutionId)
      const round = await eventually(() => store.readRound(admitted.roundId), r => ['candidate-editing', 'failed', 'rejected'].includes(r?.status ?? ''))
      expect(round?.status, round?.failure?.message).toBe('candidate-editing')
      const assignment = (await eventually(async () => coordinator.claim('default-search-client', skillHarnessIdentity(service.options.metaAgent), admitted.evolutionId), a => a !== undefined))!
      const workspace = service.workspaceManager.resolve(assignment.sessionId)
      await writeFile(join(workspace.targetPath, 'plugins', 'context.ts'), 'export const context = "improved workflow"\n')
      const active = service.activeEntry(admitted.roundId)!, refs = [assignment.baseline.evalId]
      const attribution = await active.meta.proposalAttribution(admitted.roundId, assignment.sessionId, {})
      const evidence = active.meta.proposalEvidenceAudit(admitted.roundId, assignment.sessionId, refs)
      await service.submitFinalization(admitted.evolutionId, admitted.roundId, { rationale: 'Repair the assigned workflow', expectedOutcome: 'Complete the task', evidenceRefs: refs }, undefined, attribution, evidence)
      const terminal = await eventually(() => store.readRound(admitted.roundId), r => ['accepted', 'rejected', 'failed'].includes(r?.status ?? ''))
      expect(terminal?.status, JSON.stringify({ failure: terminal?.failure, search: terminal?.searchOutcome })).toBe('accepted')
      expect(terminal?.searchOutcome?.championChanged).toBe(true)
      expect(terminal!.candidatePool.filter(candidate => candidate.sealedVersion).map(candidate => candidate.status)).toEqual(['ready'])
      expect(terminal?.searchOutcome?.research.remainingBudget).toMatchObject({ generationTokens: null, generationRequests: null })
      const journal = new SearchStore(join(store.root, 'search'))
      for (const workplan of terminal!.searchOutcome!.research.workplans) {
        expect(workplan.generationBudget.maxTokens).toBeUndefined()
        expect(workplan.generationBudget.maxModelRequests).toBeUndefined()
        const generated = await journal.read<{ ref: string }>(`rounds/${admitted.roundId}/generated-${workplan.candidateId}`)
        expect((await journal.object<{ digest: string; usage: object }>(generated!.ref)).usage).toEqual({})
      }
      expect(policyCalls).toBe(customPolicy ? 1 : 0)
      if (customPolicy) expect(terminal?.searchOutcome?.research.parents.policy?.ref.id).toBe('control-plane-parent')
      expect((evaluator as RefineEvaluator).search).toBeUndefined()
      expect(requests.every(r => r.dataset.startsWith(join(store.root, 'search', 'datasets')))).toBe(true)
      expect(await digestDatasetRef(seed.ref)).toBe(seed.digest)
      expect(await digestDatasetRef(heldOut.ref)).toBe(heldOut.digest)
    } finally { await service.dispose() }
  })

  it('settles an externally failed Skill search attempt before acknowledging meta.fail', async () => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator, git } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000, coordinator)
    const fixture = searchFixtures(20), evaluate = fixture.provider.evaluate
    fixture.provider.evaluate = input => evaluate({ ...input, snapshot: {
      ...input.snapshot, candidateId: input.snapshot.commit === git.championRef ? 'anchor' : input.snapshot.candidateId,
    } })
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = skillSearchSettings()
    try {
      const admission = await service.admit('skill')
      await editing(service, admission.evolutionId, admission.roundId)
      const claim = (await eventually(
        async () => coordinator.claim('failed-search-runner', skillHarnessIdentity(service.options.metaAgent), admission.evolutionId),
        value => value !== undefined,
      ))!
      const gateway = new RefineSkillGateway(service, coordinator, {} as never, {} as never)
      await expect(gateway.call('meta.fail', {
        clientId: 'failed-search-runner', leaseId: claim.leaseId, leaseToken: claim.leaseToken,
        reason: 'search runner exited',
      })).resolves.toMatchObject({ failed: true, roundId: admission.roundId })
      const round = await service.registry.stateStore(admission.evolutionId).readRound(admission.roundId)
      expect(round).toMatchObject({ status: 'failed', candidatePool: [{
        candidateId: claim.candidateId, status: 'failed', generationAttempts: [{ status: 'failed' }],
      }] })
      expect(round!.candidatePool[0]!.generationAttempts).toHaveLength(1)
    } finally { await service.dispose() }
  })

  it('[D05] preserves the original candidate, workplan and remaining attempts after a crash between generation retries', async () => {
    const { service, evaluator, git, metas } = await setup(0.8, false, 1, 300_000, 1, 0, 2, 600_000)
    const fixture = searchFixtures(20), gate = Promise.withResolvers<void>(), evaluate = fixture.provider.evaluate
    fixture.provider.evaluate = async input => { await gate.promise; return evaluate({ ...input, snapshot: { ...input.snapshot, candidateId: input.snapshot.commit === git.championRef ? 'anchor' : input.snapshot.candidateId } }) }
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = searchSettings()
    let restarted: RefineService | undefined
    try {
      const admitted = await service.admit('api'), active = service.activeEntry(admitted.roundId)!, store = active.store
      const firstMeta = metas.get(admitted.evolutionId)!
      firstMeta.turnCompletions.push({ reason: 'max-tokens', turn: 1, durationMs: 1, effectiveMaxTokens: 50 })
      const write = store.writeRound.bind(store)
      let crashed = false
      store.writeRound = async round => {
        await write(round)
        if (!crashed && round.candidatePool[0]?.status === 'generating' && round.candidatePool[0]?.generationAttempts?.[0]?.status === 'failed') {
          crashed = true; throw new Error('injected crash between generation attempts')
        }
      }
      gate.resolve()
      const stopped = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'failed')
      expect(crashed).toBe(true)
      expect(stopped!.candidatePool[0]!.generationAttempts).toHaveLength(1)
      await eventually(async () => service.activeEntry(admitted.roundId), a => !a)
      const journal = new SearchStore(join(store.root, 'search'))
      const remaining = await journal.remaining(admitted.roundId, service.options.searchSettings.budgets)
      const counts = fixture.executions.length
      await service.dispose()
      restarted = new RefineService(service.registry, service.builder, service.workspaceManager, (spec, digest, state) => {
        const meta = new FakeMeta(spec.evolutionId, state, digest)
        meta.turnCompletions.push({ reason: 'max-tokens', turn: 1, durationMs: 1, effectiveMaxTokens: 50 })
        return meta as never
      }, evaluator, service.options)
      await restarted.initialize()
      const finished = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'rejected')
      expect(finished!.candidatePool).toHaveLength(1)
      const before = stopped!.candidatePool[0]!, after = finished!.candidatePool[0]!
      expect(after.candidateId).toBe(before.candidateId)
      expect(after.parentHarnessRef).toBe(before.parentHarnessRef)
      expect(after.workplanDelivery).toEqual(before.workplanDelivery)
      expect(after.generationAttempts?.map(a => [a.attempt, a.status])).toEqual([[1, 'failed'], [2, 'failed']])
      expect(after.generationAttempts![0]).toEqual(before.generationAttempts![0])
      expect(finished!.candidateGenerationDeadlineAt).toBe(stopped!.candidateGenerationDeadlineAt)
      expect(await journal.remaining(admitted.roundId, service.options.searchSettings.budgets)).toEqual(remaining)
      expect(fixture.executions).toHaveLength(counts)
      expect(await store.readChampion()).toMatchObject({ ref: git.championRef })
    } finally { gate.resolve(); await restarted?.dispose(); await service.dispose() }
  })
  it('[R05] inherits actual specialist code and findings after a Skill restart with an empty checkpoint', async () => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator, git } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000, coordinator)
    const f = searchFixtures(20), evaluate = f.provider.evaluate
    const versions = new Map<string, { tasks: Set<string>; score: number }>()
    f.provider.evaluate = async input => {
      if (input.plan.stage === 'local' && input.snapshot.commit !== git.championRef && !versions.has(input.snapshot.commit)) {
        versions.set(input.snapshot.commit, { tasks: new Set(input.plan.taskIds), score: versions.size ? 0.95 : 0.9 })
      }
      return (await evaluate(input)).map(cell => {
        const specialist = versions.get(input.snapshot.commit)
        const score = input.snapshot.commit === git.championRef ? 0.85 : specialist?.tasks.has(cell.identity.taskId) ? specialist.score : 0.1
        return revise(cell, { outcome: { status: 'available', rawValue: score, contractDigest: cell.identity.outcomeContractDigest, evidenceRef: cell.evidenceRef } })
      })
    }
    const diagnose = f.diagnosis.diagnose
    f.diagnosis.diagnose = async input => {
      const result = await diagnose(input)
      return { ...result, facts: result.facts.map(fact => ({ ...fact, modificationPaths: ['prompts'] })) }
    }
    ;(evaluator as RefineEvaluator).search = { provider: f.provider, diagnosis: f.diagnosis }
    service.options.searchSettings = skillSearchSettings()
    let restarted: RefineService | undefined
    try {
      const admitted = await service.admit('api'), store = service.registry.stateStore(admitted.evolutionId)
      const finish = async (runner: RefineService, roundId: string, filename: string,
        inherited?: { commit: string; snapshotDigest: string; findings: unknown[] }) => {
        const round = await eventually(() => store.readRound(roundId), r => r?.status === 'candidate-editing' || r?.status === 'failed' || r?.status === 'rejected')
        expect(round?.status, round?.failure?.message).toBe('candidate-editing')
        const assignment = (await eventually(async () => coordinator.claim('history-client', skillHarnessIdentity(runner.options.metaAgent), admitted.evolutionId), a => a !== undefined))!
        const workspace = runner.workspaceManager.resolve(assignment.sessionId)
        if (inherited) {
          expect(assignment.parentHarnessRef).toBe(inherited.commit)
          expect(assignment.workplanDelivery?.dossier.parentSnapshotDigest).toBe(inherited.snapshotDigest)
          expect(assignment.workplanDelivery?.findings).toEqual(inherited.findings)
          expect(assignment.workplanDelivery?.findings).not.toEqual([])
          expect(assignment.baseline.primaryReward).toBeCloseTo(0.9)
          expect(await readFile(join(workspace.targetPath, 'prompts', 'first-specialist.md'), 'utf8')).toContain('First specialist retained for local improvements')
        }
        await mkdir(join(workspace.targetPath, 'prompts'), { recursive: true })
        await writeFile(join(workspace.targetPath, 'prompts', filename), inherited ? 'Second specialist consumes the inherited findings.\n' : 'First specialist retained for local improvements.\n')
        const active = runner.activeEntry(roundId)!, refs = [assignment.baseline.evalId]
        const attribution = await active.meta.proposalAttribution(roundId, assignment.sessionId, {})
        const evidence = active.meta.proposalEvidenceAudit(roundId, assignment.sessionId, refs)
        await runner.submitFinalization(admitted.evolutionId, roundId, { rationale: 'Improve the assigned local tasks', expectedOutcome: 'Higher local completion', evidenceRefs: refs }, undefined, attribution, evidence)
        const terminal = (await eventually(() => store.readRound(roundId), r => r?.status === 'rejected' || r?.status === 'failed'))!
        expect(terminal.status, terminal.failure?.message).toBe('rejected')
        expect(terminal.searchOutcome?.championChanged).toBe(false)
        await eventually(async () => runner.activeEntry(roundId), active => !active)
        return terminal
      }
      const first = await finish(service, admitted.roundId, 'first-specialist.md')
      const candidate = first.candidatePool[0]!
      expect(candidate.resultCheckpoint?.eventCount).toBe(0)
      expect(first.searchOutcome?.research.parentProbabilities).toEqual({ [candidate.candidateId]: 1 })
      const archive = (await new SearchStore(join(store.root, 'search')).archive())!
      const parent = archive.snapshots.find(s => s.candidateId === candidate.candidateId)!
      await service.dispose()
      restarted = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
      await restarted.initialize()
      const continued = await restarted.continueEvolution('api', admitted.evolutionId)
      const second = await finish(restarted, continued.roundId, 'second-specialist.md', {
        commit: candidate.sealedVersion!.commitOid, snapshotDigest: parent.digest, findings: first.searchOutcome!.findings,
      })
      expect(second.candidatePool[0]!.parentCandidateIds).toEqual([candidate.candidateId])
      expect(second.candidatePool[0]!.resultCheckpoint?.eventCount).toBe(0)
      expect(await store.readChampion()).toMatchObject({ ref: git.championRef })
      expect(versions.size).toBe(2)
      expect(f.executions.some(e => e.stage === 'held-out')).toBe(false)
    } finally { await restarted?.dispose(); await service.dispose() }
  })

  it('freezes suite protection at new admission without changing runtime options or the source dataset', async () => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000, coordinator)
    const fixture = searchFixtures(20), suite = await regressionSuiteFixture(fixture.seed, 'protected-regression')
    const originalSeed = JSON.stringify(fixture.seed)
    const seed = revise(fixture.seed, { regressionSuite: suite, regressionSuiteDigest: suite.digest })
    fixture.provider.describe = async p => p === 'seed' ? seed : fixture.heldOut
    const verify = vi.fn(async () => true); fixture.provider.verifyRegressionSuite = verify
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = skillSearchSettings(); service.options.searchSettings.regression.suiteRef = suite.digest
    try {
      const admitted = await service.admit('api')
      const spec = await service.registry.readSpec(admitted.evolutionId)
      expect(spec?.searchSettings?.promotion.protectedTasks).toEqual([suite.tasks[0]!.guard])
      expect(spec?.searchSettings?.regression.suiteRef).toBe(suite.digest)
      expect(verify).toHaveBeenCalledWith(suite.digest, seed)
      expect(service.options.searchSettings.promotion.protectedTasks).toEqual([])
      expect(JSON.stringify(fixture.seed)).toBe(originalSeed)
    } finally { await service.dispose() }
  })
  const cases: Array<{ process: boolean; recovery: string; variableRepetitions?: boolean; sharedSetPromotion?: boolean }> = [{ process: false, recovery: 'none' }, { process: true, recovery: 'none' }, { process: true, recovery: 'resume' }, { process: true, recovery: 'restart' }, { process: false, recovery: 'timeout' }, { process: true, recovery: 'none', variableRepetitions: true }, { process: false, recovery: 'champion-commit' }, { process: true, recovery: 'champion-commit', sharedSetPromotion: true }]
  it.each(cases)('delivers a scoped workplan and recovers v2 promotion ($process/$recovery/$variableRepetitions/$sharedSetPromotion)', async ({ process, recovery, variableRepetitions, sharedSetPromotion }) => {
    const coordinator = new SkillMetaCoordinator()
    const { service, evaluator, git } = await setup(0.8, false, 1, 300_000, 1, 0, 1, 300_000, coordinator)
    const fixture = searchFixtures(20, process)
    if (variableRepetitions) {
      const seed = revise(fixture.seed, { repetitions: [{ index: 0, seed: 0 }, { index: 1, seed: 1 }],
        tasks: fixture.seed.tasks.map((task, i) => ({ ...task, repetitionIndices: i === 0 ? [0] : [0, 1] })) })
      fixture.provider.describe = async partition => partition === 'seed' ? seed : fixture.heldOut
    }
    const evaluate = fixture.provider.evaluate.bind(fixture.provider)
    let ready = recovery === 'none' || recovery === 'champion-commit', championWrites = 0
    let restarted: RefineService | undefined
    fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'remote-heldout-17' })
    fixture.provider.evaluate = async input => {
      let cells = await evaluate({ ...input, snapshot: { ...input.snapshot, candidateId: input.snapshot.commit === git.championRef ? 'anchor' : input.snapshot.candidateId } })
      if (variableRepetitions && input.snapshot.commit === git.championRef) cells = cells.map(cell => revise(cell, {
        process: { status: 'available', rawValue: Number(cell.identity.taskId.slice(5)) / 20, contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef },
      }))
      if (!ready && input.plan.stage === 'held-out' && input.snapshot.commit !== git.championRef) throw new Error('lost held-out transport')
      return cells
    }
    const diagnose = fixture.diagnosis.diagnose.bind(fixture.diagnosis)
    fixture.diagnosis.diagnose = async input => { const output = await diagnose(input); return { ...output, facts: output.facts.map(f => ({ ...f, modificationPaths: ['prompts'] })) } }
    ;(evaluator as RefineEvaluator).search = { provider: fixture.provider, diagnosis: fixture.diagnosis }
    service.options.searchSettings = skillSearchSettings()
    if (sharedSetPromotion) {
      service.options.searchSettings.promotion.validationMode = 'shared-set-research'
      service.options.searchSettings.promotion.allowSharedSetPromotion = true
    }
    if (recovery === 'timeout') service.options.searchSettings.budgets.round.timeoutMs = 2500
    try {
      const admitted = await service.admit('api')
      const store = service.registry.stateStore(admitted.evolutionId)
      const current = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'candidate-editing' || r?.status === 'failed' || r?.status === 'rejected')
      expect(current?.status, current?.failure?.message).toBe('candidate-editing')
      const assignment = (await eventually(async () => coordinator.claim('test-client', skillHarnessIdentity(service.options.metaAgent), admitted.evolutionId), a => a !== undefined))!
      expect(assignment.workplanDelivery?.workplan.hypothesis).toBeTruthy()
      expect(assignment.evidencePolicy.diagnoseEveryFailedRunBeforeProposal).toBe(false)
      if (variableRepetitions) {
        expect(assignment.baseline.plannedTrialCount).toBeGreaterThan(assignment.baseline.summary.total)
        expect(assignment.baseline.scoringContext).toMatchObject({ summaryUnit: 'task', aggregateWeighting: 'frozen-scope-task-weights' })
      }
      const workingStatus = await service.status(admitted.evolutionId, admitted.roundId)
      expect(workingStatus.searchProgress?.phase).toBe('generation')
      expect(workingStatus.searchProgress?.evaluations.some(e => e.stage === 'baseline-probe' && e.profile?.outcomeComplete)).toBe(true)
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
      if (recovery === 'champion-commit') {
        const cas = active.store.compareAndSwapChampion.bind(active.store)
        active.store.compareAndSwapChampion = async (...args) => {
          await cas(...args); championWrites++
          if (championWrites === 1) throw new Error('injected crash after champion CAS')
        }
      }
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
        expect(failed?.failure?.message).toContain(recovery === 'champion-commit' ? 'injected crash after champion CAS' : 'operation pending')
        await eventually(async () => service.activeEntry(admitted.roundId), active => !active)
        const status = await service.status(admitted.evolutionId, admitted.roundId)
        if (recovery === 'champion-commit') {
          expect(status.searchPendingOperation).toBeUndefined()
          expect(await store.readChampion()).toMatchObject({ ref: failed!.candidatePool[0]!.sealedVersion!.commitOid })
        } else expect(status.searchPendingOperation).toMatchObject({ state: 'running', partition: 'held-out', handle: 'remote-heldout-17' })
        expect(status.searchProgress?.phase).toBe('seed-research-complete')
        expect(status.searchProgress?.evaluations.some(e => (e.stage as string) === 'held-out')).toBe(false)
        ready = true
        if (recovery === 'resume' || recovery === 'champion-commit') await service.resumeSearchRound(admitted.evolutionId, admitted.roundId)
        else {
          await service.dispose()
          restarted = new RefineService(service.registry, service.builder, service.workspaceManager, service.createMetaSession, evaluator, service.options)
          await restarted.initialize()
        }
      }
      const terminal = await eventually(() => store.readRound(admitted.roundId), r => r?.status === 'accepted' || r?.status === 'failed' || r?.status === 'rejected')
      expect(terminal?.status, JSON.stringify(terminal?.failure ?? terminal?.searchOutcome)).toBe('accepted')
      expect(terminal?.searchOutcome?.championChanged).toBe(true)
      if (sharedSetPromotion) {
        expect(terminal?.searchOutcome).toMatchObject({ advisory: false, validationMode: 'shared-set-research' })
        expect(await service.registry.readSpec(admitted.evolutionId)).toMatchObject({ searchSettings: { promotion: { allowSharedSetPromotion: true } } })
      }
      expect(evaluator.calls).toEqual([])
      expect(await store.readChampion()).toMatchObject({ ref: terminal!.candidatePool[0]!.sealedVersion!.commitOid })
      if (recovery === 'champion-commit') expect(championWrites).toBe(1)
    } finally { await restarted?.dispose(); await service.dispose() }
  })
})
