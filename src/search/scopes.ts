import { digestJson } from '../state/digest.js'
import { invariant, seal, sorted, unique } from './contracts.js'
import type { Bucket, EvaluationScope, FailureCluster, SearchConfig, StageEvaluationPlan, TaskSetResolution, TaskUniverse } from './types.js'

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
export function sharedTasks(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, successfulIds: string[]): string[] {
  const core = sorted(config.scopeSampling.sharedCoreTaskIds ?? [])
  const count = resolution.quantities.shared.resolved
  invariant(core.length <= count, 'shared core exceeds capacity')
  return [...core, ...stratified(universe, successfulIds.filter(id => !core.includes(id)), `${config.seed}:shared`)].slice(0, count)
}
export function createScope(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, cluster: FailureCluster, shared: string[], epoch = 1): EvaluationScope | undefined {
  const used = new Set(shared)
  const local = stratified(universe, cluster.taskIds.filter(id => !used.has(id)), `${config.seed}:${cluster.familyId}:local`).slice(0, resolution.quantities.local.resolved)
  for (const id of local) used.add(id)
  if (!cluster.taskIds.some(id => used.has(id))) return undefined
  const cross = stratified(universe, universe.tasks.map(t => t.id).filter(id => !used.has(id) && !cluster.taskIds.includes(id)), `${config.seed}:${cluster.familyId}:cross`).slice(0, resolution.quantities.cross.resolved)
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
  return seal({ familyId: cluster.familyId, epoch, universeDigest: universe.digest, taskSetSizeResolutionDigest: resolution.digest,
    buckets, taskIds, weights, guards, sampling,
    equivalenceDigest: digestJson({ universe: universe.digest, taskIds, weights, guards }),
  })
}
export function stagePlan(input: Omit<StageEvaluationPlan, 'digest'>): StageEvaluationPlan {
  invariant(input.taskIds.length > 0 && unique(input.participantIds).length === input.participantIds.length, 'invalid stage membership')
  const { digest: ignored, ...body } = input as StageEvaluationPlan
  return seal({ ...body, taskIds: sorted(input.taskIds), participantIds: sorted(input.participantIds) })
}
export function bridgeSelection(universe: TaskUniverse, resolution: TaskSetResolution, config: SearchConfig, roundIndex: number, nominees: Array<{ candidateId: string; scope: EvaluationScope }>, championId: string, guards: string[], affordable: (ids: string[], tasks: string[]) => boolean): { plan?: StageEvaluationPlan; skipped: string[] } {
  const byFamily = [...nominees].sort((a, b) => a.scope.familyId.localeCompare(b.scope.familyId))
  const offset = byFamily.length ? roundIndex % byFamily.length : 0
  const selected = [...byFamily.slice(offset), ...byFamily.slice(0, offset)].slice(0, config.evaluationStages.bridge.maxCandidates)
  const skipped: string[] = []
  const capacity = resolution.quantities.bridge.resolved
  while (selected.length && capacity > 0) {
    const required = sorted([...selected.flatMap(c => c.scope.taskIds), ...guards])
    if (required.length <= capacity) {
      const tasks = [...required, ...stratified(universe, universe.tasks.map(t => t.id).filter(id => !required.includes(id)), `${config.seed}:bridge:${roundIndex}`)].slice(0, capacity)
      const ids = [...selected.map(c => c.candidateId), championId]
      if (affordable(ids, tasks)) return { plan: stagePlan({
        stage: 'bridge', partition: 'seed', universeDigest: universe.digest, taskSetSizeResolutionDigest: resolution.digest,
        scopeDigest: digestJson({ bridge: tasks }), taskIds: tasks, participantIds: ids, prerequisiteDecisionDigests: [],
        selectionRuleDigest: digestJson(config.evaluationStages.bridge),
      }), skipped }
    }
    skipped.push(selected.pop()!.candidateId)
  }
  return { skipped: sorted([...skipped, ...selected.map(c => c.candidateId)]) }
}
