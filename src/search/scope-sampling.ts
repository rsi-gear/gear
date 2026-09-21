import { digestJson } from '../state/digest.js'
import { digest, invariant, numeric, repetitionsForTask, seal, sorted, utility, verifyDigest, weightedMean } from './contracts.js'
import { assertCell, assertConsistentCells, cellKey, validOutcome } from './evidence.js'
import type { EvidenceCell, FailureCluster, ScopeSamplingEvidence, StageResult, TaskUniverse } from './types.js'

/** Only committed history and the current planning parent's seed baseline enter this record. */
export function samplingEvidence(universe: TaskUniverse, cutoffDigest: string, clusters: FailureCluster[], results: StageResult[]): ScopeSamplingEvidence {
  invariant(universe.partition === 'seed', 'sampler only accepts seed evidence')
  verifyDigest(universe); digest(cutoffDigest)
  const tasks: ScopeSamplingEvidence['tasks'] = Object.fromEntries(universe.tasks.map(t => [t.id, { familyIds: [], submodes: [], modificationPaths: [] }]))
  for (const cluster of clusters) {
    verifyDigest(cluster)
    for (const id of sorted([...cluster.taskIds, ...(cluster.successfulControlTaskIds ?? [])])) {
      const task = tasks[id]; invariant(task, 'sampling cluster outside universe')
      const feature = cluster.taskFeatures?.find(f => f.taskId === id)
      task.familyIds = sorted([...task.familyIds, cluster.familyId])
      task.submodes = sorted([...task.submodes, ...(feature?.submodes ?? [])])
      task.modificationPaths = sorted([...task.modificationPaths, ...(feature?.modificationPaths ?? cluster.modificationPaths)])
    }
  }
  const cells = new Map<string, EvidenceCell>()
  for (const result of results) {
    verifyDigest(result)
    for (const cell of result.cells) {
      assertCell(cell, cell.identity)
      invariant(universe.tasks.some(t => t.id === cell.identity.taskId && t.contentDigest === cell.identity.taskContentDigest && t.outcome.digest === cell.identity.outcomeContractDigest
        && repetitionsForTask(universe, t.id).some(s => s.index === cell.identity.repetition && s.seed === cell.identity.seed))
        && cell.identity.conditionDigest === universe.conditionDigest, 'sampling evidence is outside frozen seed conditions')
      const key = cellKey(cell.identity), old = cells.get(key)
      if (old) assertConsistentCells(old, cell)
      if (validOutcome(cell)) cells.set(key, cell)
    }
  }
  for (const task of universe.tasks) {
    // Unbounded weighted objectives have no implicit success threshold. Do not
    // bias their scope sampling with the legacy outcome-only difficulty score.
    if (universe.objective) continue
    const versions = new Map<string, EvidenceCell[]>()
    for (const cell of cells.values()) if (cell.identity.taskId === task.id) {
      const version = digestJson([cell.identity.harnessCommit, cell.identity.harnessManifestDigest])
      versions.set(version, [...(versions.get(version) ?? []), cell])
    }
    const completed = [...versions.values()].filter(cs => repetitionsForTask(universe, task.id).every(slot => cs.some(c => c.identity.repetition === slot.index && c.identity.seed === slot.seed)))
    if (completed.length) tasks[task.id]!.historicalDifficulty = completed.filter(cs => numeric(weightedMean(cs.map(c => ({ value: utility((c.outcome as { rawValue: number }).rawValue, task.outcome), weight: 1 })))) < task.successUtility).length / completed.length
  }
  return seal({ universeDigest: universe.digest, cutoffDigest, clusterDigests: sorted(clusters.map(c => c.digest)), tasks })
}

function shuffled(seed: string, ids: string[]) { return sorted(ids).sort((a, b) => digestJson([seed, a]).localeCompare(digestJson([seed, b])) || a.localeCompare(b)) }
/** Alternate low/high cost within frozen difficulty strata, then cover submodes and modules greedily. */
export function representativeOrder(universe: TaskUniverse, ids: string[], seed: string, evidence?: ScopeSamplingEvidence): string[] {
  const groups = new Map<string, string[]>()
  for (const id of shuffled(seed, ids)) {
    const task = universe.tasks.find(t => t.id === id)!, difficulty = evidence?.tasks[id]?.historicalDifficulty
    invariant(task, 'representative outside universe')
    const key = `${task.stratum}:${difficulty === undefined ? 'unknown' : difficulty <= 0.25 ? 'easy' : difficulty <= 0.75 ? 'mixed' : 'hard'}`
    groups.set(key, [...(groups.get(key) ?? []), id])
  }
  for (const [key, ids] of groups) groups.set(key, ids.sort((a, b) => universe.tasks.find(t => t.id === a)!.estimatedCost - universe.tasks.find(t => t.id === b)!.estimatedCost))
  const order: string[] = [], keys = shuffled(seed, [...groups.keys()])
  let expensive = false
  while ([...groups.values()].some(v => v.length)) {
    for (const key of keys) { const id = expensive ? groups.get(key)!.pop() : groups.get(key)!.shift(); if (id) order.push(id) }
    expensive = !expensive
  }
  const selected: string[] = [], covered = new Set<string>()
  const labels = (id: string) => [...(evidence?.tasks[id]?.submodes ?? []).map(s => `submode:${s}`), ...(evidence?.tasks[id]?.modificationPaths ?? []).map(s => `module:${s}`)]
  while (order.length) {
    const best = [...order].sort((a, b) => labels(b).filter(l => !covered.has(l)).length - labels(a).filter(l => !covered.has(l)).length)[0]!
    selected.push(best); labels(best).forEach(l => covered.add(l)); order.splice(order.indexOf(best), 1)
  }
  return selected
}

/** Uniform family allocation; within each family first inspect tasks sharing modified modules. */
export function crossOrder(universe: TaskUniverse, excluded: Set<string>, familyId: string, paths: string[], seed: string, evidence?: ScopeSamplingEvidence): { ids: string[]; generalIds: string[] } {
  const groups = new Map<string, string[]>(), known = new Set<string>()
  for (const task of universe.tasks.filter(t => !excluded.has(t.id))) {
    const families = (evidence?.tasks[task.id]?.familyIds.length ? evidence.tasks[task.id]!.familyIds : [task.stratum]).filter(f => f !== familyId)
    for (const family of families) { groups.set(family, [...(groups.get(family) ?? []), task.id]); known.add(task.id) }
  }
  for (const [family, ids] of groups) groups.set(family, representativeOrder(universe, ids, `${seed}:${family}`, evidence).sort((a, b) =>
    Number(!!evidence?.tasks[b]?.modificationPaths.some(p => paths.some(root => p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`))))
    - Number(!!evidence?.tasks[a]?.modificationPaths.some(p => paths.some(root => p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`))))))
  const keys = shuffled(seed, [...groups.keys()]), result: string[] = [], seen = new Set<string>()
  while ([...groups.values()].some(v => v.length)) for (const key of keys) {
    const bucket = groups.get(key)!
    while (bucket.length && seen.has(bucket[0]!)) bucket.shift()
    const id = bucket.shift(); if (id) { result.push(id); seen.add(id) }
  }
  const generalIds = representativeOrder(universe, universe.tasks.map(t => t.id).filter(id => !excluded.has(id) && !known.has(id)), `${seed}:general`, evidence)
  return { ids: [...result, ...generalIds], generalIds }
}
