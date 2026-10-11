import { expect, it, vi, afterEach } from 'vitest'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { MemorySearchStore, fixtures, settings } from '../../src/search/testing.js'
import type { SearchProgress } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

afterEach(() => vi.restoreAllMocks())

it('replays the same reached phase callbacks on a pending bridge resume without advancing future phases', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
  const observed: Array<{ first: string[]; resumed: string[] }> = []
  for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    let store = new MemorySearchStore()
    const fixture = fixtures(20), first: string[] = [], resumed: string[] = []
    let active = first, pending = true
    fixture.hooks.progress = async phase => { active.push(phase) }
    const physical = fixture.provider.evaluate
    fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'bridge-worker' })
    fixture.provider.evaluate = async input => {
      if (pending && input.plan.stage === 'bridge' && input.snapshot.candidateId !== 'anchor')
        throw new Error('bridge worker response unavailable')
      return physical(input)
    }
    const request = { evolutionId: 'phase-evolution', roundId: 'phase-round', roundIndex: 0,
      maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('phase-champion'), settings: settings() }
    const run = () => new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    await expect(run()).rejects.toMatchObject({ name: 'SearchOperationPending' })
    expect(first.at(-1)).toBe('bridge')
    pending = false; active = resumed; store = new MemorySearchStore(store.checkpoint())
    // The physical adapter is idempotent under the original key on explicit resume.
    await run()
    observed.push({ first, resumed })
  }
  expect(observed[1]).toEqual(observed[0])
})

it('keeps the optional bridge/global callbacks absent when no candidate is nominated', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
  const observed: string[][] = []
  for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    const store = new MemorySearchStore(), fixture = fixtures(20), phases: string[] = []
    fixture.hooks.progress = async phase => { phases.push(phase) }
    const config = settings()
    config.search.evaluationStages.bridge.maxCandidates = 0
    const request = { evolutionId: 'phase-evolution', roundId: 'phase-round', roundIndex: 0,
      maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('phase-champion'), settings: config }
    await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    observed.push(phases)
  }
  expect(observed[1]).toEqual(observed[0])
  expect(observed[1]).toEqual(['bootstrap', 'scope-preparation', 'diagnosis-planning',
    'generation', 'local', 'seed-research-complete'])
})

it('runs the bridge callback before any bridge rollout can start', async () => {
  const initial = 2_000_000_000_000
  let now = initial
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const observed: Array<{ phases: string[]; bridgeExecutions: number; reasons: string[] }> = []
  for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    now = initial
    const store = new MemorySearchStore(), fixture = fixtures(20), phases: string[] = []
    const config = settings()
    fixture.hooks.progress = async phase => {
      phases.push(phase)
      if (phase === 'bridge') now = initial + config.budgets.round.timeoutMs + 1000
    }
    const request = { evolutionId: 'phase-evolution', roundId: 'phase-round', roundIndex: 0,
      maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('phase-champion'), settings: config }
    const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    observed.push({ phases, bridgeExecutions: fixture.executions.filter(row => row.stage === 'bridge').length,
      reasons: outcome.reasonCodes })
  }
  expect(observed[1]).toEqual(observed[0])
  expect(observed[1]?.bridgeExecutions).toBe(0)
})

it('makes seed decisions and their support readable before any held-out evaluation', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
  const observed: SearchProgress[] = []
  for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    const store = new MemorySearchStore(), fixture = fixtures(20)
    let beforeHeldOut: SearchProgress | undefined
    const physical = fixture.provider.evaluate
    fixture.provider.evaluate = async request => {
      if (request.plan.stage === 'held-out' && !beforeHeldOut)
        beforeHeldOut = await store.read<SearchProgress>('rounds/phase-round/progress')
      return physical(request)
    }
    const request = { evolutionId: 'phase-evolution', roundId: 'phase-round', roundIndex: 0,
      maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('phase-champion'), settings: settings() }
    const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    expect(beforeHeldOut?.phase).toBe('seed-research-complete')
    expect(beforeHeldOut?.decisions).toEqual(outcome.research.stageDecisions)
    for (const decision of beforeHeldOut!.decisions) {
      expect(await store.object(decision.digest)).toEqual(decision)
      expect(await store.object(decision.supportDigest)).toBeDefined()
      expect(await store.object(decision.stagePlanDigest)).toBeDefined()
      if (decision.nextStagePlanDigest) expect(await store.object(decision.nextStagePlanDigest)).toBeDefined()
    }
    observed.push(beforeHeldOut!)
  }
  expect(observed[1]).toEqual(observed[0])
})

it('replays a frozen local decision after its progress write fails without repeating generated work', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
  const observed: Array<{ outcome: unknown; generated: string[]; callbacks: string[] }> = []
  for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    let store = new MemorySearchStore(), fixture = fixtures(20)
    const callbacks: string[] = []
    fixture.hooks.progress = async phase => { callbacks.push(phase) }
    const request = { evolutionId: 'phase-evolution', roundId: 'phase-round', roundIndex: 0,
      maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('phase-champion'), settings: settings() }
    const write = store.write.bind(store)
    let failOnce = true
    store.write = async (name, value) => {
      if (name === 'rounds/phase-round/progress' && failOnce
        && (value as SearchProgress).decisions?.length) {
        failOnce = false
        throw new Error('decision progress unavailable')
      }
      return write(name, value)
    }
    const run = () => new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    await expect(run()).rejects.toThrow('decision progress unavailable')
    const generated = [...fixture.generated]
    store = new MemorySearchStore(store.checkpoint())
    const outcome = await run()
    expect(fixture.generated).toEqual(generated)
    observed.push({ outcome, generated, callbacks })
  }
  expect(observed[1]).toEqual(observed[0])
})
