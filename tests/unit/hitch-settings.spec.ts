import { expect, it } from 'vitest'
import { hitchSettings, evaluationWatchTimeoutMs } from '../../src/adapters/hitch/settings.js'

it('keeps legacy concurrency and accepts explicit capacity without an arbitrary task cap', () => {
  expect(hitchSettings({ timeoutMs: 1000 }).maxConcurrent).toBe(1)
  expect(hitchSettings({ timeoutMs: 1000, maxConcurrent: 256, preparationTimeoutMs: 2400000, setupTimeoutMs: 0 }))
    .toEqual({ maxConcurrent: 256, preparationTimeoutMs: 2400000, setupTimeoutMs: 0 })
  expect(hitchSettings({ timeoutMs: 86400000, setupTimeoutMs: 0 }).setupTimeoutMs).toBe(0)
})

it('rejects unsupported timers and invalid task/setup combinations before contacting Hitch', () => {
  for (const value of [{ maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { maxConcurrent: null },
    { preparationTimeoutMs: 2 ** 31 }, { preparationTimeoutMs: 0 }, { setupTimeoutMs: -1 },
    { timeoutMs: 86400000 }, { timeoutMs: Number.MAX_SAFE_INTEGER }]) {
    expect(() => hitchSettings({ timeoutMs: 1000, ...value } as Parameters<typeof hitchSettings>[0]))
      .toThrow(/Hitch requires|must be an integer/)
  }
})

it('allows every task its budget when actual daemon capacity is below requested concurrency', () => {
  const profile = { timeoutMs: 1000, setupTimeoutMs: 2000, preparationTimeoutMs: 5000, maxConcurrent: 16 }
  expect(evaluationWatchTimeoutMs(profile, 20)).toBeGreaterThanOrEqual(20 * 3000 + 5000)
  expect(evaluationWatchTimeoutMs(profile, Number.MAX_SAFE_INTEGER)).toBe(2 ** 31 - 1)
})
