import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaEvaluationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'
import { plannedCells } from '../../src/search/evidence.js'
import { MemorySearchStore, evaluatedFixture, fixtures, revise, scopeFixture } from '../../src/search/testing.js'
import type { SearchProgress, StageEvaluationPlan, TaskUniverse } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gepa-progress-')); roots.push(root)
  const fixture = fixtures(4)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const bindingSetRef = bindings.create({ harness })
  const journal = new MemorySearchStore()
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings,
    fixture.provider, undefined, undefined, journal)
  const envelope = (universe: TaskUniverse, plan: StageEvaluationPlan): OperationEnvelope => {
    const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe,
      plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
    const operationId = digestJson(['progress', plan.digest, root]).slice(7)
    return { campaignId: 'search-r', decisionIndex: 0, localKey: `evaluate-${plan.stage}`,
      operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input,
      inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
      bindingSetRef, limits: { rolloutCells: plannedCells(universe, plan, fixture.anchor).length,
        repairCells: 0 }, startsBudgetClock: true }
  }
  return { fixture, artifacts, journal, provider, envelope }
}

it('replays settled seed progress after a journal write fault without repeating physical evaluation', async () => {
  const { fixture, journal, provider, envelope } = setup()
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 1 }), { stage: 'baseline-probe' })
  const operation = envelope(fixture.seed, plan)
  const physical = fixture.provider.evaluate
  let physicalCalls = 0, sawRunning = false
  fixture.provider.evaluate = async request => {
    physicalCalls++
    const progress = await journal.read<SearchProgress>('rounds/r/progress')
    sawRunning = progress?.evaluations.some(row => row.stagePlanDigest === plan.digest && row.state === 'running') ?? false
    return physical(request)
  }
  const write = journal.write.bind(journal)
  let failSettled = true
  journal.write = async (name, value) => {
    if (name === 'rounds/r/progress' && failSettled
      && (value as SearchProgress).evaluations.some(row => row.state === 'settled')) {
      failSettled = false
      throw new Error('settled progress write unavailable')
    }
    return write(name, value)
  }
  await expect(provider.submit(operation)).rejects.toMatchObject({ name: 'ProviderReconcileError',
    cause: { message: 'settled progress write unavailable' } })
  expect(sawRunning).toBe(true)
  expect(physicalCalls).toBe(1)
  expect((await provider.inspect(operation)).status).toBe('replay-safe')
  expect((await provider.submit(operation)).status).toBe('completed')
  expect(physicalCalls).toBe(1)
  const settled = await journal.read<SearchProgress>('rounds/r/progress')
  expect(settled?.evaluations).toMatchObject([{ stage: 'baseline-probe', state: 'settled',
    stagePlanDigest: plan.digest, candidateId: fixture.anchor.candidateId }])

  const { plan: heldOutPlan } = evaluatedFixture(fixture.heldOut,
    scopeFixture(fixture.heldOut, ['task-0']), fixture.anchor, () => ({ outcome: 1 }), { stage: 'held-out' })
  expect((await provider.submit(envelope(fixture.heldOut, heldOutPlan))).status).toBe('completed')
  expect(await journal.read<SearchProgress>('rounds/r/progress')).toEqual(settled)
})

it('writes running once per explicit legacy invocation, including a resumed pending evaluation', async () => {
  const { fixture, journal, provider, envelope } = setup()
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 1 }), { stage: 'baseline-probe' })
  const operation = envelope(fixture.seed, plan)
  const write = journal.write.bind(journal)
  let runningWrites = 0
  journal.write = async (name, value) => {
    if (name === 'rounds/r/progress' && (value as SearchProgress).evaluations.some(row =>
      row.stagePlanDigest === plan.digest && row.state === 'running')) runningWrites++
    return write(name, value)
  }
  fixture.provider.evaluate = async () => { throw new Error('original response lost') }
  fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'same-worker' })
  const first = provider.beginLegacyInvocation()
  try {
    await provider.prepareForDispatch(operation)
    expect(runningWrites).toBe(1)
    expect((await provider.submit(operation)).status).toBe('running')
    expect(runningWrites).toBe(1)
  } finally { first() }
  const resumed = provider.beginLegacyInvocation()
  try {
    await provider.prepareForDispatch(operation)
    expect(runningWrites).toBe(2)
    expect((await journal.read<SearchProgress>('rounds/r/progress'))?.evaluations[0]?.state).toBe('running')
  } finally { resumed() }
})

it('persists objective score evidence referenced by settled seed progress', async () => {
  const { fixture, journal, provider, envelope } = setup()
  const contracts = [resolveMetric({ id: 'quality', revision: '1', unit: 'score', direction: 'maximize',
    source: { path: 'originalResult.quality', extractor: 'number-v1' }, granularity: 'trial',
    repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 })]
  const seed = revise(fixture.seed, { rawMetricContracts: contracts,
    objective: resolveObjective({ terms: [{ metric: 'quality', weight: 1 }] }, contracts) })
  fixture.provider.capabilities.objectives = 1
  fixture.provider.describe = async partition => partition === 'seed' ? seed : fixture.heldOut
  const physical = fixture.provider.evaluate
  fixture.provider.evaluate = async request => (await physical(request)).map(cell => revise(cell, {
    rawMetrics: extractRawMetrics({ contracts, certified: true,
      trial: { originalResult: { quality: .8 } },
      identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition,
        runId: cell.evidenceRef, attempt: 1, harnessCommit: cell.identity.harnessCommit,
        conditionDigest: cell.identity.conditionDigest,
        originalArtifactRefs: [digestJson(['source', cell.identity])] } }) }))
  const { plan } = evaluatedFixture(seed, scopeFixture(seed, ['task-0']), fixture.anchor,
    () => ({ outcome: .8 }), { stage: 'baseline-probe' })
  // Provider identity is sealed at construction, so use a fresh instance after
  // the synthetic objective-capable physical contract is configured.
  const objectiveProvider = new GepaEvaluationProvider(join(roots.at(-1)!, 'objective-operations'),
    provider.artifacts, provider.bindings, fixture.provider, undefined, undefined, journal)
  const operation = { ...envelope(seed, plan),
    implementationDigest: objectiveProvider.describe().implementationDigest }
  expect((await objectiveProvider.submit(operation)).status).toBe('completed')
  const progress = await journal.read<SearchProgress>('rounds/r/progress')
  const score = progress?.evaluations[0]?.profile?.objectiveScore
  expect(score?.score).toBeCloseTo(.8)
  expect(await journal.object(score!.digest)).toEqual(score)
})
