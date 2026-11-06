import { expect, it } from 'vitest'
import { aggregateUsage } from '../../src/domain/usage.js'

const complete = (usage: Record<string, number | null>) => ({ status: 'complete' as const, receipt: { usage } })

it('does not turn an omitted metric in one completed operation into zero', () => {
  const target = complete({ model_requests: 3, tokens: 150, dollars: 0.2 })
  const diagnosis = complete({ input_tokens: 30, output_tokens: 10, dollars: null })
  for (const operations of [[target, diagnosis], [diagnosis, target]])
    expect(aggregateUsage(operations)).toEqual({
      model_requests: null, tokens: null, input_tokens: null, cached_input_tokens: null,
      output_tokens: null, dollars: null,
    })
})

it('retains known zeros and separates quoted estimates from unknown bills', () => {
  expect(aggregateUsage([
    complete({ model_requests: 0, tokens: 0, dollars: null, estimated_dollars: 0 }),
    complete({ model_requests: 1, tokens: 40, dollars: null, estimated_dollars: 0.2 }),
  ])).toMatchObject({ model_requests: 1, tokens: 40, dollars: null, estimated_dollars: 0.2 })
  expect(aggregateUsage([complete({ model_requests: 0 }), complete({ model_requests: 0 })]).model_requests).toBe(0)
})

it('keeps potentially executed submissions unknown while unsubmitted reservations cost zero', () => {
  const measured = complete({ model_requests: 1, tokens: 40, dollars: 0.2 })
  expect(aggregateUsage([measured, { status: 'reserved' }])).toMatchObject({ model_requests: 1, tokens: 40, dollars: 0.2 })
  expect(aggregateUsage([measured, { status: 'submitted' }])).toMatchObject({ model_requests: null, tokens: null, dollars: null })
  expect(aggregateUsage([{ status: 'complete' }]).model_requests).toBeNull()
  expect(Object.values(aggregateUsage([]))).toEqual([0, 0, 0, 0, 0, 0])
})

it('does not publish invalid or overflowing counters as measured totals', () => {
  for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(aggregateUsage([complete({ tokens: value })]).tokens).toBeNull()
  expect(aggregateUsage([complete({ tokens: Number.MAX_SAFE_INTEGER }), complete({ tokens: 1 })]).tokens).toBeNull()
  expect(aggregateUsage([complete({ dollars: Number.MAX_VALUE }), complete({ dollars: Number.MAX_VALUE })]).dollars).toBeNull()
})
