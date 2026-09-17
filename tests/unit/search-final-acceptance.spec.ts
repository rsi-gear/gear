import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { buildArchive, selectParents } from '../../src/search/archive.js'
import { completeArchivedEvidence } from '../../src/search/completion.js'
import { cellKey } from '../../src/search/evidence.js'
import type { StageResult } from '../../src/search/types.js'
import { fixtures, settings, universe, snapshot, scopeFixture, evaluatedFixture, revise } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function store() { const root = await mkdtemp(join(tmpdir(), 'gear-final-acceptance-')); roots.push(root); return new SearchStore(root) }
async function setup(process = false) {
  const f = fixtures(20, process), config = settings(), journal = await store()
  const request = { evolutionId: 'acceptance', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('initial-revision'), settings: config }
  const engine = () => new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
  return { ...f, config, journal, request, engine, run: () => engine().run(request, new AbortController().signal) }
}

describe('remaining publication and immutable-history acceptance', () => {
  it('[A07] retains more unique specialists than the generation cap and keeps a pruned champion recoverable', async () => {
    const u = universe(16), champion = snapshot('champion'), specialists = u.tasks.map((_, i) => snapshot(`specialist-${i}`))
    const snapshots = [champion, ...specialists], scope = scopeFixture(u, u.tasks.map(t => t.id))
    const rows = snapshots.map(s => evaluatedFixture(u, scope, s, id => ({ outcome: s === champion ? 0.1 : Number(s.candidateId.slice(11)) === Number(id.slice(5)) ? 1 : 0.2 }), { participants: snapshots.map(s => s.candidateId) }))
    const archive = buildArchive({ evolutionId: 'many', universe: u, snapshots, scopes: [scope], plans: [rows[0]!.plan], results: rows.map(r => r.result), config: settings().search, championId: champion.candidateId })
    expect(archive.activeParentIds).toHaveLength(16)
    expect(archive.scopeViews[0]!.prunedIds).toContain(champion.candidateId)
    expect(selectParents(archive, settings().search, 4, 'round').batches.reduce((sum, b) => sum + b.maxCandidateSlots, 0)).toBe(4)
    const journal = await store(); await journal.casArchive(undefined, archive)
    const recovered = (await journal.archive())!
    expect(recovered.snapshots.find(s => s.digest === champion.digest)).toEqual(champion)
    expect(recovered.activeParentIds).toEqual(archive.activeParentIds)
  })

  it('[P03] permits outcome ties with process improvement through both actual release stages', async () => {
    const f = await setup(true), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => (await evaluate(input)).map(cell => input.snapshot.candidateId === 'anchor' ? cell : revise(cell, {
      outcome: { status: 'available', rawValue: input.plan.partition === 'seed' && Number(cell.identity.taskId.slice(5)) >= 16 ? 1 : 0, contractDigest: cell.identity.outcomeContractDigest, evidenceRef: cell.evidenceRef },
    }))
    const result = await f.run()
    expect(result.championChanged).toBe(true)
    expect(result.promotion?.comparison).toMatchObject({ outcomeGain: 0, processGains: { process: 0.5 } })
    expect(f.executions.some(e => e.stage === 'global-seed' && e.participant !== 'anchor')).toBe(true)
    expect(f.executions.some(e => e.stage === 'held-out' && e.participant !== 'anchor')).toBe(true)
  })

  it('[M08] promotes independently valid v2 outcomes with missing process when the release channel is off', async () => {
    const f = await setup(true), evaluate = f.provider.evaluate
    f.config.promotion.process.mode = 'off'
    f.provider.evaluate = async input => (await evaluate(input)).map(cell => input.snapshot.candidateId === 'anchor' ? cell : revise(cell, {
      process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'legacy process artifact absent; v2 outcome certified separately' },
    }))
    const result = await f.run()
    expect(result.championChanged).toBe(true)
    expect(result.promotion?.comparison.processGains).toEqual({})
    expect(result.research.candidates.every(c => c.profile.outcomeComplete && !c.profile.processComplete)).toBe(true)
  })

  it('[R03] preserves an external champion on CAS conflict and replays only the original commit intent', async () => {
    const f = await setup(), external = { revision: digestJson('concurrent-revision'), commit: 'external-commit' }, attempts: Array<{ revision: string; commit: string }> = []
    f.hooks.commitChampion = async (revision, next) => {
      attempts.push({ revision, commit: next.commit })
      if (revision !== external.revision) throw new Error('champion CAS conflict')
      external.commit = next.commit
    }
    await expect(f.run()).rejects.toThrow('champion CAS conflict')
    const intent = await f.journal.read('rounds/r/commit'), executionCount = f.executions.length, generations = [...f.generated]
    expect(await f.journal.read('rounds/r/terminal')).toBeUndefined()
    await expect(f.run()).rejects.toThrow('champion CAS conflict')
    expect(await f.journal.read('rounds/r/commit')).toEqual(intent)
    expect(external.commit).toBe('external-commit')
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(attempts[0]!.revision).toBe(f.request.championRevisionDigest)
    expect(f.executions).toHaveLength(executionCount)
    expect(f.generated).toEqual(generations)
  })

  it.each(['local', 'bridge', 'global-seed'] as const)('[R10] appends consumed %s evidence for the next archive without changing frozen decisions or nominee', async stage => {
    const f = await setup(), evaluate = f.provider.evaluate
    if (stage === 'local') f.config.search.evaluationStages.bridge.maxCandidates = 0
    let partialId: string | undefined
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (input.plan.stage === stage && input.snapshot.candidateId !== 'anchor' && !partialId) { partialId = input.snapshot.candidateId; return cells.slice(1) }
      return cells
    }
    const result = await f.run(), originalArchive = (await f.journal.archive())!
    const s = originalArchive.snapshots.find(s => s.candidateId === partialId)!
    const original = originalArchive.results.find(r => r.snapshotDigest === s.digest && originalArchive.plans.some(p => p.digest === r.stagePlanDigest && p.stage === stage))!, plan = originalArchive.plans.find(p => p.digest === original.stagePlanDigest)!
    const decisions = result.research.stageDecisions
    if (stage === 'global-seed') expect(result.promotion?.outcome).toBe('insufficient-evidence')
    else expect(decisions.find(d => d.candidateId === partialId && d.stagePlanDigest === plan.digest)?.outcome).toBe('insufficient-evidence')
    const completion = await completeArchivedEvidence({ id: 'historical', store: f.journal, provider: f.provider, universe: f.seed, plan, snapshot: s, original, settings: f.config, signal: new AbortController().signal })
    expect(completion.completedResultDigest).not.toBe(original.digest)
    expect(await f.journal.archive()).toEqual(originalArchive)
    expect(await f.run()).toEqual(result)
    expect(result.research.stageDecisions).toEqual(decisions)
    if (stage === 'global-seed') expect(result.nomineeId).toBe(partialId)
    else expect(result.nomineeId).toBeUndefined()
    await f.engine().run({ ...f.request, roundId: 'r2', roundIndex: 1 }, new AbortController().signal)
    expect((await f.journal.archive())!.results.some(r => r.digest === completion.completedResultDigest)).toBe(true)
    expect(await f.journal.object(originalArchive.digest)).toEqual(originalArchive)
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('merges successive partial completions (commitBetween=%s, crashAfterQueue=%s)', async (commitBetween, crashAfterQueue) => {
    const f = await setup(), scope = scopeFixture(f.seed, ['task-0', 'task-1', 'task-2'])
    const row = evaluatedFixture(f.seed, scope, f.anchor, id => id === 'task-0' ? { outcome: 0 } : undefined)
    const original = buildArchive({ evolutionId: 'acceptance', universe: f.seed, snapshots: [f.anchor], scopes: [scope],
      plans: [row.plan], results: [row.result], config: f.config.search, championId: f.anchor.candidateId })
    await f.journal.casArchive(undefined, original)
    for (const cell of row.result.cells) {
      await f.journal.put(cell)
      await f.journal.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
    }
    const evaluate = f.provider.evaluate
    let first = true
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (first) { first = false; return cells.slice(0, 1) }
      return cells
    }
    const complete = (id: string) => completeArchivedEvidence({ id, store: f.journal, provider: f.provider, universe: f.seed,
      plan: row.plan, snapshot: f.anchor, original: row.result, settings: f.config, signal: new AbortController().signal })
    const a = await complete('first'), partial = await f.journal.object<StageResult>(a.completedResultDigest)
    expect(partial.cells).toHaveLength(2)
    const merge = (previous: typeof original, results: typeof original.results) => buildArchive({ evolutionId: 'acceptance', previous,
      universe: f.seed, snapshots: [], scopes: [], plans: [], results, config: f.config.search, championId: f.anchor.candidateId })
    const intermediate = commitBetween ? merge(original, [partial]) : original
    if (commitBetween) await f.journal.casArchive(original.digest, intermediate)
    if (crashAfterQueue) {
      const write = f.journal.write.bind(f.journal)
      let crash = true
      f.journal.write = async (name, value) => {
        if (crash && name === 'rounds/completion-second/result') { crash = false; throw new Error('crash after queue update') }
        await write(name, value)
      }
      await expect(complete('second')).rejects.toThrow('crash after queue update')
      expect(f.executions.map(e => e.count)).toEqual([2, 1])
    }
    const b = await complete('second'), full = await f.journal.object<StageResult>(b.completedResultDigest)
    expect(full.cells).toHaveLength(3)
    expect(full.supersedesEvidenceDigest).toBe(partial.digest)
    const combined = merge(intermediate, [partial, full])
    expect(combined.results).toContainEqual(full)
    expect(combined.activeParentIds).toEqual([f.anchor.candidateId])
    expect(f.executions.map(e => e.count)).toEqual([2, 1])
    expect(await complete('second')).toEqual(b)
    expect((await complete('third')).completedResultDigest).toBe(full.digest)
    expect(f.executions.map(e => e.count)).toEqual([2, 1])
    await f.run()
    expect((await f.journal.archive())!.results).toContainEqual(full)
    expect(await f.journal.object(original.digest)).toEqual(original)
  })

  it('[R07] rejects uncommitted evidence before it can consume budget or poison the next completion queue', async () => {
    const f = await setup(); await f.run()
    const archive = (await f.journal.archive())!, original = archive.results.find(r => r.snapshotDigest !== f.anchor.digest)!
    const plan = archive.plans.find(p => p.digest === original.stagePlanDigest)!, s = archive.snapshots.find(s => s.digest === original.snapshotDigest)!
    const count = f.executions.length, queue = await f.journal.read('pending-completions')
    await expect(completeArchivedEvidence({ id: 'uncommitted', store: f.journal, provider: f.provider, universe: f.seed, plan, snapshot: s,
      original: revise(original, { cells: [] }), settings: f.config, signal: new AbortController().signal })).rejects.toThrow('committed archive evidence')
    expect(f.executions).toHaveLength(count)
    expect(await f.journal.read('pending-completions')).toEqual(queue)
    expect(await f.journal.read('active-completion')).toBeUndefined()
  })
})
