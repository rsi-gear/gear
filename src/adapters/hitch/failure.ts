import type { Json } from '../../domain/algorithm-wire.js'

export interface HitchEvaluationFailure {
  eval_id: string | null
  code: string
  message: string
  status: 'failed' | 'cancelled'
  failure_stage: string | null
}

/** A terminal error can explain missing slots; an incomplete or successful result cannot. */
export function hitchEvaluationFailure(result: Record<string, unknown>): HitchEvaluationFailure | null {
  if (!['failed', 'cancelled'].includes(String(result.status)) || result.task_completed !== true) return null
  const error = result.error as Record<string, unknown> | undefined
  if (
    !error ||
    typeof error.code !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,127}$/u.test(error.code) ||
    typeof error.message !== 'string' ||
    !error.message.trim()
  )
    return null
  return {
    eval_id: typeof result.eval_id === 'string' ? result.eval_id : null,
    status: result.status as 'failed' | 'cancelled',
    code: error.code,
    message: error.message.slice(0, 4096),
    failure_stage: typeof result.failure_stage === 'string' ? result.failure_stage : null,
  }
}

export function failureData(failures: HitchEvaluationFailure[]): Json {
  return failures.length ? { errors: failures.map((failure) => ({ ...failure })) } : null
}
