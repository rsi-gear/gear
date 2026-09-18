import { describe, expect, it } from 'vitest'
import {
  builtinComponentRef,
  componentRef,
  ComponentRegistry,
  DatasetTaskSampler,
  EvaluationMetricsCandidateAssessor,
  HighestQualityCandidateSelector,
  PairedGatePromotionPolicy,
  rolloutProviderSemanticDigest,
  TaskRewardJudge,
} from '../../src/evolution/components.js'
import { evidence, evolutionSpec, roundFixture } from '../helpers/research-fixture.js'
import { digestJson } from '../../src/state/digest.js'

describe('evolution component contracts', () => {
  it('rejects tampered component configuration digests', () => {
    const registry = new ComponentRegistry()
    const ref = builtinComponentRef('candidate-selector', 'highest-quality', { weight: 1 })
    const tampered = { ...ref, config: { weight: 2 } }
    expect(() => registry.selector(tampered)).toThrow(/config digest mismatch/)
  })

  it('resolves immutable paired conditions independently from execution isolation', () => {
    const spec = evolutionSpec()
    const sampler = new DatasetTaskSampler(spec.rollout.taskSampler)
    const first = sampler.resolve('round-1', spec.datasets, spec.rollout, spec.taskBudgetMs)
    const second = sampler.resolve('round-1', spec.datasets, spec.rollout, spec.taskBudgetMs)
    expect(first).toEqual(second)
    expect(first.seed.conditionId).not.toBe(first.heldOut.conditionId)
    expect(first.seed.dataset).toEqual(spec.datasets.seed)
  })

  it('keeps condition identity stable across provider relocation and operational changes', () => {
    const spec = evolutionSpec()
    const agentConfig = { agentArgs: ['--mode', 'evaluation'] }
    const firstProvider = builtinComponentRef('rollout-provider', 'hitch-cli', {
      executable: 'tools/hitch',
      root: 'runtime-a',
      harnessId: 'terminal-bench',
      maxConcurrent: 1,
      passEnv: ['MODEL_API_KEY_A'],
    })
    const relocatedProvider = builtinComponentRef('rollout-provider', 'hitch-cli', {
      executable: 'vendor/hitch',
      root: 'runtime-b',
      harnessId: 'terminal-bench',
      maxConcurrent: 8,
      passEnv: ['MODEL_API_KEY_B'],
    })
    const firstSemanticDigest = rolloutProviderSemanticDigest(
      firstProvider,
      { harnessId: 'terminal-bench' },
      agentConfig,
    )
    const relocatedSemanticDigest = rolloutProviderSemanticDigest(
      relocatedProvider,
      { harnessId: 'terminal-bench' },
      agentConfig,
    )
    expect(relocatedSemanticDigest).toBe(firstSemanticDigest)

    const sampler = new DatasetTaskSampler(spec.rollout.taskSampler)
    const first = sampler.resolve('round-1', spec.datasets, {
      ...spec.rollout,
      provider: firstProvider,
      providerSemanticDigest: firstSemanticDigest,
      agentConfig,
    }, spec.taskBudgetMs)
    const relocated = sampler.resolve('round-1', spec.datasets, {
      ...spec.rollout,
      provider: relocatedProvider,
      providerSemanticDigest: relocatedSemanticDigest,
      agentConfig,
    }, spec.taskBudgetMs)
    expect(relocated.seed.conditionId).toBe(first.seed.conditionId)
    expect(relocated.heldOut.conditionId).toBe(first.heldOut.conditionId)

    const differentAgentDigest = rolloutProviderSemanticDigest(
      relocatedProvider,
      { harnessId: 'terminal-bench' },
      { agentArgs: ['--mode', 'different'] },
    )
    const changed = sampler.resolve('round-1', spec.datasets, {
      ...spec.rollout,
      provider: relocatedProvider,
      providerSemanticDigest: differentAgentDigest,
      agentConfig: { agentArgs: ['--mode', 'different'] },
    }, spec.taskBudgetMs)
    expect(changed.seed.conditionId).not.toBe(first.seed.conditionId)
  })

  it('allocates a fixed candidate count deterministically across research parents', () => {
    const spec = evolutionSpec()
    const generator = new ComponentRegistry().candidateGenerator(spec.candidateGeneration.strategy)
    const parent = (candidateId: string, harnessRef: string) => ({
      candidateId, harnessRef, harnessDigest: `sha256:${'a'.repeat(64)}`,
      parentCandidateIds: [], lineageRootId: candidateId,
      metrics: { quality: 1, taskSuccessRate: 1 },
    })
    const slots = generator.plan('round-x', [parent('b', 'b'.repeat(40)), parent('a', 'a'.repeat(40))], 5)
    expect(slots.map(slot => slot.parentCandidateIds[0])).toEqual(['a', 'b', 'a', 'b', 'a'])
  })

  it('assesses and selects highest quality deterministically before applying the paired promotion gate', async () => {
    const state = roundFixture()
    const left = {
      candidateId: 'left', parentHarnessRef: state.targetHarnessRef, parentCandidateIds: ['parent'],
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.4, '1'),
      seedComparison: {
        parentBaselineEvalId: 'baseline', pairedTrials: [],
        pairing: { planned: 1, paired: 0, excluded: 1, baselineInvalid: 0, candidateInvalid: 0 },
        scoreDelta: -0.1, requiredRegressions: 0,
      },
      sealedVersion: { commitOid: '1'.repeat(40), treeOid: '2'.repeat(40), manifestDigest: `sha256:${'3'.repeat(64)}`, patchDigest: `sha256:${'4'.repeat(64)}`, immutableRef: 'refs/test/left' },
      metrics: { quality: 0.4, taskSuccessRate: 0.4 },
    }
    const right = {
      candidateId: 'right', parentHarnessRef: state.targetHarnessRef, parentCandidateIds: ['parent'],
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.8, '2'),
      seedComparison: {
        parentBaselineEvalId: 'baseline', pairedTrials: [],
        pairing: { planned: 1, paired: 0, excluded: 1, baselineInvalid: 0, candidateInvalid: 0 },
        scoreDelta: 0.3, requiredRegressions: 0,
      },
      sealedVersion: { commitOid: '5'.repeat(40), treeOid: '6'.repeat(40), manifestDigest: `sha256:${'7'.repeat(64)}`, patchDigest: `sha256:${'8'.repeat(64)}`, immutableRef: 'refs/test/right' },
      metrics: { quality: 0.8, taskSuccessRate: 0.8 },
    }
    const assessorRef = builtinComponentRef('candidate-assessor', 'evaluation-metrics', {})
    const assessmentResult = await new EvaluationMetricsCandidateAssessor(assessorRef)
      .assess({ evolutionId: 'evo-1', roundId: state.roundId, candidates: [left, right] }, {}, new AbortController().signal)
    const assessmentIdentity = { component: assessorRef, ...assessmentResult }
    const assessment = { ...assessmentIdentity, digest: digestJson(assessmentIdentity) }
    const selectorRef = builtinComponentRef('candidate-selector', 'highest-quality', {})
    const selector = new HighestQualityCandidateSelector(selectorRef)
    expect(selector.select({ candidates: [left, right], survivors: 1, assessment }))
      .toMatchObject({ selectedCandidateIds: ['right'], promotionCandidateId: 'right', assessmentDigest: assessment.digest })
    expect(() => selector.select({ candidates: [right, { ...right, candidateId: 'duplicate' }], survivors: 2, assessment }))
      .toThrow(/found 1/)

    const policy = { ...state.promotionPolicy, minimumAbsoluteGain: 0.1 }
    const gate = new PairedGatePromotionPolicy(builtinComponentRef('promotion-policy', 'paired-gate', policy))
    expect(gate.decide({
      policy,
      seedBaseline: evidence(state.plan.seed, state.targetHarnessRef, 0.5, '3'),
      seedCandidate: evidence(state.plan.seed, state.targetHarnessRef, 0, '4'),
      heldOutBaseline: evidence(state.plan.heldOut, state.targetHarnessRef, 0.6, '5'),
      heldOutCandidate: evidence(state.plan.heldOut, state.targetHarnessRef, 0, '6'),
      pairedTrials: {
        seed: [{
          conditionId: state.plan.seed.conditionId, trialKey: 'seed-1', taskName: 'task-1',
          baselineReward: 0.5, candidateReward: 0.8, rewardDelta: 0.3,
        }],
        heldOut: [{
          conditionId: state.plan.heldOut.conditionId, trialKey: 'held-1', taskName: 'task-1',
          baselineReward: 0.6, candidateReward: 0.6, rewardDelta: 0,
        }],
      },
      metrics: { quality: 0.6, taskSuccessRate: 1 },
      requiredRegressions: 0,
    })).toMatchObject({ accepted: true })
    expect(gate.decide({
      policy,
      seedBaseline: evidence(state.plan.seed, state.targetHarnessRef, 0.5, '7'),
      seedCandidate: evidence(state.plan.seed, state.targetHarnessRef, 0.8, '8'),
      heldOutBaseline: evidence(state.plan.heldOut, state.targetHarnessRef, 0.6, '9'),
      heldOutCandidate: evidence(state.plan.heldOut, state.targetHarnessRef, 0.6, 'a'),
      pairedTrials: { seed: [], heldOut: [] },
      metrics: { quality: 1, taskSuccessRate: 1 },
      requiredRegressions: 0,
    })).toMatchObject({ accepted: false, reason: expect.stringMatching(/at least one valid/) })
  })

  it('supports developer registration without allowing duplicate component ids', () => {
    const registry = new ComponentRegistry()
    const implementation = {
      package: 'test-components',
      version: '1.0.0',
      integrity: `sha256:${'a'.repeat(64)}`,
    }
    registry.registerCandidateSelector('custom', implementation, ref => new HighestQualityCandidateSelector(ref))
    registry.registerCandidateAssessor('custom-assessor', implementation, ref => new EvaluationMetricsCandidateAssessor(ref))
    const unregisterJudge = registry.registerJudge('custom-reward', implementation, ref => new TaskRewardJudge(ref))
    const evaluator = { evaluate: async () => { throw new Error('not invoked') } }
    registry.registerRolloutProvider('custom-rollout', implementation, ref => ({ ref, createEvaluator: () => evaluator }))
    expect(registry.selector(componentRef('candidate-selector', 'custom', implementation, {})))
      .toBeInstanceOf(HighestQualityCandidateSelector)
    expect(registry.assessor(componentRef('candidate-assessor', 'custom-assessor', implementation, {})))
      .toBeInstanceOf(EvaluationMetricsCandidateAssessor)
    expect(registry.judge(componentRef('judge', 'custom-reward', implementation, {})))
      .toBeInstanceOf(TaskRewardJudge)
    expect(registry.rolloutProvider(componentRef('rollout-provider', 'custom-rollout', implementation, {}))
      .createEvaluator(evolutionSpec())).toBe(evaluator)
    expect(() => registry.registerCandidateSelector('custom', implementation, ref => new HighestQualityCandidateSelector(ref)))
      .toThrow(/already registered/)
    expect(() => registry.judge(componentRef('judge', 'custom-reward', { ...implementation, version: '2.0.0' }, {})))
      .toThrow(/implementation identity mismatch/)
    unregisterJudge()
    expect(() => registry.judge(componentRef('judge', 'custom-reward', implementation, {}))).toThrow(/unknown judge/)
  })
})
