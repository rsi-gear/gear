import type { EvaluationEvidence } from '../types.js'
import type { StageResult, Snapshot } from './types.js'
import { validOutcome } from './evidence.js'

/** Meta-only seed projection. It is never a scoring or cell-reuse authority. */
export function legacySearchEvidence(result: StageResult, snapshot: Snapshot, conditionId: string, dataset: string): EvaluationEvidence {
  const trials = result.cells.filter(validOutcome).map(c => ({ taskName: c.identity.taskId, runId: c.evidenceRef, attempt: c.identity.repetition + 1,
    status: 'completed' as const, rewards: { reward: c.outcome.status === 'available' ? c.outcome.rawValue : 0 },
    scores: { totalScore: c.outcome.status === 'available' ? c.outcome.rawValue : 0, normalization: 'standard' as const,
      ...(c.process?.status === 'available' ? { processScore: c.process.rawValue } : {}) } }))
  const score = trials.length ? trials.reduce((s, t) => s + t.rewards.reward, 0) / trials.length : 0
  const passed = trials.filter(t => t.rewards.reward > 0).length
  const processScore = trials.length && trials.every(t => t.scores.processScore !== undefined)
    ? trials.reduce((sum, t) => sum + t.scores.processScore!, 0) / trials.length : undefined
  return { provider: 'search-v2-seed-projection', conditionId, effectiveConfigDigest: result.stagePlanDigest,
    evalId: result.digest, dataset, requestedCommit: snapshot.commit, actualCommit: snapshot.commit, revisionIdentity: snapshot.commit,
    completeness: result.cells.every(validOutcome) ? 'complete' : 'partial', plannedTrialCount: result.cells.length,
    primaryReward: score, ...(processScore === undefined ? {} : { processScore }),
    summary: { total: trials.length, passed, failed: trials.length - passed, score, ...(processScore === undefined ? {} : { process: { score: processScore } }) }, trials,
    invalidTrials: result.cells.filter(c => !validOutcome(c)).map(c => ({ taskName: c.identity.taskId, runId: c.evidenceRef, trialName: c.evidenceRef, attempt: c.identity.repetition + 1, status: 'errored' as const, invalidReason: c.status })) }
}
