import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { SearchStore } from '../../src/search/store.js'
import { digestJson } from '../../src/state/digest.js'
import { fixtures, settings } from '../../src/search/testing.js'
import type { DiagnosisProvider } from '../../src/search/types.js'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Campaign FailureClusterSearch bootstrap migration', () => {
  it('executes bootstrap and no-candidate research as separate operations, then publishes one terminal outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-campaign-search-')); roots.push(root)
    const fixture = fixtures(20)
    const diagnosis: DiagnosisProvider = { ...fixture.diagnosis,
      diagnose: async () => ({ facts: [], inputTokens: 3, outputTokens: 2 }) }
    const store = new SearchStore(root)
    const search = new CampaignFailureClusterSearch(store, fixture.provider, diagnosis, fixture.hooks)
    const request = { evolutionId: 'campaign-bootstrap', roundId: 'round-0', roundIndex: 0,
      maxCandidates: 1, anchor: fixture.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
    const result = await search.run(request, new AbortController().signal)
    expect(result.roundId).toBe(request.roundId)
    expect(result.championChanged).toBe(false)
    expect(result.research.workplans).toEqual([])
    expect(result.reasonCodes).toContain('no-actionable-cluster')
    expect((await store.archive())?.digest).toBe(result.archiveDigest)
    expect(await store.read(`rounds/${request.roundId}/terminal`)).toBeTruthy()
    const calls = fixture.executions.length
    const resumed = new CampaignFailureClusterSearch(new SearchStore(root), fixture.provider, diagnosis, fixture.hooks)
    expect((await resumed.run(request, new AbortController().signal)).digest).toBe(result.digest)
    expect(fixture.executions).toHaveLength(calls)
    expect(fixture.generated).toEqual([])
  })

  it('matches the frozen no-candidate outcome', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const legacyRoot = await mkdtemp(join(tmpdir(), 'gear-legacy-search-'))
    const campaignRoot = await mkdtemp(join(tmpdir(), 'gear-campaign-search-'))
    roots.push(legacyRoot, campaignRoot)
    const admission = { evolutionId: 'campaign-comparison', roundId: 'round-0', roundIndex: 0,
      maxCandidates: 1, championRevisionDigest: digestJson('revision'), settings: settings() }
    const legacyFixture = fixtures(20)
    legacyFixture.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 3, outputTokens: 2 })
    const legacyStore = new SearchStore(legacyRoot)
    const expected = await new FrozenFailureClusterSearch(legacyStore, legacyFixture.provider,
      legacyFixture.diagnosis, legacyFixture.hooks).run({ ...admission, anchor: legacyFixture.anchor }, new AbortController().signal)
    const fixture = fixtures(20)
    fixture.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 3, outputTokens: 2 })
    const campaignStore = new SearchStore(campaignRoot)
    const actual = await new CampaignFailureClusterSearch(campaignStore, fixture.provider,
      fixture.diagnosis, fixture.hooks).run({ ...admission, anchor: fixture.anchor }, new AbortController().signal)
    expect(await campaignStore.archive()).toEqual(await legacyStore.archive())
    expect(actual).toEqual(expected)
  })

  it('keeps the complete candidate seed research archive identical to the frozen engine', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const legacyRoot = await mkdtemp(join(tmpdir(), 'gear-legacy-candidate-'))
    const campaignRoot = await mkdtemp(join(tmpdir(), 'gear-campaign-candidate-'))
    roots.push(legacyRoot, campaignRoot)
    const admission = { evolutionId: 'campaign-comparison', roundId: 'round-0', roundIndex: 0,
      maxCandidates: 1, championRevisionDigest: digestJson('revision'), settings: settings() }
    const legacyFixture = fixtures(20), campaignFixture = fixtures(20)
    const legacyStore = new SearchStore(legacyRoot), campaignStore = new SearchStore(campaignRoot)
    await new FrozenFailureClusterSearch(legacyStore, legacyFixture.provider, legacyFixture.diagnosis,
      legacyFixture.hooks).run({ ...admission, anchor: legacyFixture.anchor }, new AbortController().signal)
    await new CampaignFailureClusterSearch(campaignStore, campaignFixture.provider, campaignFixture.diagnosis,
      campaignFixture.hooks).run({ ...admission, anchor: campaignFixture.anchor }, new AbortController().signal)
    expect(await campaignStore.archive()).toEqual(await legacyStore.archive())
  })
})
