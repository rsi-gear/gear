import { assertComponentRef } from '../evolution/component-ref.js'
import { digestJson } from '../state/digest.js'
import { searchImplementationIntegrity } from './identity.js'
import { validateSearchSchema } from './schema.js'
import type { EvaluationScope, MetricContract, MetricObservation, SearchSettings, Snapshot, TaskSetResolution, TaskSetSizing, TaskUniverse } from './types.js'
import { resolveMetric, resolveObjective } from '../objective/contracts.js'

export const integrity = searchImplementationIntegrity
export function seal<T extends object>(value: T): T & { digest: string } { return { ...value, digest: digestJson(value) } }
export function verifyDigest(value: { digest: string }): void {
  const { digest, ...body } = value
  if (digest !== digestJson(body)) throw new Error('immutable record digest mismatch')
}
export class SearchProtocolError extends Error { constructor(message: string) { super(message); this.name = 'SearchProtocolError' } }
export function invariant(ok: unknown, message: string): asserts ok { if (!ok) throw new SearchProtocolError(message) }
export function finite(value: number, name: string): void { invariant(Number.isFinite(value), `${name} must be finite`) }
export function integer(value: number, name: string, min = 0): void {
  invariant(Number.isSafeInteger(value) && value >= min, `${name} must be an integer >= ${min}`)
}
export function digest(value: string, name = 'digest'): void { invariant(/^sha256:[a-f0-9]{64}$/u.test(value), `invalid ${name}`) }
export function safeId(value: string): void { invariant(/^[a-zA-Z0-9_-]+$/u.test(value), 'unsafe record ID') }
export function unique<T>(values: readonly T[]): T[] { return [...new Set(values)] }
export function sorted(values: readonly string[]): string[] { return unique(values).sort() }

