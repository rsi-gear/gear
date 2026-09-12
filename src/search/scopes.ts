import { digestJson } from '../state/digest.js'
import { invariant, scopeEquivalenceDigest, seal, sorted, unique, verifyDigest } from './contracts.js'
import type { BridgeSelectionDecision, Bucket, EvaluationScope, FailureCluster, SearchConfig, StageEvaluationPlan, TaskSetResolution, TaskUniverse } from './types.js'
import type { ScopeSamplingEvidence } from './types.js'
import { representativeOrder, crossOrder } from './scope-sampling.js'

export function order(seed: string, ids: readonly string[]): string[] {
  return sorted(ids).sort((a, b) => digestJson([seed, a]).localeCompare(digestJson([seed, b])) || a.localeCompare(b))
}
/** Round robin over declared strata; estimated cost alternates cheap and expensive representatives. */
export function stratified(universe: TaskUniverse, ids: readonly string[], seed: string): string[] {
  const groups = new Map<string, string[]>()
  for (const id of sorted(ids)) {
    const task = universe.tasks.find(t => t.id === id)
    invariant(task, 'sampling task outside universe')
    const list = groups.get(task.stratum) ?? []; list.push(id); groups.set(task.stratum, list)
  }
  const strata = order(seed, [...groups.keys()])
  for (const [key, values] of groups) groups.set(key, order(seed, values).sort((a, b) => universe.tasks.find(t => t.id === a)!.estimatedCost - universe.tasks.find(t => t.id === b)!.estimatedCost))
  const result: string[] = []
  let high = false
  while ([...groups.values()].some(v => v.length)) {
    for (const key of strata) { const bucket = groups.get(key)!; const id = high ? bucket.pop() : bucket.shift(); if (id) result.push(id) }
    high = !high
  }
  return result
}
export function sharedTasks(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, successfulIds: string[], epoch = 1): string[] {
  const core = sorted(config.scopeSampling.sharedCoreTaskIds ?? [])
  const count = resolution.quantities.shared.resolved
  invariant(core.length <= count, 'shared core exceeds capacity')
  return [...core, ...stratified(universe, successfulIds.filter(id => !core.includes(id)), `${config.seed}:shared${epoch === 1 ? '' : `:epoch-${epoch}`}`)].slice(0, count)
}
export function createScope(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, cluster: Pick<FailureCluster, 'familyId' | 'taskIds'> & Partial<Pick<FailureCluster, 'successfulControlTaskIds' | 'modificationPaths'>>, shared: string[], epoch = 1, evidence?: ScopeSamplingEvidence): EvaluationScope | undefined {
  if (evidence) { verifyDigest(evidence); invariant(evidence.universeDigest === universe.digest, 'sampling evidence universe changed') }
  const used = new Set(shared)
  const localSeed = `${config.seed}:${cluster.familyId}:local${epoch === 1 ? '' : `:epoch-${epoch}`}`
  const controls = representativeOrder(universe, (cluster.successfulControlTaskIds ?? []).filter(id => !used.has(id) && !cluster.taskIds.includes(id)), `${localSeed}:controls`, evidence)
  const localCount = resolution.quantities.local.resolved, controlSlots = localCount >= 2 && controls.length ? 1 : 0
  const failures = representativeOrder(universe, cluster.taskIds.filter(id => !used.has(id)), localSeed, evidence)
  const local = [...failures.slice(0, localCount - controlSlots), ...controls.slice(0, controlSlots)]
  for (const id of [...failures, ...controls]) if (local.length < localCount && !local.includes(id)) local.push(id)
  for (const id of local) used.add(id)
  if (!cluster.taskIds.some(id => used.has(id))) return undefined
  const crossSelection = crossOrder(universe, new Set([...used, ...cluster.taskIds]), cluster.familyId, cluster.modificationPaths ?? [], `${config.seed}:${cluster.familyId}:cross${epoch === 1 ? '' : `:epoch-${epoch}`}`, evidence)
  const cross = crossSelection.ids.slice(0, resolution.quantities.cross.resolved)
  const buckets = { shared: [...shared], local, cross }
  const guards = structuredClone(config.explorationGuards)
  const taskIds = sorted([...Object.values(buckets).flat(), ...guards.map(g => g.taskId)])
  const denominator = Object.entries(buckets).reduce((sum, [key, values]) => sum + (values.length ? config.scopeSampling.bucketWeights[key as Bucket] : 0), 0)
  invariant(denominator > 0, 'nonempty scope has no positive scoring weight')
  const weights: Record<string, number> = Object.fromEntries(taskIds.map(id => [id, 0]))
  for (const name of ['shared', 'local', 'cross'] as const) {
    for (const id of buckets[name]) weights[id] = config.scopeSampling.bucketWeights[name] / denominator / buckets[name].length
  }
  const sampling = Object.fromEntries((['shared', 'local', 'cross'] as const).map(name => [name, {
    requested: resolution.quantities[name].resolved, selected: buckets[name].length,
    reasons: buckets[name].length < resolution.quantities[name].resolved ? ['eligible-pool-exhausted-after-deduplication'] : [],
  }])) as EvaluationScope['sampling']
  if (resolution.quantities.shared.resolved + resolution.quantities.local.resolved + resolution.quantities.cross.resolved > universe.tasks.length) {
    for (const name of ['shared', 'local', 'cross'] as const) if (sampling[name].selected < sampling[name].requested) sampling[name].reasons.push('rounded-targets-exceed-universe:shared-local-cross-priority')
  }
  if (local.some(id => controls.includes(id))) sampling.local.reasons.push('successful-control-included')
  else if (controls.length) sampling.local.reasons.push('successful-control-quota-unavailable')
  if (cross.some(id => crossSelection.generalIds.includes(id))) sampling.cross.reasons.push('general-seed-sampling-fallback')
  return seal({ familyId: cluster.familyId, epoch, universeDigest: universe.digest, taskSetSizeResolutionDigest: resolution.digest,
    buckets, taskIds, weights, guards, sampling,
    ...(evidence ? { samplingEvidenceDigest: evidence.digest } : {}),
    equivalenceDigest: scopeEquivalenceDigest({ universeDigest: universe.digest, taskIds, weights, guards }),
  })
}
export function stagePlan(input: Omit<StageEvaluationPlan, 'digest'>): StageEvaluationPlan {
  invariant(input.taskIds.length > 0 && unique(input.participantIds).length === input.participantIds.length, 'invalid stage membership')
  const { digest: ignored, ...body } = input as StageEvaluationPlan
  return seal({ ...body, taskIds: sorted(input.taskIds), participantIds: sorted(input.participantIds) })
}
export async function bridgeSelection(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, roundIndex: number, nominees: Array<{ candidateId: string; scope: EvaluationScope }>, championId: string, guards: string[], affordable: (ids: string[], tasks: string[]) => boolean | Promise<boolean>): Promise<BridgeSelectionDecision> {
  const byFamily = [...nominees].sort((a, b) => a.scope.familyId.localeCompare(b.scope.familyId))
  const offset = byFamily.length ? roundIndex % byFamily.length : 0
  const ordered = [...byFamily.slice(offset), ...byFamily.slice(0, offset)]
  const selected = ordered.slice(0, config.evaluationStages.bridge.maxCandidates)
  const exclusions: BridgeSelectionDecision['exclusions'] = ordered.slice(selected.length).map(c => ({ candidateId: c.candidateId,
    scopeDigest: c.scope.digest, reason: config.evaluationStages.bridge.maxCandidates === 0 ? 'bridge-disabled' : 'group-quota' }))
  const capacity = resolution.quantities.bridge.resolved
  while (selected.length && capacity > 0) {
    const required = sorted([...selected.flatMap(c => c.scope.taskIds), ...guards])
    if (required.length <= capacity) {
      const tasks = [...required, ...stratified(universe, universe.tasks.map(t => t.id).filter(id => !required.includes(id)), `${config.seed}:bridge:${roundIndex}`)].slice(0, capacity)
      const ids = [...selected.map(c => c.candidateId), championId]
      if (await affordable(ids, tasks)) return { plan: stagePlan({
        stage: 'bridge', partition: 'seed', universeDigest: universe.digest, taskSetSizeResolutionDigest: resolution.digest,
        scopeDigest: digestJson({ bridge: tasks }), taskIds: tasks, participantIds: ids, prerequisiteDecisionDigests: [],
        selectionRuleDigest: digestJson(config.evaluationStages.bridge),
      }), skipped: sorted(exclusions.map(e => e.candidateId)), exclusions }
    }
    const excluded = selected.pop()!
    exclusions.push({ candidateId: excluded.candidateId, scopeDigest: excluded.scope.digest,
      reason: required.length > capacity ? 'bridge-capacity' : 'bridge-budget' })
  }
  exclusions.push(...selected.map(c => ({ candidateId: c.candidateId, scopeDigest: c.scope.digest, reason: 'bridge-disabled' as const })))
  return { skipped: sorted(exclusions.map(e => e.candidateId)), exclusions }
}
