import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlgorithmRuntime, BindingStore, FileArtifactStore, sha256 } from '../../src/algorithm/index.js'
import type { BindingSchema, CampaignSpec, OperationEnvelope } from '../../src/algorithm/contracts.js'
import { jsonDigest } from '../../src/algorithm/schema.js'
import { LegacyTrainingCycleProvider, SlimeTrainingOperationProvider } from '../../src/algorithm/providers/training.js'
import { hitchBackendIdentityDigest, ModelEvaluationOperationProvider } from '../../src/algorithm/providers/model-evaluation.js'
import { fixedHarnessGrpoRecipe } from '../../src/algorithm/recipes/grpo.js'
import { nodeSlimeJobLookup, sealTrainingHarnessBinding, sealTrainingModelBinding, type TrainingJobLookup } from '../../src/algorithm/providers/training-mapping.js'
import { ModelTrainingCoordinator } from '../../src/training/coordinator.js'
import { HitchModelEvaluator } from '../../src/training/hitch.js'
import { digestJson } from '../../src/training/digest.js'
import { sealModelVersion } from '../../src/training/schema.js'
import { ModelTrainingStore } from '../../src/training/store.js'
import type { NodeSlimeModelTrainer } from '../../src/training/slime.js'
import type * as T from '../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './training/fixture.js'
import { v2spec } from './training/placement-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temporary = () => { const value = mkdtempSync(join(tmpdir(), 'gear-algorithm-training-')); roots.push(value); return value }
const bindingSchema: BindingSchema = { id: 'grpo-bindings.v1', slots: {
  learner: { schemaId: 'training.model-binding.v1', required: true, replaceable: true },
  fixedHarness: { schemaId: 'training.fixed-harness.v1', required: true },
} }
class KeyedFixtureTrainer extends FixtureTrainer {
  keys: string[] = []
  override async submit(request: T.TrainingRequest, key?: string): Promise<T.TrainingHandle> {
    const frozenKey = key ?? request.trainingRunId
    this.keys.push(frozenKey); await super.submit(request)
    return { schemaVersion: 1, provider: 'slime', jobId: `job_${digestJson(frozenKey).slice(7, 39)}`, requestDigest: digestJson(request) }
  }
}
async function setup() {
  const directory = temporary()
  const trainingStore = new ModelTrainingStore(join(directory, 'training-cas'))
  const plan = await fixture(trainingStore)
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'))
  const bindings = new BindingStore(artifacts, bindingSchema)
  const learner = await sealTrainingModelBinding(artifacts, trainingStore, plan.initialModel)
  const fixedHarness = await sealTrainingHarnessBinding(artifacts, trainingStore, plan.fixedHarness)
  const initialBindingSetRef = bindings.create({ learner, fixedHarness })
  const trainer = new KeyedFixtureTrainer(trainingStore)
  const evaluator = new FixtureEvaluator(trainingStore) as FixtureEvaluator & T.ModelEvaluator
  evaluator.cancel = async () => ({ resourcesReleased: true, gpuSeconds: 0 })
  const lookup: TrainingJobLookup = { identityDigest: sha256('CPU-fixture-backend'), async find(request, key) {
    return trainer.keys.includes(key) && trainer.requests.some(saved => digestJson(saved) === digestJson(request))
      ? trainer.inspect({ schemaVersion: 1, provider: 'slime', jobId: `job_${digestJson(key).slice(7, 39)}`, requestDigest: digestJson(request) }) : null
  } }
  const train = new SlimeTrainingOperationProvider(join(directory, 'train-provider'), bindings, artifacts, trainingStore, trainer, lookup)
  const evaluate = new ModelEvaluationOperationProvider(join(directory, 'eval-provider'), bindings, artifacts, trainingStore, evaluator, sha256('CPU-fixture-evaluator'))
  const budget: CampaignSpec['budget'] = {
    trainingGpuSeconds: { unit: 'GPU-second', limit: 100, source: 'training.slime', capability: 'stop' },
    rolloutTokens: { unit: 'token', limit: 1000, source: 'training.slime', capability: 'stop' },
    groupResamples: { unit: 'group', limit: 2, source: 'training.slime', capability: 'stop' },
    evaluationGpuSeconds: { unit: 'GPU-second', limit: 400, source: 'training.evaluate', capability: 'stop' },
  }
  const recipe = fixedHarnessGrpoRecipe({ plan, bindingSchema, learnerSlot: 'learner', harnessSlot: 'fixedHarness', artifacts,
    trainingLimits: { trainingGpuSeconds: 100, rolloutTokens: 1000, groupResamples: 2 }, evaluationGpuSeconds: 100 })
  const spec: CampaignSpec = { campaignId: 'grpo-cpu-fixture', config: {}, initialBindingSetRef, budget }
  return { directory, trainingStore, plan, artifacts, bindings, initialBindingSetRef, trainer, evaluator, train, evaluate, recipe, spec }
}

