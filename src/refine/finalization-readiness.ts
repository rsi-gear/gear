import type {
  CapabilityAction,
  EvaluationEvidence,
  FinalizationReadiness,
  MetaPrerequisiteBlocked,
  MetaRecoveryRequired,
  ProposalEvidenceAudit,
  TrajectoryEvidenceBlocker,
} from '../types.js'
import { validateReceipt } from '../search/diagnosis.js'

function reward(rewards: Record<string, number>): number | undefined {
  return rewards.reward ?? Object.values(rewards)[0]
}

export function receiptIsValid(receipt: NonNullable<ProposalEvidenceAudit['diagnosisReceipts']>[number]): boolean {
  const verifierAccepted = receipt.verifierStatus === 'complete'
    || receipt.verifierStatus === 'result_only'
    || receipt.verifierStatus === 'explicitly-missing'
    || (receipt.verifierStatus === 'unavailable' && receipt.compatibility === 'allow-unavailable-verifier')
  return receipt.projectionVersion === 1
    && /^sha256:[0-9a-f]{64}$/u.test(receipt.bundleDigest)
    && /^sha256:[0-9a-f]{64}$/u.test(receipt.trajectoryDigest)
    && /^sha256:[0-9a-f]{64}$/u.test(receipt.sanitizationPolicyDigest)
    && verifierAccepted
}

