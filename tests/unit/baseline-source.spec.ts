import { describe, expect, it, vi } from 'vitest'
import type {
  ArtifactRef,
  ComponentKind,
  ComponentRef,
  EvaluationCondition,
  EvaluationEvidence,
  EvolutionSpec,
  HitchTrajectoryAnalysis,
  HitchTrajectoryReader,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
} from '../../src/types.js'
import { digestJson } from '../../src/state/digest.js'
import {
  prepareBaselineSourceFromState,
  validateBaselineConditionSource,
  validateBaselineSourceSnapshot,
  type BaselineConditionSource,
} from '../../src/refine/baseline-source.js'

const hash = (digit: string): string => `sha256:${digit.repeat(64)}`
const commit = (digit: string): string => digit.repeat(40)
const seedDataset = { ref: 'dataset-seed-v1', digest: hash('1') }
const heldOutDataset = { ref: 'dataset-held-out-v1', digest: hash('2') }
const initial = { ref: commit('a'), manifestDigest: hash('a') }

function component<C>(
  kind: ComponentKind,
  id: string,
  config: C,
  generation: 'legacy' | 'current',
): ComponentRef<C> {
  return {
    kind,
    id,
    apiVersion: 1,
    implementation: {
      package: generation === 'legacy' ? 'dsh-plugin-refine' : 'dsh-plugin-refine/components',
      version: generation === 'legacy' ? '0.1.0' : '2.0.0',
      integrity: generation === 'legacy' ? hash('3') : hash('4'),
    },
    config,
    configDigest: digestJson(config),
  }
}

function hitchConfig(generation: 'legacy' | 'current'): Record<string, unknown> {
  return {
    executable: generation === 'legacy' ? '/old/bin/hitch' : '/new/bin/hitch',
    harnessId: 'deepseek',
    root: './hitch-data',
    model: 'target-model',
    attempts: 1,
    maxConcurrent: generation === 'legacy' ? 1 : 8,
    seeds: [],
    sampling: { temperature: 0 },
    agentArgs: ['--profile', 'target'],
    controlPlane: { mode: 'direct', requireModelCapture: false },
  }
}

function currentProviderDigest(spec: EvolutionSpec): string {
  return digestJson({
    provider: {
      kind: spec.rollout.provider.kind,
      id: spec.rollout.provider.id,
      apiVersion: spec.rollout.provider.apiVersion,
      implementation: spec.rollout.provider.implementation,
    },
    semanticConfig: { harnessId: 'deepseek' },
    agentConfig: spec.rollout.agentConfig,
  })
}

function spec(
  evolutionId: string,
  generation: 'legacy' | 'current',
  harness: ArtifactRef = { ref: initial.ref, digest: initial.manifestDigest },
): EvolutionSpec {
  const providerConfig = hitchConfig(generation)
  const value = {
    evolutionId,
    createdAt: '2026-09-10T00:00:00.000Z',
    initialHarness: harness,
    datasets: { seed: seedDataset, heldOut: heldOutDataset },
    metaAgent: {
      runtime: { type: 'dsh', version: generation === 'legacy' ? '1' : '2', integrity: hash('5') },
      preset: { id: `meta-${generation}`, digest: generation === 'legacy' ? hash('6') : hash('7'), resources: [] },
      model: { provider: 'meta', model: generation === 'legacy' ? 'meta-old' : 'meta-new' },
      sampling: { temperature: generation === 'legacy' ? 0 : 0.7 },
    },
    candidateGeneration: {
      strategy: component('candidate-generator', 'meta-forked-proposals', {}, generation),
      maxCandidates: generation === 'legacy' ? 1 : 3,
      budget: { attemptTimeoutMs: 1_000 },
    },
    rollout: {
      provider: component('rollout-provider', 'hitch-cli', providerConfig, generation),
      taskSampler: component('task-sampler', 'dataset', {}, generation),
      repetitions: 1,
      model: 'target-model',
      sampling: { temperature: 0 },
      agentConfig: { agentArgs: ['--profile', 'target'] },
    },
    evaluation: { judges: [], primaryMetric: 'reward' },
    selection: {
      assessor: component('candidate-assessor', 'evaluation-metrics', {}, generation),
      strategy: component('candidate-selector', 'highest-quality', {}, generation),
      survivors: 1,
      timeoutMs: 1_000,
    },
    promotion: {
      policy: component('promotion-policy', 'paired-gate', {
        minimumCandidateScore: 0,
        minimumAbsoluteGain: 0,
        requireNoRegression: true,
        maxHeldOutRegression: 0,
        maxRequiredRegressions: 0,
      }, generation),
    },
    taskBudgetMs: 60_000,
    toolchainRef: 'toolchain-v1',
    sandboxProfileRef: 'sandbox-v1',
  } as EvolutionSpec
  if (generation === 'current') value.rollout.providerSemanticDigest = currentProviderDigest(value)
  return value
}

