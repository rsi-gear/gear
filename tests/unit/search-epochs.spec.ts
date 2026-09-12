import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { selectParents } from '../../src/search/archive.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchOperationPending, SearchExecutionFailure } from '../../src/search/recovery.js'
import { SearchStore } from '../../src/search/store.js'
import { createScope, sharedTasks } from '../../src/search/scopes.js'
import { samplingEvidence } from '../../src/search/scope-sampling.js'
import { validOutcome, cellKey } from '../../src/search/evidence.js'
import { resolveSizing, sorted, validateSettings } from '../../src/search/contracts.js'
import { fixtures, settings } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(period = 1, cellLimit = 10000) {
  const f = fixtures(20), config = settings()
  config.search.scopeSampling = { ...config.search.scopeSampling, epochPolicy: 'periodic', updateEveryRounds: period, maxHistoricalSpecialists: 1 }
  config.budgets.evolution.maxNewRolloutCells = cellLimit
  config.promotion.validationMode = 'shared-set-research'
  const root = await mkdtemp(join(tmpdir(), 'gear-epochs-')); roots.push(root)
  const store = new SearchStore(root)
  const run = (roundId: string, roundIndex: number) => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run({ evolutionId: 'epochs', roundId, roundIndex, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }, new AbortController().signal)
  return { ...f, config, store, run }
}

