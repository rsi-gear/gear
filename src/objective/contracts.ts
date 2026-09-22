import { digestJson } from '../state/digest.js'
import type { ObjectiveDefinition, RawMetricContract, RawMetricDefinition, ResolvedObjective } from './types.js'

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[], name: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is unsupported`)
}
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`)
}
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${name} must be a nonempty string`)
}
export function sealed<T extends object>(body: T): T & { digest: string } { return { ...body, digest: digestJson(body) } }
export function verifySealed(value: { digest: string }) {
  const { digest, ...body } = value
  if (digest !== digestJson(body)) throw new TypeError('objective/raw metric immutable digest mismatch')
}
export function parseObjective(value: unknown = { terms: [{ metric: 'pass_rate', weight: 1 }] }): ObjectiveDefinition {
  const input = object(value, 'objective')
  fields(input, ['terms', 'constraints'], 'objective')
  if (!Array.isArray(input.terms) || !input.terms.length) throw new TypeError('objective.terms must be nonempty')
  const terms = input.terms.map(item => {
    const term = object(item, 'objective term'); fields(term, ['metric', 'weight', 'scale'], 'objective term')
    nonempty(term.metric, 'metric'); finite(term.weight, 'weight')
    const scale = term.scale === undefined ? 1 : term.scale; finite(scale, 'scale')
    if (scale <= 0) throw new TypeError('scale must be positive')
    return { metric: term.metric, weight: term.weight, scale }
  })
  if (new Set(terms.map(t => t.metric)).size !== terms.length) throw new TypeError('duplicate objective metric')
  if (!terms.some(t => t.weight !== 0)) throw new TypeError('objective weights cannot all be zero')
  if (input.constraints !== undefined && !Array.isArray(input.constraints)) throw new TypeError('objective.constraints must be an array')
  const constraints = (input.constraints as unknown[] | undefined ?? []).map(item => {
    const c = object(item, 'constraint'); nonempty(c.metric, 'constraint metric')
    if (c.rule === 'minimum') {
      fields(c, ['metric', 'rule', 'value'], 'constraint'); finite(c.value, 'constraint value')
      return { metric: c.metric, rule: c.rule, value: c.value } as const
    }
    fields(c, ['metric', 'rule', 'reference', 'tolerance'], 'constraint')
    if (c.rule !== 'no_regression' || c.reference !== 'initial_baseline') throw new TypeError('unsupported objective constraint/reference')
    const tolerance = c.tolerance === undefined ? 0 : c.tolerance; finite(tolerance, 'constraint tolerance')
    if (tolerance < 0) throw new TypeError('constraint tolerance must be nonnegative')
    return { metric: c.metric, rule: c.rule, reference: c.reference, tolerance } as const
  })
  return { terms: terms.sort((a, b) => a.metric.localeCompare(b.metric)), constraints: constraints.sort((a, b) => digestJson(a).localeCompare(digestJson(b))) }
}

export function resolveMetric(value: unknown): RawMetricContract {
  const d = object(value, 'metric contract')
  fields(d, ['id', 'revision', 'unit', 'direction', 'source', 'range', 'granularity', 'repetitionReducer', 'taskReducer', 'comparisonPrecision', 'measurement'], 'metric contract')
  for (const key of ['id', 'revision', 'unit']) nonempty(d[key], `metric ${key}`)
  if (!['maximize', 'minimize'].includes(d.direction as string) || !['trial', 'dataset-aggregate'].includes(d.granularity as string)
    || d.repetitionReducer !== 'mean' || d.taskReducer !== 'weighted-mean') throw new TypeError('unsupported raw metric aggregation/direction')
  finite(d.comparisonPrecision, 'metric comparisonPrecision')
  if (d.comparisonPrecision <= 0) throw new TypeError('metric precision must be positive')
  const source = object(d.source, 'metric source'); fields(source, ['path', 'extractor', 'equals'], 'metric source')
  nonempty(source.path, 'metric source.path')
  if (!/^(scores|rewards|originalResult|verifier)(\.[a-zA-Z0-9_-]+)+$/u.test(source.path)
    || source.path.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new TypeError('unsupported raw metric source path')
  if (!['number-v1', 'boolean-v1', 'equals-v1'].includes(source.extractor as string)) throw new TypeError('unsupported metric extractor')
  if (source.extractor === 'equals-v1') {
    if (!['number', 'boolean', 'string'].includes(typeof source.equals) || typeof source.equals === 'number' && !Number.isFinite(source.equals)) throw new TypeError('equals extractor requires a finite scalar')
  } else if (source.equals !== undefined) throw new TypeError('equals is only valid with equals-v1')
  if (d.range !== undefined) {
    const bounds = object(d.range, 'metric range'); fields(bounds, ['min', 'max'], 'metric range')
    finite(bounds.min, 'range min'); finite(bounds.max, 'range max')
    if (bounds.min >= bounds.max) throw new TypeError('invalid metric range')
  }
  if (d.id === 'pass_rate' && (source.extractor === 'number-v1' || d.direction !== 'maximize' || d.unit !== 'ratio')) throw new TypeError('pass_rate requires an explicit boolean or equality pass predicate')
  if (d.measurement !== undefined) {
    const m = object(d.measurement, 'measurement')
    fields(m, ['kind', 'scope', 'providerModels', 'priceSnapshot', 'tokenAccounting', 'timeBoundary', 'retryAccounting'], 'measurement')
    if (!['actual', 'api-equivalent', 'counter', 'wall-clock'].includes(m.kind as string)) throw new TypeError('unsupported measurement kind')
    for (const k of ['scope', 'tokenAccounting', 'timeBoundary', 'retryAccounting']) nonempty(m[k], `measurement ${k}`)
    if (!Array.isArray(m.providerModels) || !m.providerModels.length) throw new TypeError('measurement requires providerModels')
    for (const p of m.providerModels) nonempty(p, 'provider/model')
    if (m.kind === 'actual' || m.kind === 'api-equivalent') nonempty(m.priceSnapshot, 'measurement priceSnapshot')
  }
  if (['api_cost_usd', 'total_tokens', 'latency_ms', 'model_requests'].includes(d.id as string) && d.measurement === undefined) throw new TypeError('usage metrics require a measurement contract')
  return sealed({ ...structuredClone(d) as unknown as RawMetricDefinition, schemaVersion: 1 as const })
}

export function resolveObjective(input: unknown, contracts: RawMetricContract[]): ResolvedObjective {
  const definition = parseObjective(input)
  if (new Set(contracts.map(c => c.id)).size !== contracts.length) throw new TypeError('duplicate raw metric contract')
  for (const c of contracts) verifySealed(c)
  const contract = (id: string, required: boolean) => {
    const found = contracts.find(c => c.id === id)
    if (!found) throw new TypeError(`unknown or unsupported objective metric ${id}; available: ${contracts.map(c => c.id).join(', ')}`)
    if (required && found.granularity !== 'trial') throw new TypeError(`objective metric ${id} requires per-trial evidence for staged search`)
    return found
  }
  return sealed({ schemaVersion: 1 as const, direction: 'maximize' as const,
    terms: definition.terms.map(t => ({ ...t, scale: t.scale ?? 1, metricContractDigest: contract(t.metric, t.weight !== 0).digest })),
    constraints: (definition.constraints ?? []).map(c => {
      const m = contract(c.metric, true)
      return sealed({ ...c, metricContractDigest: m.digest, direction: m.direction, comparisonPrecision: m.comparisonPrecision })
    }), scorerVersion: 'linear-raw-v1' as const, comparisonPrecision: 1e-9 })
}

export function objectiveFormula(objective: ResolvedObjective): string {
  return objective.terms.map(t => `${t.weight} × (${t.metric} / ${t.scale})`).join(' + ')
}

export function validateResolvedObjective(value: ResolvedObjective): void {
  const input = object(value, 'resolved objective')
  fields(input, ['schemaVersion', 'direction', 'terms', 'constraints', 'scorerVersion', 'comparisonPrecision', 'digest'], 'resolved objective')
  verifySealed(value)
  if (value.schemaVersion !== 1 || value.direction !== 'maximize' || value.scorerVersion !== 'linear-raw-v1') throw new TypeError('unsupported objective definition')
  finite(value.comparisonPrecision, 'objective comparisonPrecision')
  if (value.comparisonPrecision <= 0 || !Array.isArray(value.terms) || !Array.isArray(value.constraints)) throw new TypeError('invalid resolved objective')
  const digest = (value: unknown) => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError('invalid metric contract digest') }
  for (const t of value.terms) {
    fields(object(t, 'resolved term'), ['metric', 'weight', 'scale', 'metricContractDigest'], 'resolved term')
    digest(t.metricContractDigest); finite(t.scale, 'resolved scale')
  }
  for (const c of value.constraints) {
    fields(object(c, 'resolved constraint'), ['metric', 'rule', 'value', 'reference', 'tolerance', 'metricContractDigest', 'direction', 'comparisonPrecision', 'digest'], 'resolved constraint')
    verifySealed(c); digest(c.metricContractDigest)
    finite(c.comparisonPrecision, 'constraint comparisonPrecision')
    if (c.comparisonPrecision <= 0 || !['maximize', 'minimize'].includes(c.direction)) throw new TypeError('invalid resolved constraint')
    const term = value.terms.find(t => t.metric === c.metric)
    if (term && term.metricContractDigest !== c.metricContractDigest) throw new TypeError('constraint metric contract mismatch')
  }
  parseObjective({ terms: value.terms.map(({ metric, weight, scale }) => ({ metric, weight, scale })),
    constraints: value.constraints.map(c => c.rule === 'minimum' ? { metric: c.metric, rule: c.rule, value: c.value }
      : { metric: c.metric, rule: c.rule, reference: c.reference, tolerance: c.tolerance }) })
}
