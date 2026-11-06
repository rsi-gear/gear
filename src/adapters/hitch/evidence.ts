import { builtinPolicy } from '../python/builtin-policy.js'
import type { Evidence, Json, AssertionEvidence } from '../../domain/algorithm-wire.js'
import { GearError } from '../../domain/errors.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { extractRawMetrics } from '../../objective/scoring.js'
import type { OperationRequest } from '../../ports/operations.js'
import type { VerifierCapture } from './verifier.js'
import { hitchEvaluationFailure } from './failure.js'

export function decodeHitchTrials(
  result: Record<string, unknown>,
  request: OperationRequest,
  taskIds: string[],
  repetition: number,
  verifiers: VerifierCapture[] = [],
): { evidence: Evidence[]; provenance: Json } {
  if (
    result.schema_version !== '1' ||
    !['succeeded', 'failed', 'cancelled'].includes(String(result.status)) ||
    !Array.isArray(result.trials)
  )
    throw new GearError('hitch-evidence-incomplete', 'Hitch has not produced a complete trial manifest')
  const trials = result.trials as Array<Record<string, unknown>>
  const failure = hitchEvaluationFailure(result)
  if (
    (!failure && trials.length !== taskIds.length) ||
    trials.length > taskIds.length ||
    new Set(trials.map((trial) => trial?.task_id)).size !== trials.length
  )
    throw new GearError('hitch-slot-mismatch', 'Hitch returned duplicate or missing task slots')
  const evidence = trials.map((trial) => {
    if (
      !trial ||
      typeof trial !== 'object' ||
      Array.isArray(trial) ||
      !taskIds.includes(String(trial.task_id)) ||
      trial.attempt !== 1 ||
      typeof trial.run_id !== 'string' ||
      !['valid', 'invalid'].includes(String(trial.observation_status))
    )
      throw new GearError('hitch-slot-mismatch', 'Hitch returned an unexpected logical slot')
    const score = trial.observation_status === 'valid' ? trial.reward : null
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1))
      throw new GearError('hitch-score-invalid', 'A valid trial must contain a finite template score')
    const reason = String(trial.invalid_reason ?? '')
    const verifier = verifiers.find(
      (value) =>
        value.run_id === trial.run_id && value.task_id === trial.task_id && value.repetition === repetition,
    )
    const raw = {
      originalResult: trial,
      scores: { passed: score === 1 },
      rewards: { reward: score },
      ...(verifier?.observation.status === 'available'
        ? { verifier: (verifier.source as { verifier: Json }).verifier }
        : {}),
    }
    const feedback =
      score !== null
        ? score === 1
          ? 'Task assertion passed'
          : 'Task assertion failed'
        : 'Evaluation evidence unavailable'
    const cell: Evidence = {
      candidate_id: request.operation.candidate_id!,
      task_id: String(trial.task_id),
      repetition,
      score: score as number | null,
      status:
        score !== null
          ? ('valid' as const)
          : /verifier|reward|scor/i.test(reason)
            ? ('scoring_failed' as const)
            : ('environment_failed' as const),
      scope: request.operation.scope,
      ...(request.metrics
        ? {
            raw_metrics: extractRawMetrics({
              contracts: request.metrics,
              trial: raw,
              certified: score !== null,
              identity: {
                taskId: String(trial.task_id),
                repetition,
                runId: String(trial.run_id),
                attempt: 1,
                harnessCommit: request.operation.candidate_id!,
                conditionDigest: canonicalDigest([request.runId, request.partition]),
                originalArtifactRefs: [
                  canonicalDigest(trial),
                  ...(verifier?.observation.source_digest ? [verifier.observation.source_digest] : []),
                ],
              },
            }).metrics,
          }
        : {}),
      ...(request.assertions?.length
        ? {
            assertions: builtinPolicy<AssertionEvidence[]>('assertions_extract', {
              contracts: request.assertions,
              trial: raw,
              certified: score !== null,
              evidence_refs: [
                canonicalDigest(trial),
                ...(verifier?.observation.source_digest ? [verifier.observation.source_digest] : []),
              ],
            }),
          }
        : {}),
      ...(verifier ? { verifier: verifier.observation } : {}),
      feedback: builtinPolicy<string>('verifier_feedback', {
        feedback,
        verifier: verifier?.observation ?? null,
      }),
    }
    return builtinPolicy<Evidence>('verifier_bind', {
      evidence: cell,
      metrics: request.metrics ?? [],
      assertions: request.assertions ?? [],
    })
  })
  if (failure)
    for (const taskId of taskIds) {
      if (evidence.some((cell) => cell.task_id === taskId)) continue
      evidence.push({
        candidate_id: request.operation.candidate_id!,
        task_id: taskId,
        repetition,
        score: null,
        status: 'environment_failed',
        scope: request.operation.scope,
        feedback: `Hitch evaluation ${failure.status}: ${failure.code}`,
      })
    }
  // Keep the complete original provider result in the operator-only receipt.
  return { evidence, provenance: result as Json }
}