function condition(value: EvolutionSpec, partition: 'seed' | 'held-out'): EvaluationCondition {
  const identity = {
    partition,
    dataset: partition === 'seed' ? value.datasets.seed : value.datasets.heldOut,
    repetitions: value.rollout.repetitions,
    ...(value.rollout.seeds === undefined ? {} : { seeds: value.rollout.seeds }),
    model: value.rollout.model,
    sampling: value.rollout.sampling,
    timeoutMs: value.taskBudgetMs,
    rolloutProviderDigest: value.rollout.providerSemanticDigest ?? digestJson(value.rollout.provider),
  }
  return { conditionId: digestJson(identity), ...identity }
}

function effectiveConfigDigest(value: EvaluationCondition, sandboxProfileRef = 'sandbox-v1'): string {
  return digestJson({ contract: 'hitch-test-v1', conditionId: value.conditionId, sandboxProfileRef })
}

function evidence(
  value: EvaluationCondition,
  harnessRef: string,
  label: string,
): EvaluationEvidence {
  return {
    provider: 'hitch-cli',
    conditionId: value.conditionId,
    effectiveConfigDigest: effectiveConfigDigest(value),
    evalId: `eval-${label}`,
    dataset: value.dataset.ref,
    requestedCommit: harnessRef,
    actualCommit: harnessRef,
    revisionIdentity: `revision-${label}`,
    invocationFingerprint: `old-invocation-${label}`,
    benchmark: { id: value.dataset.ref, revision: value.dataset.digest },
    completeness: 'complete',
    plannedTrialCount: 1,
    primaryReward: 0,
    summary: { total: 1, passed: 0, failed: 1, score: 0 },
    trials: [{
      taskName: `task-${label}`,
      trialName: `trial-${label}`,
      runId: `run-${label}`,
      attempt: 1,
      status: 'completed',
      rewards: { reward: 0 },
    }],
    invalidTrials: [],
  }
}

function attempt(
  value: EvaluationCondition,
  sourceEvidence: EvaluationEvidence,
  harnessRef: string,
  reusedFromRoundId?: string,
): RoundEvaluationAttempt {
  return {
    provider: sourceEvidence.provider,
    evalId: sourceEvidence.evalId,
    phase: value.partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
    owner: { candidateId: 'baseline', role: 'baseline', harnessRef },
    conditionId: value.conditionId,
    dataset: value.dataset.ref,
    requestedModelId: value.model,
    requestedCommit: harnessRef,
    status: 'settled',
    startedAt: '2026-09-10T00:00:01.000Z',
    completedAt: '2026-09-10T00:00:02.000Z',
    ...(reusedFromRoundId === undefined ? {} : { reusedFromRoundId }),
  }
}

