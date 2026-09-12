import { digestJson } from '../state/digest.js'
import { comparisonKey, invariant, seal, sorted, verifyDigest } from './contracts.js'
import { completeEvidence, profile } from './evidence.js'
import type { EvidenceProfile, EvaluationScope, ParentSelectionDecision, ResearchArchive, ScopeView, SearchConfig, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

export function passesExploration(scope: EvaluationScope, p: EvidenceProfile, universe: TaskUniverse): boolean {
  return p.outcomeComplete && scope.guards.every(g => {
    const task = universe.tasks.find(t => t.id === g.taskId)!, row = p.tasks.find(t => t.taskId === g.taskId)
    return row?.outcome !== undefined && comparisonKey(row.outcome, task.outcome.comparisonQuantum) >= comparisonKey(g.rule === 'must-pass' ? task.successUtility : g.minimumUtility!, task.outcome.comparisonQuantum)
  })
}
export function scopeView(scope: EvaluationScope, universe: TaskUniverse, snapshots: Snapshot[], records: Array<{ snapshot: Snapshot; result: StageResult; plan: StageEvaluationPlan }>, config: SearchConfig, championId: string): ScopeView {
  verifyDigest(scope)
  const profiles = new Map<string, EvidenceProfile>(), times = new Map<string, string>()
  const pending: string[] = []
  for (const record of records) {
    if (record.plan.scopeDigest !== scope.digest) continue
    const p = profile(universe, record.plan, record.snapshot, record.result, config.process.mode, scope.weights)
    if (!passesExploration(scope, p, universe)) { pending.push(record.snapshot.candidateId); continue }
    profiles.set(record.snapshot.candidateId, p)
    times.set(record.snapshot.candidateId, record.result.cells.map(c => c.completedAt).sort().at(-1) ?? '')
    if (!p.processComplete) pending.push(record.snapshot.candidateId)
  }
  const representatives: Record<string, string> = {}, trees = new Map<string, string>()
  const ids = [...profiles.keys()].sort((a, b) => times.get(a)!.localeCompare(times.get(b)!) || a.localeCompare(b))
  for (const id of ids) {
    const snapshot = snapshots.find(s => s.candidateId === id)!
    const group = digestJson({ tree: snapshot.tree, manifest: snapshot.manifestDigest })
    const representative = trees.get(group) ?? id
    trees.set(group, representative); representatives[id] = representative
  }
  const eligible = ids.filter(id => representatives[id] === id).sort()
  const processEligible = eligible.filter(id => profiles.get(id)!.processComplete)
  const fronts: ScopeView['fronts'] = []
  for (const channel of ['outcome', 'process'] as const) for (const taskId of scope.taskIds) {
    const values = (channel === 'outcome' ? eligible : processEligible).flatMap(id => {
      const value = profiles.get(id)!.tasks.find(t => t.taskId === taskId)?.[channel === 'outcome' ? 'outcomeKey' : 'processKey']
      return value === undefined ? [] : [{ id, key: BigInt(value) }]
    })
    if (!values.length) continue
    const max = values.reduce((m, v) => v.key > m ? v.key : m, values[0]!.key)
    fronts.push({ taskId, channel, candidateIds: values.filter(v => v.key === max).map(v => v.id), informative: values.some(v => v.key !== max) })
  }
  const informative = fronts.filter(f => f.informative && scope.weights[f.taskId]! > 0)
  const live = new Set(eligible), prunedIds: string[] = []
  const traversal = [...eligible].sort((a, b) => profiles.get(a)!.outcome! - profiles.get(b)!.outcome! || a.localeCompare(b))
  if (informative.length) for (const id of traversal) {
    const memberships = informative.filter(f => f.candidateIds.includes(id))
    if (memberships.every(f => f.candidateIds.some(other => other !== id && live.has(other)))) { live.delete(id); prunedIds.push(id) }
  }
  const probability: Record<string, number> = {}
  if (!informative.length && eligible.length) {
    const fallback = eligible.includes(championId) ? championId : [...eligible].sort((a, b) => profiles.get(b)!.outcome! - profiles.get(a)!.outcome! || a.localeCompare(b))[0]!
    probability[fallback] = 1
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
    fronts, representatives, prunedIds, conditionalParentProbabilities: probability, pendingEvidenceIds: sorted(pending) })
}

