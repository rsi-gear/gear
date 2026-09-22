import { aggregateRawMetrics, objectiveScopeDigest, scoreObjective } from '../objective/scoring.js'
import type { ObjectiveBaseline } from '../objective/scoring.js'
import { comparisonKey, invariant, numeric, repetitionsForTask, utility } from './contracts.js'
import type { EvidenceCell, EvidenceProfile, TaskProfile, TaskUniverse } from './types.js'

export function objectiveProfile(universe: TaskUniverse, taskIds: string[], cells: EvidenceCell[], weights?: Record<string, number>, baseline?: ObjectiveBaseline): Pick<EvidenceProfile, 'rawMetrics' | 'objectiveScore' | 'objectiveComplete' | 'objectiveKey'> {
  if (!universe.rawMetricContracts) return {}
  const tasks = taskIds.map(id => ({ id, repetitions: repetitionsForTask(universe, id).map(r => r.index), weight: weights?.[id] ?? 1 }))
  const records = cells.filter(c => taskIds.includes(c.identity.taskId)).flatMap(c => {
    if (!c.rawMetrics) return []
    invariant(c.rawMetrics.taskId === c.identity.taskId && c.rawMetrics.repetition === c.identity.repetition
      && c.rawMetrics.runId === c.evidenceRef && c.rawMetrics.harnessCommit === c.identity.harnessCommit
      && c.rawMetrics.conditionDigest === c.identity.conditionDigest, 'raw metric trial provenance mismatch')
    // Respect the existing envelope's certification boundary even for unused channels.
    invariant(c.status === 'available' && c.outcomeCertified || Object.values(c.rawMetrics.metrics).every(m => m.status !== 'available'), 'uncertified envelope cannot provide raw metrics')
    return [c.rawMetrics]
  })
  const rawMetrics = aggregateRawMetrics(universe.rawMetricContracts, tasks, records)
  if (!universe.objective) return { rawMetrics }
  const scopeDigest = objectiveScopeDigest({ tasks, conditionDigest: universe.conditionDigest, partition: universe.partition })
  const objectiveScore = scoreObjective(universe.objective, rawMetrics, scopeDigest, baseline)
  return { rawMetrics, objectiveScore, objectiveComplete: objectiveScore.score !== undefined,
    ...(objectiveScore.score === undefined ? {} : { objectiveKey: String(comparisonKey(objectiveScore.score, universe.objective.comparisonPrecision)) }) }
}
export function scoringComplete(p: EvidenceProfile): boolean {
  return p.objectiveScore ? p.objectiveComplete === true : p.outcomeComplete && p.processComplete
}
export function scoringKey(p: EvidenceProfile | TaskProfile): string | undefined {
  return p.objectiveScore ? p.objectiveKey : p.outcomeKey
}
export function scoringValue(p: TaskProfile): number | undefined {
  return p.objectiveScore ? p.objectiveScore.score : p.outcome
}
export function trialPassed(cell: EvidenceCell, universe: TaskUniverse): boolean {
  if (universe.objective) return cell.rawMetrics?.metrics.pass_rate?.status === 'available' && cell.rawMetrics.metrics.pass_rate.value === 1
  const task = universe.tasks.find(t => t.id === cell.identity.taskId)!
  // Legacy utilities retain their original success threshold.
  return cell.outcome.status === 'available' && numeric(utility(cell.outcome.rawValue, task.outcome)) >= task.successUtility
}
