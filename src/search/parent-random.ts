import { digestJson } from '../state/digest.js'

/** Indexed randomness has no mutable cursor; a replay uses the same seed and indices. */
export interface ParentRandom {
  readonly seed: string
  float(index: number): number
  weighted(probabilities: Readonly<Record<string, number>>, index: number): string
}

export function createParentRandom(seed: string): ParentRandom {
  const float = (index: number): number => {
    if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('random index must be a nonnegative integer')
    return parseInt(digestJson([seed, index]).slice(7, 20), 16) / 0x10000000000000
  }
  return Object.freeze({ seed, float, weighted(probabilities: Readonly<Record<string, number>>, index: number): string {
    const entries = Object.entries(probabilities).sort(([a], [b]) => a.localeCompare(b))
    if (entries.some(([, p]) => !Number.isFinite(p) || p < 0)) throw new TypeError('invalid sampling probability')
    const positive = entries.filter(([, p]) => p > 0)
    if (!positive.length) throw new Error('blocked-no-eligible-parent')
    if (Math.abs(positive.reduce((sum, [, p]) => sum + p, 0) - 1) > 1e-9) throw new TypeError('sampling probabilities must sum to one')
    const sample = float(index)
    let total = 0
    for (const [id, p] of positive) { total += p; if (sample < total) return id }
    return positive.at(-1)![0]
  } })
}
