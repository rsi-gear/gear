import { digestJson } from '../state/digest.js'
import { comparisonKey, invariant, repetitionsForTask, seal, sorted, validateScope, verifyDigest } from './contracts.js'
import { assertConsistentCells, cellIdentity, cellKey, completeEvidence, profile, validOutcome } from './evidence.js'
import { selectParentsWithPolicy } from './parent-selection.js'
import { championGepaPolicy, resolveParentPolicyRef, scopedFrontierPolicy } from './policies/parents.js'
import { validateSearchSchema } from './schema.js'
import type { EvaluationScope, EvidenceCell, EvidenceProfile, FailureCluster, ParentSelectionDecision, ResearchArchive, ScopeView, SearchConfig, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'
import { scoringComplete, scoringKey } from './objective.js'

export function passesExploration(scope: EvaluationScope, p: EvidenceProfile, universe: TaskUniverse): boolean {
  return (universe.objective ? scoringComplete(p) : p.outcomeComplete) && scope.guards.every(g => {
    const task = universe.tasks.find(t => t.id === g.taskId)!, row = p.tasks.find(t => t.taskId === g.taskId)
    if (universe.objective) {
      const metric = g.rule === 'must-pass' ? 'pass_rate' : g.metric!, value = row?.rawMetrics?.[metric], contract = universe.rawMetricContracts!.find(c => c.id === metric)
      if (!contract || value?.status !== 'available') return false
      const difference = comparisonKey(value.value!, contract.comparisonPrecision) - comparisonKey(g.rule === 'must-pass' ? 1 : g.minimumUtility!, contract.comparisonPrecision)
      return contract.direction === 'maximize' ? difference >= 0n : difference <= 0n
    }
    return row?.outcome !== undefined && comparisonKey(row.outcome, task.outcome.comparisonQuantum) >= comparisonKey(g.rule === 'must-pass' ? task.successUtility : g.minimumUtility!, task.outcome.comparisonQuantum)
  })
}
export function scopeView(scope: EvaluationScope, universe: TaskUniverse, snapshots: Snapshot[], records: Array<{ snapshot: Snapshot; result: StageResult; plan: StageEvaluationPlan }>, config: SearchConfig, championId: string, equivalentScopes: ReadonlySet<string> = new Set([scope.digest])): ScopeView {
  validateScope(scope, universe)
  const profiles = new Map<string, EvidenceProfile>(), times = new Map<string, number>()
  const observed = new Set<string>(), guardRejected = new Set<string>()
  for (const record of records) {
    if (!equivalentScopes.has(record.plan.scopeDigest)) continue
    invariant(digestJson(sorted(record.plan.taskIds)) === digestJson(scope.taskIds), 'stage task manifest does not cover its complete scope')
    const p = profile(universe, record.plan, record.snapshot, record.result, config.process.mode, scope.weights)
    const id = record.snapshot.candidateId
    observed.add(id)
    if (!passesExploration(scope, p, universe)) { if (p.outcomeComplete) guardRejected.add(id); continue }
    const previous = profiles.get(id)
    if (!previous || !universe.objective && !previous.processComplete && p.processComplete) profiles.set(id, p)
    const completedAt = Math.max(...record.result.cells.map(c => Date.parse(c.completedAt)))
    if (!times.has(id) || completedAt < times.get(id)!) times.set(id, completedAt)
  }
  const representatives: Record<string, string> = {}, trees = new Map<string, string>()
  const ids = [...profiles.keys()].sort((a, b) => times.get(a)! - times.get(b)! || a.localeCompare(b))
  for (const id of ids) {
    const snapshot = snapshots.find(s => s.candidateId === id)!
    const group = digestJson({ tree: snapshot.tree, manifest: snapshot.manifestDigest })
    const representative = trees.get(group) ?? id
    trees.set(group, representative); representatives[id] = representative
  }
  const eligible = ids.filter(id => representatives[id] === id).sort()
  const processEligible = universe.objective ? [] : eligible.filter(id => profiles.get(id)!.processComplete)
  const fronts: ScopeView['fronts'] = []
  for (const channel of universe.objective ? ['objective'] as const : ['outcome', 'process'] as const) for (const taskId of scope.taskIds) {
    const values = (channel !== 'process' ? eligible : processEligible).flatMap(id => {
      const value = profiles.get(id)!.tasks.find(t => t.taskId === taskId)?.[channel === 'objective' ? 'objectiveKey' : channel === 'outcome' ? 'outcomeKey' : 'processKey']
      return value === undefined ? [] : [{ id, key: BigInt(value) }]
    })
    if (!values.length) continue
    const max = values.reduce((m, v) => v.key > m ? v.key : m, values[0]!.key)
    fronts.push({ taskId, channel, candidateIds: values.filter(v => v.key === max).map(v => v.id), informative: values.some(v => v.key !== max) })
  }
  const informative = fronts.filter(f => f.informative && scope.weights[f.taskId]! > 0)
  const live = new Set(eligible), prunedIds: string[] = []
  const compareOutcome = (a: string, b: string): number => {
    const difference = BigInt(scoringKey(profiles.get(a)!)!) - BigInt(scoringKey(profiles.get(b)!)!)
    return difference === 0n ? a.localeCompare(b) : difference < 0n ? -1 : 1
  }
  const traversal = [...eligible].sort(compareOutcome)
  if (informative.length) for (const id of traversal) {
    const memberships = informative.filter(f => f.candidateIds.includes(id))
    if (memberships.every(f => f.candidateIds.some(other => other !== id && live.has(other)))) { live.delete(id); prunedIds.push(id) }
  }
  const probability: Record<string, number> = {}
  if (!informative.length && eligible.length) {
    const fallback = eligible.includes(championId) ? championId : [...eligible].sort((a, b) => {
      const difference = BigInt(scoringKey(profiles.get(b)!)!) - BigInt(scoringKey(profiles.get(a)!)!)
      return difference === 0n ? a.localeCompare(b) : difference < 0n ? -1 : 1
    })[0]!
    probability[fallback] = 1
  } else if (universe.objective) {
    for (const front of informative) for (const id of front.candidateIds.filter(id => live.has(id))) probability[id] = (probability[id] ?? 0) + scope.weights[front.taskId]!
    const total = Object.values(probability).reduce((a, b) => a + b, 0)
    for (const id of Object.keys(probability)) probability[id] = probability[id]! / total
  } else {
    const channels = {} as Record<'outcome' | 'process', Record<string, number>>
    for (const channel of ['outcome', 'process'] as const) {
      const weights: Record<string, number> = {}
      for (const front of informative.filter(f => f.channel === channel)) for (const id of front.candidateIds.filter(id => live.has(id))) weights[id] = (weights[id] ?? 0) + scope.weights[front.taskId]!
      const total = Object.values(weights).reduce((a, b) => a + b, 0)
      channels[channel] = Object.fromEntries(Object.entries(weights).map(([id, weight]) => [id, weight / total]))
    }
    const hasOutcome = Object.keys(channels.outcome).length > 0, hasProcess = Object.keys(channels.process).length > 0
    const rho = !hasProcess ? 0 : !hasOutcome ? 1 : config.process.parentBudgetFraction
    for (const id of live) {
      const value = (1 - rho) * (channels.outcome[id] ?? 0) + rho * (channels.process[id] ?? 0)
      if (value > 0) probability[id] = value
    }
  }
  return seal({ scopeDigest: scope.digest, outcomeEligibleIds: eligible, processEligibleIds: processEligible,
    fronts, representatives, prunedIds, conditionalParentProbabilities: probability,
    pendingEvidenceIds: [...observed].filter(id => !guardRejected.has(id) && (!profiles.has(id) || !scoringComplete(profiles.get(id)!))).sort(),
    ineligibleIds: [...guardRejected].filter(id => !profiles.has(id)).sort() })
}

export function buildArchive(input: { evolutionId: string; previous?: ResearchArchive; universe: TaskUniverse; snapshots: Snapshot[]; scopes: EvaluationScope[]; results: StageResult[]; plans: StageEvaluationPlan[]; config: SearchConfig; championId: string; includeChampion?: boolean; clusters?: FailureCluster[] }): ResearchArchive {
  const { previous, universe } = input
  const legacyMixture = !input.config.parentPolicy && input.config.parentSampling === 'epsilon-greedy-gepa-v1'
  if (previous) { validateSearchSchema('ResearchArchive', previous); verifyDigest(previous); invariant(previous.universeDigest === universe.digest && previous.evolutionId === input.evolutionId, 'archive cohort identity changed') }
  invariant(universe.partition === 'seed' && input.plans.every(p => p.partition === 'seed' && p.universeDigest === universe.digest), 'held-out evidence is forbidden in archive')
  const snapshots = new Map((previous?.snapshots ?? []).map(s => [s.candidateId, s]))
  for (const snapshot of input.snapshots) {
    verifyDigest(snapshot)
    invariant(!snapshots.has(snapshot.candidateId) || snapshots.get(snapshot.candidateId)!.digest === snapshot.digest, 'candidate identity changed')
    snapshots.set(snapshot.candidateId, snapshot)
  }
  const plans = new Map([...(previous?.plans ?? []), ...input.plans].map(p => [p.digest, p]))
  const resultHistory = new Map([...(previous?.results ?? []), ...input.results].map(r => [r.digest, r]))
  const records = new Map<string, { snapshot: Snapshot; result: StageResult; plan: StageEvaluationPlan }>()
  const cellHistory = new Map<string, EvidenceCell>()
  for (const result of resultHistory.values()) {
    verifyDigest(result)
    const plan = plans.get(result.stagePlanDigest), snapshot = [...snapshots.values()].find(s => s.digest === result.snapshotDigest)
    invariant(plan && snapshot && plan.partition === 'seed', 'archive evidence has no seed plan/snapshot')
    profile(universe, plan, snapshot, result, input.config.process.mode)
    for (const cell of result.cells) {
      const identity = cellKey(cell.identity), oldCell = cellHistory.get(identity)
      if (oldCell) assertConsistentCells(oldCell, cell)
      if (!oldCell || !validOutcome(oldCell) || validOutcome(cell) && (oldCell.process?.status !== 'available' || cell.process?.status === 'available')) cellHistory.set(identity, cell)
    }
    const key = `${plan.digest}:${snapshot.digest}`, old = records.get(key)
    if (old && old.result.digest !== result.digest) {
      invariant(result.supersedesEvidenceDigest === old.result.digest, 'evidence revision must explicitly supersede prior support')
      completeEvidence(old.result, result.cells)
    }
    records.set(key, { snapshot, result, plan })
  }
  const scopes = new Map((previous?.scopes ?? []).map(s => [s.digest, s]))
  for (const scope of input.scopes) scopes.set(scope.digest, scope)
  const epochs = new Map<string, string>(), equivalentScopes = new Map<string, Set<string>>()
  for (const scope of scopes.values()) {
    validateScope(scope, universe)
    const epochKey = digestJson([scope.familyId, scope.epoch])
    invariant(!epochs.has(epochKey) || epochs.get(epochKey) === scope.digest, 'scope epoch manifest changed')
    epochs.set(epochKey, scope.digest)
    const aliases = equivalentScopes.get(scope.equivalenceDigest) ?? new Set<string>()
    aliases.add(scope.digest); equivalentScopes.set(scope.equivalenceDigest, aliases)
  }
  const viewRecords = [...records.values()]
  // A promoted champion's global seed cells can support its existing bootstrap
  // diagnosis scope. This creates no rollout and does not broaden GEPA scopes.
  if (input.includeChampion ?? legacyMixture) {
    const champion = snapshots.get(input.championId)
    const bootstrap = [...scopes.values()].find(s => s.familyId === 'bootstrap')
    if (champion && bootstrap) {
      const cells = bootstrap.taskIds.flatMap(id => repetitionsForTask(universe, id).flatMap(slot => {
        const cell = cellHistory.get(cellKey(cellIdentity(universe, id, slot.index, champion)))
        return cell ? [cell] : []
      }))
      const plan: StageEvaluationPlan = seal({ stage: 'baseline-probe' as const, partition: 'seed' as const, universeDigest: universe.digest,
        taskSetSizeResolutionDigest: bootstrap.taskSetSizeResolutionDigest, scopeDigest: bootstrap.digest, taskIds: bootstrap.taskIds,
        participantIds: [champion.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('champion-baseline-projection-v1') })
      viewRecords.push({ snapshot: champion, plan, result: seal({ stagePlanDigest: plan.digest, snapshotDigest: champion.digest, cells, settled: true }) })
    }
  }
  const scopeViews = [...scopes.values()].map(s => scopeView(s, universe, [...snapshots.values()], viewRecords, input.config, input.championId, equivalentScopes.get(s.equivalenceDigest)!))
  const latest = new Map<string, EvaluationScope>(), equivalences = new Set<string>()
  for (const scope of [...scopes.values()].sort((a, b) => b.epoch - a.epoch || a.familyId.localeCompare(b.familyId))) {
    if (latest.has(scope.familyId) || equivalences.has(scope.equivalenceDigest)) continue
    const view = scopeViews.find(v => v.scopeDigest === scope.digest)!
    if (!Object.keys(view.conditionalParentProbabilities).length) continue
    latest.set(scope.familyId, scope); equivalences.add(scope.equivalenceDigest)
  }
  if (latest.size > 1) latest.delete('bootstrap')
  const scopeProbabilities: Record<string, number> = {}, parentProbabilities: Record<string, number> = {}
  for (const scope of latest.values()) {
    scopeProbabilities[scope.digest] = 1 / latest.size
    const view = scopeViews.find(v => v.scopeDigest === scope.digest)!
    for (const [id, p] of Object.entries(view.conditionalParentProbabilities)) parentProbabilities[id] = (parentProbabilities[id] ?? 0) + p / latest.size
  }
  let parentMixture: ResearchArchive['parentMixture']
  if (legacyMixture) {
    const championProbability = input.config.championProbability ?? 0.5
    invariant(Number.isFinite(championProbability) && championProbability >= 0 && championProbability <= 1, 'invalid champion probability')
    const championScope = [...scopes.values()].filter(s => scopeViews.find(v => v.scopeDigest === s.digest)!.representatives[input.championId] !== undefined)
      .sort((a, b) => b.taskIds.length - a.taskIds.length || b.epoch - a.epoch || a.digest.localeCompare(b.digest))[0]
    invariant(championScope && snapshots.has(input.championId), 'champion has no complete eligible seed scope')
    parentMixture = { strategy: 'epsilon-greedy-gepa-v1', championId: input.championId, championProbability,
      championScopeDigest: championScope.digest, explorationParentProbabilities: { ...parentProbabilities } }
    for (const id of Object.keys(parentProbabilities)) parentProbabilities[id] = parentProbabilities[id]! * (1 - championProbability)
    parentProbabilities[input.championId] = (parentProbabilities[input.championId] ?? 0) + championProbability
    if (!Object.keys(parentMixture.explorationParentProbabilities).length) parentProbabilities[input.championId] = 1
    for (const id of Object.keys(parentProbabilities)) if (parentProbabilities[id] === 0) delete parentProbabilities[id]
  }
  const clusters = [...new Map([...(previous?.clusters ?? []), ...(input.clusters ?? [])].map(c => [c.digest, c])).values()]
  for (const cluster of clusters) {
    verifyDigest(cluster)
    invariant(cluster.taskIds.every(id => universe.tasks.some(t => t.id === id)) && [...snapshots.values()].some(s => s.digest === cluster.parentSnapshotDigest), 'cluster is outside the committed parent seed cohort')
  }
  return seal({ schemaVersion: 1 as const, clusters, evolutionId: input.evolutionId, revision: (previous?.revision ?? -1) + 1, universeDigest: universe.digest,
    snapshots: [...snapshots.values()], scopes: [...scopes.values()], results: [...resultHistory.values()], plans: [...plans.values()], scopeViews,
    scopeProbabilities, parentProbabilities, activeParentIds: Object.keys(parentProbabilities).sort(), ...(parentMixture ? { parentMixture } : {}),
  })
}

/** Compatibility entry point for the built-in presets. Custom policies use the registry/runtime. */
export function selectParents(archive: ResearchArchive, config: SearchConfig, maxCandidates: number, roundId: string): ParentSelectionDecision {
  invariant(!config.parentPolicy, 'resolve custom parent policies through ComponentRegistry')
  const ref = resolveParentPolicyRef(config)
  if (config.parentSampling === 'epsilon-greedy-gepa-v1') {
    invariant(archive.parentMixture?.championProbability === (config.championProbability ?? 0.5), 'parent mixture does not match frozen settings')
    return selectParentsWithPolicy(archive, championGepaPolicy(ref), maxCandidates, roundId, config.seed, archive.parentMixture.championId)
  }
  invariant(!archive.parentMixture, 'legacy selector cannot consume a mixed archive')
  return selectParentsWithPolicy(archive, scopedFrontierPolicy(ref), maxCandidates, roundId, config.seed)
}
