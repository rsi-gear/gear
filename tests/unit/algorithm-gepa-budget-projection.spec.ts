import { describe, expect, it } from 'vitest'
import { projectGepaCampaignBudget } from '../../src/algorithm/providers/gepa-budget-projection.js'
import type { CampaignState } from '../../src/algorithm/runtime/engine.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import type { BudgetLimits } from '../../src/search/types.js'

const limits: BudgetLimits = { maxNewRolloutCells: 100, maxRepairCells: 10,
  maxDiagnosisInputTokens: 1000, maxDiagnosisOutputTokens: 100,
  timeoutMs: 60000 }

function state(roundId: string, cells: number, heldCells = 0, budgetStartedAt?: number): CampaignState {
  return { spec: { campaignId: `search-${roundId}`, config: { request: { roundId } } }, spent: { rolloutCells: cells },
    ...(budgetStartedAt === undefined ? {} : { budgetStartedAt }),
    operations: heldCells ? { active: { released: false, accounted: { rolloutCells: 2 },
      envelope: { limits: { rolloutCells: heldCells + 2 } } } } : {},
    auxiliaryOperations: heldCells ? { repair: { pending: { released: false, accounted: {},
      envelope: { limits: { repairCells: 2 } } } } } : {},
  } as unknown as CampaignState
}

describe('GEPA Campaign budget compatibility projection', () => {
  it('projects cumulative spent and unreleased main/aux reservations without a second reserve', async () => {
    const journal = new MemorySearchStore()
    await projectGepaCampaignBudget(journal, 'r1', state('r1', 20, 5, 1000), 1000)
    const first = await journal.remaining('r1', { round: limits, evolution: limits })
    expect(first.cells).toBe(75)
    expect(first.repairCells).toBe(8)
    expect(first.generationTokens).toBeNull()
    const checkpoint = journal.checkpoint()
    const resumed = new MemorySearchStore(checkpoint)
    await projectGepaCampaignBudget(resumed, 'r1', state('r1', 25, 0, 1000), 1000)
    expect((await resumed.remaining('r1', { round: limits, evolution: limits })).cells).toBe(75)
    await projectGepaCampaignBudget(resumed, 'r1', state('r1', 25, 0, 1000), 1000)
    expect((await resumed.read<{ operations: unknown[] }>('budget'))?.operations).toHaveLength(1)
    await projectGepaCampaignBudget(resumed, 'r2', state('r2', 10, 0, 2000), 2000)
    const second = await resumed.remaining('r2', { round: limits, evolution: limits })
    expect(second.cells).toBe(65)
    expect((await resumed.remaining('r1', { round: limits, evolution: limits })).cells).toBe(65)
    expect((await resumed.read<{ operations: unknown[] }>('budget'))?.operations).toHaveLength(2)
  })

  it('does not create a ledger for admission or mutate another round before first dispatch', async () => {
    const journal = new MemorySearchStore()
    expect(await projectGepaCampaignBudget(journal, 'r1', state('r1', 0), 1000)).toBeNull()
    expect(await journal.read('budget')).toBeUndefined()
    await projectGepaCampaignBudget(journal, 'r1', state('r1', 0, 0, 1200), 1000)
    const before = await journal.read('budget')
    expect(await projectGepaCampaignBudget(journal, 'r2', state('r2', 0), 2000)).toEqual(before)
    expect(await journal.read('budget')).toEqual(before)
    await expect(projectGepaCampaignBudget(journal, 'r1', state('r1', 0), 1000))
      .rejects.toThrow('clock missing')
  })

  it('rejects metered Campaign spending if no operation started the legacy clock', async () => {
    const journal = new MemorySearchStore()
    await expect(projectGepaCampaignBudget(journal, 'r1', state('r1', 1), 1000))
      .rejects.toThrow('mapped spending without a Campaign budget clock')
    expect(await journal.read('budget')).toBeUndefined()
  })

  it('keeps the ledger byte-identical through scientific-only steps but writes every usage or status change', async () => {
    const journal = new MemorySearchStore()
    const originalWrite = journal.write.bind(journal)
    let budgetWrites = 0
    journal.write = async (name, value) => {
      if (name === 'budget') budgetWrites++
      return originalWrite(name, value)
    }
    const first = state('r1', 2, 3, 1000)
    const reserved = await projectGepaCampaignBudget(journal, 'r1', first, 1000)
    expect(budgetWrites).toBe(1)
    expect(reserved?.operations[0]?.status).toBe('reserved')
    const scientificOnly = { ...first, state: { phase: 'new-decision' }, decisionIndex: 7 } as CampaignState
    expect(await projectGepaCampaignBudget(journal, 'r1', scientificOnly, 1000)).toEqual(reserved)
    expect(budgetWrites).toBe(1)
    const settled = await projectGepaCampaignBudget(journal, 'r1', state('r1', 5, 0, 1000), 1000)
    expect(settled?.operations[0]?.status).toBe('complete')
    expect(settled?.operations[0]?.actual?.cells).toBe(5)
    expect(budgetWrites).toBe(2)
    expect(await projectGepaCampaignBudget(journal, 'r1', { ...state('r1', 5, 0, 1000),
      state: { phase: 'another-scientific-decision' } } as CampaignState, 1000)).toEqual(settled)
    expect(budgetWrites).toBe(2)
    await projectGepaCampaignBudget(journal, 'r1', state('r1', 6, 0, 1000), 1000)
    expect(budgetWrites).toBe(3)
  })

  it('reconciles a lost budget acknowledgement and still rejects a tampered ledger', async () => {
    const journal = new MemorySearchStore()
    const originalWrite = journal.write.bind(journal)
    let loseAck = true
    journal.write = async (name, value) => {
      await originalWrite(name, value)
      if (name === 'budget' && loseAck) { loseAck = false; throw new Error('budget acknowledgement lost') }
    }
    const value = await projectGepaCampaignBudget(journal, 'r1', state('r1', 3, 0, 1000), 1000)
    expect(value?.operations[0]?.actual?.cells).toBe(3)
    expect(await projectGepaCampaignBudget(journal, 'r1', state('r1', 3, 0, 1000), 1000)).toEqual(value)
    await originalWrite('budget', { ...value, digest: `sha256:${'0'.repeat(64)}` })
    await expect(projectGepaCampaignBudget(journal, 'r1', state('r1', 3, 0, 1000), 1000))
      .rejects.toThrow('immutable record digest mismatch')
  })
})
