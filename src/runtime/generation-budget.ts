import { GearError } from '../domain/errors.js'
import {
  generationMetrics,
  type GenerationLimits,
  type GenerationMetric,
} from '../domain/generation-budget.js'
import type { JournalOperation, RunJournal } from '../domain/run.js'
import type { OperationReceipt } from '../ports/operations.js'

export function isGeneration(kind: string): boolean {
  return kind === 'diagnose_seed' || kind === 'generate_candidate'
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function safe(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}
function accounting(journal: RunJournal, metric: GenerationMetric) {
  let accounted = 0n,
    reserved = 0n,
    unknown = 0,
    unbounded = false
  for (const operation of journal.operations.filter((item) => isGeneration(item.request.operation.kind))) {
    const receipt = operation.generationViolation?.receipt ?? operation.receipt
    const value = receipt?.usage[metric]
    const allowance = operation.request.generationLimits?.[metric]
    // Once metering contradicts itself, the reservation is no longer a proven upper bound.
    if (operation.generationViolation) unbounded = true
    if (operation.status === 'complete' && counter(value) && !operation.generationViolation) {
      accounted += BigInt(value)
    } else {
      if (allowance === undefined) unbounded = true
      const held = BigInt(allowance ?? 0)
      // A metering violation is retained as evidence, never rounded down to the allowance.
      accounted += counter(value) && BigInt(value) > held ? BigInt(value) : held
      if (operation.status !== 'complete') reserved += held
      if (operation.status !== 'reserved') unknown++
    }
  }
  return { accounted, reserved, unknown, unbounded }
}

export function generationLedger(journal: RunJournal) {
  const violated = journal.operations.some((operation) => operation.generationViolation)
  const metrics = Object.fromEntries(
    generationMetrics.map((metric) => {
      const total = journal.spec.generationBudget.total[metric]
      const current = accounting(journal, metric)
      const remaining =
        total === undefined
          ? null
          : violated
            ? 0
            : Number(BigInt(total) > current.accounted ? BigInt(total) - current.accounted : 0n)
      return [
        metric,
        {
          limit: total ?? null,
          accounted_upper_bound: current.unbounded ? null : safe(current.accounted),
          reserved_upper_bound: current.unbounded ? null : safe(current.reserved),
          unknown_operations: current.unknown,
          remaining,
        },
      ]
    }),
  ) as Record<
    GenerationMetric,
    {
      limit: number | null
      accounted_upper_bound: number | null
      reserved_upper_bound: number | null
      unknown_operations: number
      remaining: number | null
    }
  >
  const capacities = generationMetrics.flatMap((metric) => {
    const remaining = metrics[metric].remaining
    if (remaining === null) return []
    const cap = Math.min(journal.spec.generationBudget.perOperation[metric] ?? remaining, remaining)
    return [cap ? Number(BigInt(remaining) / BigInt(cap)) : 0]
  })
  return {
    scope: 'diagnosis-and-generation' as const,
    policy: journal.spec.generationBudget,
    metrics,
    batch_capacity: violated ? 0 : capacities.length ? Math.min(...capacities) : null,
  }
}

/** One maximum allowance; the complete batch must fit before any operation commits. */
export function reserveGeneration(journal: RunJournal): GenerationLimits | undefined {
  const ledger = generationLedger(journal)
  const result: GenerationLimits = {}
  for (const metric of generationMetrics) {
    const remaining = ledger.metrics[metric].remaining
    if (remaining === 0)
      throw new GearError('generation-budget-exhausted', `No ${metric} remain for diagnosis or generation`)
    const maximum = journal.spec.generationBudget.perOperation[metric] ?? remaining
    if (maximum !== null) result[metric] = remaining === null ? maximum : Math.min(maximum, remaining)
  }
  return Object.keys(result).length ? result : undefined
}

export function validateGenerationReservations(journal: RunJournal, extra: JournalOperation[] = []): void {
  const policy = journal.spec.generationBudget
  for (const operation of [...journal.operations, ...extra]) {
    if (operation.generationViolation)
      throw new GearError(
        'generation-budget-violation',
        'A provider violated a frozen generation allowance; no further work can be submitted',
      )
    const limits = operation.request.generationLimits
    if (!isGeneration(operation.request.operation.kind)) {
      if (limits !== undefined)
        throw new GearError(
          'invalid-generation-reservation',
          'Generation allowance attached to a non-Meta operation',
        )
      continue
    }
    if (
      limits !== undefined &&
      (!limits ||
        typeof limits !== 'object' ||
        Array.isArray(limits) ||
        Object.keys(limits).some((key) => !generationMetrics.includes(key as GenerationMetric)))
    )
      throw new GearError('invalid-generation-reservation', 'Invalid generation allowance')
    for (const metric of generationMetrics) {
      const required = policy.total[metric] !== undefined || policy.perOperation[metric] !== undefined
      const value = limits?.[metric]
      if (
        !required
          ? value !== undefined
          : !counter(value) ||
            value < 1 ||
            value > Math.min(policy.total[metric] ?? Infinity, policy.perOperation[metric] ?? Infinity)
      )
        throw new GearError(
          'invalid-generation-reservation',
          `Generation allowance does not match frozen ${metric} policy`,
        )
    }
  }
  for (const metric of generationMetrics) {
    const total = policy.total[metric]
    if (
      total !== undefined &&
      accounting({ ...journal, operations: [...journal.operations, ...extra] }, metric).accounted >
        BigInt(total)
    )
      throw new GearError(
        'generation-budget-exhausted',
        `Insufficient ${metric} for the complete operation batch`,
      )
  }
}

export function generationReceiptViolation(
  operation: JournalOperation,
  receipt: OperationReceipt,
): string | null {
  if (!isGeneration(operation.request.operation.kind)) return null
  for (const metric of generationMetrics) {
    const value = receipt.usage[metric]
    if (value === undefined || value === null) continue
    if (!counter(value)) return `Invalid ${metric} counter`
    const limit = operation.request.generationLimits?.[metric]
    if (limit !== undefined && value > limit) return `${metric} exceeded the reserved allowance`
  }
  for (const metric of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    const value = receipt.usage[metric]
    if (value !== undefined && value !== null && !counter(value)) return `Invalid ${metric} counter`
  }
  const {
    tokens,
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    model_requests: requests,
  } = receipt.usage
  if (
    counter(tokens) &&
    counter(input) &&
    counter(output) &&
    BigInt(tokens) !== BigInt(input) + BigInt(output)
  )
    return 'Total tokens do not match input plus output tokens'
  if (counter(cached) && counter(input) && cached > input) return 'Cached tokens exceed input tokens'
  const knownInput = Math.max(counter(input) ? input : 0, counter(cached) ? cached : 0)
  const knownMinimum = BigInt(knownInput) + BigInt(counter(output) ? output : 0)
  if (counter(tokens) && BigInt(tokens) < knownMinimum) return 'Total tokens are below known token components'
  const tokenLimit = operation.request.generationLimits?.tokens
  if (tokenLimit !== undefined && knownMinimum > BigInt(tokenLimit))
    return 'Known token components exceeded the reserved allowance'
  if (requests === 0 && [tokens, input, output, cached].some((value) => counter(value) && value > 0))
    return 'Token usage contradicts zero model requests'
  return null
}
