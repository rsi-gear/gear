import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { chargeEvaluationUsage } from '../../../src/training/evaluation-usage.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { TrainingContractError } from '../../../src/training/schema.js'
import { fixture, fixtureEndpointBinding, fixtureEndpointPreparer, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'
import type { EvaluationUsage, ModelTrainingSpecV2 } from '../../../src/training/types.js'

describe('shared endpoint usage and explicit training GPU budgets', () => {
  let root: string, store: ModelTrainingStore, trainer: FixtureTrainer, evaluator: FixtureEvaluator, spec: ModelTrainingSpecV2
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-eval-usage-')); store = new ModelTrainingStore(root)
    trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store); spec = v2spec(await fixture(store))
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('finishes external evaluation at exactly the training budget and refuses another training admission', async () => {
    spec.budgets.totalGpuSeconds = 1
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    expect((await coordinator.advance(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    const state = await store.load(experiment.id)
    expect(state.usage.gpuSeconds).toBe(1)
    expect(state.evaluationUsage).toMatchObject({ gpuSeconds: null, gpuSecondsSource: null })
    await expect(coordinator.admit(experiment.id)).rejects.toMatchObject({ code: 'budget-exhausted' })
  })
  it('resumes waiting candidate deployment at the training limit without starting training again', async () => {
    spec.budgets.totalGpuSeconds = 1
    let ready = false
    const preparer = { ...fixtureEndpointPreparer, prepare: async (model: Parameters<typeof fixtureEndpointBinding>[0]) =>
      model.trainingRunId && !ready ? undefined : fixtureEndpointBinding(model) }
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, preparer)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    const pending = await coordinator.advance(experiment.id, run.id)
    expect(pending.phase).toBe('evaluating'); expect(pending.error).toContain('waiting for externally prepared')
    expect(pending.usage.gpuSeconds).toBe(1); expect(trainer.submissions).toBe(1)
    expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused')
    ready = true
    expect((await coordinator.resume(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(trainer.submissions).toBe(1)
  })
  it('requires an explicit scope and rejects a total hard budget without inference attribution', async () => {
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer)
    const { gpuSecondsScope: _, ...oldBudgets } = spec.budgets
    for (const budgets of [oldBudgets, { ...oldBudgets, gpuSecondsScope: 'total' }]) {
      await expect(coordinator.createExperiment({ ...spec, budgets })).rejects.toMatchObject({ code: 'unsupported-gpu-budget-scope' })
    }
  })
  it('cancels task requests with unknown GPU cost without waiting for a shared service to release', async () => {
    let completed = false
    const provider = { evaluate: async () => { throw new TrainingContractError('evaluation-pending', 'running') },
      observeUsage: async () => ({ gpuSeconds: null, gpuSecondsSource: null }),
      cancel: async () => ({ tasksCompleted: completed, gpuSeconds: null, gpuSecondsSource: null }) }
    const coordinator = new ModelTrainingCoordinator(store, trainer, provider, fixtureEndpointPreparer)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await coordinator.advance(experiment.id, run.id)
    expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('pausing')
    completed = true
    const paused = await coordinator.pause(experiment.id, run.id)
    expect(paused.execution).toBe('paused'); expect(paused.evaluationTasksCompleted).toBe(true)
    expect((await store.load(experiment.id)).evaluationUsage?.gpuSeconds).toBeNull()
    expect(trainer.submissions).toBe(0)
  })
  async function ledger() {
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    await store.transaction(experiment.id, state => { state.runs[run.id]!.evaluationIntents = {
      'baseline:dev': { key: 'same-provider-task' }, 'duplicate:dev': { key: 'same-provider-task' },
    } })
    const charge = (usage: EvaluationUsage, intent = 'baseline:dev') => store.transaction(experiment.id,
      state => chargeEvaluationUsage(store, state, run.id, intent, usage))
    return { experiment, run, charge }
  }
  it('preserves a monotonic lower bound across known → unknown → known observations without double billing', async () => {
    const { experiment, run, charge } = await ledger()
    const metered = (gpuSeconds: number): EvaluationUsage => ({ gpuSeconds, gpuSecondsSource: 'deployment-meter-v1',
      inputTokens: 10, outputTokens: 5, requests: 2, usageSource: 'model-interactions-v1' })
    await charge(metered(7))
    expect((await store.load(experiment.id)).evaluationUsage).toMatchObject({ gpuSeconds: 7, requests: 2 })
    await charge({ gpuSeconds: null, gpuSecondsSource: null })
    let state = await store.load(experiment.id)
    expect(state.evaluationUsage?.gpuSeconds).toBeNull()
    expect(state.runs[run.id]!.evaluationIntents['baseline:dev']!.chargedGpuSeconds).toBe(7)
    await charge(metered(6), 'duplicate:dev')
    await charge(metered(9))
    state = await store.load(experiment.id)
    expect(state.evaluationUsage).toMatchObject({ gpuSeconds: 9, gpuSecondsSource: 'deployment-meter-v1', inputTokens: 10, outputTokens: 5, requests: 2 })
    expect(state.usage.gpuSeconds).toBe(0)
  })
  it('rejects invalid costs and mixed attribution sources even while aggregate GPU time is unknown', async () => {
    const { experiment, charge } = await ledger()
    await charge({ gpuSeconds: 4, gpuSecondsSource: 'meter-a' })
    await charge({ gpuSeconds: null, gpuSecondsSource: null })
    await expect(charge({ gpuSeconds: 8, gpuSecondsSource: 'meter-b' })).rejects.toMatchObject({ code: 'evaluation-metering-source-drift' })
    await expect(charge({ gpuSeconds: null, gpuSecondsSource: null, inputTokens: 3 })).rejects.toMatchObject({ code: 'invalid-evaluation-usage' })
    await expect(charge({ gpuSeconds: Number.NaN, gpuSecondsSource: 'meter-a' })).rejects.toMatchObject({ code: 'invalid-evaluation-usage' })
    expect((await store.load(experiment.id)).evaluationUsage?.gpuSeconds).toBeNull()
  })
})
