import type { EvaluationEvidence } from '../types.js'
import type { EvaluationScope, ProcessMode, StageEvaluationPlan, StageResult, Snapshot, TaskUniverse } from './types.js'
import { invariant, numeric, sorted, utility, weightedMean } from './contracts.js'
import { profile, validOutcome } from './evidence.js'

/** Meta-only seed projection. It is never a scoring or cell-reuse authority. */
export function legacySearchEvidence(result: StageResult, snapshot: Snapshot, conditionId: string, dataset: string,
  context: { universe: TaskUniverse; plan: StageEvaluationPlan; scope: EvaluationScope; processMode: ProcessMode }): EvaluationEvidence {
  const { universe, plan, scope, processMode } = context
  invariant(universe.partition === 'seed' && scope.digest === plan.scopeDigest, 'Meta baseline must reference its frozen seed scope')
  const p = profile(universe, plan, snapshot, result, processMode, scope.weights)
  invariant(p.outcomeComplete, 'Meta baseline requires complete planned outcome evidence')
  const trials = result.cells.filter(validOutcome).map(c => {
    const task = universe.tasks.find(t => t.id === c.identity.taskId)!
    const score = universe.objective ? (c.outcome as { rawValue: number }).rawValue : numeric(utility((c.outcome as { rawValue: number }).rawValue, task.outcome))
    const process = p.processTaskIds.includes(task.id) && c.process?.status === 'available' && task.process
      ? universe.objective ? c.process.rawValue : numeric(utility(c.process.rawValue, task.process)) : undefined
    const pass = c.rawMetrics?.metrics.pass_rate
    return { taskName: task.id, runId: c.evidenceRef, attempt: c.identity.repetition + 1, status: 'completed' as const,
      ...(universe.objective ? { passStatus: pass?.status !== 'available' ? 'unavailable' as const : pass.value === 1 ? 'passed' as const : 'failed' as const } : {}),
      rewards: { reward: score }, scores: { totalScore: score, normalization: 'standard' as const, ...(process === undefined ? {} : { processScore: process }) } }
  })
  const passed = p.tasks.filter(row => universe.objective ? row.rawMetrics?.pass_rate?.status === 'available' && row.rawMetrics.pass_rate.value === 1
    : row.outcome! >= universe.tasks.find(t => t.id === row.taskId)!.successUtility).length
  const groups = Object.values(p.processGroups)
  const rawMean = (taskIds: string[], channel: 'totalScore' | 'processScore') => numeric(weightedMean(taskIds.map(id => ({
    value: weightedMean(trials.filter(t => t.taskName === id).map(t => ({ value: t.scores[channel]!, weight: 1 }))), weight: scope.weights[id]!,
  }))))
  const processScore = p.processComplete && groups.length === 1 ? universe.objective ? rawMean(p.processTaskIds, 'processScore') : groups[0] : undefined
  const primaryReward = universe.objective ? rawMean(plan.taskIds, 'totalScore') : p.outcome!
  return { provider: 'search-v2-seed-projection', conditionId, effectiveConfigDigest: plan.digest,
    ...(p.rawMetrics ? { rawMetrics: p.rawMetrics } : {}), ...(p.objectiveScore ? { objectiveScore: p.objectiveScore } : {}),
    evalId: result.digest, dataset, requestedCommit: snapshot.commit, actualCommit: snapshot.commit, revisionIdentity: snapshot.commit,
    completeness: 'complete', plannedTrialCount: p.coverage.planned, primaryReward, ...(processScore === undefined ? {} : { processScore }),
    summary: { total: plan.taskIds.length, passed, failed: plan.taskIds.length - passed, score: primaryReward,
      ...(universe.objective ? { passRateStatus: p.rawMetrics?.pass_rate?.status === 'available' ? 'available' as const : 'unavailable' as const,
        ...(p.rawMetrics?.pass_rate?.value === undefined ? {} : { passRate: p.rawMetrics.pass_rate.value }) } : {}),
      ...(processScore === undefined ? {} : { process: { score: processScore } }) }, trials,
    invalidTrials: [], metadata: { metricSemantics: universe.objective ? 'raw-metric' : 'frozen-utility', aggregateWeighting: 'frozen-scope-task-weights', summaryUnit: 'task',
      plannedTaskCount: plan.taskIds.length, plannedLogicalSlots: p.coverage.planned, processAggregateStatus: processScore === undefined ? 'unavailable' : 'available',
      taskWeights: scope.weights, processTaskGroups: Object.fromEntries(p.processTaskIds.map(id => [id, universe.tasks.find(t => t.id === id)!.process!.group])) } }
}

