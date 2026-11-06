import { describe, expect, it } from 'vitest'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { MemorySearchStore, fixtures, revise, settings } from '../../src/search/testing.js'
import { digestJson } from '../../src/state/digest.js'

describe('explicit staged seed reuse', () => {
  for (const allow of [true, false]) it(`does not schedule a held-out run; allowSharedSetPromotion=${allow}`, async () => {
    const f = fixtures(20), config = settings()
    config.promotion.validationMode = 'shared-set-research'; config.promotion.allowSharedSetPromotion = allow
    const originalDescribe = f.provider.describe.bind(f.provider)
    f.provider.describe = async p => p === 'seed' ? originalDescribe(p) : revise(f.seed, { partition: 'held-out' })
    let checks = 0; f.provider.verifySeedPromotionReuse = async () => { checks++ }
    const result = await new FailureClusterSearch(new MemorySearchStore(), f.provider, f.diagnosis, f.hooks).run({
      evolutionId: 'seed-reuse', roundId: 'one', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config,
    }, new AbortController().signal)
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(f.executions.some(e => e.stage === 'held-out')).toBe(false)
    expect(result.championChanged).toBe(allow)
    expect(result.advisory).toBe(!allow)
    expect(result.promotion?.reasonCodes).toContain('shared-set-research-seed-evidence')
  })
  it('rejects seed reuse in independent mode before any run', async () => {
    const f = fixtures(20); f.provider.verifySeedPromotionReuse = async () => {}
    await expect(new FailureClusterSearch(new MemorySearchStore(), f.provider, f.diagnosis, f.hooks).run({
      evolutionId: 'bad-mode', roundId: 'one', roundIndex: 0, maxCandidates: 1, anchor: f.anchor,
      championRevisionDigest: digestJson('revision'), settings: settings(),
    }, new AbortController().signal)).rejects.toThrow('shared-set-research')
    expect(f.executions).toHaveLength(0)
  })
  it('rejects a provider claiming reuse across different tasks', async () => {
    const f = fixtures(20), config = settings()
    config.promotion.validationMode = 'shared-set-research'; config.promotion.allowSharedSetPromotion = true
    f.provider.verifySeedPromotionReuse = async () => {}
    await expect(new FailureClusterSearch(new MemorySearchStore(), f.provider, f.diagnosis, f.hooks).run({
      evolutionId: 'mismatch', roundId: 'one', roundIndex: 0, maxCandidates: 1, anchor: f.anchor,
      championRevisionDigest: digestJson('revision'), settings: config,
    }, new AbortController().signal)).rejects.toThrow('identical task and scoring universes')
    expect(f.executions).toHaveLength(0)
  })
})
