import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureGepaBudgetCut, firstGepaBudgetFailure } from '../../src/algorithm/recipes/gepa-budget.js'
import { seal } from '../../src/search/contracts.js'
import { SearchBudgetExceeded, zeroUsage, type Ledger, type Operation, type Usage } from '../../src/search/store.js'
import { MemorySearchStore, settings } from '../../src/search/testing.js'

const roundId = 'current'
const now = 10_000
let nextKey = 0
const budgets = () => structuredClone(settings().budgets)
const delta = () => ({ spent: zeroUsage(), reserved: zeroUsage() })
const cellCost = (cells: number): Usage => ({ ...zeroUsage(), cells })
const op = (key: string, operationRoundId: string, reserved: Usage, actual?: Usage): Operation => ({
  key, roundId: operationRoundId, requestDigest: 'sha256:' + 'a'.repeat(64), reserved,
  status: actual ? 'complete' : 'reserved', ...(actual ? { actual, outputDigest: 'sha256:' + 'b'.repeat(64) } : {}),
})

async function ledger(store: MemorySearchStore, operations: Operation[], startedAt = now - 100): Promise<void> {
  await store.write('budget', seal({ startedAt, operations }))
}

async function oldFailure(store: MemorySearchStore, cost: Usage, limits: ReturnType<typeof budgets>,
  roundStartedAt = now - 100): Promise<string | null> {
  try {
    await store.reserve(roundId, `key-${++nextKey}`, { roundId }, cost, limits, roundStartedAt)
    return null
  } catch (error) {
    if (!(error instanceof SearchBudgetExceeded)) throw error
    return error.resource
  }
}

async function compare(store: MemorySearchStore, cost: Usage, limits = budgets(),
  roundStartedAt = now - 100, campaignDelta = delta()): Promise<void> {
  const cut = await captureGepaBudgetCut(store, roundId, limits)
  const actual = firstGepaBudgetFailure({ cut, delta: campaignDelta, cost, roundStartedAt, now })
  expect(actual).toBe(await oldFailure(store, cost, limits, roundStartedAt))
}

afterEach(() => vi.restoreAllMocks())

