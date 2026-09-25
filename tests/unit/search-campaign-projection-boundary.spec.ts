import { afterEach, expect, it, vi } from 'vitest'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { MemorySearchStore, fixtures, settings } from '../../src/search/testing.js'
import { digestJson } from '../../src/state/digest.js'

afterEach(() => vi.restoreAllMocks())

for (const crashPhase of [undefined, 'scope-preparation', 'generation'] as const) {
  it(`preserves budget and effect visibility at scientific phase barriers (crash=${crashPhase ?? 'none'})`, async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const observations: unknown[] = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      let store = new MemorySearchStore()
      const f = fixtures(20), config = settings(), trace: unknown[] = []
      let inject = crashPhase !== undefined
      const request = { evolutionId: 'projection-evolution', roundId: 'projection-round', roundIndex: 0,
        maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('projection-champion'), settings: config }
      f.hooks.progress = async phase => {
        trace.push({ phase, remaining: await store.remaining(request.roundId, config.budgets),
          evaluations: structuredClone(f.executions), generated: [...f.generated] })
        if (inject && phase === crashPhase) { inject = false; throw new Error('phase observer interrupted') }
      }
      const run = () => new Search(store, f.provider, f.diagnosis, f.hooks).run(request, new AbortController().signal)
      if (crashPhase) {
        await expect(run()).rejects.toThrow('phase observer interrupted')
        store = new MemorySearchStore(store.checkpoint())
      }
      const outcome = await run()
      observations.push({ trace, outcome })
    }
    expect(observations[1]).toEqual(observations[0])
  })
}
