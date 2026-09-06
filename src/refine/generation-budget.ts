import type { CandidateGenerationBudgetStatus } from '../types.js'

export function generationBudgetSnapshot(
  value: CandidateGenerationBudgetStatus,
  timestamp = Date.now(),
): CandidateGenerationBudgetStatus {
  const roundRemainingMs = Math.max(0, value.roundDeadlineAt - timestamp)
  const remainingMs = Math.max(0, Math.min(value.deadlineAt - timestamp, roundRemainingMs))
  return { ...value, remainingMs, roundRemainingMs,
    diagnosisAvailableMs: Math.max(0, remainingMs - value.finalizationReserveMs) }
}
