import type {
  ArtifactRef,
  CandidateAssessmentContext,
  CandidateAssessmentRequest,
  CandidateAssessmentResult,
  CandidateSelectionRequest,
  ComponentRef,
  EvaluationCondition,
  EvolutionSpec,
  EvaluationEvidence,
  MetricSet,
  PairedTrial,
  PromotionPolicy,
  ResolvedRoundPlan,
  RolloutSpec,
  SelectionDecision,
} from '../types.js'
import { digestJson } from '../state/digest.js'
import { assertComponentRef } from './component-ref.js'
import type {
  CandidateGenerator,
  CandidateGenerationParent,
  CandidateGenerationSlot,
  CandidateAssessor,
  CandidateSelector,
  Judge,
  PromotionDecision,
  PromotionDecisionRequest,
  PromotionPolicyProvider,
  TaskSampler,
} from './components.js'

export class ForkedProposalCandidateGenerator implements CandidateGenerator {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'candidate-generator')
    this.ref = ref
  }

  plan(roundId: string, parents: readonly CandidateGenerationParent[], maxCandidates: number): CandidateGenerationSlot[] {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
      throw new TypeError('candidateGeneration.maxCandidates must be a positive integer')
    }
    if (parents.length === 0) throw new TypeError('candidate generation requires at least one parent')
    const ordered = [...parents].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    return Array.from({ length: maxCandidates }, (_, index) => ({
      candidateId: `${roundId}-candidate-${index + 1}`,
      parentHarnessRef: ordered[index % ordered.length]!.harnessRef,
      parentCandidateIds: [ordered[index % ordered.length]!.candidateId],
    }))
  }
}

function condition(
  partition: EvaluationCondition['partition'],
  dataset: ArtifactRef,
  rollout: RolloutSpec,
  timeoutMs: number,
): EvaluationCondition {
  const identity = {
    partition,
    dataset,
    repetitions: rollout.repetitions,
    ...(rollout.seeds === undefined ? {} : { seeds: rollout.seeds }),
    model: rollout.model,
    sampling: rollout.sampling,
    timeoutMs,
    // Legacy specs retain their original identity so they remain readable. New specs provide the
    // path-independent semantic digest explicitly; their first round after this change establishes
    // evidence under the new identity.
    rolloutProviderDigest: rollout.providerSemanticDigest ?? digestJson(rollout.provider),
  }
  return { conditionId: digestJson(identity), ...identity }
}

export class DatasetTaskSampler implements TaskSampler {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'task-sampler')
    this.ref = ref
  }

  resolve(roundId: string, datasets: EvolutionSpec['datasets'], rollout: RolloutSpec, timeoutMs: number): ResolvedRoundPlan {
    const seed = condition('seed', datasets.seed, rollout, timeoutMs)
    const heldOut = condition('held-out', datasets.heldOut, rollout, timeoutMs)
    const identity = { roundId, taskSampler: this.ref, seed, heldOut }
    return { planId: `${roundId}-plan`, digest: digestJson(identity), taskSampler: this.ref, seed, heldOut }
  }
}

export class TaskRewardJudge implements Judge {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'judge')
    this.ref = ref
  }

  evaluate(evidence: EvaluationEvidence): Partial<MetricSet> {
    return {
      quality: evidence.primaryReward,
      taskSuccessRate: evidence.summary.total === 0 ? 0 : evidence.summary.passed / evidence.summary.total,
    }
  }
}

export class EvaluationMetricsCandidateAssessor implements CandidateAssessor {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'candidate-assessor')
    this.ref = ref
  }

  async assess(
    request: CandidateAssessmentRequest,
    _context: CandidateAssessmentContext,
    signal: AbortSignal,
  ): Promise<CandidateAssessmentResult> {
    signal.throwIfAborted()
    const ordered = [...request.candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    return {
      candidateMetrics: Object.fromEntries(ordered.map(candidate => [candidate.candidateId, structuredClone(candidate.metrics)])),
      rankingCandidateIds: ordered
        .sort((left, right) => right.metrics.quality - left.metrics.quality || left.candidateId.localeCompare(right.candidateId))
        .map(candidate => candidate.candidateId),
      reason: 'used persisted seed evaluation metrics without additional model calls',
      evidence: {
        kind: 'evaluation-metrics',
        evalIds: Object.fromEntries(ordered.map(candidate => [candidate.candidateId, candidate.seedEvaluation.evalId])),
      },
      usage: { modelRequests: 0, inputTokens: 0, outputTokens: 0 },
    }
  }
}