describe('scope epoch preparation at the planning boundary', () => {
  it('[A12,E12] changes scopes only at configured boundaries and samples the committed view on the following round', async () => {
    const f = await setup(2)
    const first = await f.run('r0', 0), initial = (await f.store.archive())!
    expect(initial.clusters).toHaveLength(4)
    const second = await f.run('r1', 1)
    expect(second.research.scopePreparation.decisions).toEqual([])
    expect(second.research.scopeViews.map(s => s.scopeDigest)).toEqual(first.research.scopeViews.map(s => s.scopeDigest))
    const before = (await f.store.archive())!, previousCalls = f.executions.length
    const evaluated = new Set(before.results.flatMap(r => r.cells.map(c => cellKey(c.identity))))
    const evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      for (const cell of input.cells) { expect(evaluated.has(cellKey(cell))).toBe(false); evaluated.add(cellKey(cell)) }
      return evaluate(input)
    }
    const third = await f.run('r2', 2), next = (await f.store.archive())!
    const prepared = third.research.scopePreparation
    expect(prepared.scopes.length).toBeGreaterThan(0)
    expect(prepared.scopes.every(s => s.epoch === 2)).toBe(true)
    expect(prepared.scopes.every(s => JSON.stringify(s.buckets.shared) === JSON.stringify(prepared.sharedTaskIds))).toBe(true)
    expect(third.research.parents.archiveDigest).toBe(before.digest)
    expect(third.research.parents.batches.every(b => before.scopeProbabilities[b.sourceScopeDigest] !== undefined)).toBe(true)
    expect(f.executions.slice(previousCalls).every(e => e.stage === 'baseline-probe')).toBe(true)
    expect(f.executions.length).toBe(new Set(f.executions.map(e => e.key)).size)
    for (const scope of prepared.scopes) {
      expect(next.scopeProbabilities[scope.digest]).toBeGreaterThan(0)
      const active = next.scopes.filter(s => s.familyId === scope.familyId && next.scopeProbabilities[s.digest] !== undefined)
      expect(active).toHaveLength(1)
      const old = initial.scopes.find(s => s.familyId === scope.familyId)!
      expect(next.scopes).toContainEqual(old)
    }
    expect(await f.store.object<typeof initial>(initial.digest)).toEqual(initial)
    const generated = [...f.generated]
    const fourth = await f.run('r3', 3)
    expect(fourth.research.parents.archiveDigest).toBe(next.digest)
    expect(fourth.research.parents.batches.every(b => next.scopeProbabilities[b.sourceScopeDigest] !== undefined)).toBe(true)
    expect(f.generated).toEqual(generated)
    expect(f.promotions).toEqual([])
  })

  it('[A12] preserves the old epoch when required selected-parent preparation exceeds the remaining budget', async () => {
    const f = await setup(1, 60)
    const first = await f.run('r0', 0), previous = (await f.store.archive())!
    expect(f.executions.reduce((sum, e) => sum + e.count, 0)).toBe(60)
    const ids = Array.from({ length: 100 }, (_, i) => `budget-${i}`)
    const roundId = ids.find(id => {
      const selection = selectParents(previous, f.config.search, 4, id)
      const parent = previous.snapshots.find(s => s.digest === selection.batches[0]!.parentSnapshotDigest)!
      const source = previous.scopes.find(s => s.digest === selection.batches[0]!.sourceScopeDigest)!
      const cells = previous.results.filter(r => r.snapshotDigest === parent.digest).flatMap(r => r.cells)
      const successful = f.seed.tasks.filter(t => cells.some(c => c.identity.taskId === t.id && validOutcome(c) && c.outcome.status === 'available' && c.outcome.rawValue === 1)).map(t => t.id)
      const resolution = resolveSizing(f.seed, f.config.search.taskSetSizing)
      const shared = sharedTasks(f.seed, resolution, f.config.search, successful, 2)
      const history = previous.clusters.filter(c => c.familyId === source.familyId)
      const proposed = createScope(f.seed, resolution, f.config.search, { familyId: source.familyId, taskIds: sorted(history.flatMap(c => c.taskIds)),
        modificationPaths: sorted(history.flatMap(c => c.modificationPaths)), successfulControlTaskIds: sorted(history.flatMap(c => c.successfulControlTaskIds ?? [])) }, shared, 2,
        samplingEvidence(f.seed, previous.digest, previous.clusters, previous.results))!
      return parent.candidateId !== first.nomineeId && proposed.taskIds.some(id => !cells.some(c => c.identity.taskId === id && validOutcome(c)))
    })!
    expect(roundId).toBeDefined()
    const count = f.executions.length, second = await f.run(roundId, 1), next = (await f.store.archive())!
    const insufficient = second.research.scopePreparation.decisions.filter(d => d.status === 'budget-insufficient')
    expect(insufficient.length).toBeGreaterThan(0)
    for (const decision of insufficient) {
      expect(next.scopeProbabilities[decision.previousScopeDigest]).toBeGreaterThan(0)
      expect(next.scopeProbabilities[decision.proposedScopeDigest!]).toBeUndefined()
      expect(decision.reasonCodes).toEqual(['scope-preparation-budget'])
    }
    expect(f.executions).toHaveLength(count)
    expect(await f.store.object<typeof previous>(previous.digest)).toEqual(previous)
  })

  it('[A12,R08] freezes preparation participants before calls and recovers the same interrupted operation', async () => {
    const f = await setup()
    await f.run('r0', 0)
    const evaluate = f.provider.evaluate, inspect = f.provider.inspectEvaluation!
    let interrupted = false, ready = false
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (!interrupted && input.plan.stage === 'baseline-probe' && input.snapshot.candidateId !== 'anchor') {
        interrupted = true; throw new Error('scope preparation response lost')
      }
      return cells
    }
    f.provider.inspectEvaluation = async input => ready ? inspect(input) : { status: 'running', handle: 'scope-prepare-1' }
    await expect(f.run('r1', 1)).rejects.toBeInstanceOf(SearchOperationPending)
    expect(interrupted).toBe(true)
    const parents = await f.store.read('rounds/r1/parents')
    expect(await f.store.read('rounds/r1/planning')).toBeUndefined()
    ready = true
    const result = await f.run('r1', 1)
    expect(result.research.scopePreparation.decisions.some(d => d.status === 'prepared')).toBe(true)
    expect(await f.store.read('rounds/r1/parents')).toEqual(parents)
    expect(f.executions.length).toBe(new Set(f.executions.map(e => e.key)).size)
    expect(await f.run('r1', 1)).toEqual(result)
  })

  for (const kind of ['missing', 'terminal-failure'] as const) it(`[A12,R09] keeps old eligibility when the proposed baseline is ${kind}`, async () => {
    const f = await setup()
    await f.run('r0', 0)
    const previous = (await f.store.archive())!, evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      if (input.plan.stage === 'baseline-probe' && input.snapshot.candidateId !== 'anchor') {
        if (kind === 'terminal-failure') throw new SearchExecutionFailure('scope-worker-exited', 'scope worker exited', 'provider:scope-worker-1')
        return (await evaluate(input)).slice(1)
      }
      return evaluate(input)
    }
    const result = await f.run('r1', 1), next = (await f.store.archive())!
    const rejected = result.research.scopePreparation.decisions.filter(d => d.status === 'baseline-ineligible')
    expect(rejected.length).toBeGreaterThan(0)
    for (const decision of rejected) {
      expect(next.scopeProbabilities[decision.previousScopeDigest]).toBeGreaterThan(0)
      expect(next.scopeProbabilities[decision.proposedScopeDigest!]).toBeUndefined()
    }
    expect(await f.store.object<typeof previous>(previous.digest)).toEqual(previous)
  })

  it('rejects missing, zero or noninteger periods and negative historical preparation limits', () => {
    const f = fixtures(20), config = settings()
    config.search.scopeSampling.epochPolicy = 'periodic'
    for (const value of [undefined, 0, 0.5, -1]) {
      if (value === undefined) delete config.search.scopeSampling.updateEveryRounds
      else config.search.scopeSampling.updateEveryRounds = value
      expect(() => validateSettings(config, f.seed, f.heldOut, 4)).toThrow()
    }
    config.search.scopeSampling.updateEveryRounds = 2
    config.search.scopeSampling.maxHistoricalSpecialists = -1
    expect(() => validateSettings(config, f.seed, f.heldOut, 4)).toThrow()
  })
})
