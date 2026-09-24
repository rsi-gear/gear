import type { CampaignState } from '../runtime/engine.js'
import { canonicalJson } from '../schema.js'
import { digestJson } from '../../state/digest.js'
import { seal, verifyDigest } from '../../search/contracts.js'
import type { Ledger, Operation, SearchJournal, Usage } from '../../search/store.js'

const dimensions = {
  cells: 'rolloutCells', repairCells: 'repairCells',
  diagnosisInputTokens: 'diagnosisInputTokens', diagnosisOutputTokens: 'diagnosisOutputTokens',
  generationTokens: 'generationTokens', generationRequests: 'generationRequests',
} as const satisfies Record<keyof Usage, string>

function campaignUsage(state: CampaignState): { spent: Usage; held: Usage } {
  const spent = {} as Usage, held = {} as Usage
  const auxiliary = Object.values(state.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))
  const operations = [...Object.values(state.operations), ...auxiliary]
  for (const [resource, dimension] of Object.entries(dimensions) as Array<[keyof Usage, string]>) {
    spent[resource] = state.spent[dimension] ?? 0
    held[resource] = 0
    for (const operation of operations) {
      if (operation.released) continue
      held[resource] += Math.max(0, (operation.envelope.limits[dimension] ?? 0) - (operation.accounted[dimension] ?? 0))
    }
    if (!Number.isSafeInteger(spent[resource]) || spent[resource] < 0 || !Number.isSafeInteger(held[resource]) || held[resource] < 0)
      throw new Error(`Invalid Campaign budget projection: ${resource}`)
  }
  return { spent, held }
}

/** Compatibility view of the Campaign's authoritative cumulative ledger. Never reserves or settles a second budget. */
export async function projectGepaCampaignBudget(journal: SearchJournal, roundId: string,
  state: CampaignState, admissionStartedAt: number): Promise<Ledger | null> {
  if (!/^[A-Za-z0-9_-]+$/u.test(roundId) || !Number.isSafeInteger(admissionStartedAt) || admissionStartedAt < 0)
    throw new Error('Invalid GEPA budget projection identity')
  const config = state.spec.config as { request?: { roundId?: string } } | undefined
  if (config?.request?.roundId !== roundId) throw new Error('GEPA Campaign/round budget identity mismatch')
  const existing = await journal.read<Ledger>('budget')
  if (existing) verifyDigest(existing)
  const key = digestJson(['campaign-budget-projection-v1', roundId])
  const previous = existing?.operations.find(item => item.key === key)
  // Admission and an unsubmitted intent never start the old SearchJournal clock.
  // Keep another round's ledger intact while this round has not reserved work.
  if (state.budgetStartedAt === undefined) {
    const { spent } = campaignUsage(state)
    if ((Object.keys(spent) as Array<keyof Usage>).some(resource => spent[resource] > 0))
      throw new Error('GEPA mapped spending without a Campaign budget clock')
    if (previous) throw new Error('GEPA budget projection clock missing from Campaign')
    return existing ?? null
  }
  if (!Number.isSafeInteger(state.budgetStartedAt) || state.budgetStartedAt < 0)
    throw new Error('Invalid Campaign budget clock timestamp')
  const { spent, held } = campaignUsage(state)
  const reserved = {} as Usage
  for (const resource of Object.keys(dimensions) as Array<keyof Usage>) {
    reserved[resource] = spent[resource] + held[resource]
    if (!Number.isSafeInteger(reserved[resource])) throw new Error(`GEPA projected usage exceeds safe integer: ${resource}`)
  }
  const pending = (Object.keys(held) as Array<keyof Usage>).some(resource => held[resource] > 0)
  const operation: Operation = { key, roundId, requestDigest: digestJson(state.spec), reserved,
    status: pending ? 'reserved' : 'complete',
    ...(!pending ? { actual: spent, outputDigest: digestJson(state) } : {}) }
  if (previous && (previous.roundId !== roundId || previous.requestDigest !== operation.requestDigest))
    throw new Error('GEPA budget projection conflicts with frozen Campaign identity')
  const ledger = seal({ startedAt: existing?.startedAt ?? state.budgetStartedAt,
    operations: [...(existing?.operations ?? []).filter(item => item.key !== key), operation] }) as Ledger
  if (existing?.digest !== ledger.digest) {
    try { await journal.write('budget', ledger) }
    catch (error) {
      const observed = await journal.read<Ledger>('budget')
      if (!observed) throw error
      verifyDigest(observed)
      if (canonicalJson(observed) !== canonicalJson(ledger)) throw error
    }
  }
  return ledger
}
