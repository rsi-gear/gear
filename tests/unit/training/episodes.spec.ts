import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrainingEpisodeCoordinator, validateRolloutIntent } from '../../../src/training/episodes.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { digestJson } from '../../../src/training/digest.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { ModelTrainingStore, TrainingContentStore } from '../../../src/training/store.js'
import type { ContentRef, TrainingHandle, TrainingRequestV2 } from '../../../src/training/types.js'
import { jsonProcess } from '../../../src/training/process.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'

type Json = Record<string, any>

describe('controller-owned rollout reconciliation', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gear-episodes-')); roots.push(root)
    const store = new ModelTrainingStore(join(root, 'controller')), node = new TrainingContentStore(join(root, 'node'))
    const legacy = await fixture(store), hash = digestJson('canonical-identity')
    const harness = { harnessId: 'training-tool', revisionIdentity: hash, artifactId: hash }
    legacy.fixedHarness.manifestRef = await store.putJson({ hitch: harness })
    legacy.datasets.train.tasks[0]!.environmentRef = await store.putJson({ taskDigest: hash, verifierIdentity: hash, hitchEnvironmentIdentity: hash })
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(v2spec(legacy))
    const request = (await coordinator.admit(experiment.id)).request as TrainingRequestV2
    const task = request.trainDataset.tasks[0]!
    const handle: TrainingHandle = { schemaVersion: 1, provider: 'slime', jobId: `job_${'a'.repeat(32)}`, requestDigest: digestJson(request) }
    const sampling = { temperature: 1, top_p: 1, top_k: -1, repetition_penalty: 1, max_new_tokens: 16,
      skip_special_tokens: false, spaces_between_special_tokens: false, no_stop_trim: true }
    const lease = { schemaVersion: 1, trainingRunId: request.trainingRunId, batchId: 'batch-0', policyVersion: 'runtime-1/update-0',
      parentModelVersionId: request.parentModel.id, synchronizedWeightsRef: await node.putJson({ weights: 'fixture' }), runtimeInstanceId: 'runtime-1',
      samplingDigest: digestJson(sampling), fencingToken: 'fence-0', expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'serving' }
    const id = 'episode-0', bindingId = `binding_${'a'.repeat(32)}`
    const context = { id, groupId: 'group-0', slot: 0, runId: null, taskId: task.id, logicalAttempt: 1, trainingRunId: request.trainingRunId,
      batchId: lease.batchId, bindingId, harnessRef: request.fixedHarness.manifestRef, taskRef: task.taskRef, environmentRef: task.environmentRef,
      policyVersion: lease.policyVersion, wireModel: lease.policyVersion, runtimeInstanceId: lease.runtimeInstanceId,
      tokenizerDigest: request.parentModel.tokenizerDigest, chatTemplateDigest: request.parentModel.chatTemplateDigest, sampling,
      maxContextTokens: 128, maxEpisodeSteps: request.budgets.maxEpisodeSteps, maxRolloutTokens: request.budgets.maxRolloutTokens,
      generationContractDigest: request.trainer.runtimeLock.protocolDigest, verifierVersion: request.verifier.digest }
    const binding = { kind: 'training-external', bindingId, trainingRunId: request.trainingRunId, policyLeaseRef: await node.putJson(lease),
      expectedPolicyVersion: lease.policyVersion, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt,
      endpointRef: `hitch-training:${bindingId}`, credentialRef: `hitch-training:${bindingId}`, requiredCapture: 'exact-policy-tokens-v1', api: 'chat-completions',
      generationContractDigest: request.trainer.runtimeLock.protocolDigest, maxOutputTokens: 16, maxEpisodeSteps: request.budgets.maxEpisodeSteps }
    const body = { schemaVersion: 2, id, jobId: handle.jobId, incarnation: 'incarnation-1', trainingRunId: request.trainingRunId,
      context, binding, lease, key: digestJson([request.trainingRunId, lease.batchId, task.taskRef.digest, context.groupId, 0]), gateway: { nodePort: 31001 }, credential: 'd'.repeat(64) }
    const intent = validateRolloutIntent({ ...body, inputDigest: digestJson(body) }, request, handle)
    const entry: Json = { intent, cancelRequested: false, ack: null, result: null }
    const runId = `run_${'c'.repeat(32)}`, evalId = `eval_${'b'.repeat(32)}`
    const raw = await node.putJson({ native: 'raw-generation' })
    const receipt = { schemaVersion: 1, id: 'receipt-0', episodeId: id, callIndex: 0, requestId: 'request-0', runId, taskId: task.id, logicalAttempt: 1,
      policyVersion: lease.policyVersion, runtimeInstanceId: lease.runtimeInstanceId, tokenizerDigest: context.tokenizerDigest, chatTemplateDigest: context.chatTemplateDigest,
      effectiveSamplingRef: await node.putJson(sampling), inputTokenIdsRef: await node.putJson([1, 2]), outputTokenIdsRef: await node.putJson([3, 4]),
      behaviorLogProbsRef: await node.putJson([-.1, -.2]), rawRequestRef: raw, rawResponseRef: raw, finishReason: 'stop', complete: true }
    const receiptRef = await node.putJson(receipt)
    const state = { submits: 0, submitted: [] as readonly string[], loseSubmitReply: false, loseResultReply: false, loseAdmissionReply: false,
      terminal: true, cancelled: false, wrongVerifier: false, admission: { valid: true } as Json, admitted: 0, resultCalls: 0,
      canonicalHarnessRef: `training-tool@commit:${request.fixedHarness.commit}`, canonicalHarnessArtifact: hash }
    const transport = new ModelNodeTransport({ transport: { type: 'local' }, workspace: root, python: ['fixture'], configPath: join(root, 'node.json'),
      gateway: { localPort: 31001, nodePort: 31001 } }, { nodeId: 'gpu-node', generation: 'boot-1' })
    const uploaded: ContentRef[] = []
    vi.spyOn(transport, 'upload').mockImplementation(async (source, ref) => { uploaded.push(ref); await node.putBytes(await source.readBytes(ref), ref.mediaType) })
    vi.spyOn(transport, 'download').mockImplementation(async (destination, ref) => {
      try { await destination.readBytes(ref) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await destination.putBytes(await node.readBytes(ref), ref.mediaType)
      }
    })
    vi.spyOn(transport, 'gateway').mockResolvedValue('http://127.0.0.1:31001')
    const rpc = vi.spyOn(transport, 'call').mockImplementation(async (op, payload) => {
      const p = payload as Json
      if (op === 'training.episodes.list') return { schemaVersion: 2, jobId: handle.jobId, entries: [structuredClone(entry)], nextCursor: null }
      if (op === 'training.episodes.ack') { expect(p.ack).toEqual({ evalId }); entry.ack = p.ack; return { ack: p.ack } }
      if (op === 'training.episodes.receipts') return { runId, complete: true, receiptRefs: [receiptRef] }
      if (op === 'training.episodes.admit') {
        state.admitted++
        if (state.loseAdmissionReply) { state.loseAdmissionReply = false; throw new Error('admission reply lost') }
        return state.admission
      }
      if (op === 'training.episodes.result') {
        state.resultCalls++; if (entry.result) expect(p.result).toEqual(entry.result)
        entry.result = p.result
        if (state.loseResultReply) { state.loseResultReply = false; throw new Error('result reply lost') }
        return { accepted: true }
      }
      throw new Error(`unexpected RPC ${op}`)
    })
    const invoke: typeof jsonProcess = vi.fn(async (command, args, payload) => {
      if (command[0] === 'fixture-python') return { path: (payload as Json).destination }
      const a = args.slice(2), op = a.slice(0, 2).join(' ')
      if (a[0] === 'capabilities') return { training_external_binding: '1', exact_policy_tokens: '1', training_policy_fencing: '1', training_harnesses: ['training-tool'] }
      if (op === 'training runtime') return { schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: hash,
        source: { kind: 'git-checkout', commit: request.trainer.runtimeLock.hitchCommit, dirty: true } }
      if (op === 'training register') return { binding: (payload as Json).binding }
      if (op === 'eval submit') {
        if (state.submitted.length) expect(a).toEqual(state.submitted)
        state.submitted = a; state.submits++
        if (state.loseSubmitReply) { state.loseSubmitReply = false; throw new Error('submit reply lost') }
        return { eval_id: evalId }
      }
      if (op === 'eval cancel') { state.cancelled = true; return {} }
      if (op === 'eval inspect') return { request: { request: { training_binding: binding, harness_ref: state.submitted[state.submitted.indexOf('--harness') + 1] } }, control: { state: state.terminal ? 'completed' : 'running' },
        result: state.terminal ? { status: state.cancelled ? 'cancelled' : 'succeeded', trials: [{ task_id: task.id, run_id: runId, attempt: 1, observation_status: 'valid', reward: 0 }] } : null }
      if (op === 'runs inspect') return { record_status: 'valid', trajectory_status: 'valid', record: { run_id: runId, parent: { eval_id: evalId, attempt: 1 },
        context: { kind: 'benchmark_task', task_id: task.id, task_digest: hash, verifier_identity: state.wrongVerifier ? digestJson('other') : hash },
        protocol: { environment_identity: hash }, model: { provider: 'slime-training', effective_id: lease.policyVersion, identity_resolved: true },
        harness: { harness_id: harness.harnessId, revision_identity: hash, artifact_id: state.canonicalHarnessArtifact, requested_ref: state.canonicalHarnessRef },
        observation: { status: 'valid', reward: 0 } } }
      if (op === 'verifier inspect') return { verifier: { status: 'complete', private: 'controller-only-verifier-output' } }
      if (op === 'training evidence') return { training_external: { policy_version: lease.policyVersion }, termination: 'terminated' }
      throw new Error(`unexpected Hitch call ${op}`)
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ...lease, episodeId: id, capture: 'exact-policy-tokens-v1', generationContractDigest: context.generationContractDigest }))
    const options = { command: ['fixture-hitch'], root: join(root, 'hitch'), workspace: join(root, 'episodes'), python: ['fixture-python'], harnessSourceDirectory: root, episodeTimeoutSeconds: 10 }
    const create = () => new TrainingEpisodeCoordinator(store, transport, options, invoke, fetcher)
    const episodes = create(); await episodes.remember(request, handle.jobId)
    const statePath = join(options.workspace, 'training-episodes', handle.jobId, digestJson(id).slice(7), 'state.json')
    return { episodes, create, store, node, handle, request, entry, state, rpc, intent, uploaded, transport, invoke, fetcher, statePath }
  }
  it('collects native evidence, keeps zero reward and sends only verifier projections to the node', async () => {
    const s = await setup(); await s.episodes.preflight(s.request)
    expect(await s.episodes.reconcile(s.handle)).toEqual({ pending: false })
    expect(s.entry.result.outcome).toBe('feedback'); expect(s.state.submits).toBe(1)
    const feedback = await s.node.readJson<Json>(s.entry.result.feedbackRef)
    expect(feedback.reward).toBe(0)
    const projection = await s.node.readJson<Json>(feedback.verifierEvidenceRef)
    expect(projection.kind).toBe('controller-verifier-observation')
    await expect(s.node.readBytes(projection.sourceEvidenceRef)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(s.node.readBytes(s.request.trainDataset.tasks[0]!.taskRef)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(await s.store.readJson(projection.sourceEvidenceRef))).toContain('controller-only-verifier-output')
    expect(s.uploaded).toHaveLength(4)
    expect(await s.create().reconcile(s.handle)).toEqual({ pending: false }); expect(s.state.submits).toBe(1)
  })
  it('accepts the real Python driver lease through the durable node journal', async () => {
    const s = await setup()
    const intent = await jsonProcess(['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'],
      [resolve('python/tests/emit_driver_intent.py')], { request: s.request, intent: s.intent })
    expect(validateRolloutIntent(intent, s.request, s.handle).lease.samplingDigest).toBe(digestJson(s.intent.context.sampling))
  })
  it.each(['reference', 'artifact'])('rejects canonical harness %s drift before native admission', async field => {
    const s = await setup()
    if (field === 'reference') s.state.canonicalHarnessRef = `training-tool@commit:${'f'.repeat(40)}`
    else s.state.canonicalHarnessArtifact = digestJson('different-artifact')
    await expect(s.episodes.reconcile(s.handle)).rejects.toMatchObject({ code: 'training-canonical-identity-drift' })
    expect(s.state.admitted).toBe(0); expect(s.entry.result).toBeNull()
  })
  it('rejects controller source drift before admitting any training episode', async () => {
    const s = await setup()
    vi.mocked(s.invoke).mockImplementationOnce(async () => ({ schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: digestJson('runtime'),
      source: { kind: 'git-checkout', commit: 'f'.repeat(40), dirty: false } }))
    await expect(s.episodes.preflight(s.request)).rejects.toMatchObject({ code: 'hitch-commit-drift' })
    expect(s.state.submits).toBe(0)
  })
  it('replays an uncertain submit with its original binding and key, including during cancellation', async () => {
    const s = await setup(); s.state.loseSubmitReply = true
    await expect(s.episodes.reconcile(s.handle)).rejects.toThrow('submit reply lost')
    expect(JSON.parse(await readFile(s.statePath, 'utf8')).submitted).toBe(true)
    s.entry.cancelRequested = true
    expect(await s.create().reconcile(s.handle, true)).toEqual({ pending: false })
    expect(s.state.submits).toBe(2); expect(s.state.cancelled).toBe(true); expect(s.entry.result.outcome).toBe('cancelled')
  })
  it('reconciles accepted feedback after reply loss without resubmitting or changing its reward', async () => {
    const s = await setup(); s.state.loseResultReply = true
    await expect(s.episodes.reconcile(s.handle)).rejects.toThrow('result reply lost')
    expect(await s.create().reconcile(s.handle)).toEqual({ pending: false })
    expect(s.state.submits).toBe(1); expect(s.state.resultCalls).toBe(1)
  })
  it('retries an unknown admission outcome but journals a known invalid native sample as rejected', async () => {
    const s = await setup(); s.state.loseAdmissionReply = true
    await expect(s.episodes.reconcile(s.handle)).rejects.toThrow('admission reply lost')
    expect(JSON.parse(await readFile(s.statePath, 'utf8')).result).toBeUndefined()
    s.state.admission = { valid: false, reason: 'nonlinear-token-history' }
    expect(await s.create().reconcile(s.handle)).toEqual({ pending: false })
    expect(s.entry.result).toMatchObject({ outcome: 'rejected', reason: 'nonlinear-token-history' })
    expect(s.state.submits).toBe(1)
  })
  it('does not resolve or consume evidence from another canonical verifier', async () => {
    const s = await setup(); s.state.wrongVerifier = true
    await expect(s.episodes.reconcile(s.handle)).rejects.toMatchObject({ code: 'training-canonical-identity-drift' })
    expect(s.entry.result).toBeNull(); expect(s.uploaded).toHaveLength(0)
  })
  it('rejects a rehashed task or policy assignment before any Hitch dispatch', async () => {
    const s = await setup()
    s.entry.intent.context.taskRef = s.request.verifier
    const { inputDigest: _, ...body } = s.entry.intent; s.entry.intent.inputDigest = digestJson(body)
    await expect(s.episodes.reconcile(s.handle)).rejects.toMatchObject({ code: 'episode-assignment-drift' })
    expect(s.state.submits).toBe(0)
  })
  it('cancels an undispatched slot without ever submitting Hitch work', async () => {
    const s = await setup(); s.entry.cancelRequested = true
    expect(await s.episodes.reconcile(s.handle)).toEqual({ pending: false })
    expect(s.entry.result).toMatchObject({ outcome: 'cancelled', evalId: null }); expect(s.state.submits).toBe(0)
  })
  it('stops new dispatch when a successful heartbeat reports that the lease was fenced', async () => {
    const s = await setup()
    const response = await s.fetcher('http://fixture')
    s.fetcher.mockImplementationOnce(async () => {
      s.entry.cancelRequested = true
      await new Promise(resolve => setTimeout(resolve, 2200))
      return response
    })
    await expect(s.episodes.reconcile(s.handle)).rejects.toMatchObject({ code: 'controller-contact-lost' })
    expect(s.state.submits).toBe(0)
    expect(await s.create().reconcile(s.handle)).toEqual({ pending: false })
    expect(s.entry.result).toMatchObject({ outcome: 'cancelled', evalId: null })
  })
})
