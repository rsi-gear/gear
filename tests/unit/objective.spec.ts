import { describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { parseObjective, resolveMetric, resolveObjective, sealed } from '../../src/objective/contracts.js'
import { aggregateRawMetrics, extractRawMetrics, scoreObjective } from '../../src/objective/scoring.js'
import type { RawMetricDefinition } from '../../src/objective/types.js'

const contract = (id: string, source: RawMetricDefinition['source'], extra: Partial<RawMetricDefinition> = {}) => resolveMetric({
  id, revision: '1', unit: 'ratio', direction: 'maximize', source, granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9, ...extra,
})
const pass = contract('pass_rate', { path: 'originalResult.passed', extractor: 'boolean-v1' })
const process = contract('process_score', { path: 'scores.processScore', extractor: 'number-v1' })
const custom = contract('custom', { path: 'rewards.custom', extractor: 'number-v1' })
const measurement = { kind: 'actual' as const, scope: 'all target, auxiliary, reducer, compaction and child calls including internal retries',
  providerModels: ['test/model'], priceSnapshot: digestJson('price-2026-09-20'), tokenAccounting: 'input + output; reasoning included in output; all cache buckets retained', timeBoundary: 'trial start to settled', retryAccounting: 'all internal retries included; infrastructure reruns separate' }
const cost = contract('api_cost_usd', { path: 'originalResult.usage.cost', extractor: 'number-v1' }, { unit: 'USD', direction: 'minimize', measurement })
const tokens = contract('total_tokens', { path: 'originalResult.usage.tokens', extractor: 'number-v1' }, { unit: 'token', direction: 'minimize', measurement: { ...measurement, kind: 'counter' } })
const contracts = [pass, process, custom, cost, tokens]
const scope = digestJson('scope')
function aggregate(values: Array<{ task?: string; repetition?: number; passed: boolean; q?: number; cost?: number; tokens?: number; custom?: number; certified?: boolean }>, weights?: Record<string, number>) {
  const records = values.map((v, i) => extractRawMetrics({ contracts, certified: v.certified !== false,
    trial: { scores: { processScore: v.q }, rewards: { custom: v.custom }, originalResult: { passed: v.passed, usage: { cost: v.cost, tokens: v.tokens } } },
    identity: { taskId: v.task ?? `task-${i}`, repetition: v.repetition ?? 0, runId: `run-${i}`, attempt: 1, harnessCommit: 'a'.repeat(40), conditionDigest: digestJson('condition'), originalArtifactRefs: [digestJson(v)] } }))
  const tasks = [...new Set(records.map(r => r.taskId))].map(id => ({ id, repetitions: records.filter(r => r.taskId === id).map(r => r.repetition), weight: weights?.[id] ?? 1 }))
  return { records, tasks, metrics: aggregateRawMetrics(contracts, tasks, records) }
}
describe('raw metrics and inline optimization objectives', () => {
  it('preserves finite extreme means and ignores zero-weight scale overflow', () => {
    const raw = aggregate([{ passed: true, q: 1e308 }, { passed: true, q: 1e308 }])
    expect(raw.metrics.process_score).toMatchObject({ status: 'available', value: 1e308, observationTotalExact: { denominator: '1' } })
    expect(raw.metrics.process_score!.observationTotal).toBeUndefined()
    const zero = resolveObjective({ terms: [{ metric: 'pass_rate', weight: 1 }, { metric: 'process_score', weight: 0, scale: 5e-324 }] }, contracts)
    expect(scoreObjective(zero, raw.metrics, scope)).toMatchObject({ status: 'available', score: 1 })
    const tiny = aggregate([{ passed: true, q: 5e-324 }])
    expect(scoreObjective(resolveObjective({ terms: [{ metric: 'process_score', weight: 1, scale: 5e-324 }] }, contracts), tiny.metrics, scope).score).toBe(1)
  })
  it('preserves unselected raw metrics, scales and all physical observations while using task macro means', () => {
    const raw = aggregate([{ task: 'a', repetition: 0, passed: true, q: 60, cost: 1, custom: 9 }, { task: 'a', repetition: 1, passed: true, q: 60, cost: 3, custom: 8 }, { task: 'b', passed: false, q: 60, cost: 6, custom: 7 }])
    const objective = resolveObjective({ terms: [{ metric: 'pass_rate', weight: .5 }, { metric: 'process_score', weight: .5, scale: 100 }] }, contracts)
    const result = scoreObjective(objective, raw.metrics, scope)
    expect(result.score).toBe(.55)
    expect(raw.metrics.process_score!.value).toBe(60)
    expect(raw.metrics.api_cost_usd).toMatchObject({ value: 4, observationTotal: 10 })
    expect(raw.metrics.custom!.value).toBe(7.75)
    expect(raw.metrics.total_tokens!.status).toBe('missing')
    expect(scoreObjective(resolveObjective(undefined, contracts), raw.metrics, scope).score).toBe(.5)
    expect(raw.records).toHaveLength(3)
  })
  it('reprojects immutable raw values with different weights and reverses the ranking', () => {
    const raw = (p: number, q: number) => Object.fromEntries([['pass_rate', p], ['process_score', q]].map(([id, value]) => [id, { status: 'available' as const, value: Number(value), unit: 'ratio', contractDigest: contracts.find(c => c.id === id)!.digest, evidenceRefs: [scope] }]))
    const a = raw(.8, .4), b = raw(.7, .8), before = structuredClone([a, b])
    const balanced = resolveObjective({ terms: [{ metric: 'pass_rate', weight: .5 }, { metric: 'process_score', weight: .5 }] }, contracts)
    expect(scoreObjective(balanced, a, scope).score).toBe(.6)
    expect(scoreObjective(balanced, b, scope).score).toBe(.75)
    expect(scoreObjective(resolveObjective(undefined, contracts), a, scope).score).toBe(.8)
    const changed = resolveObjective({ terms: [{ metric: 'pass_rate', weight: .8 }, { metric: 'process_score', weight: .2 }] }, contracts)
    expect(changed.digest).not.toBe(balanced.digest)
    expect(scoreObjective(changed, a, scope).score).toBe(.72)
    expect([a, b]).toEqual(before)
  })
  it('supports the SoL example without normalization, clipping or hidden quality gates', () => {
    const o = resolveObjective({ terms: [{ metric: 'pass_rate', weight: .5 }, { metric: 'process_score', weight: .5 }, { metric: 'api_cost_usd', weight: -.1 }, { metric: 'total_tokens', weight: -.1, scale: 100000 }] }, contracts)
    const metrics = aggregate(Array.from({ length: 10 }, (_, i) => ({ passed: i < 8, q: .9, cost: 1, tokens: 100000 }))).metrics
    expect(scoreObjective(o, metrics, scope).score).toBe(.65)
    const cheap = aggregate(Array.from({ length: 10 }, (_, i) => ({ passed: i < 8, q: .9, cost: .5, tokens: 50000 }))).metrics
    expect(scoreObjective(o, cheap, scope).score).toBe(.75)
    const penalty = resolveObjective({ terms: [{ metric: 'api_cost_usd', weight: -3 }] }, contracts)
    expect(scoreObjective(penalty, metrics, scope).score).toBe(-3)
    expect(scoreObjective(resolveObjective({ terms: [{ metric: 'process_score', weight: 5 }] }, contracts), metrics, scope).score).toBe(4.5)
  })
  it('does not fabricate missing values or rescue an invalid envelope', () => {
    const raw = aggregate([{ passed: true, q: .6 }])
    const zero = resolveObjective({ terms: [{ metric: 'pass_rate', weight: 1 }, { metric: 'total_tokens', weight: 0 }] }, contracts)
    expect(scoreObjective(zero, raw.metrics, scope)).toMatchObject({ status: 'available', score: 1 })
    expect(scoreObjective(zero, raw.metrics, scope).contributions.find(c => c.metric === 'total_tokens')).not.toHaveProperty('scaledValue')
    const required = resolveObjective({ terms: [{ metric: 'total_tokens', weight: -1 }] }, contracts)
    expect(scoreObjective(required, raw.metrics, scope)).toMatchObject({ status: 'missing' })
    expect(scoreObjective(required, raw.metrics, scope).score).toBeUndefined()
    const invalid = aggregate([{ passed: true, q: 1, certified: false }])
    expect(scoreObjective(resolveObjective(undefined, contracts), invalid.metrics, scope)).toMatchObject({ status: 'invalid' })
  })
  it('retains the actual score on explicit constraint failure, with a frozen scoped reference', () => {
    const baseline = sealed({ scopeDigest: scope, metrics: aggregate([{ passed: true, q: 1, cost: 2 }]).metrics })
    const objective = resolveObjective({ terms: [{ metric: 'api_cost_usd', weight: -1 }], constraints: [{ metric: 'pass_rate', rule: 'no_regression', reference: 'initial_baseline', tolerance: 0 }] }, contracts)
    const metrics = aggregate([{ passed: false, q: 1, cost: 0 }]).metrics
    expect(scoreObjective(objective, metrics, scope, baseline)).toMatchObject({ status: 'available', score: 0, constraintResults: [{ status: 'failed', referenceDigest: baseline.digest }] })
    expect(scoreObjective(objective, metrics, scope)).toMatchObject({ status: 'missing', constraintResults: [{ status: 'unavailable' }] })
    expect(() => scoreObjective(objective, metrics, digestJson('different-scope'), baseline)).toThrow('scope mismatch')
  })
  it.each([
    { terms: [] }, { terms: [{ metric: 'x', weight: 0 }] }, { terms: [{ metric: 'x', weight: Infinity }] },
    { terms: [{ metric: 'x', weight: 1, scale: 0 }] }, { terms: [{ metric: 'x', weight: 1 }, { metric: 'x', weight: 2 }] },
    { terms: [{ metric: 'x', weight: 1 }], expression: 'x' }, { terms: [{ metric: 'x', weight: 1 }], constraints: [{ metric: 'x', rule: 'no_regression', reference: 'champion' }] },
  ])('rejects invalid or unsupported objective definitions: %j', input => expect(() => parseObjective(input)).toThrow())
  it('requires a declared pass predicate and rejects dataset totals as staged inputs', () => {
    expect(() => resolveObjective(undefined, [process])).toThrow('pass_rate')
    expect(() => contract('pass_rate', { path: 'scores.totalScore', extractor: 'number-v1' })).toThrow('predicate')
    expect(() => resolveObjective({ terms: [{ metric: 'custom', weight: 1 }] }, [contract('custom', { path: 'rewards.custom', extractor: 'number-v1' }, { granularity: 'dataset-aggregate' })])).toThrow('per-trial')
  })
})
