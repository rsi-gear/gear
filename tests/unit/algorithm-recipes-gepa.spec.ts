import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlgorithmRuntime, BindingStore, FileArtifactStore } from '../../src/algorithm/index.js'
import type { BindingSchema, CampaignSpec } from '../../src/algorithm/contracts.js'
import { GepaDiagnosisProvider, GepaEvaluationProvider, GepaGenerationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { createGepaRound, nextGepaRound } from '../../src/algorithm/recipes/gepa-round.js'
import { chooseGepaParents } from '../../src/algorithm/recipes/gepa-policy.js'
import { buildArchive } from '../../src/search/archive.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { cellKey } from '../../src/search/evidence.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import { resolveParentPolicyRef, scopedFrontierPolicy } from '../../src/search/policies/parents.js'
import { evaluatedFixture, fixtures, scopeFixture, settings } from '../helpers/search-fixture.js'
import { digestJson } from '../../src/state/digest.js'
import { seal } from '../../src/search/contracts.js'
import { jsonDigest } from '../../src/algorithm/schema.js'
import type { CandidateWorkPlan } from '../../src/search/types.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const schema: BindingSchema = { id: 'gepa-harness.v1', slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } }
function setup(maxCandidates = 2, periodic = false) {
  const root = mkdtempSync(join(tmpdir(), 'gear-algorithm-gepa-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, schema)
  const fixture = fixtures(20)
  const config = settings()
  if (periodic) config.search.scopeSampling = { ...config.search.scopeSampling,
    epochPolicy: 'periodic', updateEveryRounds: 1 }
  const scope = scopeFixture(fixture.seed, fixture.seed.tasks.map(task => task.id), 'bootstrap', 0)
  const baseline = evaluatedFixture(fixture.seed, scope, fixture.anchor,
    id => ({ outcome: Number(id.slice(5)) >= 16 ? 1 : 0 }), { stage: 'baseline-probe' })
  const archive = buildArchive({ evolutionId: 'algorithm-gepa-fixture', universe: fixture.seed, snapshots: [fixture.anchor],
    scopes: [scope], plans: [baseline.plan], results: [baseline.result], config: config.search,
    championId: fixture.anchor.candidateId })
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const initialBindingSetRef = bindings.create({ harness })
  const options = { evolutionId: 'algorithm-gepa-fixture', roundId: 'r', roundIndex: 0, maxCandidates,
    anchor: fixture.anchor, seed: fixture.seed, heldOut: fixture.heldOut, archive, settings: config,
    bindingSchema: schema, snapshotBindings: { [fixture.anchor.digest]: initialBindingSetRef },
    artifacts, deadlineAt: 2_000_000_000_000 }
  const budget: CampaignSpec['budget'] = {
    rolloutCells: { unit: 'cell', limit: 10000, source: 'gepa.evaluate', capability: 'stop' },
    repairCells: { unit: 'cell', limit: 20, source: 'gepa.evaluate', capability: 'stop' },
    diagnosisInputTokens: { unit: 'token', limit: 100000, source: 'gepa.diagnose', capability: 'stop' },
    diagnosisOutputTokens: { unit: 'token', limit: 20000, source: 'gepa.diagnose', capability: 'stop' },
    generationTokens: { unit: 'token', limit: 10000, source: 'gepa.generate', capability: 'stop' },
    generationRequests: { unit: 'request', limit: 100, source: 'gepa.generate', capability: 'stop' },
  }
  const firstRound = createGepaRound({ campaignId: 'gepa-fixture', options, evolutionBudget: budget })
  const { spec } = firstRound, recipe = firstRound.algorithm
  const providers = [new GepaEvaluationProvider(join(root, 'providers'), artifacts, bindings, fixture.provider, archive),
    new GepaDiagnosisProvider(join(root, 'providers'), artifacts, bindings, fixture.diagnosis),
    new GepaGenerationProvider(join(root, 'providers'), artifacts, bindings, fixture.hooks, digestJson('fixture-hooks').slice(7))]
  return { root, artifacts, bindings, fixture, config, archive, options, spec, recipe, providers }
}

describe('common-operation failure-cluster GEPA', () => {
  it('draws exactly the old validated parent plan before any operation', () => {
    const f = setup()
    const policy = scopedFrontierPolicy(resolveParentPolicyRef(f.config.search))
    const expected = chooseGepaParents(f.archive, policy, 'r', 2, f.config.search.seed, f.fixture.anchor.candidateId)
    const decision = f.recipe.initialize({ campaignId: f.spec.campaignId, decisionIndex: 0,
      activeBindingSetRef: f.spec.initialBindingSetRef, config: {} })
    if (decision instanceof Promise) throw new Error('parent selection unexpectedly async')
    const actual = decision.nextState as unknown as { parents: typeof expected }
    expect(actual.parents).toEqual(expected)
    expect(decision.operations?.map(operation => operation.kind)).toEqual(['gepa.evaluate'])
  })

  it('prepares the second periodic epoch from the first round archive with a carried budget', async () => {
    const f = setup(2, true)
    const first = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await first.runUntilBlocked(50)).toBe('complete')
    const previous = first.snapshot()!
    const state = previous.state as unknown as { archiveRef: { kind: 'artifact'; digest: string; size: number; mediaType: string; schemaId?: string };
      snapshotBindings: typeof f.options.snapshotBindings; finalGate: { outcome: string } }
    const archive = f.artifacts.getJson(state.archiveRef) as unknown as typeof f.archive
    expect(archive.scopes.some(scope => scope.familyId !== 'bootstrap')).toBe(true)
    const secondRoot = join(f.root, 'round2')
    cpSync(join(f.root, 'artifacts'), join(secondRoot, 'artifacts'), { recursive: true })
    const artifacts = new FileArtifactStore(join(secondRoot, 'artifacts'))
    const bindings = new BindingStore(artifacts, schema)
    const secondRound = nextGepaRound(previous, artifacts,
      { campaignId: 'gepa-fixture-round2', roundId: 'r2', deadlineAt: 2_000_000_100_000 })
    expect(secondRound.options.archive.digest).toBe(archive.digest)
    expect(secondRound.options.anchor.digest).toBe(archive.snapshots.find(snapshot =>
      state.snapshotBindings[snapshot.digest]?.digest === previous.activeBindingSetRef.digest)?.digest)
    expect(secondRound.spec.budget.rolloutCells!.limit).toBe(Math.min(
      f.spec.budget.rolloutCells!.limit - previous.spent.rolloutCells!, f.config.budgets.round.maxNewRolloutCells))
    const providers = [new GepaEvaluationProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.provider, archive),
      new GepaDiagnosisProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.diagnosis),
      new GepaGenerationProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.hooks, digestJson('fixture-hooks').slice(7))]
    const second = new AlgorithmRuntime(secondRoot, secondRound.algorithm, providers, secondRound.spec)
    await second.tick()
    const initial = second.snapshot()!.state as unknown as { scopePlan: { base: { epoch: number };
      pending: Array<{ participants: unknown[]; scope: { taskIds: string[] } }>; decisions: unknown[] };
      queuedOperations: unknown[] }
    expect(initial.scopePlan.base.epoch).toBe(2)
    expect(initial.scopePlan.pending.length + initial.scopePlan.decisions.length).toBeGreaterThan(0)
    expect(Object.keys(second.snapshot()!.operations)).toHaveLength(1)
    if (initial.scopePlan.pending.length > 1) {
      expect(initial.queuedOperations.length).toBeGreaterThan(0)
      expect(initial.scopePlan.pending[0]!.scope.taskIds.some(id =>
        initial.scopePlan.pending[1]!.scope.taskIds.includes(id))).toBe(true)
    }
    expect(await second.runUntilBlocked(50)).toBe('complete')
    const final = second.snapshot()!.state as unknown as { preparation: { digest: string; epoch: number; decisions: unknown[] } }
    expect(final.preparation.epoch).toBe(2)
    expect(final.preparation.decisions.length).toBeGreaterThan(0)
    const oldFixture = fixtures(20)
    const oldStore = new MemorySearchStore()
    await oldStore.casArchive(undefined, archive)
    for (const result of archive.results) for (const cell of result.cells) {
      await oldStore.put(cell)
      await oldStore.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
    }
    const old = await new FailureClusterSearch(oldStore, oldFixture.provider, oldFixture.diagnosis, oldFixture.hooks).run({
      evolutionId: f.options.evolutionId, roundId: 'r2', roundIndex: 1, maxCandidates: 2,
      anchor: secondRound.options.anchor, championRevisionDigest: digestJson('revision'),
      settings: f.config }, new AbortController().signal)
    expect(final.preparation).toEqual(old.research.scopePreparation)
  })

  it('reuses the first frozen shared-task draw throughout a stable epoch', async () => {
    const f = setup()
    const first = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await first.runUntilBlocked(100)).toBe('complete')
    const previous = first.snapshot()!
    const firstState = previous.state as unknown as { archiveRef: { kind: 'artifact'; digest: string; size: number; mediaType: string; schemaId?: string };
      sharedEpochs: Record<string, { epoch: number; archiveCutoffDigest: string; parentSnapshotDigest: string; taskIds: string[] }> }
    const archive = f.artifacts.getJson(firstState.archiveRef) as unknown as typeof f.archive
    const secondRoot = join(f.root, 'stable-round2')
    cpSync(join(f.root, 'artifacts'), join(secondRoot, 'artifacts'), { recursive: true })
    const artifacts = new FileArtifactStore(join(secondRoot, 'artifacts'))
    const bindings = new BindingStore(artifacts, schema)
    const next = nextGepaRound(previous, artifacts,
      { campaignId: 'stable-round2', roundId: 'r2', deadlineAt: 2_000_000_100_000 })
    const providers = [new GepaEvaluationProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.provider, archive),
      new GepaDiagnosisProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.diagnosis),
      new GepaGenerationProvider(join(secondRoot, 'providers'), artifacts, bindings, f.fixture.hooks, digestJson('fixture-hooks').slice(7))]
    const second = new AlgorithmRuntime(secondRoot, next.algorithm, providers, next.spec)
    await second.tick()
    const modern = (second.snapshot()!.state as unknown as { preparation: { digest: string; epoch: number; sharedTaskIds: string[] } }).preparation
    expect(modern.epoch).toBe(1)
    expect(modern.sharedTaskIds).toEqual(firstState.sharedEpochs['1']!.taskIds)
    const oldFixture = fixtures(20), oldStore = new MemorySearchStore()
    await oldStore.casArchive(undefined, archive)
    for (const result of archive.results) for (const cell of result.cells) {
      await oldStore.put(cell)
      await oldStore.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
    }
    await oldStore.freezeEvolution('shared-epoch-1', () => seal(firstState.sharedEpochs['1']!))
    const old = await new FailureClusterSearch(oldStore, oldFixture.provider, oldFixture.diagnosis, oldFixture.hooks).run({
      evolutionId: f.options.evolutionId, roundId: 'r2', roundIndex: 1, maxCandidates: 2,
      anchor: next.options.anchor, championRevisionDigest: digestJson('revision'),
      settings: f.config }, new AbortController().signal)
    expect(modern).toEqual(old.research.scopePreparation)
  })

  it('runs physical old-provider adapters under common operations and recovers the same parent draw', async () => {
    const f = setup()
    const runtime = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    const status = await runtime.runUntilBlocked(50)
    expect(status).toBe('complete')
    const state = runtime.snapshot()!.state as unknown as { phase: string; parents: { digest: string }; archiveRef: { digest: string };
      works: unknown[]; finalGate: { outcome: string } | null }
    expect(state.phase).toBe('done')
    expect(state.archiveRef.digest).toBeTruthy()
    expect(state.works).toHaveLength(2)
    expect(f.fixture.generated).toHaveLength(2)
    expect(state.finalGate?.outcome).toBe('accepted')
    expect(runtime.snapshot()!.activeBindingSetRef.digest).not.toBe(f.spec.initialBindingSetRef.digest)
    expect(f.fixture.executions.length).toBeGreaterThan(0)
    const restarted = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await restarted.runUntilBlocked(5)).toBe('complete')
    expect(restarted.snapshot()!.state).toEqual(runtime.snapshot()!.state)
  })

  it('matches old-engine parent, workplans and bridge decisions for two candidates', async () => {
    const f = setup()
    const modern = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await modern.runUntilBlocked(50)).toBe('complete')
    const modernState = modern.snapshot()!.state as unknown as {
      parents: { digest: string }; works: Array<{ workplan: CandidateWorkPlan }>;
      bridge: { plan?: { digest: string }; skipped: string[]; exclusions: unknown[] }; finalGate?: { outcome: string }
    }
    const oldFixture = fixtures(20)
    const store = new MemorySearchStore()
    await store.casArchive(undefined, f.archive)
    for (const result of f.archive.results) for (const cell of result.cells) {
      await store.put(cell)
      await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
    }
    const old = await new FailureClusterSearch(store, oldFixture.provider, oldFixture.diagnosis, oldFixture.hooks).run({
      evolutionId: f.options.evolutionId, roundId: f.options.roundId, roundIndex: 0,
      maxCandidates: 2, anchor: oldFixture.anchor, championRevisionDigest: digestJson('revision'),
      settings: f.config }, new AbortController().signal)
    expect(modernState.parents.digest).toBe(old.research.parents.digest)
    const withoutClock = (workplan: CandidateWorkPlan) => {
      const { digest: ignoredDigest, generationBudget, ...body } = workplan
      const { deadlineAt: ignoredDeadline, ...budget } = generationBudget
      return { ...body, generationBudget: budget }
    }
    expect(modernState.works.map(item => withoutClock(item.workplan)))
      .toEqual(old.research.workplans.map(withoutClock))
    expect(modernState.bridge?.plan?.digest).toBe(old.research.bridge.plan?.digest)
    expect(modernState.bridge?.skipped).toEqual(old.research.bridge.skipped)
    expect(modernState.finalGate?.outcome).toBe(old.promotion?.outcome)
  })

  it('rejects a scientific snapshot paired with a different execution binding', async () => {
    const f = setup()
    const decision = f.recipe.initialize({ campaignId: f.spec.campaignId, decisionIndex: 0,
      activeBindingSetRef: f.spec.initialBindingSetRef, config: f.spec.config })
    if (decision instanceof Promise) throw new Error('unexpected asynchronous initialization')
    const intent = decision.operations![0]!
    const wrongHarness = f.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: 'different-commit',
      manifestDigest: f.fixture.anchor.manifestDigest }, 'harness.directory.v1')
    const wrongBinding = f.bindings.create({ harness: wrongHarness })
    const operationId = digestJson('forged-gepa-binding').slice(7)
    await expect(f.providers[0]!.preflight({ operationId, idempotencyKey: operationId,
      campaignId: f.spec.campaignId, decisionIndex: 0, localKey: intent.localKey, kind: intent.kind,
      input: intent.input, inputDigest: jsonDigest(intent.input),
      implementationDigest: f.providers[0]!.describe().implementationDigest,
      bindingSetRef: wrongBinding, limits: intent.limits ?? {} })).rejects.toThrow(/binding\/snapshot mismatch/)
  })

  it('does not execute a missing rollout when the frozen remaining cell budget is zero', async () => {
    const f = setup()
    const limited = createGepaRound({ campaignId: 'gepa-zero-rollout', options: f.options,
      evolutionBudget: { ...f.spec.budget, rolloutCells: { ...f.spec.budget.rolloutCells!, limit: 0 } } })
    const runtime = new AlgorithmRuntime(f.root, limited.algorithm, f.providers, limited.spec)
    expect(await runtime.runUntilBlocked(50)).toBe('complete')
    expect(f.fixture.executions).toHaveLength(0)
    expect(runtime.snapshot()!.activeBindingSetRef).toEqual(limited.spec.initialBindingSetRef)
    const state = runtime.snapshot()!.state as unknown as { reasons: string[] }
    expect(state.reasons.some(reason => /budget|unavailable/.test(reason))).toBe(true)
  })

  it('leaves an uncertain original-key effect pending and recovers without resubmission', async () => {
    const f = setup()
    const evaluate = f.fixture.provider.evaluate
    const inspect = f.fixture.provider.inspectEvaluation!
    let lost = false
    f.fixture.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (!lost) { lost = true; throw new Error('response lost after durable physical effect') }
      return cells
    }
    f.fixture.provider.inspectEvaluation = async () => ({ status: 'not-started' })
    const runtime = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await runtime.runUntilBlocked(50)).toBe('waiting')
    expect(lost).toBe(true)
    const before = [...f.fixture.executions]
    const restarted = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    expect(await restarted.runUntilBlocked(5)).toBe('waiting')
    expect(f.fixture.executions).toEqual(before)
    f.fixture.provider.inspectEvaluation = inspect
    expect(await restarted.runUntilBlocked(50)).toBe('complete')
    expect(new Set(f.fixture.executions.map(item => item.key)).size).toBe(f.fixture.executions.length)
  })

  it('records actual stop-capability usage above its reservation', async () => {
    const f = setup()
    const limited = createGepaRound({ campaignId: 'gepa-stop-overrun', options: f.options,
      evolutionBudget: { ...f.spec.budget,
        diagnosisInputTokens: { ...f.spec.budget.diagnosisInputTokens!, limit: 1 } } })
    const runtime = new AlgorithmRuntime(f.root, limited.algorithm, f.providers, limited.spec)
    expect(await runtime.runUntilBlocked(50)).toBe('complete')
    expect(runtime.snapshot()!.spent.diagnosisInputTokens).toBe(10)
    expect(f.fixture.generated).toHaveLength(0)
  })

  it('serializes overlapping cell plans and never performs the same uncached physical cell twice', async () => {
    const f = setup()
    const physical = f.fixture.provider.evaluate
    const dispatched = new Map<string, number>()
    let call = 0
    f.fixture.provider.evaluate = async input => {
      const marker = ++call
      for (const identity of input.cells) {
        const key = cellKey(identity)
        dispatched.set(key, (dispatched.get(key) ?? 0) + 1)
      }
      return (await physical(input)).map(cell => {
        if (cell.outcome.status !== 'available') return cell
        const { digest: ignored, ...body } = cell
        const evidenceRef = `${cell.evidenceRef}-dispatch-${marker}`
        return seal({ ...body, evidenceRef, outcome: { ...cell.outcome, evidenceRef } })
      })
    }
    const runtime = new AlgorithmRuntime(f.root, f.recipe, f.providers, f.spec)
    let complete = false
    for (let tick = 0; tick < 150; tick++) {
      const status = await runtime.tick()
      expect(Object.keys(runtime.snapshot()!.operations).length).toBeLessThanOrEqual(1)
      if (status === 'complete') { complete = true; break }
    }
    expect(complete).toBe(true)
    expect(dispatched.size).toBeGreaterThan(0)
    expect([...dispatched.values()].every(count => count === 1)).toBe(true)
  })
})
