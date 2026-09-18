import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { resolveSizing, seal, validateSettings } from '../../src/search/contracts.js'
import { createScope, sharedTasks } from '../../src/search/scopes.js'
import { buildArchive } from '../../src/search/archive.js'
import { profile } from '../../src/search/evidence.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { evaluatedFixture, fixtures, revise, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'

describe('final scope and persisted-contract acceptance', () => {
  it('[E08,E09] applies optional limits, reports actual pool shortages and keeps scale independent of scoring weights', () => {
    const u = universe(10), config = settings().search
    config.taskSetSizing.local = { ratio: 0.01, minTasks: 3, maxTasks: 4 }
    config.taskSetSizing.shared = { ratio: 0.04, minTasks: 20 }
    let resolution = resolveSizing(u, config.taskSetSizing)
    expect(resolution.quantities.local.resolved).toBe(3)
    expect(resolution.quantities.shared).toMatchObject({ resolved: 10, reasons: ['minimum-clipped-to-universe'] })
    config.taskSetSizing.shared = { ratio: 0 }
    config.taskSetSizing.cross = { ratio: 0 }
    resolution = resolveSizing(u, config.taskSetSizing)
    const scope = createScope(u, resolution, config, { familyId: 'small', taskIds: ['task-0', 'task-0'] }, [])!
    expect(scope.buckets.local).toEqual(['task-0'])
    expect(scope.sampling.local).toMatchObject({ requested: 3, selected: 1, reasons: ['eligible-pool-exhausted-after-deduplication'] })
    expect(scope.weights).toEqual({ 'task-0': 1 })
    config.scopeSampling.bucketWeights = { local: 0.1, shared: 0.7, cross: 0.2 }
    expect(resolveSizing(u, config.taskSetSizing)).toEqual(resolution)
    config.taskSetSizing.local = { ratio: 0.8, maxTasks: 2 }
    expect(resolveSizing(u, config.taskSetSizing).quantities.local).toMatchObject({ requested: 8, resolved: 2, reasons: ['capacity-clipped'] })
  })

  it('[E09,E10] resolves tiny overlapping pools in fixed priority and preserves guards when optional buckets are disabled', () => {
    const u = universe(1), config = settings().search, resolution = resolveSizing(u, config.taskSetSizing)
    const scope = createScope(u, resolution, config, { familyId: 'tiny', taskIds: ['task-0'] }, sharedTasks(u, resolution, config, ['task-0']))!
    expect(scope.buckets).toEqual({ shared: ['task-0'], local: [], cross: [] })
    expect(scope.taskIds).toEqual(['task-0']); expect(scope.weights).toEqual({ 'task-0': 1 })
    expect(scope.sampling.local.reasons).toContain('rounded-targets-exceed-universe:shared-local-cross-priority')
    expect(scope.sampling.cross.reasons).toContain('rounded-targets-exceed-universe:shared-local-cross-priority')
    const larger = universe(4)
    config.taskSetSizing.shared = { ratio: 0 }; config.taskSetSizing.cross = { ratio: 0 }
    config.explorationGuards = [{ taskId: 'task-3', partition: 'seed', rule: 'must-pass' }]
    const guarded = createScope(larger, resolveSizing(larger, config.taskSetSizing), config, { familyId: 'guarded', taskIds: ['task-0'] }, [])!
    expect(guarded.taskIds).toEqual(['task-0', 'task-3'])
    expect(guarded.buckets.shared).toEqual([]); expect(guarded.buckets.cross).toEqual([])
    const full = settings(); full.search = config; config.scopeSampling.sharedCoreTaskIds = ['task-2']
    expect(() => validateSettings(full, larger, universe(2, 'held-out'), 4)).toThrow('shared core')
    for (const limit of [{ ratio: 0 }, { ratio: 0.1, minTasks: -1 }, { ratio: 0.1, maxTasks: 1.5 }, { ratio: 0.1, maxTasks: 0 }]) {
      expect(() => resolveSizing(larger, { ...config.taskSetSizing, local: limit })).toThrow()
    }
  })

  it('[A09,M03,M04] admits complete local outcomes while withholding process fronts for different incomplete subsets', () => {
    const u = universe(100, 'seed', true), scope = scopeFixture(u, u.tasks.slice(0, 15).map(t => t.id)), a = snapshot('A'), b = snapshot('B')
    const ar = evaluatedFixture(u, scope, a, id => ({ outcome: 0.8, ...(id === 'task-0' ? { process: 0 } : {}) }))
    const br = evaluatedFixture(u, scope, b, id => ({ outcome: 0.9, ...(id === 'task-1' ? { process: 1 } : {}) }))
    const archive = buildArchive({ evolutionId: 'local', universe: u, snapshots: [a, b], scopes: [scope], results: [ar.result, br.result], plans: [ar.plan, br.plan], config: settings().search, championId: 'A' })
    expect(archive.activeParentIds).toContain('B')
    expect(archive.scopeViews[0]!.processEligibleIds).toEqual([])
    for (const [s, row] of [[a, ar], [b, br]] as const) {
      const p = profile(u, row.plan, s, row.result, 'auto')
      expect(p.outcomeComplete).toBe(true); expect(p.processComplete).toBe(false)
      expect(p.coverage).toMatchObject({ planned: 15, available: 15, notEvaluated: 85, missing: 0 })
      expect(p.processGroups).toEqual({}); expect(p.processCoverage).toMatchObject({ planned: 15, available: 1, missing: 14 })
    }
    const cell = ar.result.cells[0]!, invalid = revise(cell, { process: { status: 'invalid', contractDigest: cell.identity.processContractDigest!, reason: 'invalid process output' } })
    const p = profile(u, ar.plan, a, revise(ar.result, { cells: [invalid, ...ar.result.cells.slice(1)] }), 'auto')
    expect(p.processCoverage).toMatchObject({ available: 0, invalid: 1, missing: 14 })
    expect(p.outcomeComplete).toBe(true)
  })

  it('[R01,R08] rejects a previously bound plan being rebound to another snapshot before any Target execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-binding-check-')), f = fixtures(20), store = new SearchStore(root), freeze = store.freeze.bind(store)
    store.freeze = async (roundId, name, create) => {
      const value = await freeze(roundId, name, create)
      return name.startsWith('binding-') ? seal({ ...value, sealedSnapshotDigest: digestJson('other-snapshot') }) : value
    }
    try {
      await expect(new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run({ evolutionId: 'binding', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor,
        championRevisionDigest: digestJson('revision'), settings: settings() }, new AbortController().signal)).rejects.toThrow('already bound')
      expect(f.executions).toEqual([]); expect(f.generated).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
