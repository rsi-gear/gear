import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenFailureClusterSearch, SearchEvidencePending as FrozenSearchEvidencePending } from '../helpers/frozen-failure-cluster-search.js'
import { fixtures, settings } from '../helpers/search-fixture.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { SearchEvidencePending } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import type { StageResult } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scenario(driver: 'old' | 'campaign') {
  const root = await mkdtemp(join(tmpdir(), 'gear-campaign-repair-equivalence-'))
  roots.push(root)
  const store = new SearchStore(root), fixture = fixtures(20), config = settings()
  const admission = { evolutionId: 'repair-equivalence', roundId: 'r', roundIndex: 0,
    maxCandidates: 1, anchor: fixture.anchor,
    championRevisionDigest: digestJson('frozen-champion'), settings: config }
  const originalEvaluate = fixture.provider.evaluate
  let partial = true
  fixture.provider.evaluate = async input => {
    const cells = await originalEvaluate(input)
    if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' && partial) {
      partial = false
      return cells.slice(1)
    }
    return cells
  }
  const engine = () => driver === 'old'
    ? new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
    : new CampaignFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
  return { store, fixture, config, admission, engine,
    run: () => engine().run(admission, new AbortController().signal),
    repair: (repairId: string, originalRef: string) => engine().repairEvaluation(
      admission.roundId, repairId, originalRef, new AbortController().signal) }
}

describe('frozen versus Campaign repairEvaluation', () => {
  it('preserves a partial held-out result, original repair key, revision and final publication', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const old = await scenario('old'), modern = await scenario('campaign')
    await expect(old.run()).rejects.toBeInstanceOf(FrozenSearchEvidencePending)
    let campaignPending: string = 'resolved'
    try { await modern.run() } catch (error) {
      campaignPending = error instanceof Error ? error.name : String(error)
    }
    expect(campaignPending).toBe(SearchEvidencePending.name)
    const oldPending = await old.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    const newPending = await modern.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
    expect(newPending).toEqual(oldPending)
    const originalRef = oldPending!.resultRefs[1]!
    const before = await old.store.object<StageResult>(originalRef)
    expect(before.cells).toHaveLength(1)
    const priorCalls = old.fixture.executions.length
    const oldResult = await old.repair('repair-1', originalRef)
    const newResult = await modern.repair('repair-1', originalRef)
    expect(newResult).toEqual(oldResult)
    expect(newResult.supersedesEvidenceDigest).toBe(originalRef)
    expect(old.fixture.executions).toHaveLength(priorCalls + 1)
    expect(modern.fixture.executions).toEqual(old.fixture.executions)
    expect(await modern.store.read('rounds/r/active-repair'))
      .toEqual(await old.store.read('rounds/r/active-repair'))
    expect(await modern.store.read(`rounds/r/repair-${originalRef.slice(7)}`))
      .toEqual(await old.store.read(`rounds/r/repair-${originalRef.slice(7)}`))
    expect(await modern.store.remaining('r', modern.config.budgets))
      .toEqual(await old.store.remaining('r', old.config.budgets))
    expect(await modern.run()).toEqual(await old.run())
  })
})
