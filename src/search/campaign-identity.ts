import { digestJson } from '../state/digest.js'

/** Internal bounded names only; public round IDs and old physical keys stay unchanged. */
export function campaignSearchId(roundId: string): string {
  return `search-${digestJson(roundId).slice(7)}`
}

export function campaignSearchDirectory(roundId: string): string {
  return `round-${digestJson(roundId).slice(7)}`
}
