import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { TrainingContractError } from '../../../src/training/schema.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'
import type { ModelTrainingSpecV2 } from '../../../src/training/types.js'

describe('durable evaluation accounting', () => {
  let root: string, store: ModelTrainingStore, trainer: FixtureTrainer, evaluator: FixtureEvaluator, spec: ModelTrainingSpecV2
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-eval-usage-')); store = new ModelTrainingStore(root)
    trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store); spec = v2spec(await fixture(store))
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  it('charges one cumulative baseline key across closed runs and migrates evidence-only charges', async () => {
    let complete = false
    const keys: string[] = []
    const coordinator = new ModelTrainingCoordinator(store, trainer, {
      observeUsage: () => evaluator.observeUsage(),
      evaluate: async (request, key) => {
        const evidence = await evaluator.evaluate(request)
        if (!request.model.trainingRunId && request.condition.partition === 'dev') {
          keys.push(key); evidence.gpuSeconds = complete ? 10 : 7; evidence.complete = complete
          if (!complete) evidence.trials[0]!.valid = false
        }
        return evidence
      },
      cancel: async () => ({ resourcesReleased: true, gpuSeconds: 7 }),
    })
    const experiment = await coordinator.createExperiment(spec), first = await coordinator.admit(experiment.id)
    await expect(coordinator.advance(experiment.id, first.id)).rejects.toMatchObject({ code: 'incomplete-evaluation' })
    await coordinator.close(experiment.id, first.id)
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(7)
    await store.transaction(experiment.id, state => { delete state.runs[first.id]!.evaluationIntents['baseline:dev']!.chargedGpuSeconds })
    complete = true
    const second = await coordinator.admit(experiment.id)
    expect((await coordinator.advance(experiment.id, second.id)).decision?.outcome).toBe('accepted')
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(11) // 10 evaluation + 1 training
  })
  it('meters pending work across restart and pauses at the budget until physical release is confirmed', async () => {
    spec.budgets.totalGpuSeconds = 10
    let usage = 7, released = false
    const evaluate = vi.fn(async () => { throw new TrainingContractError('evaluation-pending', 'running') })
    const cancel = vi.fn(async (_request: unknown, _key: string, _intent?: unknown) => ({ resourcesReleased: released, gpuSeconds: ++usage }))
    const provider = { evaluate, observeUsage: async () => ({ gpuSeconds: usage }), cancel }
    let coordinator = new ModelTrainingCoordinator(store, trainer, provider)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await coordinator.advance(experiment.id, run.id)
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(7)
    usage = 11; coordinator = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, provider)
    const pausing = await coordinator.advance(experiment.id, run.id)
    expect(pausing.execution).toBe('pausing'); expect(pausing.evaluationResourcesReleased).toBe(false)
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(12)
    expect(evaluate).toHaveBeenCalledTimes(1); expect(trainer.submissions).toBe(0)
    expect(cancel.mock.calls[0]![2]).toMatchObject({ action: 'pause', sequence: 1 })
    released = true
    expect((await coordinator.advance(experiment.id, run.id)).execution).toBe('paused')
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(13)
    expect((await coordinator.inspect(experiment.id, run.id)).decision).toBeUndefined()
    await expect(coordinator.resume(experiment.id, run.id)).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect(trainer.submissions).toBe(0); expect(evaluate).toHaveBeenCalledTimes(1)
  })
  it('retains usage and ownership while observation is offline, then reconciles the original pending key', async () => {
    let usage = 4, offline = false
    const keys: string[] = []
    const coordinator = new ModelTrainingCoordinator(store, trainer, {
      evaluate: async (_request, key) => { keys.push(key); throw new TrainingContractError('evaluation-pending', 'running') },
      observeUsage: async () => { if (offline) throw new Error('model node disconnected'); return { gpuSeconds: usage } },
    })
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await coordinator.advance(experiment.id, run.id)
    offline = true
    await expect(coordinator.advance(experiment.id, run.id)).rejects.toThrow('model node disconnected')
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(4)
    expect((await coordinator.inspect(experiment.id, run.id)).evaluationResourcesReleased).toBe(false)
    expect(keys).toHaveLength(1)
    offline = false; usage = 6
    expect((await coordinator.advance(experiment.id, run.id)).execution).toBe('running')
    expect(keys[0]).toBe(keys[1]); expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(6)
  })
  it('keeps the newer cancellation charge when valid evidence arrives with an older cost snapshot', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const coordinator = new ModelTrainingCoordinator(store, trainer, {
      observeUsage: async () => ({ gpuSeconds: 7 }),
      evaluate: async request => { const evidence = await evaluator.evaluate(request); entered(); await waiting; return { ...evidence, gpuSeconds: 5 } },
      cancel: async () => ({ resourcesReleased: true, gpuSeconds: 7 }),
    })
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    const advancing = coordinator.advance(experiment.id, run.id); void advancing.catch(() => {})
    try { await ready; await coordinator.pause(experiment.id, run.id) } finally { release() }
    const paused = await advancing
    expect(paused.execution).toBe('paused'); expect(paused.evaluationIntents['baseline:dev']!.evidenceRef).toBeDefined()
    expect(paused.evaluationIntents['baseline:dev']!.chargedGpuSeconds).toBe(7)
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(7)
    expect(trainer.submissions).toBe(0)
  })
  it('rejects invalid observed cost without clearing the admitted evaluation', async () => {
    const coordinator = new ModelTrainingCoordinator(store, trainer, {
      evaluate: async () => { throw new TrainingContractError('evaluation-pending', 'running') },
      observeUsage: async () => ({ gpuSeconds: Number.NaN }),
    })
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await expect(coordinator.advance(experiment.id, run.id)).rejects.toMatchObject({ code: 'invalid-evaluation-usage' })
    const state = await store.load(experiment.id)
    expect(state.usage.gpuSeconds).toBe(0); expect(state.runs[run.id]!.evaluationResourcesReleased).toBe(false)
    expect(state.runs[run.id]!.execution).toBe('blocked')
  })
})
