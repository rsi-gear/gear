import { describe, expect, it } from 'vitest'
import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'
import { completeArchivedEvidence } from '../../src/search/completion.js'
import { FailureClusterSearch, SearchEvidencePending } from '../../src/search/engine.js'
import { assertConsistentCells, cellKey, profile } from '../../src/search/evidence.js'
import { MemorySearchStore, evaluatedFixture, fixtures, revise, scopeFixture, settings } from '../../src/search/testing.js'
import type { EvidenceCell, StageEvaluationPlan, StageResult, TaskUniverse } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const contracts = ['quality', 'retained'].map(id => resolveMetric({ id, revision: '1', unit: 'score', direction: 'maximize',
  source: { path: `originalResult.${id}`, extractor: 'number-v1' }, granularity: 'trial', repetitionReducer: 'mean',
  taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
const objective = resolveObjective({ terms: [{ metric: 'quality', weight: 1 }] }, contracts)
function measured(cell: EvidenceCell, quality?: number): EvidenceCell {
  return revise(cell, { rawMetrics: extractRawMetrics({ contracts, certified: true,
    trial: { originalResult: { retained: .25, ...(quality === undefined ? {} : { quality }) } },
    identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition, runId: cell.evidenceRef, attempt: 1,
      harnessCommit: cell.identity.harnessCommit, conditionDigest: cell.identity.conditionDigest,
      originalArtifactRefs: [digestJson(['source', cell.identity])] } }) })
}
function setup(process = false) {
  const f = fixtures(20, process), store = new MemorySearchStore(), config = settings()
  const cohort = (u: TaskUniverse) => revise(u, { rawMetricContracts: contracts, objective })
  const seed = cohort(f.seed), heldOut = cohort(f.heldOut), evaluate = f.provider.evaluate
  f.provider.capabilities.objectives = 1
  f.provider.describe = async partition => partition === 'seed' ? seed : heldOut
  f.provider.evaluate = async input => (await evaluate(input)).map(cell => measured(cell,
    cell.outcome.status === 'available' ? cell.outcome.rawValue : undefined))
  const cache = async (cell: EvidenceCell) => {
    await store.put(cell)
    await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
  }
  const complete = async (plan: StageEvaluationPlan, original: StageResult, id = 'metrics') => {
    const completion = await completeArchivedEvidence({ id, store, provider: f.provider, universe: seed, plan,
      snapshot: f.anchor, original, settings: config, signal: new AbortController().signal })
    return store.object<StageResult>(completion.completedResultDigest)
  }
  return { ...f, seed, heldOut, store, config, cache, complete }
}
function archived(process: 'undeclared' | 'available' | 'missing' = 'undeclared') {
  const f = setup(process !== 'undeclared'), scope = scopeFixture(f.seed, ['task-0'])
  const row = evaluatedFixture(f.seed, scope, f.anchor, () => ({ outcome: 1, ...(process === 'available' ? { process: .5 } : {}) }))
  const old = measured(row.result.cells[0]!), newer = measured(old, 1)
  return { ...f, plan: row.plan, original: revise(row.result, { cells: [old] }), old, newer }
}

describe('raw metric evidence recovery', () => {
  it.each(['undeclared', 'available', 'missing'] as const)('imports cached metrics with %s process evidence without a rollout', async process => {
    const f = archived(process)
    expect(profile(f.seed, f.plan, f.anchor, f.original, 'auto').objectiveScore?.score).toBeUndefined()
    assertConsistentCells(f.old, f.newer)
    await f.cache(f.newer)
    const completed = await f.complete(f.plan, f.original)
    expect(profile(f.seed, f.plan, f.anchor, completed, 'auto').objectiveScore?.score).toBe(1)
    expect(completed.cells).toEqual([f.newer])
    expect(completed.cells[0]!.identity).toEqual(f.old.identity)
    expect(completed.cells[0]!.outcome).toEqual(f.old.outcome)
    expect(completed.cells[0]!.process).toEqual(f.old.process)
    expect(completed.cells[0]!.rawMetrics!.metrics.retained).toEqual(f.old.rawMetrics!.metrics.retained)
    expect(await f.complete(f.plan, f.original)).toEqual(completed)
    expect((await f.complete(f.plan, completed, 'no-change')).digest).toBe(completed.digest)
    expect(f.executions).toHaveLength(0)
  })

  it.each(['absent-record', 'absent-metric', 'invalid-metric'] as const)('recovers an %s from cached original evidence', async state => {
    const f = archived()
    const { rawMetrics, digest: ignored, ...body } = f.old
    const old = state === 'absent-record' ? { ...body, digest: digestJson(body) }
      : revise(f.old, { rawMetrics: revise(rawMetrics!, { metrics: {
        retained: rawMetrics!.metrics.retained!,
        ...(state === 'invalid-metric' ? { quality: { ...rawMetrics!.metrics.quality!, status: 'invalid' as const } } : {}),
      } }) })
    await f.cache(f.newer)
    const completed = await f.complete(f.plan, revise(f.original, { cells: [old] }))
    expect(profile(f.seed, f.plan, f.anchor, completed, 'auto').objectiveScore?.score).toBe(1)
    expect(f.executions).toHaveLength(0)
  })

  it('does not create a revision or rerun a valid slot when the cache adds no metric', async () => {
    const f = archived()
    await f.cache(f.old)
    expect((await f.complete(f.plan, f.original)).digest).toBe(f.original.digest)
    expect(f.executions).toHaveLength(0)
  })

  it('ignores an older cached view when the current raw metrics are already complete', async () => {
    const f = archived(), original = revise(f.original, { cells: [f.newer] })
    await f.cache(f.old)
    expect((await f.complete(f.plan, original)).digest).toBe(original.digest)
    expect(f.executions).toHaveLength(0)
  })

  it.each(['raw-value', 'execution-slot', 'process-value'] as const)('rejects a cached completion that changes an existing %s', async change => {
    const f = archived('available'), raw = f.newer.rawMetrics!
    const newer = change === 'process-value'
      ? revise(f.newer, { process: { ...f.newer.process!, status: 'available', rawValue: .75,
        contractDigest: f.newer.identity.processContractDigest!, evidenceRef: f.newer.evidenceRef } })
      : revise(f.newer, { rawMetrics: revise(raw, change === 'execution-slot' ? { attempt: 2 }
        : { metrics: { ...raw.metrics, retained: { ...raw.metrics.retained!, value: .75 } } }) })
    await f.cache(newer)
    await expect(f.complete(f.plan, f.original)).rejects.toThrow(/cannot replace valid|changed its execution slot/)
    expect(f.executions).toHaveLength(0)
  })

  it.each([false, true])('repairs a pending round from cached raw metrics and resumes without more rollouts (process=%s)', async process => {
    const f = setup(process), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => (await evaluate(input)).map(cell =>
      input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor' ? measured(cell) : cell)
    const engine = new FailureClusterSearch(f.store, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'raw-recovery', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: f.config }
    const run = () => engine.run(request, new AbortController().signal)
    await expect(run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const pending = (await f.store.read<{ resultRefs: string[] }>('rounds/r/pending-evidence'))!
    const original = await f.store.object<StageResult>(pending.resultRefs[1]!)
    for (const cell of original.cells) await f.cache(measured(cell, 1))
    const count = f.executions.length
    const completed = await engine.repairEvaluation('r', 'metrics', original.digest, new AbortController().signal)
    expect(completed.cells.every(cell => cell.rawMetrics?.metrics.quality?.value === 1)).toBe(true)
    expect(completed.cells.map(cell => cell.identity)).toEqual(original.cells.map(cell => cell.identity))
    expect(completed.cells.map(cell => cell.outcome)).toEqual(original.cells.map(cell => cell.outcome))
    expect((await run()).championChanged).toBe(true)
    expect(f.executions).toHaveLength(count)
  })
})
