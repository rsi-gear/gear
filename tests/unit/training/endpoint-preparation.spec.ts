import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trainingCommand } from '../../../src/training/cli.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { digestJson } from '../../../src/training/digest.js'
import { ExternalFileEndpointPreparer, parseEndpointBinding, publicEndpointBinding, validateReadyEndpointBinding } from '../../../src/training/endpoint-binding.js'
import { modelEvaluationRequest, pairModelEvidence, validateModelEvidence } from '../../../src/training/evaluation.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import type { ModelTrainingSpecV1, ModelVersion } from '../../../src/training/types.js'
import { fixture, fixtureEndpointBinding, fixtureEndpointPreparer, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'

describe('per-model external deployment preparation', () => {
  let root: string, store: ModelTrainingStore, spec: ModelTrainingSpecV1, trainer: FixtureTrainer, evaluator: FixtureEvaluator
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gear-endpoint-preparation-')); store = new ModelTrainingStore(root)
    spec = await fixture(store); trainer = new FixtureTrainer(store); evaluator = new FixtureEvaluator(store) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('persists waiting preparation before training and freezes each ready model binding across restart', async () => {
    const file = join(root, 'map.json'), bindingFile = join(root, 'baseline.json')
    const preparation = new ExternalFileEndpointPreparer({ bindingsFile: file, trustedReceiptSources: ['fixture-deployer'] })
    let coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, preparation)
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    let pending = await coordinator.advance(experiment.id, run.id)
    expect(pending.execution).toBe('running'); expect(pending.error).toContain('waiting for externally prepared')
    expect(trainer.submissions).toBe(0); expect(evaluator.calls).toHaveLength(0)
    let state = await store.load(experiment.id)
    const baseline = await store.readJson<ModelVersion>(spec.initialModel)
    expect(state.endpointPreparations?.[baseline.id]?.status).toBe('waiting')
    const original = fixtureEndpointBinding(baseline)
    await writeFile(bindingFile, JSON.stringify(original))
    await writeFile(file, JSON.stringify({ schemaVersion: 1, bindings: { [baseline.hfSnapshotRef.digest]: bindingFile } }))
    coordinator = new ModelTrainingCoordinator(new ModelTrainingStore(root), trainer, evaluator, preparation)
    pending = await coordinator.advance(experiment.id, run.id)
    expect(pending.phase).toBe('evaluating'); expect(pending.error).toContain('waiting for externally prepared')
    expect(trainer.submissions).toBe(1); expect(evaluator.calls).toHaveLength(2)
    state = await store.load(experiment.id)
    const saved = state.endpointPreparations![baseline.id]!
    expect(saved.status).toBe('ready')
    expect(JSON.stringify(state)).not.toContain('fixture.invalid')
    const candidate = await store.readJson<ModelVersion>(pending.candidateRef!)
    expect(state.endpointPreparations![candidate.id]!.status).toBe('waiting')
    // Mutating the external alias product cannot affect the already saved baseline.
    await writeFile(bindingFile, JSON.stringify({ ...original, wire_model: 'wrong-current-alias' }))
    const candidateFile = join(root, 'candidate.json')
    await writeFile(candidateFile, JSON.stringify(fixtureEndpointBinding(candidate)))
    await writeFile(file, JSON.stringify({ schemaVersion: 1, bindings: { [candidate.hfSnapshotRef.digest]: candidateFile } }))
    const done = await new ModelTrainingCoordinator(store, trainer, evaluator, preparation).advance(experiment.id, run.id)
    expect(done.decision?.outcome).toBe('accepted'); expect(trainer.submissions).toBe(1)
    expect(await store.readJson(saved.bindingRef!)).toEqual(original)
    const baselineCalls = evaluator.calls.filter(call => call.model.id === baseline.id), candidateCalls = evaluator.calls.filter(call => call.model.id === candidate.id)
    expect(baselineCalls.every(call => call.endpointBinding.wire_model === original.wire_model)).toBe(true)
    expect(candidateCalls).toHaveLength(2)
    expect((await store.load(experiment.id)).activeReleaseId).toBeUndefined()
  })
  it('rejects mismatched receipts, endpoint revision, generation, protocol and public runtime configuration before eval', async () => {
    const model = await store.readJson<ModelVersion>(spec.initialModel), binding = fixtureEndpointBinding(model)
    const cases: Array<[string, (value: typeof binding) => void]> = [
      ['unsupported-parallel-tool-calls', value => { value.capabilities.parallel_tool_calls = true }],
      ['deployment-model-mismatch', value => { value.deployment_receipt.model_digest = digestJson('other-snapshot') }],
      ['invalid-deployment-receipt', value => { value.deployment_receipt.wire_model = 'wrong-version' }],
      ['untrusted-deployment-receipt', value => { value.deployment_receipt.source = 'untrusted' }],
      ['endpoint-revision-drift', value => { value.connection.base_url = 'http://changed.invalid/v1' }],
      ['evaluation-sampling-drift', value => { value.generation.max_output_tokens = 4096 }],
      ['evaluation-protocol-drift', value => { value.api = 'responses'; value.endpoint_revision = digestJson({ schema_version: '1', base_url: value.connection.base_url,
        wire_model: value.wire_model, api: value.api, auth: value.connection.auth, capabilities: value.capabilities }) }],
      ['evaluation-runtime-drift', value => { value.deployment_receipt.service_config.engine_version = 'other' }],
      ['invalid-service-config', value => { value.deployment_receipt.service_config.base_url = 'http://private.invalid' }],
      ['private-service-config', value => { value.deployment_receipt.service_config.parsing = { secret: 'private-key' } }],
    ]
    for (const [code, mutate] of cases) {
      const changed = structuredClone(binding); mutate(changed)
      expect(() => validateReadyEndpointBinding(changed, model, spec.evaluation.common, ['fixture-deployer'])).toThrow(expect.objectContaining({ code }))
    }
    expect(() => parseEndpointBinding({ ...binding, endpoint_ref: 'endpoint/Uppercase' }, true)).toThrow()
    expect(() => parseEndpointBinding({ ...binding, generation: { ...binding.generation, stop: ['done'] } }, true)).toThrow()
  })
  it('pairs different candidate endpoint revisions without losing common engine and sampling conditions', async () => {
    const baseline = await store.readJson<ModelVersion>(spec.initialModel), baselineBinding = fixtureEndpointBinding(baseline)
    const changed = { ...baseline, id: digestJson('candidate'), hfSnapshotRef: await store.putJson({ candidate: 'snapshot' }), weightsDigest: digestJson('candidate-weights') }
    const candidateRef = await store.putJson(changed), candidateBinding = fixtureEndpointBinding(changed)
    const before = await evaluator.evaluate(modelEvaluationRequest(spec, baseline, spec.initialModel, 'dev', baselineBinding))
    const after = await evaluator.evaluate(modelEvaluationRequest(spec, changed, candidateRef, 'dev', candidateBinding))
    expect(before.condition).toEqual(after.condition)
    expect(before.schemaVersion === 2 && after.schemaVersion === 2 && before.endpointBinding.endpoint_revision !== after.endpointBinding.endpoint_revision).toBe(true)
    expect(pairModelEvidence(before, after).meanDelta).toBe(0)
    expect(JSON.stringify(before)).not.toContain('fixture.invalid')
    expect(JSON.stringify(publicEndpointBinding(baselineBinding))).not.toContain('connection')
  })
  it('reads historical v1 evidence and v2 experiments unchanged, while refusing old runtime resume', async () => {
    const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, fixtureEndpointPreparer)
    const experiment = await coordinator.createExperiment(v2spec(spec)), run = await coordinator.admit(experiment.id)
    const current = await store.load(experiment.id), historical = structuredClone(current) as unknown as Record<string, any>
    historical.spec.evaluation = { ...historical.spec.evaluation, provider: 'hitch-managed', samplingProfile: 'baseline',
      inferencePool: { schemaVersion: 3, profile: 'baseline', tensorParallelSize: 1, replicas: [{ devices: ['GPU-123'] }], maxRunningRequests: 1,
        maxQueuedRequests: 1, maxConcurrent: 1, modelNode: { nodeId: 'gpu-node', generation: 'boot-1', runtimeDigest: digestJson('old-inference') } } }
    historical.spec.resources.evaluationDevices = [{ nodeId: 'gpu-node', gpuUuid: 'GPU-123' }]
    historical.spec.deployment.gpuScheduling.trainEvaluation = 'sequential'
    historical.runs[run.id].request.deployment.gpuScheduling.trainEvaluation = 'sequential'
    delete historical.spec.budgets.gpuSecondsScope; delete historical.runs[run.id].request.budgets.gpuSecondsScope
    historical.runs[run.id].evaluationResourcesReleased = true; delete historical.runs[run.id].evaluationTasksCompleted
    historical.specDigest = digestJson(historical.spec)
    const path = join(root, 'model-training-v1', experiment.id, 'state.json')
    await writeFile(path, JSON.stringify(historical))
    expect((await store.load(experiment.id)).specDigest).toBe(historical.specDigest)
    expect(await coordinator.inspect(experiment.id, run.id)).toEqual(historical.runs[run.id])
    await expect(coordinator.resume(experiment.id, run.id)).rejects.toMatchObject({ code: 'historical-run-read-only' })
    const oldControllerFile = join(root, 'old-controller.json')
    await writeFile(oldControllerFile, JSON.stringify({ schemaVersion: 2, storeRoot: root, evaluationGateway: { localPort: 1, nodePort: 2 } }))
    expect(await trainingCommand(['status', experiment.id, run.id, '--config', oldControllerFile])).toEqual(historical.runs[run.id])
    await expect(trainingCommand(['resume', experiment.id, run.id, '--config', oldControllerFile])).rejects.toMatchObject({ code: 'historical-run-read-only' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(historical)
    const model = await store.readJson<ModelVersion>(spec.initialModel)
    const condition = { ...modelEvaluationRequest(spec, model, spec.initialModel, 'dev', fixtureEndpointBinding(model)).condition, schemaVersion: 1 as const }
    delete condition.endpointApi
    const subject = { harnessRef: spec.fixedHarness.manifestRef, modelVersionRef: spec.initialModel, weightsDigest: model.weightsDigest }
    const evidence = { schemaVersion: 1, evalId: 'historical-eval', subject, condition, evidenceKey: digestJson({ subject, condition }),
      hitchModelId: digestJson('historical-model'), inferenceLockRef: await store.putJson({ historical: 'inference-lock' }),
      trials: condition.slots.map((slot, index) => ({ taskId: slot.taskId, attempt: slot.attempt, runId: `historical-${index}`, valid: true, reward: 0, inferenceError: false })), complete: true, gpuSeconds: 12 }
    expect(digestJson(validateModelEvidence(evidence))).toBe(digestJson(evidence))
  })
})
