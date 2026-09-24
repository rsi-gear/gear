import { describe, expect, it, vi, afterEach } from 'vitest'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'
import { cellKey } from '../../src/search/evidence.js'
import { MemorySearchStore, fixtures, revise, settings } from '../../src/search/testing.js'
import type { EvidenceCell, StageResult } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

afterEach(() => vi.restoreAllMocks())

describe('Campaign initial objective reference recovery', () => {
  it('returns the original evidence fence and resumes a repaired reference without another rollout', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const compared: unknown[] = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      let store = new MemorySearchStore()
      const f = fixtures(20), config = settings()
      const contracts = ['quality', 'retained'].map(id => resolveMetric({ id, revision: '1', unit: 'score',
        direction: 'maximize', source: { path: `originalResult.${id}`, extractor: 'number-v1' },
        granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
      const objective = resolveObjective({ terms: [{ metric: 'quality', weight: 1 }],
        constraints: [{ metric: 'retained', rule: 'no_regression', reference: 'initial_baseline' }] }, contracts)
      const seed = revise(f.seed, { rawMetricContracts: contracts, objective })
      const heldOut = revise(f.heldOut, { rawMetricContracts: contracts, objective })
      f.provider.capabilities.objectives = 1
      f.provider.describe = async partition => partition === 'seed' ? seed : heldOut
      const measured = (cell: EvidenceCell, quality?: number): EvidenceCell => revise(cell, {
        rawMetrics: extractRawMetrics({ contracts, certified: true,
          trial: { originalResult: { retained: 0.6, ...(quality === undefined ? {} : { quality }) } },
          identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition, runId: cell.evidenceRef,
            attempt: 1, harnessCommit: cell.identity.harnessCommit, conditionDigest: cell.identity.conditionDigest,
            originalArtifactRefs: [digestJson(['source', cell.identity])] } }) })
      const physical = f.provider.evaluate
      const referenceCalls: string[] = []
      f.provider.evaluate = async input => {
        if (input.plan.selectionRuleDigest === digestJson('objective-initial-reference-v1'))
          referenceCalls.push(input.idempotencyKey)
        return (await physical(input)).map(cell => measured(cell,
          input.plan.selectionRuleDigest === digestJson('objective-initial-reference-v1') ? undefined
            : cell.outcome.status === 'available' ? cell.outcome.rawValue : 0))
      }
      const request = { evolutionId: 'objective-repair', roundId: 'r', roundIndex: 0, maxCandidates: 1,
        anchor: f.anchor, championRevisionDigest: digestJson('objective-repair-champion'), settings: config }
      const run = () => new Search(store, f.provider, f.diagnosis, f.hooks).run(request, new AbortController().signal)
      let thrown: unknown
      try { await run() } catch (error) { thrown = error }
      const pending = await store.read<{ planDigest: string; resultRefs: string[] }>('rounds/r/pending-evidence')
      expect(thrown).toMatchObject({ name: 'SearchEvidencePending', planDigest: pending?.planDigest })
      expect(pending?.resultRefs).toHaveLength(1)
      const original = await store.object<StageResult>(pending!.resultRefs[0]!)
      expect(original.stagePlanDigest).toBe(pending!.planDigest)
      for (const cell of original.cells) {
        const completed = measured(cell, cell.outcome.status === 'available' ? cell.outcome.rawValue : 0)
        await store.put(completed)
        await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: completed.digest })
      }
      const beforeReferenceCalls = [...referenceCalls]
      store = new MemorySearchStore(store.checkpoint())
      const repaired = await new Search(store, f.provider, f.diagnosis, f.hooks)
        .repairEvaluation('r', 'reference-metrics', original.digest, new AbortController().signal)
      const outcome = await run()
      expect(referenceCalls).toEqual(beforeReferenceCalls)
      compared.push({ pending, repaired, outcome, executions: f.executions })
    }
    expect(compared[1]).toEqual(compared[0])
  })
})
