import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { ModelTrainingCoordinator, trainingCompatibilityDigest } from '../../../src/training/coordinator.js'
import { parseModelTrainingSpec } from '../../../src/training/schema.js'
import { digestJson } from '../../../src/training/digest.js'
import { readOfflineDataset, offlineWindow } from '../../../src/training/offline.js'
import { fixture, FixtureEvaluator } from './fixture.js'
import { offlineDataset, OfflineFixtureTrainer } from './offline-fixture.js'
import type * as T from '../../../src/training/types.js'

describe('versioned training recipes and offline SFT admission', () => {
  let root: string, store: ModelTrainingStore, spec: T.ModelTrainingSpecV1, trainer: OfflineFixtureTrainer, evaluator: FixtureEvaluator, coordinator: ModelTrainingCoordinator
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-recipes-')); store = new ModelTrainingStore(root); spec = await fixture(store)
    trainer = new OfflineFixtureTrainer(store); evaluator = new FixtureEvaluator(store); coordinator = new ModelTrainingCoordinator(store, trainer, evaluator)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  async function sft() {
    spec.trainer.recipe = 'offline-sft-v1'; spec.trainer.globalBatchSize = 1
    spec.resources.trainingDevices = ['GPU-fixture']
    spec.offlineTraining = await offlineDataset(store, await store.readJson(spec.initialModel), spec.datasets.train)
  }
  it('accepts versioned native estimators and rejects unsupported algorithms', () => {
    for (const recipe of ['agent-gspo-v1', 'agent-cispo-v1', 'agent-reinforce-plus-plus-v1', 'agent-reinforce-plus-plus-baseline-v1'] as const) {
      spec.trainer.recipe = recipe; expect(parseModelTrainingSpec(spec).trainer.recipe).toBe(recipe)
    }
    for (const recipe of ['ppo', 'agent-opd-v1', 'agent-gspo-v2']) {
      spec.trainer.recipe = recipe as T.TrainingRecipe; expect(() => parseModelTrainingSpec(spec)).toThrow()
    }
  })
  it('permits singleton REINFORCE++ while preserving baseline group requirements', () => {
    spec.trainer.recipe = 'agent-reinforce-plus-plus-v1'; spec.rollout.groupSize = 1; spec.trainer.globalBatchSize = 1
    expect(parseModelTrainingSpec(spec).rollout.groupSize).toBe(1)
    spec.trainer.recipe = 'agent-reinforce-plus-plus-baseline-v1'; expect(() => parseModelTrainingSpec(spec)).toThrow()
  })
  it('SFT ignores online grouping/sampling budgets and requires its sealed data contract', async () => {
    await sft(); spec.rollout.groupSize = 3; spec.rollout.sampling.maxNewTokens = 256
    expect(parseModelTrainingSpec(spec).trainer.recipe).toBe('offline-sft-v1')
    delete spec.offlineTraining; expect(() => parseModelTrainingSpec(spec)).toThrow('offlineTraining')
    spec.trainer.recipe = 'agent-grpo-v1'; spec.offlineTraining = {} as T.OfflineTraining
    expect(() => parseModelTrainingSpec(spec)).toThrow()
  })
  it('rejects evaluation examples, tool masks and unknown provenance before training', async () => {
    await sft()
    const config = spec.offlineTraining!, data = await store.readJson<T.OfflineSftDataset>(config.datasetRef)
    const row = await store.readJson<T.OfflineSftRecord>(data.records[0]!)
    for (const mutate of [
      (r: T.OfflineSftRecord) => { r.source.taskId = spec.datasets.dev.tasks[0]!.id },
      (r: T.OfflineSftRecord) => { r.source.family = spec.datasets.heldOut.tasks[0]!.family },
      (r: T.OfflineSftRecord) => { r.source.taskDigest = spec.datasets.dev.tasks[0]!.taskRef.digest },
      (r: T.OfflineSftRecord) => { r.lossMask[3] = 1 },
      (r: T.OfflineSftRecord) => { r.tokens[0] = 2147483648 },
    ]) {
      const altered = structuredClone(row); mutate(altered); const { id: _, ...body } = altered; altered.id = digestJson(body)
      spec.offlineTraining!.datasetRef = await store.putJson({ ...data, records: [await store.putJson(altered)] })
      await expect(coordinator.createExperiment(spec)).rejects.toThrow()
    }
    expect(trainer.submissions).toBe(0)
  })
  it('keeps independent evaluation and promotion with committed SFT cursors', async () => {
    await sft(); const experiment = await coordinator.createExperiment(spec); const run = await coordinator.admit(experiment.id)
    const finished = await coordinator.advance(experiment.id, run.id)
    expect(finished.decision?.outcome).toBe('accepted'); expect(evaluator.calls).toHaveLength(4)
    expect(trainer.requests[0]!.offlineTraining).toEqual(spec.offlineTraining)
    expect(JSON.stringify(trainer.requests[0])).not.toContain('heldOut')
    const next = await coordinator.admit(experiment.id)
    expect(next.request.coldStart).toBe(false)
    const checkpoint = await store.readJson<T.TrainerCheckpoint>(next.request.resumeCheckpointRef!)
    expect(await store.readJson(checkpoint.dataCursorRef)).toMatchObject({ position: 1, datasetDigest: spec.offlineTraining!.datasetRef.digest })
    expect((await store.load(experiment.id)).activeReleaseId).toBeUndefined()
  })
  it('rejects exhausted accepted parent before another GPU submission', async () => {
    await sft(); spec.offlineTraining!.maxEpochs = 1
    const data = await store.readJson<T.OfflineSftDataset>(spec.offlineTraining!.datasetRef)
    spec.offlineTraining!.datasetRef = await store.putJson({ ...data, records: data.records.slice(0, 1) })
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await coordinator.advance(experiment.id, run.id)
    await expect(coordinator.admit(experiment.id)).rejects.toMatchObject({ code: 'offline-dataset-exhausted' })
    expect(trainer.submissions).toBe(1)
  })
  it('preserves legacy GRPO digest and binds new recipe/shape/seed for resume', async () => {
    const experiment = await coordinator.createExperiment(spec); const { request } = await coordinator.admit(experiment.id)
    const legacy = digestJson({ backend: request.trainer.backend, runtimeLock: request.trainer.runtimeLock, hyperparametersRef: request.trainer.hyperparametersRef,
      placement: 'separate', trainingDeviceCount: request.trainingDevices.length, referenceModelRef: request.referenceModelRef,
      architecture: request.parentModel.architecture, dtype: request.parentModel.dtype,
      tokenizerDigest: request.parentModel.tokenizerDigest, chatTemplateDigest: request.parentModel.chatTemplateDigest })
    expect(trainingCompatibilityDigest(request)).toBe(legacy)
    request.trainer.recipe = 'agent-gspo-v1'; expect(trainingCompatibilityDigest(request)).not.toBe(legacy)
    const gspo = trainingCompatibilityDigest(request); request.trainer.rolloutBatchSize++; expect(trainingCompatibilityDigest(request)).not.toBe(gspo)
    request.trainer.recipe = 'offline-sft-v1'; request.offlineTraining = await offlineDataset(store, request.parentModel, request.trainDataset)
    const sft = trainingCompatibilityDigest(request); request.offlineTraining.shuffleSeed++; expect(trainingCompatibilityDigest(request)).not.toBe(sft)
  })
  it('orders the same SHA256 epoch window used by the Python sealed batch hook', async () => {
    await sft(); const config = spec.offlineTraining!, data = await readOfflineDataset(store, config.datasetRef,
      await store.readJson(spec.initialModel), spec.datasets.train, config.maxSequenceTokens)
    const expected = data.records.map((ref, index) => ({ ref, key: digestJson({ seed: 23, epoch: 0, index }) }))
      .sort((a, b) => a.key < b.key ? -1 : 1).map(item => item.ref)
    expect(offlineWindow(data.records, 23, 0, 4)).toEqual(expected)
    expect(offlineWindow(data.records, 23, 2, 6)).toHaveLength(6)
  })
})
