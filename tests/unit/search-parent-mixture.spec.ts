import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { buildArchive, selectParents } from '../../src/search/archive.js'
import { defaultEpsilonGreedySearchConfig, resolveSearchSettings } from '../../src/search/config.js'
import { validateSettings, verifyDigest } from '../../src/search/contracts.js'
import { completeEvidence } from '../../src/search/evidence.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import type { ParentSelectionDecision, ResearchArchive, SearchConfig } from '../../src/search/types.js'
import { evaluatedFixture, fixtures, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })
async function store() { const root = await mkdtemp(join(tmpdir(), 'gear-parent-mixture-')); roots.push(root); return new SearchStore(root) }
function weighted(config: SearchConfig = defaultEpsilonGreedySearchConfig, championId = 'A') {
  const u = universe(3), scope = scopeFixture(u, u.tasks.map(t => t.id))
  const snapshots = ['A', 'B', 'C'].map(id => snapshot(id))
  const values = [[0.9, 0.9, 0.4], [0.5, 0.5, 1], [0.4, 0.4, 0.3]]
  const rows = snapshots.map((s, i) => evaluatedFixture(u, scope, s, id => ({ outcome: values[i]![Number(id.slice(5))]! })))
  return buildArchive({ evolutionId: 'weighted', universe: u, snapshots, scopes: [scope], plans: rows.map(r => r.plan), results: rows.map(r => r.result), config, championId })
}

