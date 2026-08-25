import { describe, expect, it } from 'vitest'
import {
  builtinComponentRef,
  componentRef,
  ComponentRegistry,
  DatasetTaskSampler,
  HighestQualityCandidateSelector,
  PairedGatePromotionPolicy,
  TaskRewardJudge,
} from '../../src/evolution/components.js'
import { evidence, evolutionSpec, roundFixture } from '../helpers/research-fixture.js'

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

  it('selects highest quality deterministically and applies the paired promotion gate', () => {
    const state = roundFixture()
    const left = {
      candidateId: 'left', parentHarnessRef: state.targetHarnessRef, parentCandidateIds: ['parent'],
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.4, '1'),
      seedComparison: { parentBaselineEvalId: 'baseline', pairedTrials: [], scoreDelta: -0.1, requiredRegressions: 0 },
      sealedVersion: { commitOid: '1'.repeat(40), treeOid: '2'.repeat(40), manifestDigest: `sha256:${'3'.repeat(64)}`, patchDigest: `sha256:${'4'.repeat(64)}`, immutableRef: 'refs/test/left' },
      metrics: { quality: 0.4, taskSuccessRate: 0.4 },
    }
    const right = {
      candidateId: 'right', parentHarnessRef: state.targetHarnessRef, parentCandidateIds: ['parent'],
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.8, '2'),
      seedComparison: { parentBaselineEvalId: 'baseline', pairedTrials: [], scoreDelta: 0.3, requiredRegressions: 0 },
      sealedVersion: { commitOid: '5'.repeat(40), treeOid: '6'.repeat(40), manifestDigest: `sha256:${'7'.repeat(64)}`, patchDigest: `sha256:${'8'.repeat(64)}`, immutableRef: 'refs/test/right' },
      metrics: { quality: 0.8, taskSuccessRate: 0.8 },
    }
    const selectorRef = builtinComponentRef('candidate-selector', 'highest-quality', {})
    const selector = new HighestQualityCandidateSelector(selectorRef)
    expect(selector.select([left, right], 1)).toMatchObject({ selectedCandidateIds: ['right'], promotionCandidateId: 'right' })
    expect(() => selector.select([right, { ...right, candidateId: 'duplicate' }], 2)).toThrow(/found 1/)

    const policy = { ...state.promotionPolicy, minimumAbsoluteGain: 0.1 }
    const gate = new PairedGatePromotionPolicy(builtinComponentRef('promotion-policy', 'paired-gate', policy))
    expect(gate.decide({
      policy,
      seedBaseline: evidence(state.plan.seed, state.targetHarnessRef, 0.5, '3'),
      seedCandidate: evidence(state.plan.seed, state.targetHarnessRef, 0.8, '4'),
      heldOutBaseline: evidence(state.plan.heldOut, state.targetHarnessRef, 0.6, '5'),
      heldOutCandidate: evidence(state.plan.heldOut, state.targetHarnessRef, 0.6, '6'),
      pairedTrials: { seed: [], heldOut: [] },
      metrics: { quality: 0.6, taskSuccessRate: 1 },
      requiredRegressions: 0,
    })).toMatchObject({ accepted: true })
  })

  it('supports developer registration without allowing duplicate component ids', () => {
    const registry = new ComponentRegistry()
    const implementation = {
      package: 'test-components',
      version: '1.0.0',
      integrity: `sha256:${'a'.repeat(64)}`,
    }
    registry.registerCandidateSelector('custom', implementation, ref => new HighestQualityCandidateSelector(ref))
    const unregisterJudge = registry.registerJudge('custom-reward', implementation, ref => new TaskRewardJudge(ref))
    const evaluator = { evaluate: async () => { throw new Error('not invoked') } }
    registry.registerRolloutProvider('custom-rollout', implementation, ref => ({ ref, createEvaluator: () => evaluator }))
    expect(registry.selector(componentRef('candidate-selector', 'custom', implementation, {})))
      .toBeInstanceOf(HighestQualityCandidateSelector)
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
