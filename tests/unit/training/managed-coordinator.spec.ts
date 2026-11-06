import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelIterationController, runIteration } from '../../../src/training/iteration.js'
import { iterationPolicy } from '../../../src/training/iteration-policy.js'
import { digestJson } from '../../../src/training/digest.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import type * as T from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer, fixtureEndpointBinding } from './fixture.js'
import { v2spec } from './placement-fixture.js'

/** Controlled lifecycle implementation: no GPU, SSH or external endpoint exists. */
class ManagedFixture implements T.ModelEndpointPreparer {
  mode = 'managed-native' as const
  configurationDigest = digestJson('managed-lifecycle-fixture')
  trustedReceiptSources = ['fixture-deployer']
  maxRuntimeSeconds = 60
  prepared: string[] = []
  consumers = new Map<string, { revision: string; released: boolean }>()
  alive = new Set<string>()
  fences: T.EndpointPreparationContext[] = []
  blockRelease = false
  ownersReleased = 0
  ownershipReleased = false
  loseOwnershipReplyOnce = false
  beforePrepare?: () => Promise<void>
  async prepare(model: T.ModelVersion, _ref: T.ContentRef, context?: T.EndpointPreparationContext) {
    await this.beforePrepare?.()
    const fence = this.fences.at(-1)
    if (fence && context && (fence.controlSequence > context.controlSequence || fence.controlSequence === context.controlSequence && fence.action === 'pause')) {
      throw Object.assign(new Error('late start fenced'), { code: 'native-deployment-stale' })
    }
    const binding = fixtureEndpointBinding(model)
    this.prepared.push(model.id)
    binding.connection.base_url = `http://fixture-${this.prepared.length}.invalid/v1`
    binding.endpoint_revision = digestJson({ schema_version: '1', base_url: binding.connection.base_url, wire_model: binding.wire_model,
      api: binding.api, auth: binding.connection.auth, capabilities: binding.capabilities })
    this.alive.add(binding.endpoint_revision)
    return binding
  }
  async observe(binding: T.ReadyEvaluationEndpointBinding) { return this.alive.has(binding.endpoint_revision) ? binding : undefined }
  async acquireConsumer(binding: T.ReadyEvaluationEndpointBinding, consumer: T.EndpointConsumer) {
    const current = this.consumers.get(consumer.id)
    if (current?.released) throw new Error('a released consumer cannot reopen')
    this.consumers.set(consumer.id, { revision: binding.endpoint_revision, released: false })
  }
  async releaseConsumer(_binding: T.ReadyEvaluationEndpointBinding, id: string) { const consumer = this.consumers.get(id); if (consumer) consumer.released = true }
  async retire(binding: T.ReadyEvaluationEndpointBinding) {
    if (this.blockRelease || [...this.consumers.values()].some(consumer => consumer.revision === binding.endpoint_revision && !consumer.released)) {
      return { status: 'blocked' as const, reason: 'controlled cleanup block' }
    }
    this.alive.delete(binding.endpoint_revision)
    return { status: 'released' as const }
  }
  async retireOwned() { return { status: this.alive.size ? 'blocked' as const : 'released' as const } }
  async releaseOwnership() {
    if (this.alive.size === 0 && !this.ownershipReleased) { this.ownersReleased++; this.ownershipReleased = true }
    if (this.loseOwnershipReplyOnce) { this.loseOwnershipReplyOnce = false; throw new Error('ownership release reply lost') }
    return { released: this.ownershipReleased }
  }
  async fence(context: T.EndpointPreparationContext) { this.fences.push(context) }
}

