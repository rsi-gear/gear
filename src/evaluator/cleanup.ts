import type { EvaluationFailure, FailedEvaluationEvidence } from '../types.js'

export function evaluationFailure(error: unknown): EvaluationFailure {
  return {
    code: typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code : 'evaluation_failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Keep the primary failure's code, message and evidence; report cleanup separately. */
export class EvaluationCleanupError extends Error {
  readonly code: string
  readonly cleanupFailure: EvaluationFailure
  readonly failedEvidence?: FailedEvaluationEvidence

  constructor(error: unknown, cleanupError: unknown) {
    const failure = evaluationFailure(error)
    super(failure.message, { cause: error })
    this.name = 'EvaluationCleanupError'
    this.code = failure.code
    this.cleanupFailure = evaluationFailure(cleanupError)
    const evidence = (error as { failedEvidence?: FailedEvaluationEvidence } | null)?.failedEvidence
    if (evidence !== undefined) this.failedEvidence = evidence
  }
}