describe('GEPA legacy two-layer reservation compatibility', () => {
  it('captures the admitted Ledger read-only, charging actual for completed and reservation for pending operations', async () => {
    const store = new MemorySearchStore()
    await ledger(store, [op('held', roundId, cellCost(3)), op('settled', roundId, cellCost(5), cellCost(1)),
      op('other', 'older', cellCost(2))])
    const before = store.checkpoint()
    const cut = await captureGepaBudgetCut(store, roundId, budgets())
    expect(cut.round.used.cells).toBe(4)
    expect(cut.evolution.used.cells).toBe(6)
    expect(cut.evolutionStartedAt).toBe(now - 100)
    expect(store.checkpoint()).toEqual(before)
    expect(() => firstGepaBudgetFailure({ cut: { ...cut, roundId: 'changed' }, delta: delta(),
      cost: cellCost(0), roundStartedAt: now - 100, now })).toThrow('digest')
  })

  it('reports round before evolution even when both fail', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 2
    limits.evolution.maxNewRolloutCells = 1
    await ledger(store, [op('existing', roundId, cellCost(1))])
    await compare(store, cellCost(2), limits)
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: cellCost(2), roundStartedAt: now - 100, now }))
      .toBe('round.cells')
  })

  it('reports evolution exhaustion after an available round quota', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 10
    limits.evolution.maxNewRolloutCells = 3
    await ledger(store, [op('older', 'older', cellCost(2))])
    await compare(store, cellCost(2), limits)
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: cellCost(2), roundStartedAt: now - 100, now }))
      .toBe('evolution.cells')
  })

  it('preserves the old cost object resource order within each layer', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 0
    limits.round.maxRepairCells = 0
    const cost: Usage = { repairCells: 1, cells: 1, diagnosisInputTokens: 0,
      diagnosisOutputTokens: 0, generationTokens: 0, generationRequests: 0 }
    await compare(store, cost, limits)
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost, roundStartedAt: now - 100, now }))
      .toBe('round.repairCells')
  })

  it.each([['generationTokens', 'maxGenerationTokens'], ['generationRequests', 'maxGenerationRequests']] as const)(
    'keeps omitted %s limits null but treats explicit zero as a bound', async (resource, setting) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const store = new MemorySearchStore()
      const limits = budgets()
      delete limits.round[setting]
      delete limits.evolution[setting]
      const cost: Usage = { ...zeroUsage(), [resource]: 1_000_000 }
      const cut = await captureGepaBudgetCut(store, roundId, limits)
      expect(cut.round.limit[resource]).toBeNull()
      expect(cut.evolution.limit[resource]).toBeNull()
      await compare(store, cost, limits)

      const explicit = budgets()
      explicit.round[setting] = 0
      await compare(new MemorySearchStore(), { ...zeroUsage(), [resource]: 1 }, explicit)
      const bounded = await captureGepaBudgetCut(new MemorySearchStore(), roundId, explicit)
      expect(firstGepaBudgetFailure({ cut: bounded, delta: delta(), cost: { ...zeroUsage(), [resource]: 1 },
        roundStartedAt: now - 100, now })).toBe(`round.${resource}`)
    })

  it('accepts zero cost, including zero limits, while old reserve starts its clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round = { ...limits.round, maxNewRolloutCells: 0, maxRepairCells: 0,
      maxDiagnosisInputTokens: 0, maxDiagnosisOutputTokens: 0, maxGenerationTokens: 0, maxGenerationRequests: 0 }
    limits.evolution = { ...limits.round }
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(cut.evolutionStartedAt).toBeNull()
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(), roundStartedAt: now, now })).toBeNull()
    await store.reserve(roundId, 'zero', {}, zeroUsage(), limits, now)
    expect((await store.read<Ledger>('budget'))?.startedAt).toBe(now)
  })

  it('checks time before resource quota, including an existing evolution clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 0
    limits.round.timeoutMs = 100
    await compare(store, cellCost(1), limits, now - 101)
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: cellCost(1), roundStartedAt: now - 101, now })).toBe('time')

    const evolutionStore = new MemorySearchStore()
    const other = budgets()
    other.evolution.timeoutMs = 50
    await ledger(evolutionStore, [], now - 51)
    await compare(evolutionStore, zeroUsage(), other)
  })

  it('starts a first reservation when only the admission-based evolution timer has expired', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.timeoutMs = 1_000
    limits.evolution.timeoutMs = 50
    const roundStartedAt = now - 100
    // The old search deadline signal is already aborted (admission + 50), but
    // SearchJournal.reserve creates a fresh evolution ledger at its first call.
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(cut.evolutionStartedAt).toBeNull()
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(), roundStartedAt, now })).toBeNull()
    await compare(store, zeroUsage(), limits, roundStartedAt)
    expect((await store.read<Ledger>('budget'))?.startedAt).toBe(now)
  })

  it('uses the durable first Campaign reservation clock for later evolution timeouts', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.timeoutMs = 1_000
    limits.evolution.timeoutMs = 50
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(),
      roundStartedAt: now, now })).toBeNull()
    await store.reserve(roundId, 'first', {}, zeroUsage(), limits, now)
    clock.mockReturnValue(now + 51)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(),
      roundStartedAt: now, campaignBudgetStartedAt: now, now: now + 51 })).toBe('time')
    expect(await oldFailure(store, zeroUsage(), limits, now)).toBe('time')
    expect(() => firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(),
      roundStartedAt: now, campaignBudgetStartedAt: -1, now: now + 51 })).toThrow('Campaign budget clock')
  })

  it('prefers an existing legacy evolution ledger clock over a later Campaign clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.timeoutMs = 1_000
    limits.evolution.timeoutMs = 50
    await ledger(store, [], now - 100)
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: zeroUsage(),
      roundStartedAt: now - 100, campaignBudgetStartedAt: now - 10, now })).toBe('time')
    expect(await oldFailure(store, zeroUsage(), limits)).toBe('time')
  })

  it('adds Campaign confirmed spend and live unaccounted reservation without re-reading the frozen cut', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 5
    limits.evolution.maxNewRolloutCells = 6
    await ledger(store, [op('prior', roundId, cellCost(1))])
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    const campaignDelta = { spent: cellCost(2), reserved: cellCost(1) }
    const failure = firstGepaBudgetFailure({ cut, delta: campaignDelta, cost: cellCost(2), roundStartedAt: now - 100, now })
    expect(failure).toBe('round.cells')
    const saved = await store.read<Ledger>('budget')
    await ledger(store, [...saved!.operations, op('spent', roundId, cellCost(2), cellCost(2)),
      op('live', roundId, cellCost(1))], saved!.startedAt)
    expect(await oldFailure(store, cellCost(2), limits)).toBe(failure)
    // The new synthetic projection is mutable; resume must keep the original cut.
    expect(cut.round.used.cells).toBe(1)
  })

  it('rejects an invalid new reservation only after the prior resource checks, like the old journal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = new MemorySearchStore()
    const limits = budgets()
    limits.round.maxNewRolloutCells = 0
    const invalid = { ...zeroUsage(), cells: 1, repairCells: -1 }
    const cut = await captureGepaBudgetCut(store, roundId, limits)
    expect(firstGepaBudgetFailure({ cut, delta: delta(), cost: invalid, roundStartedAt: now - 100, now })).toBe('round.cells')
    expect(await oldFailure(store, invalid, limits)).toBe('round.cells')
  })
})
