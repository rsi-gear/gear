import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSlimeModelTrainer } from '../../../src/training/slime.js'
import { ModelTrainingCoordinator, trainingCompatibilityDigest } from '../../../src/training/coordinator.js'
import { digestJson } from '../../../src/training/digest.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { ModelTrainingStore, withTrainingFileLock } from '../../../src/training/store.js'
import { parseTrainingBatch, sealModelVersion } from '../../../src/training/schema.js'
import { jsonProcess } from '../../../src/training/process.js'
import type { ContentRef, TrainingArtifacts, TrainingHandle, TrainingRequestV2, TrainingStatus, UpdateCommitManifest } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'

describe('model-node trainer and controller episode lifecycle', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gear-node-trainer-')); roots.push(root)
    const store = new ModelTrainingStore(join(root, 'controller')), node = new ModelTrainingStore(join(root, 'node'))
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const spec = v2spec(await fixture(store))
    const file = await store.putBytes(Buffer.from('CPU model fixture'), 'application/octet-stream')
    const hf = await store.putJson({ schemaVersion: 1, format: 'hf-safetensors', files: [{ path: 'model.safetensors', size: 17, sha256: file.digest, contentRef: file }] })
    const { id: _, ...model } = await store.readJson<any>(spec.initialModel)
    spec.initialModel = await store.putJson(sealModelVersion({ ...model, hfSnapshotRef: hf }))
    spec.referenceModel = spec.initialModel
    const experiment = await coordinator.createExperiment(spec)
    const request = (await coordinator.admit(experiment.id)).request as TrainingRequestV2
    const key = 'stable-job-key', local: TrainingHandle = { schemaVersion: 1, provider: 'slime', jobId: `job_${digestJson(key).slice(7, 39)}`, requestDigest: digestJson(request) }
    const transport = new ModelNodeTransport({ transport: { type: 'local' }, workspace: root, python: ['fixture'], configPath: 'fixture',
      gateway: { localPort: 31001, nodePort: 31001 } }, { nodeId: 'gpu-node', generation: 'boot-1' })
    const handle: TrainingHandle = { ...local, schemaVersion: 2, node: transport.identity! }
    const status: TrainingStatus = { schemaVersion: 1, handle: local, execution: 'running', phase: 'collecting', committedUpdate: 0,
      usage: { gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 }, resourcesReleased: false }
    const state = { exists: false, pending: false, submissions: 0, remembered: false, artifacts: undefined as TrainingArtifacts | undefined }
    const episodes = { preflight: vi.fn(async () => {}), remember: vi.fn(async () => { state.remembered = true }), reconcile: vi.fn(async () => ({ pending: state.pending })) }
    const controlledEpisodes = { ...episodes, withControl: async <R>(handle: TrainingHandle, action: (reconcile: (cancel?: boolean) => Promise<{ pending: boolean }>) => Promise<R>): Promise<R> => withTrainingFileLock(join(root, 'control.lock'), () => action(cancel => (episodes.reconcile as (...args: unknown[]) => Promise<{ pending: boolean }>)(handle, cancel))) }
    const rpc = vi.spyOn(transport, 'call').mockImplementation(async (operation, payload) => {
      if (operation === 'probe') return { capabilities: { orderedTrainingControl: true } }
      if (operation === 'training.find') return { exists: state.exists, ...(state.exists ? { status: structuredClone(status) } : {}) }
      if (operation === 'training.control') {
        expect(state.remembered).toBe(true); expect(payload).toMatchObject({ request, idempotencyKey: key, intent: { schemaVersion: 2 } })
        state.exists = true; state.submissions++; return structuredClone(status)
      }
      if (operation === 'training.inspect' || operation === 'training.cancel') return structuredClone(status)
      if (operation === 'training.collect') return state.artifacts
      if (operation === 'training.preflight') return new FixtureTrainer(node).preflight(request)
      throw new Error(`unexpected node operation ${operation}`)
    })
    const uploaded: ContentRef[] = []
    vi.spyOn(transport, 'upload').mockImplementation(async (source, ref) => { uploaded.push(ref); await node.putBytes(await source.readBytes(ref), ref.mediaType) })
    const downloaded: ContentRef[] = []
    vi.spyOn(transport, 'download').mockImplementation(async (destination, ref) => {
      downloaded.push(ref)
      try { await destination.readBytes(ref) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await destination.putBytes(await node.readBytes(ref), ref.mediaType)
      }
    })
    const trainer = new NodeSlimeModelTrainer(transport, store, controlledEpisodes)
    return { root, store, node, request, key, local, handle, status, state, rpc, episodes, uploaded, downloaded, trainer }
  }
  it('separates controller preflight and uploads model inputs without train task bodies', async () => {
    const s = await setup()
    expect((await s.trainer.preflight(s.request)).blockers).toEqual([])
    expect(s.episodes.preflight).toHaveBeenCalledWith(s.request)
    expect(s.uploaded).toContainEqual(s.request.parentModelRef)
    expect(s.uploaded).not.toContainEqual(s.request.trainDataset.tasks[0]!.taskRef)
    expect(await s.trainer.submit(s.request, s.key)).toEqual(s.handle)
    expect(s.episodes.remember).toHaveBeenCalledWith(s.request, s.local.jobId)
    expect(await s.trainer.submit(s.request, s.key)).toEqual(s.handle)
    expect(s.episodes.reconcile).toHaveBeenLastCalledWith(s.local, false)
  })
  it('does not traverse held-out or private verifier refs embedded in JSON model files', async () => {
    const s = await setup()
    const held = await s.store.putJson({ heldOut: 'PRIVATE-HELD-OUT-CONTENT' })
    const verifier = await s.store.putJson({ answer: 'PRIVATE-VERIFIER-CONTENT' })
    const config = await s.store.putJson({ model_type: 'fixture', metadata: { held, verifier } })
    const bytes = await s.store.readBytes(config)
    const hf = await s.store.putJson({ schemaVersion: 1, format: 'hf-safetensors', files: [{ path: 'config.json', size: bytes.length, sha256: config.digest, contentRef: config }] })
    const { id: _, ...model } = s.request.parentModel
    s.request.parentModel = sealModelVersion({ ...model, hfSnapshotRef: hf })
    s.request.parentModelRef = await s.store.putJson(s.request.parentModel)
    await s.trainer.preflight(s.request)
    expect(await s.node.readBytes(config)).toEqual(bytes)
    for (const ref of [held, verifier, s.request.trainDataset.tasks[0]!.taskRef]) {
      expect(s.uploaded).not.toContainEqual(ref)
      await expect(s.node.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('rejects undeclared snapshot references before sending snapshot bytes', async () => {
    const s = await setup()
    const hf = await s.store.readJson<any>(s.request.parentModel.hfSnapshotRef)
    const forbidden = await s.store.putJson({ secret: 'PRIVATE-HELD-OUT-CONTENT' })
    const poisoned = await s.store.putJson({ ...hf, provenance: forbidden })
    const { id: _, ...model } = s.request.parentModel
    s.request.parentModel = sealModelVersion({ ...model, hfSnapshotRef: poisoned })
    s.request.parentModelRef = await s.store.putJson(s.request.parentModel)
    await expect(s.trainer.preflight(s.request)).rejects.toMatchObject({ code: 'model-input-reference-leak' })
    expect(s.uploaded).not.toContainEqual(poisoned)
    expect(s.uploaded).not.toContainEqual(forbidden)
  })
  it('retains ownership until both the model node and old Hitch episodes have terminated', async () => {
    const s = await setup(); s.status.execution = 'paused'; s.status.resourcesReleased = true; s.state.pending = true
    expect((await s.trainer.control(s.request, s.key, { schemaVersion: 2, sequence: 1, action: 'pause' })).resourcesReleased).toBe(false)
    expect(s.episodes.reconcile).toHaveBeenLastCalledWith(s.local, true)
    s.state.pending = false
    expect((await s.trainer.inspect(s.handle)).resourcesReleased).toBe(true)
  })
  it('rejects old node control capabilities before preflight can upload or dispatch work', async () => {
    const s = await setup(), original = s.rpc.getMockImplementation()!
    s.rpc.mockImplementation((operation, payload, id) => operation === 'probe' ? Promise.resolve({ capabilities: { durableTrainingJobs: true } }) : original(operation, payload, id))
    await expect(s.trainer.preflight(s.request)).rejects.toMatchObject({ code: 'training-control-unavailable' })
    expect(s.uploaded).toEqual([]); expect(s.episodes.preflight).not.toHaveBeenCalled(); expect(s.state.submissions).toBe(0)
  })
  it('finishes old pause episode cancellation before a newer start can reach the node', async () => {
    const s = await setup(), events: string[] = []
    let entered!: () => void, release!: () => void, phase = 'pause'
    const ready = new Promise<void>(done => { entered = done }), waiting = new Promise<void>(done => { release = done })
    const original = s.rpc.getMockImplementation()!
    s.rpc.mockImplementation(async (operation, payload, id) => {
      if (operation === 'training.control') {
        const { intent } = payload as { intent: { action: string } }
        events.push(`${intent.action}-rpc`)
        if (intent.action === 'pause') { entered(); await waiting }
        phase = intent.action; s.status.execution = phase === 'pause' ? 'paused' : 'running'; s.status.resourcesReleased = phase === 'pause'
      }
      return original(operation, payload, id)
    })
    s.episodes.reconcile.mockImplementation(async () => { events.push(`${phase}-reconcile`); return { pending: false } })
    const pausing = s.trainer.control(s.request, s.key, { schemaVersion: 2, sequence: 1, action: 'pause' })
    await ready
    const resuming = s.trainer.control(s.request, s.key, { schemaVersion: 2, sequence: 2, action: 'start' })
    try { await new Promise(done => setTimeout(done, 80)); expect(events).toEqual(['pause-rpc']) }
    finally { release() }
    await Promise.all([pausing, resuming])
    expect(events).toEqual(['pause-rpc', 'pause-reconcile', 'pause-reconcile', 'start-rpc', 'start-reconcile'])
  })
  it('does not restart an interrupted incarnation until old canonical slots are resolved', async () => {
    const s = await setup(); s.state.exists = true; s.status.execution = 'interrupted'; s.status.resourcesReleased = true; s.state.pending = true
    await expect(s.trainer.control(s.request, s.key, { schemaVersion: 2, sequence: 1, action: 'start' })).rejects.toMatchObject({ code: 'controller-episodes-pending' })
    expect(s.state.submissions).toBe(0)
    s.state.pending = false
    expect((await s.trainer.control(s.request, s.key, { schemaVersion: 2, sequence: 1, action: 'start' })).handle).toEqual(s.handle)
    expect(s.episodes.reconcile).toHaveBeenLastCalledWith(s.local, true)
  })
  it('rejects a stale node generation before invoking any transport or controller operation', async () => {
    const s = await setup(); s.request.deployment.modelRuntime.generation = 'old-boot'
    await expect(s.trainer.submit(s.request, s.key)).rejects.toMatchObject({ code: 'training-node-drift' })
    expect(s.rpc).not.toHaveBeenCalled(); expect(s.episodes.remember).not.toHaveBeenCalled()
  })
  it('agrees with the Python v2 checkpoint identity and resolves a single physical GPU for colocated execution', async () => {
    const s = await setup()
    const actual = await jsonProcess(['env', `PYTHONPATH=${resolve('python')}`, 'python3'], ['-c', `
import json, sys
from gear_training.preflight import compatibility_digest
from gear_training.execution import training_devices
from gear_training.placement import resource_plan, placement_probe_digest
request = json.load(sys.stdin)
placement, counts, _ = resource_plan(request, [])
original = placement_probe_digest(request)
digest = compatibility_digest(request)
devices = training_devices(request)
request["deployment"]["modelRuntime"]["generation"] = "another-generation"
print(json.dumps({"compatibilityDigest": digest, "devices": devices, "placement": placement, "counts": counts, "probeChanged": original != placement_probe_digest(request)}))
`], s.request) as { compatibilityDigest: string; devices: string[]; placement: string; counts: Record<string, number>; probeChanged: boolean }
    expect(actual.compatibilityDigest).toBe(trainingCompatibilityDigest(s.request))
    expect(actual.devices).toEqual(['GPU-123']); expect(actual.placement).toBe('colocated')
    expect(actual.counts['--actor-num-gpus-per-node']).toBe(1); expect(actual.counts['--rollout-num-gpus']).toBe(1)
    expect(actual.probeChanged).toBe(true)
  })
  it('collects implicit consumed-batch and source-evidence dependencies across separate stores', async () => {
    const s = await setup(), backend = new FixtureTrainer(s.node)
    await backend.submit(s.request)
    const artifacts = await backend.collect(s.local)
    const native = await s.node.putBytes(Buffer.from('exact-native-data'), 'application/octet-stream')
    const evidence = await s.node.putJson({ nativeRef: native })
    const opaque = await s.node.putJson({ samples: 'fixture' })
    const body = { schemaVersion: 2, trainingRunId: s.request.trainingRunId, policyVersion: 'fixture', recipeDigest: s.request.recipeDigest,
      datasetSplitDigest: s.request.datasetSplitDigest, groupsRef: opaque, samplesRef: opaque, sourceEvidenceRefs: [evidence],
      sourceEvidenceDigest: digestJson([evidence]), state: 'sealed' }
    const batch = parseTrainingBatch({ ...body, id: digestJson(body) }), batchRef = await s.node.putJson(batch)
    const commit = await s.node.readJson<UpdateCommitManifest>(artifacts.updateCommitRefs[0]!)
    artifacts.updateCommitRefs = [await s.node.putJson({ ...commit, consumedBatchDigest: batchRef.digest })]
    artifacts.handle = s.local; s.state.artifacts = artifacts
    const collected = await s.trainer.collect(s.handle)
    expect(collected.handle).toEqual(s.handle)
    expect(await s.store.readJson(batchRef)).toEqual(batch)
    expect((await s.store.readBytes(native)).toString()).toBe('exact-native-data')
    expect(s.downloaded).toContainEqual(evidence)
    const changed = { ...body, sourceEvidenceRefs: [] }
    expect(() => parseTrainingBatch({ ...changed, id: digestJson(changed) })).toThrow('evidence')
  })
})
