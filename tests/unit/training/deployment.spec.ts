import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freezeExecutionPlacement, parseTrainingDeployment, assertDeploymentMatches } from '../../../src/training/deployment.js'
import { digestJson } from '../../../src/training/digest.js'
import { parseModelTrainingSpec, parseTrainingRequest } from '../../../src/training/schema.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { modelEvaluationRequest } from '../../../src/training/evaluation.js'
import type { ModelTrainingSpecV1, ModelVersion } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'

import { deployment, observation, v2spec } from './placement-fixture.js'

describe('v2 independent execution placement', () => {
  let root: string, store: ModelTrainingStore, legacy: ModelTrainingSpecV1
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gear-deployment-')); store = new ModelTrainingStore(root); legacy = await fixture(store) })
  afterEach(async () => rm(root, { recursive: true, force: true }))
  it('plans all four combinations without coupling Harbor to the GPU node', () => {
    for (const task of ['local', 'remote'] as const) for (const model of ['local', 'ssh'] as const) {
      const config = deployment(task, model); const parsed = parseModelTrainingSpec(v2spec(legacy, config))
      expect(parsed.schemaVersion).toBe(2)
      if (parsed.schemaVersion === 2) {
        expect(parsed.deployment.taskExecution.provider).toBe(config.taskExecution.provider)
        expect(parsed.deployment.modelRuntime.nodeId).toBe('gpu-node')
        expect(JSON.stringify(parsed)).not.toContain('vast-debug') // Connection alias is not a frozen model identity.
      }
    }
  })
  it('rejects unknown connections, old worker capabilities, node mismatch and GPU overlap', () => {
    const missing = deployment(); missing.modelRuntime.nodeRef = 'missing'
    expect(() => parseTrainingDeployment(missing)).toThrow('does not exist')
    const config = deployment('remote'); const oldWorker = observation(config); oldWorker.provider.capabilities.exactTrainingBinding = false
    expect(() => freezeExecutionPlacement(config, oldWorker)).toThrow('exactTrainingBinding')
    const wrongNode = v2spec(legacy); wrongNode.resources.trainingDevices[0]!.nodeId = 'other-node'
    expect(() => parseModelTrainingSpec(wrongNode)).toThrow('selected model node')
    const overlap = v2spec(legacy); overlap.deployment.gpuScheduling.trainEvaluation = 'isolated'
    expect(() => parseModelTrainingSpec(overlap)).toThrow('must not overlap')
    const duplicated = v2spec(legacy); duplicated.trainer.placement = 'colocated'
    expect(() => parseModelTrainingSpec(duplicated)).toThrow('v2 placement')
  })
  it('does not rewrite legacy specs or inject new identity fields', () => {
    const before = digestJson(legacy)
    expect(digestJson(parseModelTrainingSpec(legacy))).toBe(before)
    expect(parseModelTrainingSpec(legacy)).not.toHaveProperty('deployment')
  })
  it('freezes deployment through admission and rejects persisted drift', async () => {
    const spec = v2spec(legacy)
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec); const run = await coordinator.admit(experiment.id)
    expect(run.request.schemaVersion).toBe(2)
    expect(parseTrainingRequest(run.request)).toHaveProperty('deployment', spec.deployment)
    await store.transaction(experiment.id, state => {
      const request = state.runs[run.id]!.request
      if (request.schemaVersion === 2) request.deployment.modelRuntime.generation = 'new-generation'
    })
    await expect(store.load(experiment.id)).rejects.toMatchObject({ code: 'training-request-drift' })
  })
  it('requires new baselines when provider or node identity changes', async () => {
    const model = await store.readJson<ModelVersion>(legacy.initialModel)
    const a = modelEvaluationRequest(v2spec(legacy), model, legacy.initialModel, 'dev')
    const b = modelEvaluationRequest(v2spec(legacy, deployment('remote')), model, legacy.initialModel, 'dev')
    expect(a.condition.deploymentDigest).not.toBe(b.condition.deploymentDigest)
    const config = deployment(); const obs = observation(config); const frozen = freezeExecutionPlacement(config, obs)
    obs.node.generation = 'another-boot'
    expect(() => assertDeploymentMatches(frozen, config, obs)).toThrow('new experiment')
  })
})
