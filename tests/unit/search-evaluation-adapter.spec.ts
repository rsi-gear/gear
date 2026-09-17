import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvaluationEvidence, EvaluationRequest, HitchTrajectoryReader, HitchVerifierEvidence, RefineEvaluator } from '../../src/types.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { digestJson } from '../../src/state/digest.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { attachSearchEvaluation, EvaluationSearchAdapter } from '../../src/search/evaluation-adapter.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchBudgetExceeded, SearchStore } from '../../src/search/store.js'
import { cellIdentity } from '../../src/search/evidence.js'
import { stagePlan } from '../../src/search/scopes.js'
import { resolveSizing, seal } from '../../src/search/contracts.js'
import { settings, fixtures } from '../helpers/search-fixture.js'
import { evolutionSpec, roundFixture } from '../helpers/research-fixture.js'
import { standardSearchDataset } from '../helpers/standard-search-dataset.js'
import type { Snapshot } from '../../src/search/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(process = true, repetitions = 1, deferred = false) {
  const root = await mkdtemp(join(tmpdir(), 'gear-evaluation-bridge-')); roots.push(root)
  const source = fixtures(100, process), spec = evolutionSpec(), search = settings()
  spec.datasets = { seed: await standardSearchDataset(root, 100, 'seed', process), heldOut: await standardSearchDataset(root, 10, 'held-out', process) }
  spec.rollout.repetitions = repetitions
  const requests: EvaluationRequest[] = [], observations = new Map<string, EvaluationEvidence>(), runs = new Map<string, string>()
  let serial = 0
  let runtime = 'runtime-A'
  const runtimeIdentity = (request: Readonly<EvaluationRequest>, version = runtime) => ({ provider: 'fixture-existing-evaluator', effectiveConfigDigest: digestJson([version, request.condition]) })
  const reservations = new Map<string, string>(), cancelled: string[] = []
  const evaluator: RefineEvaluator & { inspectVerifierEvidence: Function } = {
    evaluationIdentity: (_round, request) => deferred ? undefined : runtimeIdentity(request),
    ...(deferred ? { submittedEvaluationIdentity: async (_round, request, reservation) => ({ ...runtimeIdentity(request, reservations.get(reservation.evalId)!), cohortDigest: digestJson(['execution-policy', reservations.get(reservation.evalId)!]) }),
      cancelReservation: async reservation => { cancelled.push(reservation.evalId) } } satisfies Partial<RefineEvaluator> : {}),
    reserve: async () => { const evalId = `eval-${++serial}`; reservations.set(evalId, runtime); return { provider: 'fixture-existing-evaluator', evalId } },
    async evaluate(_round, request, _signal, reservation) {
      requests.push(request)
      const manifest = JSON.parse(await readFile(join(request.dataset, 'benchmark.adapter.json'), 'utf8'))
      const trials = manifest.tasks.map((t: { task_id: string }) => {
        const runId = `${reservation!.evalId}-${t.task_id}`; runs.set(runId, t.task_id)
        const score = request.harnessRef === source.anchor.commit ? Number(t.task_id.slice(5)) % 5 === 0 ? 1 : 0.3 : 1
        return { taskName: t.task_id, runId, trialName: runId, attempt: 1, status: 'completed' as const, rewards: { reward: score }, scores: { totalScore: score, ...(process ? { processScore: score } : {}), normalization: 'standard' as const } }
      })
      const score = trials.reduce((sum: number, t: typeof trials[number]) => sum + t.scores.totalScore, 0) / trials.length
      const evidence: EvaluationEvidence = { ...runtimeIdentity(request, deferred ? reservations.get(reservation!.evalId)! : runtime), evalId: reservation!.evalId, conditionId: request.condition.conditionId, dataset: request.dataset,
        requestedCommit: request.harnessRef, actualCommit: request.harnessRef, revisionIdentity: request.harnessRef, completeness: 'complete', plannedTrialCount: trials.length,
        primaryReward: score, summary: { total: trials.length, passed: trials.length, failed: 0, score }, trials, invalidTrials: [] }
      observations.set(evidence.evalId, evidence); return evidence
    },
    inspectResult: async (_round, _request, reservation) => observations.has(reservation.evalId) ? { status: 'complete', evidence: observations.get(reservation.evalId)! } : { status: 'running' },
    inspectVerifierEvidence: async (runId: string) => ({ runId, observation: { status: 'valid' }, verifier: { status: 'complete', feedback: { schemaVersion: 1,
      items: [{ code: `workflow-${Number(runs.get(runId)!.slice(5)) % 4}`, severity: 'error', message: 'Failed the fixture workflow' }] } } }),
  }
  const store = new SearchStore(join(root, 'search')), options = { spec, workspaceRoot: root, stateRoot: store.root, identityRound: roundFixture({ workspaceRoot: root }),
    round: async () => roundFixture({ workspaceRoot: root }), manifest: async (snapshot: Snapshot) => ({ schemaVersion: 1 as const, dshBaseRef: source.anchor.commit, toolchainRef: 'fixture', sandboxProfileRef: 'fixture', digest: snapshot.manifestDigest,
      artifacts: [{ path: 'harness/main.ts', bytes: 1, digest: digestJson('file') }] }) }
  const provider = new EvaluationSearchAdapter(evaluator, options)
  const run = () => new FailureClusterSearch(store, provider, provider.diagnosis, source.hooks).run({ evolutionId: spec.evolutionId, roundId: 'r', roundIndex: 0, maxCandidates: 4,
    anchor: source.anchor, championRevisionDigest: digestJson('champion'), settings: search }, new AbortController().signal)
  return { root, spec, source, requests, evaluator, provider, options, store, run, observations, search, reservations, cancelled, changeRuntime: () => { runtime = 'runtime-B' } }
}

