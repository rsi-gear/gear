import { GearError } from './errors.js'
import type { ProviderCapabilities } from '../ports/operations.js'

export function requireEvaluationCapabilities(capabilities: ProviderCapabilities): void {
  if (!capabilities.inspect || !capabilities.physicalAttemptAccounting || !capabilities.subsets)
    throw new GearError(
      'provider-capability-missing',
      'Provider must inspect submissions, meter physical attempts and evaluate exact subsets',
    )
}

export interface EvaluationRepairPolicy {
  /** Additional executions after the original attempt; zero disables execution repair. */
  maxRetries: number
  /** Read-only projections from original artifacts; never additional target executions. */
  maxProjections: number
  backoffMs: number[]
}

export function evaluationRepairPolicy(input?: EvaluationRepairPolicy): EvaluationRepairPolicy {
  const policy = input ?? { maxRetries: 2, maxProjections: 2, backoffMs: [15_000, 60_000] }
  if (
    !Number.isSafeInteger(policy.maxRetries) ||
    policy.maxRetries < 0 ||
    !Number.isSafeInteger(policy.maxProjections) ||
    policy.maxProjections < 0 ||
    !Array.isArray(policy.backoffMs) ||
    !policy.backoffMs.length ||
    policy.backoffMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 2 ** 31 - 1)
  )
    throw new GearError(
      'invalid-evaluation-repair',
      'Repair needs nonnegative retry and projection counts, and backoff delays between 0 and 2147483647 ms',
    )
  return structuredClone(policy)
}