function round(
  sourceSpec: EvolutionSpec,
  options: {
    roundId?: string
    target?: { ref: string; manifestDigest: string }
    heldOut?: boolean
    reusedFromRoundId?: string
  } = {},
): RefinementRound {
  const roundId = options.roundId ?? `${sourceSpec.evolutionId}-round-1`
  const target = options.target ?? initial
  const seed = condition(sourceSpec, 'seed')
  const heldOut = condition(sourceSpec, 'held-out')
  const seedEvidence = evidence(seed, target.ref, `${roundId}-seed`)
  const heldOutEvidence = evidence(heldOut, target.ref, `${roundId}-held-out`)
  const planIdentity = { roundId, taskSampler: sourceSpec.rollout.taskSampler, seed, heldOut }
  return {
    evolutionId: sourceSpec.evolutionId,
    roundId,
    workspaceRoot: '/old/repository',
    status: 'rejected',
    source: 'api',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:03.000Z',
    metaHarnessRef: commit('f'),
    targetHarnessRef: target.ref,
    targetHarnessDigest: target.manifestDigest,
    sandboxProfileRef: sourceSpec.sandboxProfileRef,
    seedTaskRef: sourceSpec.datasets.seed.ref,
    heldOutRef: sourceSpec.datasets.heldOut.ref,
    taskBudgetMs: sourceSpec.taskBudgetMs,
    promotionPolicy: sourceSpec.promotion.policy.config,
    batchId: `${sourceSpec.evolutionId}-batch-1`,
    roundIndex: 0,
    roundCount: 1,
    plan: { planId: `${roundId}-plan`, digest: digestJson(planIdentity), ...planIdentity },
    baseline: seedEvidence,
    candidatePool: [],
    evaluationAttempts: [
      attempt(seed, seedEvidence, target.ref, options.reusedFromRoundId),
      ...(options.heldOut ? [attempt(heldOut, heldOutEvidence, target.ref, options.reusedFromRoundId)] : []),
    ],
    ...(options.heldOut
      ? { evaluation: { heldOutBaseline: heldOutEvidence } as NonNullable<RefinementRound['evaluation']> }
      : {}),
    decision: 'rejected',
  }
}

function evaluator(): RefineEvaluator & { evaluate: ReturnType<typeof vi.fn>; evaluationIdentity: ReturnType<typeof vi.fn> } {
  return {
    evaluationIdentity: vi.fn((sourceRound: RefinementRound, request: { condition: EvaluationCondition }) => ({
      provider: 'hitch-cli',
      effectiveConfigDigest: effectiveConfigDigest(request.condition, sourceRound.sandboxProfileRef),
      invocationFingerprint: `current-invocation-${request.condition.partition}`,
    })),
    evaluate: vi.fn(async () => { throw new Error('Target evaluation must not run while importing a baseline') }),
  }
}

function reader(sourceRound: RefinementRound, verifierStatus: 'complete' | 'unavailable' = 'complete'):
HitchTrajectoryReader & { options: { root: string }; inspectTrajectoryAnalysis: ReturnType<typeof vi.fn> } {
  const seedEvidence = sourceRound.baseline!
  return {
    options: { root: 'hitch-data' },
    inspectCapabilities: vi.fn(async () => ({
      schemaVersion: 1 as const,
      trajectoryAnalysis: 1 as const,
      trajectoryEventsPage: 1 as const,
      verifierEvidence: 1 as const,
    })),
    inspectTrajectoryAnalysis: vi.fn(async (runId: string) => ({
      schemaVersion: 1,
      kind: 'trajectory-analysis',
      runId,
      coverage: { surface: 'complete', chunks: 'coalesced', content: 'complete', childSessions: 'none' },
    } as HitchTrajectoryAnalysis)),
    inspectTrajectoryEvents: vi.fn(async () => { throw new Error('event pages are not needed for admission') }),
    inspectVerifierEvidence: vi.fn(async (runId: string) => {
      const trial = seedEvidence.trials.find(value => value.runId === runId)!
      return {
        runId,
        parent: { evalId: seedEvidence.evalId, trialId: trial.trialName!, attempt: trial.attempt! },
        verifier: { status: verifierStatus },
      }
    }),
  }
}

