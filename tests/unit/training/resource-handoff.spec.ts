import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { TrainingContractError } from '../../../src/training/schema.js'
import type { ModelTrainingSpecV2 } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'

describe('v2 GPU ownership across asynchronous evaluation and recovery', () => {
  let root: string, store: ModelTrainingStore, trainer: FixtureTrainer, evaluator: FixtureEvaluator, spec: ModelTrainingSpecV2, coordinator: ModelTrainingCoordinator
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-handoff-')); store = new ModelTrainingStore(root)
    trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store); spec = v2spec(await fixture(store))
    coordinator = new ModelTrainingCoordinator(store, trainer, evaluator)
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  async function admit() { const experiment = await coordinator.createExperiment(spec); return { experiment, run: await coordinator.admit(experiment.id) } }
  it('orders baseline cancellation before a delayed first evaluator call and sends a newer explicit resume', async () => {
    let entered!: () => void, release!: () => void, first = true
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const commands = new Map<string, number>(), seen: string[] = []
    coordinator = new ModelTrainingCoordinator(store, trainer, {
      observeUsage: () => evaluator.observeUsage(),
      evaluate: async (request, key, intent) => {
        seen.push(`${intent!.action}:${intent!.sequence}`)
        if (first) { first = false; entered(); await waiting }
        if ((commands.get(key) ?? -1) > intent!.sequence) throw new TrainingContractError('eval_control_stale', 'newer pause fences evaluation')
        commands.set(key, intent!.sequence)
        return evaluator.evaluate(request)
      },
      cancel: async (_request, key, intent) => {
        seen.push(`${intent!.action}:${intent!.sequence}`); commands.set(key, intent!.sequence)
        return { resourcesReleased: true, gpuSeconds: 0 }
      },
    })
    const { experiment, run } = await admit(), advancing = coordinator.advance(experiment.id, run.id)
    void advancing.catch(() => {})
    try { await ready; expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused') }
    finally { release() }
    expect((await advancing).execution).toBe('paused'); expect(evaluator.calls).toHaveLength(0)
    expect((await coordinator.resume(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(seen.slice(0, 3)).toEqual(['start:0', 'pause:1', 'start:2'])
    expect(evaluator.calls).toHaveLength(4); expect(trainer.submissions).toBe(1)
  })
  it('fences a first start delayed past pause and resumes the same job only with a newer intent', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const control = trainer.control.bind(trainer)
    const commands: unknown[] = []
    vi.spyOn(trainer, 'control').mockImplementation(async (request, key, intent) => {
      commands.push(structuredClone(intent))
      if (intent.sequence === 0 && intent.action === 'start') { entered(); await waiting }
      return control(request, key, intent)
    })
    const { experiment, run } = await admit(), advancing = coordinator.advance(experiment.id, run.id)
    void advancing.catch(() => {})
    let originalHandle
    try {
      await ready
      const paused = await coordinator.pause(experiment.id, run.id)
      expect(paused.execution).toBe('paused'); expect(paused.resourcesReleased).toBe(true)
      expect(paused.usage.gpuSeconds).toBe(0); expect(trainer.submissions).toBe(0)
      originalHandle = paused.handle
    } finally { release() }
    expect((await advancing).execution).toBe('paused'); expect(trainer.submissions).toBe(0)
    const restored = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator)
    const completed = await restored.resume(experiment.id, run.id)
    expect(completed.decision?.outcome).toBe('accepted'); expect(completed.handle).toEqual(originalHandle)
    expect(commands).toEqual([{ schemaVersion: 2, sequence: 0, action: 'start' }, { schemaVersion: 2, sequence: 1, action: 'pause' }, { schemaVersion: 2, sequence: 2, action: 'start' }])
    expect(evaluator.calls).toHaveLength(4); expect(trainer.submissions).toBe(1)
  })
  function isolated() {
    spec.deployment.gpuScheduling.trainEvaluation = 'isolated'; spec.resources.evaluationDevices[0]!.gpuUuid = 'GPU-456'
    trainer.released = false
    const meter = { seconds: 1 }, inspect = trainer.inspect.bind(trainer), collect = trainer.collect.bind(trainer)
    vi.spyOn(trainer, 'inspect').mockImplementation(async handle => { const status = await inspect(handle); return { ...status, usage: { ...status.usage, gpuSeconds: meter.seconds } } })
    vi.spyOn(trainer, 'collect').mockImplementation(async handle => { const artifacts = await collect(handle); return { ...artifacts, usage: { ...artifacts.usage, gpuSeconds: meter.seconds } } })
    vi.spyOn(trainer, 'cancel').mockImplementation(handle => trainer.inspect(handle))
    return meter
  }
  it('reconciles a baseline that occupies the shared GPU and rechecks readiness after the baseline releases it', async () => {
    let occupied = false, attempts = 0
    const evaluate = evaluator.evaluate.bind(evaluator), preflight = trainer.preflight.bind(trainer)
    vi.spyOn(evaluator, 'evaluate').mockImplementation(async request => {
      if (!request.model.trainingRunId && request.condition.partition === 'dev' && attempts++ === 0) {
        occupied = true; throw new TrainingContractError('evaluation-pending', 'baseline still owns the GPU')
      }
      occupied = false; return evaluate(request)
    })
    const checks: boolean[] = []
    vi.spyOn(trainer, 'preflight').mockImplementation(async request => {
      checks.push(occupied); return { ...await preflight(request), blockers: occupied ? ['training-gpu-pool-occupied'] : [] }
    })
    const { experiment, run } = await admit()
    expect((await coordinator.advance(experiment.id, run.id)).evaluationResourcesReleased).toBe(false)
    const resumed = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator)
    expect((await resumed.advance(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(checks).toEqual([false, false])
    expect(trainer.submissions).toBe(1); expect(evaluator.calls).toHaveLength(4)
  })
  it('reconciles an uncertain submission without demanding that its own training GPU be idle', async () => {
    const preflight = trainer.preflight.bind(trainer)
    vi.spyOn(trainer, 'preflight').mockImplementation(async request => ({ ...await preflight(request), blockers: trainer.submissions ? ['training-gpu-pool-occupied'] : [] }))
    trainer.failSubmitOnce = true
    const { experiment, run } = await admit()
    await expect(coordinator.advance(experiment.id, run.id)).rejects.toThrow('reply lost')
    expect((await coordinator.inspect(experiment.id, run.id)).resourcesReleased).toBe(false)
    const resumed = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator)
    expect((await resumed.advance(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(trainer.submissions).toBe(1); expect(evaluator.calls).toHaveLength(4)
  })
  it('does not submit when pause wins while the post-baseline preflight is in flight', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const preflight = trainer.preflight.bind(trainer)
    vi.spyOn(trainer, 'preflight').mockImplementation(async request => {
      if (evaluator.calls.length === 2) { entered(); await waiting }
      return preflight(request)
    })
    const { experiment, run } = await admit(), advancing = coordinator.advance(experiment.id, run.id)
    void advancing.catch(() => {})
    try { await ready; expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused') }
    finally { release() }
    expect((await advancing).execution).toBe('paused'); expect(trainer.submissions).toBe(0)
    expect(evaluator.calls).toHaveLength(2)
  })
  it('retains a late valid export without undoing pause or dispatching candidate evaluation', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const collect = trainer.collect.bind(trainer)
    vi.spyOn(trainer, 'collect').mockImplementation(async handle => {
      const artifacts = await collect(handle); entered(); await waiting; return artifacts
    })
    const { experiment, run } = await admit(), advancing = coordinator.advance(experiment.id, run.id)
    void advancing.catch(() => {})
    try { await ready; expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused') }
    finally { release() }
    const paused = await advancing
    expect(paused.execution).toBe('paused'); expect(paused.decision).toBeUndefined()
    expect(paused.artifactsRef).toBeDefined(); expect(paused.resourcesReleased).toBe(true)
    expect(evaluator.calls).toHaveLength(2); expect(trainer.submissions).toBe(1)
    expect((await coordinator.resume(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(evaluator.calls).toHaveLength(4); expect(trainer.submissions).toBe(1)
  })
  it('still rejects runtime drift after baseline release and reuses completed baseline evidence on retry', async () => {
    let drift = true
    const preflight = trainer.preflight.bind(trainer)
    vi.spyOn(trainer, 'preflight').mockImplementation(async request => ({ ...await preflight(request), blockers: drift && evaluator.calls.length >= 2 ? ['runtime-drift'] : [] }))
    const { experiment, run } = await admit()
    await expect(coordinator.advance(experiment.id, run.id)).rejects.toThrow('runtime-drift')
    expect(trainer.submissions).toBe(0); expect(evaluator.calls).toHaveLength(2)
    expect((await coordinator.inspect(experiment.id, run.id)).resourcesReleased).toBe(true)
    drift = false
    expect((await coordinator.advance(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(evaluator.calls).toHaveLength(4); expect(trainer.submissions).toBe(1)
  })
  for (const finalCost of [8, 101]) it(`waits for the isolated training owner and charges its final ${finalCost} GPU seconds before deciding`, async () => {
    const meter = isolated(), { experiment, run } = await admit()
    const pending = await coordinator.advance(experiment.id, run.id)
    expect(pending.decision).toBeUndefined(); expect(pending.phase).toBe('evaluating'); expect(pending.resourcesReleased).toBe(false)
    expect(trainer.cancel).toHaveBeenCalledTimes(1); expect(evaluator.calls).toHaveLength(4)
    meter.seconds = finalCost; trainer.released = true
    const resumed = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator)
    const done = await resumed.advance(experiment.id, run.id)
    expect(done.decision?.outcome).toBe(finalCost > spec.budgets.totalGpuSeconds ? 'rejected' : 'accepted')
    if (finalCost > spec.budgets.totalGpuSeconds) expect(done.decision?.reasons).toContain('experiment-budget-exceeded')
    expect(done.usage.gpuSeconds).toBe(finalCost); expect(done.resourcesReleased).toBe(true)
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(finalCost)
    expect(trainer.submissions).toBe(1); expect(evaluator.calls).toHaveLength(4)
  })
  it('keeps accounting for an unreleased trainer while isolated candidate evaluation is pending', async () => {
    const meter = isolated(), evaluate = evaluator.evaluate.bind(evaluator)
    vi.spyOn(evaluator, 'evaluate').mockImplementation(request => {
      if (request.model.trainingRunId) throw new TrainingContractError('evaluation-pending', 'candidate still running')
      return evaluate(request)
    })
    const { experiment, run } = await admit()
    await coordinator.advance(experiment.id, run.id)
    meter.seconds = 19
    const pending = await coordinator.advance(experiment.id, run.id)
    expect(pending.usage.gpuSeconds).toBe(19); expect(pending.phase).toBe('evaluating')
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(19)
    expect(pending.decision).toBeUndefined(); expect(pending.resourcesReleased).toBe(false)
  })
  for (const state of ['evaluation-pending', 'evaluation-offline', 'training-offline']) it(`pause cancels both owners when ${state}`, async () => {
    const meter = isolated(), evaluate = evaluator.evaluate.bind(evaluator), evaluationCancel = vi.fn(async () => ({ resourcesReleased: false, gpuSeconds: 6 }))
    coordinator = new ModelTrainingCoordinator(store, trainer, { evaluate: request => {
      if (request.model.trainingRunId) throw new TrainingContractError('evaluation-pending', 'candidate still owns eval GPU')
      return evaluate(request)
    }, observeUsage: () => evaluator.observeUsage(), cancel: evaluationCancel })
    const { experiment, run } = await admit(); await coordinator.advance(experiment.id, run.id)
    meter.seconds = 9
    if (state === 'training-offline') vi.mocked(trainer.cancel).mockRejectedValueOnce(new Error('model node disconnected'))
    if (state === 'evaluation-offline') evaluationCancel.mockRejectedValueOnce(new Error('Harbor disconnected'))
    if (state.endsWith('-offline')) await expect(coordinator.pause(experiment.id, run.id)).rejects.toThrow('disconnected')
    else await coordinator.pause(experiment.id, run.id)
    expect(trainer.cancel).toHaveBeenCalledTimes(1); expect(evaluationCancel).toHaveBeenCalledTimes(1)
    const pending = await coordinator.inspect(experiment.id, run.id)
    expect(pending.execution).toBe('pausing'); expect(pending.resourcesReleased).toBe(false)
    if (state !== 'training-offline') expect(pending.usage.gpuSeconds).toBe(9)
    trainer.released = true; evaluationCancel.mockResolvedValue({ resourcesReleased: true, gpuSeconds: 6 })
    expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused')
    expect((await store.load(experiment.id)).usage.gpuSeconds).toBe(15)
  })
  it('retains a late dev result after pause without admitting held-out work or promoting until explicit resume', async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    evaluator.beforeReturn = async () => { if (evaluator.calls.length === 3) { entered(); await waiting } }
    coordinator = new ModelTrainingCoordinator(store, trainer, { evaluate: request => evaluator.evaluate(request),
      observeUsage: () => evaluator.observeUsage(),
      cancel: async () => ({ resourcesReleased: true, gpuSeconds: 0 }) })
    const { experiment, run } = await admit(), advancing = coordinator.advance(experiment.id, run.id)
    void advancing.catch(() => {})
    try {
      await ready
      expect((await coordinator.pause(experiment.id, run.id)).execution).toBe('paused')
    } finally { release() }
    const paused = await advancing
    expect(paused.execution).toBe('paused'); expect(paused.decision).toBeUndefined(); expect(paused.heldOutQueries).toBe(0)
    expect(paused.evaluationIntents['candidate:dev']?.evidenceRef).toBeDefined()
    expect(evaluator.calls).toHaveLength(3)
    expect((await coordinator.resume(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(evaluator.calls).toHaveLength(4); expect(trainer.submissions).toBe(1)
  })
})
