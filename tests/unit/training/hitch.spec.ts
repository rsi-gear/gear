import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrainingContentStore } from '../../../src/training/store.js'
import { sealModelVersion, TrainingContractError } from '../../../src/training/schema.js'
import { digestJson } from '../../../src/training/digest.js'
import { HitchModelEvaluator } from '../../../src/training/hitch.js'
import { jsonProcess } from '../../../src/training/process.js'
import { publicEndpointBinding } from '../../../src/training/endpoint-binding.js'
import { evaluationAttemptId } from '../../../src/training/evaluation.js'
import { fixtureEndpointBinding, fixtureGeneration, fixtureServiceConfig } from './fixture.js'
import type { ModelEvaluationRequest } from '../../../src/training/types.js'
vi.mock('../../../src/training/process.js', () => ({ jsonProcess: vi.fn() }))

describe('Hitch evaluator task-only public CLI boundary', () => {
  const roots: string[] = []
  afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gear-hitch-endpoint-evaluator-')); roots.push(root)
    const store = new TrainingContentStore(root), hash = digestJson('identity'), ref = await store.putJson({ fixture: true })
    const environmentRef = await store.putJson({ hitchEnvironmentIdentity: hash, taskDigest: hash, verifierIdentity: hash })
    const harness = { harnessId: 'training-tool', revisionIdentity: hash, artifactId: hash }, harnessRef = await store.putJson({ hitch: harness })
    const model = sealModelVersion({ schemaVersion: 1, hfSnapshotRef: ref, weightsDigest: digestJson('weights'), tokenizerDigest: hash,
      chatTemplateDigest: hash, architecture: 'Tiny', dtype: 'float32', provenanceRef: ref })
    const budgets = { timeoutSeconds: 10, setupTimeoutSeconds: 20, maxConcurrent: 16, maxEpisodeSteps: 16 as const, infrastructureRetries: 0 as const, maxRepairRounds: 1 }
    const request: ModelEvaluationRequest = { schemaVersion: 2, subject: { harnessRef, modelVersionRef: await store.putJson(model), weightsDigest: model.weightsDigest }, model,
      endpointBinding: fixtureEndpointBinding(model), condition: { schemaVersion: 2, endpointApi: 'chat-completions', partition: 'dev', datasetDigest: ref.digest,
        slots: [{ taskId: 'task', attempt: 1, environmentDigest: environmentRef.digest }], verifierDigest: ref.digest, budgetsDigest: digestJson(budgets),
        runtimeDigest: digestJson(fixtureServiceConfig), protocolDigest: digestJson({ api: 'chat-completions' }), samplingDigest: digestJson(fixtureGeneration),
        tokenizerDigest: hash, chatTemplateDigest: hash, architecture: 'Tiny', dtype: 'float32' }, datasetRef: ref, harnessCommit: 'a'.repeat(40), harnessAdapter: 'training-tool',
      datasetTasks: [{ id: 'task', family: 'task', taskRef: ref, environmentRef }], verifierRef: ref }
    const binding = publicEndpointBinding(request.endpointBinding), evalId = `eval_${'b'.repeat(32)}`, runId = `run_${'c'.repeat(32)}`
    const state = { submits: 0, submitted: [] as readonly string[], command: undefined as { sequence: number; action: string } | undefined,
      complete: true, cancelled: false, valid: true, verifierIdentity: hash, resultBinding: binding, pendingRepair: false, repairReplyLost: false, submitReplyLost: false, repairs: 0 }
    vi.mocked(jsonProcess).mockImplementation(async (command, args, payload) => {
      if (command[0] === 'fake-python') return { path: (payload as { destination: string }).destination }
      const argv = args.slice(2), op = argv.slice(0, 2).join(' ')
      if (op === 'capabilities --json') return { external_endpoint: '1', ordered_eval_control: '2' }
      if (op === 'eval control') {
        const control = JSON.parse(await readFile(argv[argv.indexOf('--file') + 1]!, 'utf8'))
        if (state.command && (control.sequence < state.command.sequence || control.sequence === state.command.sequence && control.action !== state.command.action)) throw new TrainingContractError('eval_control_stale', 'newer eval command')
        state.command = control; state.cancelled = control.action === 'pause'
        return { ...control, eval_id: evalId, submitted: state.submits > 0, pending_reruns: state.pendingRepair }
      }
      if (op === 'eval submit') {
        state.submits++; state.submitted = argv
        expect(JSON.parse(await readFile(argv[argv.indexOf('--model-binding-file') + 1]!, 'utf8'))).toEqual(request.endpointBinding)
        if (state.submitReplyLost) { state.submitReplyLost = false; throw new Error('submit reply lost') }
        return { eval_id: evalId }
      }
      if (op === 'eval rerun') {
        state.repairs++
        if (state.repairReplyLost) throw new TrainingContractError('process-timeout', 'repair reply lost')
        return {}
      }
      const option = (name: string) => state.submitted[state.submitted.indexOf(name) + 1]
      if (op === 'eval inspect') return { control: { state: state.cancelled ? 'cancelled' : state.complete ? 'completed' : 'running' },
        request: { model: binding.endpoint_ref, endpoint_binding: binding, dataset: option('--dataset'), harness_ref: option('--harness'), timeout_ms: 10000,
          max_concurrent: Number(option('--max-concurrent')), infrastructure_retries: 0 }, plan: { candidate: { endpoint_binding: binding } },
        result: state.complete ? { task_completed: true, endpoint_binding: state.resultBinding, usage: { requests: 3, input_tokens: 9, output_tokens: 5, source: 'model-interactions-v1' },
          trials: [{ task_id: 'task', attempt: 1, run_id: runId, observation_status: state.valid ? 'valid' : 'invalid', reward: 0 }] } : null }
      if (op === 'runs inspect') return { record_status: 'valid', trajectory_status: 'valid', record: { run_id: runId, parent: { eval_id: evalId, attempt: 1 },
        context: { kind: 'benchmark_task', task_id: 'task', task_digest: hash, verifier_identity: state.verifierIdentity }, protocol: { environment_identity: hash },
        model: { provider: 'external-endpoint', requested_id: binding.endpoint_ref, effective_id: binding.wire_model, identity_resolved: false, endpoint_binding: binding },
        harness: { harness_id: harness.harnessId, requested_ref: `${request.harnessAdapter}@commit:${request.harnessCommit}`, revision_identity: hash, artifact_id: hash },
        observation: { status: 'valid', reward: 0 } } }
      if (op === 'verifier inspect') return { verifier: { status: 'complete' } }
      throw new Error(`unexpected CLI call: ${op}`)
    })
    const evaluator = new HitchModelEvaluator(store, { command: ['fake-hitch'], root: join(root, 'hitch'), workspace: join(root, 'eval'),
      harnessSourceDirectory: root, python: ['fake-python'], budgets })
    return { evaluator, request, state, root }
  }
  it('uses a ready endpoint, records upstream token usage and never plans or stops model services', async () => {
    const { evaluator, request } = await setup()
    const evidence = await evaluator.evaluate(request, 'endpoint-evaluation')
    expect(evidence).toMatchObject({ schemaVersion: 2, complete: true, gpuSeconds: null, gpuSecondsSource: null, inputTokens: 9, outputTokens: 5, requests: 3 })
    expect(JSON.stringify(evidence)).not.toContain('fixture.invalid')
    const observed = await evaluator.observeUsage(request, 'endpoint-evaluation')
    expect(observed.elapsedSeconds).toBe(evidence.schemaVersion === 2 ? evidence.elapsedSeconds : undefined)
    const calls = vi.mocked(jsonProcess).mock.calls.map(([, args]) => args)
    const submitted = calls.find(args => args.includes('submit'))!
    expect(submitted).toContain('--model-binding-file'); expect(submitted).toContain('endpoint/fixture')
    expect(submitted).toContain('16'); expect(submitted).not.toContain('--gpu')
    expect(calls.some(args => args.includes('local') || args.includes('models') || args.includes('model-node'))).toBe(false)
    expect(vi.mocked(jsonProcess).mock.calls.filter(([command]) => command[0] === 'fake-python').every(([, , payload]) => !(payload as { destination: string }).destination.includes('/models/'))).toBe(true)
  })
  it('reconciles a lost submit response without reading a mutable endpoint alias or submitting again', async () => {
    const { evaluator, request, state } = await setup(); state.submitReplyLost = true
    await expect(evaluator.evaluate(request, 'lost-submit')).rejects.toThrow('submit reply lost')
    const restored = new HitchModelEvaluator(evaluator.store, evaluator.options)
    expect((await restored.evaluate(request, 'lost-submit')).complete).toBe(true)
    expect(state.submits).toBe(1)
  })
  it('marks task cancellation separately from unknown physical GPU release', async () => {
    const { evaluator, request, state } = await setup(); state.complete = false
    await expect(evaluator.evaluate(request, 'cancel')).rejects.toMatchObject({ code: 'evaluation-pending' })
    expect(await evaluator.cancel(request, 'cancel')).toMatchObject({ tasksCompleted: false, gpuSeconds: null, gpuSecondsSource: null })
    state.complete = true
    const stopped = await evaluator.cancel(request, 'cancel')
    expect(stopped.tasksCompleted).toBe(true); expect(stopped).not.toHaveProperty('resourcesReleased')
    expect(vi.mocked(jsonProcess).mock.calls.some(([, args]) => args.includes('stop') || args.includes('drain') || args.includes('release'))).toBe(false)
  })
  it('fences first admission when cancellation arrives before a local journal exists', async () => {
    const { evaluator, request, state } = await setup()
    expect((await evaluator.cancel(request, 'before-admission')).tasksCompleted).toBe(true)
    await expect(evaluator.evaluate(request, 'before-admission')).rejects.toMatchObject({ code: 'eval_control_stale' })
    expect(state.submits).toBe(0)
  })
  it('rejects endpoint or canonical verifier drift and key reuse with another frozen binding', async () => {
    const { evaluator, request, state } = await setup()
    state.resultBinding = { ...state.resultBinding, wire_model: 'other-model' }
    await expect(evaluator.evaluate(request, 'drift')).rejects.toMatchObject({ code: 'hitch-endpoint-drift' })
    state.resultBinding = publicEndpointBinding(request.endpointBinding); state.verifierIdentity = digestJson('wrong-verifier')
    await expect(evaluator.evaluate(request, 'drift')).rejects.toMatchObject({ code: 'canonical-evaluation-identity-drift' })
    const changed = structuredClone(request); changed.endpointBinding.generation.max_output_tokens = 4096
    await expect(evaluator.evaluate(changed, 'drift')).rejects.toMatchObject({ code: 'evaluation-sampling-drift' })
  })
  it('retains invalid slot repair intent across an uncertain reply', async () => {
    const { evaluator, request, state } = await setup(); state.valid = false
    expect((await evaluator.evaluate(request, 'repair')).complete).toBe(false)
    state.repairReplyLost = true
    await expect(evaluator.evaluate(request, 'repair')).rejects.toMatchObject({ code: 'evaluation-pending' })
    state.repairReplyLost = false; state.valid = true
    expect((await evaluator.evaluate(request, 'repair')).complete).toBe(true)
    expect(state.submits).toBe(1); expect(state.repairs).toBe(2)
  })
  it('freezes a new deployment attempt, keeps reward zero, and reconciles a lost repair reply without changing the root request', async () => {
    const { evaluator, request, state, root } = await setup()
    request.condition.slots.push({ ...request.condition.slots[0]!, attempt: 2 })
    const before = await evaluator.evaluate(request, 'incarnation-repair')
    expect(before.complete).toBe(false); expect(before.trials[0]!.reward).toBe(0)
    const changed = structuredClone(request), binding = changed.endpointBinding
    binding.wire_model = 'new-incarnation'; binding.deployment_receipt.wire_model = binding.wire_model; binding.deployment_receipt.deployment_ref = 'new-incarnation'
    binding.endpoint_revision = digestJson({ schema_version: '1', ...binding.connection, wire_model: binding.wire_model, api: binding.api, capabilities: binding.capabilities })
    await expect(evaluator.evaluate(changed, 'incarnation-repair')).rejects.toMatchObject({ code: 'evaluation-attempt-drift' })
    const parentId = evaluationAttemptId(request.endpointBinding), id = evaluationAttemptId(binding), childRun = `run_${'d'.repeat(32)}`
    const originalCall = vi.mocked(jsonProcess).getMockImplementation()!
    let repairCommitted = false, loseReply = true, admissions = 0, pendingReruns = true
    vi.mocked(jsonProcess).mockImplementation(async (command, args, payload, timeout) => {
      const argv = args.slice(2), operation = argv.slice(0, 2).join(' ')
      if (operation === 'capabilities --json') return { ordered_eval_control: '2', endpoint_evaluation_attempts: '1' }
      if (operation === 'eval rerun') {
        const file = argv[argv.indexOf('--endpoint-attempt-file') + 1]!
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ id, parent_id: parentId, endpoint_binding: binding })
        if (!repairCommitted) { repairCommitted = true; admissions++ }
        if (loseReply) { loseReply = false; throw new TrainingContractError('process-timeout', 'reply lost after completed repair') }
        return {}
      }
      const result = await originalCall(command, args, payload, timeout) as Record<string, any>
      if (operation === 'eval inspect' && repairCommitted) return { ...result, pending_reruns: pendingReruns, endpoint_attempts: [
        { id: parentId, endpoint_binding: publicEndpointBinding(request.endpointBinding) },
        { id, parent_id: parentId, endpoint_binding: publicEndpointBinding(binding), selected_trials: [{ task_id: 'task', attempt: 2 }] }],
      result: { ...result.result, usage: { requests: 7, input_tokens: 25, output_tokens: 14, source: 'model-interactions-v1' },
        trials: [...result.result.trials, { task_id: 'task', attempt: 2, run_id: childRun, observation_status: 'valid', reward: 1 }] } }
      if (operation === 'runs inspect' && argv[2] === childRun) return { ...result, record: { ...result.record, run_id: childRun,
        parent: { ...result.record.parent, attempt: 2 }, model: { provider: 'external-endpoint', requested_id: binding.endpoint_ref, effective_id: binding.wire_model, endpoint_binding: publicEndpointBinding(binding) },
        observation: { status: 'valid', reward: 1 } } }
      return result
    })
    const intent = { schemaVersion: 2 as const, sequence: 2, action: 'start' as const }
    await expect(evaluator.evaluate(changed, 'incarnation-repair', intent, { id, parentId })).rejects.toMatchObject({ code: 'evaluation-pending' })
    const restored = new HitchModelEvaluator(evaluator.store, evaluator.options)
    expect(await restored.observeUsage(changed, 'incarnation-repair')).toMatchObject({ requests: 7, inputTokens: 25 })
    vi.mocked(jsonProcess).mockClear()
    expect(await restored.reconcileEvidence(changed, 'incarnation-repair')).toBeUndefined()
    expect(vi.mocked(jsonProcess).mock.calls.every(([, args]) => args.slice(2, 4).join(' ') === 'eval inspect')).toBe(true)
    pendingReruns = false
    vi.mocked(jsonProcess).mockClear()
    const reconciled = await restored.reconcileEvidence(changed, 'incarnation-repair')
    expect(reconciled?.complete).toBe(true)
    expect(vi.mocked(jsonProcess).mock.calls.every(([, args]) => ['eval inspect', 'runs inspect', 'verifier inspect'].includes(args.slice(2, 4).join(' ')))).toBe(true)
    const evidence = await restored.evaluate(changed, 'incarnation-repair', intent, { id, parentId })
    expect(evidence).toMatchObject({ complete: true, requests: 7, inputTokens: 25, outputTokens: 14 })
    expect(evidence.trials[0]).toEqual(before.trials[0]); expect(admissions).toBe(1); expect(state.submits).toBe(1)
    expect(evidence.schemaVersion === 2 && evidence.endpointAttempts?.map(attempt => attempt.id)).toEqual([parentId, id])
    const directory = join(root, 'eval', 'evaluations', digestJson('incarnation-repair').slice(7))
    const journal = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(journal.requestDigest).toBe(digestJson(request)); expect(journal.request.endpointBinding).toEqual(request.endpointBinding)
    expect(JSON.parse(await readFile(join(directory, 'attempts', id, 'request.json'), 'utf8'))).toEqual(changed)
    await expect(restored.evaluate(request, 'incarnation-repair', intent)).rejects.toMatchObject({ code: 'evaluation-attempt-stale' })
  })
})
