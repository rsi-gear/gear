import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { add, comparisonKey, div, mul, rational, weightedMean } from '../search/contracts.js'
import { digestJson } from '../state/digest.js'
import { sealed, verifySealed, validateResolvedObjective } from './contracts.js'
import type { ObjectiveScoreEvidence, RawMetricAggregate, RawMetricContract, RawMetricValue, RawTrialMetrics, ResolvedObjective } from './types.js'

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
export const objectiveProjectorDigest = `sha256:${['contracts', 'scoring'].reduce((hash, name) => hash.update(readFileSync(new URL(`${name}${extension}`, import.meta.url))), createHash('sha256')).digest('hex')}`

function numeric(value: ReturnType<typeof rational>): number {
  const n = Number(value.n), d = Number(value.d)
  if (Number.isFinite(n) && Number.isFinite(d)) return n / d
  const absolute = value.n < 0n ? -value.n : value.n
  const shift = 17 - (absolute.toString().length - value.d.toString().length)
  const digits = shift >= 0 ? absolute * 10n ** BigInt(shift) / value.d : absolute / (value.d * 10n ** BigInt(-shift))
  return Number(`${value.n < 0n ? '-' : ''}${digits}e${-shift}`)
}

export function extractRawMetrics(input: {
  contracts: RawMetricContract[]
  trial: unknown
  certified: boolean
  identity: Omit<RawTrialMetrics, 'schemaVersion' | 'kind' | 'metrics' | 'digest'>
}): RawTrialMetrics {
  const metrics: Record<string, RawMetricValue> = {}
  for (const c of input.contracts) {
    verifySealed(c)
    const base = { contractDigest: c.digest, unit: c.unit, evidenceRefs: [...input.identity.originalArtifactRefs] }
    if (!input.certified) { metrics[c.id] = { ...base, status: 'invalid', reason: 'original observation is not certified' }; continue }
    if (c.granularity !== 'trial') { metrics[c.id] = { ...base, status: 'unsupported', reason: 'dataset aggregate has no trial projection' }; continue }
    let value: unknown = input.trial
    for (const part of c.source.path.split('.')) value = value && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined
    if (value === undefined || value === null) { metrics[c.id] = { ...base, status: 'missing', reason: `missing ${c.source.path}` }; continue }
    let number: number | undefined
    if (c.source.extractor === 'number-v1' && typeof value === 'number' && Number.isFinite(value)) number = value
    if (c.source.extractor === 'boolean-v1' && typeof value === 'boolean') number = Number(value)
    if (c.source.extractor === 'equals-v1' && typeof value === typeof c.source.equals && (typeof value !== 'number' || Number.isFinite(value))) number = Number(value === c.source.equals)
    if (number === undefined || c.range && (number < c.range.min || number > c.range.max)) {
      metrics[c.id] = { ...base, status: 'invalid', reason: 'metric type or range does not match its contract' }; continue
    }
    metrics[c.id] = { ...base, status: 'available', value: number }
  }
  return sealed({ schemaVersion: 1 as const, kind: 'raw-metrics' as const, ...input.identity, metrics })
}

/** Explicit slots prevent missing observations from changing the denominator. */
export function aggregateRawMetrics(contracts: RawMetricContract[], tasks: Array<{ id: string; repetitions: number[]; weight: number }>, records: RawTrialMetrics[]): Record<string, RawMetricAggregate> {
  if (!tasks.length || new Set(tasks.map(t => t.id)).size !== tasks.length || !tasks.some(t => t.weight > 0)) throw new TypeError('invalid raw metric task scope')
  const bySlot = new Map<string, RawTrialMetrics>()
  for (const record of records) {
    verifySealed(record)
    const key = JSON.stringify([record.taskId, record.repetition])
    const task = tasks.find(t => t.id === record.taskId)
    if (!task || !task.repetitions.includes(record.repetition) || bySlot.has(key)) throw new TypeError('unplanned or duplicate raw metric slot')
    bySlot.set(key, record)
  }
  return Object.fromEntries(contracts.map(c => {
    verifySealed(c)
    let status: RawMetricValue['status'] = 'available'
    let total = rational(0)
    const means: Array<{ value: ReturnType<typeof rational>; weight: number }> = [], refs = new Set<string>()
    for (const task of tasks) {
      if (!task.repetitions.length || new Set(task.repetitions).size !== task.repetitions.length) throw new TypeError('invalid raw metric repetitions')
      const values: number[] = []
      for (const repetition of task.repetitions) {
        const record = bySlot.get(JSON.stringify([task.id, repetition])), metric = record?.metrics[c.id]
        if (record) refs.add(record.digest)
        if (metric && metric.contractDigest !== c.digest) throw new TypeError('raw metric contract changed')
        if (metric && metric.unit !== c.unit) throw new TypeError('raw metric unit changed')
        if (!metric || metric.status !== 'available') {
          if (metric?.status === 'invalid') status = 'invalid'
          else if (status !== 'invalid') status = metric?.status ?? 'missing'
        } else {
          if (!Number.isFinite(metric.value)) throw new TypeError('invalid available raw value')
          values.push(metric.value!); total = add(total, rational(metric.value!))
        }
      }
      if (values.length === task.repetitions.length) means.push({ value: weightedMean(values.map(value => ({ value, weight: 1 }))), weight: task.weight })
    }
    const value = status === 'available' ? numeric(weightedMean(means)) : undefined
    if (value !== undefined && !Number.isFinite(value)) status = 'invalid'
    const observationTotal = numeric(total)
    return [c.id, { contractDigest: c.digest, unit: c.unit, status, evidenceRefs: [...refs].sort(),
      ...(status === 'available' ? { value: value!, ...(Number.isFinite(observationTotal) ? { observationTotal }
        : { observationTotalExact: { numerator: total.n.toString(), denominator: total.d.toString() } }) }
        : { reason: 'incomplete or nonfinite frozen task/repetition scope' }) } satisfies RawMetricAggregate]
  }))
}

