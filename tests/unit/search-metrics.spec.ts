import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { buildArchive } from '../../src/search/archive.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { completeArchivedEvidence } from '../../src/search/completion.js'
import { plannedCellCount, validateSettings } from '../../src/search/contracts.js'
import { cellIdentity, completeEvidence, profile } from '../../src/search/evidence.js'
import { assessGate, decideFinal, precheckSeed, rankProfiles } from '../../src/search/promotion.js'
import type { Stage, TaskUniverse } from '../../src/search/types.js'
import { evaluatedFixture, fixtures, revise, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'

function rows(u: TaskUniverse, values: Record<string, { outcome: number[]; process?: number[] }>, stage: Stage = 'global-seed') {
  const scope = scopeFixture(u, u.tasks.map(t => t.id)), participants = Object.keys(values)
  return Object.entries(values).map(([id, value]) => {
    const s = snapshot(id)
    return { snapshot: s, ...evaluatedFixture(u, scope, s, taskId => {
      const index = Number(taskId.slice(5))
      return { outcome: value.outcome[index]!, ...(value.process ? { process: value.process[index]! } : {}) }
    }, { stage, participants }) }
  })
}
function pair(u: TaskUniverse, values: Parameters<typeof rows>[1], stage: Stage = 'global-seed') {
  const [a, b] = rows(u, values, stage)
  return { universe: u, plan: a!.plan, anchor: a!.snapshot, candidate: b!.snapshot, baseline: a!.result, result: b!.result }
}
function groupedUniverse(): TaskUniverse {
  const u = universe(2, 'seed', true)
  return revise(u, { tasks: u.tasks.map((t, i) => ({ ...t, process: revise(t.process!, {
    id: i ? 'elapsed' : 'partial-credit', group: i ? 'seconds' : 'credit',
    direction: i ? 'minimize' : 'maximize', range: { min: 0, max: i ? 100 : 1 }, comparisonQuantum: i ? 0.1 : 0.000001,
    applicableTaskSetDigest: digestJson([t.contentDigest]),
  }) })) })
}

describe('metric contracts and independent release constraints', () => {
  it.each([0.5, 1])('allows bridge process regression but vetoes it at both full gates at outcome %s', candidateOutcome => {
    const u = universe(2, 'seed', true), config = settings().promotion
    const values = { A: { outcome: [0.5, 0.5], process: [0.8, 0.8] }, B: { outcome: [candidateOutcome, candidateOutcome], process: [0.6, 0.6] } }
    expect(assessGate(pair(u, values, 'bridge'), config, false)).toMatchObject({
      outcome: 'eligible', reasonCodes: [], comparison: { outcomeGain: candidateOutcome - 0.5, processGains: { process: -0.2 } },
    })
    const global = precheckSeed(pair(u, values), config)
    expect(global.outcome).toBe('rejected')
    expect(global.reasonCodes).toContain('process-regression:process')
    const passingSeed = pair(u, { A: values.A, B: { outcome: [1, 1], process: [1, 1] } })
    const heldOut = pair(universe(2, 'held-out', true), values, 'held-out')
    expect(decideFinal(passingSeed, heldOut, config)).toMatchObject({ outcome: 'rejected', reasonCodes: ['process-regression:process'] })
  })

  it.each([
    [0.44, 0.835871696, 'rejected'],
    [0.44, 0.838669818, 'eligible'],
    [0.44, 0.84, 'eligible'],
    [0.4, 0.84, 'eligible'],
    [0.4, 0.838669818, 'rejected'],
    [0.4, 0.83, 'rejected'],
    [0.39, 1, 'rejected'],
  ] as const)('requires non-regressing full outcome and process, with a strict gain: outcome %s and process %s => %s', (outcome, process, expected) => {
    const u = universe(2, 'seed', true), config = settings().promotion
    const input = pair(u, { A: { outcome: [0.4, 0.4], process: [0.838669818, 0.838669818] }, B: { outcome: [outcome, outcome], process: [process, process] } })
    expect(precheckSeed(input, config).outcome).toBe(expected)
  })

  it('keeps bridge admission blocked by outcome regression, protected tasks and missing process evidence', () => {
    const u = universe(2, 'seed', true), config = settings().promotion
    const base = { outcome: [0.5, 0.5], process: [0.8, 0.8] }
    const regressed = pair(u, { A: base, B: { outcome: [0.4, 0.4], process: [0.6, 0.6] } }, 'bridge')
    expect(assessGate(regressed, config, false).reasonCodes).toEqual(['outcome-regression'])
    const missing = pair(u, { A: base, B: { outcome: [1, 1] } }, 'bridge')
    expect(assessGate(missing, config, false)).toMatchObject({ outcome: 'insufficient-evidence', reasonCodes: ['incomplete-stage-evidence'] })
    config.protectedTasks = [{ taskId: 'task-0', partition: 'seed', rule: 'no-regression' }]
    const protectedRegression = pair(u, { A: base, B: { outcome: [0.4, 1], process: [0.6, 0.6] } }, 'bridge')
    expect(assessGate(protectedRegression, config, false).reasonCodes).toEqual(['protected-task:task-0'])
  })

  it('[E02,M07] uses uniform task macro weights even when provider metadata contains unequal weights', () => {
    const base = universe(2), u = revise(base, { tasks: base.tasks.map((t, i) => ({ ...t, weight: i ? 1 : 1000 })) })
    const input = pair(u, { A: { outcome: [1, 0] }, B: { outcome: [0.9, 0.9] } })
    const p = profile(u, input.plan, input.anchor, input.baseline, 'auto')
    expect(p.outcome).toBe(0.5)
    expect(precheckSeed(input, settings().promotion)).toMatchObject({ outcome: 'eligible', comparison: { outcomeGain: 0.4 } })
    expect(profile(u, input.plan, input.anchor, input.baseline, 'auto', { 'task-0': 3, 'task-1': 1 }).outcome).toBe(0.75)
    expect(() => profile(u, input.plan, input.anchor, input.baseline, 'auto', { 'task-0': 1 })).toThrow('frozen task manifest')
  })

  it('[M05] compares exact quantized gain keys without a floating-point round trip', () => {
    const base = universe(2), contract = revise(base.tasks[0]!.outcome, { comparisonQuantum: 1e-17 })
    const u = revise(base, { tasks: base.tasks.map(t => ({ ...t, outcome: contract })) })
    const config = settings().promotion
    config.outcome.minimumGain = 0.39999999999999997
    const gate = precheckSeed(pair(u, { A: { outcome: [0.5, 0.5] }, B: { outcome: [0.9, 0.9] } }), config)
    expect(gate.outcome).toBe('eligible')
    expect(gate.comparison.outcomeGain).toBe(0.4)
  })

  it('[M07] pairs different per-task repetition counts, preserves valid zero and excludes retries from statistical weight', () => {
    const base = universe(2, 'seed', true)
    const u = revise(base, { repetitions: [{ index: 0, seed: 17 }, { index: 1, seed: 29 }],
      tasks: base.tasks.map((t, i) => ({ ...t, repetitionIndices: i ? [0] : [0, 1] })) })
    const scope = scopeFixture(u, ['task-0', 'task-1']), a = snapshot('A'), b = snapshot('B')
    const row = evaluatedFixture(u, scope, a, (id, repetition) => ({ outcome: id === 'task-0' ? repetition : 1, process: id === 'task-0' ? repetition : 1 }), { participants: ['A', 'B'] })
    expect(() => validateSettings(settings(), u, universe(2, 'held-out'), 2)).not.toThrow()
    const p = profile(u, row.plan, a, row.result, 'auto')
    expect(p.coverage).toMatchObject({ planned: 3, available: 3, notEvaluated: 0 })
    expect(p.processCoverage).toMatchObject({ planned: 3, available: 3 })
    expect(p.outcome).toBe(0.75)
    expect(p.processGroups.process).toBe(0.75)
    expect(plannedCellCount(u, ['task-0'])).toBe(2)
    const local = evaluatedFixture(u, scopeFixture(u, ['task-1']), a, () => ({ outcome: 1, process: 1 }))
    expect(profile(u, local.plan, a, local.result, 'auto').coverage).toMatchObject({ planned: 1, available: 1, notEvaluated: 2 })
    const other = evaluatedFixture(u, scope, b, () => ({ outcome: 1, process: 1 }), { participants: ['A', 'B'] })
    const gate = assessGate({ universe: u, plan: row.plan, anchor: a, candidate: b, baseline: row.result, result: other.result }, settings().promotion, true)
    expect(gate.outcome).toBe('eligible')
    const duplicate = revise(row.result, { cells: [...row.result.cells, row.result.cells[0]!] })
    expect(() => profile(u, row.plan, a, duplicate, 'auto')).toThrow('duplicate')
    expect(() => cellIdentity(u, 'task-1', 1, a)).toThrow('slot manifest')
    expect(() => completeEvidence(row.result, [revise(row.result.cells[0]!, { outcome: { status: 'available', rawValue: 1, contractDigest: u.tasks[0]!.outcome.digest, evidenceRef: row.result.cells[0]!.evidenceRef } })])).toThrow('replace a valid outcome')
  })

  it('[M07] rejects empty, duplicate and undeclared per-task repetition slots before admission', () => {
    const base = universe(2)
    for (const indices of [[], [0, 0], [1], [-1]]) {
      const u = revise(base, { tasks: [{ ...base.tasks[0]!, repetitionIndices: indices }, base.tasks[1]!] })
      expect(() => validateSettings(settings(), u, universe(2, 'held-out'), 2)).toThrow('per-task repetition')
    }
  })

  it('[A05,P04] retains a low-outcome process specialist without using process to offset outcome regression', () => {
    const u = universe(2, 'seed', true), items = rows(u, { A: { outcome: [1, 1], process: [0.1, 0.1] }, B: { outcome: [0.9, 0.9], process: [0.9, 0.9] } }, 'local')
    const archive = buildArchive({ evolutionId: 'metrics', universe: u, snapshots: items.map(r => r.snapshot), scopes: [items[0]!.scope], results: items.map(r => r.result), plans: items.map(r => r.plan), config: settings().search, championId: 'A' })
    expect(archive.parentProbabilities).toEqual({ A: 0.75, B: 0.25 })
    expect(assessGate({ universe: u, plan: items[0]!.plan, anchor: items[0]!.snapshot, candidate: items[1]!.snapshot, baseline: items[0]!.result, result: items[1]!.result }, settings().promotion, true).reasonCodes).toContain('outcome-regression')
  })

  it('[P02,E07] nominates and accepts a macro winner even when it has no task frontier membership', () => {
    const u = universe(2), items = rows(u, { A: { outcome: [1, 0] }, B: { outcome: [0, 1] }, C: { outcome: [0.6, 0.6] } }, 'local')
    const archive = buildArchive({ evolutionId: 'metrics', universe: u, snapshots: items.map(r => r.snapshot), scopes: [items[0]!.scope], results: items.map(r => r.result), plans: items.map(r => r.plan), config: settings().search, championId: 'A' })
    expect(archive.activeParentIds).toEqual(['A', 'B'])
    expect(rankProfiles(u, items.map(r => ({ id: r.snapshot.candidateId, profile: profile(u, r.plan, r.snapshot, r.result, 'off') })))[0]).toBe('C')
    const seed = pair(u, { A: { outcome: [1, 0] }, C: { outcome: [0.6, 0.6] } })
    const heldOut = pair(universe(2, 'held-out'), { A: { outcome: [0.5, 0.5] }, C: { outcome: [0.6, 0.6] } }, 'held-out')
    expect(decideFinal(seed, heldOut, settings().promotion).outcome).toBe('accepted')
    const forged = revise(items[2]!.result, { cells: [items[0]!.result.cells[0]!, items[1]!.result.cells[1]!] })
    expect(() => profile(u, items[2]!.plan, items[2]!.snapshot, forged, 'off')).toThrow('unplanned evidence cell')
  })

  it('[P05] enforces task and assertion protection independently of aggregate gain', () => {
    const u = universe(2), config = settings().promotion
    config.protectedTasks = [{ taskId: 'task-0', partition: 'seed', rule: 'no-regression' }]
    const input = pair(u, { A: { outcome: [1, 0] }, B: { outcome: [0.9, 1] } })
    expect(precheckSeed(input, config).reasonCodes).toContain('protected-task:task-0')
    config.protectedTasks = []
    config.protectedAssertions = [{ taskId: 'task-0', partition: 'seed', assertionId: 'safety', schemaDigest: digestJson('assertions'), rule: 'no-new-violation' }]
    const scope = scopeFixture(u, ['task-0', 'task-1'])
    const a = evaluatedFixture(u, scope, input.anchor, () => ({ outcome: 0.5, assertions: [{ id: 'safety', schemaDigest: digestJson('assertions'), status: 'passed' }] }), { stage: 'global-seed', participants: ['A', 'B'] })
    const b = evaluatedFixture(u, scope, input.candidate, () => ({ outcome: 1, assertions: [{ id: 'safety', schemaDigest: digestJson('assertions'), status: 'failed' }] }), { stage: 'global-seed', participants: ['A', 'B'] })
    expect(precheckSeed({ ...input, plan: a.plan, baseline: a.result, result: b.result }, config).reasonCodes).toContain('protected-assertion:task-0:safety')
    expect(precheckSeed(input, config).outcome).toBe('insufficient-evidence')
    const duplicate = revise(b.result, { cells: b.result.cells.map((c, i) => i ? c : revise(c, { assertions: [...c.assertions!, { ...c.assertions![0]!, status: 'passed' }] })) })
    expect(() => precheckSeed({ ...input, plan: a.plan, baseline: a.result, result: duplicate }, config)).toThrow('duplicate assertion identity')
  })

  it('[M09,M05] keeps heterogeneous process groups separate for ties, bounds and improvement', () => {
    const u = groupedUniverse(), config = settings()
    expect(() => validateSettings(config, u, universe(2, 'held-out'), 2)).toThrow('explicit group thresholds')
    config.promotion.process.groups = { credit: { minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 }, seconds: { minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 } }
    expect(() => validateSettings(config, u, universe(2, 'held-out'), 2)).not.toThrow()
    const tied = rows(u, { A: { outcome: [0.5, 0.5], process: [0.9, 90] }, B: { outcome: [0.5, 0.5], process: [0.1, 10] } })
    const profiles = tied.map(r => ({ id: r.snapshot.candidateId, profile: profile(u, r.plan, r.snapshot, r.result, 'auto') }))
    expect(profiles[0]!.profile.processGroups).toEqual({ credit: 0.9, seconds: -90 })
    expect(rankProfiles(u, profiles)).toEqual(['A', 'B'])
    const worseSeconds = pair(u, { A: { outcome: [0.5, 0.5], process: [0.5, 50] }, B: { outcome: [0.5, 0.5], process: [0.8, 60] } })
    expect(precheckSeed(worseSeconds, config.promotion).reasonCodes).toContain('process-regression:seconds')
    const bothBetter = pair(u, { A: { outcome: [0.5, 0.5], process: [0.5, 50] }, B: { outcome: [0.5, 0.5], process: [0.8, 40] } })
    expect(precheckSeed(bothBetter, config.promotion)).toMatchObject({ outcome: 'eligible', comparison: { processGains: { credit: 0.3, seconds: 10 } } })
  })

  it('[M01,M01b,M06] distinguishes dataset aggregates, trial scalars and incomplete projected support', () => {
    const base = universe(2, 'seed', true)
    const aggregate = revise(base.tasks[0]!.process!, { granularity: 'dataset-aggregate' })
    const aggregateUniverse = revise(base, { tasks: base.tasks.map(t => ({ ...t, process: aggregate })) })
    const input = pair(aggregateUniverse, { A: { outcome: [0.5, 0.5] }, B: { outcome: [1, 1] } })
    expect(precheckSeed(input, settings().promotion).outcome).toBe('eligible')
    expect(profile(aggregateUniverse, input.plan, input.candidate, input.result, 'auto').processTaskIds).toEqual([])
    const scalar = pair(base, { A: { outcome: [0.5, 0.5], process: [0.1, 0.1] }, B: { outcome: [0.5, 0.5], process: [0.5, 0.5] } })
    expect(scalar.result.cells.every(c => c.assertions === undefined)).toBe(true)
    expect(precheckSeed(scalar, settings().promotion).outcome).toBe('eligible')
    const missing = revise(scalar.result, { cells: scalar.result.cells.map((c, i) => i ? revise(c, { process: { status: 'missing', contractDigest: c.identity.processContractDigest!, reason: 'projection unavailable' } }) : c) })
    const projected = profile(base, scalar.plan, scalar.candidate, missing, 'auto')
    expect(projected.outcomeComplete).toBe(true)
    expect(projected.processComplete).toBe(false)
    expect(projected.processGroups).toEqual({})
    expect(projected).not.toHaveProperty('processScore')
    expect(precheckSeed({ ...scalar, result: missing }, settings().promotion).outcome).toBe('insufficient-evidence')
  })
  it('[E02,M07] prices staged plans by actual logical cells while sizing task sets by task count', async () => {
    const f = fixtures(20), config = settings(), root = await mkdtemp(join(tmpdir(), 'gear-repeat-plans-'))
    const u = revise(f.seed, { repetitions: [{ index: 0, seed: 0 }, { index: 1, seed: 7 }], tasks: f.seed.tasks.map((t, i) => ({ ...t, repetitionIndices: i % 2 ? [0, 1] : [0] })) })
    f.provider.describe = async partition => partition === 'seed' ? u : f.heldOut
    const store = new SearchStore(root)
    try {
      const result = await new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run({ evolutionId: 'slots', roundId: 'r0', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('fixed'), settings: config }, new AbortController().signal)
      expect(result.championChanged).toBe(true)
      expect(result.research.sizing.universeSize).toBe(20)
      expect(plannedCellCount(u, u.tasks.map(t => t.id))).toBe(30)
      const archive = (await store.archive())!, bridge = result.research.bridge.plan!
      const localCost = new Map(result.research.workplans.map(w => [w.candidateId, plannedCellCount(u, archive.plans.find(p => p.digest === w.localStagePlanDigest)!.taskIds)]))
      const bridgeCells = plannedCellCount(u, bridge.taskIds)
      const expected = [...localCost.values()].reduce((a, b) => a + b, 0)
        + bridge.participantIds.filter(id => id !== f.anchor.candidateId).reduce((sum, id) => sum + bridgeCells - localCost.get(id)!, 0)
        + 30 - bridgeCells
      expect(f.executions.filter(e => e.participant !== 'anchor' && e.stage !== 'held-out').reduce((sum, e) => sum + e.count, 0)).toBe(expected)
      expect(result.research.remainingBudget.cells).toBe(config.budgets.round.maxNewRolloutCells - f.executions.reduce((sum, e) => sum + e.count, 0))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('[A06] uses actual completion chronology across timezone offsets instead of selecting a later lucky score', () => {
    const u = universe(2), scope = scopeFixture(u, ['task-0', 'task-1']), tree = 'a'.repeat(40)
    const a = snapshot('A', [], tree), b = snapshot('B', ['A'], tree), c = snapshot('C')
    const items = [
      evaluatedFixture(u, scope, a, () => ({ outcome: 0 }), { completedAt: '2026-01-01T00:30:00+01:00' }),
      evaluatedFixture(u, scope, b, () => ({ outcome: 1 }), { completedAt: '2026-01-01T00:00:00Z' }),
      evaluatedFixture(u, scope, c, () => ({ outcome: 0.5 })),
    ]
    const result = buildArchive({ evolutionId: 'chronology', universe: u, snapshots: [a, b, c], scopes: [scope], results: items.map(r => r.result), plans: items.map(r => r.plan), config: settings().search, championId: 'A' })
    expect(result.scopeViews[0]!.representatives.B).toBe('A')
    expect(result.activeParentIds).toEqual(['C'])
    expect(result.results).toContainEqual(items[1]!.result)
  })

  it('[M01] never projects dataset-only process metrics while completing outcome evidence', async () => {
    const f = fixtures(20, true), root = await mkdtemp(join(tmpdir(), 'gear-aggregate-process-'))
    const aggregate = revise(f.seed.tasks[0]!.process!, { granularity: 'dataset-aggregate' })
    const u = revise(f.seed, { tasks: f.seed.tasks.map(t => ({ ...t, process: aggregate })) })
    f.provider.describe = async partition => partition === 'seed' ? u : f.heldOut
    let projections = 0
    f.provider.completeProcess = async () => { projections++; throw new Error('dataset aggregate must not create trial process') }
    const row = evaluatedFixture(u, scopeFixture(u, ['task-0', 'task-1']), f.anchor, id => id === 'task-0' ? { outcome: 0 } : undefined)
    const store = new SearchStore(root)
    try {
      const completion = await completeArchivedEvidence({ id: 'aggregate-1', store, provider: f.provider, universe: u, plan: row.plan, snapshot: f.anchor, original: row.result, settings: settings(), signal: new AbortController().signal })
      const complete = await store.object<typeof row.result>(completion.completedResultDigest)
      expect(profile(u, row.plan, f.anchor, complete, 'auto').outcomeComplete).toBe(true)
      expect(projections).toBe(0)
      expect(f.executions.map(e => e.count)).toEqual([1])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

})

it('[M06,M07] gives Meta a task-weighted complete baseline and removes unavailable process aggregates', async () => {
  const { legacySearchEvidence, searchProjectionAggregates } = await import('../../src/search/legacy.js')
  const base = universe(2, 'seed', true)
  const u = revise(base, { repetitions: [{ index: 0, seed: 0 }, { index: 1, seed: 1 }], tasks: base.tasks.map((t, i) => ({ ...t, repetitionIndices: i ? [0, 1] : [0] })) })
  const s = snapshot('parent'), scope = scopeFixture(u, ['task-0', 'task-1'])
  const row = evaluatedFixture(u, scope, s, id => ({ outcome: id === 'task-0' ? 0 : 1 }))
  const context = { universe: u, plan: row.plan, scope, processMode: 'auto' as const }
  const projection = legacySearchEvidence(row.result, s, 'condition', 'seed', context)
  expect(projection.primaryReward).toBe(0.5)
  expect(projection.plannedTrialCount).toBe(3)
  expect(projection.summary).toEqual({ total: 2, passed: 1, failed: 1, score: 0.5 })
  expect(projection.processScore).toBeUndefined()
  expect(projection.summary.process).toBeUndefined()
  expect(projection.metadata).toMatchObject({ processAggregateStatus: 'unavailable', summaryUnit: 'task' })
  expect(() => legacySearchEvidence(revise(row.result, { cells: row.result.cells.slice(0, 2) }), s, 'condition', 'seed', context)).toThrow('complete planned outcome')
  const complete = evaluatedFixture(u, scope, s, id => ({ outcome: id === 'task-0' ? 0 : 1, process: id === 'task-0' ? 0 : 1 }))
  const weighted = legacySearchEvidence(complete.result, s, 'condition', 'seed', context)
  expect(weighted.processScore).toBe(0.5)
  expect(searchProjectionAggregates(weighted)).toEqual({ taskCount: 2, outcome: 0.5, process: 0.5 })
  expect(() => searchProjectionAggregates({ ...weighted, metadata: { ...weighted.metadata as object, taskWeights: { 'task-0': 1, 'task-1': 1 } } })).toThrow('task weights')
})
