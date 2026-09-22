import { digestJson } from '../state/digest.js'
import { passesExploration } from './archive.js'
import { integrity, invariant, repetitionsForTask, seal, sorted, verifyDigest } from './contracts.js'
import { trialPassed } from './objective.js'
import { profile, validOutcome } from './evidence.js'
import { samplingEvidence } from './scope-sampling.js'
import { createScope, sharedTasks, stagePlan } from './scopes.js'
import type { SearchJournal } from './store.js'
import type { EvaluationScope, ParentSelectionDecision, ResearchArchive, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskSetResolution, TaskUniverse } from './types.js'

export interface ScopeEpochPreparation {
  archiveCutoffDigest: string
  epoch: number
  sharedTaskIds: string[]
  ruleDigest: string
  scopes: EvaluationScope[]
  plans: StageEvaluationPlan[]
  results: StageResult[]
  decisions: Array<{
    familyId: string; previousScopeDigest: string; proposedScopeDigest?: string
    participantIds: string[]; excludedHistoricalIds: string[]
    status: 'prepared' | 'unchanged' | 'budget-insufficient' | 'baseline-ineligible' | 'no-history'
    reasonCodes: string[]
  }>
  digest: string
}
export function scopeEpoch(settings: SearchSettings, roundIndex: number): number {
  invariant(Number.isSafeInteger(roundIndex) && roundIndex >= 0, 'invalid scope round index')
  if (settings.search.scopeSampling.epochPolicy === 'periodic') invariant(Number.isSafeInteger(settings.search.scopeSampling.updateEveryRounds) && settings.search.scopeSampling.updateEveryRounds! > 0, 'invalid scope update period')
  return settings.search.scopeSampling.epochPolicy === 'stable' ? 1 : 1 + Math.floor(roundIndex / settings.search.scopeSampling.updateEveryRounds!)
}
/** Called at the round planning boundary, under its writer lock and shared budget. */
export async function prepareScopeEpochs(input: {
  store: SearchJournal; roundId: string; roundIndex: number; settings: SearchSettings
  archive: ResearchArchive; universe: TaskUniverse; anchor: Snapshot; parents: ParentSelectionDecision; resolution: TaskSetResolution
  missingCost(snapshots: Snapshot[], taskIds: string[]): Promise<{ cells: number; repairCells: number }>
  evaluate(plan: StageEvaluationPlan, snapshot: Snapshot): Promise<StageResult>
}): Promise<ScopeEpochPreparation> {
  const { store, archive, universe, settings, parents, anchor, resolution, roundId } = input
  for (const record of [archive, universe, parents, resolution]) verifyDigest(record)
  invariant(archive.universeDigest === universe.digest && parents.archiveDigest === archive.digest && resolution.universeDigest === universe.digest, 'scope preparation cohort changed')
  invariant(!await store.read(`rounds/${roundId}/planning`), 'scope preparation must precede frozen workplans')
  const config = settings.search, epoch = scopeEpoch(settings, input.roundIndex)
  const parent = archive.snapshots.find(s => s.digest === parents.batches[0]?.parentSnapshotDigest) ?? anchor
  const parentCells = archive.results.filter(r => r.snapshotDigest === parent.digest).flatMap(r => r.cells)
  const successful = universe.tasks.filter(task => repetitionsForTask(universe, task.id).every(slot => parentCells.some(c =>
    c.identity.taskId === task.id && c.identity.repetition === slot.index && validOutcome(c)
    && trialPassed(c, universe)))).map(t => t.id)
  const shared = await store.freezeEvolution(`shared-epoch-${epoch}`, () => seal({ epoch, archiveCutoffDigest: archive.digest, parentSnapshotDigest: parent.digest,
    taskIds: sharedTasks(universe, resolution, config, successful, epoch) }))
  const base = { archiveCutoffDigest: archive.digest, epoch, sharedTaskIds: shared.taskIds, ruleDigest: digestJson(config.scopeSampling) }
  const scopes: EvaluationScope[] = [], plans: StageEvaluationPlan[] = [], results: StageResult[] = [], decisions: ScopeEpochPreparation['decisions'] = []
  if (config.scopeSampling.epochPolicy === 'stable' || input.roundIndex === 0 || input.roundIndex % config.scopeSampling.updateEveryRounds! !== 0) return seal({ ...base, scopes, plans, results, decisions })
  for (const oldScope of archive.scopes.filter(s => s.familyId !== 'bootstrap' && archive.scopeProbabilities[s.digest] !== undefined).sort((a, b) => a.familyId.localeCompare(b.familyId))) {
    if (oldScope.epoch >= epoch) continue
    const history = archive.clusters.filter(c => c.familyId === oldScope.familyId)
    if (!history.length) { decisions.push({ familyId: oldScope.familyId, previousScopeDigest: oldScope.digest, participantIds: [], excludedHistoricalIds: [], status: 'no-history', reasonCodes: ['no-committed-family-diagnosis'] }); continue }
    const proposed = await store.freezeEvolution(`scope-epoch-${digestJson([oldScope.familyId, epoch]).slice(7)}`, () => {
      const sampler = samplingEvidence(universe, archive.digest, archive.clusters, archive.results)
      const scope = createScope(universe, resolution, config, { familyId: oldScope.familyId, taskIds: sorted(history.flatMap(c => c.taskIds)),
        modificationPaths: sorted(history.flatMap(c => c.modificationPaths)), successfulControlTaskIds: sorted(history.flatMap(c => c.successfulControlTaskIds ?? [])) }, shared.taskIds, epoch, sampler)
      invariant(scope, 'historical family has no representative in proposed epoch')
      return seal({ scope, sampler, archiveCutoffDigest: archive.digest, clusterDigests: sorted(history.map(c => c.digest)), ruleDigest: base.ruleDigest })
    })
    await store.put(proposed.sampler)
    await store.put(proposed.scope)
    const decisionBase = { familyId: oldScope.familyId, previousScopeDigest: oldScope.digest, proposedScopeDigest: proposed.scope.digest }
    if (proposed.scope.equivalenceDigest === oldScope.equivalenceDigest) {
      decisions.push({ ...decisionBase, participantIds: [], excludedHistoricalIds: [], status: 'unchanged', reasonCodes: ['equivalent-task-scope'] }); continue
    }
    // Actual selected code parents are mandatory. Optional historical specialists
    // follow frozen membership order and can be removed only before any evaluation.
    const mandatory = [...new Map([anchor, ...parents.batches.filter(b => b.sourceScopeDigest === oldScope.digest).map(b => archive.snapshots.find(s => s.digest === b.parentSnapshotDigest)!)].map(s => [s.candidateId, s])).values()]
    const probabilities = archive.scopeViews.find(v => v.scopeDigest === oldScope.digest)!.conditionalParentProbabilities
    const historical = Object.entries(probabilities).sort(([a, ap], [b, bp]) => bp - ap || a.localeCompare(b))
      .filter(([id]) => !mandatory.some(s => s.candidateId === id)).slice(0, config.scopeSampling.maxHistoricalSpecialists ?? 1)
      .map(([id]) => archive.snapshots.find(s => s.candidateId === id)!)
    const admission = await store.freeze(roundId, `scope-preparation-${proposed.scope.digest.slice(7)}-input`, async () => {
      const selected = [...historical], excludedHistoricalIds: string[] = []
      const remaining = await store.remaining(roundId, settings.budgets)
      let cost = await input.missingCost([...mandatory, ...selected], proposed.scope.taskIds)
      while ((cost.cells > remaining.cells || cost.repairCells > remaining.repairCells) && selected.length) {
        excludedHistoricalIds.push(selected.pop()!.candidateId)
        cost = await input.missingCost([...mandatory, ...selected], proposed.scope.taskIds)
      }
      const participants = [...mandatory, ...selected]
      return seal({ participantIds: participants.map(s => s.candidateId), excludedHistoricalIds,
        affordable: cost.cells <= remaining.cells && cost.repairCells <= remaining.repairCells,
        missingCost: cost, remaining, plan: stagePlan({ stage: 'baseline-probe', partition: 'seed', universeDigest: universe.digest,
          taskSetSizeResolutionDigest: resolution.digest, scopeDigest: proposed.scope.digest, taskIds: proposed.scope.taskIds,
          participantIds: participants.map(s => s.candidateId), prerequisiteDecisionDigests: [parents.digest, proposed.digest], selectionRuleDigest: integrity }) })
    })
    if (!admission.affordable) { decisions.push({ ...decisionBase, participantIds: admission.participantIds, excludedHistoricalIds: admission.excludedHistoricalIds, status: 'budget-insufficient', reasonCodes: ['scope-preparation-budget'] }); continue }
    plans.push(admission.plan)
    let eligible = true
    const reasons: string[] = []
    for (const id of admission.participantIds) {
      const snapshot = id === anchor.candidateId ? anchor : archive.snapshots.find(s => s.candidateId === id)!
      const result = await input.evaluate(admission.plan, snapshot)
      results.push(result)
      if (result.failure || !passesExploration(proposed.scope, profile(universe, admission.plan, snapshot, result, config.process.mode, proposed.scope.weights), universe)) {
        eligible = false; reasons.push(result.failure ? `${result.failure.kind}:${result.failure.code}` : `incomplete-or-ineligible:${id}`)
      }
    }
    if (eligible) scopes.push(proposed.scope)
    decisions.push({ ...decisionBase, participantIds: admission.participantIds, excludedHistoricalIds: admission.excludedHistoricalIds, status: eligible ? 'prepared' : 'baseline-ineligible', reasonCodes: reasons })
  }
  return seal({ ...base, scopes, plans, results, decisions })
}
