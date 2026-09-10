import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelTrainingCoordinator, trainingCompatibilityDigest } from '../../../src/training/coordinator.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { parseModelTrainingSpec, TrainingContractError } from '../../../src/training/schema.js'
import { pairModelEvidence, modelEvaluationRequest } from '../../../src/training/evaluation.js'
import { digestJson } from '../../../src/training/digest.js'
import type { ModelVersion, ModelTrainingSpecV1 as ModelTrainingSpec } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'

describe('model training control plane (CPU contract providers)', () => {
  let root: string, store: ModelTrainingStore, trainer: FixtureTrainer, evaluator: FixtureEvaluator, coordinator: ModelTrainingCoordinator, spec: ModelTrainingSpec
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gear-training-')); store = new ModelTrainingStore(root); trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store); coordinator = new ModelTrainingCoordinator(store, trainer, evaluator); spec = await fixture(store) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('rejects split-family leakage, sampling drift, GPU overlap and invalid batch layout', () => {
    for (const mutate of [
      (s: ModelTrainingSpec) => { s.datasets.dev.tasks[0]!.family = 'train' },
      (s: ModelTrainingSpec) => { s.rollout.sampling.topP = .9 as 1 },
      (s: ModelTrainingSpec) => { s.resources.mode = 'isolated' },
      (s: ModelTrainingSpec) => { s.trainer.globalBatchSize = 3 },
    ]) { const s = structuredClone(spec); mutate(s); expect(() => parseModelTrainingSpec(s)).toThrow() }
  })
  it('serializes concurrent state transactions and rejects persisted request drift', async () => {
    const experiment = await coordinator.createExperiment(spec)
    await Promise.all(Array.from({ length: 6 }, () => store.transaction(experiment.id, async s => {
      const prior = s.usage.gpuSeconds
      await new Promise(resolve => setTimeout(resolve, 10))
      s.usage.gpuSeconds = prior + 1
    })))
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(6)
    const run = await coordinator.admit(experiment.id)
    await store.transaction(experiment.id, s => { s.runs[run.id]!.request.fixedHarness.commit = 'f'.repeat(40) })
    await expect(store.load(experiment.id)).rejects.toMatchObject({ code: 'training-request-drift' })
  })
  it('requires explicit colocation for one GPU and freezes it into the training request', async () => {
    spec.resources.trainingDevices = ['GPU-fixture']
    expect(() => parseModelTrainingSpec(spec)).toThrow('GPU pool')
    spec.trainer.placement = 'colocated'
    expect(parseModelTrainingSpec(spec).resources).toHaveProperty('mode', 'sequential')
    const e = await coordinator.createExperiment(spec); const run = await coordinator.admit(e.id)
    expect(run.request.trainer.placement).toBe('colocated')
    expect(run.request.trainingDevices).toEqual(['GPU-fixture'])
    const separate = structuredClone(run.request); separate.trainer.placement = 'separate'
    expect(trainingCompatibilityDigest(separate)).not.toBe(trainingCompatibilityDigest(run.request))
    spec.trainer.dataParallelSize = 2
    expect(() => parseModelTrainingSpec(spec)).toThrow('GPU pool')
  })
  it('retains the legacy separate placement default with two GPUs', async () => {
    const e = await coordinator.createExperiment(spec); const run = await coordinator.admit(e.id)
    const explicit = structuredClone(run.request); explicit.trainer.placement = 'separate'
    expect(trainingCompatibilityDigest(explicit)).toBe(trainingCompatibilityDigest(run.request))
    spec.trainer.placement = 'automatic' as 'separate'
    expect(() => parseModelTrainingSpec(spec)).toThrow()
  })
  it('accepts only independently evaluated weights and resumes the accepted optimizer', async () => {
    const experiment = await coordinator.createExperiment(spec); const run = await coordinator.admit(experiment.id)
    const done = await coordinator.advance(experiment.id, run.id)
    expect(done.decision?.outcome).toBe('accepted'); expect(evaluator.calls).toHaveLength(4)
    expect(JSON.stringify(trainer.requests[0])).not.toContain('heldOut')
    expect(JSON.stringify(trainer.requests[0])).not.toContain('task":"dev')
    expect((await store.load(experiment.id)).activeReleaseId).toBeUndefined()
    const next = await coordinator.admit(experiment.id)
    expect(next.request.coldStart).toBe(false); expect(next.request.resumeCheckpointRef).toBeDefined()
    expect(next.request.referenceModelRef).toEqual(spec.referenceModel)
    await coordinator.advance(experiment.id, next.id)
    expect(evaluator.calls).toHaveLength(5) // New champion's two complete baselines were reused; no dev gain, no held-out query.
    expect((await coordinator.inspect(experiment.id, next.id)).decision?.outcome).toBe('rejected')
  })
  it('retains the old champion and cold start after rejecting the candidate', async () => {
    evaluator.candidateReward = 0
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    expect((await coordinator.advance(e.id, r.id)).decision?.outcome).toBe('rejected')
    const state = await store.load(e.id); expect(state.champion.modelRef).toEqual(spec.initialModel); expect(state.champion.revision).toBe(0)
    expect(evaluator.calls).toHaveLength(3)
    const next = await coordinator.admit(e.id); expect(next.request.coldStart).toBe(true)
  })
  it('reconciles a lost submit reply without creating another training job', async () => {
    trainer.failSubmitOnce = true
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    await expect(coordinator.advance(e.id, r.id)).rejects.toThrow('reply lost')
    const restarted = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator)
    expect((await restarted.advance(e.id, r.id)).decision?.outcome).toBe('accepted'); expect(trainer.submissions).toBe(1)
  })
  it('blocks official submission while cloud GPU probes are pending', async () => {
    spec.trainer.runtimeLock.validation = 'pending-gpu'; spec.trainer.runtimeLock.probeEvidenceRefs = []
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    await expect(coordinator.advance(e.id, r.id)).rejects.toThrow('GPU compatibility probes')
    expect(trainer.submissions).toBe(0); expect(evaluator.calls).toHaveLength(0)
  })
  it('does not close or submit training while baseline cancellation is pending', async () => {
    let released = false
    coordinator = new ModelTrainingCoordinator(store, trainer, {
      evaluate: async () => { throw new TrainingContractError('evaluation-pending', 'still evaluating') },
      cancel: async () => ({ resourcesReleased: released, gpuSeconds: 2 }),
    })
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    expect((await coordinator.advance(e.id, r.id)).execution).toBe('running')
    expect((await coordinator.pause(e.id, r.id)).evaluationResourcesReleased).toBe(false)
    await expect(coordinator.close(e.id, r.id)).rejects.toMatchObject({ code: 'gpu-not-released' })
    expect(trainer.submissions).toBe(0)
    released = true
    expect((await coordinator.close(e.id, r.id)).decision?.outcome).toBe('inconclusive')
    expect((await coordinator.close(e.id, r.id)).decision?.outcome).toBe('inconclusive')
    expect((await store.load(e.id)).usage.gpuSeconds).toBe(2)
  })
  it('requires training resource release before a sequential evaluation', async () => {
    trainer.released = false
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    await expect(coordinator.advance(e.id, r.id)).rejects.toThrow('GPU release')
    expect(evaluator.calls).toHaveLength(2)
  })
  it('does not promote across champion CAS conflicts', async () => {
    const e = await coordinator.createExperiment(spec); const r = await coordinator.admit(e.id)
    evaluator.beforeReturn = async () => { if (evaluator.calls.length === 4) await store.transaction(e.id, s => { s.champion.revision++ }) }
    expect((await coordinator.advance(e.id, r.id)).decision?.outcome).toBe('superseded')
    expect((await store.load(e.id)).champion.modelRef).toEqual(spec.initialModel)
  })
  it('retains release on activation failure and idempotently publishes / rolls back', async () => {
    const e = await coordinator.createExperiment(spec)
    await expect(coordinator.publish(e.id, { activate: async () => { throw new Error('activation failed') } })).rejects.toThrow('activation failed')
    const pending = await store.load(e.id); expect(pending.activeReleaseId).toBeUndefined(); expect(pending.activationIntent).toBeDefined()
    const publisher = { activate: async (model: ModelVersion, activationId: string) => ({ activationId, modelVersionId: model.id, active: true as const }) }
    const initial = await coordinator.publish(e.id, publisher)
    const r = await coordinator.admit(e.id); await coordinator.advance(e.id, r.id)
    const second = await coordinator.publish(e.id, publisher)
    expect(second.modelRef.digest).not.toEqual(initial.modelRef.digest)
    const rollback = await coordinator.publish(e.id, publisher, initial.id)
    expect(rollback.modelRef).toEqual(initial.modelRef); expect(rollback.previousReleaseId).toBe(second.id)
  })
  it('rejects changed harness/template in a model comparison and counts task uncertainty', async () => {
    const model = await store.readJson<ModelVersion>(spec.initialModel)
    const request = modelEvaluationRequest(spec, model, spec.initialModel, 'dev')
    const a = await evaluator.evaluate(request); const b = structuredClone(a)
    expect(pairModelEvidence(a, b).standardError).toBeNull() // two attempts are still one task
    b.condition.chatTemplateDigest = digestJson('different-template'); b.evidenceKey = digestJson({ subject: b.subject, condition: b.condition })
    expect(() => pairModelEvidence(a, b)).toThrow('weights only')
  })
})
