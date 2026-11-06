import { readFileSync } from 'node:fs'
import { GearError } from '../../domain/errors.js'

export interface BenchmarkLimits {
  maxFiles: number
  maxDirectories: number
  maxUniqueBytes: number
  maxMaterializedBytes: number
  authorTimeoutMs: number
  maxOutputBytes: number
}

const limitsVariable = 'GEAR_BENCHMARK_LIMITS_JSON'
const defaults = JSON.parse(
  readFileSync(new URL('../../../python/gear/benchmark/limits.json', import.meta.url), 'utf8'),
) as BenchmarkLimits
const maxTimerDelayMs = 2 ** 31 - 1

/** Keep all import, compilation and frozen-dataset gates on the same operator budgets. */
export function benchmarkLimits(env: NodeJS.ProcessEnv = process.env): BenchmarkLimits {
  try {
    const overrides: unknown = JSON.parse(env[limitsVariable] ?? '{}')
    if (
      !overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.keys(overrides).some((key) => !Object.hasOwn(defaults, key))
    )
      throw new Error()
    const result = { ...defaults, ...overrides }
    if (
      Object.values(result).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      result.authorTimeoutMs > maxTimerDelayMs
    )
      throw new Error()
    return result
  } catch {
    throw new GearError(
      'invalid-benchmark-limits',
      'Benchmark limits must be a JSON object of known positive integer budgets; authorTimeoutMs must fit a Node timer',
      { location: limitsVariable },
    )
  }
}
