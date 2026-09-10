import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrainingContentStore } from '../../../src/training/store.js'
import { sealModelVersion, TrainingContractError } from '../../../src/training/schema.js'
import { digestJson } from '../../../src/training/digest.js'
import { HitchModelEvaluator, inferenceCommonDigest } from '../../../src/training/hitch.js'
import { HitchModelPublisher } from '../../../src/training/publication.js'
import { jsonProcess } from '../../../src/training/process.js'
import { freezeExecutionPlacement } from '../../../src/training/deployment.js'
import { deployment, observation } from './placement-fixture.js'
import type { ModelEvaluationRequest } from '../../../src/training/types.js'
vi.mock('../../../src/training/process.js', () => ({ jsonProcess: vi.fn() }))

describe('Hitch evaluator public CLI boundary', () => {
  const roots: string[] = []
  afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup(v2 = false) {
    const root = await mkdtemp(join(tmpdir(), 'gear-hitch-evaluator-')); roots.push(root)
    const store = new TrainingContentStore(root), hash = digestJson('identity'), modelId = digestJson('hitch-model'), inferenceId = digestJson('inference')
    const files = [{ path: 'model.safetensors', size: 128, sha256: digestJson('weights') }]
    const ref = await store.putJson({ files }); const environmentRef = await store.putJson({ hitchEnvironmentIdentity: hash, taskDigest: hash, verifierIdentity: hash })
    const harness = { harnessId: 'training-tool', revisionIdentity: hash, artifactId: hash }
    const harnessRef = await store.putJson({ hitch: harness })
    const model = sealModelVersion({ schemaVersion: 1, hfSnapshotRef: ref, weightsDigest: files[0]!.sha256, tokenizerDigest: hash, chatTemplateDigest: hash, architecture: 'Tiny', dtype: 'float32', provenanceRef: ref })
    const placement = freezeExecutionPlacement(deployment(), observation(deployment()))
    const node = { schema_version: '2', node_id: placement.modelRuntime.nodeId, generation: placement.modelRuntime.generation,
      runtime_digest: placement.modelRuntime.runtimeDigest, launcher: 'process' }
    const lock = { ...(v2 ? { schema_version: '2', model_node: node } : {}), engine: 'sglang', profile: 'baseline', runtime_id: hash, model_id: modelId, inference_id: inferenceId,
      execution: { platform: { backend: 'cuda', device_constraint: 'GPU-test' }, max_running_requests: 1 }, resources: { gpu_count: 1 },
      generation: { max_output_tokens: 2048 }, protocol: { api: 'chat-completions' } }
    const budgets = { timeoutSeconds: 10, setupTimeoutSeconds: 20, maxConcurrent: 1 as const, maxEpisodeSteps: 16 as const, infrastructureRetries: 0 as const, maxRepairRounds: 0 }
    const request: ModelEvaluationRequest = { schemaVersion: 1, subject: { harnessRef, modelVersionRef: await store.putJson(model), weightsDigest: model.weightsDigest }, model,
      condition: { schemaVersion: 1, partition: 'dev', datasetDigest: ref.digest, slots: [{ taskId: 'task', attempt: 1, environmentDigest: environmentRef.digest }],
        verifierDigest: ref.digest, budgetsDigest: digestJson(budgets), runtimeDigest: inferenceCommonDigest(lock), protocolDigest: digestJson(lock.protocol), samplingDigest: digestJson(lock.generation),
        tokenizerDigest: hash, chatTemplateDigest: hash, architecture: 'Tiny', dtype: 'float32' }, datasetRef: ref, harnessCommit: 'a'.repeat(40), harnessAdapter: 'training-tool',
      datasetTasks: [{ id: 'task', family: 'task', taskRef: ref, environmentRef }], verifierRef: ref, evaluationDevices: ['GPU-test'], ...(v2 ? { deployment: placement } : {}) }
    if (v2) request.condition.deploymentDigest = digestJson(placement)
    const state = { submits: 0, submitted: [] as readonly string[], verifierIdentity: hash, node, canonicalNode: node, stopped: false, usage: 12, supportsNode: true, serviceMissing: false,
      command: undefined as { sequence: number; action: string } | undefined, valid: true, repairReplyLost: false, preparationFailure: false, supportsStorage: true }
    const evalId = `eval_${'b'.repeat(32)}`, runId = `run_${'c'.repeat(32)}`
    vi.mocked(jsonProcess).mockImplementation(async (command, args, payload) => {
      if (command[0] === 'fake-python') return { path: (payload as { destination: string }).destination }
      const a = args.slice(2), op = a.slice(0, 2).join(' ')
      if (op === 'models add' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(a[a.indexOf('--name') + 1]!)) {
        throw new TrainingContractError('invalid-input', 'Hitch model aliases must fit the public 64-character contract')
      }
      if (op === 'models add' || op === 'models add-node' || op === 'models inspect') return { model_id: modelId, files, architecture: model.architecture, dtype: model.dtype, tokenizer_digest: hash, template_digest: hash, quantization: null }
      if (op === 'capabilities --json') return state.supportsNode ? { managed_model_node: '2', model_node_usage: '2', ordered_eval_control: '2', ...(state.supportsStorage ? { model_node_storage: '1' } : {}) } : {}
      if (op === 'eval control') {
        const command = JSON.parse(await readFile(a[a.indexOf('--file') + 1]!, 'utf8'))
        if (state.command && (command.sequence < state.command.sequence || command.sequence === state.command.sequence && command.action !== state.command.action)) throw new TrainingContractError('eval_control_stale', 'newer eval command')
        state.command = command
        return { ...command, eval_id: evalId, submitted: state.submits > 0, pending_reruns: false }
      }
      if (op === 'eval rerun') {
        if (state.repairReplyLost) throw new TrainingContractError('process-timeout', 'repair reply lost')
        return {}
      }
      if (op === 'model-node register') return { binding: JSON.parse(await readFile(a[a.indexOf('--file') + 1]!, 'utf8')).binding }
      if (op === 'local stop') { state.stopped = true; return { stopped: 1 } }
      if (op === 'local inspect-service') return { schema_version: '2', service_id: 'inference_fixture', inference_id: inferenceId, model_node: state.node,
        resources_released: state.stopped, state: state.stopped ? 'stopped' : 'failed', gpu_seconds: state.usage }
      if (op === 'local plan') return { lock }
      if (op === 'local inspect') return lock
      if (op === 'eval submit') {
        if (a.includes('--control-file')) {
          const command = JSON.parse(await readFile(a[a.indexOf('--control-file') + 1]!, 'utf8'))
          if (command.sequence !== state.command?.sequence || state.command?.action !== 'start') throw new TrainingContractError('eval_control_stale', 'newer eval command')
        }
        state.submits++; state.submitted = a; return { eval_id: evalId }
      }
      const option = (name: string) => state.submitted[state.submitted.indexOf(name) + 1]
      if (op === 'eval inspect') return { control: { state: 'completed' }, request: { model: `local/${modelId}`, dataset: option('--dataset'), harness_ref: option('--harness'), timeout_ms: 10000, max_concurrent: 1, infrastructure_retries: 0, ...(v2 ? { local_inference: { model_node: state.node } } : {}) },
        submission: { execution: { provider: 'local-docker' } }, plan: state.preparationFailure ? null : { candidate: { inference_id: inferenceId, ...(v2 ? { model_node: state.node } : {}) } },
        result: state.preparationFailure ? { status: 'failed', failure_stage: 'preparing', error: { code: 'inference_process_exited', message: 'private engine details' }, trials: [] }
          : { trials: [{ task_id: 'task', attempt: 1, run_id: runId, observation_status: state.valid ? 'valid' : 'invalid', reward: 0 }] } }
      if (op === 'local status') return { services: v2 && !state.serviceMissing ? [{ service_id: 'inference_fixture', inference_id: inferenceId, isolation_key: digestJson({ inference_id: inferenceId, cache_scope_owner: evalId }), model_node: state.node, state: state.stopped ? 'stopped' : 'failed' }, { service_id: 'inference_previous_eval', inference_id: inferenceId, isolation_key: digestJson({ inference_id: inferenceId, cache_scope_owner: 'previous-eval' }), model_node: state.node, state: 'ready' }] : [] }
      if (op === 'runs inspect') return { record_status: 'valid', trajectory_status: 'valid', record: { run_id: runId, parent: { eval_id: evalId, attempt: 1 },
        context: { kind: 'benchmark_task', task_id: 'task', task_digest: hash, verifier_identity: state.verifierIdentity }, protocol: { environment_identity: hash },
        model: { effective_id: modelId, inference_id: inferenceId, identity_resolved: true, ...(v2 ? { model_node: state.canonicalNode } : {}) }, harness: { harness_id: harness.harnessId, requested_ref: `${request.harnessAdapter}@commit:${request.harnessCommit}`, revision_identity: hash, artifact_id: hash }, observation: { status: 'valid', reward: 0 } } }
      if (op === 'verifier inspect') return { verifier: { status: 'complete' } }
      throw new Error(`unexpected CLI call: ${op}`)
    })
    const evaluator = new HitchModelEvaluator(store, { command: ['fake-hitch'], root: join(root, 'hitch'), workspace: join(root, 'eval'), harnessSourceDirectory: root, python: ['fake-python'], budgets, ...(v2 ? { modelNode: { transport: { type: 'ssh' as const, host: 'vast-debug' }, python: ['python'], configPath: '/workspace/node.json', gateway: { localPort: 33000, nodePort: 33001 } } } : {}) })
    return { evaluator, request, lock, state }
  }
  it('imports and verifies a model on its node without materializing weights on the controller', async () => {
    const { evaluator, request, state } = await setup(true)
    evaluator.options.artifactStorage = 'model-node'
    state.stopped = true
    await evaluator.evaluate(request, 'remote-storage')
    const calls = vi.mocked(jsonProcess).mock.calls
    expect(calls.some(([, args]) => args.includes('add-node') && args.includes('--model-node-file'))).toBe(true)
    expect(calls.some(([, args]) => args.includes('models') && args.includes('inspect') && args.includes('--model-node-file'))).toBe(true)
    const materializations = calls.filter(([command]) => command[0] === 'fake-python').map(([, , payload]) => (payload as { destination: string }).destination)
    expect(materializations).toHaveLength(1)
    expect(materializations[0]).toContain('/datasets/')
  })
  it('rejects old Hitch storage capabilities before model import or evaluation submission', async () => {
    const { evaluator, request, state } = await setup(true)
    evaluator.options.artifactStorage = 'model-node'; state.supportsStorage = false
    await expect(evaluator.evaluate(request, 'missing-remote-storage')).rejects.toMatchObject({ code: 'remote-model-storage-unavailable' })
    expect(state.submits).toBe(0)
  })
  it('imports evaluation and publication models with a full digest alias within Hitch limits', async () => {
    const { evaluator, request } = await setup()
    await evaluator.evaluate(request, 'alias-evaluation')
    const publisher = new HitchModelPublisher(evaluator.store, { ...evaluator.options,
      activationPath: join(evaluator.store.root, 'active-model.json') })
    await expect(publisher.activate(request.model, 'alias-publication')).resolves.toMatchObject({ active: true })
    const imports = vi.mocked(jsonProcess).mock.calls.map(([, args]) => args).filter(args => args.includes('--name'))
    expect(imports).toHaveLength(2)
    for (const args of imports) {
      expect(args[args.indexOf('--name') + 1]).toBe(request.model.id.slice(7))
      expect(args).not.toContain('--force')
    }
  })
  it('observes durable node usage without admission, cancellation, repair or inferred release', async () => {
    const { evaluator, request, state } = await setup(true)
    expect(await evaluator.observeUsage(request, 'meter')).toEqual({ gpuSeconds: null })
    expect(vi.mocked(jsonProcess)).not.toHaveBeenCalled()
    await expect(evaluator.evaluate(request, 'meter')).rejects.toMatchObject({ code: 'evaluation-pending' })
    state.stopped = false; state.usage = 14; vi.mocked(jsonProcess).mockClear()
    const restarted = new HitchModelEvaluator(evaluator.store, evaluator.options)
    expect(await restarted.observeUsage(request, 'meter')).toEqual({ gpuSeconds: 14 })
    expect(vi.mocked(jsonProcess).mock.calls.map(([, args]) => args.slice(2, 4).join(' '))).toEqual(['local status', 'local inspect-service'])
    expect(state.stopped).toBe(false); expect(state.submits).toBe(1)
    state.usage = 13
    await expect(restarted.observeUsage(request, 'meter')).rejects.toMatchObject({ code: 'model-node-usage-drift' })
    state.serviceMissing = true
    await expect(restarted.observeUsage(request, 'meter')).rejects.toMatchObject({ code: 'model-node-service-missing' })
  })
  it('reports preparation failure only after confirmed release and never manufactures evaluation evidence', async () => {
    const { evaluator, request, state } = await setup(true)
    state.preparationFailure = true
    await expect(evaluator.evaluate(request, 'preparation-failed')).rejects.toMatchObject({ code: 'evaluation-pending' })
    expect(state.stopped).toBe(true)
    await expect(evaluator.evaluate(request, 'preparation-failed')).rejects.toMatchObject({
      code: 'hitch-evaluation-preparation-failed', message: expect.stringContaining('(inference_process_exited)'),
    })
    const restarted = new HitchModelEvaluator(evaluator.store, evaluator.options)
    await expect(restarted.evaluate(request, 'preparation-failed')).rejects.toMatchObject({ code: 'hitch-evaluation-preparation-failed' })
    expect(await restarted.observeUsage(request, 'preparation-failed')).toEqual({ gpuSeconds: 12 })
    expect(state.submits).toBe(1)
    expect(vi.mocked(jsonProcess).mock.calls.some(([, args]) => args.includes('runs') || args.includes('rerun'))).toBe(false)
  })
  it('v2 waits for node release, freezes public node selection and uses physical device time', async () => {
    const { evaluator, request, state } = await setup(true)
    await expect(evaluator.evaluate(request, 'node')).rejects.toMatchObject({ code: 'evaluation-pending' })
    expect(state.stopped).toBe(true)
    state.usage = 14
    const evidence = await evaluator.evaluate(request, 'node')
    expect(evidence.complete).toBe(true); expect(evidence.gpuSeconds).toBe(14); expect(state.submits).toBe(1)
    const bindingPath = state.submitted[state.submitted.indexOf('--model-node-file') + 1]!
    expect(JSON.parse(await readFile(bindingPath, 'utf8'))).toEqual(state.node)
    expect(state.submitted[state.submitted.indexOf('--provider') + 1]).toBe('local-docker')
    expect(state.submitted).not.toContain('--device')
  })
  it('v2 cold pause prevents a delayed first evaluation and keeps its identity on explicit resume', async () => {
    const { evaluator, request, state } = await setup(true)
    expect(await evaluator.cancel(request, 'cold')).toEqual({ resourcesReleased: true, gpuSeconds: 0 })
    await expect(evaluator.evaluate(request, 'cold')).rejects.toMatchObject({ code: 'eval_control_stale' })
    expect(state.submits).toBe(0)
    const resume = { schemaVersion: 2 as const, sequence: 2, action: 'start' as const }
    await expect(evaluator.evaluate(request, 'cold', resume)).rejects.toMatchObject({ code: 'evaluation-pending' })
    const evidence = await evaluator.evaluate(request, 'cold', resume)
    expect(evidence.complete).toBe(true); expect(state.submits).toBe(1)
    await expect(evaluator.cancel(request, 'cold', { schemaVersion: 2, sequence: 1, action: 'pause' })).rejects.toMatchObject({ code: 'eval_control_stale' })
    expect((await evaluator.evaluate(request, 'cold', resume)).evalId).toBe(evidence.evalId)
  })
  it('v2 remote pause fences admission while the original materializer is still in flight', async () => {
    const { evaluator, request, state } = await setup(true)
    const original = vi.mocked(jsonProcess).getMockImplementation()!
    let entered!: () => void, release!: () => void, sawPause!: () => void, blocked = false
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const paused = new Promise<void>(done => { sawPause = done })
    vi.mocked(jsonProcess).mockImplementation(async (command, args, payload, timeout) => {
      if (command[0] === 'fake-python' && !blocked) { blocked = true; entered(); await waiting }
      const result = await original(command, args, payload, timeout)
      if (args.includes('control') && state.command?.action === 'pause') sawPause()
      return result
    })
    const evaluating = evaluator.evaluate(request, 'delayed')
    void evaluating.catch(() => {})
    await ready
    const cancelling = evaluator.cancel(request, 'delayed')
    void cancelling.catch(() => {})
    try { await paused; expect(state.submits).toBe(0) } finally { release() }
    await expect(evaluating).rejects.toMatchObject({ code: 'eval_control_stale' })
    expect(await cancelling).toEqual({ resourcesReleased: true, gpuSeconds: 0 })
    expect(state.submits).toBe(0)
  })
  it('v2 resume imports a repair that finished before its reply was lost without spending another repair round', async () => {
    const { evaluator, request, state } = await setup(true)
    evaluator.options.budgets.maxRepairRounds = 1; request.condition.budgetsDigest = digestJson(evaluator.options.budgets)
    state.valid = false
    await expect(evaluator.evaluate(request, 'repair')).rejects.toMatchObject({ code: 'evaluation-pending' })
    expect((await evaluator.evaluate(request, 'repair')).complete).toBe(false)
    state.repairReplyLost = true
    await expect(evaluator.evaluate(request, 'repair')).rejects.toMatchObject({ code: 'evaluation-pending' })
    state.valid = true
    expect((await evaluator.cancel(request, 'repair')).resourcesReleased).toBe(true)
    const result = await evaluator.evaluate(request, 'repair', { schemaVersion: 2, sequence: 2, action: 'start' })
    expect(result.complete).toBe(true); expect(state.submits).toBe(1)
    expect(vi.mocked(jsonProcess).mock.calls.filter(([, args]) => args[2] === 'eval' && args[3] === 'rerun')).toHaveLength(1)
  })
  it('v2 rejects old Hitch capabilities before submitting evaluation', async () => {
    const { evaluator, request, state } = await setup(true); state.supportsNode = false
    await expect(evaluator.evaluate(request, 'old-hitch')).rejects.toMatchObject({ code: 'evaluation-control-unavailable' })
    expect(state.submits).toBe(0)
  })
  it('v2 rejects decreasing usage and disappeared service records', async () => {
    const { evaluator, request, state } = await setup(true)
    await expect(evaluator.evaluate(request, 'usage')).rejects.toMatchObject({ code: 'evaluation-pending' })
    state.usage = 0
    await expect(evaluator.evaluate(request, 'usage')).rejects.toMatchObject({ code: 'model-node-usage-drift' })
    state.serviceMissing = true
    await expect(evaluator.evaluate(request, 'usage')).rejects.toMatchObject({ code: 'model-node-service-missing' })
  })
  it('v2 rejects a canonical run from another generation after the engine stops', async () => {
    const { evaluator, request, state } = await setup(true)
    await expect(evaluator.evaluate(request, 'canonical')).rejects.toMatchObject({ code: 'evaluation-pending' })
    state.canonicalNode = { ...state.node, generation: 'another-boot' }
    await expect(evaluator.evaluate(request, 'canonical')).rejects.toMatchObject({ code: 'canonical-model-node-drift' })
  })
  it('retains valid zero rewards and reuses the same completed eval', async () => {
    const { evaluator, request, state } = await setup()
    const first = await evaluator.evaluate(request, 'stable-key'); expect(first.complete).toBe(true); expect(first.trials[0]?.reward).toBe(0)
    expect(await evaluator.evaluate(request, 'stable-key')).toEqual(first); expect(state.submits).toBe(1)
  })
  it('rejects execution drift before launching evaluation', async () => {
    const { evaluator, request, lock, state } = await setup(); lock.execution.max_running_requests = 2
    await expect(evaluator.evaluate(request, 'drift')).rejects.toMatchObject({ code: 'inference-common-condition-drift' }); expect(state.submits).toBe(0)
  })
  it('rejects a canonical verifier belonging to another task configuration', async () => {
    const { evaluator, request, state } = await setup(); state.verifierIdentity = digestJson('other-verifier')
    await expect(evaluator.evaluate(request, 'wrong-verifier')).rejects.toMatchObject({ code: 'canonical-evaluation-identity-drift' })
  })
})