describe('champion plus weighted GEPA parent selection', () => {
  it('adds 50% to champion and scales GEPA weights, including champion, by 50%', () => {
    const a = weighted()
    expect(a.parentMixture!.explorationParentProbabilities.A).toBeCloseTo(2 / 3)
    expect(a.parentMixture!.explorationParentProbabilities.B).toBeCloseTo(1 / 3)
    expect(a.parentProbabilities.A).toBeCloseTo(5 / 6)
    expect(a.parentProbabilities.B).toBeCloseTo(1 / 6)
    expect(a.parentProbabilities.C).toBeUndefined() // Exploration is not uniform over all snapshots.
    expect(Object.values(a.parentProbabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    verifyDigest(a)
  })

  it('keeps a valid champion in the greedy branch even when GEPA prunes it', () => {
    const a = weighted(defaultEpsilonGreedySearchConfig, 'C')
    expect(a.parentProbabilities).toEqual({ A: 1 / 3, B: 1 / 6, C: 0.5 })
    expect(a.scopeViews[0]!.prunedIds).toContain('C')
    const draws = selectParents(a, defaultEpsilonGreedySearchConfig, 32, 'pruned-champion').batches
    expect(draws.some(b => b.selectionBranch === 'champion' && b.parentSnapshotDigest === a.snapshots.find(s => s.candidateId === 'C')!.digest)).toBe(true)
  })

  it.each([0, 1])('supports champion probability %s without drawing a zero-weight branch', championProbability => {
    const config = { ...defaultEpsilonGreedySearchConfig, championProbability }, a = weighted(config)
    const batches = selectParents(a, config, 100, 'boundary').batches
    expect(new Set(batches.map(b => b.selectionBranch))).toEqual(new Set([championProbability ? 'champion' : 'gepa']))
    if (championProbability) expect(a.parentProbabilities).toEqual({ A: 1 })
    else expect(a.parentProbabilities).toEqual(a.parentMixture!.explorationParentProbabilities)
  })

  it('draws each candidate independently, preserves weighted exploration and replays exactly', () => {
    const a = weighted(), counts = { champion: 0, gepa: 0, A: 0, B: 0 }, branchPatterns = new Set<number>()
    for (let i = 0; i < 256; i++) {
      const d = selectParents(a, defaultEpsilonGreedySearchConfig, 4, `r-${i}`)
      expect(d).toEqual(selectParents(a, defaultEpsilonGreedySearchConfig, 4, `r-${i}`))
      expect(d.batches).toHaveLength(4)
      branchPatterns.add(d.batches.filter(b => b.selectionBranch === 'champion').length)
      for (const b of d.batches) {
        expect(b.maxCandidateSlots).toBe(1)
        counts[b.selectionBranch!]++
        const id = a.snapshots.find(s => s.digest === b.parentSnapshotDigest)!.candidateId as 'A' | 'B'
        counts[id]++
      }
    }
    expect(branchPatterns).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(counts.champion / 1024).toBeGreaterThan(0.44)
    expect(counts.champion / 1024).toBeLessThan(0.56)
    expect(counts.A / 1024).toBeGreaterThan(0.78)
    expect(counts.A / 1024).toBeLessThan(0.88)
    for (const count of [1, 3, 7]) expect(selectParents(a, defaultEpsilonGreedySearchConfig, count, 'sizing').batches).toHaveLength(count)
  })

  it('retains the legacy selector and makes the new probability configurable with a 0.5 default', () => {
    const config = settings(), a = weighted(config.search)
    expect(a.parentMixture).toBeUndefined()
    expect(a.parentProbabilities).toEqual({ A: 2 / 3, B: 1 / 3 })
    expect(selectParents(a, config.search, 4, 'legacy').batches).toHaveLength(1)
    config.search.parentSampling = 'epsilon-greedy-gepa-v1'
    expect(resolveSearchSettings(config)!.search.championProbability).toBe(0.5)
    expect(weighted(config.search).parentMixture!.championProbability).toBe(0.5)
    for (const p of [-0.1, 1.1, NaN, Infinity]) {
      config.search.championProbability = p
      expect(() => validateSettings(config, universe(3), universe(3, 'held-out'), 4)).toThrow()
    }
    expect(() => selectParents(weighted(), { ...defaultEpsilonGreedySearchConfig, championProbability: 0.2 }, 4, 'changed')).toThrow('frozen settings')
  })

  it('does not bypass incomplete seed evidence or exploration guards for the greedy branch', () => {
    const u = universe(2), s = snapshot('A'), scope = scopeFixture(u, ['task-0'], 'guarded', 1, [{ taskId: 'task-1', partition: 'seed', rule: 'must-pass' }])
    for (const missing of [true, false]) {
      const r = evaluatedFixture(u, scope, s, id => id === 'task-1' && missing ? undefined : { outcome: 0 })
      expect(() => buildArchive({ evolutionId: 'guard', universe: u, snapshots: [s], scopes: [scope], plans: [r.plan], results: [r.result],
        config: defaultEpsilonGreedySearchConfig, championId: s.candidateId })).toThrow('champion has no complete eligible seed scope')
    }
  })

  it('uses completed global seed cells for a promoted champion baseline without broadening GEPA scopes', () => {
    const u = universe(3), old = snapshot('old'), current = snapshot('current')
    const bootstrap = scopeFixture(u, u.tasks.map(t => t.id), 'bootstrap', 0), local = scopeFixture(u, ['task-0'], 'local')
    const base = evaluatedFixture(u, bootstrap, old, () => ({ outcome: 0 }))
    const oldLocal = evaluatedFixture(u, local, old, () => ({ outcome: 0 }))
    const global = evaluatedFixture(u, scopeFixture(u, u.tasks.map(t => t.id), 'global'), current, id => id === 'task-2' ? undefined : { outcome: 1 }, { stage: 'global-seed' })
    const previous = buildArchive({ evolutionId: 'projection', universe: u, snapshots: [old, current], scopes: [bootstrap, local], plans: [base.plan, oldLocal.plan, global.plan],
      results: [base.result, oldLocal.result, global.result], config: settings().search, championId: old.candidateId })
    const full = evaluatedFixture(u, global.scope, current, () => ({ outcome: 1 }), { stage: 'global-seed' })
    const completion = completeEvidence(global.result, full.result.cells)
    const a = buildArchive({ evolutionId: 'projection', previous, universe: u, snapshots: [], scopes: [], plans: [], results: [completion], config: defaultEpsilonGreedySearchConfig, championId: current.candidateId })
    expect(a.parentMixture!.championScopeDigest).toBe(bootstrap.digest)
    expect(a.parentMixture!.explorationParentProbabilities).toEqual({ old: 1 })
    expect(a.parentProbabilities).toEqual({ old: 0.5, current: 0.5 })
    expect(a.results).toHaveLength(previous.results.length + 1)
    expect(a.scopeViews.find(v => v.scopeDigest === local.digest)!.outcomeEligibleIds).toEqual(['old'])
    expect(previous.results).not.toContainEqual(completion)
  })
})

describe('durable mixture admission', () => {
  it.each(['parent-archive', 'parents', 'commit', 'champion'])('resumes after %s without redrawing parents or rerunning valid cells', async point => {
    const f = fixtures(20), journal = await store(), write = journal.write.bind(journal), commit = f.hooks.commitChampion
    let interrupted = false
    journal.write = async (name, value) => {
      await write(name, value)
      if (!interrupted && name === `rounds/r/${point}`) { interrupted = true; throw new Error('crash') }
    }
    f.hooks.commitChampion = async (...args) => {
      await commit(...args)
      if (!interrupted && point === 'champion') { interrupted = true; throw new Error('crash') }
    }
    const config = settings(); config.search = structuredClone(defaultEpsilonGreedySearchConfig)
    const request = { evolutionId: 'mixture', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('first'), settings: config }
    const run = () => new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks).run(request, new AbortController().signal)
    await expect(run()).rejects.toThrow('crash')
    const parents = await journal.read('rounds/r/parents'), executions = f.executions.length
    const result = await run()
    expect(result.championChanged).toBe(true)
    expect(f.generated).toHaveLength(4)
    expect(result.research.parents.batches).toHaveLength(4)
    if (parents) expect(await journal.read('rounds/r/parents')).toEqual(parents)
    if (point === 'commit' || point === 'champion') expect(f.executions).toHaveLength(executions)
    expect(new Set(f.executions.map(e => e.key)).size).toBe(f.executions.length)
    expect(await run()).toEqual(result)
    const archive = (await journal.archive())!, champion = archive.snapshots.find(s => s.candidateId === result.nomineeId)!
    const next = await new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks).run({ ...request, roundId: 'next', roundIndex: 1, anchor: champion,
      championRevisionDigest: digestJson('promoted') }, new AbortController().signal)
    const decisionArchive = await journal.object<ResearchArchive>(next.research.parents.archiveDigest)
    expect(decisionArchive.parentMixture!.championId).toBe(champion.candidateId)
    expect(decisionArchive.parentProbabilities[champion.candidateId]).toBeGreaterThanOrEqual(0.5)
    expect(archive.parentMixture!.championId).toBe(f.anchor.candidateId) // Previous round stays frozen.
  })

  it('incorporates pending completions before freezing the first parent draw', async () => {
    const f = fixtures(20), journal = await store(), config = settings(); config.search = structuredClone(defaultEpsilonGreedySearchConfig)
    const bootstrap = scopeFixture(f.seed, f.seed.tasks.map(t => t.id), 'bootstrap', 0), local = scopeFixture(f.seed, ['task-0'], 'local')
    const historical = snapshot('historical')
    const base = evaluatedFixture(f.seed, bootstrap, f.anchor, () => ({ outcome: 0 }))
    const ab = evaluatedFixture(f.seed, local, f.anchor, () => ({ outcome: 0 }))
    const invalid = evaluatedFixture(f.seed, local, historical, () => ({ outcome: 1, invalid: true }))
    const complete = completeEvidence(invalid.result, evaluatedFixture(f.seed, local, historical, () => ({ outcome: 1 })).result.cells)
    const a = buildArchive({ evolutionId: 'completion', universe: f.seed, snapshots: [f.anchor, historical], scopes: [bootstrap, local], plans: [base.plan, ab.plan, invalid.plan],
      results: [base.result, ab.result, invalid.result], config: config.search, championId: f.anchor.candidateId })
    await journal.casArchive(undefined, a)
    await journal.put(complete)
    const receipt = { kind: 'archive-evidence-completion', id: 'repair', originalResultDigest: invalid.result.digest, completedResultDigest: complete.digest,
      planDigest: invalid.plan.digest, snapshotDigest: historical.digest }
    const ref = await journal.put({ ...receipt, digest: digestJson(receipt) })
    await journal.write('pending-completions', { refs: [ref] })
    const write = journal.write.bind(journal)
    journal.write = async (name, value) => { await write(name, value); if (name === 'rounds/r/parents') throw new Error('inspect admission') }
    await expect(new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks).run({ evolutionId: 'completion', roundId: 'r', roundIndex: 0,
      maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('champion'), settings: config }, new AbortController().signal)).rejects.toThrow('inspect admission')
    const pointer = (await journal.read<{ ref: string }>('rounds/r/parents'))!
    const parents = await journal.object<ParentSelectionDecision>(pointer.ref), selectionArchive = await journal.object<ResearchArchive>(parents.archiveDigest)
    expect(selectionArchive.parentMixture!.explorationParentProbabilities).toEqual({ historical: 1 })
    expect(selectionArchive.parentProbabilities).toEqual({ historical: 0.5, anchor: 0.5 })
    expect((await journal.archive())!.digest).toBe(a.digest)
    expect(f.executions).toHaveLength(0)
  })
})