async function prepare(
  sourceSpec: EvolutionSpec,
  sourceRound: RefinementRound,
  newSpec: EvolutionSpec,
  options: { partitions?: readonly ('seed' | 'held-out')[]; readerRoot?: string; allowUnavailable?: boolean } = {},
) {
  const targetEvaluator = evaluator()
  const trajectoryReader = reader(sourceRound)
  if (options.readerRoot !== undefined) trajectoryReader.options.root = options.readerRoot
  const result = await prepareBaselineSourceFromState({
    source: {
      evolutionId: sourceSpec.evolutionId,
      roundId: sourceRound.roundId,
      ...(options.partitions === undefined ? {} : { partitions: options.partitions }),
    },
    sourceSpecDigest: digestJson(sourceSpec),
    sourceSpec,
    sourceRound,
    newSpec,
    initialChampion: {
      schemaVersion: 2,
      ref: newSpec.initialHarness.ref,
      manifestDigest: newSpec.initialHarness.digest,
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
    evaluator: targetEvaluator,
    trajectoryReader,
    workspaceRoot: '/current/repository',
    ...(options.allowUnavailable === undefined
      ? {}
      : { allowUnavailableVerifierDiagnosis: options.allowUnavailable }),
  })
  return { result, targetEvaluator, trajectoryReader }
}

function replaceBaseline(roundValue: RefinementRound, sourceEvidence: EvaluationEvidence, reusedFromRoundId: string): void {
  roundValue.baseline = structuredClone(sourceEvidence)
  roundValue.evaluationAttempts = [attempt(
    roundValue.plan.seed,
    roundValue.baseline,
    roundValue.targetHarnessRef,
    reusedFromRoundId,
  )]
}

describe('baseline source preparation', () => {
  it('reuses complete legacy seed evidence across Meta and component releases without Target calls', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const sourceRound = round(sourceSpec)
    const newSpec = spec('evo-b', 'current')
    const before = structuredClone(sourceRound.baseline)

    const { result, targetEvaluator, trajectoryReader } = await prepare(sourceSpec, sourceRound, newSpec)

    expect(result.inheritedRolloutProviderDigest).toBe(sourceRound.plan.seed.rolloutProviderDigest)
    expect(result.conditionSource.source.conditionFormula).toBe('component-ref-v1')
    expect(result.conditionSource.sourceProvider.implementation).toEqual(sourceSpec.rollout.provider.implementation)
    expect(result.conditionSource.destinationProvider.implementation).toEqual(newSpec.rollout.provider.implementation)
    expect(result.snapshot.partitions.seed.evidence).toEqual(before)
    expect(result.snapshot.partitions.seed.evidence.evalId).toBe(before!.evalId)
    expect(result.snapshot.partitions.seed.evidence.invocationFingerprint).toBe(before!.invocationFingerprint)
    expect(sourceRound.baseline).toEqual(before)
    expect(targetEvaluator.evaluate).not.toHaveBeenCalled()
    expect(targetEvaluator.evaluationIdentity).toHaveBeenCalledTimes(1)
    expect(trajectoryReader.inspectTrajectoryAnalysis).toHaveBeenCalledWith(
      sourceRound.baseline!.trials[0]!.runId,
      expect.any(AbortSignal),
    )
    expect(validateBaselineConditionSource(result.conditionSource)).toEqual(result.conditionSource)
    expect(validateBaselineSourceSnapshot(result.snapshot)).toEqual(result.snapshot)
  })

  it('preserves deployed legacy evidence that already uses provider-semantic-v1', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    sourceSpec.rollout.providerSemanticDigest = currentProviderDigest(sourceSpec)
    const sourceRound = round(sourceSpec)
    const originalEvidence = structuredClone(sourceRound.baseline)

    const { result, targetEvaluator } = await prepare(sourceSpec, sourceRound, spec('evo-b', 'current'))

    expect(result.conditionSource.source.conditionFormula).toBe('provider-semantic-v1')
    expect(result.inheritedRolloutProviderDigest).toBe(sourceSpec.rollout.providerSemanticDigest)
    expect(result.snapshot.partitions.seed.condition).toEqual(sourceRound.plan.seed)
    expect(result.snapshot.partitions.seed.evidence).toEqual(originalEvidence)
    expect(result.snapshot.partitions.seed.evidence.evalId).toBe(originalEvidence!.evalId)
    expect(targetEvaluator.evaluate).not.toHaveBeenCalled()
  })

  it('defaults to seed but imports held-out evidence only when requested', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const sourceRound = round(sourceSpec, { heldOut: true })
    const newSpec = spec('evo-b', 'current')

    const seedOnly = await prepare(sourceSpec, sourceRound, newSpec)
    expect(seedOnly.result.snapshot.partitions.heldOut).toBeUndefined()
    expect(seedOnly.targetEvaluator.evaluationIdentity).toHaveBeenCalledTimes(1)

    const both = await prepare(sourceSpec, sourceRound, newSpec, { partitions: ['seed', 'held-out'] })
    expect(both.result.snapshot.partitions.heldOut?.evidence.evalId)
      .toBe(sourceRound.evaluation!.heldOutBaseline!.evalId)
    expect(both.targetEvaluator.evaluationIdentity).toHaveBeenCalledTimes(2)
  })

  it('rejects a snapshot whose evidence partitions differ from its sealed selection', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const prepared = (await prepare(
      sourceSpec,
      round(sourceSpec, { heldOut: true }),
      spec('evo-b', 'current'),
      { partitions: ['seed', 'held-out'] },
    )).result
    const forged = structuredClone(prepared.snapshot)
    delete forged.partitions.heldOut
    const { digest: _digest, ...identity } = forged
    forged.digest = digestJson(identity)

    expect(() => validateBaselineSourceSnapshot(forged)).toThrow(
      'snapshot partitions do not match the sealed source selection',
    )
  })

  it('accepts an empty Hitch config seed list when the frozen rollout omits seeds', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    expect(sourceSpec.rollout.seeds).toBeUndefined()
    expect((sourceSpec.rollout.provider.config as { seeds: unknown }).seeds).toEqual([])
    await expect(prepare(sourceSpec, round(sourceSpec), spec('evo-b', 'current'))).resolves.toBeDefined()
  })

  it('rejects Target, dataset, and artifact-root changes', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const sourceRound = round(sourceSpec)

    const changedModel = spec('evo-b', 'current')
    changedModel.rollout.model = 'other-target-model'
    ;(changedModel.rollout.provider.config as Record<string, unknown>).model = 'other-target-model'
    changedModel.rollout.provider.configDigest = digestJson(changedModel.rollout.provider.config)
    await expect(prepare(sourceSpec, sourceRound, changedModel)).rejects.toThrow('Target parameters differ')

    const changedDataset = spec('evo-b', 'current')
    changedDataset.datasets.seed = { ref: seedDataset.ref, digest: hash('9') }
    await expect(prepare(sourceSpec, sourceRound, changedDataset)).rejects.toThrow(
      'destination seed condition cannot inherit',
    )

    const changedRoot = spec('evo-b', 'current')
    ;(changedRoot.rollout.provider.config as Record<string, unknown>).root = './other-hitch-data'
    changedRoot.rollout.provider.configDigest = digestJson(changedRoot.rollout.provider.config)
    await expect(prepare(sourceSpec, sourceRound, changedRoot)).rejects.toThrow('Hitch roots differ')

    await expect(prepare(sourceSpec, sourceRound, spec('evo-b', 'current'), { readerRoot: 'other-root' }))
      .rejects.toThrow('trajectory reader is bound to a different Hitch root')
  })

  it('rejects incomplete evidence, wrong ownership phase, forged conditions, and forged effective identity', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const newSpec = spec('evo-b', 'current')

    const incomplete = round(sourceSpec)
    incomplete.baseline!.completeness = 'partial'
    await expect(prepare(sourceSpec, incomplete, newSpec)).rejects.toThrow('not complete settled evidence')

    const wrongPhase = round(sourceSpec)
    wrongPhase.evaluationAttempts![0]!.phase = 'seed-candidate'
    await expect(prepare(sourceSpec, wrongPhase, newSpec)).rejects.toThrow('not complete settled evidence')

    const forgedCondition = round(sourceSpec)
    forgedCondition.plan.seed.conditionId = hash('8')
    forgedCondition.plan.digest = digestJson({
      roundId: forgedCondition.roundId,
      taskSampler: forgedCondition.plan.taskSampler,
      seed: forgedCondition.plan.seed,
      heldOut: forgedCondition.plan.heldOut,
    })
    await expect(prepare(sourceSpec, forgedCondition, newSpec)).rejects.toThrow('condition is forged')

    const forgedEffective = round(sourceSpec)
    forgedEffective.baseline!.effectiveConfigDigest = hash('8')
    await expect(prepare(sourceSpec, forgedEffective, newSpec)).rejects.toThrow(
      'current evaluator does not recognize source seed evidence',
    )
  })

  it('does not confuse same-evolution round reuse metadata with cross-evolution condition provenance', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const reusedRound = round(sourceSpec, { roundId: 'evo-a-round-2', reusedFromRoundId: 'evo-a-round-1' })

    const { result } = await prepare(sourceSpec, reusedRound, spec('evo-b', 'current'))
    expect(result.snapshot.partitions.seed.sourceAttempt.reusedFromRoundId).toBe('evo-a-round-1')
    expect(result.conditionSource.source.conditionFormula).toBe('component-ref-v1')
  })

  it('validates A to B to C through the sealed spec proof while preserving the selected round provenance', async () => {
    const aSpec = spec('evo-a', 'legacy')
    const aRound = round(aSpec)
    const bDraft = spec('evo-b', 'current')
    const ab = (await prepare(aSpec, aRound, bDraft)).result

    const bSpec = structuredClone(bDraft) as EvolutionSpec & { baselineConditionSource: BaselineConditionSource }
    bSpec.rollout.providerSemanticDigest = ab.inheritedRolloutProviderDigest
    bSpec.baselineConditionSource = ab.conditionSource
    const bRound = round(bSpec, { roundId: 'evo-b-round-2' })
    replaceBaseline(bRound, ab.snapshot.partitions.seed.evidence, 'evo-b-round-1')

    const bc = (await prepare(bSpec, bRound, spec('evo-c', 'current'))).result
    expect(bc.conditionSource.source.conditionFormula).toBe('validated-inheritance-v1')
    expect(bc.conditionSource.parentConditionSourceDigest).toBe(ab.conditionSource.digest)
    expect(bc.snapshot.partitions.seed.evidence.evalId).toBe(aRound.baseline!.evalId)
    expect(bc.snapshot.partitions.seed.sourceAttempt.reusedFromRoundId).toBe('evo-b-round-1')
  })

  it('allows a promoted B Target to become C baseline without tying it to A evidence', async () => {
    const aSpec = spec('evo-a', 'legacy')
    const bDraft = spec('evo-b', 'current')
    const ab = (await prepare(aSpec, round(aSpec), bDraft)).result
    const bSpec = structuredClone(bDraft) as EvolutionSpec & { baselineConditionSource: BaselineConditionSource }
    bSpec.rollout.providerSemanticDigest = ab.inheritedRolloutProviderDigest
    bSpec.baselineConditionSource = ab.conditionSource

    const promoted = { ref: commit('b'), manifestDigest: hash('b') }
    const promotedRound = round(bSpec, { roundId: 'evo-b-round-promoted', target: promoted })
    const cSpec = spec('evo-c', 'current', { ref: promoted.ref, digest: promoted.manifestDigest })
    const bc = (await prepare(bSpec, promotedRound, cSpec)).result

    expect(bc.snapshot.target).toEqual({ harnessRef: promoted.ref, manifestDigest: promoted.manifestDigest })
    expect(bc.snapshot.partitions.seed.evidence.evalId).toBe('eval-evo-b-round-promoted-seed')
    expect(bc.conditionSource.parentConditionSourceDigest).toBe(ab.conditionSource.digest)
  })

  it('marks explicitly unavailable verifier data as trajectory-only while retaining ownership checks', async () => {
    const sourceSpec = spec('evo-a', 'legacy')
    const sourceRound = round(sourceSpec)
    const targetEvaluator = evaluator()
    const trajectoryReader = reader(sourceRound, 'unavailable')
    const result = await prepareBaselineSourceFromState({
      source: { evolutionId: sourceSpec.evolutionId, roundId: sourceRound.roundId },
      sourceSpecDigest: digestJson(sourceSpec),
      sourceSpec,
      sourceRound,
      newSpec: spec('evo-b', 'current'),
      initialChampion: { schemaVersion: 2, ...initial, updatedAt: '2026-09-10T00:00:00.000Z' },
      evaluator: targetEvaluator,
      trajectoryReader,
      workspaceRoot: '/current/repository',
      allowUnavailableVerifierDiagnosis: true,
    })
    expect(result.snapshot.artifactAccess.verifierEvidence).toBe('trajectory-only-explicit')
  })
})
