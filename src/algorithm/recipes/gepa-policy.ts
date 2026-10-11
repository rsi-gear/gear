import { digestJson } from '../../state/digest.js'
import { buildArchive, passesExploration } from '../../search/archive.js'
import { clusters } from '../../search/diagnosis.js'
import { cellIdentity, cellKey, profile, validOutcome } from '../../search/evidence.js'
import { selectParentsWithPolicy, type ParentSelectionPolicy } from '../../search/parent-selection.js'
import { rankProfiles } from '../../search/promotion.js'
import { scoringComplete } from '../../search/objective.js'
import { bridgeSelection, createScope, sharedTasks, stagePlan } from '../../search/scopes.js'
import { samplingEvidence } from '../../search/scope-sampling.js'
import { scopeEpoch, type ScopeEpochPreparation } from '../../search/epochs.js'
import { trialPassed } from '../../search/objective.js'
import { integrity, repetitionsForTask, resolveSizing, seal, sorted, verifyDigest } from '../../search/contracts.js'
import type { BridgeSelectionDecision, CandidateWorkPlan, DiagnosisDossier, EvaluationScope, FailureCluster,
  ParentSelectionDecision, ResearchArchive, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'

export type GepaWork = { batchId: string; parent: Snapshot; dossier: DiagnosisDossier; cluster: FailureCluster;
  scope: EvaluationScope; plan: StageEvaluationPlan; workplan: CandidateWorkPlan; parentBaseline: StageResult }
export type GepaBaseline = { plan: StageEvaluationPlan; result: StageResult }
export type GepaLocal = { work: GepaWork; snapshot: Snapshot; result: StageResult; changedPaths: string[];
  outsideBoundary: boolean; broaderScopeSatisfied: boolean }
export type GepaPendingScope = { familyId: string; oldScopeDigest: string; scope: EvaluationScope;
  plan: StageEvaluationPlan; participants: Snapshot[]; excludedHistoricalIds: string[] }
export type GepaPreparationPlan = { base: Pick<ScopeEpochPreparation, 'archiveCutoffDigest' | 'epoch' | 'sharedTaskIds' | 'ruleDigest'>;
  pending: GepaPendingScope[]; decisions: ScopeEpochPreparation['decisions'] }
export type GepaSharedEpoch = { epoch: number; archiveCutoffDigest: string;
  parentSnapshotDigest: string; taskIds: string[] }

/** Periodic scope proposals and historical specialist trimming use frozen archive cells and the public remaining budget. */
export function planGepaScopePreparation(input: { archive: ResearchArchive; parents: ParentSelectionDecision; anchor: Snapshot;
  seed: TaskUniverse; settings: SearchSettings; roundIndex: number; remainingCells: number; remainingRepairCells: number;
  sharedEpochs?: Record<string, GepaSharedEpoch> }): GepaPreparationPlan {
  const { archive, parents, anchor, seed, settings } = input
  const resolution = resolveSizing(seed, settings.search.taskSetSizing), epoch = scopeEpoch(settings, input.roundIndex)
  const first = archive.snapshots.find(snapshot => snapshot.digest === parents.batches[0]?.parentSnapshotDigest) ?? anchor
  const parentCells = archive.results.filter(result => result.snapshotDigest === first.digest).flatMap(result => result.cells)
  const successful = seed.tasks.filter(task => repetitionsForTask(seed, task.id).every(slot => parentCells.some(cell =>
    cell.identity.taskId === task.id && cell.identity.repetition === slot.index && validOutcome(cell) && trialPassed(cell, seed))))
    .map(task => task.id)
  const previousEpoch = input.sharedEpochs?.[String(epoch)]
  if (previousEpoch && (previousEpoch.epoch !== epoch
    || !/^sha256:[a-f0-9]{64}$/u.test(previousEpoch.archiveCutoffDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(previousEpoch.parentSnapshotDigest)
    || digestJson(previousEpoch.taskIds) !== digestJson(sorted(previousEpoch.taskIds))
    || previousEpoch.taskIds.some(id => !seed.tasks.some(task => task.id === id))))
    throw new Error('GEPA shared epoch lineage is invalid')
  const sharedTaskIds = previousEpoch?.taskIds ?? sharedTasks(seed, resolution, settings.search, successful, epoch)
  const base = { archiveCutoffDigest: archive.digest, epoch, sharedTaskIds,
    ruleDigest: digestJson(settings.search.scopeSampling) }
  const pending: GepaPendingScope[] = [], decisions: ScopeEpochPreparation['decisions'] = []
  if (settings.search.scopeSampling.epochPolicy === 'stable' || input.roundIndex === 0
    || input.roundIndex % settings.search.scopeSampling.updateEveryRounds! !== 0) return { base, pending, decisions }
  const valid = new Set(archive.results.flatMap(result => result.cells.filter(validOutcome).map(cell => cellKey(cell.identity))))
  const invalid = new Set(archive.results.flatMap(result => result.cells.filter(cell => !validOutcome(cell)).map(cell => cellKey(cell.identity))))
  const planned = new Set<string>()
  let remainingCells = input.remainingCells, remainingRepairCells = input.remainingRepairCells
  const missingCost = (participants: Snapshot[], tasks: string[]) => {
    const keys = new Set(participants.flatMap(snapshot => tasks.flatMap(id => repetitionsForTask(seed, id)
      .map(slot => cellKey(cellIdentity(seed, id, slot.index, snapshot))))))
    const missing = [...keys].filter(key => !valid.has(key) && !planned.has(key))
    return { cells: missing.length, repairCells: missing.filter(key => invalid.has(key)).length, keys: missing }
  }
  for (const oldScope of archive.scopes.filter(scope => scope.familyId !== 'bootstrap'
    && archive.scopeProbabilities[scope.digest] !== undefined).sort((a, b) => a.familyId.localeCompare(b.familyId))) {
    if (oldScope.epoch >= epoch) continue
    const history = archive.clusters.filter(cluster => cluster.familyId === oldScope.familyId)
    if (!history.length) { decisions.push({ familyId: oldScope.familyId, previousScopeDigest: oldScope.digest,
      participantIds: [], excludedHistoricalIds: [], status: 'no-history', reasonCodes: ['no-committed-family-diagnosis'] }); continue }
    const sampler = samplingEvidence(seed, archive.digest, archive.clusters, archive.results)
    const scope = createScope(seed, resolution, settings.search, { familyId: oldScope.familyId,
      taskIds: sorted(history.flatMap(cluster => cluster.taskIds)),
      modificationPaths: sorted(history.flatMap(cluster => cluster.modificationPaths)),
      successfulControlTaskIds: sorted(history.flatMap(cluster => cluster.successfulControlTaskIds ?? [])) },
    sharedTaskIds, epoch, sampler)
    if (!scope) throw new Error('Historical GEPA family has no representative in proposed epoch')
    const proposed = seal({ scope, sampler, archiveCutoffDigest: archive.digest,
      clusterDigests: sorted(history.map(cluster => cluster.digest)), ruleDigest: base.ruleDigest })
    const decisionBase = { familyId: oldScope.familyId, previousScopeDigest: oldScope.digest,
      proposedScopeDigest: scope.digest }
    if (scope.equivalenceDigest === oldScope.equivalenceDigest) {
      decisions.push({ ...decisionBase, participantIds: [], excludedHistoricalIds: [], status: 'unchanged',
        reasonCodes: ['equivalent-task-scope'] }); continue
    }
    const mandatory = [...new Map([anchor, ...parents.batches.filter(batch => batch.sourceScopeDigest === oldScope.digest)
      .map(batch => archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!)].map(snapshot =>
        [snapshot.candidateId, snapshot])).values()]
    const probabilities = archive.scopeViews.find(view => view.scopeDigest === oldScope.digest)!.conditionalParentProbabilities
    const historical = Object.entries(probabilities).sort(([a, ap], [b, bp]) => bp - ap || a.localeCompare(b))
      .filter(([id]) => !mandatory.some(snapshot => snapshot.candidateId === id))
      .slice(0, settings.search.scopeSampling.maxHistoricalSpecialists ?? 1)
      .map(([id]) => archive.snapshots.find(snapshot => snapshot.candidateId === id)!)
    const selected = [...historical], excludedHistoricalIds: string[] = []
    let cost = missingCost([...mandatory, ...selected], scope.taskIds)
    while ((cost.cells > remainingCells || cost.repairCells > remainingRepairCells) && selected.length) {
      excludedHistoricalIds.push(selected.pop()!.candidateId)
      cost = missingCost([...mandatory, ...selected], scope.taskIds)
    }
    const participants = [...mandatory, ...selected]
    if (cost.cells > remainingCells || cost.repairCells > remainingRepairCells) {
      decisions.push({ ...decisionBase, participantIds: participants.map(snapshot => snapshot.candidateId), excludedHistoricalIds,
        status: 'budget-insufficient', reasonCodes: ['scope-preparation-budget'] }); continue
    }
    const plan = stagePlan({ stage: 'baseline-probe', partition: 'seed', universeDigest: seed.digest,
      taskSetSizeResolutionDigest: resolution.digest, scopeDigest: scope.digest, taskIds: scope.taskIds,
      participantIds: participants.map(snapshot => snapshot.candidateId), prerequisiteDecisionDigests: [parents.digest, proposed.digest],
      selectionRuleDigest: integrity })
    pending.push({ familyId: oldScope.familyId, oldScopeDigest: oldScope.digest, scope, plan, participants, excludedHistoricalIds })
    remainingCells -= cost.cells; remainingRepairCells -= cost.repairCells
    for (const key of cost.keys) planned.add(key)
  }
  return { base, pending, decisions }
}

export function completeGepaScopePreparation(planned: GepaPreparationPlan, results: Record<string, StageResult>,
  seed: TaskUniverse, settings: SearchSettings): ScopeEpochPreparation {
  const scopes: EvaluationScope[] = [], plans: StageEvaluationPlan[] = [], settled: StageResult[] = []
  const decisions = [...planned.decisions]
  for (const [index, item] of planned.pending.entries()) {
    let eligible = true
    const reasons: string[] = []
    plans.push(item.plan)
    for (const [participantIndex, snapshot] of item.participants.entries()) {
      const result = results[`prepare-${index}-${participantIndex}`]
      if (!result) { eligible = false; reasons.push(`missing-preparation:${snapshot.candidateId}`); continue }
      settled.push(result)
      if (result.failure || !passesExploration(item.scope,
        profile(seed, item.plan, snapshot, result, settings.search.process.mode, item.scope.weights), seed)) {
        eligible = false
        reasons.push(result.failure ? `${result.failure.kind}:${result.failure.code}` : `incomplete-or-ineligible:${snapshot.candidateId}`)
      }
    }
    if (eligible) scopes.push(item.scope)
    decisions.push({ familyId: item.familyId, previousScopeDigest: item.oldScopeDigest,
      proposedScopeDigest: item.scope.digest, participantIds: item.participants.map(snapshot => snapshot.candidateId),
      excludedHistoricalIds: item.excludedHistoricalIds, status: eligible ? 'prepared' : 'baseline-ineligible', reasonCodes: reasons })
  }
  return seal({ ...planned.base, scopes, plans, results: settled, decisions })
}

/** Keep the old parent policy and its seed-only, validated input projection. */
export function chooseGepaParents(archive: ResearchArchive, policy: ParentSelectionPolicy, roundId: string,
  maxCandidates: number, seed: number, championId: string): ParentSelectionDecision {
  verifyDigest(archive)
  return selectParentsWithPolicy(archive, policy, maxCandidates, roundId, seed, championId)
}

/** The old cluster, representative-scope, and workplan rules, applied to frozen operation results. */
export function planGepaWorks(input: { archive: ResearchArchive; parents: ParentSelectionDecision; baselines: Record<string, GepaBaseline>;
  dossiers: Record<string, DiagnosisDossier>; preparation: ScopeEpochPreparation; seed: TaskUniverse; settings: SearchSettings; roundId: string; roundIndex: number;
  maxCandidates: number; deadlineAt: number; remainingGenerationTokens: number; remainingGenerationRequests: number }):
  { works: GepaWork[]; clusters: FailureCluster[]; scopes: EvaluationScope[]; reasons: string[] } {
  const { archive, parents, baselines, dossiers, seed, settings } = input
  const resolution = resolveSizing(seed, settings.search.taskSetSizing)
  const works: GepaWork[] = [], diagnosed: FailureCluster[] = [], scopes = [...archive.scopes, ...input.preparation.scopes], reasons: string[] = []
  const used = new Set<string>()
  for (const batch of parents.batches) {
    const parent = archive.snapshots.find(item => item.digest === batch.parentSnapshotDigest)
    const sourceScope = archive.scopes.find(item => item.digest === batch.sourceScopeDigest)
    const baselineRecord = baselines[batch.batchId], dossier = dossiers[batch.batchId]
    const baseline = baselineRecord?.result
    if (!parent || !sourceScope || !baseline || !dossier || baseline.failure || dossier.failure) {
      reasons.push(`parent-baseline-or-diagnosis-unavailable:${batch.batchId}`); continue
    }
    verifyDigest(baseline); verifyDigest(dossier)
    if (dossier.parentSnapshotDigest !== parent.digest || !dossier.baselineEvidenceDigests.includes(baseline.digest)) {
      throw new Error('GEPA diagnosis does not reference its frozen parent baseline')
    }
    const families = clusters(dossier, seed, settings.promotion.protectedTasks.filter(guard => guard.partition === 'seed').map(guard => guard.taskId))
    diagnosed.push(...families)
    const parentScope = input.preparation.scopes.find(scope => scope.familyId === sourceScope.familyId) ?? sourceScope
    const p = profile(seed, baselineRecord.plan, parent, baseline,
    settings.search.process.mode, parentScope.weights)
    if (seed.objective ? !scoringComplete(p) : !p.outcomeComplete) {
      reasons.push(`parent-baseline-incomplete:${batch.batchId}`); continue
    }
    const successful = p.tasks.filter(task => task.outcome !== undefined && task.outcome >= seed.tasks.find(item => item.id === task.taskId)!.successUtility).map(task => task.taskId)
    const shared = input.preparation.sharedTaskIds
    const sampler = samplingEvidence(seed, seal({ archiveDigest: archive.digest, baselineDigest: baseline.digest }).digest,
      [...archive.clusters, ...families], [...archive.results, ...input.preparation.results, baseline])
    let allocated = 0
    for (const family of families) {
      if (allocated >= batch.maxCandidateSlots || works.length >= input.maxCandidates) break
      const scope = scopes.filter(item => item.familyId === family.familyId).sort((a, b) => b.epoch - a.epoch)[0]
        ?? createScope(seed, resolution, settings.search, family, shared, input.preparation.epoch, sampler)
      if (!scope) { reasons.push(`no-representative:${family.familyId}`); continue }
      for (const hypothesis of family.hypotheses.slice(0, settings.search.diagnosis.candidatesPerFamily)) {
        if (allocated >= batch.maxCandidateSlots || works.length >= input.maxCandidates) break
        const hypothesisKey = digestJson([parent.digest, family.familyId, hypothesis])
        if (used.has(hypothesisKey)) continue
        const candidateId = `${input.roundId}-candidate-${works.length}`
        const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: seed.digest,
          taskSetSizeResolutionDigest: resolution.digest, scopeDigest: scope.digest, taskIds: scope.taskIds,
          participantIds: [candidateId, parent.candidateId], prerequisiteDecisionDigests: [parents.digest], selectionRuleDigest: integrity })
        const slots = Math.max(1, input.maxCandidates - works.length)
        const reservedTokens = works.reduce((total, work) => total + (work.workplan.generationBudget.maxTokens ?? 0), 0)
        const reservedRequests = works.reduce((total, work) => total + (work.workplan.generationBudget.maxModelRequests ?? 0), 0)
        if (input.remainingGenerationTokens - reservedTokens < slots || input.remainingGenerationRequests - reservedRequests < slots) {
          reasons.push('generation-budget-exhausted'); continue
        }
        const workplan: CandidateWorkPlan = seal({ candidateId, batchId: batch.batchId, parentSnapshotDigest: parent.digest,
          dossierDigest: dossier.digest, clusterDigest: family.digest, familyId: family.familyId, hypothesis,
          targetTaskIds: family.taskIds, requiredDiagnosisRefs: family.evidenceRefs, modificationPaths: family.modificationPaths,
          scopeDigest: scope.digest, localStagePlanDigest: plan.digest,
          modificationBoundaryRule: { requiredSeedTaskIds: sorted(seed.tasks.map(task => task.id)), onInsufficientScope: 'retain-research-only' as const },
          generationBudget: {
            maxTokens: Math.floor((input.remainingGenerationTokens - reservedTokens) / slots),
            maxModelRequests: Math.floor((input.remainingGenerationRequests - reservedRequests) / slots),
            deadlineAt: input.deadlineAt } })
        works.push({ batchId: batch.batchId, parent, dossier, cluster: family, scope, plan, workplan, parentBaseline: baseline })
        allocated++; used.add(hypothesisKey)
        if (!scopes.some(item => item.digest === scope.digest)) scopes.push(scope)
      }
    }
  }
  return { works, clusters: diagnosed, scopes, reasons }
}

