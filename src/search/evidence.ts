import { digestJson } from '../state/digest.js'
import type { Rational } from './contracts.js'
import { comparisonKey, digest, invariant, numeric, observationValue, plannedCellCount, processTasks, repetitionsForTask, seal, sorted, validateSnapshot, verifyDigest, weightedMean } from './contracts.js'
import { validateSearchSchema } from './schema.js'
import type { SearchJournal } from './store.js'
import type { CellIdentity, EvidenceCell, EvidenceProfile, ProcessMode, SearchProvider, Snapshot, StageEvaluationPlan, StageResult, TaskProfile, TaskUniverse } from './types.js'

export function cellIdentity(universe: TaskUniverse, taskId: string, repetition: number, snapshot: Snapshot): CellIdentity {
  const task = universe.tasks.find(t => t.id === taskId), slot = repetitionsForTask(universe, taskId).find(s => s.index === repetition)
  invariant(task && slot, 'cell outside frozen task/slot manifest')
  return {
    taskId, taskContentDigest: task.contentDigest, repetition, seed: slot.seed,
    conditionDigest: universe.conditionDigest, outcomeContractDigest: task.outcome.digest,
    ...(task.process ? { processContractDigest: task.process.digest } : {}), harnessCommit: snapshot.commit,
    harnessManifestDigest: snapshot.manifestDigest, snapshotDigest: snapshot.digest,
  }
}
export function cellKey(identity: CellIdentity): string {
  const { snapshotDigest: originRecord, ...executionIdentity } = identity
  return digestJson(executionIdentity)
}
export function plannedCells(universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot): CellIdentity[] {
  validateSearchSchema('StageEvaluationPlan', plan)
  verifyDigest(plan); validateSnapshot(snapshot)
  invariant(plan.universeDigest === universe.digest && plan.partition === universe.partition, 'stage universe/partition mismatch')
  invariant(plan.participantIds.includes(snapshot.candidateId), 'snapshot is not a stage participant')
  invariant(plan.taskIds.length > 0 && sorted(plan.taskIds).length === plan.taskIds.length, 'invalid stage task manifest')
  return plan.taskIds.flatMap(id => repetitionsForTask(universe, id).map(s => cellIdentity(universe, id, s.index, snapshot)))
}
export function validOutcome(cell: EvidenceCell): boolean {
  return cell.status === 'available' && cell.outcomeCertified && cell.outcome.status === 'available'
}
/** Missing older views may coexist with complete views; two valid values may not conflict. */
export function assertConsistentCells(a: EvidenceCell, b: EvidenceCell): void {
  if (!validOutcome(a) || !validOutcome(b)) return
  invariant(digestJson(a.identity) === digestJson(b.identity) && a.evidenceRef === b.evidenceRef && a.completedAt === b.completedAt
    && digestJson(a.outcome) === digestJson(b.outcome) && a.outcomeCertified === b.outcomeCertified && a.envelope === b.envelope
    && digestJson(a.assertions ?? null) === digestJson(b.assertions ?? null), 'evidence cannot rerun or replace a valid outcome')
  if (a.process?.status === 'available' && b.process?.status === 'available') invariant(digestJson(a.process) === digestJson(b.process), 'evidence cannot replace valid process')
}
export function assertCell(cell: EvidenceCell, expected: CellIdentity): void {
  validateSearchSchema('EvidenceCell', cell)
  verifyDigest(cell)
  digest(cell.identity.snapshotDigest); digest(cell.identity.harnessManifestDigest)
  invariant(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(cell.identity.harnessCommit), 'cell requires an exact harness commit')
  invariant(cellKey(cell.identity) === cellKey(expected), 'cell condition/task/scorer/snapshot/slot identity mismatch')
  invariant(['available', 'missing', 'invalid'].includes(cell.status), 'invalid execution status')
  invariant(['legacy-v1', 'score-envelope-v2'].includes(cell.envelope), 'unsupported score envelope')
  invariant(typeof cell.outcomeCertified === 'boolean' && !!cell.evidenceRef && !!cell.completedAt, 'missing cell provenance')
  invariant(Number.isFinite(Date.parse(cell.completedAt)), 'invalid evidence completion time')
  if (cell.assertions) {
    invariant(new Set(cell.assertions.map(a => a.id)).size === cell.assertions.length, 'duplicate assertion identity')
    for (const assertion of cell.assertions) { invariant(assertion.id.length > 0, 'empty assertion identity'); digest(assertion.schemaDigest) }
  }
  if (cell.envelope === 'legacy-v1' && (cell.process?.status === 'missing' || cell.process?.status === 'invalid')) {
    invariant(!validOutcome(cell), 'legacy invalid observation cannot rescue outcome')
  }
}
export function profile(universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot, result: StageResult, mode: ProcessMode, weights?: Record<string, number>): EvidenceProfile {
  validateSearchSchema('StageResult', result)
  verifyDigest(result)
  invariant(result.stagePlanDigest === plan.digest && result.snapshotDigest === snapshot.digest, 'evidence support binding mismatch')
  const identities = plannedCells(universe, plan, snapshot)
  if (weights) invariant(plan.taskIds.every(id => Number.isFinite(weights[id]) && weights[id]! >= 0) && Object.keys(weights).length === plan.taskIds.length, 'profile weights must cover the frozen task manifest')
  const expected = new Map(identities.map(i => [cellKey(i), i]))
  const cells = new Map<string, EvidenceCell>()
  for (const cell of result.cells) {
    const key = cellKey(cell.identity), identity = expected.get(key)
    invariant(identity && !cells.has(key), 'duplicate or unplanned evidence cell')
    assertCell(cell, identity); cells.set(key, cell)
  }
  const declaredProcess = processTasks(universe, mode), applicable = declaredProcess.filter(id => plan.taskIds.includes(id))
  const coverage = { planned: identities.length, available: 0, paired: 0, pending: 0, missing: 0, invalid: 0, notEvaluated: plannedCellCount(universe, universe.tasks.filter(t => !plan.taskIds.includes(t.id)).map(t => t.id)) }
  const processCoverage = { ...coverage, planned: plannedCellCount(universe, applicable),
    notEvaluated: plannedCellCount(universe, declaredProcess.filter(id => !plan.taskIds.includes(id))) }
  const tasks: TaskProfile[] = []
  const outcomes: Array<{ value: Rational; weight: number }> = []
  const processValues: Record<string, Array<{ value: Rational; weight: number }>> = {}
  for (const taskId of plan.taskIds) {
    const task = universe.tasks.find(t => t.id === taskId)!
    const outcome: Rational[] = [], process: Rational[] = []
    for (const identity of identities.filter(i => i.taskId === taskId)) {
      const cell = cells.get(cellKey(identity))
      if (!cell) {
        coverage[result.settled ? 'missing' : 'pending']++
        if (applicable.includes(taskId)) processCoverage[result.settled ? 'missing' : 'pending']++
        continue
      }
      const o = observationValue(cell.outcome, task.outcome)
      if (validOutcome(cell) && o !== undefined) { coverage.available++; outcome.push(o) }
      else coverage[cell.status === 'missing' || cell.outcome.status === 'missing' ? 'missing' : 'invalid']++
      if (applicable.includes(taskId)) {
        const p = observationValue(cell.process, task.process!)
        if (validOutcome(cell) && p !== undefined) { processCoverage.available++; process.push(p) }
        else processCoverage[cell.process?.status === 'invalid' || !validOutcome(cell) ? 'invalid' : 'missing']++
      }
    }
    const row: TaskProfile = { taskId }
    // Global/bridge policy uses uniform task macro weights. Scoped callers supply
    // their frozen bucket weights explicitly; repetition count never changes them.
    const weight = weights?.[taskId] ?? 1
    const expectedSlots = repetitionsForTask(universe, taskId).length
    if (outcome.length === expectedSlots) {
      const value = weightedMean(outcome.map(value => ({ value, weight: 1 })))
      row.outcome = numeric(value); row.outcomeKey = String(comparisonKey(value, task.outcome.comparisonQuantum))
      outcomes.push({ value, weight })
    }
    if (applicable.includes(taskId) && process.length === expectedSlots) {
      const value = weightedMean(process.map(value => ({ value, weight: 1 })))
      row.process = numeric(value); row.processKey = String(comparisonKey(value, task.process!.comparisonQuantum))
      if (weight > 0) (processValues[task.process!.group] ??= []).push({ value, weight })
    }
    tasks.push(row)
  }
  const outcomeComplete = coverage.available === coverage.planned
  const processComplete = outcomeComplete && processCoverage.available === processCoverage.planned
  return {
    universeDigest: universe.digest, stagePlanDigest: plan.digest, scopeDigest: plan.scopeDigest, snapshotDigest: snapshot.digest,
    coverage, processCoverage, outcomeComplete, processComplete, processTaskIds: applicable, tasks,
    ...(outcomeComplete ? { outcome: numeric(weightedMean(outcomes)), outcomeKey: String(comparisonKey(weightedMean(outcomes), universe.tasks[0]!.outcome.comparisonQuantum)) } : {}),
    processGroups: processComplete ? Object.fromEntries(Object.entries(processValues).map(([k, v]) => [k, numeric(weightedMean(v))])) : {},
    processGroupKeys: processComplete ? Object.fromEntries(Object.entries(processValues).map(([k, v]) => [k, String(comparisonKey(weightedMean(v), universe.tasks.find(t => t.process?.group === k)!.process!.comparisonQuantum))])) : {},
    supportDigest: digestJson({ universe: universe.digest, plan: plan.digest, result: result.digest, mode, weights: weights ?? null }),
  }
}
/** Reuse completion evidence across operation labels without rerunning an already valid slot. */
export async function reusableCells(store: SearchJournal, provider: SearchProvider, identities: CellIdentity[], current: EvidenceCell[]): Promise<EvidenceCell[]> {
  const reusable: EvidenceCell[] = []
  for (const identity of identities) {
    const old = current.find(c => cellKey(c.identity) === cellKey(identity))
    if (old && validOutcome(old) && (!identity.processContractDigest || old.process?.status === 'available')) continue
    const pointer = await store.read<{ ref: string }>(`cells/${cellKey(identity).slice(7)}`)
    if (!pointer) continue
    const cell = await store.object<EvidenceCell>(pointer.ref)
    if (!validOutcome(cell)) continue
    assertCell(cell, identity); invariant(await provider.verifyCell(cell, identity), 'cached completion provenance rejected')
    if (old && validOutcome(old)) { assertConsistentCells(old, cell); if (cell.process?.status !== 'available') continue }
    reusable.push(cell)
  }
  return reusable
}
/** Appending a completion never changes an already valid outcome or its statistical slot. */
export function completeEvidence(original: StageResult, replacements: EvidenceCell[]): StageResult {
  verifyDigest(original)
  const cells = new Map(original.cells.map(c => [cellKey(c.identity), c]))
  for (const replacement of replacements) {
    verifyDigest(replacement)
    const key = cellKey(replacement.identity), old = cells.get(key)
    if (old && validOutcome(old)) {
      invariant(validOutcome(replacement), 'completion cannot rerun or replace a valid outcome')
      assertConsistentCells(old, replacement)
      if (old.process?.status === 'available') invariant(digestJson(replacement.process) === digestJson(old.process), 'completion cannot replace valid process')
    }
    cells.set(key, replacement)
  }
  return seal({ stagePlanDigest: original.stagePlanDigest, snapshotDigest: original.snapshotDigest, cells: [...cells.values()], settled: true, supersedesEvidenceDigest: original.digest })
}
export function emptyResult(plan: StageEvaluationPlan, snapshot: Snapshot): StageResult {
  return seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells: [], settled: false })
}
