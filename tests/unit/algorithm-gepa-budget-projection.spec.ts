import { describe, expect, it } from 'vitest'
import { projectGepaCampaignBudget } from '../../src/algorithm/providers/gepa-budget-projection.js'
import type { CampaignState } from '../../src/algorithm/runtime/engine.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import type { BudgetLimits } from '../../src/search/types.js'

const limits: BudgetLimits = { maxNewRolloutCells: 100, maxRepairCells: 10,
  maxDiagnosisInputTokens: 1000, maxDiagnosisOutputTokens: 100,
  timeoutMs: 60000 }

function state(roundId: string, cells: number, heldCells = 0): CampaignState {
  return { spec: { campaignId: `search-${roundId}`, config: { request: { roundId } } }, spent: { rolloutCells: cells },
    operations: heldCells ? { active: { released: false, accounted: { rolloutCells: 2 },
      envelope: { limits: { rolloutCells: heldCells + 2 } } } } : {},
    auxiliaryOperations: heldCells ? { repair: { pending: { released: false, accounted: {},
      envelope: { limits: { repairCells: 2 } } } } } : {},
  } as unknown as CampaignState
}

describe('GEPA Campaign budget compatibility projection', () => {
  it('projects cumulative spent and unreleased main/aux reservations without a second reserve', async () => {
    const journal = new MemorySearchStore()
    await projectGepaCampaignBudget(journal, 'r1', state('r1', 20, 5), 1000)
    const first = await journal.remaining('r1', { round: limits, evolution: limits })
    expect(first.cells).toBe(75)
    expect(first.repairCells).toBe(8)
    expect(first.generationTokens).toBeNull()
    const checkpoint = journal.checkpoint()
    const resumed = new MemorySearchStore(checkpoint)
    await projectGepaCampaignBudget(resumed, 'r1', state('r1', 25), 1000)
    expect((await resumed.remaining('r1', { round: limits, evolution: limits })).cells).toBe(75)
    await projectGepaCampaignBudget(resumed, 'r1', state('r1', 25), 1000)
    expect((await resumed.read<{ operations: unknown[] }>('budget'))?.operations).toHaveLength(1)
    await projectGepaCampaignBudget(resumed, 'r2', state('r2', 10), 2000)
    const second = await resumed.remaining('r2', { round: limits, evolution: limits })
    expect(second.cells).toBe(65)
    expect((await resumed.remaining('r1', { round: limits, evolution: limits })).cells).toBe(65)
    expect((await resumed.read<{ operations: unknown[] }>('budget'))?.operations).toHaveLength(2)
  })
})
