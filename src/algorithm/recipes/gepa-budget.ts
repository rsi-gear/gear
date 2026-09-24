import { seal, verifyDigest, invariant } from '../../search/contracts.js'
import { usageLimit, zeroUsage, type Ledger, type RemainingBudget, type SearchJournal, type Usage } from '../../search/store.js'
import type { BudgetLimits } from '../../search/types.js'

export type GepaBudgetResource = keyof Usage
export type GepaBudgetFailure = 'time' | `round.${GepaBudgetResource}` | `evolution.${GepaBudgetResource}`

export interface GepaBudgetLayerCut {
  limit: RemainingBudget
  /** Existing old-ledger operations at admission: settled actual, otherwise reservation. */
  used: Usage
  timeoutMs: number
}

/** Capture once at new admission; resume reads the sealed cut, never the mutable projected ledger. */
export interface GepaBudgetCut {
  roundId: string
  round: GepaBudgetLayerCut
  evolution: GepaBudgetLayerCut
  /** No ledger means the first successful reservation starts this clock. */
  evolutionStartedAt: number | null
  digest: string
}

function selectedUsage(ledger: Ledger | undefined, roundId: string, layer: 'round' | 'evolution'): Usage {
  const used = zeroUsage()
  for (const operation of ledger?.operations ?? []) {
    if (layer === 'round' && operation.roundId !== roundId) continue
    const charged = operation.actual ?? operation.reserved
    for (const resource of Object.keys(used) as GepaBudgetResource[]) used[resource] += charged[resource]
  }
  return used
}

export async function captureGepaBudgetCut(store: Pick<SearchJournal, 'read'>, roundId: string,
  limits: { round: BudgetLimits; evolution: BudgetLimits }): Promise<GepaBudgetCut> {
  const ledger = await store.read<Ledger>('budget')
  if (ledger) verifyDigest(ledger)
  return seal({ roundId,
    round: { limit: usageLimit(limits.round), used: selectedUsage(ledger, roundId, 'round'), timeoutMs: limits.round.timeoutMs },
    evolution: { limit: usageLimit(limits.evolution), used: selectedUsage(ledger, roundId, 'evolution'), timeoutMs: limits.evolution.timeoutMs },
    evolutionStartedAt: ledger?.startedAt ?? null })
}

export interface GepaBudgetDelta {
  /** Confirmed Campaign receipts since the frozen cut, for this one round. */
  spent: Usage
  /** Unaccounted portions of live Campaign reservations, for this one round. */
  reserved: Usage
}

/**
 * Mirrors the checks of SearchJournal.reserve for a new operation, without writing a second ledger.
 * The caller must first resolve an existing idempotency key, and must supply the physical provider's
 * frozen post-cache-split cost. The same round's Campaign delta contributes to both layers.
 */
export function firstGepaBudgetFailure(input: {
  cut: GepaBudgetCut
  delta: GepaBudgetDelta
  cost: Usage
  roundStartedAt: number
  /** The first durable Campaign reserve, when the admission cut had no legacy ledger. */
  campaignBudgetStartedAt?: number
  now: number
}): GepaBudgetFailure | null {
  const { cut, delta, cost, roundStartedAt, campaignBudgetStartedAt, now } = input
  verifyDigest(cut)
  invariant(Number.isSafeInteger(now) && Number.isSafeInteger(roundStartedAt), 'invalid budget clock')
  if (campaignBudgetStartedAt !== undefined)
    invariant(Number.isSafeInteger(campaignBudgetStartedAt) && campaignBudgetStartedAt >= 0, 'invalid Campaign budget clock')
  const evolutionStartedAt = cut.evolutionStartedAt ?? campaignBudgetStartedAt ?? now
  if (now >= roundStartedAt + cut.round.timeoutMs
    || now >= evolutionStartedAt + cut.evolution.timeoutMs) return 'time'
  // The old reserve checks the round first, then the evolution. Within each layer,
  // Object.keys(cost) order determines which simultaneous failure is reported.
  for (const layer of ['round', 'evolution'] as const) {
    for (const resource of Object.keys(cost) as GepaBudgetResource[]) {
      invariant(Number.isSafeInteger(cost[resource]) && cost[resource] >= 0, 'invalid budget reservation')
      const used = cut[layer].used[resource] + delta.spent[resource] + delta.reserved[resource]
      const bound = cut[layer].limit[resource]
      if (bound !== null && used + cost[resource] > bound) return `${layer}.${resource}`
    }
  }
  return null
}