describe('independent Slime training and fixed-Harness GRPO', () => {
  it('uses the frozen learner instead of an unrelated old champion and selects paired evidence', async () => {
    const f = await setup()
    const w0 = await f.trainingStore.readJson<T.ModelVersion>(f.plan.initialModel)
    const { id: _frozenId, ...oldBody } = w0
    const wOld = sealModelVersion({ ...oldBody, weightsDigest: digestJson('old champion') })
    const wOldRef = await f.trainingStore.putJson(wOld)
    const coordinator = new ModelTrainingCoordinator(f.trainingStore, new FixtureTrainer(f.trainingStore), new FixtureEvaluator(f.trainingStore))
    const old = await coordinator.createExperiment({ ...f.plan, initialModel: wOldRef })
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect(f.trainer.requests).toHaveLength(1)
    expect(f.trainer.requests[0]?.parentModelRef.digest).toBe(f.plan.initialModel.digest)
    expect(f.trainer.requests[0]?.parentModel.weightsDigest).toBe(w0.weightsDigest)
    expect(runtime.snapshot()?.activeBindingSetRef.digest).not.toBe(f.initialBindingSetRef.digest)
    expect(f.evaluator.calls).toHaveLength(4)
    expect(new Set(f.evaluator.calls.map(call => call.subject.harnessRef.digest))).toEqual(new Set([f.plan.fixedHarness.manifestRef.digest]))
    expect(f.evaluator.calls.filter(call => call.condition.partition === 'dev').map(call => !!call.model.trainingRunId).sort()).toEqual([false, true])
    expect((await f.trainingStore.load(old.id)).champion.modelRef.digest).toBe(wOldRef.digest)
  })

  it('records a dev-gate rejection without querying held-out evidence', async () => {
    const f = await setup()
    f.evaluator.candidateReward = -1
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect(runtime.snapshot()?.activeBindingSetRef).toEqual(f.initialBindingSetRef)
    expect(f.evaluator.calls).toHaveLength(2)
    const state = runtime.snapshot()?.state as { business: { decision: { outcome: string; reasons: string[] } } }
    expect(state.business.decision.outcome).toBe('rejected')
    expect(state.business.decision.reasons).toContain('dev-gain-below-threshold')
  })

  it('leaves the learner unchanged with a zero-usage no-candidate result', async () => {
    const f = await setup()
    f.trainer.inspect = async handle => ({ schemaVersion: 1, handle, phase: 'inconclusive', execution: 'completed', committedUpdate: 0,
      usage: { gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 }, resourcesReleased: true })
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect(runtime.snapshot()?.activeBindingSetRef).toEqual(f.initialBindingSetRef)
    expect(runtime.snapshot()?.spent.trainingGpuSeconds ?? 0).toBe(0)
    expect(f.evaluator.calls).toHaveLength(0)
  })

  it('recovers a lost submit reply with the original request and key, and rejects input drift', async () => {
    const f = await setup()
    f.trainer.failSubmitOnce = true
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    await runtime.tick(); expect(await runtime.tick()).toBe('waiting')
    const original = runtime.snapshot()!.operations.train!.envelope
    expect(f.trainer.submissions).toBe(1)
    const resumed = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await resumed.runUntilBlocked()).toBe('complete')
    expect(f.trainer.submissions).toBe(1)
    expect(f.trainer.keys).toEqual([original.idempotencyKey])
    expect(f.trainer.requests[0]?.trainingRunId).toBe(`train_${original.operationId.slice(0, 32)}`)
    await expect(f.train.preflight({ ...original, inputDigest: sha256('tampered') })).rejects.toThrow('identity')
    await expect(f.train.preflight({ ...original, limits: { ...original.limits, trainingGpuSeconds: 1 } }))
      .rejects.toMatchObject({ code: 'training-reservation-too-small' })
    const altered = { ...f.plan, datasets: { ...f.plan.datasets, train: { ...f.plan.datasets.train, exactDataAuthorized: false } } }
    await expect(f.train.preflight({ ...original, input: { plan: altered, learnerSlot: 'learner', harnessSlot: 'fixedHarness' } as never,
      inputDigest: jsonDigest({ plan: altered, learnerSlot: 'learner', harnessSlot: 'fixedHarness' }) })).rejects.toThrow()
  })

  it('replays cancellation and holds reservations until the trainer confirms release', async () => {
    const f = await setup()
    let released = false; let cancels = 0
    f.trainer.released = false
    f.trainer.cancel = async handle => {
      cancels++
      return { ...await f.trainer.inspect(handle), execution: 'paused', resourcesReleased: released }
    }
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    await runtime.tick(); expect(await runtime.tick()).toBe('waiting')
    await runtime.cancel('train')
    expect(cancels).toBe(1)
    expect(runtime.snapshot()?.operations.train?.released).toBe(false)
    released = true
    const resumed = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await resumed.runUntilBlocked()).toBe('complete')
    expect(cancels).toBeGreaterThanOrEqual(2)
    expect(resumed.snapshot()?.spent.trainingGpuSeconds).toBe(1)
    expect(resumed.snapshot()?.activeBindingSetRef).toEqual(f.initialBindingSetRef)
  })

  it('persists cancellation before submit for Slime and evaluation across provider restart', async () => {
    const f = await setup()
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    await runtime.tick()
    const training = runtime.snapshot()!.operations.train!.envelope
    expect(await f.train.cancel(training)).toMatchObject({ status: 'cancelled', releaseConfirmed: true })
    const recoveredTrain = new SlimeTrainingOperationProvider(join(f.directory, 'train-provider'), f.bindings, f.artifacts,
      f.trainingStore, f.trainer, f.train.lookup)
    expect(await recoveredTrain.inspect(training)).toMatchObject({ status: 'cancelled', releaseConfirmed: true })
    await expect(recoveredTrain.submit(training)).rejects.toThrow('Cancelled training operation')
    expect(f.trainer.submissions).toBe(0)

    const input = { plan: f.plan, learnerSlot: 'learner', harnessSlot: 'fixedHarness', partition: 'dev' }
    const operationId = sha256('cancel-evaluation-before-submit')
    const evaluation: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'grpo-cpu-fixture',
      decisionIndex: 1, localKey: 'baseline-dev', kind: 'model.evaluate', input: input as never, inputDigest: jsonDigest(input),
      implementationDigest: f.evaluate.describe().implementationDigest, bindingSetRef: f.initialBindingSetRef,
      limits: { evaluationGpuSeconds: 100 } }
    expect(await f.evaluate.cancel(evaluation)).toMatchObject({ status: 'cancelled', releaseConfirmed: true })
    const recoveredEval = new ModelEvaluationOperationProvider(join(f.directory, 'eval-provider'), f.bindings, f.artifacts,
      f.trainingStore, f.evaluator, sha256('CPU-fixture-evaluator'))
    expect(await recoveredEval.inspect(evaluation)).toMatchObject({ status: 'cancelled', releaseConfirmed: true })
    await expect(recoveredEval.submit(evaluation)).rejects.toThrow('Cancelled evaluation operation')
    expect(f.evaluator.calls).toHaveLength(0)
  })

  it('persists legacy cancellation before submit and fences delayed advance', async () => {
    const f = await setup()
    const trainer = new FixtureTrainer(f.trainingStore)
    const coordinator = new ModelTrainingCoordinator(f.trainingStore, trainer, new FixtureEvaluator(f.trainingStore))
    const experiment = await coordinator.createExperiment(f.plan)
    const run = await coordinator.admit(experiment.id)
    const root = join(f.directory, 'legacy-cancel-provider')
    const provider = new LegacyTrainingCycleProvider(root, coordinator, f.trainingStore, sha256('legacy-fixture'))
    const input = { experimentId: experiment.id, runId: run.id }
    const operationId = sha256('legacy-cancel-before-submit')
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'legacy-fixture',
      decisionIndex: 0, localKey: 'cancel-first', kind: 'training.legacy_cycle', input, inputDigest: jsonDigest(input),
      implementationDigest: provider.describe().implementationDigest, bindingSetRef: f.initialBindingSetRef,
      limits: { legacyGpuSeconds: 100, legacyRolloutTokens: 1000, legacyGroupResamples: 2 } }
    const cancelled = await provider.cancel(envelope)
    expect(cancelled.status).toBe('cancelled')
    const resumed = new LegacyTrainingCycleProvider(root, coordinator, f.trainingStore, sha256('legacy-fixture'))
    expect((await resumed.inspect(envelope)).status).toBe('cancelled')
    await expect(resumed.submit(envelope)).rejects.toThrow('Cancelled legacy operation')
    expect(trainer.submissions).toBe(0)
  })

  it('charges each legacy run once and never attributes a later run to the first operation', async () => {
    const f = await setup()
    const oldTrainer = new FixtureTrainer(f.trainingStore)
    const coordinator = new ModelTrainingCoordinator(f.trainingStore, oldTrainer, new FixtureEvaluator(f.trainingStore))
    const experiment = await coordinator.createExperiment(f.plan)
    const firstRun = await coordinator.admit(experiment.id)
    const legacy = new LegacyTrainingCycleProvider(join(f.directory, 'legacy-provider'), coordinator, f.trainingStore, sha256('legacy-fixture'))
    const envelope = (runId: string, name: string): OperationEnvelope => {
      const input = { experimentId: experiment.id, runId }
      const operationId = sha256(name)
      return { operationId, idempotencyKey: operationId, campaignId: 'legacy-fixture', decisionIndex: 0, localKey: name,
        kind: 'training.legacy_cycle', input, inputDigest: jsonDigest(input), implementationDigest: legacy.describe().implementationDigest,
        bindingSetRef: f.initialBindingSetRef, limits: { legacyGpuSeconds: 100, legacyRolloutTokens: 1000, legacyGroupResamples: 2 } }
    }
    const first = envelope(firstRun.id, 'first')
    await legacy.submit(first)
    let firstResult = await legacy.inspect(first)
    for (let count = 0; count < 10 && firstResult.status !== 'completed'; count++) firstResult = await legacy.inspect(first)
    expect(firstResult.status).toBe('completed')
    if (firstResult.status !== 'completed') throw new Error('fixture legacy run did not finish')
    const firstGpu = firstResult.completion.receipt?.cumulative.legacyGpuSeconds
    expect(firstGpu).toBe(1)
    await expect(legacy.submit(envelope(firstRun.id, 'duplicate-owner'))).rejects.toThrow('two operations')
    const otherProviderRoot = new LegacyTrainingCycleProvider(join(f.directory, 'other-legacy-provider'), coordinator, f.trainingStore, sha256('legacy-fixture'))
    await expect(otherProviderRoot.submit(envelope(firstRun.id, 'cross-root-owner'))).rejects.toThrow('two operations')
    const secondRun = await coordinator.admit(experiment.id)
    const second = envelope(secondRun.id, 'second')
    await legacy.submit(second)
    for (let count = 0; count < 10; count++) {
      const inspected = await legacy.inspect(second)
      if (inspected.status === 'completed') break
    }
    const recoveredFirst = await legacy.inspect(first)
    expect(recoveredFirst.status).toBe('completed')
    if (recoveredFirst.status === 'completed') expect(recoveredFirst.completion.receipt?.cumulative.legacyGpuSeconds).toBe(firstGpu)
    expect((await f.trainingStore.load(experiment.id)).usage.gpuSeconds).toBeGreaterThan(firstGpu!)
  })

  it('applies the same checkpoint validator to independent and legacy training', async () => {
    const f = await setup()
    const collectNew = f.trainer.collect.bind(f.trainer)
    f.trainer.collect = async handle => ({ ...await collectNew(handle), checkpointRef: f.plan.initialModel })
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    await runtime.tick(); await runtime.tick()
    let independentCode: unknown
    try { await runtime.tick() } catch (error) { independentCode = (error as { code?: unknown }).code }
    expect(independentCode).toBeTruthy()

    const oldTrainer = new FixtureTrainer(f.trainingStore)
    const collectOld = oldTrainer.collect.bind(oldTrainer)
    oldTrainer.collect = async handle => ({ ...await collectOld(handle), checkpointRef: f.plan.initialModel })
    const coordinator = new ModelTrainingCoordinator(f.trainingStore, oldTrainer, new FixtureEvaluator(f.trainingStore))
    const experiment = await coordinator.createExperiment(f.plan)
    const run = await coordinator.admit(experiment.id)
    let legacyCode: unknown
    try { await coordinator.advance(experiment.id, run.id) } catch (error) { legacyCode = (error as { code?: unknown }).code }
    expect(legacyCode).toBe(independentCode)
  })

  it('holds evaluation reservations until explicit Hitch-style release confirmation', async () => {
    const f = await setup()
    let released = false; let releaseCalls = 0
    f.evaluator.cancel = async () => { releaseCalls++; return { resourcesReleased: released, gpuSeconds: 0 } }
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    expect(await runtime.runUntilBlocked()).toBe('waiting')
    expect(releaseCalls).toBeGreaterThan(0)
    expect(Object.values(runtime.snapshot()!.operations).every(operation => !operation.released)).toBe(true)
    released = true
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect(runtime.snapshot()?.activeBindingSetRef.digest).not.toBe(f.initialBindingSetRef.digest)
  })

  it('rejects recipe and learner model identity drift on resume', async () => {
    const f = await setup()
    const runtime = new AlgorithmRuntime(f.directory, f.recipe, [f.train, f.evaluate], f.spec)
    await runtime.tick()
    const changedPlan = { ...f.plan, trainer: { ...f.plan.trainer, updatesPerCandidate: 2 } }
    const changedRecipe = fixedHarnessGrpoRecipe({ plan: changedPlan, bindingSchema, learnerSlot: 'learner', harnessSlot: 'fixedHarness', artifacts: f.artifacts,
      trainingLimits: { trainingGpuSeconds: 100, rolloutTokens: 1000, groupResamples: 2 }, evaluationGpuSeconds: 100 })
    expect(() => new AlgorithmRuntime(f.directory, changedRecipe, [f.train, f.evaluate], f.spec).snapshot()).toThrow('identity drift')

    const original = runtime.snapshot()!.operations.train!.envelope
    const model = await f.trainingStore.readJson<T.ModelVersion>(f.plan.initialModel)
    const { id: _id, ...modelBody } = model
    const mismatched = sealModelVersion({ ...modelBody, weightsDigest: digestJson('forged learner') })
    const forged = f.artifacts.putJson({ modelRef: f.plan.initialModel, model: mismatched } as never, 'training.model-binding.v1')
    const forgedSet = f.bindings.derive(f.initialBindingSetRef, { learner: forged })
    await expect(f.train.preflight({ ...original, bindingSetRef: forgedSet })).rejects.toMatchObject({ code: 'model-binding-drift' })
  })

  it('reconciles the exact V2 request/key through training.find and checks the live node runtime', async () => {
    const f = await setup()
    const plan = v2spec(f.plan)
    const coordinator = new ModelTrainingCoordinator(f.trainingStore, new FixtureTrainer(f.trainingStore), new FixtureEvaluator(f.trainingStore))
    const experiment = await coordinator.createExperiment(plan)
    const run = await coordinator.admit(experiment.id)
    if (run.request.schemaVersion !== 2) throw new Error('V2 fixture lost its deployment')
    const key = 'operation-frozen-key'
    const node = { nodeId: run.request.deployment.modelRuntime.nodeId, generation: run.request.deployment.modelRuntime.generation }
    const localHandle: T.TrainingHandle = { schemaVersion: 1, provider: 'slime', jobId: `job_${digestJson(key).slice(7, 39)}`,
      requestDigest: digestJson(run.request) }
    const seen: string[] = []
    let drift = false
    const fakeTrainer = {
      transport: { identity: node, connection: { transport: { type: 'local' } }, async call(operation: string, payload: unknown) {
        seen.push(operation)
        if (operation === 'probe') return { ...node, runtime: 'observed-runtime', runtimeDigest: drift ? sha256('changed') : digestJson('observed-runtime') }
        expect(payload).toEqual({ idempotencyKey: key, requestDigest: digestJson(run.request) })
        return { exists: true, status: { schemaVersion: 1, handle: localHandle, phase: 'checkpointed', execution: 'completed',
          committedUpdate: 1, usage: { gpuSeconds: 1, rolloutTokens: 4, groupResamples: 0 }, resourcesReleased: true } }
      } },
      async inspect(handle: T.TrainingHandle) { return { schemaVersion: 1, handle, phase: 'checkpointed', execution: 'completed',
        committedUpdate: 1, usage: { gpuSeconds: 1, rolloutTokens: 4, groupResamples: 0 }, resourcesReleased: true } },
    } as unknown as NodeSlimeModelTrainer
    const lookup = nodeSlimeJobLookup(fakeTrainer)
    expect((await lookup.find(run.request, key))?.handle).toMatchObject({ schemaVersion: 2, node })
    expect(seen).toEqual(['probe', 'training.find'])
    drift = true
    await expect(lookup.find(run.request, key)).rejects.toMatchObject({ code: 'training-node-runtime-drift' })
  })

  it('seals the actual Hitch command tree and rejects implementation drift', async () => {
    const directory = temporary()
    const cli = join(directory, 'dist', 'bin', 'hitch.js')
    mkdirSync(join(directory, 'dist', 'bin'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"name":"hitch-fixture","version":"1.0.0"}')
    writeFileSync(cli, 'console.log("v1")')
    const evaluator = new HitchModelEvaluator(new ModelTrainingStore(join(directory, 'cas')), {
      command: [process.execPath, cli], root: join(directory, 'hitch-root'), workspace: join(directory, 'workspace'),
      harnessSourceDirectory: directory, python: [process.execPath],
      budgets: { timeoutSeconds: 30, setupTimeoutSeconds: 30, maxConcurrent: 1, maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 },
    })
    const before = hitchBackendIdentityDigest(evaluator)
    writeFileSync(cli, 'console.log("v2")')
    expect(hitchBackendIdentityDigest(evaluator)).not.toBe(before)
  })
})
