import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import type { ModelTrainingSpecV1 } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer, fixtureEndpointPreparer } from './fixture.js'

describe('durable keyed training admission', () => {
  let root: string, store: ModelTrainingStore, trainer: FixtureTrainer, spec: ModelTrainingSpecV1
  const coordinator = () => new ModelTrainingCoordinator(store, trainer, new FixtureEvaluator(store), fixtureEndpointPreparer)
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-admission-replay-'))
    store = new ModelTrainingStore(root); spec = await fixture(store); trainer = new FixtureTrainer(store)
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

  it('recovers an experiment creation reply gap and fences changed inputs', async () => {
    const create = store.create.bind(store)
    const interrupted = vi.spyOn(store, 'create').mockImplementationOnce(async state => {
      await create(state); throw new Error('creation reply lost after fsync')
    })
    await expect(coordinator().createExperiment(spec, 'round-0/challenger')).rejects.toThrow('reply lost')
    interrupted.mockRestore()
    const first = await coordinator().createExperiment(spec, 'round-0/challenger')
    const replay = await coordinator().createExperiment(spec, 'round-0/challenger')
    expect(replay).toEqual(first)
    await expect(coordinator().createExperiment({ ...spec, name: 'different task scope' }, 'round-0/challenger'))
      .rejects.toMatchObject({ code: 'training-idempotency-drift' })
    expect(trainer.submissions).toBe(0)
  })

  it('serializes concurrent callers and replays a completed admission without another update', async () => {
    const experiments = await Promise.all(Array.from({ length: 4 }, () => coordinator().createExperiment(spec, 'shared')))
    expect(new Set(experiments.map(value => value.id)).size).toBe(1)
    const id = experiments[0]!.id
    const runs = await Promise.all(Array.from({ length: 4 }, () => coordinator().admit(id, undefined, 'solver-0')))
    expect(new Set(runs.map(value => value.id)).size).toBe(1)
    const finished = await coordinator().advance(id, runs[0]!.id)
    expect(finished.decision?.outcome).toBe('accepted')
    const before = await store.load(id)
    expect(await coordinator().admit(id, undefined, 'solver-0')).toEqual(finished)
    expect(await coordinator().createExperiment(spec, 'shared')).toEqual(before)
    expect(await store.load(id)).toEqual(before)
    expect(trainer.submissions).toBe(1)
    const next = await coordinator().admit(id, undefined, 'solver-1')
    expect(next.id).not.toBe(finished.id)
    expect(next.request.coldStart).toBe(false)
    expect(next.request.resumeCheckpointRef).toBeDefined()
  })

  it('reconciles an admission reply gap while preserving pause and frozen budgets', async () => {
    const experiment = await coordinator().createExperiment(spec, 'reply-gap')
    const transaction = store.transaction.bind(store)
    const interrupted = vi.spyOn(store, 'transaction').mockImplementationOnce(async (id, operation) => {
      await transaction(id, operation); throw new Error('admission reply lost after fsync')
    })
    await expect(coordinator().admit(experiment.id, undefined, 'slot')).rejects.toThrow('reply lost')
    interrupted.mockRestore()
    const run = await coordinator().admit(experiment.id, undefined, 'slot')
    await store.transaction(experiment.id, state => { state.runs[run.id]!.execution = 'paused' })
    const replay = await coordinator().admit(experiment.id, undefined, 'slot')
    expect(replay.execution).toBe('paused')
    expect(replay.request).toEqual(run.request)
    expect(Object.keys((await store.load(experiment.id)).runs)).toEqual([run.id])
    await expect(coordinator().admit(experiment.id, undefined, 'another-slot')).rejects.toMatchObject({ code: 'training-run-active' })
    await expect(coordinator().admit(experiment.id, 0, 'slot')).rejects.toMatchObject({ code: 'training-idempotency-scope' })
  })

  it('rejects empty or ambiguous keys and keeps unkeyed creation behavior', async () => {
    for (const key of ['', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(257)]) {
      await expect(coordinator().createExperiment(spec, key)).rejects.toMatchObject({ code: 'invalid-training-idempotency-key' })
    }
    const first = await coordinator().createExperiment(spec), second = await coordinator().createExperiment(spec)
    expect(first.id).not.toBe(second.id)
  })
})