export class HighestQualityCandidateSelector implements CandidateSelector {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'candidate-selector')
    this.ref = ref
  }

  select(request: CandidateSelectionRequest): SelectionDecision {
    const { candidates, survivors, assessment } = request
    if (!Number.isSafeInteger(survivors) || survivors <= 0) throw new TypeError('selection.survivors must be positive')
    const scored = [...candidates]
      .sort((left, right) => (right.metrics?.quality ?? right.seedEvaluation.primaryReward)
        - (left.metrics?.quality ?? left.seedEvaluation.primaryReward)
        || left.candidateId.localeCompare(right.candidateId))
      .filter((candidate, index, ordered) => ordered.findIndex(value => value.sealedVersion.treeOid === candidate.sealedVersion.treeOid) === index)
    if (scored.length < survivors) throw new Error(`selector needs ${survivors} evaluated candidates, found ${scored.length}`)
    const selected = scored.slice(0, survivors)
    return {
      selectedCandidateIds: selected.map(candidate => candidate.candidateId),
      promotionCandidateId: selected[0]!.candidateId,
      reason: 'highest assessed quality on seed/dev evaluation',
      component: this.ref,
      assessmentDigest: assessment.digest,
      metrics: Object.fromEntries(scored.map(candidate => [candidate.candidateId, candidate.metrics?.quality ?? candidate.seedEvaluation.primaryReward])),
    }
  }
}

function pairedRewards(trials: readonly PairedTrial[], side: 'baseline' | 'candidate'): {
  score: number
  passed: number
} {
  const rewards = trials.map(trial => side === 'baseline' ? trial.baselineReward : trial.candidateReward)
  return {
    score: rewards.length === 0 ? 0 : rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
    passed: rewards.filter(reward => reward > 0).length,
  }
}

export class PairedGatePromotionPolicy implements PromotionPolicyProvider {
  readonly ref: ComponentRef<PromotionPolicy>

  constructor(ref: ComponentRef<PromotionPolicy>) {
    assertComponentRef(ref, 'promotion-policy')
    this.ref = ref
  }

  decide(request: PromotionDecisionRequest): PromotionDecision {
    if (request.pairedTrials.seed.length === 0 || request.pairedTrials.heldOut.length === 0) {
      return { accepted: false, reason: 'paired promotion gate requires at least one valid seed and held-out pair' }
    }
    const seedBaseline = pairedRewards(request.pairedTrials.seed, 'baseline')
    const seedCandidate = pairedRewards(request.pairedTrials.seed, 'candidate')
    const heldOutBaseline = pairedRewards(request.pairedTrials.heldOut, 'baseline')
    const heldOutCandidate = pairedRewards(request.pairedTrials.heldOut, 'candidate')
    const seedDelta = seedCandidate.score - seedBaseline.score
    const heldOutDelta = heldOutCandidate.score - heldOutBaseline.score
    const accepted = seedCandidate.score >= request.policy.minimumCandidateScore
      && seedDelta >= request.policy.minimumAbsoluteGain
      && heldOutDelta >= -request.policy.maxHeldOutRegression
      && request.requiredRegressions <= request.policy.maxRequiredRegressions
      && (!request.policy.requireNoRegression
        || (seedCandidate.passed >= seedBaseline.passed
          && heldOutCandidate.passed >= heldOutBaseline.passed))
    return {
      accepted,
      reason: accepted ? 'paired seed and held-out gates passed' : 'paired promotion gate rejected candidate',
    }
  }
}