export function buildArchive(input: { evolutionId: string; previous?: ResearchArchive; universe: TaskUniverse; snapshots: Snapshot[]; scopes: EvaluationScope[]; results: StageResult[]; plans: StageEvaluationPlan[]; config: SearchConfig; championId: string }): ResearchArchive {
  const { previous, universe } = input
  if (previous) { verifyDigest(previous); invariant(previous.universeDigest === universe.digest && previous.evolutionId === input.evolutionId, 'archive cohort identity changed') }
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
  for (const result of resultHistory.values()) {
    verifyDigest(result)
    const plan = plans.get(result.stagePlanDigest), snapshot = [...snapshots.values()].find(s => s.digest === result.snapshotDigest)
    invariant(plan && snapshot && plan.partition === 'seed', 'archive evidence has no seed plan/snapshot')
    const key = `${plan.digest}:${snapshot.digest}`, old = records.get(key)
    if (old && old.result.digest !== result.digest) {
      invariant(result.supersedesEvidenceDigest === old.result.digest, 'evidence revision must explicitly supersede prior support')
      completeEvidence(old.result, result.cells)
    }
    records.set(key, { snapshot, result, plan })
  }
  const scopes = new Map((previous?.scopes ?? []).map(s => [s.digest, s]))
  for (const scope of input.scopes) { verifyDigest(scope); invariant(scope.universeDigest === universe.digest, 'scope universe changed'); scopes.set(scope.digest, scope) }
  const latest = new Map<string, EvaluationScope>(), equivalences = new Set<string>()
  for (const scope of [...scopes.values()].sort((a, b) => b.epoch - a.epoch || a.familyId.localeCompare(b.familyId))) {
    if (latest.has(scope.familyId) || equivalences.has(scope.equivalenceDigest)) continue
    const view = scopeView(scope, universe, [...snapshots.values()], [...records.values()], input.config, input.championId)
    if (!Object.keys(view.conditionalParentProbabilities).length) continue
    latest.set(scope.familyId, scope); equivalences.add(scope.equivalenceDigest)
  }
  if (latest.size > 1) latest.delete('bootstrap')
  const scopeViews = [...scopes.values()].map(s => scopeView(s, universe, [...snapshots.values()], [...records.values()], input.config, input.championId))
  const scopeProbabilities: Record<string, number> = {}, parentProbabilities: Record<string, number> = {}
  for (const scope of latest.values()) {
    scopeProbabilities[scope.digest] = 1 / latest.size
    const view = scopeViews.find(v => v.scopeDigest === scope.digest)!
    for (const [id, p] of Object.entries(view.conditionalParentProbabilities)) parentProbabilities[id] = (parentProbabilities[id] ?? 0) + p / latest.size
  }
  return seal({ schemaVersion: 1 as const, evolutionId: input.evolutionId, revision: (previous?.revision ?? -1) + 1, universeDigest: universe.digest,
    snapshots: [...snapshots.values()], scopes: [...scopes.values()], results: [...resultHistory.values()], plans: [...plans.values()], scopeViews,
    scopeProbabilities, parentProbabilities, activeParentIds: Object.keys(parentProbabilities).sort(),
  })
}

function draw(probabilities: Record<string, number>, seed: string, index: number): string {
  const entries = Object.entries(probabilities).sort(([a], [b]) => a.localeCompare(b))
  invariant(entries.length > 0, 'blocked-no-eligible-parent')
  const sample = parseInt(digestJson([seed, index]).slice(7, 20), 16) / 0x10000000000000
  let total = 0
  for (const [id, p] of entries) { total += p; if (sample < total) return id }
  return entries.at(-1)![0]
}
export function selectParents(archive: ResearchArchive, config: SearchConfig, maxCandidates: number, roundId: string): ParentSelectionDecision {
  verifyDigest(archive)
  const randomSeed = digestJson([config.seed, roundId, archive.digest])
  const batches = Array.from({ length: config.parentBatchCount }, (_, i) => {
    const scope = draw(archive.scopeProbabilities, randomSeed, i * 2)
    const view = archive.scopeViews.find(v => v.scopeDigest === scope)!
    const parent = draw(view.conditionalParentProbabilities, randomSeed, i * 2 + 1)
    return { batchId: `${roundId}-batch-${i}`, sourceScopeDigest: scope, parentSnapshotDigest: archive.snapshots.find(s => s.candidateId === parent)!.digest,
      maxCandidateSlots: Math.floor(maxCandidates / config.parentBatchCount) + (i < maxCandidates % config.parentBatchCount ? 1 : 0), drawIndex: i * 2,
    }
  })
  return seal({ archiveDigest: archive.digest, algorithmRef: 'sha256-counter-v1' as const, randomSeed, batches })
}