/** Stage-local ranking and the same old bridge quota/affordability selector. */
export async function chooseGepaBridge(input: { locals: GepaLocal[]; anchor: Snapshot; seed: TaskUniverse;
  settings: SearchSettings; roundIndex: number; remainingCells: number; remainingRepairCells: number;
  knownCells: ResearchArchive['results'][number]['cells'] }): Promise<BridgeSelectionDecision> {
  const { locals, anchor, seed, settings } = input
  const nominees = new Map<string, GepaLocal>()
  for (const scope of new Map(locals.map(item => [item.work.scope.digest, item.work.scope])).values()) {
    const eligible = locals.filter(item => item.work.scope.digest === scope.digest && !item.result.failure
      && (!item.outsideBoundary || item.broaderScopeSatisfied))
    const ranks = rankProfiles(seed, eligible.map(item => ({ id: item.snapshot.candidateId,
      profile: profile(seed, item.work.plan, item.snapshot, item.result, settings.promotion.process.mode, scope.weights) })))
    const first = eligible.find(item => item.snapshot.candidateId === ranks[0])
    if (first) nominees.set(scope.digest, first)
  }
  const known = new Map<string, { valid: boolean }>()
  for (const cell of input.knownCells) {
    const key = cellKey(cell.identity), previous = known.get(key)
    known.set(key, { valid: (previous?.valid ?? false) || validOutcome(cell) })
  }
  return bridgeSelection(seed, resolveSizing(seed, settings.search.taskSetSizing), settings.search, input.roundIndex,
    [...nominees.values()].map(item => ({ candidateId: item.snapshot.candidateId, scope: item.work.scope })), anchor.candidateId,
    sorted([...settings.promotion.protectedTasks, ...settings.promotion.protectedAssertions]
      .filter(guard => guard.partition === 'seed').map(guard => guard.taskId)),
    async (ids, tasks) => {
      let cells = 0, repairCells = 0
      for (const id of ids) {
        const snapshot = id === anchor.candidateId ? anchor : locals.find(item => item.snapshot.candidateId === id)!.snapshot
        for (const taskId of tasks) for (const slot of repetitionsForTask(seed, taskId)) {
          const cell = known.get(cellKey(cellIdentity(seed, taskId, slot.index, snapshot)))
          if (!cell?.valid) { cells++; if (cell) repairCells++ }
        }
      }
      return cells <= input.remainingCells && repairCells <= input.remainingRepairCells
    })
}

/** Archive membership follows the old seed-only builder; held-out is never admitted. */
export function updateGepaArchive(input: { previous: ResearchArchive; seed: TaskUniverse; settings: SearchSettings;
  anchor: Snapshot; championId: string; locals: GepaLocal[]; works: GepaWork[]; clusters: FailureCluster[];
  scopes: EvaluationScope[]; parentBaselines: GepaBaseline[]; stagePlans: StageEvaluationPlan[];
  stageResultsBeforeLocal: StageResult[]; stageResultsAfterLocal: StageResult[]; evolutionId: string }): ResearchArchive {
  return buildArchive({ evolutionId: input.evolutionId, previous: input.previous, universe: input.seed,
    snapshots: [input.anchor, ...input.locals.map(item => item.snapshot)], scopes: input.scopes, clusters: input.clusters,
    results: [...input.parentBaselines.map(item => item.result), ...input.stageResultsBeforeLocal,
      ...input.locals.map(item => item.result), ...input.stageResultsAfterLocal],
    plans: [...input.parentBaselines.map(item => item.plan), ...input.works.map(item => item.plan), ...input.stagePlans], config: input.settings.search,
    championId: input.championId })
}
