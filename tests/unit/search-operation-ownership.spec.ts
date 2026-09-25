import { describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { buildArchive } from '../../src/search/archive.js'
import { completeArchivedEvidence } from '../../src/search/completion.js'
import { FailureClusterSearch, SearchEvidencePending } from '../../src/search/engine.js'
import { SearchExecutionFailure, SearchOperationPending } from '../../src/search/recovery.js'
import { MemorySearchStore, evaluatedFixture, fixtures, revise, scopeFixture, settings, snapshot } from '../../src/search/testing.js'
import type { ResearchArchive, StageResult } from '../../src/search/types.js'

function setup() {
  const f = fixtures(20), store = new MemorySearchStore(), config = settings()
  const request = { evolutionId: 'ownership', roundId: 'r', roundIndex: 0, maxCandidates: 1,
    anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }
  const engine = () => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks)
  const run = () => engine().run(request, new AbortController().signal)
  return { ...f, store, config, request, engine, run }
}

async function pausedRound() {
  const f = setup(), evaluate = f.provider.evaluate
  f.provider.evaluate = async input => {
    const cells = await evaluate(input)
    return input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' ? [] : cells
  }
  await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
  f.provider.evaluate = evaluate
  const pending = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!
  return { ...f, originalRef: pending.resultRefs[1]! }
}

async function archivedEvidence() {
  const f = setup(), scope = scopeFixture(f.seed, ['task-0', 'task-1'])
  const row = evaluatedFixture(f.seed, scope, f.anchor, () => undefined)
  const archive = buildArchive({ evolutionId: f.request.evolutionId, universe: f.seed, snapshots: [f.anchor],
    scopes: [scope], plans: [row.plan], results: [row.result], config: f.config.search, championId: f.anchor.candidateId })
  await f.store.casArchive(undefined, archive)
  const complete = (id: string, signal = new AbortController().signal) => completeArchivedEvidence({
    id, store: f.store, provider: f.provider, universe: f.seed, plan: row.plan, snapshot: f.anchor,
    original: row.result, settings: f.config, signal,
  })
  return { ...f, row, archive, complete }
}