describe('Gear-owned staging through the existing evaluation interface', () => {
  it('resolves projected verifier runs after restart, including physical attempt 1 for the second repetition', async () => {
    const f = await setup(false, 2), universe = await f.provider.describe('seed'), signal = new AbortController().signal
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: universe.digest,
      taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'],
      participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const cells = await f.provider.evaluate({ plan, snapshot: f.source.anchor,
      cells: [0, 1].map(index => cellIdentity(universe, 'task-1', index, f.source.anchor)),
      idempotencyKey: digestJson('verifier-repetitions'), signal })
    const result = seal({ stagePlanDigest: plan.digest, snapshotDigest: f.source.anchor.digest, cells, settled: true })
    await f.store.put(plan); await f.store.put(result)
    const cell = cells[1]!, runId = cell.evidenceRef
    const physical = { evalId: 'eval-2', trialId: runId, attempt: 1 }
    const actual: HitchVerifierEvidence = { runId, parent: physical, verifier: { status: 'complete' } }
    f.evaluator.inspectVerifierEvidence = async () => actual
    const reader = attachSearchEvaluation(f.evaluator, f.options) as unknown as HitchTrajectoryReader
    expect(await reader.resolveVerifierRun!(result.digest, runId, signal)).toEqual({ evalId: 'eval-2', trialName: runId, attempt: 1 })
    const capabilities = new RefineCapabilities({} as never, {} as never, { trajectoryReader: reader })
    const load = (evalId = result.digest) => (capabilities as unknown as {
      loadVerifierEvidence(item: unknown, signal: AbortSignal): Promise<HitchVerifierEvidence>
    }).loadVerifierEvidence({ evalId, trial: { runId, attempt: 2 } }, signal)
    expect(await load()).toEqual(actual)
    expect((await load(digestJson('unknown-projection'))).verifier.status).toBe('corrupt')
    await expect(reader.resolveVerifierRun!(result.digest, 'foreign-run', signal)).rejects.toThrow('not uniquely bound')
    for (const patch of [{ evalId: 'foreign-eval' }, { trialId: 'foreign-trial' }, { attempt: 2 }]) {
      actual.parent = { ...physical, ...patch }
      expect((await load()).verifier.status).toBe('corrupt')
    }
    const { digest: ignored, ...planBody } = plan
    const heldOut = seal({ ...planBody, partition: 'held-out' as const })
    const heldOutResult = seal({ stagePlanDigest: heldOut.digest, snapshotDigest: f.source.anchor.digest, cells, settled: true })
    await f.store.put(heldOut); await f.store.put(heldOutResult)
    await expect(reader.resolveVerifierRun!(heldOutResult.digest, runId, signal)).rejects.toThrow('requires seed evidence')
    expect(f.requests).toHaveLength(2)
  })

  it.each(['restart', 'same-adapter'])('rejects old cells and new batches after runtime configuration changes (%s)', async mode => {
    const f = await setup(false), universe = await f.provider.describe('seed')
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: universe.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const input = { plan, snapshot: f.source.anchor, cells: [cellIdentity(universe, 'task-1', 0, f.source.anchor)], idempotencyKey: digestJson('runtime-test'), signal: new AbortController().signal }
    const [cell] = await f.provider.evaluate(input)
    expect(await f.provider.verifyCell(cell!, input.cells[0]!)).toBe(true)
    f.changeRuntime()
    const provider = mode === 'restart' ? new EvaluationSearchAdapter(f.evaluator, f.options) : f.provider
    await expect(provider.describe('seed')).rejects.toThrow('runtime configuration changed')
    await expect(provider.verifyCell(cell!, input.cells[0]!)).rejects.toThrow('runtime configuration changed')
    await expect(provider.evaluate({ ...input, idempotencyKey: digestJson('next-batch') })).rejects.toThrow('runtime configuration changed')
    await expect(provider.inspectEvaluation(input)).rejects.toThrow('runtime configuration changed')
    expect(f.requests).toHaveLength(1)
  })

  it.each(['seed', 'held-out'] as const)('cancels a deferred batch with changed execution policy before accepting its %s evidence', async partition => {
    const f = await setup(false, 1, true), seed = await f.provider.describe('seed')
    const input = (universe: typeof seed, key: string) => {
      const plan = stagePlan({ stage: universe.partition === 'seed' ? 'local' : 'held-out', partition: universe.partition,
        universeDigest: universe.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'),
        taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
      return { plan, snapshot: f.source.anchor, cells: [cellIdentity(universe, 'task-1', 0, f.source.anchor)], idempotencyKey: digestJson(key), signal: new AbortController().signal }
    }
    const originalInput = input(seed, 'original'), [original] = await f.provider.evaluate(originalInput)
    f.changeRuntime()
    const restarted = new EvaluationSearchAdapter(f.evaluator, f.options)
    // The original A submission remains valid; it cannot authorize any new B submission.
    expect(await restarted.verifyCell(original!, originalInput.cells[0]!)).toBe(true)
    const next = input(await restarted.describe(partition), 'changed-submission')
    await expect(restarted.evaluate(next)).rejects.toThrow('runtime cohort changed')
    await expect(restarted.inspectEvaluation(next)).rejects.toThrow('runtime cohort changed')
    expect(f.requests).toHaveLength(1)
    expect(f.reservations.size).toBe(2)
    expect(f.cancelled).toEqual(['eval-2'])
  })

  it('rejects unresolved runtime identity before admission and after evidence has been collected', async () => {
    const f = await setup(false), identity = f.evaluator.evaluationIdentity
    f.evaluator.evaluationIdentity = () => undefined
    await expect(f.provider.describe('seed')).rejects.toThrow('resolvable evaluation runtime identity')
    expect(f.requests).toHaveLength(0)
    f.evaluator.evaluationIdentity = identity!
    await f.provider.describe('seed')
    f.evaluator.evaluationIdentity = () => undefined
    await expect(new EvaluationSearchAdapter(f.evaluator, f.options).describe('seed')).rejects.toThrow('resolvable evaluation runtime identity')
  })
  it.each([{ process: false, deferred: false }, { process: true, deferred: false }, { process: false, deferred: true }, { process: true, deferred: true }])('runs 4→2→1 with verified execution identities (process=$process, deferred=$deferred)', async ({ process, deferred }) => {
    const f = await setup(process, 1, deferred), result = await f.run()
    expect(f.evaluator.search).toBeUndefined()
    expect(result.championChanged, JSON.stringify({ reasons: result.reasonCodes, candidates: result.research.candidates, promotion: result.promotion })).toBe(true)
    expect(result.research.workplans).toHaveLength(4)
    const candidateSeed = f.requests.filter(r => r.harnessRef !== f.source.anchor.commit && r.phase === 'seed-candidate')
    expect(candidateSeed).toHaveLength(7)
    expect(candidateSeed.map(r => r.condition.repetitions)).toEqual(Array(7).fill(1))
    const counts = await Promise.all(candidateSeed.map(async r => JSON.parse(await readFile(join(r.dataset, 'benchmark.adapter.json'), 'utf8')).tasks.length))
    expect(counts).toEqual([15, 15, 15, 15, 25, 25, 60])
    expect(await digestDatasetRef(f.spec.datasets.seed.ref)).toBe(f.spec.datasets.seed.digest)
    expect(await digestDatasetRef(f.spec.datasets.heldOut.ref)).toBe(f.spec.datasets.heldOut.digest)
    const count = f.requests.length
    expect(await f.run()).toEqual(result); expect(f.requests).toHaveLength(count)
  })

  it.each([false, true])('recovers a lost result through a read-only lookup without a second evaluation or timestamp change (deferred=%s)', async deferred => {
    const f = await setup(true, 1, deferred), evaluate = f.evaluator.evaluate
    let first = true
    f.evaluator.evaluate = async (...args) => { const result = await evaluate(...args); if (first) { first = false; throw new Error('lost response') } return result }
    const u = await f.provider.describe('seed'), plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: u.digest, taskSetSizeResolutionDigest: resolveSizing(u, f.search.search.taskSetSizing).digest,
      scopeDigest: digestJson('scope'), taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const input = { plan, snapshot: f.source.anchor, cells: [cellIdentity(u, 'task-1', 0, f.source.anchor)], idempotencyKey: digestJson('operation'), signal: new AbortController().signal }
    await expect(f.provider.evaluate(input)).rejects.toThrow('lost response')
    const recovered = new EvaluationSearchAdapter(f.evaluator, f.options)
    const firstResult = await recovered.inspectEvaluation(input)
    expect(firstResult.status).toBe('complete')
    expect(await recovered.inspectEvaluation(input)).toEqual(firstResult)
    expect(f.requests).toHaveLength(1)
    if (firstResult.status === 'complete') expect(await recovered.verifyCell(firstResult.result.cells[0]!, input.cells[0]!)).toBe(true)
  })

  it('preserves uncontrolled repetition identities and reads partial results after a verified deadline', async () => {
    const f = await setup(false, 2), u = await f.provider.describe('seed')
    expect(u.repetitions).toEqual([{ index: 0, seed: null }, { index: 1, seed: null }])
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: u.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const controller = new AbortController(), evaluate = f.evaluator.evaluate
    f.evaluator.evaluate = async (...args) => { const result = await evaluate(...args); controller.abort(new SearchBudgetExceeded('time')); return result }
    const input = { plan, snapshot: f.source.anchor, cells: [0, 1].map(index => cellIdentity(u, 'task-1', index, f.source.anchor)), idempotencyKey: digestJson('two-repetitions'), signal: controller.signal }
    await expect(f.provider.evaluate(input)).rejects.toThrow('time')
    const recovered = await new EvaluationSearchAdapter(f.evaluator, f.options).inspectEvaluation({ ...input, signal: new AbortController().signal })
    expect(recovered).toMatchObject({ status: 'complete', result: { failure: { kind: 'budget-exhausted' }, cells: [{ identity: { repetition: 0, seed: null } }] } })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.condition.seeds).toBeUndefined()
  })

  it('does not repeat an uncertain submission when the evaluator has no reservation recovery', async () => {
    const f = await setup(), u = await f.provider.describe('seed'), reserve = f.evaluator.reserve!
    let submissions = 0
    f.evaluator.reserve = async (...args) => { submissions++; await reserve(...args); throw new Error('lost submission response') }
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: u.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const input = { plan, snapshot: f.source.anchor, cells: [cellIdentity(u, 'task-1', 0, f.source.anchor)], idempotencyKey: digestJson('uncertain-submit'), signal: new AbortController().signal }
    await expect(f.provider.evaluate(input)).rejects.toThrow('lost submission response')
    const recovered = new EvaluationSearchAdapter(f.evaluator, f.options)
    await expect(recovered.evaluate(input)).rejects.toThrow('unknown')
    expect(await recovered.inspectEvaluation(input)).toMatchObject({ status: 'unknown' })
    expect(submissions).toBe(1); expect(f.requests).toHaveLength(0)
  })

  it('leaves outcome-only failures unresolved when verifier artifacts contain no failure evidence', async () => {
    const f = await setup(false)
    f.evaluator.inspectVerifierEvidence = async (runId: string) => ({ runId, verifier: { status: 'missing' } })
    const result = await f.run()
    expect(result.research.workplans).toEqual([])
    expect(result.championChanged).toBe(false)
    expect(f.requests.every(r => r.harnessRef === f.source.anchor.commit)).toBe(true)
  })

  it('refuses changed source bytes before creating a subset or invoking the evaluator', async () => {
    const f = await setup(), u = await f.provider.describe('seed')
    await writeFile(join(f.spec.datasets.seed.ref, 'task-1', 'instruction.md'), 'changed')
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: u.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'], participantIds: [f.source.anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    await expect(f.provider.evaluate({ plan, snapshot: f.source.anchor, cells: [cellIdentity(u, 'task-1', 0, f.source.anchor)], idempotencyKey: digestJson('changed'), signal: new AbortController().signal })).rejects.toThrow('source dataset changed')
    expect(f.requests).toEqual([])
  })
})
