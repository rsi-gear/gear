import type { PublicRoundStatus } from '../types.js'

/** Research/Target surfaces do not expose the operator's held-out gate or repair refs. */
export function seedOnlyStatus<T extends Pick<PublicRoundStatus, 'search' | 'searchPendingEvidence'>>(status: T): Omit<T, 'search' | 'searchPendingEvidence'> & { research?: Omit<NonNullable<PublicRoundStatus['search']>['research'], 'remainingBudget'> } {
  const { search, searchPendingEvidence: privateRepair, ...legacy } = status
  if (!search) return legacy
  const { remainingBudget: privateUsage, ...research } = search.research
  return { ...legacy, research }
}
