import type { ProviderDispatchContext } from '../contracts.js'
import { firstGepaBudgetFailure, type GepaBudgetCut, type GepaBudgetFailure } from '../recipes/gepa-budget.js'
import { seal, verifyDigest } from '../../search/contracts.js'
import { zeroUsage, type Usage } from '../../search/store.js'
import { ProviderProtocolError } from '../provider-errors.js'

export type GepaAuxBudgetInput = { budgetCut?: GepaBudgetCut; roundStartedAt?: number }
export type GepaAuxBudgetDecision = { digest: string; cost: Usage; failure: GepaBudgetFailure | null }

export function checkedAuxBudget(input: GepaAuxBudgetInput, roundId: string):
  { cut: GepaBudgetCut; roundStartedAt: number } | undefined {
  if (input.budgetCut === undefined && input.roundStartedAt === undefined) return undefined
  if (!input.budgetCut || !Number.isSafeInteger(input.roundStartedAt) || input.roundStartedAt! < 0)
    throw new ProviderProtocolError('GEPA auxiliary budget admission is incomplete')
  verifyDigest(input.budgetCut)
  if (input.budgetCut.roundId !== roundId)
    throw new ProviderProtocolError('GEPA auxiliary budget admission round mismatch')
  return { cut: input.budgetCut, roundStartedAt: input.roundStartedAt! }
}

/** The Campaign ledger is authoritative; this only maps its frozen dispatch view to old resource names. */
export function auxBudgetDecision(input: GepaAuxBudgetInput, roundId: string,
  context: ProviderDispatchContext, cost: Usage): GepaAuxBudgetDecision {
  const budget = checkedAuxBudget(input, roundId)
  if (!budget) throw new ProviderProtocolError('GEPA auxiliary budget admission is missing')
  const dimensions = { cells: 'rolloutCells', repairCells: 'repairCells',
    diagnosisInputTokens: 'diagnosisInputTokens', diagnosisOutputTokens: 'diagnosisOutputTokens',
    generationTokens: 'generationTokens', generationRequests: 'generationRequests' } as const
  const spent = zeroUsage(), reserved = zeroUsage()
  for (const [resource, dimension] of Object.entries(dimensions) as Array<[keyof Usage, string]>) {
    spent[resource] = context.spent[dimension] ?? 0
    reserved[resource] = context.reservedExcludingSelf[dimension] ?? 0
    if (!Number.isSafeInteger(spent[resource]) || spent[resource] < 0
      || !Number.isSafeInteger(reserved[resource]) || reserved[resource] < 0)
      throw new ProviderProtocolError('GEPA auxiliary Campaign budget snapshot is invalid')
  }
  return seal({ cost, failure: firstGepaBudgetFailure({ cut: budget.cut,
    delta: { spent, reserved }, cost, roundStartedAt: budget.roundStartedAt,
    ...(context.budgetStartedAt === undefined ? {} : { campaignBudgetStartedAt: context.budgetStartedAt }),
    now: Date.now() }) })
}