describe('managed deployment coordinator boundaries', () => {
  let root: string, store: ModelTrainingStore, spec: T.ModelTrainingSpecV2, trainer: FixtureTrainer, evaluator: FixtureEvaluator, endpoints: ManagedFixture
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-managed-coordinator-')); store = new ModelTrainingStore(root)
    spec = v2spec(await fixture(store)); trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store); endpoints = new ManagedFixture()
    spec.endpointPreparation = { mode: 'managed-native', profileDigest: endpoints.configurationDigest }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const coordinator = () => new ModelTrainingCoordinator(store, trainer, evaluator, endpoints)

  it('reuses complete champion evidence before requesting any deployment across rounds', async () => {
    spec.iteration = iterationPolicy([{ id: 'base', sourceRef: spec.trainer.hyperparametersRef }], { maxRounds: 2, maxWallClockSeconds: 60 })
    const loop = new ModelIterationController(coordinator()), experiment = await loop.coordinator.createExperiment(spec)
    const first = await loop.advance(experiment.id)
    expect(Object.values(first.runs)[0]?.decision?.outcome).toBe('accepted')
    const champion = await store.readJson<T.ModelVersion>(first.champion.modelRef)
    expect(endpoints.prepared.filter(id => id === champion.id)).toHaveLength(1)
    evaluator.candidateReward = 2; evaluator.heldOutReward = 2
    const completed = await runIteration(new ModelIterationController(coordinator()), experiment.id, { intervalMs: 1 })
    expect(completed.champion.revision).toBe(2)
    expect(endpoints.prepared).toHaveLength(3) // M0, M1, M2; baseline reuse never redeploys M1
    expect([...endpoints.consumers.values()].every(consumer => consumer.released)).toBe(true)
    expect(endpoints.ownersReleased).toBe(1)
    expect(endpoints.alive.size).toBe(0)
  })

  it('keeps the round active until owned inference release is confirmed', async () => {
    const c = coordinator(), experiment = await c.createExperiment(spec), run = await c.admit(experiment.id)
    endpoints.blockRelease = true
    const pending = await c.advance(experiment.id, run.id)
    expect(pending.execution).toBe('running'); expect(pending.decision).toBeUndefined()
    expect(pending.resourcesReleased && pending.evaluationTasksCompleted).toBe(true)
    expect(pending.inferenceResourcesReleased).toBe(false)
    endpoints.blockRelease = false
    expect((await c.advance(experiment.id, run.id)).decision?.outcome).toBe('accepted')
    expect(endpoints.ownersReleased).toBe(0) // only outer experiment termination transfers ownership
  })

  it('recovers a lost ownership-release reply before committing experiment completion', async () => {
    spec.iteration = iterationPolicy([{ id: 'base', sourceRef: spec.trainer.hyperparametersRef }], { maxRounds: 1, maxWallClockSeconds: 60 })
    endpoints.loseOwnershipReplyOnce = true
    const loop = new ModelIterationController(coordinator()), experiment = await loop.coordinator.createExperiment(spec)
    const pending = await runIteration(loop, experiment.id, { intervalMs: 1 })
    expect(pending.iteration).toMatchObject({ status: 'pausing', stopReason: 'max-rounds', error: 'ownership release reply lost' })
    expect(endpoints.ownershipReleased).toBe(true)
    const recovered = await new ModelIterationController(coordinator()).advance(experiment.id)
    expect(recovered.iteration?.status).toBe('completed')
    expect(endpoints.ownersReleased).toBe(1); expect(endpoints.alive.size).toBe(0)
  })

  it('persists a newer pause before a delayed endpoint start can take effect', async () => {
    spec.iteration = iterationPolicy([{ id: 'base', sourceRef: spec.trainer.hyperparametersRef }], { maxRounds: 2, maxWallClockSeconds: 60 })
    let start!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { start = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    endpoints.beforePrepare = async () => { start(); await waiting }
    const loop = new ModelIterationController(coordinator()), experiment = await loop.coordinator.createExperiment(spec)
    const pending = loop.advance(experiment.id)
    await started
    const paused = await new ModelIterationController(coordinator()).pause(experiment.id)
    expect(paused.iteration?.status).toBe('paused')
    release(); await pending
    expect((await new ModelIterationController(coordinator()).advance(experiment.id)).iteration?.status).toBe('paused')
    expect(endpoints.prepared).toEqual([]); expect(trainer.submissions).toBe(0)
    expect(endpoints.ownersReleased).toBe(0)
  })

  it('gives invalid-slot repair on the same instance a fresh consumer admission', async () => {
    const original = evaluator.evaluate.bind(evaluator)
    let partial: T.ModelEvaluationEvidence | undefined
    evaluator.evaluate = async request => {
      const evidence = await original(request)
      if (!request.model.trainingRunId || request.condition.partition !== 'dev') return evidence
      if (!partial) {
        evidence.trials[0]!.reward = 0
        evidence.trials[1] = { ...evidence.trials[1]!, valid: false, inferenceError: true }
        delete evidence.trials[1]!.reward
        evidence.complete = false; partial = structuredClone(evidence)
        return evidence
      }
      evidence.trials[0] = structuredClone(partial.trials[0]!)
      return evidence
    }
    const c = coordinator(), experiment = await c.createExperiment(spec), run = await c.admit(experiment.id)
    await expect(c.advance(experiment.id, run.id)).rejects.toMatchObject({ code: 'incomplete-evaluation' })
    await c.resume(experiment.id, run.id)
    const current = await c.inspect(experiment.id, run.id)
    expect(current.decision?.outcome).toBe('accepted')
    const registrations = [...endpoints.consumers.keys()].filter(id => id.includes('candidate:dev'))
    expect(registrations).toHaveLength(2)
    expect(registrations.map(id => id.slice(id.lastIndexOf('/') + 1)).sort()).toEqual(['0', '1'])
    expect(endpoints.prepared).toHaveLength(2)
  })

  it('recovers complete terminal evidence before redeploying an instance that died after a lost reply', async () => {
    const original = evaluator.evaluate.bind(evaluator)
    let lost: T.ModelEvaluationEvidence | undefined
    evaluator.evaluate = async request => {
      const evidence = await original(request)
      if (request.model.trainingRunId && request.condition.partition === 'held-out' && !lost) {
        lost = structuredClone(evidence)
        endpoints.alive.delete(request.endpointBinding.endpoint_revision)
        throw new Error('complete held-out reply lost before Gear evidence commit')
      }
      return evidence
    }
    Object.assign(evaluator, { reconcileEvidence: async (request: T.ModelEvaluationRequest) => lost
      && lost.evidenceKey === digestJson({ subject: request.subject, condition: request.condition }) ? lost : undefined })
    const c = coordinator(), experiment = await c.createExperiment(spec), run = await c.admit(experiment.id)
    await expect(c.advance(experiment.id, run.id)).rejects.toThrow('complete held-out reply lost')
    expect(endpoints.prepared).toHaveLength(2)
    const resumed = await c.resume(experiment.id, run.id)
    expect(resumed.decision?.outcome).toBe('accepted')
    expect(endpoints.prepared).toHaveLength(2)
    expect(evaluator.calls).toHaveLength(4)
    const held = await store.readJson<T.ModelEvaluationEvidence>(resumed.evaluationIntents['candidate:held-out']!.evidenceRef!)
    expect(held).toEqual(lost)
    expect([...endpoints.consumers.values()].every(consumer => consumer.released)).toBe(true)
  })
})