/** Decimal rationals make threshold boundaries and ties independent of binary rounding. */
export type Rational = { n: bigint; d: bigint }
function reduced(n: bigint, d: bigint): Rational {
  let a = n < 0n ? -n : n, b = d
  while (b) { const remainder = a % b; a = b; b = remainder }
  return { n: n / (a || 1n), d: d / (a || 1n) }
}
export function rational(value: number): Rational {
  finite(value, 'decimal')
  const [digits, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole = '0', fraction = ''] = digits!.split('.')
  const scale = fraction.length - Number(exponent)
  const n = BigInt(whole + fraction)
  return scale < 0 ? { n: n * 10n ** BigInt(-scale), d: 1n } : { n, d: 10n ** BigInt(scale) }
}
export function add(a: Rational, b: Rational): Rational { return reduced(a.n * b.d + b.n * a.d, a.d * b.d) }
export function sub(a: Rational, b: Rational): Rational { return add(a, { n: -b.n, d: b.d }) }
export function mul(a: Rational, b: Rational): Rational { return reduced(a.n * b.n, a.d * b.d) }
export function div(a: Rational, b: Rational): Rational {
  invariant(b.n !== 0n, 'zero divisor')
  const sign = b.n < 0n ? -1n : 1n
  return reduced(a.n * b.d * sign, a.d * b.n * sign)
}
export function floor(a: Rational): bigint { const q = a.n / a.d; return a.n < 0n && a.n % a.d !== 0n ? q - 1n : q }
export function numeric(a: Rational): number { return Number(a.n) / Number(a.d) }
export function comparisonKey(value: Rational | number, quantum: number): bigint {
  invariant(quantum > 0 && Number.isFinite(quantum), 'comparison quantum must be positive')
  return floor(add(div(typeof value === 'number' ? rational(value) : value, rational(quantum)), { n: 1n, d: 2n }))
}
export function utility(raw: number, contract: MetricContract): Rational {
  finite(raw, 'metric value')
  if (contract.range) invariant(raw >= contract.range.min && raw <= contract.range.max, 'metric value outside declared range')
  let value = rational(raw)
  if (contract.normalization) value = div(sub(value, rational(contract.normalization.min)), sub(rational(contract.normalization.max), rational(contract.normalization.min)))
  return contract.direction === 'maximize' ? value : { ...value, n: -value.n }
}
export function weightedMean(values: Array<{ value: Rational | number; weight: number }>): Rational {
  invariant(values.length > 0, 'cannot aggregate an empty metric')
  let total = rational(0), weights = rational(0)
  for (const item of values) {
    invariant(item.weight >= 0 && Number.isFinite(item.weight), 'invalid task weight')
    total = add(total, mul(typeof item.value === 'number' ? rational(item.value) : item.value, rational(item.weight)))
    weights = add(weights, rational(item.weight))
  }
  return div(total, weights)
}
export function validateMetric(contract: MetricContract): void {
  verifyDigest(contract)
  invariant(contract.id && contract.revision && contract.group, 'metric identity and utility group required')
  invariant(['outcome', 'process'].includes(contract.channel), 'invalid metric channel')
  invariant(['final-outcome', 'final-state-partial-credit', 'trajectory'].includes(contract.evidenceKind), 'invalid evidence kind')
  invariant(['dataset-aggregate', 'trial', 'component'].includes(contract.granularity), 'invalid metric granularity')
  invariant(['maximize', 'minimize'].includes(contract.direction) && contract.repetitionReducer === 'mean', 'invalid metric reducer/direction')
  digest(contract.applicableTaskSetDigest)
  invariant(contract.comparisonQuantum > 0 && Number.isFinite(contract.comparisonQuantum), 'invalid metric quantum')
  for (const bounds of [contract.range, contract.normalization]) if (bounds) {
    invariant(Number.isFinite(bounds.min) && Number.isFinite(bounds.max) && bounds.min < bounds.max, 'invalid metric bounds')
  }
  if (contract.normalization) invariant(contract.normalization.kind === 'fixed-linear', 'unsupported normalization')
}
export function validateUniverse(universe: TaskUniverse): void {
  validateSearchSchema('TaskUniverse', universe)
  verifyDigest(universe); digest(universe.conditionDigest)
  if (universe.rawMetricContracts) {
    invariant(new Set(universe.rawMetricContracts.map(c => c.id)).size === universe.rawMetricContracts.length, 'duplicate raw metric contract')
    for (const c of universe.rawMetricContracts) {
      verifyDigest(c)
      const { schemaVersion, digest: ignored, ...definition } = c
      invariant(schemaVersion === 1 && resolveMetric(definition).digest === c.digest, 'invalid raw metric contract')
    }
  }
  if (universe.objective) {
    invariant(universe.rawMetricContracts, 'objective requires raw metric contracts')
    const o = universe.objective
    const resolved = resolveObjective({ terms: o.terms.map(({ metric, weight, scale }) => ({ metric, weight, scale })),
      constraints: o.constraints.map(c => c.rule === 'minimum' ? { metric: c.metric, rule: c.rule, value: c.value } : { metric: c.metric, rule: c.rule, reference: c.reference, tolerance: c.tolerance }) }, universe.rawMetricContracts)
    invariant(resolved.digest === o.digest, 'objective definition changed')
  }
  invariant(['seed', 'held-out'].includes(universe.partition), 'invalid partition')
  invariant(universe.tasks.length > 0, 'empty task universe')
  invariant(unique(universe.tasks.map(t => t.id)).length === universe.tasks.length, 'duplicate task IDs')
  invariant(unique(universe.tasks.map(t => t.contentDigest)).length === universe.tasks.length, 'duplicate task content')
  invariant(universe.repetitions.length > 0 && unique(universe.repetitions.map(s => s.index)).length === universe.repetitions.length, 'invalid repetition slots')
  for (const slot of universe.repetitions) { integer(slot.index, 'repetition'); if (slot.seed !== null) integer(slot.seed, 'seed') }
  for (const task of universe.tasks) {
    invariant(task.id.length > 0 && task.stratum.length > 0, 'task identity/stratum required'); digest(task.contentDigest)
    validateMetric(task.outcome); invariant(task.outcome.channel === 'outcome' && task.outcome.granularity !== 'dataset-aggregate', 'trial outcome is required')
    if (task.process) { validateMetric(task.process); invariant(task.process.channel === 'process', 'wrong process contract channel') }
    repetitionsForTask(universe, task.id)
    finite(task.successUtility, 'success threshold')
    invariant(Number.isFinite(task.weight) && task.weight > 0 && Number.isFinite(task.estimatedCost) && task.estimatedCost > 0, 'invalid task weight/cost')
  }
  invariant(unique(universe.tasks.map(t => t.outcome.group)).length === 1, 'outcome macro average requires a fixed common utility scale')
  for (const channel of ['outcome', 'process'] as const) {
    const groups = new Map<string, number>()
    for (const task of universe.tasks) {
      const contract = task[channel]
      if (!contract) continue
      const q = groups.get(contract.group)
      invariant(q === undefined || q === contract.comparisonQuantum, 'metric group has inconsistent aggregate quantum')
      groups.set(contract.group, contract.comparisonQuantum)
      const applicable = sorted(universe.tasks.filter(t => t[channel]?.digest === contract.digest).map(t => t.contentDigest))
      invariant(contract.applicableTaskSetDigest === digestJson(applicable), 'metric applicability declaration mismatch')
    }
  }
}
export function repetitionsForTask(universe: TaskUniverse, taskId: string): TaskUniverse['repetitions'] {
  const task = universe.tasks.find(t => t.id === taskId)
  invariant(task, 'task outside repetition manifest')
  if (task.repetitionIndices === undefined) return universe.repetitions
  const slots = universe.repetitions.filter(s => task.repetitionIndices!.includes(s.index))
  invariant(slots.length > 0 && slots.length === task.repetitionIndices.length && unique(task.repetitionIndices).length === slots.length, 'invalid per-task repetition slots')
  return slots
}
export function plannedCellCount(universe: TaskUniverse, taskIds: readonly string[]): number {
  return taskIds.reduce((sum, id) => sum + repetitionsForTask(universe, id).length, 0)
}
export function processTasks(universe: TaskUniverse, mode: 'off' | 'auto' | 'required'): string[] {
  if (universe.objective) mode = 'auto'
  if (mode === 'off') return []
  const ids = universe.tasks.filter(t => t.process && t.process.granularity !== 'dataset-aggregate').map(t => t.id)
  invariant(mode !== 'required' || ids.length > 0, 'required process metrics are unsupported')
  return ids
}
/** Semantic identity excludes family names, epoch labels, and sampling annotations. */
export function scopeEquivalenceDigest(scope: Pick<EvaluationScope, 'universeDigest' | 'taskIds' | 'weights' | 'guards'>): string {
  return digestJson({ universe: scope.universeDigest, taskIds: sorted(scope.taskIds), weights: scope.weights,
    guards: [...scope.guards].sort((a, b) => digestJson(a).localeCompare(digestJson(b))) })
}
export function validateScope(scope: EvaluationScope, universe: TaskUniverse): void {
  validateSearchSchema('EvaluationScope', scope); verifyDigest(scope)
  invariant(universe.partition === 'seed' && scope.universeDigest === universe.digest, 'scope universe changed')
  invariant(scope.familyId.length > 0, 'scope family is required'); integer(scope.epoch, 'scope epoch')
  digest(scope.taskSetSizeResolutionDigest)
  if (scope.samplingEvidenceDigest) digest(scope.samplingEvidenceDigest)
  invariant(scope.taskIds.length > 0 && digestJson(scope.taskIds) === digestJson(sorted(scope.taskIds))
    && scope.taskIds.every(id => universe.tasks.some(t => t.id === id)), 'invalid scope task manifest')
  const bucketIds = Object.values(scope.buckets).flat()
  invariant(unique(bucketIds).length === bucketIds.length, 'scope buckets must be deduplicated')
  invariant(scope.guards.every(g => g.partition === 'seed' && (g.rule === 'must-pass' || g.rule === 'minimum-score'
    && Number.isFinite(g.minimumUtility))), 'invalid scope exploration guards')
  invariant(digestJson(sorted([...bucketIds, ...scope.guards.map(g => g.taskId)])) === digestJson(scope.taskIds), 'scope manifest must include every bucket and guard')
  invariant(digestJson(Object.keys(scope.weights).sort()) === digestJson(scope.taskIds), 'scope weights do not match its task manifest')
  const weights = Object.values(scope.weights)
  invariant(weights.every(w => Number.isFinite(w) && w >= 0) && Math.abs(weights.reduce((a, b) => a + b, 0) - 1) <= 1e-12, 'scope weights must be normalized')
  invariant(scope.equivalenceDigest === scopeEquivalenceDigest(scope), 'scope equivalence identity mismatch')
}
export function resolveSizing(universe: TaskUniverse, config: TaskSetSizing): TaskSetResolution {
  invariant(config.basis === 'seed-universe' && config.rounding === 'ceil', 'unsupported task sizing rule')
  const N = universe.tasks.length
  invariant(N > 0, 'empty seed universe')
  let sum = rational(0)
  const quantities = {} as TaskSetResolution['quantities']
  for (const name of ['local', 'shared', 'cross', 'bridge'] as const) {
    const limit = config[name]
    invariant(limit && Number.isFinite(limit.ratio) && limit.ratio >= 0 && limit.ratio <= 1, `invalid ${name} ratio`)
    if (limit.minTasks != null) integer(limit.minTasks, `${name}.minTasks`)
    if (limit.maxTasks != null) integer(limit.maxTasks, `${name}.maxTasks`)
    invariant(limit.minTasks == null || limit.maxTasks == null || limit.minTasks <= limit.maxTasks, `${name} min exceeds max`)
    invariant(limit.ratio !== 0 || !limit.minTasks, `${name} is disabled but has a positive minimum`)
    invariant(limit.ratio === 0 || limit.maxTasks !== 0, `${name} positive ratio conflicts with zero capacity`)
    if (name !== 'bridge') sum = add(sum, rational(limit.ratio))
    const product = mul(rational(N), rational(limit.ratio))
    const requested = Number(-floor({ n: -product.n, d: product.d }))
    const resolved = Math.min(N, limit.maxTasks ?? N, Math.max(Math.min(N, limit.minTasks ?? 0), requested))
    quantities[name] = { requested, resolved, reasons: [
      ...((limit.minTasks ?? 0) > N ? ['minimum-clipped-to-universe'] : []),
      ...(resolved < requested ? ['capacity-clipped'] : []),
    ] }
  }
  invariant(config.local.ratio > 0, 'local ratio must be positive')
  invariant(sum.n <= sum.d, 'local/shared/cross ratios exceed one')
  return seal({ universeDigest: universe.digest, universeSize: N, config: structuredClone(config), quantities })
}
export function validateSettings(settings: SearchSettings, universe: TaskUniverse, heldOut: TaskUniverse, maxCandidates: number): void {
  validateSearchSchema('SearchSettings', settings)
  const s = settings.search, p = settings.promotion
  invariant(s.mode === 'failure-cluster-gepa-v1', 'unknown search mode')
  integer(s.seed, 'search.seed'); integer(maxCandidates, 'maxCandidates', 1); integer(s.parentBatchCount, 'parentBatchCount', 1)
  if (s.parentPolicy) assertComponentRef(s.parentPolicy, 'parent-selection')
  if (!s.parentPolicy && s.parentSampling === 'scoped-frontier-membership-v1') invariant(s.parentBatchCount <= maxCandidates, 'parent batches exceed candidate limit')
  invariant(['scoped-frontier-membership-v1', 'epsilon-greedy-gepa-v1'].includes(s.parentSampling) && s.scopeWeights === 'uniform-by-family' && s.archiveCoverage === 'complete-scope', 'unsupported archive algorithm')
  if (s.championProbability !== undefined) invariant(s.parentSampling === 'epsilon-greedy-gepa-v1', 'championProbability requires epsilon-greedy-gepa-v1')
  const championProbability = s.championProbability ?? 0.5
  invariant(Number.isFinite(championProbability) && championProbability >= 0 && championProbability <= 1, 'invalid champion probability')
  invariant(s.diagnosis.sharing === 'parent-evidence-dossier' && s.diagnosis.planner === 'evidence-failure-clusters-v1', 'unsupported diagnosis policy')
  integer(s.diagnosis.candidatesPerFamily, 'candidatesPerFamily', 1)
  invariant(['stable', 'periodic'].includes(s.scopeSampling.epochPolicy), 'unsupported scope epoch policy')
  if (s.scopeSampling.epochPolicy === 'periodic') integer(s.scopeSampling.updateEveryRounds!, 'scope update period', 1)
  if (s.scopeSampling.updateEveryRounds !== undefined) integer(s.scopeSampling.updateEveryRounds, 'scope update period', 1)
  if (s.scopeSampling.maxHistoricalSpecialists !== undefined) integer(s.scopeSampling.maxHistoricalSpecialists, 'scope historical specialist limit')
  invariant(s.evaluationStages.reuseValidCells === true && s.evaluationStages.globalSeed.maxCandidates === 1, 'invalid staged evaluation policy')
  integer(s.evaluationStages.bridge.maxCandidates, 'bridge.maxCandidates')
  invariant(s.evaluationStages.bridge.groupAllocation === 'weighted-round-robin' && s.evaluationStages.bridge.taskSelection === 'nominated-scopes-union-then-stratified', 'unsupported bridge policy')
  invariant(s.globalTaskWeights === 'uniform', 'unsupported global task weighting')
  for (const v of Object.values(s.scopeSampling.bucketWeights)) invariant(Number.isFinite(v) && v >= 0, 'invalid bucket weight')
  invariant(Object.values(s.scopeSampling.bucketWeights).reduce((a, b) => a + b, 0) > 0, 'empty bucket weights')
  invariant(Number.isFinite(s.process.parentBudgetFraction) && s.process.parentBudgetFraction >= 0 && s.process.parentBudgetFraction <= 1, 'invalid process budget fraction')
  for (const mode of [s.process.mode, p.process.mode]) invariant(['off', 'auto', 'required'].includes(mode), 'invalid process mode')
  validateUniverse(universe); validateUniverse(heldOut)
  invariant(universe.partition === 'seed' && heldOut.partition === 'held-out', 'incorrect task partitions')
  resolveSizing(universe, s.taskSetSizing)
  if (!universe.objective) { processTasks(universe, s.process.mode); processTasks(universe, p.process.mode); processTasks(heldOut, p.process.mode) }
  invariant(universe.objective?.digest === heldOut.objective?.digest, 'seed/held-out objective semantics differ')
  invariant(p.policy === 'paired-multisignal-v1' && ['independent-held-out', 'shared-set-research'].includes(p.validationMode), 'invalid promotion policy')
  if (p.validationMode === 'independent-held-out') {
    const identities = new Set(universe.tasks.map(t => t.contentDigest))
    invariant(!heldOut.tasks.some(t => identities.has(t.contentDigest)), 'independent held-out overlaps seed task content')
  }
  invariant(typeof p.allowNeutral === 'boolean', 'invalid neutral promotion rule')
  invariant(p.allowSharedSetPromotion === undefined || typeof p.allowSharedSetPromotion === 'boolean', 'invalid shared-set promotion authorization')
  for (const threshold of [p.outcome, p.process, ...Object.values(p.process.groups ?? {}), ...(p.objective ? [p.objective] : [])]) {
    for (const value of [threshold.minimumGain, threshold.maxSeedRegression, threshold.maxHeldOutRegression]) invariant(Number.isFinite(value) && value >= 0, 'invalid promotion threshold')
  }
  const groups = unique([universe, heldOut].flatMap(u => u.tasks.filter(t => processTasks(u, p.process.mode).includes(t.id)).map(t => t.process!.group)))
  if (!universe.objective && groups.length > 1) invariant(groups.every(g => p.process.groups?.[g]), 'heterogeneous process metrics require explicit group thresholds')
  for (const guard of [...s.explorationGuards, ...p.protectedTasks]) {
    const u = guard.partition === 'seed' ? universe : heldOut
    if (u.objective) invariant(u.rawMetricContracts?.some(c => c.id === (guard.rule === 'must-pass' ? 'pass_rate' : guard.metric) && c.granularity === 'trial'), 'objective task guards require an explicit raw metric binding or a pass predicate')
    invariant(u.tasks.some(t => t.id === guard.taskId) && ['no-regression', 'minimum-score', 'must-pass'].includes(guard.rule), 'invalid protected task')
    if (guard.rule === 'minimum-score') finite(guard.minimumUtility!, 'guard minimum')
  }
  invariant(s.explorationGuards.every(g => g.partition === 'seed' && g.rule !== 'no-regression'), 'exploration guards must be absolute seed requirements')
  for (const g of p.protectedAssertions) {
    invariant((g.partition === 'seed' ? universe : heldOut).tasks.some(t => t.id === g.taskId), 'unknown protected assertion task')
    digest(g.schemaDigest); invariant(g.assertionId && ['must-pass', 'no-new-violation'].includes(g.rule), 'invalid protected assertion')
  }
  const resolution = resolveSizing(universe, s.taskSetSizing)
  const core = sorted(s.scopeSampling.sharedCoreTaskIds ?? [])
  invariant(core.every(id => universe.tasks.some(t => t.id === id)) && core.length <= resolution.quantities.shared.resolved, 'shared core exceeds configured capacity or universe')
  for (const limits of [settings.budgets.round, settings.budgets.evolution]) {
    for (const key of ['maxNewRolloutCells', 'maxDiagnosisInputTokens', 'maxDiagnosisOutputTokens', 'maxRepairCells', 'timeoutMs'] as const) integer(limits[key], key, key === 'timeoutMs' ? 1 : 0)
    for (const key of ['maxGenerationTokens', 'maxGenerationRequests'] as const) if (limits[key] !== undefined) integer(limits[key], key, 0)
  }
  integer(settings.regression.maxProposals, 'maxProposals')
  invariant(typeof settings.regression.collectFailures === 'boolean', 'invalid regression collection setting')
}
export function validateSnapshot(snapshot: Snapshot): void {
  validateSearchSchema('Snapshot', snapshot)
  verifyDigest(snapshot); safeId(snapshot.candidateId)
  invariant(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(snapshot.commit) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(snapshot.tree), 'exact Git commit/tree required')
  digest(snapshot.manifestDigest)
}
export function observationValue(observation: MetricObservation | undefined, contract: MetricContract): Rational | undefined {
  if (!observation) return undefined
  if ('contractDigest' in observation) invariant(observation.contractDigest === contract.digest, 'metric/scorer identity mismatch')
  if (observation.status !== 'available') return undefined
  invariant(observation.evidenceRef.length > 0, 'metric provenance required')
  return utility(observation.rawValue, contract)
}