describe('search operation ownership', () => {
  it('rejects an unsafe completion ID before it can block a valid completion', async () => {
    const f = await archivedEvidence(), before = f.store.checkpoint()
    await expect(f.complete('bad/id')).rejects.toThrow('unsafe record ID')
    expect(f.store.checkpoint()).toEqual(before)
    const completed = await f.complete('valid')
    expect((await f.store.object<StageResult>(completed.completedResultDigest)).cells).toHaveLength(2)
  })

  it.each(['before', 'during-validation'])('does not claim a completion cancelled %s admission', async timing => {
    const f = await archivedEvidence(), before = f.store.checkpoint(), controller = new AbortController()
    if (timing === 'before') controller.abort(new Error('cancelled'))
    else {
      const describe = f.provider.describe
      f.provider.describe = async partition => { controller.abort(new Error('cancelled')); return describe(partition) }
    }
    await expect(f.complete('cancelled', controller.signal)).rejects.toThrow('cancelled')
    expect(f.store.checkpoint()).toEqual(before)
    await f.complete('valid')
  })

  it('rejects an unsafe round ID before writing an evolution or active round', async () => {
    const f = setup()
    await expect(f.engine().run({ ...f.request, roundId: 'bad/id' }, new AbortController().signal)).rejects.toThrow('unsafe record ID')
    expect(f.store.checkpoint()).toEqual([])
    expect((await f.run()).championChanged).toBe(true)
  })

  it.each(['before', 'during-validation'])('does not claim a round cancelled %s admission', async timing => {
    const f = setup(), controller = new AbortController()
    if (timing === 'before') controller.abort(new Error('cancelled'))
    else {
      const describe = f.provider.describe
      f.provider.describe = async partition => { controller.abort(new Error('cancelled')); return describe(partition) }
    }
    await expect(f.engine().run(f.request, controller.signal)).rejects.toThrow('cancelled')
    expect(f.store.checkpoint()).toEqual([])
    expect((await f.run()).championChanged).toBe(true)
  })

  it.each(['first-input', 'evidence-digest'])('keeps repair ID %s separate from internal input and evidence records', async label => {
    const f = await pausedRound(), evaluate = f.provider.evaluate
    let first = true
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (first) { first = false; return cells.slice(0, 1) }
      return cells
    }
    const repair = (id: string) => f.engine().repairEvaluation('r', id, f.originalRef, new AbortController().signal)
    const partial = await repair('first')
    expect(partial.cells).toHaveLength(1)
    const full = await repair(label === 'evidence-digest' ? f.originalRef.slice(7) : label)
    expect(full.cells).toHaveLength(f.heldOut.tasks.length)
    expect(full.supersedesEvidenceDigest).toBe(partial.digest)
    expect((await f.run()).championChanged).toBe(true)
  })

  it('rejects a stored evaluation that was not produced by the requested round', async () => {
    const f = await pausedRound(), foreign = snapshot('foreign')
    const scope = scopeFixture(f.heldOut, f.heldOut.tasks.map(t => t.id))
    const row = evaluatedFixture(f.heldOut, scope, foreign, () => undefined, { stage: 'held-out' })
    for (const value of [foreign, row.plan, row.result]) await f.store.put(value)
    const before = f.store.checkpoint(), calls = f.executions.length
    await expect(f.engine().repairEvaluation('r', 'foreign', row.result.digest, new AbortController().signal)).rejects.toThrow('this round')
    expect(f.store.checkpoint()).toEqual(before)
    expect(f.executions).toHaveLength(calls)
    await f.engine().repairEvaluation('r', 'valid', f.originalRef, new AbortController().signal)
    expect((await f.run()).championChanged).toBe(true)
  })

  it.each(['worker-exited', 'cancelled', 'missing', 'invalid'])('keeps a %s bootstrap pending and repairs only its missing/invalid cells', async kind => {
    const f = setup(), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      const cells = await evaluate(input), valid = cells.slice(0, 3)
      if (kind === 'missing') return valid
      if (kind === 'invalid') return [...valid, ...cells.slice(3).map(cell => revise(cell, {
        status: 'invalid', outcomeCertified: false,
        outcome: { status: 'invalid', contractDigest: cell.identity.outcomeContractDigest, reason: 'runtime failed' },
      }))]
      throw new SearchExecutionFailure(kind, 'baseline execution unavailable', `worker:${kind}`, valid)
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = (await f.store.read<{ planDigest: string; resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const original = await f.store.object<StageResult>(pending.resultRefs[0]!)
    expect(original.stagePlanDigest).toBe(pending.planDigest)
    expect(original.cells.slice(0, 3).every(cell => cell.outcome.status === 'available')).toBe(true)
    expect(await f.store.read('rounds/r/terminal')).toBeUndefined()
    expect(await f.store.read('rounds/r/commit')).toBeUndefined()
    expect(await f.store.archive()).toBeUndefined()
    expect(f.generated).toEqual([])
    const calls = f.executions.length
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    expect(f.executions).toHaveLength(calls)
    await expect(f.engine().run({ ...f.request, roundId: 'next', roundIndex: 1 }, new AbortController().signal))
      .rejects.toThrow('unresolved round')
    f.provider.evaluate = evaluate
    const repaired = await f.engine().repairEvaluation('r', 'baseline-repair', original.digest, new AbortController().signal)
    expect(repaired.cells).toHaveLength(f.seed.tasks.length)
    expect(repaired.cells).toEqual(expect.arrayContaining(original.cells.slice(0, 3)))
    expect(f.executions[calls]!.count).toBe(f.seed.tasks.length - 3)
    expect((await f.run()).championChanged).toBe(true)
    const before = f.store.checkpoint()
    await expect(f.engine().repairEvaluation('r', 'late', original.digest, new AbortController().signal)).rejects.toThrow('commit intent')
    expect(f.store.checkpoint()).toEqual(before)
  })

  it.each(['partial', 'failed'])('keeps the original bootstrap reference across consecutive %s repairs', async kind => {
    const f = setup(), evaluate = f.provider.evaluate
    f.config.budgets.round.maxRepairCells = 100
    f.config.budgets.evolution.maxRepairCells = 100
    f.provider.evaluate = async input => (await evaluate(input)).slice(0, 3)
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const originalPending = (await f.store.read<{ planDigest: string; resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const original = await f.store.object<StageResult>(originalPending.resultRefs[0]!)
    let pending = originalPending, current = original
    f.provider.evaluate = async input => {
      const valid = (await evaluate(input)).slice(0, 3)
      if (kind === 'failed') throw new SearchExecutionFailure('worker-exited', 'repair worker exited', 'worker:repair', valid)
      return valid
    }
    for (const repairId of ['first', 'second']) {
      const calls = f.executions.length
      const repaired = await f.engine().repairEvaluation('r', repairId, pending.resultRefs[0]!, new AbortController().signal)
      expect(f.executions[calls]!.count).toBe(f.seed.tasks.length - current.cells.length)
      expect(repaired.cells).toHaveLength(current.cells.length + 3)
      expect(repaired.cells).toEqual(expect.arrayContaining(current.cells))
      await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
      pending = (await f.store.read<typeof originalPending>('rounds/r/pending-evidence'))!
      expect(pending).toEqual(originalPending)
      await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
      expect(f.executions).toHaveLength(calls + 1)
      expect(await f.store.read('rounds/r/terminal')).toBeUndefined()
      expect(await f.store.archive()).toBeUndefined()
      expect(f.generated).toEqual([])
      current = repaired
    }
    await expect(f.engine().run({ ...f.request, roundId: 'next', roundIndex: 1 }, new AbortController().signal))
      .rejects.toThrow('unresolved round')
    f.provider.evaluate = evaluate
    const calls = f.executions.length
    const repaired = await f.engine().repairEvaluation('r', 'final', pending.resultRefs[0]!, new AbortController().signal)
    expect(f.executions[calls]!.count).toBe(f.seed.tasks.length - current.cells.length)
    expect(repaired.cells).toHaveLength(f.seed.tasks.length)
    expect(repaired.cells).toEqual(expect.arrayContaining(current.cells))
    expect((await f.run()).championChanged).toBe(true)
  })

  it('still terminates a bootstrap that cannot reserve its frozen rollout budget', async () => {
    const f = setup()
    f.config.budgets.round.maxNewRolloutCells = 0
    const outcome = await f.run()
    expect(outcome.reasonCodes).toContain('budget-exhausted:round.cells')
    expect(await f.store.read('rounds/r/terminal')).toBeDefined()
    expect(f.executions).toHaveLength(0)
  })

  it('allows completed archive evidence to be replayed while a round is pending', async () => {
    const f = await archivedEvidence(), completed = await f.complete('first'), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      return input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' ? [] : cells
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const before = f.store.checkpoint()
    expect(await f.complete('first')).toEqual(completed)
    expect(f.store.checkpoint()).toEqual(before)
  })

  it('keeps a pending archive completion ahead of new round execution', async () => {
    const f = await archivedEvidence(), evaluate = f.provider.evaluate
    f.provider.evaluate = async () => { throw new Error('remote response unavailable') }
    f.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'completion-run' })
    await expect(f.complete('pending')).rejects.toBeInstanceOf(SearchOperationPending)
    const before = f.store.checkpoint()
    await expect(f.run()).rejects.toThrow('unresolved completion')
    expect(f.store.checkpoint()).toEqual(before)
    f.provider.evaluate = evaluate
    await f.complete('pending')
    expect((await f.run()).championChanged).toBe(true)
  })

  it('keeps archive completion from entering an unresolved search round', async () => {
    const f = await pausedRound(), archive = (await f.store.archive())!
    const original = archive.results[0]!, plan = archive.plans.find(p => p.digest === original.stagePlanDigest)!
    const candidate = archive.snapshots.find(s => s.digest === original.snapshotDigest)!
    const before = f.store.checkpoint()
    await expect(completeArchivedEvidence({ id: 'interleaved', store: f.store, provider: f.provider, universe: f.seed,
      plan, snapshot: candidate, original, settings: f.config, signal: new AbortController().signal })).rejects.toThrow('unresolved round')
    expect(f.store.checkpoint()).toEqual(before)
    await f.engine().repairEvaluation('r', 'valid', f.originalRef, new AbortController().signal)
    expect((await f.run()).championChanged).toBe(true)
  })

  it('does not reuse a completion journal and budget as a search round', async () => {
    const f = await archivedEvidence()
    await f.complete('first')
    const before = f.store.checkpoint(), calls = f.executions.length
    await expect(f.engine().run({ ...f.request, roundId: 'completion-first' }, new AbortController().signal)).rejects.toThrow('operation kind')
    expect(f.store.checkpoint()).toEqual(before)
    expect(f.executions).toHaveLength(calls)
    expect((await f.run()).championChanged).toBe(true)
  })

  it('does not reuse a search round journal and budget as an archive completion', async () => {
    const f = setup()
    await f.engine().run({ ...f.request, roundId: 'completion-first' }, new AbortController().signal)
    const archive = (await f.store.archive())!, original = archive.results[0]!
    const plan = archive.plans.find(p => p.digest === original.stagePlanDigest)!
    const candidate = archive.snapshots.find(s => s.digest === original.snapshotDigest)!
    const complete = (id: string) => completeArchivedEvidence({ id, store: f.store, provider: f.provider, universe: f.seed,
      plan, snapshot: candidate, original, settings: f.config, signal: new AbortController().signal })
    const before = f.store.checkpoint(), calls = f.executions.length
    await expect(complete('first')).rejects.toThrow('operation kind')
    expect(f.store.checkpoint()).toEqual(before)
    expect(f.executions).toHaveLength(calls)
    await complete('second')
  })
})
