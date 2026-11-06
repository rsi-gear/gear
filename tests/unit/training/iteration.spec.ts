import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelIterationController, runIteration } from '../../../src/training/iteration.js'
import { iterationPolicy } from '../../../src/training/iteration-policy.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { trainingCommand } from '../../../src/training/cli.js'
import { NodeSlimeModelTrainer } from '../../../src/training/slime.js'
import { HitchModelEvaluator } from '../../../src/training/hitch.js'
import { ExternalFileEndpointPreparer } from '../../../src/training/endpoint-binding.js'
import type * as T from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer, fixtureEndpointBinding, fixtureEndpointPreparer } from './fixture.js'
import { deployment, v2spec } from './placement-fixture.js'
import { offlineDataset, OfflineFixtureTrainer } from './offline-fixture.js'

class ImprovingEvaluator extends FixtureEvaluator {
  constructor(private content: ModelTrainingStore) { super(content) }
  override async evaluate(request: T.ModelEvaluationRequest) {
    const update = request.model.trainerCheckpointRef ? (await this.content.readJson<T.TrainerCheckpoint>(request.model.trainerCheckpointRef)).committedUpdate : 0
    this.candidateReward = update; this.heldOutReward = update
    return super.evaluate(request)
  }
}

describe('durable unattended experiment rounds', () => {
  let root: string, store: ModelTrainingStore, spec: T.ModelTrainingSpecV1, trainer: FixtureTrainer, evaluator: ImprovingEvaluator
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-iteration-')); store = new ModelTrainingStore(root)
    spec = await fixture(store); trainer = new FixtureTrainer(store); evaluator = new ImprovingEvaluator(store)
    spec.iteration = iterationPolicy([{ id: 'initial', sourceRef: spec.trainer.hyperparametersRef }], { maxRounds: 2, maxWallClockSeconds: 60 })
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const controller = () => new ModelIterationController(new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer))

  it('automatically accepts two distinct rounds and resumes every native checkpoint component', async () => {
    const loop = controller(), experiment = await loop.coordinator.createExperiment(spec)
    const result = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(result.iteration).toMatchObject({ status: 'completed', stopReason: 'max-rounds', consecutiveRejected: 0 })
    const runs = Object.values(result.iteration!.rounds).map(round => result.runs[round.runId]!)
    expect(runs).toHaveLength(2); expect(new Set(runs.map(run => run.id)).size).toBe(2)
    expect(runs.map(run => run.decision?.outcome)).toEqual(['accepted', 'accepted'])
    const first = await store.readJson<T.ModelVersion>(runs[0]!.candidateRef!), secondRequest = runs[1]!.request
    expect(secondRequest.parentModelRef).toEqual(runs[0]!.candidateRef)
    expect(secondRequest.resumeCheckpointRef).toEqual(first.trainerCheckpointRef); expect(secondRequest.coldStart).toBe(false)
    const checkpoint = await store.readJson<T.TrainerCheckpoint>(secondRequest.resumeCheckpointRef!)
    for (const ref of [checkpoint.actorStateRef, checkpoint.optimizerStateRef, checkpoint.schedulerAndRngRef, checkpoint.dataCursorRef]) expect(await store.readBytes(ref)).toBeDefined()
    expect((await store.readJson<T.TrainerCheckpoint>((await store.readJson<T.ModelVersion>(result.champion.modelRef)).trainerCheckpointRef!)).committedUpdate).toBe(2)
    expect(evaluator.calls).toHaveLength(6) // second round uses the two complete champion observations
    expect(result.releases).toEqual([])
    expect(trainer.submissions).toBe(2)
  })

  it('atomically maps admission and reuses it after a lost admission response', async () => {
    const loop = controller(), experiment = await loop.coordinator.createExperiment(spec)
    const first = await loop.coordinator.admit(experiment.id, 0)
    const restarted = controller(), state = await store.load(experiment.id)
    const replayed = await restarted.coordinator.admit(experiment.id, state.iteration!.control.sequence)
    expect(replayed.id).toBe(first.id)
    await runIteration(restarted, experiment.id, { intervalMs: 1 })
    expect(Object.keys((await store.load(experiment.id)).runs)).toHaveLength(2)
    expect(trainer.submissions).toBe(2)
  })

  it('uses only frozen recovery authority after a lost training submission reply', async () => {
    spec.iteration!.recovery.maxRunRecoveries = 1
    trainer.failSubmitOnce = true
    const loop = controller(), experiment = await loop.coordinator.createExperiment(spec)
    const completed = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(completed.iteration).toMatchObject({ status: 'completed', stopReason: 'max-rounds' })
    expect(completed.iteration?.rounds['0']?.recoveries).toBe(1)
    expect(trainer.submissions).toBe(2)
    expect(new Set(trainer.requests.map(request => request.trainingRunId)).size).toBe(2)
    expect(completed.iteration!.control.sequence).toBeGreaterThan(2)
  })

  it('persists user pause and fences stale round admission through controller restart', async () => {
    const loop = controller(), experiment = await loop.coordinator.createExperiment(spec)
    const admitted = await loop.coordinator.admit(experiment.id, 0)
    const saved = await store.load(experiment.id), sequence = saved.iteration!.control.sequence
    await loop.pause(experiment.id)
    expect((await controller().advance(experiment.id)).iteration?.status).toBe('paused')
    expect(trainer.submissions).toBe(0)
    await expect(loop.coordinator.admit(experiment.id, sequence)).rejects.toMatchObject({ code: 'iteration-control-stale' })
    await controller().resume(experiment.id)
    const complete = await runIteration(controller(), experiment.id, { intervalMs: 1 })
    expect(complete.iteration?.status).toBe('completed')
    expect(complete.iteration?.rounds['0']?.runId).toBe(admitted.id)
    expect(complete.iteration!.control.sequence).toBeGreaterThan(sequence)
  })

  it('stops rejection without a new declared input and never contaminates the champion', async () => {
    const flat = new FixtureEvaluator(store); flat.candidateReward = 0
    const coordinator = new ModelTrainingCoordinator(store, trainer, flat, fixtureEndpointPreparer), loop = new ModelIterationController(coordinator)
    const experiment = await coordinator.createExperiment(spec), result = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(result.iteration).toMatchObject({ status: 'completed', stopReason: 'no-new-proposal' })
    expect(result.champion.modelRef).toEqual(spec.initialModel); expect(trainer.submissions).toBe(1)
    expect((await controller().advance(experiment.id)).iteration?.stopReason).toBe('no-new-proposal')
  })

  it('consumes a distinct frozen proposal after rejection, preserving optimizer compatibility', async () => {
    spec.iteration!.proposals.push({ id: 'longer-rollout', sourceRef: await store.putJson({ plan: 'longer-rollout' }),
      rolloutSampling: { ...spec.rollout.sampling, maxNewTokens: 32 } })
    const flat = new FixtureEvaluator(store); flat.candidateReward = 0
    const loop = new ModelIterationController(new ModelTrainingCoordinator(store, trainer, flat, fixtureEndpointPreparer))
    const experiment = await loop.coordinator.createExperiment(spec)
    await loop.advance(experiment.id)
    flat.candidateReward = 1
    const result = await runIteration(loop, experiment.id, { intervalMs: 1 })
    const runs = Object.values(result.iteration!.rounds).map(round => result.runs[round.runId]!)
    expect(runs.map(run => run.iterationRound?.proposalId)).toEqual(['initial', 'longer-rollout'])
    expect(runs[1]!.request.rollout.sampling.maxNewTokens).toBe(32)
    expect(runs[1]!.parent.modelRef).toEqual(spec.initialModel)
    expect(result.champion.trainingRunId).toBe(runs[1]!.id)
    expect((await store.load(experiment.id)).spec).toEqual(spec)
  })

  it('does not treat another provenance label for identical inputs as new exploration', async () => {
    spec.iteration!.proposals.push({ id: 'different-label', sourceRef: await store.putJson({ provenance: 'another-label' }) })
    const flat = new FixtureEvaluator(store); flat.candidateReward = 0
    const loop = new ModelIterationController(new ModelTrainingCoordinator(store, trainer, flat, fixtureEndpointPreparer))
    const experiment = await loop.coordinator.createExperiment(spec)
    const result = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(result.iteration?.stopReason).toBe('no-new-proposal'); expect(trainer.submissions).toBe(1)
  })

  it.each(['gpu', 'tokens', 'held-out', 'rejected'] as const)('stops at the frozen %s budget before another admission', async budget => {
    if (budget === 'gpu') spec.budgets.totalGpuSeconds = 1
    if (budget === 'tokens') spec.budgets.maxRolloutTokens = 4
    if (budget === 'held-out') spec.evaluation.policy.maxHeldOutEvaluations = 1
    if (budget === 'rejected') {
      spec.iteration!.maxConsecutiveRejected = 1
      spec.iteration!.proposals.push({ id: 'next', sourceRef: spec.verifier, rolloutSampling: { ...spec.rollout.sampling, maxNewTokens: 32 } })
    }
    const chosen = budget === 'rejected' ? new FixtureEvaluator(store) : evaluator
    if (budget === 'rejected') chosen.candidateReward = 0
    const loop = new ModelIterationController(new ModelTrainingCoordinator(store, trainer, chosen, fixtureEndpointPreparer))
    const experiment = await loop.coordinator.createExperiment(spec), complete = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(complete.iteration?.stopReason).toBe({ gpu: 'training-gpu-budget-exhausted', tokens: 'rollout-token-budget-exhausted',
      'held-out': 'held-out-budget-exhausted', rejected: 'max-consecutive-rejected' }[budget])
    expect(trainer.submissions).toBe(1)
  })

  it('stops instead of resetting optimizer state for an incompatible declared proposal', async () => {
    spec.trainer.recipe = 'agent-gspo-v1'; spec.iteration!.maxRounds = 3
    spec.iteration!.proposals.push({ id: 'changed-sampling', sourceRef: spec.verifier,
      rolloutSampling: { ...spec.rollout.sampling, maxNewTokens: 32 } })
    const loop = controller(), experiment = await loop.coordinator.createExperiment(spec)
    const first = await loop.advance(experiment.id)
    const accepted = first.champion.modelRef
    const original = evaluator.evaluate.bind(evaluator)
    evaluator.evaluate = async request => {
      const evidence = await original(request)
      if (request.model.trainerCheckpointRef && (await store.readJson<T.TrainerCheckpoint>(request.model.trainerCheckpointRef)).committedUpdate === 2) {
        for (const trial of evidence.trials) trial.reward = 1
      }
      return evidence
    }
    const completed = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(completed.iteration).toMatchObject({ status: 'failed', stopReason: 'admission-failed:checkpoint-incompatible' })
    expect(completed.champion.modelRef).toEqual(accepted); expect(trainer.submissions).toBe(2)
    expect(Object.keys(completed.runs)).toHaveLength(2)
  })

  it('stops at offline cursor exhaustion without readmitting the same consumed data', async () => {
    spec.trainer.recipe = 'offline-sft-v1'; spec.trainer.globalBatchSize = 1
    spec.offlineTraining = await offlineDataset(store, await store.readJson<T.ModelVersion>(spec.initialModel), spec.datasets.train)
    spec.offlineTraining.maxEpochs = 1; spec.iteration!.maxRounds = 8; spec.evaluation.policy.maxHeldOutEvaluations = 8
    const offline = new OfflineFixtureTrainer(store)
    const loop = new ModelIterationController(new ModelTrainingCoordinator(store, offline, evaluator, fixtureEndpointPreparer))
    const experiment = await loop.coordinator.createExperiment(spec), completed = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(completed.iteration).toMatchObject({ status: 'completed', stopReason: 'offline-dataset-exhausted' })
    expect(offline.submissions).toBe(4)
    const champion = await store.readJson<T.ModelVersion>(completed.champion.modelRef)
    const checkpoint = await store.readJson<T.TrainerCheckpoint>(champion.trainerCheckpointRef!)
    expect(await store.readJson(checkpoint.dataCursorRef)).toMatchObject({ position: 4, datasetDigest: spec.offlineTraining.datasetRef.digest })
  })

  it('retains the stop intent if the controller dies after committing rejection', async () => {
    const flat = new FixtureEvaluator(store); flat.candidateReward = 0
    const loop = new ModelIterationController(new ModelTrainingCoordinator(store, trainer, flat, fixtureEndpointPreparer))
    const experiment = await loop.coordinator.createExperiment(spec)
    const fence = vi.spyOn(loop.coordinator, 'fenceEndpoints').mockRejectedValue(new Error('crash after durable round decision'))
    const pending = await loop.advance(experiment.id)
    expect(pending.iteration).toMatchObject({ status: 'pausing', stopReason: 'no-new-proposal' })
    expect(pending.iteration?.rounds['0']?.outcome).toBe('rejected')
    fence.mockRestore()
    const restarted = new ModelIterationController(new ModelTrainingCoordinator(store, trainer, flat, fixtureEndpointPreparer))
    expect((await restarted.advance(experiment.id)).iteration).toMatchObject({ status: 'completed', stopReason: 'no-new-proposal' })
    expect(trainer.submissions).toBe(1)
  })

  it('preserves the absolute deadline across restart and never restarts paused work after it', async () => {
    const loop = controller(), now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const experiment = await loop.coordinator.createExperiment(spec)
    const admitted = await loop.coordinator.admit(experiment.id, 0)
    expect(admitted.request.deadlineAt).toBe(experiment.iteration?.deadlineAt)
    await loop.pause(experiment.id)
    clock.mockReturnValue(now + 61_000)
    await expect(controller().resume(experiment.id)).rejects.toMatchObject({ code: 'iteration-deadline-exceeded' })
    expect((await store.load(experiment.id)).iteration?.deadlineAt).toBe(experiment.iteration?.deadlineAt)
    expect(trainer.submissions).toBe(0)
  })

  it('leaves historical experiments single-run and rejects adding managed authority through configuration', async () => {
    delete spec.iteration
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer)
    const experiment = await coordinator.createExperiment(spec)
    expect(experiment.iteration).toBeUndefined()
    await expect(new ModelIterationController(coordinator).advance(experiment.id)).rejects.toMatchObject({ code: 'iteration-not-authorized' })
    const elevated = new ModelTrainingCoordinator(store, trainer, evaluator, { ...fixtureEndpointPreparer, mode: 'managed-native' })
    await expect(elevated.admit(experiment.id)).rejects.toMatchObject({ code: 'managed-endpoint-not-authorized' })
  })

  it('rejects an implicit or one-round decay schedule before creating the automatic experiment', async () => {
    const c = controller().coordinator
    const args = ['--lr', '0.000001', '--lr-decay-style', 'linear', '--num-steps-per-rollout', '1']
    spec.trainer.hyperparametersRef = await store.putJson({ schemaVersion: 1, slimeArgs: args })
    await expect(c.createExperiment(spec)).rejects.toMatchObject({ code: 'iteration-schedule-too-short' })
    spec.trainer.hyperparametersRef = await store.putJson({ schemaVersion: 1, slimeArgs: [...args, '--lr-decay-iters', '1'] })
    await expect(c.createExperiment(spec)).rejects.toMatchObject({ code: 'iteration-schedule-too-short' })
    spec.trainer.hyperparametersRef = await store.putJson({ schemaVersion: 1, slimeArgs: [...args, '--lr-decay-iters', '2'] })
    expect((await c.createExperiment(spec)).iteration?.status).toBe('running')
  })

  it.each([
    ['--lr', '0.000001', '--lr=0', '--lr-decay-style', 'constant', '--num-steps-per-rollout', '1'],
    ['--lr=0.000001', '--lr-decay-style=constant', '--lr-decay-style', 'linear', '--num-steps-per-rollout=1'],
    ['--lr=Infinity', '--lr-decay-style=constant', '--num-steps-per-rollout=1'],
    ['--lr=0.000001', '--lr-decay-style=constant', '--num-steps-per-rollout=2'],
  ])('rejects ambiguous or incompatible schedule argv %j', async (...slimeArgs) => {
    spec.trainer.hyperparametersRef = await store.putJson({ schemaVersion: 1, slimeArgs })
    await expect(controller().coordinator.createExperiment(spec)).rejects.toThrow()
  })

  it('runs two rounds through the public CLI without per-round admission', async () => {
    const selected = v2spec(spec), file = join(root, 'controller.json'), specFile = join(root, 'spec.json')
    await writeFile(specFile, JSON.stringify(selected))
    await writeFile(file, JSON.stringify({ schemaVersion: 2, storeRoot: root, deployment: deployment(), episodeTimeoutSeconds: 30,
      activationPath: join(root, 'active.json'), evaluationBindings: { bindingsFile: join(root, 'unused-map.json'), trustedReceiptSources: ['fixture-deployer'] },
      hitch: { command: ['unused-hitch'], python: ['unused-python'], root: join(root, 'hitch'), workspace: join(root, 'workspace'),
        harnessSourceDirectory: root, budgets: { timeoutSeconds: 30, setupTimeoutSeconds: 30, maxConcurrent: 1,
          maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 } } }))
    vi.spyOn(NodeSlimeModelTrainer.prototype, 'preflight').mockImplementation(request => trainer.preflight(request))
    vi.spyOn(NodeSlimeModelTrainer.prototype, 'control').mockImplementation((request, key, intent) => trainer.control(request, key, intent))
    vi.spyOn(NodeSlimeModelTrainer.prototype, 'inspect').mockImplementation(handle => trainer.inspect(handle))
    vi.spyOn(NodeSlimeModelTrainer.prototype, 'collect').mockImplementation(handle => trainer.collect(handle))
    vi.spyOn(HitchModelEvaluator.prototype, 'evaluate').mockImplementation(request => evaluator.evaluate(request))
    vi.spyOn(HitchModelEvaluator.prototype, 'observeUsage').mockImplementation(() => evaluator.observeUsage())
    vi.spyOn(ExternalFileEndpointPreparer.prototype, 'prepare').mockImplementation(async model => fixtureEndpointBinding(model))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await trainingCommand(['iterate', specFile, '--config', file]) as T.ModelExperimentState
    expect(result.iteration?.status).toBe('completed'); expect(Object.keys(result.runs)).toHaveLength(2)
    expect(result.champion.revision).toBe(2); expect(trainer.submissions).toBe(2)
  })
})
