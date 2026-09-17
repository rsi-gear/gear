import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch, SearchEvidencePending } from '../../src/search/engine.js'
import { SearchExecutionFailure, SearchOperationPending } from '../../src/search/recovery.js'
import { completeArchivedEvidence } from '../../src/search/completion.js'
import { buildArchive } from '../../src/search/archive.js'
import { SearchStore } from '../../src/search/store.js'
import type { EvidenceCell, PendingSearchOperation, Stage, StageResult } from '../../src/search/types.js'
import { fixtures, settings, evaluatedFixture, scopeFixture, revise } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(process = false) {
  const f = fixtures(20, process), config = settings()
  const root = await mkdtemp(join(tmpdir(), 'gear-recovery-')); roots.push(root)
  const store = new SearchStore(root)
  const request = { evolutionId: 'recovery', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }
  const engine = () => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks)
  const run = () => engine().run(request, new AbortController().signal)
  return { ...f, store, config, request, run }
}

describe('external execution recovery and budget settlement', () => {
  for (const stage of ['local', 'bridge', 'global-seed', 'held-out'] as Stage[]) {
    it(`[R01,R08] recovers a lost ${stage} response from the original operation without replaying execution`, async () => {
      const f = await setup(), original = f.provider.evaluate
      let interrupted = false
      f.provider.evaluate = async input => {
        const cells = await original(input)
        if (!interrupted && input.snapshot.candidateId !== 'anchor' && input.plan.stage === stage) {
          interrupted = true; throw new Error('response lost after remote completion')
        }
        return cells
      }
      const result = await f.run()
      expect(interrupted).toBe(true)
      expect(result.championChanged).toBe(true)
      expect(f.executions.length).toBe(new Set(f.executions.map(e => e.key)).size)
      expect(await f.run()).toEqual(result)
      expect(f.generated.length).toBe(new Set(f.generated).size)
    })

    it(`[E04,R04,R08] preserves unresolved ${stage} identity and resumes only the same idempotency key`, async () => {
      const f = await setup(), original = f.provider.evaluate
      const keys: string[] = []
      let ready = false
      f.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'external-run-17' })
      f.provider.evaluate = async input => {
        if (input.snapshot.candidateId !== 'anchor' && input.plan.stage === stage && !keys.length || keys.includes(input.idempotencyKey)) {
          keys.push(input.idempotencyKey)
          if (!ready) throw new Error('transport disconnected')
        }
        return original(input)
      }
      await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
      const pending = await f.store.read<PendingSearchOperation>('rounds/r/pending-operation')
      expect(pending).toMatchObject({ state: 'running', handle: 'external-run-17', operationKey: keys[0] })
      expect(await f.store.read('rounds/r/commit')).toBeUndefined()
      const research = await f.store.read('rounds/r/research')
      if (stage === 'held-out') expect(research).toBeDefined()
      const generated = [...f.generated]
      ready = true
      const result = await f.run()
      expect(result.championChanged).toBe(true)
      expect(keys).toEqual([keys[0], keys[0]])
      expect(f.generated).toEqual(generated)
      expect(await f.store.read('rounds/r/pending-operation')).toBeNull()
      if (stage === 'held-out') expect(await f.store.read('rounds/r/research')).toEqual(research)
    })
  }

  for (const stage of ['local', 'bridge', 'global-seed', 'held-out'] as Stage[]) {
    it(`[E04,R04] records verified ${stage} failure while preserving sealed candidates and local evidence`, async () => {
      const f = await setup(), original = f.provider.evaluate
      let failed = false
      f.provider.evaluate = async input => {
        if (input.snapshot.candidateId !== 'anchor' && input.plan.stage === stage) {
          failed = true; throw new SearchExecutionFailure('worker-exited', 'worker exited with terminal status', 'remote:failure-17')
        }
        return original(input)
      }
      const result = await f.run(), archive = (await f.store.archive())!
      expect(failed).toBe(true)
      expect(result.championChanged).toBe(false)
      expect(result.reasonCodes).toContain('execution-failure:worker-exited')
      expect(archive.snapshots.filter(s => s.parentIds.length)).toHaveLength(f.generated.length)
      if (stage !== 'local') expect(result.research.candidates.every(c => c.profile.outcomeComplete)).toBe(true)
      expect(f.executions.filter(e => e.stage === 'global-seed' && e.participant !== 'anchor').length).toBeLessThanOrEqual(1)
      expect(f.promotions).toEqual([])
    })
  }

  it('[D05,E04] expires after local evaluation, preserves research and starts no further external work', async () => {
    const f = await setup(), progress = f.hooks.progress
    const start = Date.now()
    f.hooks.progress = async phase => {
      await progress?.(phase)
      if (phase === 'bridge') vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    }
    const result = await f.run()
    expect(result.championChanged).toBe(false)
    expect(result.research.candidates).toHaveLength(4)
    expect(result.research.candidates.every(c => c.profile.outcomeComplete)).toBe(true)
    expect(result.reasonCodes).toContain('budget-exhausted:time')
    expect(f.executions.some(e => e.stage === 'bridge' || e.stage === 'global-seed' || e.stage === 'held-out')).toBe(false)
    expect(await f.run()).toEqual(result)
  })

  for (const resolution of ['complete', 'not-started'] as const) it(`[R04,D05] only inspects an unresolved held-out operation after expiration (${resolution})`, async () => {
    const f = await setup(), original = f.provider.evaluate, start = Date.now()
    let key: string | undefined, savedCells: EvidenceCell[] = [], ready = false, calls = 0
    f.provider.evaluate = async input => {
      calls++
      if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        key = input.idempotencyKey
        if (resolution === 'complete') savedCells = await original(input)
        throw new Error('lost connection')
      }
      return original(input)
    }
    f.provider.inspectEvaluation = async input => {
      expect(input.idempotencyKey).toBe(key)
      return !ready ? { status: 'running', handle: 'run-9' } : resolution === 'complete'
        ? { status: 'complete', result: { cells: savedCells } } : { status: 'not-started' }
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    const before = calls, research = await f.store.read('rounds/r/research')
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    expect(calls).toBe(before)
    ready = true
    const result = await f.run()
    expect(calls).toBe(before)
    expect(result.championChanged).toBe(resolution === 'complete')
    expect(await f.store.read('rounds/r/research')).toEqual(research)
    expect(await f.store.read('rounds/r/pending-operation')).toBeNull()
  })

  it('[R08] does not disguise a journal write failure as a terminal provider failure', async () => {
    const f = await setup(), write = f.store.write.bind(f.store)
    let interrupted = false
    vi.spyOn(f.store, 'write').mockImplementation(async (name, value) => {
      if (!interrupted && name.startsWith('cells/') && f.executions.some(e => e.stage === 'bridge')) {
        interrupted = true; throw new Error('disk unavailable')
      }
      return write(name, value)
    })
    await expect(f.run()).rejects.toThrow('disk unavailable')
    expect(await f.store.read('rounds/r/commit')).toBeUndefined()
    const before = [...f.executions], result = await f.run()
    expect(result.championChanged).toBe(true)
    expect(new Set(f.executions.map(e => e.key)).size).toBe(f.executions.length)
    expect(f.executions.slice(0, before.length)).toEqual(before)
  })
  for (const kind of ['diagnosis', 'generation'] as const) it(`[D05,R08] inspects the original ${kind} after its response was lost and the budget expired`, async () => {
    const f = await setup(), start = Date.now()
    let ready = false, calls = 0
    if (kind === 'diagnosis') {
      const original = f.diagnosis.diagnose, inspect = f.diagnosis.inspectDiagnosis!
      f.diagnosis.diagnose = async input => { calls++; await original(input); throw new Error('lost diagnosis response') }
      f.diagnosis.inspectDiagnosis = async (key, signal) => ready ? inspect(key, signal) : { status: 'running', handle: 'diagnosis-1' }
    } else {
      const original = f.hooks.generate, inspect = f.hooks.inspectGeneration!
      f.hooks.generate = async input => { calls++; await original(input); throw new Error('lost generation response') }
      f.hooks.inspectGeneration = async (key, signal) => ready ? inspect(key, signal) : { status: 'running', handle: 'meta-1' }
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    const pending = await f.store.read<PendingSearchOperation>('rounds/r/pending-operation')
    expect(pending?.kind).toBe(kind)
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    ready = true
    const result = await f.run()
    expect(calls).toBe(1)
    expect(result.championChanged).toBe(false)
    expect(f.executions.filter(e => e.participant !== 'anchor')).toEqual([])
    expect((await f.store.archive())!.snapshots.filter(s => s.parentIds.length)).toHaveLength(kind === 'generation' ? 1 : 0)
    expect(await f.store.read('rounds/r/pending-operation')).toBeNull()
  })

  it('[D05] exposes a generation deadline abort without converting unknown external work into failure', async () => {
    const f = await setup()
    // Give bootstrap time to finish, then simulate an external Meta operation
    // that observes the abort but cannot certify that its remote worker stopped.
    f.config.budgets.round.timeoutMs = 1500
    let aborted = false
    f.hooks.generate = async input => new Promise((_resolve, reject) => {
      const stop = () => { aborted = true; reject(input.signal.reason) }
      if (input.signal.aborted) stop(); else input.signal.addEventListener('abort', stop, { once: true })
    })
    f.hooks.inspectGeneration = async () => ({ status: 'running', handle: 'meta-still-running' })
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    expect(aborted).toBe(true)
    expect(await f.store.read('rounds/r/commit')).toBeUndefined()
    expect(await f.store.read('rounds/r/pending-operation')).toMatchObject({ kind: 'generation', state: 'running' })
  })

  it('settles a held-out repair started after expiry without blocking round completion', async () => {
    const f = await setup(), original = f.provider.evaluate, start = Date.now()
    f.provider.evaluate = async input => {
      const cells = await original(input)
      return input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' ? cells.slice(1) : cells
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const before = await f.store.object<StageResult>(pending.resultRefs[1]!), calls = f.executions.length
    const ledger = await f.store.read('budget')
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    const engine = new FailureClusterSearch(f.store, f.provider, f.diagnosis, f.hooks)
    const repaired = await engine.repairEvaluation('r', 'expired-repair', before.digest, new AbortController().signal)
    expect(repaired.failure).toMatchObject({ kind: 'budget-exhausted', code: 'time' })
    expect(repaired.cells).toEqual(before.cells)
    expect(await f.store.read('budget')).toEqual(ledger)
    const result = await f.run()
    expect(result.reasonCodes).toContain('budget-exhausted:time')
    expect(result.championChanged).toBe(false)
    expect(f.executions).toHaveLength(calls)
    expect(await f.store.read('active-round')).toEqual({ roundId: null })
    expect(await f.run()).toEqual(result)
  })

  it('[R06,R08] recovers a held-out repair after deadline using only its original cell request', async () => {
    const f = await setup(), original = f.provider.evaluate, inspect = f.provider.inspectEvaluation!, start = Date.now()
    let repair = false, ready = false, calls = 0
    f.provider.evaluate = async input => {
      calls++
      const cells = await original(input)
      if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        if (repair) throw new Error('lost repair response')
        return cells.slice(1)
      }
      return cells
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const originalRef = pending.resultRefs[1]!, research = await f.store.read('rounds/r/research')
    repair = true
    f.provider.inspectEvaluation = async input => ready ? inspect(input) : { status: 'running', handle: 'repair-run-1' }
    const engine = new FailureClusterSearch(f.store, f.provider, f.diagnosis, f.hooks)
    const complete = () => engine.repairEvaluation('r', 'repair-1', originalRef, new AbortController().signal)
    await expect(complete()).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(engine.repairEvaluation('r', 'different-label', originalRef, new AbortController().signal)).rejects.toThrow('original repair ID')
    const before = calls
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    await expect(complete()).rejects.toBeInstanceOf(SearchOperationPending)
    ready = true
    const result = await complete()
    expect(result.supersedesEvidenceDigest).toBe(originalRef)
    expect(result.cells).toHaveLength(f.heldOut.tasks.length)
    expect(calls).toBe(before)
    expect((await f.run()).championChanged).toBe(true)
    expect(await f.store.read('rounds/r/research')).toEqual(research)
  })

  it('retains repair ownership after a crash before settlement or the pending marker', async () => {
    const f = await setup(), evaluate = f.provider.evaluate, start = Date.now()
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      return input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' ? cells.slice(1) : cells
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const originalRef = pending.resultRefs[1]!
    f.provider.evaluate = evaluate
    const repair = (id: string) => new FailureClusterSearch(f.store, f.provider, f.diagnosis, f.hooks)
      .repairEvaluation('r', id, originalRef, new AbortController().signal)
    vi.spyOn(f.store, 'settle').mockRejectedValueOnce(new Error('crash before repair settlement'))
    await expect(repair('first')).rejects.toThrow('crash before repair settlement')
    expect(await f.store.read('rounds/r/pending-operation')).toBeUndefined()
    const calls = f.executions.length, ledger = await f.store.read('budget')
    await expect(repair('second')).rejects.toThrow('original repair ID')
    expect(await f.store.read('budget')).toEqual(ledger)
    expect(f.executions).toHaveLength(calls)
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    await expect(f.run()).rejects.toThrow('original repair ID')
    const completed = await repair('first')
    expect(completed.cells).toHaveLength(f.heldOut.tasks.length)
    expect(await repair('first')).toEqual(completed)
    expect(f.executions).toHaveLength(calls)
    expect((await f.run()).championChanged).toBe(true)
  })

  it('[R07,R08,M06] recovers historical process projection without rerunning valid outcome or changing the old archive', async () => {
    const f = await setup(true), start = Date.now()
    const scope = scopeFixture(f.seed, ['task-0', 'task-1'])
    const row = evaluatedFixture(f.seed, scope, f.anchor, id => id === 'task-0' ? { outcome: 0 } : undefined)
    const archived = buildArchive({ evolutionId: 'recovery', universe: f.seed, snapshots: [f.anchor], scopes: [scope], results: [row.result], plans: [row.plan], config: f.config.search, championId: f.anchor.candidateId })
    await f.store.casArchive(undefined, archived)
    let projections = 0, ready = false, projected: EvidenceCell | undefined
    f.provider.completeProcess = async cell => {
      projections++
      projected = revise(cell, { process: { status: 'available', rawValue: 0.5, contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
      throw new Error('lost original artifact projection response')
    }
    f.provider.inspectProcess = async () => ready ? { status: 'complete', result: { cells: [projected!] } } : { status: 'running', handle: 'projection-1' }
    const complete = () => completeArchivedEvidence({ id: 'historical-1', store: f.store, provider: f.provider, universe: f.seed, plan: row.plan, snapshot: f.anchor, original: row.result, settings: f.config, signal: new AbortController().signal })
    await expect(complete()).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(completeArchivedEvidence({ id: 'different-label', store: f.store, provider: f.provider, universe: f.seed, plan: row.plan, snapshot: f.anchor, original: row.result, settings: f.config, signal: new AbortController().signal })).rejects.toThrow('original ID')
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    await expect(complete()).rejects.toBeInstanceOf(SearchOperationPending)
    ready = true
    const completion = await complete()
    const result = await f.store.object<typeof row.result>(completion.completedResultDigest)
    expect(result.cells).toHaveLength(2)
    expect(result.cells.every(c => c.process?.status === 'available')).toBe(true)
    expect(result.cells.find(c => c.identity.taskId === 'task-0')?.outcome).toEqual(row.result.cells[0]!.outcome)
    expect(projections).toBe(1)
    expect(f.executions.map(e => e.count)).toEqual([1])
    expect(await f.store.archive()).toEqual(archived)
    expect(await complete()).toEqual(completion)
  })

  it.each(['time', 'cells'] as const)('settles an archive completion when its %s budget expires before reservation', async resource => {
    const f = await setup(), scope = scopeFixture(f.seed, ['task-0', 'task-1']), start = Date.now()
    f.config.budgets.round.timeoutMs = 30000
    if (resource === 'cells') f.config.budgets.round.maxNewRolloutCells = 0
    const row = evaluatedFixture(f.seed, scope, f.anchor, id => id === 'task-0' ? { outcome: 0 } : undefined)
    const archived = buildArchive({ evolutionId: 'recovery', universe: f.seed, snapshots: [f.anchor], scopes: [scope],
      results: [row.result], plans: [row.plan], config: f.config.search, championId: f.anchor.candidateId })
    await f.store.casArchive(undefined, archived)
    const write = f.store.write.bind(f.store)
    const fault = vi.spyOn(f.store, 'write').mockImplementation(async (path, value) => {
      await write(path, value)
      if (path === 'rounds/completion-first/cell-request') throw new Error('crashed before reservation')
    })
    const complete = (id = 'first') => completeArchivedEvidence({ id, store: f.store, provider: f.provider, universe: f.seed,
      plan: row.plan, snapshot: f.anchor, original: row.result, settings: f.config, signal: new AbortController().signal })
    await expect(complete()).rejects.toThrow('crashed before reservation')
    fault.mockRestore()
    if (resource === 'time') vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    const completion = await complete()
    const result = await f.store.object<StageResult>(completion.completedResultDigest)
    expect(result.failure).toMatchObject({ kind: 'budget-exhausted', code: resource === 'time' ? 'time' : 'round.cells' })
    expect(result.cells).toEqual(row.result.cells)
    expect(f.executions).toHaveLength(0)
    expect(await f.store.read('budget')).toBeUndefined()
    expect(await f.store.archive()).toEqual(archived)
    expect(await complete()).toEqual(completion)
    // A settled completion cannot lock out the next operation ID.
    await complete('next')
  })

  it('[R07,R10,M07] reuses completed slots and process when a new completion ID references the old partial result', async () => {
    const f = await setup(true), scope = scopeFixture(f.seed, ['task-0', 'task-1'])
    const row = evaluatedFixture(f.seed, scope, f.anchor, id => id === 'task-0' ? { outcome: 0 } : undefined)
    let projections = 0
    f.provider.completeProcess = async cell => {
      projections++
      return revise(cell, { process: { status: 'available', rawValue: 0.5, contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
    }
    const complete = (id: string) => completeArchivedEvidence({ id, store: f.store, provider: f.provider, universe: f.seed, plan: row.plan, snapshot: f.anchor, original: row.result, settings: f.config, signal: new AbortController().signal })
    const first = await complete('first'), calls = f.executions.length
    const second = await complete('second')
    expect(second.completedResultDigest).toBe(first.completedResultDigest)
    expect(f.executions).toHaveLength(calls)
    expect(f.executions.map(e => e.count)).toEqual([1])
    expect(projections).toBe(1)
    expect(row.result.cells[0]!.outcome).toMatchObject({ rawValue: 0 })
    expect(row.result.cells[0]!.process?.status).toBe('missing')
  })

  it('[R06,R08,M06] resumes projection of a freshly repaired outcome using the original repair operation', async () => {
    const f = await setup(true), original = f.provider.evaluate, start = Date.now()
    let repairing = false, ready = false, projections = 0, projected: EvidenceCell | undefined
    f.provider.evaluate = async input => {
      const cells = await original(input)
      if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        if (!repairing) return cells.slice(1)
        return cells.map(c => revise(c, { process: { status: 'missing', contractDigest: c.identity.processContractDigest!, reason: 'projection pending' } }))
      }
      return cells
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const originalRef = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!.resultRefs[1]!
    f.provider.completeProcess = async cell => {
      projections++
      projected = revise(cell, { process: { status: 'available', rawValue: 1, contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
      throw new Error('lost fresh projection response')
    }
    f.provider.inspectProcess = async () => ready ? { status: 'complete', result: { cells: [projected!] } } : { status: 'running', handle: 'fresh-projection-1' }
    const engine = new FailureClusterSearch(f.store, f.provider, f.diagnosis, f.hooks)
    const complete = () => engine.repairEvaluation('r', 'fresh-1', originalRef, new AbortController().signal)
    repairing = true
    await expect(complete()).rejects.toBeInstanceOf(SearchOperationPending)
    const count = f.executions.length
    vi.spyOn(Date, 'now').mockReturnValue(start + f.config.budgets.round.timeoutMs + 1000)
    ready = true
    const result = await complete()
    expect(result.cells.every(c => c.process?.status === 'available')).toBe(true)
    expect(projections).toBe(1)
    expect(f.executions).toHaveLength(count)
    expect((await f.run()).championChanged).toBe(true)
  })

})