export interface ObjectiveBaseline { scopeDigest: string; metrics: Record<string, RawMetricAggregate>; digest: string }
/** Pure re-projection: changing weights never edits raw records or executes a rollout. */
export function scoreObjective(objective: ResolvedObjective, metrics: Record<string, RawMetricAggregate>, scopeDigest: string, baseline?: ObjectiveBaseline): ObjectiveScoreEvidence {
  validateResolvedObjective(objective)
  if (baseline) { verifySealed(baseline); if (baseline.scopeDigest !== scopeDigest) throw new TypeError('initial baseline scope mismatch') }
  const required = new Set([...objective.terms.filter(t => t.weight !== 0).map(t => t.metric), ...objective.constraints.map(c => c.metric)])
  const refs = new Set<string>(), inputs: ObjectiveScoreEvidence['inputs'] = [], contributions: ObjectiveScoreEvidence['contributions'] = []
  let status: ObjectiveScoreEvidence['status'] = 'available', sum = rational(0)
  for (const id of new Set([...objective.terms.map(t => t.metric), ...required])) {
    const metric = metrics[id], expected = objective.terms.find(t => t.metric === id)?.metricContractDigest ?? objective.constraints.find(c => c.metric === id)!.metricContractDigest
    if (metric && metric.contractDigest !== expected) throw new TypeError('objective input contract mismatch')
    const available = metric?.status === 'available' && Number.isFinite(metric.value)
    if (required.has(id) && !available) {
      if (metric?.status === 'invalid') status = 'invalid'
      else if (status === 'available') status = 'missing'
    }
    for (const ref of metric?.evidenceRefs ?? []) refs.add(ref)
    inputs.push({ metric: id, contractDigest: expected, rawInputRefs: metric?.evidenceRefs ?? [], ...(available ? { value: metric!.value } : {}) })
  }
  for (const term of objective.terms) {
    const input = inputs.find(i => i.metric === term.metric)!
    if (term.weight === 0) {
      contributions.push({ metric: term.metric, weight: 0, scale: term.scale, contribution: 0 })
      continue
    }
    const scaled = input.value === undefined ? undefined : div(rational(input.value), rational(term.scale))
    const contribution = scaled && mul(scaled, rational(term.weight))
    if (contribution) sum = add(sum, contribution)
    const finiteContribution = scaled && Number.isFinite(numeric(scaled)) && Number.isFinite(numeric(contribution!))
    if (scaled && !finiteContribution) status = 'invalid'
    contributions.push({ metric: term.metric, weight: term.weight, scale: term.scale,
      ...(finiteContribution ? { scaledValue: numeric(scaled!), contribution: numeric(contribution!) } : {}) })
  }
  const constraintResults: ObjectiveScoreEvidence['constraintResults'] = objective.constraints.map(c => {
    verifySealed(c)
    const metric = metrics[c.metric], reference = baseline?.metrics[c.metric]
    const evidenceRefs = [...metric?.evidenceRefs ?? [], ...reference?.evidenceRefs ?? []]
    const base = { constraintDigest: c.digest, ...(baseline ? { referenceDigest: baseline.digest } : {}), evidenceRefs }
    if (metric?.status !== 'available' || c.rule === 'no_regression' && reference?.status !== 'available') return { ...base, status: 'unavailable' }
    if (reference && reference.contractDigest !== c.metricContractDigest) throw new TypeError('baseline metric contract mismatch')
    const boundary = c.rule === 'minimum' ? rational(c.value) : add(rational(reference!.value!), rational((c.direction === 'maximize' ? -1 : 1) * (c.tolerance ?? 0)))
    const difference = comparisonKey(metric.value!, c.comparisonPrecision) - comparisonKey(boundary, c.comparisonPrecision)
    return { ...base, status: (c.direction === 'maximize' ? difference >= 0n : difference <= 0n) ? 'passed' : 'failed' }
  })
  const score = numeric(sum)
  if (!Number.isFinite(score)) status = 'invalid'
  const inputsComplete = status === 'available'
  if (constraintResults.some(c => c.status === 'unavailable') && status === 'available') status = 'missing'
  return sealed({ schemaVersion: 1 as const, kind: 'refine-objective-score' as const, objective, objectiveDigest: objective.digest,
    projectorDigest: objectiveProjectorDigest, status, ...(inputsComplete ? { score } : {}), scopeDigest,
    rawMetricsRefs: [...refs].sort(), inputs, contributions, constraintResults })
}

export function objectiveScopeDigest(input: { tasks: Array<{ id: string; repetitions: number[]; weight: number }>; conditionDigest: string; partition: string }): string {
  return digestJson({ ...input, tasks: input.tasks.map(t => ({ ...t, repetitions: [...t.repetitions].sort((a, b) => a - b) })).sort((a, b) => a.id.localeCompare(b.id)) })
}
