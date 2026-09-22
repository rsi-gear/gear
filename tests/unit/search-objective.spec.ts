import { describe, expect, it } from 'vitest'
import { resolveMetric, resolveObjective, sealed } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'
import type { ObjectiveDefinition } from '../../src/objective/types.js'
import { digestJson } from '../../src/state/digest.js'
import { profile, cellKey } from '../../src/search/evidence.js'
import { buildArchive } from '../../src/search/archive.js'
import { assessGate, precheckSeed, rankProfiles } from '../../src/search/promotion.js'
import { evaluatedFixture, revise, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'
import type { EvidenceCell, TaskUniverse } from '../../src/search/types.js'

const metrics = [resolveMetric({ id: 'pass_rate', revision: '1', unit: 'ratio', direction: 'maximize', source: { path: 'originalResult.pass', extractor: 'boolean-v1' },
  granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }),
resolveMetric({ id: 'process_score', revision: '1', unit: 'score', direction: 'maximize', source: { path: 'scores.processScore', extractor: 'number-v1' },
  granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 })]
function cohort(definition: ObjectiveDefinition = { terms: [{ metric: 'pass_rate', weight: .5 }, { metric: 'process_score', weight: .5 }] }) {
  return revise(universe(10, 'seed', true), { rawMetricContracts: metrics, objective: resolveObjective(definition, metrics) })
}
function rows(u: TaskUniverse, a: { pass: number; process: number }, b: { pass: number; process: number }) {
  const scope = scopeFixture(u, u.tasks.map(t => t.id))
  const participants = ['A', 'B']
  return [a, b].map((v, index) => {
    const s = snapshot(participants[index]!)
    const row = evaluatedFixture(u, scope, s, () => ({ outcome: .6, process: v.process }), { stage: 'global-seed', participants })
    const cells = row.result.cells.map(c => revise(c, { rawMetrics: extractRawMetrics({ contracts: metrics, certified: true,
      trial: { scores: { processScore: v.process }, originalResult: { pass: Number(c.identity.taskId.slice(5)) < v.pass * 10 } },
      identity: { taskId: c.identity.taskId, repetition: c.identity.repetition, runId: c.evidenceRef, attempt: 1, harnessCommit: c.identity.harnessCommit,
        conditionDigest: c.identity.conditionDigest, originalArtifactRefs: [digestJson(['source', c.identity])] } }) }))
    return { ...row, snapshot: s, result: revise(row.result, { cells }) }
  })
}
describe('objective scoring throughout staged search', () => {
  it('ranks and gates by the weighted score while preserving both original channels', () => {
    const u = cohort(), [a, b] = rows(u, { pass: .8, process: .4 }, { pass: .7, process: .8 })
    const profiles = [a!, b!].map(r => ({ id: r.snapshot.candidateId, profile: profile(u, r.plan, r.snapshot, r.result, 'auto') }))
    expect(profiles.map(r => r.profile.objectiveScore!.score)).toEqual([.6, .75])
    expect(profiles.map(r => r.profile.outcome)).toEqual([.6, .6])
    expect(rankProfiles(u, profiles)).toEqual(['B', 'A'])
    const input = { universe: u, plan: a!.plan, anchor: a!.snapshot, candidate: b!.snapshot, baseline: a!.result, result: b!.result }
    expect(precheckSeed(input, settings().promotion)).toMatchObject({ outcome: 'eligible', comparison: { objectiveGain: .15, processGains: {} } })
    const archive = buildArchive({ evolutionId: 'e', universe: u, snapshots: [a!.snapshot, b!.snapshot], scopes: [a!.scope], plans: [a!.plan],
      results: [a!.result, b!.result], config: settings().search, championId: 'A' })
    expect(archive.scopeViews[0]!.fronts.every(f => f.channel === 'objective')).toBe(true)
    expect(archive.scopeViews[0]!.processEligibleIds).toEqual([])
    expect(archive.parentProbabilities.B).toBeGreaterThan(0)
  })
  it('does not use process as a hidden tiebreak or alternate acceptance branch', () => {
    const u = cohort({ terms: [{ metric: 'pass_rate', weight: 1 }] }), [a, b] = rows(u, { pass: .8, process: .4 }, { pass: .8, process: 1 })
    expect(rankProfiles(u, [b!, a!].map(r => ({ id: r.snapshot.candidateId, profile: profile(u, r.plan, r.snapshot, r.result, 'auto') })))).toEqual(['A', 'B'])
    const input = { universe: u, plan: a!.plan, anchor: a!.snapshot, candidate: b!.snapshot, baseline: a!.result, result: b!.result }
    expect(precheckSeed(input, settings().promotion)).toMatchObject({ outcome: 'rejected', reasonCodes: ['no-substantive-objective-improvement'] })
    expect(precheckSeed(input, { ...settings().promotion, allowNeutral: true }).outcome).toBe('eligible')
  })
  it('requires only selected metrics, but never drops missing slots', () => {
    const u = cohort({ terms: [{ metric: 'pass_rate', weight: 1 }] }), [a, b] = rows(u, { pass: .8, process: .4 }, { pass: .9, process: .8 })
    const missing = (c: EvidenceCell) => revise(c, { rawMetrics: revise(c.rawMetrics!, { metrics: { ...c.rawMetrics!.metrics,
      process_score: { contractDigest: metrics[1]!.digest, unit: 'score', status: 'missing', evidenceRefs: [] } } }) })
    const result = revise(b!.result, { cells: b!.result.cells.map(missing) })
    expect(profile(u, b!.plan, b!.snapshot, result, 'auto').objectiveScore?.score).toBe(.9)
    expect(profile(u, b!.plan, b!.snapshot, revise(result, { cells: result.cells.slice(1) }), 'auto').objectiveComplete).toBe(false)
    const selected = cohort(), [c, d] = rows(selected, { pass: .8, process: .4 }, { pass: .9, process: .8 })
    expect(precheckSeed({ universe: selected, plan: c!.plan, anchor: c!.snapshot, candidate: d!.snapshot, baseline: c!.result,
      result: revise(d!.result, { cells: d!.result.cells.map(missing) }) }, settings().promotion).outcome).toBe('insufficient-evidence')
  })
  it('binds explicit quality constraints to the supplied frozen initial baseline', () => {
    const u = cohort({ terms: [{ metric: 'process_score', weight: 1 }], constraints: [{ metric: 'pass_rate', rule: 'no_regression', reference: 'initial_baseline' }] })
    const [initial, candidate] = rows(u, { pass: .8, process: .4 }, { pass: .7, process: .8 })
    const p = profile(u, initial!.plan, initial!.snapshot, initial!.result, 'auto')
    const reference = sealed({ scopeDigest: p.objectiveScore!.scopeDigest, metrics: p.rawMetrics! })
    const input = { universe: u, plan: initial!.plan, anchor: initial!.snapshot, candidate: candidate!.snapshot, baseline: initial!.result, result: candidate!.result, initialBaseline: reference }
    const gate = assessGate(input, settings().promotion, true)
    expect(gate).toMatchObject({ outcome: 'rejected', objectiveScore: { score: .8, constraintResults: [{ status: 'failed' }] } })
    expect(assessGate({ ...input, initialBaseline: undefined }, settings().promotion, true).outcome).toBe('insufficient-evidence')
  })
  it('changes derived identities while keeping raw execution slots reusable', () => {
    const u = cohort(), [a] = rows(u, { pass: .8, process: .4 }, { pass: .7, process: .8 })
    const changed = cohort({ terms: [{ metric: 'pass_rate', weight: .8 }, { metric: 'process_score', weight: .2 }] })
    const [b] = rows(changed, { pass: .8, process: .4 }, { pass: .7, process: .8 })
    expect(changed.digest).not.toBe(u.digest)
    expect(b!.result.cells.map(c => cellKey(c.identity))).toEqual(a!.result.cells.map(c => cellKey(c.identity)))
    expect(profile(u, a!.plan, a!.snapshot, a!.result, 'auto').objectiveScore!.digest).not.toBe(profile(changed, b!.plan, b!.snapshot, b!.result, 'auto').objectiveScore!.digest)
  })
})