export function finalizationReadiness(
  baseline: EvaluationEvidence,
  audit: ProposalEvidenceAudit,
  trajectoryBlockedRuns: readonly TrajectoryEvidenceBlocker[] = [],
): FinalizationReadiness {
  if (audit.workplanDelivery) {
    let consumed = false
    try {
      if (audit.workplanReceipt) {
        validateReceipt(audit.workplanReceipt, audit.workplanDelivery, audit.workplanReceipt.sessionId)
        consumed = audit.candidateId === audit.workplanDelivery.workplan.candidateId
      }
    } catch { consumed = false }
    const unaccessedCitedRefs = audit.citedRefs.filter(ref => !audit.accessedRefs.includes(ref))
    const ready = consumed && audit.summaryAccessed && unaccessedCitedRefs.length === 0
    return { ready, summaryAccessed: audit.summaryAccessed, baselineEvalId: baseline.evalId,
      failedRunCount: audit.workplanDelivery.workplan.requiredDiagnosisRefs.length,
      diagnosedRunCount: consumed ? audit.workplanDelivery.workplan.requiredDiagnosisRefs.length : 0,
      remainingRunCount: consumed ? 0 : audit.workplanDelivery.workplan.requiredDiagnosisRefs.length,
      missing: [], verifierBlockedRunIds: [], trajectoryBlockedRuns: [], unaccessedCitedRefs,
      blockers: ready ? [] : [{ code: 'MISSING_BASELINE_DIAGNOSIS', message: 'Consume the assigned workplan, sourced dossier and shared constraints before finalizing; cited evidence must be accessed.' }],
      nextActions: [] }
  }
  const required = baseline.trials
    .filter(trial => (reward(trial.rewards) ?? 0) <= 0 && trial.runId !== undefined)
    .map(trial => {
      const trialReward = reward(trial.rewards)
      return {
        taskName: trial.taskName,
        runId: trial.runId!,
        ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
        ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
        ...(trialReward === undefined ? {} : { reward: trialReward }),
      }
    })
    .sort((left, right) => left.taskName.localeCompare(right.taskName) || left.runId.localeCompare(right.runId))
  const receipts = audit.diagnosisReceipts ?? []
  const diagnosed = new Set(receipts.filter(receiptIsValid).map(receipt => receipt.runId))
  const verifierBlocked = new Set((receipts ?? [])
    .filter(receipt => receipt.verifierStatus === 'unavailable'
      && receipt.compatibility !== 'allow-unavailable-verifier')
    .map(receipt => receipt.runId))
  const missing = required.filter(item => !diagnosed.has(item.runId))
  const verifierBlockedRunIds = missing.filter(item => verifierBlocked.has(item.runId)).map(item => item.runId)
  const requiredRunIds = new Set(required.map(item => item.runId))
  const trajectoryBlocked = trajectoryBlockedRuns
    .filter(item => requiredRunIds.has(item.runId) && !diagnosed.has(item.runId))
    .sort((left, right) => left.runId.localeCompare(right.runId))
  const trajectoryBlockedRunIds = new Set(trajectoryBlocked.map(item => item.runId))
  const actionableMissing = missing.filter(item => !verifierBlocked.has(item.runId) && !trajectoryBlockedRunIds.has(item.runId))
  const allowedRefs = new Set([
    baseline.evalId,
    ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
    ...baseline.invalidTrials.map(trial => trial.runId),
  ])
  const accessedRefs = new Set(audit.accessedRefs)
  const coveredByDiagnosis = new Set(missing.map(item => item.runId))
  const unaccessedCitedRefs = audit.summaryAccessed
    ? [...new Set(audit.citedRefs.filter(ref => allowedRefs.has(ref)
      && !accessedRefs.has(ref)
      && !coveredByDiagnosis.has(ref)))].sort()
    : []
  const blockers: FinalizationReadiness['blockers'] = []
  const nextActions: CapabilityAction[] = []
  if (!audit.summaryAccessed) {
    blockers.push({
      code: 'BASELINE_SUMMARY_REQUIRED',
      message: 'Read the current baseline summary before finalizing.',
    })
    nextActions.push({
      actionId: 'read-current-baseline-summary',
      tool: 'trajectory_query',
      arguments: {},
      reason: 'Load the authoritative current-round seed baseline summary.',
    })
  }
  if (actionableMissing.length > 0) {
    blockers.push({
      code: 'MISSING_BASELINE_DIAGNOSIS',
      message: `${actionableMissing.length} failed baseline run${actionableMissing.length === 1 ? '' : 's'} still require a diagnostic card.`,
    })
    for (let index = 0; index < actionableMissing.length; index += 5) {
      const batch = actionableMissing.slice(index, index + 5)
      const refs = batch.map(item => item.runId)
      nextActions.push({
        actionId: `diagnose-failed-baselines-${Math.floor(index / 5) + 1}`,
        tool: 'trajectory_query',
        arguments: { refs },
        reason: `Read diagnostic cards for ${refs.length} failed baseline run${refs.length === 1 ? '' : 's'}.`,
        coversRunIds: refs,
      })
    }
  }
  if (verifierBlockedRunIds.length > 0) {
    blockers.push({
      code: 'VERIFIER_EVIDENCE_UNAVAILABLE',
      message: `${verifierBlockedRunIds.length} failed baseline run${verifierBlockedRunIds.length === 1 ? ' has' : 's have'} no verifier evidence and compatibility is disabled.`,
    })
  }
  if (trajectoryBlocked.length > 0) {
    blockers.push({
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      message: `${trajectoryBlocked.length} failed baseline run${trajectoryBlocked.length === 1 ? ' has' : 's have'} no usable bounded trajectory evidence.`,
    })
  }
  if (unaccessedCitedRefs.length > 0) {
    blockers.push({
      code: 'EVIDENCE_REF_NOT_ACCESSED',
      message: `${unaccessedCitedRefs.length} cited baseline evidence ref${unaccessedCitedRefs.length === 1 ? ' has' : 's have'} not been read.`,
    })
    if (unaccessedCitedRefs.includes(baseline.evalId)) {
      nextActions.push({
        actionId: 'read-cited-baseline-summary',
        tool: 'trajectory_query',
        arguments: {},
        reason: 'Read the cited authoritative baseline evaluation summary.',
      })
    }
    const runRefs = unaccessedCitedRefs.filter(ref => ref !== baseline.evalId)
    for (let index = 0; index < runRefs.length; index += 10) {
      const refs = runRefs.slice(index, index + 10)
      nextActions.push({
        actionId: `read-cited-baseline-runs-${Math.floor(index / 10) + 1}`,
        tool: 'trajectory_query',
        arguments: { refs },
        reason: `Read the ${refs.length} cited baseline run${refs.length === 1 ? '' : 's'} before retrying.`,
        coversRunIds: refs,
      })
    }
  }
  return {
    ready: blockers.length === 0,
    summaryAccessed: audit.summaryAccessed,
    baselineEvalId: baseline.evalId,
    failedRunCount: required.length,
    diagnosedRunCount: required.length - missing.length,
    remainingRunCount: missing.length,
    missing,
    verifierBlockedRunIds,
    trajectoryBlockedRuns: trajectoryBlocked,
    unaccessedCitedRefs,
    blockers,
    nextActions,
  }
}

