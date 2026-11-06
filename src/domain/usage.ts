import type { JournalOperation } from './run.js'
import type { OperationReceipt } from './algorithm-wire.js'

const counts = new Set(['model_requests', 'tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens'])
const standardMetrics = [...counts, 'dollars']
type UsageRecord = Pick<JournalOperation, 'status'> & { receipt?: Pick<OperationReceipt, 'usage'> }

function observed(metric: string, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!counts.has(metric) || Number.isSafeInteger(value))
  )
}

/** Account for every potentially executed operation; absent metering is never zero. */
export function aggregateUsage(operations: readonly UsageRecord[]): Record<string, number | null> {
  // A reserved operation has not crossed the durable submission boundary yet.
  const executed = operations.filter((operation) => operation.status !== 'reserved')
  const metrics = new Set([
    ...standardMetrics,
    ...executed.flatMap((operation) => Object.keys(operation.receipt?.usage ?? {})),
  ])
  return Object.fromEntries(
    [...metrics].sort().map((metric) => {
      let total = 0
      for (const operation of executed) {
        const value = operation.status === 'complete' ? operation.receipt?.usage[metric] : undefined
        if (!observed(metric, value) || !observed(metric, total + value)) return [metric, null]
        total += value
      }
      return [metric, total]
    }),
  )
}
