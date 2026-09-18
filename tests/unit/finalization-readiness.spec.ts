import { describe, expect, it } from 'vitest'
import { finalizationReadiness, recoveryRequired } from '../../src/refine/finalization-readiness.js'
import type { EvaluationEvidence, ProposalEvidenceAudit } from '../../src/types.js'

function baseline(count: number): EvaluationEvidence {
  return {
    provider: 'fake',
    conditionId: 'condition',
    effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
    evalId: `eval_${'1'.repeat(32)}`,
    dataset: 'seed',
    requestedCommit: 'a'.repeat(40),
    actualCommit: 'a'.repeat(40),
    revisionIdentity: `sha256:${'b'.repeat(64)}`,
    completeness: 'complete',
    plannedTrialCount: count,
    primaryReward: 0,
    summary: { total: count, passed: 0, failed: count, score: 0 },
    trials: Array.from({ length: count }, (_, index) => ({
      taskName: `task-${String(index + 1).padStart(2, '0')}`,
      trialName: `trial-${index + 1}`,
      runId: `run_${(index + 1).toString(16).padStart(32, '0')}`,
      attempt: 1,
      status: 'completed' as const,
      rewards: { reward: 0 },
    })),
    invalidTrials: [],
  }
}

function audit(overrides: Partial<ProposalEvidenceAudit> = {}): ProposalEvidenceAudit {
  return {
    evolutionId: 'evo-1',
    roundId: 'round-1',
    baselineEvalId: `eval_${'1'.repeat(32)}`,
    summaryAccessed: true,
    accessedRefs: [],
    diagnosedRunRefs: [],
    citedRefs: [],
    ...overrides,
  }
}

describe('finalization readiness', () => {
  it('returns task-labelled executable actions in complete batches', () => {
    const readiness = finalizationReadiness(baseline(11), audit())
    expect(readiness).toMatchObject({
      ready: false,
      failedRunCount: 11,
      diagnosedRunCount: 0,
      remainingRunCount: 11,
      nextActions: [
        { tool: 'trajectory_query', arguments: { refs: expect.any(Array) }, coversRunIds: expect.arrayContaining([]) },
        { tool: 'trajectory_query', arguments: { refs: expect.any(Array) } },
        { tool: 'trajectory_query', arguments: { refs: expect.any(Array) } },
      ],
    })
    expect(readiness.missing).toContainEqual(expect.objectContaining({ taskName: 'task-01', reward: 0 }))
    expect(readiness.nextActions[0]?.coversRunIds).toHaveLength(5)
    expect(readiness.nextActions[1]?.coversRunIds).toHaveLength(5)
    expect(readiness.nextActions[2]?.coversRunIds).toHaveLength(1)
    const recovery = recoveryRequired(readiness, 'candidate.finalize')
    expect(recovery).toMatchObject({
      accepted: false,
      recoverable: true,
      code: 'MISSING_BASELINE_DIAGNOSIS',
      nextAction: readiness.nextActions[0],
      remainingActions: [readiness.nextActions[1], readiness.nextActions[2]],
      retry: { tool: 'finalize_candidate', reusePreviousArguments: true },
    })
  })

  it('accepts digest-bound receipts and becomes ready after the final bundle', () => {
    const evidence = baseline(2)
    const receipts = evidence.trials.map(trial => ({
      runId: trial.runId!,
      bundleDigest: `sha256:${'c'.repeat(64)}`,
      trajectoryDigest: `sha256:${'d'.repeat(64)}`,
      projectionVersion: 1 as const,
      verifierStatus: 'unavailable' as const,
      compatibility: 'allow-unavailable-verifier' as const,
      sanitizationPolicyDigest: `sha256:${'e'.repeat(64)}`,
      inspectedAt: 'now',
    }))
    expect(finalizationReadiness(evidence, audit({ diagnosisReceipts: receipts }))).toMatchObject({
      ready: true,
      diagnosedRunCount: 2,
      remainingRunCount: 0,
      blockers: [],
      nextActions: [],
    })
  })

  it('does not treat the legacy diagnosed-run list as proof of inspection', () => {
    const evidence = baseline(1)
    const runId = evidence.trials[0]!.runId!
    expect(finalizationReadiness(evidence, audit({ diagnosedRunRefs: [runId] }))).toMatchObject({
      ready: false,
      diagnosedRunCount: 0,
      missing: [{ runId }],
      blockers: [{ code: 'MISSING_BASELINE_DIAGNOSIS' }],
    })
  })

  it('blocks explicitly when verifier evidence is unavailable and compatibility is disabled', () => {
    const evidence = baseline(1)
    const trial = evidence.trials[0]!
    const readiness = finalizationReadiness(evidence, audit({
      diagnosisReceipts: [{
        runId: trial.runId!,
        bundleDigest: `sha256:${'c'.repeat(64)}`,
        trajectoryDigest: `sha256:${'d'.repeat(64)}`,
        projectionVersion: 1,
        verifierStatus: 'unavailable',
        sanitizationPolicyDigest: `sha256:${'e'.repeat(64)}`,
        inspectedAt: 'now',
      }],
    }))
    expect(readiness).toMatchObject({
      ready: false,
      verifierBlockedRunIds: [trial.runId],
      blockers: [{ code: 'VERIFIER_EVIDENCE_UNAVAILABLE' }],
      nextActions: [],
    })
    expect(recoveryRequired(readiness, 'candidate.finalize')).toMatchObject({
      accepted: false,
      recoverable: false,
      code: 'VERIFIER_EVIDENCE_UNAVAILABLE',
      operatorAction: { compatibilityConfig: 'hitch.allowUnavailableVerifierDiagnosis=true' },
    })
  })

  it('returns a typed recovery action for allowed evidence cited before access', () => {
    const evidence = baseline(1)
    evidence.trials[0]!.rewards.reward = 1
    const runId = evidence.trials[0]!.runId!
    const readiness = finalizationReadiness(evidence, audit({ citedRefs: [runId] }))
    expect(readiness).toMatchObject({
      ready: false,
      unaccessedCitedRefs: [runId],
      blockers: [{ code: 'EVIDENCE_REF_NOT_ACCESSED' }],
      nextActions: [{ tool: 'trajectory_query', arguments: { refs: [runId] } }],
    })
    expect(recoveryRequired(readiness, 'candidate.finalize')).toMatchObject({
      accepted: false,
      code: 'EVIDENCE_REF_NOT_ACCESSED',
      nextAction: { arguments: { refs: [runId] } },
    })
  })

  it('stops retry loops when Hitch cannot construct bounded trajectory evidence', () => {
    const evidence = baseline(1)
    const runId = evidence.trials[0]!.runId!
    const readiness = finalizationReadiness(evidence, audit(), [{
      runId,
      code: 'trajectory_integrity_mismatch',
      message: `Bounded trajectory evidence could not be constructed for ${runId}.`,
    }])
    expect(readiness).toMatchObject({
      ready: false,
      missing: [{ taskName: 'task-01', runId }],
      trajectoryBlockedRuns: [{ runId, code: 'trajectory_integrity_mismatch' }],
      blockers: [{ code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE' }],
      nextActions: [],
    })
    expect(recoveryRequired(readiness, 'candidate.finalize')).toMatchObject({
      accepted: false,
      recoverable: false,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      operatorAction: {
        repair: 'Repair or re-import the persisted trajectory or verifier evidence for the affected runs.',
        runIds: [runId],
        reason: 'trajectory_integrity_mismatch',
      },
      retry: { tool: 'finalize_candidate', reusePreviousArguments: true, afterPrerequisite: true },
    })
  })
})
