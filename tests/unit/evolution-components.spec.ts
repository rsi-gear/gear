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

  it('selects highest quality deterministically and applies the paired promotion gate', () => {
    const state = roundFixture()
    const left = {
      ...state.candidatePool[0]!, candidateId: 'left', status: 'ready' as const,
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.4, '1'),
    }
    const right = {
      ...state.candidatePool[0]!, candidateId: 'right', status: 'ready' as const,
      seedEvaluation: evidence(state.plan.seed, state.targetHarnessRef, 0.8, '2'),
    }
    const selectorRef = builtinComponentRef('candidate-selector', 'highest-quality', {})
    expect(new HighestQualityCandidateSelector(selectorRef).select([left, right], 1).selectedCandidateIds).toEqual(['right'])

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