export function recoveryRequired(
  readiness: FinalizationReadiness,
  failedOperation: MetaRecoveryRequired['failedOperation'],
): MetaRecoveryRequired | MetaPrerequisiteBlocked | undefined {
  const first = readiness.blockers[0]
  if (first === undefined) return undefined
  const retryTool = failedOperation === 'candidate.finalize' ? 'finalize_candidate' : 'decline_candidate'
  if (first.code === 'VERIFIER_EVIDENCE_UNAVAILABLE') {
    return {
      schemaVersion: 1,
      accepted: false,
      recoverable: false,
      code: first.code,
      failedOperation,
      message: `The operation was not submitted because verifier evidence is unavailable for ${readiness.verifierBlockedRunIds.length} failed baseline run${readiness.verifierBlockedRunIds.length === 1 ? '' : 's'}. An operator must upgrade Hitch or explicitly enable trajectory-only compatibility, then the diagnostic cards must be read again.`,
      readiness,
      operatorAction: {
        upgrade: 'Hitch verifier evidence API',
        compatibilityConfig: 'hitch.allowUnavailableVerifierDiagnosis=true',
      },
      retry: { tool: retryTool, reusePreviousArguments: true, afterPrerequisite: true },
    }
  }
  if (first.code === 'TRAJECTORY_EVIDENCE_UNAVAILABLE') {
    const requiresUpgrade = readiness.trajectoryBlockedRuns.some(item => item.resolution === 'upgrade-hitch')
    const requiresRepair = readiness.trajectoryBlockedRuns.some(item => item.resolution !== 'upgrade-hitch')
    return {
      schemaVersion: 1,
      accepted: false,
      recoverable: false,
      code: first.code,
      failedOperation,
      message: `The operation was not submitted because bounded trajectory evidence is unavailable for ${readiness.trajectoryBlockedRuns.length} failed baseline run${readiness.trajectoryBlockedRuns.length === 1 ? '' : 's'}. Resolve the reported prerequisite, then read the affected diagnostic cards again.`,
      readiness,
      operatorAction: {
        ...(requiresUpgrade ? { upgrade: 'Upgrade Hitch to provide the required bounded evidence capability.' } : {}),
        ...(requiresRepair ? { repair: 'Repair or re-import the persisted trajectory or verifier evidence for the affected runs.' } : {}),
        runIds: readiness.trajectoryBlockedRuns.map(item => item.runId),
        reason: readiness.trajectoryBlockedRuns.map(item => item.cause ?? item.code).join(','),
      },
      retry: { tool: retryTool, reusePreviousArguments: true, afterPrerequisite: true },
    }
  }
  const nextAction = readiness.nextActions[0]
  if (nextAction === undefined) return undefined
  const message = first.code === 'BASELINE_SUMMARY_REQUIRED'
    ? 'The operation was not submitted because the current baseline summary has not been read. Execute nextAction, then remainingActions, and retry with the same arguments.'
    : first.code === 'EVIDENCE_REF_NOT_ACCESSED'
      ? `The operation was not submitted because ${readiness.unaccessedCitedRefs.length} cited baseline evidence ref${readiness.unaccessedCitedRefs.length === 1 ? ' has' : 's have'} not been read. Execute nextAction, then remainingActions, and retry with the same arguments.`
      : `The operation was not submitted: ${readiness.diagnosedRunCount}/${readiness.failedRunCount} failed baseline runs are diagnosed; ${readiness.remainingRunCount} remain. Execute nextAction, then remainingActions, and retry with the same arguments.`
  return {
    schemaVersion: 1,
    accepted: false,
    recoverable: true,
    code: first.code,
    failedOperation,
    message,
    readiness,
    nextAction,
    remainingActions: readiness.nextActions.slice(1),
    retry: { tool: retryTool, reusePreviousArguments: true },
  }
}