/** Structural state validation can recompute this Meta projection without treating it as release evidence. */
export function searchProjectionAggregates(value: EvaluationEvidence): { taskCount: number; outcome: number; process?: number } {
  const m = value.metadata as unknown as { metricSemantics: string; aggregateWeighting: string; summaryUnit: string; plannedTaskCount: number; plannedLogicalSlots: number;
    taskWeights: Record<string, number>; processTaskGroups: Record<string, string>; processAggregateStatus: string } | undefined
  const ids = sorted(value.trials.map(t => t.taskName))
  invariant(m && ['frozen-utility', 'raw-metric'].includes(m.metricSemantics) && m.aggregateWeighting === 'frozen-scope-task-weights' && m.summaryUnit === 'task'
    && value.completeness === 'complete' && m.plannedTaskCount === ids.length && m.plannedLogicalSlots === value.plannedTrialCount, 'invalid search baseline projection metadata')
  invariant(m.taskWeights && !Array.isArray(m.taskWeights) && typeof m.taskWeights === 'object' && m.processTaskGroups && typeof m.processTaskGroups === 'object' && !Array.isArray(m.processTaskGroups), 'invalid search baseline weights/groups')
  invariant(JSON.stringify(Object.keys(m.taskWeights).sort()) === JSON.stringify(ids) && Object.values(m.taskWeights).every(w => Number.isFinite(w) && w >= 0)
    && Math.abs(Object.values(m.taskWeights).reduce((sum, w) => sum + w, 0) - 1) <= 1e-12, 'invalid search baseline task weights')
  invariant(Object.entries(m.processTaskGroups).every(([id, group]) => ids.includes(id) && typeof group === 'string' && group.length), 'invalid search baseline process groups')
  const rows = ids.map(id => {
    const trials = value.trials.filter(t => t.taskName === id)
    invariant(trials.every(t => t.scores?.normalization === 'standard'), 'search baseline requires explicit utility observations')
    const outcome = weightedMean(trials.map(t => ({ value: t.scores!.totalScore, weight: 1 })))
    const applicable = Object.hasOwn(m.processTaskGroups, id)
    invariant(trials.every(t => applicable || t.scores?.processScore === undefined), 'process outside declared search baseline applicability')
    const process = applicable && trials.every(t => t.scores?.processScore !== undefined)
      ? weightedMean(trials.map(t => ({ value: t.scores!.processScore!, weight: 1 }))) : undefined
    return { id, outcome, process, weight: m.taskWeights[id]! }
  })
  const outcome = numeric(weightedMean(rows.map(r => ({ value: r.outcome, weight: r.weight }))))
  const processRows = rows.filter(r => Object.hasOwn(m.processTaskGroups, r.id))
  const groups = sorted(processRows.filter(r => r.weight > 0).map(r => m.processTaskGroups[r.id]!))
  const process = processRows.length && groups.length === 1 && processRows.every(r => r.process !== undefined)
    ? numeric(weightedMean(processRows.map(r => ({ value: r.process!, weight: r.weight })))) : undefined
  invariant(m.processAggregateStatus === (process === undefined ? 'unavailable' : 'available'), 'search baseline process aggregate availability changed')
  return { taskCount: ids.length, outcome, ...(process === undefined ? {} : { process }) }
}
