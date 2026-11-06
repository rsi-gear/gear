import { expect, it } from 'vitest'
import { CodexUsage } from '../../src/adapters/codex/usage.js'

const complete = (meter: CodexUsage, usage?: Record<string, number | null>) =>
  meter.record(JSON.stringify({ type: 'turn.completed', usage }))
const measured = { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 }

it('aggregates full native turns without counting turns as model requests', () => {
  const meter = new CodexUsage()
  meter.record(JSON.stringify({ type: 'turn.started' }))
  complete(meter, measured)
  complete(meter, measured)
  expect(meter.result(true)).toEqual({ input_tokens: 24, cached_input_tokens: 6, output_tokens: 14,
    tokens: 38, model_requests: null, dollars: null })
})

it.each([false, true])('keeps missing fields unknown even when other turns are measured, missing-first=%s', first => {
  const meter = new CodexUsage()
  for (const usage of first ? [{ output_tokens: 2 }, measured] : [measured, { output_tokens: 2 }])
    complete(meter, usage)
  expect(meter.result(true)).toMatchObject({ input_tokens: null, cached_input_tokens: null, output_tokens: 9, tokens: null })
  complete(meter, measured)
  expect(meter.result(true).input_tokens).toBeNull()
})

it.each(['absent', 'unfinished', 'failed', 'error', 'interrupted', 'malformed'])('does not publish partial totals after %s metering', kind => {
  const meter = new CodexUsage()
  complete(meter, measured)
  if (kind === 'absent') complete(meter)
  if (kind === 'unfinished') meter.record(JSON.stringify({ type: 'turn.started' }))
  if (kind === 'failed') meter.record(JSON.stringify({ type: 'turn.failed' }))
  if (kind === 'error') meter.record(JSON.stringify({ type: 'error' }))
  if (kind === 'malformed') meter.record('invalid-json-event')
  expect(Object.values(meter.result(kind !== 'interrupted'))).toEqual([null, null, null, null, null, null])
})

it('retains explicit zeros but not malformed, inconsistent or overflowing native counters', () => {
  const zero = new CodexUsage()
  complete(zero, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })
  expect(zero.result(true).tokens).toBe(0)
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const meter = new CodexUsage()
    complete(meter, { ...measured, input_tokens: value })
    expect(meter.result(true).input_tokens).toBeNull()
  }
  const overflow = new CodexUsage()
  complete(overflow, { ...measured, input_tokens: Number.MAX_SAFE_INTEGER })
  complete(overflow, measured)
  expect(overflow.result(true).input_tokens).toBeNull()
  const inconsistent = new CodexUsage()
  complete(inconsistent, { ...measured, cached_input_tokens: 13 })
  expect(inconsistent.result(true).tokens).toBeNull()
  expect(new CodexUsage().result(true).tokens).toBeNull()
})
