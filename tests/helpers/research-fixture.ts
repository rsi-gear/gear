import { builtinComponentRef, rolloutProviderSemanticDigest } from '../../src/evolution/components.js'
import { digestJson } from '../../src/state/evolution.js'
import type {
  DshMetaAgentSpec,
  EvaluationCondition,
  EvolutionSpec,
  HitchEvaluationEvidence,
  PromotionPolicy,
  RefinementRound,
} from '../../src/types.js'

export const SHA = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`

export const DEFAULT_PROMOTION: PromotionPolicy = {
  minimumCandidateScore: 0,
  minimumAbsoluteGain: 0,
  requireNoRegression: true,
  maxHeldOutRegression: 0,
  maxRequiredRegressions: 0,
}

export function metaAgent(preset = 'meta-v1', temperature?: number): DshMetaAgentSpec {
  return {
    runtime: { type: 'dsh', version: 'test', integrity: SHA('8') },
    preset: {
      id: preset,
      digest: SHA('7'),
      resources: [{ logicalPath: 'preset/agent.cordis.yml', kind: 'composition', digest: SHA('6') }],
    },
    model: { provider: 'p', model: 'm' },
    sampling: temperature === undefined ? {} : { temperature },
  }
}

export function evaluationCondition(
  partition: 'seed' | 'held-out',
  dataset: string,
  timeoutMs = 60_000,
): EvaluationCondition {
  const identity = {
    partition,
    dataset: { ref: dataset, digest: SHA(partition === 'seed' ? 'c' : 'd') },
    repetitions: 1,
    model: 'deepseek-chat',
    sampling: {},
    timeoutMs,
    rolloutProviderDigest: SHA('e'),
  }
  return { conditionId: digestJson(identity), ...identity }
}

export function roundFixture(overrides: Partial<RefinementRound> = {}): RefinementRound {
  const roundId = overrides.roundId ?? 'round-1'
  const targetHarnessRef = overrides.targetHarnessRef ?? 'a'.repeat(40)
  const timeoutMs = overrides.taskBudgetMs ?? 60_000
  const seed = evaluationCondition('seed', overrides.seedTaskRef ?? 'seed', timeoutMs)
  const heldOut = evaluationCondition('held-out', overrides.heldOutRef ?? 'held-out', timeoutMs)
  const taskSampler = builtinComponentRef('task-sampler', 'dataset', {})
  return {
    evolutionId: 'evo-1',
    roundId,
    workspaceRoot: '/workspace',
    status: 'preparing-candidate',
    source: 'api',
    createdAt: 'now',
    updatedAt: 'now',
    metaHarnessRef: 'meta-v1',
    targetHarnessRef,
    targetHarnessDigest: SHA('b'),
    sandboxProfileRef: 'sandbox-v1',
    seedTaskRef: 'seed',
    heldOutRef: 'held-out',
    taskBudgetMs: timeoutMs,
    promotionPolicy: { ...DEFAULT_PROMOTION },
    batchId: 'batch-1',
    roundIndex: 1,
    roundCount: 1,
    plan: {
      planId: `${roundId}-plan`, digest: digestJson({ roundId, taskSampler, seed, heldOut }), taskSampler, seed, heldOut,
    },
    candidatePool: [{
      candidateId: `${roundId}-candidate-1`, roundId, parentHarnessRef: targetHarnessRef,
      parentCandidateIds: [`initial-${targetHarnessRef}`], status: 'generating',
    }],
    ...overrides,
  }
}

export function evidence(
  condition: EvaluationCondition,
  harnessRef = 'a'.repeat(40),
  score = 1,
  serial = '1',
): HitchEvaluationEvidence {
  const identity = SHA(serial)
  return {
    provider: 'fake',
    conditionId: condition.conditionId,
    effectiveConfigDigest: condition.rolloutProviderDigest,
    evalId: `eval_${serial.repeat(32).slice(0, 32)}`,
    dataset: condition.dataset.ref,
    requestedCommit: harnessRef,
    actualCommit: harnessRef,
    revisionIdentity: identity,
    invocationFingerprint: condition.rolloutProviderDigest,
    completeness: 'complete',
    plannedTrialCount: 1,
    primaryReward: score,
    summary: { total: 1, passed: score > 0 ? 1 : 0, failed: score > 0 ? 0 : 1, score },
    trials: [{ taskName: 'task-1', runId: `run_${serial.repeat(32).slice(0, 32)}`, status: 'completed', rewards: { reward: score } }],
    invalidTrials: [],
    localSourceTransport: {
      kind: 'local-git-commit', resolutionIdentity: identity, commit: harnessRef,
      tree: 'f'.repeat(40), payloadSha256: SHA('1'), payloadBytes: 1,
    },
  }
}

export function evolutionSpec(evolutionId = 'evo-1'): EvolutionSpec {
  const promotion = { ...DEFAULT_PROMOTION }
  const rolloutProvider = builtinComponentRef('rollout-provider', 'hitch-cli', {})
  const rolloutAgentConfig = {}
  return {
    evolutionId,
    createdAt: 'now',
    initialHarness: { ref: 'a'.repeat(40), digest: SHA('b') },
    datasets: { seed: { ref: 'seed', digest: SHA('c') }, heldOut: { ref: 'held', digest: SHA('d') } },
    metaAgent: metaAgent(),
    candidateGeneration: {
      strategy: builtinComponentRef('candidate-generator', 'dsh-meta-forked-proposals', {}),
      maxCandidates: 1,
      budget: { attemptTimeoutMs: 60_000, maxAttemptsPerCandidate: 2, roundTimeoutMs: 120_000 },
    },
    rollout: {
      provider: rolloutProvider,
      providerSemanticDigest: rolloutProviderSemanticDigest(rolloutProvider, { harnessId: 'test' }, rolloutAgentConfig),
      taskSampler: builtinComponentRef('task-sampler', 'dataset', {}),
      repetitions: 1,
      model: 'deepseek-chat',
      sampling: {},
      agentConfig: rolloutAgentConfig,
    },
    evaluation: { judges: [builtinComponentRef('judge', 'task-reward', {})], primaryMetric: 'primaryReward' },
    selection: {
      assessor: builtinComponentRef('candidate-assessor', 'evaluation-metrics', {}),
      strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}),
      survivors: 1,
      timeoutMs: 60_000,
    },
    promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', promotion) },
    taskBudgetMs: 60_000,
    toolchainRef: 'node',
    sandboxProfileRef: 'sandbox-v1',
  }
}
