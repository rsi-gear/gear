import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenFailureClusterSearch, SearchEvidencePending as FrozenSearchEvidencePending } from '../helpers/frozen-failure-cluster-search.js'
import { evaluatedFixture, fixtures, revise, scopeFixture, settings, snapshot } from '../helpers/search-fixture.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { SearchEvidencePending } from '../../src/search/engine.js'
import { SearchOperationPending } from '../../src/search/recovery.js'
import { SearchStore } from '../../src/search/store.js'
import type { EvidenceCell } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scenario(driver: 'old' | 'campaign') {
  const root = await mkdtemp(join(tmpdir(), 'gear-campaign-repair-recovery-'))
  roots.push(root)
  const store = new SearchStore(root), fixture = fixtures(20), config = settings()
  const admission = { evolutionId: 'repair-recovery', roundId: 'r', roundIndex: 0,
    maxCandidates: 1, anchor: fixture.anchor,
    championRevisionDigest: digestJson('frozen-champion'), settings: config }
  const evaluate = fixture.provider.evaluate, inspect = fixture.provider.inspectEvaluation!
  let repairing = false, ready = false, repairCalls = 0
  fixture.provider.evaluate = async input => {
    const cells = await evaluate(input)
    if (input.plan.stage !== 'held-out' || input.snapshot.candidateId === 'anchor') return cells
    if (!repairing) return cells.slice(1)
    repairCalls++
    if (!ready) throw new Error('lost original repair response')
    return cells
  }
  fixture.provider.inspectEvaluation = async input => {
    if (repairing && input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' && !ready)
      return { status: 'running', handle: 'frozen-repair-worker' }
    return inspect(input)
  }
  const engine = () => driver === 'old'
    ? new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
    : new CampaignFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
  return { root, store, fixture, config, admission,
    run: () => engine().run(admission, new AbortController().signal),
    repair: (id: string, ref: string) => engine().repairEvaluation('r', id, ref, new AbortController().signal),
    beginRepair: () => { repairing = true }, ready: () => { ready = true }, calls: () => repairCalls }
}

async function processScenario(driver: 'old' | 'campaign') {
  const root = await mkdtemp(join(tmpdir(), 'gear-campaign-process-recovery-'))
  roots.push(root)
  const store = new SearchStore(root), fixture = fixtures(20, true), config = settings()
  const admission = { evolutionId: 'process-recovery', roundId: 'r', roundIndex: 0,
    maxCandidates: 1, anchor: fixture.anchor,
    championRevisionDigest: digestJson('frozen-champion'), settings: config }
  const evaluate = fixture.provider.evaluate
  let repairing = false, ready = false
  const processCalls: string[] = []
  const projected = new Map<string, EvidenceCell>()
  fixture.provider.evaluate = async input => {
    const cells = await evaluate(input)
    if (input.plan.stage !== 'held-out' || input.snapshot.candidateId === 'anchor') return cells
    if (!repairing) return cells.slice(1)
    return cells.map(cell => revise(cell, { process: {
      status: 'missing', contractDigest: cell.identity.processContractDigest!,
      reason: 'fixture projection still pending',
    } }))
  }
  fixture.provider.completeProcess = async (cell, key) => {
    processCalls.push(key)
    const completed = revise(cell, { process: {
      status: 'available', rawValue: 1,
      contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef,
    } })
    projected.set(key, completed)
    if (processCalls.length === 1) throw new Error('lost original process response')
    return completed
  }
  fixture.provider.inspectProcess = async (_cell, key) => {
    const completed = projected.get(key)
    if (!completed) return { status: 'not-started' }
    return ready ? { status: 'complete', result: { cells: [completed] } }
      : { status: 'running', handle: 'frozen-process-worker' }
  }
  const engine = () => driver === 'old'
    ? new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
    : new CampaignFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
  return { store, fixture, config, admission,
    run: () => engine().run(admission, new AbortController().signal),
    repair: (id: string, ref: string) => engine().repairEvaluation('r', id, ref, new AbortController().signal),
    beginRepair: () => { repairing = true }, ready: () => { ready = true }, processCalls }
}

async function repeatedRepairScenario(driver: 'old' | 'campaign', roundId = 'r') {
  const root = await mkdtemp(join(tmpdir(), 'gear-campaign-repeated-repair-'))
  roots.push(root)
  const store = new SearchStore(root), fixture = fixtures(20), config = settings()
  const admission = { evolutionId: 'repeated-repair', roundId, roundIndex: 0,
    maxCandidates: 1, anchor: fixture.anchor,
    championRevisionDigest: digestJson('frozen-champion'), settings: config }
  const evaluate = fixture.provider.evaluate
  let phase = 0
  fixture.provider.evaluate = async input => {
    const cells = await evaluate(input)
    if (input.plan.stage !== 'held-out' || input.snapshot.candidateId === 'anchor') return cells
    if (phase === 0) return cells.slice(1)
    if (phase === 1) return []
    return cells
  }
  const engine = () => driver === 'old'
    ? new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
    : new CampaignFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
  return { store, fixture, admission,
    run: () => engine().run(admission, new AbortController().signal),
    repair: (id: string, originalRef: string) => engine().repairEvaluation(roundId, id, originalRef, new AbortController().signal),
    phase: (value: number) => { phase = value } }
}

describe('Campaign repair recovery against frozen FailureClusterSearch', () => {
  it('retries an unresolved evaluation under the original physical key on the next explicit call', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await scenario('old'), modern = await scenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const oldPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    const modernPending = await modern.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(modernPending).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    old.beginRepair(); modern.beginRepair()
    await expect(old.repair('repair-retry', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(modern.repair('repair-retry', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    old.ready(); modern.ready()
    const oldResult = await old.repair('repair-retry', originalRef)
    const modernResult = await modern.repair('repair-retry', originalRef)
    expect(modernResult).toEqual(oldResult)
    expect([old.calls(), modern.calls()]).toEqual([2, 2])
    expect(await modern.store.read('rounds/r/pending-operation'))
      .toEqual(await old.store.read('rounds/r/pending-operation'))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('holds the original physical key and reservation across an expired unknown repair', async () => {
    const start = 2_000_000_000_000
    let now = start
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const old = await scenario('old'), modern = await scenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const oldPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    const modernPending = await modern.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(modernPending).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    old.beginRepair(); modern.beginRepair()
    await expect(old.repair('repair-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(modern.repair('repair-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    const oldCalls = old.calls(), modernCalls = modern.calls()
    expect([oldCalls, modernCalls]).toEqual([1, 1])
    await expect(old.repair('different-label', originalRef)).rejects.toThrow('original repair ID')
    await expect(modern.repair('different-label', originalRef)).rejects.toThrow('original repair ID')
    expect([old.calls(), modern.calls()]).toEqual([oldCalls, modernCalls])
    expect(await modern.store.read('rounds/r/pending-operation'))
      .toEqual(await old.store.read('rounds/r/pending-operation'))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    now = start + old.config.budgets.round.timeoutMs + 1_000
    await expect(old.repair('repair-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(modern.repair('repair-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    expect([old.calls(), modern.calls()]).toEqual([oldCalls, modernCalls])
    old.ready(); modern.ready()
    const oldResult = await old.repair('repair-1', originalRef)
    const newResult = await modern.repair('repair-1', originalRef)
    expect(newResult).toEqual(oldResult)
    expect(newResult.supersedesEvidenceDigest).toBe(originalRef)
    expect(oldResult.cells).toHaveLength(2)
    expect([old.calls(), modern.calls()]).toEqual([oldCalls, modernCalls])
    expect(await modern.store.read('rounds/r/pending-operation'))
      .toEqual(await old.store.read('rounds/r/pending-operation'))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('stops after the first pending process projection and resumes its original cell key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await processScenario('old'), modern = await processScenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const oldPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    const modernPending = await modern.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(modernPending).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    old.beginRepair(); modern.beginRepair()
    await expect(old.repair('process-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    await expect(modern.repair('process-1', originalRef)).rejects.toBeInstanceOf(SearchOperationPending)
    expect(modern.processCalls).toEqual(old.processCalls)
    expect(old.processCalls).toHaveLength(1)
    expect(await modern.store.read('rounds/r/pending-operation'))
      .toEqual(await old.store.read('rounds/r/pending-operation'))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    old.ready(); modern.ready()
    const oldResult = await old.repair('process-1', originalRef)
    const newResult = await modern.repair('process-1', originalRef)
    expect(newResult).toEqual(oldResult)
    expect(modern.processCalls).toEqual(old.processCalls)
    expect(old.processCalls).toHaveLength(2)
    expect(await modern.store.read('rounds/r/pending-operation'))
      .toEqual(await old.store.read('rounds/r/pending-operation'))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('publishes the latest incomplete revision as the next pending input while retaining original repair ownership', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await repeatedRepairScenario('old'), modern = await repeatedRepairScenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const originalPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(await modern.store.read('rounds/r/pending-evidence')).toEqual(originalPending)
    const originalRef = originalPending!.resultRefs[1]!
    old.phase(1); modern.phase(1)
    const oldFirst = await old.repair('first-input', originalRef)
    const modernFirst = await modern.repair('first-input', originalRef)
    expect(modernFirst).toEqual(oldFirst)
    expect(oldFirst.cells).toHaveLength(1)
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const nextPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(nextPending!.resultRefs[1]).toBe(oldFirst.digest)
    expect(nextPending!.resultRefs[1]).not.toBe(originalRef)
    expect(await modern.store.read('rounds/r/pending-evidence')).toEqual(nextPending)
    old.phase(2); modern.phase(2)
    const secondId = originalRef.slice(7)
    const oldSecond = await old.repair(secondId, originalRef)
    const modernSecond = await modern.repair(secondId, originalRef)
    expect(modernSecond).toEqual(oldSecond)
    expect(oldSecond.supersedesEvidenceDigest).toBe(oldFirst.digest)
    expect(await modern.run()).toEqual(await old.run())
  })

  it('rethrows the original journal completion failure and reconciles the same physical result', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await repeatedRepairScenario('old'), modern = await repeatedRepairScenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const oldPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    const modernPending = await modern.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(modernPending).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    old.phase(2); modern.phase(2)
    const oldResult = await old.repair('repair-fault', originalRef)
    const originalWrite = modern.store.write.bind(modern.store)
    const failure = new Error('injected provider completion journal write')
    let thrown = false
    const write = vi.spyOn(modern.store, 'write').mockImplementation(async (name, value) => {
      if (!thrown && name.startsWith('rounds/r/campaign/providers/')
        && (value as { stage?: string }).stage === 'complete') {
        thrown = true
        throw failure
      }
      return originalWrite(name, value)
    })
    await expect(modern.repair('repair-fault', originalRef)).rejects.toBe(failure)
    expect(thrown).toBe(true)
    write.mockRestore()
    const calls = modern.fixture.executions.length
    await expect(modern.repair('different-label', originalRef)).rejects.toThrow('original repair ID')
    expect(modern.fixture.executions).toHaveLength(calls)
    const newResult = await modern.repair('repair-fault', originalRef)
    expect(newResult).toEqual(oldResult)
    expect(modern.fixture.executions).toEqual(old.fixture.executions)
    expect(await modern.store.remaining('r', modern.admission.settings.budgets))
      .toEqual(await old.store.remaining('r', old.admission.settings.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('repairs an old legal long round ID through the bounded internal Campaign identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const roundId = 'r'.repeat(180)
    const old = await repeatedRepairScenario('old', roundId)
    const modern = await repeatedRepairScenario('campaign', roundId)
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const oldPending = await old.store.read<{ resultRefs: string[] }>(`rounds/${roundId}/pending-evidence`)
    expect(await modern.store.read(`rounds/${roundId}/pending-evidence`)).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    old.phase(2); modern.phase(2)
    expect(await modern.repair('repair-long-id', originalRef))
      .toEqual(await old.repair('repair-long-id', originalRef))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('seals a prestart repair deadline failure without starting new physical work', async () => {
    const start = 2_000_000_000_000
    let now = start
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const old = await repeatedRepairScenario('old'), modern = await repeatedRepairScenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(await modern.store.read('rounds/r/pending-evidence')).toEqual(pending)
    const originalRef = pending!.resultRefs[1]!
    const oldCalls = old.fixture.executions.length, modernCalls = modern.fixture.executions.length
    now += old.admission.settings.budgets.round.timeoutMs + 1_000
    old.phase(2); modern.phase(2)
    const oldResult = await old.repair('late-repair', originalRef)
    const modernResult = await modern.repair('late-repair', originalRef)
    expect(modernResult).toEqual(oldResult)
    expect(modernResult.failure).toMatchObject({ kind: 'budget-exhausted', code: 'time' })
    expect(old.fixture.executions).toHaveLength(oldCalls)
    expect(modern.fixture.executions).toHaveLength(modernCalls)
    const oldOutcome = await old.run()
    const modernOutcome = await modern.run()
    expect(modernOutcome).toEqual(oldOutcome)
    expect(oldOutcome.reasonCodes).toContain('budget-exhausted:time')
  })

  it('turns an unreserved repair-cell quota failure into the old stage reason without another ledger', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await repeatedRepairScenario('old'), modern = await repeatedRepairScenario('campaign')
    old.admission.settings.budgets.round.maxRepairCells = 0
    modern.admission.settings.budgets.round.maxRepairCells = 0
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(await modern.store.read('rounds/r/pending-evidence')).toEqual(pending)
    const originalRef = pending!.resultRefs[1]!
    const oldCalls = old.fixture.executions.length, modernCalls = modern.fixture.executions.length
    old.phase(2); modern.phase(2)
    const oldResult = await old.repair('no-repair-quota', originalRef)
    const modernResult = await modern.repair('no-repair-quota', originalRef)
    expect(modernResult).toEqual(oldResult)
    expect(modernResult.failure).toMatchObject({ kind: 'budget-exhausted', code: 'round.repairCells' })
    expect(old.fixture.executions).toHaveLength(oldCalls)
    expect(modern.fixture.executions).toHaveLength(modernCalls)
    expect(await modern.store.remaining('r', modern.admission.settings.budgets))
      .toEqual(await old.store.remaining('r', old.admission.settings.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })

  it('rejects foreign evidence before claiming repair ownership or spending budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await repeatedRepairScenario('old'), modern = await repeatedRepairScenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    await expect(modern.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const foreign = snapshot('foreign')
    const scope = scopeFixture(old.fixture.heldOut, old.fixture.heldOut.tasks.map(task => task.id))
    const row = evaluatedFixture(old.fixture.heldOut, scope, foreign, () => undefined, { stage: 'held-out' })
    for (const fixture of [old, modern]) for (const value of [foreign, row.plan, row.result])
      await fixture.store.put(value)
    const oldRemaining = await old.store.remaining('r', old.admission.settings.budgets)
    const modernRemaining = await modern.store.remaining('r', modern.admission.settings.budgets)
    expect(modernRemaining).toEqual(oldRemaining)
    const oldCalls = old.fixture.executions.length, modernCalls = modern.fixture.executions.length
    await expect(old.repair('foreign', row.result.digest)).rejects.toThrow('this round')
    await expect(modern.repair('foreign', row.result.digest)).rejects.toThrow('this round')
    expect(await modern.store.read('rounds/r/active-repair'))
      .toEqual(await old.store.read('rounds/r/active-repair'))
    expect(await modern.store.remaining('r', modern.admission.settings.budgets))
      .toEqual(await old.store.remaining('r', old.admission.settings.budgets))
    expect(old.fixture.executions).toHaveLength(oldCalls)
    expect(modern.fixture.executions).toHaveLength(modernCalls)
    const pending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    old.phase(2); modern.phase(2)
    expect(await modern.repair('valid', pending!.resultRefs[1]!))
      .toEqual(await old.repair('valid', pending!.resultRefs[1]!))
  })
})
