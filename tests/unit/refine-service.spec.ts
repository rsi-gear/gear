import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineService } from '../../src/refine/service.js'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import type { EvaluationPhase, EvaluationRequest, EvaluationRerunResult, EvaluationRerunSelector, EvaluationReservation, HitchEvaluationEvidence, MetaAttribution, RefineEvaluator, RefinementRound, RoundEvaluationAttempt } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { builtinComponentRef } from '../../src/evolution/components.js'
import { evolutionSpec } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakeMeta {
  wakes: string[] = []
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
  async fork() {
    const id = `meta-${this.evolutionId}-candidate-${++this.child}`
    const agent = { id }
    this.agents.set(id, agent)
    return agent
  }
  async wakeCandidate(round: Readonly<RefinementRound>, _candidate: unknown, _baseline: unknown, agent: { id: string }) {
    this.wakes.push(round.roundId)
    return agent.id
  }
  async cancel(): Promise<void> {}
  async release(sessionId: string): Promise<void> { this.agents.delete(sessionId) }
  async dispose(): Promise<void> {}
}

class FakeEvaluator implements RefineEvaluator {
  calls: EvaluationPhase[] = []
  private reservations = 0
  constructor(
    private readonly candidateScore = 0.8,
    private readonly heldOutDelta = 0,
    private readonly mismatchSeedCondition = false,
  ) {}
  async reserve(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
  ): Promise<EvaluationReservation> {
    this.reservations += 1
    return { provider: 'fake', evalId: `eval_fake_${this.reservations}` }
  }
  async evaluate(
    _round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    _signal?: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    this.calls.push(request.phase)
    const baseline = request.phase.endsWith('baseline')
    const heldOut = request.phase.startsWith('held-out')
    const score = heldOut ? (baseline ? 0.6 : 0.6 + this.heldOutDelta) : (baseline ? 0.5 : this.candidateScore)
    const passed = Math.round(score * 10)
    const serial = this.calls.length.toString(16).padStart(32, '0')
    return {
      provider: reservation?.provider ?? 'fake',
      conditionId: this.mismatchSeedCondition && request.phase === 'seed-candidate'
        ? `sha256:${'f'.repeat(64)}` : request.condition.conditionId,
      effectiveConfigDigest: request.condition.rolloutProviderDigest,
      evalId: reservation?.evalId ?? `eval_${serial}`, dataset: request.dataset,
      requestedCommit: request.harnessRef, actualCommit: request.harnessRef,
      revisionIdentity: `sha256:${serial.padEnd(64, '0')}`,
      invocationFingerprint: request.condition.rolloutProviderDigest,
      primaryReward: score, summary: { total: 10, passed, failed: 10 - passed, score },
      trials: Array.from({ length: 10 }, (_, index) => ({
        taskName: `task-${index}`, trialName: `${request.phase}-trial-${index}`, attempt: 1,
        runId: `run_${`${serial}${index}`.slice(-32).padStart(32, '0')}`,
        status: 'completed' as const, rewards: { reward: index < passed ? 1 : 0 },
      })),
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${serial.padEnd(64, '0')}`,
        commit: request.harnessRef, tree: 'f'.repeat(40), payloadSha256: `sha256:${'1'.repeat(64)}`, payloadBytes: 1,
      },
    }
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
    return {
      provider: attempt.provider,
      evalId: attempt.evalId,
      selectedTasks: [...tasks],
      repairedTasks: [...tasks],
      remainingInvalidTasks: [],
      evalStatus: 'succeeded',
      evidence,
    }
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000
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
  generationTimeoutMs = 300_000,
  survivors = 1,
  heldOutDelta = 0,
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
    const meta = new FakeMeta(spec.evolutionId, store, digest)
    metas.set(spec.evolutionId, meta)
    return meta as never
  }, evaluator, {
    workspaceRoot: git.root, metaAgent: defaults.metaAgent,
    candidateGeneration: {
      ...defaults.candidateGeneration,
      maxCandidates,
      budget: { ...defaults.candidateGeneration.budget, timeoutMs: generationTimeoutMs },
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
  const runRefs = round.baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId])
  const failed = round.baseline.trials.flatMap(trial => (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : [])
  await service.submitFinalization(round.evolutionId, round.roundId, {
    rationale: 'fix observed failures', expectedOutcome: 'higher reward', evidenceRefs: [round.baseline.evalId], semanticTargets: ['context', 'routing'],
  }, undefined, meta, {
    evolutionId: round.evolutionId, roundId: round.roundId, candidateId: candidate.candidateId, baselineEvalId: round.baseline.evalId,
    summaryAccessed: true, accessedRefs: [round.baseline.evalId, ...runRefs], diagnosedRunRefs: failed, citedRefs: [round.baseline.evalId],
  })
}

describe('RefineService evolution workspaces', () => {
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

  it('reruns a failed Hitch attempt under the same eval id and continues the round', async () => {
    const { service, evaluator } = await setup()
    const evalId = `eval_${'7'.repeat(32)}`
    const originalReserve = evaluator.reserve.bind(evaluator)
    const originalEvaluate = evaluator.evaluate.bind(evaluator)
    let firstReservation = true
    let firstEvaluation = true
    evaluator.reserve = async (...args) => {
      if (firstReservation) {
        firstReservation = false
        return { provider: 'hitch-cli', evalId }
      }
      return originalReserve(...args)
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
    const rerun = await service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' })
    expect(rerun).toMatchObject({ evalId, evalStatus: 'succeeded', remainingInvalidTasks: [] })
    const resumed = await editing(service, admission.evolutionId, admission.roundId)
    expect(resumed.evaluationAttempts?.find(attempt => attempt.evalId === evalId)).toMatchObject({
      provider: 'hitch-cli', status: 'settled', completedAt: expect.any(String),
    })
    expect(resumed.baseline).toMatchObject({ evalId })
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
      repairableEvaluations: [{ provider: 'hitch-cli', evalId, phase: 'seed-candidate' }],
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
    const { service, evaluator, metas } = await setup()
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
      evaluationAttempts: [{ status: 'repair-completed', completedAt: expect.any(String) }],
    })
    const lock = await store.acquireRoundLock(admission.roundId)
    await lock.release()
  })

  it('does not create a candidate execution when dispose starts after repair handoff', async () => {
    const { service, evaluator, metas } = await setup()
    const evalId = `eval_${'f'.repeat(32)}`
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

    const driveReadStarted = Promise.withResolvers<void>()
    const releaseDriveRead = Promise.withResolvers<void>()
    const originalReadRound = store.readRound.bind(store)
    let blockPendingResumeRead = true
    store.readRound = async roundId => {
      const value = await originalReadRound(roundId)
      if (blockPendingResumeRead && value?.status === 'repairing-evaluation'
        && value.evaluationAttempts?.some(attempt => attempt.status === 'repair-completed')) {
        blockPendingResumeRead = false
        driveReadStarted.resolve()
        await releaseDriveRead.promise
      }
      return value
    }

    await expect(service.rerunEvaluation(admission.evolutionId, admission.roundId, evalId, { mode: 'invalid' }))
      .resolves.toMatchObject({ evalStatus: 'succeeded' })
    await driveReadStarted.promise
    expect(service.activeEntry(admission.roundId)?.workspace).toBeUndefined()
    const disposing = service.dispose()
    releaseDriveRead.resolve()
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
      status: 'repairing-evaluation',
      baseline: { evalId },
      evaluationAttempts: [{ status: 'repair-completed' }],
    })
    const lock = await store.acquireRoundLock(admission.roundId)
    await lock.release()
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
    await store.writeRound({
      ...interrupted,
      status: 'repairing-evaluation',
      evaluationAttempts: failed.evaluationAttempts.map(attempt => {
        const { completedAt: _completedAt, failure: _failure, ...running } = attempt
        return { ...running, status: 'rerunning' as const }
      }),
    })
    await service.initialize()
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
      expect(resumed.evaluationAttempts?.[0]).toMatchObject({ status: 'settled', completedAt: expect.any(String) })
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
      summaryAccessed: true, accessedRefs: [first.baseline!.evalId, ...failed], diagnosedRunRefs: failed, citedRefs: [],
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

  it('rejects proposal usage budgets that DSH cannot verify instead of recording them as effective', async () => {
    const { service } = await setup()
    service.options.candidateGeneration.budget.maxModelRequests = 2
    await expect(service.admit('api')).rejects.toThrow(/aggregate proposal usage/)
    expect(await service.listEvolutions()).toEqual([])
    await service.dispose()
  })

  it('enforces the immutable candidate generation timeout and cleans up the workspace', async () => {
    const { service } = await setup(0.8, false, 1, 50)
    const admission = await service.admit('api')
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'rejected',
    )
    expect(terminal?.candidatePool[0]?.failure?.message).toMatch(/candidate generation exceeded its 50ms round budget/)
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    await service.dispose()
  })
})
