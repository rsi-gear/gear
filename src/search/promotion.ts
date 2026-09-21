import { comparisonKey, mul, numeric, rational, repetitionsForTask, invariant, processTasks, seal, sorted, verifyDigest } from './contracts.js'
import { profile, validOutcome } from './evidence.js'
import type { EvidenceProfile, GateDecision, MultisignalPromotionConfig, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'
import { scoringComplete, scoringKey } from './objective.js'
import { scoreObjective, type ObjectiveBaseline } from '../objective/scoring.js'

export interface PromotionInput { universe: TaskUniverse; plan: StageEvaluationPlan; anchor: Snapshot; candidate: Snapshot; baseline: StageResult; result: StageResult; initialBaseline?: ObjectiveBaseline | undefined }
function thresholds(config: MultisignalPromotionConfig, group: string) { return config.process.groups?.[group] ?? config.process }
function gainValue(key: bigint, quantum: number): number { return numeric(mul({ n: key, d: 1n }, rational(quantum))) }
export function rankProfiles(universe: TaskUniverse, entries: Array<{ id: string; profile: EvidenceProfile }>): string[] {
  const usable = entries.filter(e => scoringComplete(e.profile))
  const groups = sorted(usable.flatMap(e => Object.keys(e.profile.processGroups)))
  return usable.sort((a, b) => {
    const o = BigInt(scoringKey(b.profile)!) - BigInt(scoringKey(a.profile)!)
    if (o) return o > 0n ? 1 : -1
    if (!universe.objective && groups.length === 1) {
      const g = groups[0]!
      const p = BigInt(b.profile.processGroupKeys[g]!) - BigInt(a.profile.processGroupKeys[g]!)
      if (p) return p > 0n ? 1 : -1
    }
    return a.id.localeCompare(b.id)
  }).map(e => e.id)
}
export function assessGate(input: PromotionInput, config: MultisignalPromotionConfig, requireImprovement: boolean): GateDecision {
  const { universe, plan } = input
  invariant(plan.participantIds.includes(input.anchor.candidateId) && plan.participantIds.includes(input.candidate.candidateId), 'promotion participants do not match fixed anchor/nominee')
  const baseline = profile(universe, plan, input.anchor, input.baseline, config.process.mode)
  const candidate = profile(universe, plan, input.candidate, input.result, config.process.mode)
  const paired = input.result.cells.filter(c => validOutcome(c) && input.baseline.cells.some(b => validOutcome(b)
    && b.identity.taskContentDigest === c.identity.taskContentDigest && b.identity.repetition === c.identity.repetition && b.identity.seed === c.identity.seed)).length
  baseline.coverage.paired = candidate.coverage.paired = paired
  const reasons: string[] = []
  const comparison: GateDecision['comparison'] = { processGains: {}, constraintCoverage: config.protectedTasks.length || config.protectedAssertions.length ? 'available' : 'unavailable' }
  const base = { reasonCodes: reasons, supportDigest: seal({ baseline, candidate }).digest,
    metricContractDigests: sorted(universe.tasks.filter(t => plan.taskIds.includes(t.id)).flatMap(t => [t.outcome.digest, ...(processTasks(universe, config.process.mode).includes(t.id) ? [t.process!.digest] : [])])), comparison }
  if (input.baseline.failure || input.result.failure) return seal({ ...base, outcome: 'insufficient-evidence' as const, reasonCodes: ['stage-execution-unavailable'] })
  if (!scoringComplete(baseline) || !scoringComplete(candidate)) return seal({ ...base, outcome: 'insufficient-evidence' as const, reasonCodes: ['incomplete-stage-evidence'] })
  for (const guard of config.protectedTasks.filter(g => g.partition === universe.partition && plan.taskIds.includes(g.taskId))) {
    const task = universe.tasks.find(t => t.id === guard.taskId)!, q = task.outcome.comparisonQuantum
    const metric = guard.rule === 'must-pass' ? 'pass_rate' : guard.metric
    if (universe.objective) {
      const contract = universe.rawMetricContracts!.find(c => c.id === metric)!
      const a = baseline.tasks.find(t => t.taskId === guard.taskId)!.rawMetrics?.[metric!], b = candidate.tasks.find(t => t.taskId === guard.taskId)!.rawMetrics?.[metric!]
      if (!contract || a?.status !== 'available' || b?.status !== 'available') return seal({ ...base, outcome: 'insufficient-evidence' as const, reasonCodes: ['missing-protected-metric'] })
      const boundary = guard.rule === 'no-regression' ? a.value! : guard.rule === 'must-pass' ? 1 : guard.minimumUtility!
      const difference = comparisonKey(b.value!, contract.comparisonPrecision) - comparisonKey(boundary, contract.comparisonPrecision)
      if (contract.direction === 'maximize' ? difference < 0n : difference > 0n) reasons.push(`protected-task:${guard.taskId}`)
      continue
    }
    const a = baseline.tasks.find(t => t.taskId === guard.taskId)!.outcome!, b = candidate.tasks.find(t => t.taskId === guard.taskId)!.outcome!
    const minimum = guard.rule === 'no-regression' ? a : guard.rule === 'must-pass' ? task.successUtility : guard.minimumUtility!
    if (comparisonKey(b, q) < comparisonKey(minimum, q)) reasons.push(`protected-task:${guard.taskId}`)
  }
  let missingAssertion = false
  for (const guard of config.protectedAssertions.filter(g => g.partition === universe.partition && plan.taskIds.includes(g.taskId))) {
    for (const repetition of repetitionsForTask(universe, guard.taskId)) {
      const a = input.baseline.cells.find(c => c.identity.taskId === guard.taskId && c.identity.repetition === repetition.index)?.assertions?.find(a => a.id === guard.assertionId)
      const b = input.result.cells.find(c => c.identity.taskId === guard.taskId && c.identity.repetition === repetition.index)?.assertions?.find(a => a.id === guard.assertionId)
      if (!a || !b) { missingAssertion = true; continue }
      invariant(a.schemaDigest === guard.schemaDigest && b.schemaDigest === guard.schemaDigest, 'protected assertion schema mismatch')
      if ((guard.rule === 'must-pass' && b.status !== 'passed') || (guard.rule === 'no-new-violation' && a.status !== 'failed' && b.status === 'failed')) reasons.push(`protected-assertion:${guard.taskId}:${guard.assertionId}`)
    }
  }
  if (missingAssertion) return seal({ ...base, outcome: 'insufficient-evidence' as const, reasonCodes: ['missing-protected-assertion'] })
  if (universe.objective) {
    const objectiveScore = scoreObjective(universe.objective, candidate.rawMetrics!, candidate.objectiveScore!.scopeDigest, input.initialBaseline)
    const q = universe.objective.comparisonPrecision, limits = config.objective ?? { minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 }
    const gain = BigInt(candidate.objectiveKey!) - BigInt(baseline.objectiveKey!)
    const resultBase = { ...base, objectiveScore, metricContractDigests: sorted([...universe.objective.terms.filter(t => t.weight !== 0).map(t => t.metricContractDigest), ...universe.objective.constraints.map(c => c.metricContractDigest)]),
      comparison: { ...comparison, objectiveGain: gainValue(gain, q), constraintCoverage: universe.objective.constraints.length ? 'available' as const : comparison.constraintCoverage } }
    if (objectiveScore.status !== 'available') return seal({ ...resultBase, outcome: 'insufficient-evidence' as const, reasonCodes: ['incomplete-objective-constraints'] })
    for (const c of objectiveScore.constraintResults) if (c.status === 'failed') reasons.push(`objective-constraint:${c.constraintDigest}`)
    if (gain < comparisonKey(-(universe.partition === 'seed' ? limits.maxSeedRegression : limits.maxHeldOutRegression), q)) reasons.push('objective-regression')
    if (requireImprovement && gain <= comparisonKey(limits.minimumGain, q) && !(config.allowNeutral && gain === 0n)) reasons.push('no-substantive-objective-improvement')
    return seal({ ...resultBase, outcome: reasons.length ? 'rejected' as const : 'eligible' as const })
  }
  const q = universe.tasks[0]!.outcome.comparisonQuantum
  const outcomeGainKey = BigInt(candidate.outcomeKey!) - BigInt(baseline.outcomeKey!)
  comparison.outcomeGain = gainValue(outcomeGainKey, q)
  const outcomeLimit = universe.partition === 'seed' ? config.outcome.maxSeedRegression : config.outcome.maxHeldOutRegression
  if (outcomeGainKey < comparisonKey(-outcomeLimit, q)) reasons.push('outcome-regression')
  let processImproved = false, allProcessNonnegative = true
  for (const [group, value] of Object.entries(candidate.processGroups)) {
    const tq = universe.tasks.find(t => t.process?.group === group)!.process!.comparisonQuantum
    const gainKey = BigInt(candidate.processGroupKeys[group]!) - BigInt(baseline.processGroupKeys[group]!), limits = thresholds(config, group)
    comparison.processGains[group] = gainValue(gainKey, tq)
    // Bridge process regression does not block collecting full-evaluation evidence.
    if (plan.stage !== 'bridge' && gainKey < comparisonKey(-(universe.partition === 'seed' ? limits.maxSeedRegression : limits.maxHeldOutRegression), tq)) reasons.push(`process-regression:${group}`)
    if (gainKey < 0n) allProcessNonnegative = false
    if (gainKey > comparisonKey(limits.minimumGain, tq)) processImproved = true
  }
  const improved = outcomeGainKey > comparisonKey(config.outcome.minimumGain, q) || processImproved && allProcessNonnegative
  const neutral = outcomeGainKey === 0n && Object.values(comparison.processGains).every(g => g === 0)
  if (requireImprovement && !improved && !(config.allowNeutral && neutral)) reasons.push('no-substantive-improvement')
  return seal({ ...base, outcome: reasons.length ? 'rejected' as const : 'eligible' as const })
}
export function precheckSeed(input: PromotionInput, config: MultisignalPromotionConfig): GateDecision {
  invariant(input.plan.stage === 'global-seed' && input.universe.partition === 'seed' && input.plan.taskIds.length === input.universe.tasks.length, 'seed precheck requires complete global seed plan')
  return assessGate(input, config, true)
}
export function decideFinal(seed: PromotionInput, heldOut: PromotionInput, config: MultisignalPromotionConfig): GateDecision {
  invariant(seed.candidate.digest === heldOut.candidate.digest && seed.anchor.digest === heldOut.anchor.digest, 'finalist/anchor changed between promotion stages')
  invariant(heldOut.plan.stage === 'held-out' && heldOut.plan.taskIds.length === heldOut.universe.tasks.length && heldOut.universe.partition === 'held-out', 'final gate requires full held-out')
  const first = precheckSeed(seed, config)
  if (first.outcome !== 'eligible') return first
  const final = assessGate(heldOut, config, false)
  const { digest: ignored, ...body } = final
  return seal({ ...body, outcome: final.outcome === 'eligible' ? 'accepted' as const : final.outcome, supportDigest: seal({ seed: first, heldOut: final }).digest })
}
