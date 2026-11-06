import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  builtinPolicyImplementationDigest,
  builtinPolicy as pythonPolicy,
} from '../adapters/python/builtin-policy.js'
import { digestJson } from '../state/digest.js'
import { sealed, verifySealed, validateResolvedObjective } from './contracts.js'
import type {
  ObjectiveScoreEvidence,
  RawMetricAggregate,
  RawMetricContract,
  RawMetricValue,
  RawTrialMetrics,
  ResolvedObjective,
} from './types.js'

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
export const objectiveProjectorDigest = `sha256:${['contracts', 'scoring'].reduce((hash, name) => hash.update(readFileSync(new URL(`${name}${extension}`, import.meta.url))), createHash('sha256').update(builtinPolicyImplementationDigest)).digest('hex')}`

/** Python owns metric extraction/aggregation/scoring; TS verifies and seals provenance. */
export function extractRawMetrics(input: {
  contracts: RawMetricContract[]
  trial: unknown
  certified: boolean
  identity: Omit<RawTrialMetrics, 'schemaVersion' | 'kind' | 'metrics' | 'digest'>
}): RawTrialMetrics {
  for (const contract of input.contracts) verifySealed(contract)
  const metrics = pythonPolicy<Record<string, RawMetricValue>>('objective_extract', input)
  return sealed({ schemaVersion: 1 as const, kind: 'raw-metrics' as const, ...input.identity, metrics })
}

export function aggregateRawMetrics(
  contracts: RawMetricContract[],
  tasks: Array<{ id: string; repetitions: number[]; weight: number }>,
  records: RawTrialMetrics[],
): Record<string, RawMetricAggregate> {
  for (const contract of contracts) verifySealed(contract)
  for (const record of records) verifySealed(record)
  return pythonPolicy('objective_aggregate', { contracts, tasks, records })
}

export interface ObjectiveBaseline {
  scopeDigest: string
  metrics: Record<string, RawMetricAggregate>
  digest: string
}
export function scoreObjective(
  objective: ResolvedObjective,
  metrics: Record<string, RawMetricAggregate>,
  scopeDigest: string,
  baseline?: ObjectiveBaseline,
): ObjectiveScoreEvidence {
  return scoreObjectiveProjection(objective, metrics, scopeDigest, baseline).evidence
}

export function scoreObjectiveProjection(
  objective: ResolvedObjective,
  metrics: Record<string, RawMetricAggregate>,
  scopeDigest: string,
  baseline?: ObjectiveBaseline,
): { evidence: ObjectiveScoreEvidence; comparisonKey?: string } {
  validateResolvedObjective(objective)
  if (baseline) {
    verifySealed(baseline)
    if (baseline.scopeDigest !== scopeDigest) throw new TypeError('initial baseline scope mismatch')
  }
  const projection = pythonPolicy<{
    score: Pick<
      ObjectiveScoreEvidence,
      'status' | 'score' | 'rawMetricsRefs' | 'inputs' | 'contributions' | 'constraintResults'
    >
    comparisonKey?: string
  }>('objective_score_projection', { objective, metrics, ...(baseline ? { baseline } : {}) })
  const evidence = sealed({
    schemaVersion: 1 as const,
    kind: 'refine-objective-score' as const,
    objective,
    objectiveDigest: objective.digest,
    projectorDigest: objectiveProjectorDigest,
    scopeDigest,
    ...projection.score,
  })
  return {
    evidence,
    ...(projection.comparisonKey === undefined ? {} : { comparisonKey: projection.comparisonKey }),
  }
}

export function objectiveScopeDigest(input: {
  tasks: Array<{ id: string; repetitions: number[]; weight: number }>
  conditionDigest: string
  partition: string
}): string {
  return digestJson({
    ...input,
    tasks: input.tasks
      .map((t) => ({ ...t, repetitions: [...t.repetitions].sort((a, b) => a - b) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })
}
