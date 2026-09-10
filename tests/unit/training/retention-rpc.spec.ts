import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retainContentGraph } from '../../../src/training/retention.js'
import { ModelNodeTransport, uploadSnapshotFiles } from '../../../src/training/transport.js'
import { atomicWrite, ModelTrainingStore } from '../../../src/training/store.js'
import type { ContentRef, ModelNodeConnection, NodeIdentity } from '../../../src/training/types.js'
import { trainingCommand, trainingController, type TrainingControllerConfigV2 } from '../../../src/training/cli.js'
import { digestJson } from '../../../src/training/digest.js'
import { sealModelVersion } from '../../../src/training/schema.js'
import * as trainingProcess from '../../../src/training/process.js'
import { fixture } from './fixture.js'
import { deployment, v2spec } from './placement-fixture.js'
import type { ModelRelease } from '../../../src/training/types.js'

describe('model-node retention through real Python RPC', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gear-retention-rpc-')); roots.push(root)
    const node = new ModelTrainingStore(join(root, 'node-cas')), store = new ModelTrainingStore(join(root, 'controller'))
    const configPath = join(root, 'node.json')
    await atomicWrite(configPath, { schemaVersion: 2, nodeId: 'retention-node', nodeRoot: join(root, 'node'), storeRoot: node.root, jobConfigPath: join(root, 'job.json') })
    const connection: ModelNodeConnection = { transport: { type: 'local' }, workspace: root, configPath,
      python: ['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'], gateway: { localPort: 31991, nodePort: 31991 } }
    const probe = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
    const transport = new ModelNodeTransport(connection, { nodeId: probe.nodeId, generation: probe.generation })
    const weight = await node.putBytes(Buffer.alloc(1024 * 1024, 37), 'application/octet-stream')
    const secret = await store.putJson({ privateVerifier: 'CONTROLLER-PRIVATE-SENTINEL' })
    const config = await node.putJson({ model_type: 'fixture', opaqueReference: secret })
    const configBytes = await node.readBytes(config)
    const snapshot = await node.putJson({ schemaVersion: 1, format: 'hf-safetensors', files: [
      { path: 'config.json', size: configBytes.length, sha256: config.digest, contentRef: config },
      { path: 'model.safetensors', size: 1024 * 1024, sha256: weight.digest, contentRef: weight },
    ] })
    const batch = await node.putJson({ native: 'native-token-evidence' })
    const commit = await node.putJson({ schemaVersion: 1, checkpointRef: snapshot, consumedBatchDigest: batch.digest, trainingRunId: 'run-fixture' })
    return { root, node, store, transport, weight, snapshot, batch, commit, secret, config }
  }
  async function publication(s: Awaited<ReturnType<typeof setup>>) {
    const firstSnapshot = await s.node.readJson<{ files: Array<{ path: string; size: number; sha256: string; contentRef: ContentRef }> }>(s.snapshot)
    const nextWeight = await s.node.putBytes(Buffer.alloc(1024 * 1024, 38), 'application/octet-stream')
    const nextSnapshot = await s.node.putJson({ ...firstSnapshot, files: firstSnapshot.files.map(file => file.path === 'model.safetensors'
      ? { ...file, sha256: nextWeight.digest, contentRef: nextWeight } : file) })
    const models = await Promise.all([s.snapshot, nextSnapshot].map(async hfSnapshotRef => sealModelVersion({ schemaVersion: 1,
      hfSnapshotRef, weightsDigest: hfSnapshotRef.digest, tokenizerDigest: s.config.digest, chatTemplateDigest: s.config.digest,
      architecture: 'FixtureForCausalLM', dtype: 'float32', provenanceRef: s.batch })))
    await retainContentGraph(s.transport, s.store, models.map(model => model.hfSnapshotRef))
    const placement = deployment('local', 'local')
    placement.nodes.gpu = s.transport.connection
    const observed = await s.transport.call('probe', {}) as NodeIdentity & { runtimeDigest: string }
    const spec = v2spec(await fixture(s.store), placement)
    spec.initialModel = await s.store.putJson(models[0])
    spec.referenceModel = spec.initialModel
    spec.deployment.modelRuntime = { ...spec.deployment.modelRuntime, nodeId: observed.nodeId,
      generation: observed.generation, runtimeDigest: observed.runtimeDigest }
    for (const device of [...spec.resources.trainingDevices, ...spec.resources.evaluationDevices]) device.nodeId = observed.nodeId
    const config: TrainingControllerConfigV2 = { schemaVersion: 2, storeRoot: s.store.root, artifactStorage: 'model-node', deployment: placement,
      evaluationGateway: { localPort: 31992, nodePort: 31992 }, activationPath: join(s.root, 'active.json'), episodeTimeoutSeconds: 30,
      hitch: { command: ['fixture-hitch'], root: join(s.root, 'hitch'), workspace: join(s.root, 'controller'),
        harnessSourceDirectory: '/unused', python: s.transport.connection.python,
        budgets: { timeoutSeconds: 30, setupTimeoutSeconds: 30, maxConcurrent: 1, maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 } } }
    const experiment = await trainingController(config, spec, s.store).coordinator.createExperiment(spec)
    const file = join(s.root, 'controller.json')
    await atomicWrite(file, config)
    const state = { storage: true, loseImportReply: false, importDrift: false }
    const invoke = trainingProcess.jsonProcess
    let registered: ModelNodeTransport | undefined
    const calls = vi.spyOn(trainingProcess, 'jsonProcess').mockImplementation(async (command, args, ...rest) => {
      if (command[0] !== 'fixture-hitch') return invoke(command, args, ...rest)
      const argv = args.slice(2), op = argv.slice(0, 2).join(' ')
      if (op === 'capabilities --json') return { managed_model_node: '2', model_node_storage: state.storage ? '1' : undefined }
      if (op === 'model-node register') {
        const { binding, connection } = JSON.parse(await readFile(argv[argv.indexOf('--file') + 1]!, 'utf8'))
        const transport = new ModelNodeTransport({ ...connection, workspace: s.root }, { nodeId: binding.node_id, generation: binding.generation })
        const actual = await transport.call('probe', {}) as typeof observed
        expect(actual.runtimeDigest).toBe(binding.runtime_digest)
        registered = transport
        return { binding }
      }
      if (op === 'models add-node' || op === 'models inspect') {
        const ref = op === 'models add-node' ? JSON.parse(await readFile(argv[2]!, 'utf8')) : undefined
        const model = models.find(model => ref ? model.hfSnapshotRef.digest === ref.digest : argv[2] === `local/${digestJson(model.id)}`)!
        expect(registered).toBeDefined()
        const binding = JSON.parse(await readFile(argv[argv.indexOf('--model-node-file') + 1]!, 'utf8'))
        expect(binding.generation).toBe(observed.generation)
        await registered!.call('cas.retain', { roots: [model.hfSnapshotRef], controllerObjects: [] })
        if (state.loseImportReply && op === 'models add-node') {
          state.loseImportReply = false
          throw new Error('model import response lost')
        }
        const snapshot = await s.node.readJson<typeof firstSnapshot>(model.hfSnapshotRef)
        return { model_id: digestJson(model.id), tokenizer_digest: model.tokenizerDigest, template_digest: model.chatTemplateDigest,
          files: snapshot.files.map(({ path, size, sha256 }) => ({ path, size, sha256: state.importDrift ? digestJson('wrong-file') : sha256 })) }
      }
      throw new Error('unexpected Hitch operation: ' + op)
    })
    return { config, spec, models, experiment, state, calls,
      publish: (...args: string[]) => trainingCommand([args.length ? 'rollback' : 'publish', experiment.id, ...args, '--config', file]) as Promise<ModelRelease> }
  }
  it('publishes and rolls back retained node models through the CLI without downloading files, including a lost import reply', async () => {
    const s = await setup(), p = await publication(s)
    p.state.loseImportReply = true
    await expect(p.publish()).rejects.toThrow('model import response lost')
    const pending = (await s.store.load(p.experiment.id)).activationIntent!
    const initial = await p.publish()
    expect(initial.activationId).toBe(pending.id)
    const activation = JSON.parse(await readFile(p.config.activationPath, 'utf8'))
    expect(activation).toMatchObject({ hitchModel: `local/${digestJson(p.models[0]!.id)}`,
      modelNode: { node_id: s.transport.identity!.nodeId, generation: s.transport.identity!.generation,
        runtime_digest: p.spec.deployment.modelRuntime.runtimeDigest, launcher: 'process' } })
    expect(JSON.stringify(activation)).not.toContain(s.transport.connection.configPath)
    const candidateRef = await s.store.putJson(p.models[1])
    await s.store.transaction(p.experiment.id, state => { state.champion.modelRef = candidateRef; state.champion.revision++ })
    const candidate = await p.publish()
    expect(candidate.modelRef).toEqual(candidateRef)
    const rollback = await p.publish(initial.id)
    expect(rollback.modelRef).toEqual(initial.modelRef)
    expect(JSON.parse(await readFile(p.config.activationPath, 'utf8')).modelNode).toEqual(activation.modelNode)
    for (const ref of [s.weight, s.config]) await expect(s.store.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(p.calls.mock.calls.some(([, args]) => args.includes('materialize') || args.includes('add'))).toBe(false)
  }, 30_000)
  it('keeps the published release when remote capability, import identity, files or generation cannot be verified', async () => {
    const s = await setup(), p = await publication(s)
    const initial = await p.publish()
    const before = await readFile(p.config.activationPath, 'utf8')
    p.state.storage = false
    await expect(p.publish(initial.id)).rejects.toMatchObject({ code: 'remote-model-storage-unavailable' })
    p.state.storage = true; p.state.importDrift = true
    await expect(p.publish(initial.id)).rejects.toMatchObject({ code: 'publication-import-drift' })
    p.state.importDrift = false
    await rm(s.node.path(s.weight.digest))
    await expect(p.publish(initial.id)).rejects.toMatchObject({ code: 'missing-node-content' })
    const identityFile = join(s.root, 'node', 'identity.json')
    const identity = JSON.parse(await readFile(identityFile, 'utf8'))
    await atomicWrite(identityFile, { ...identity, generation: 'different-generation' })
    await expect(p.publish(initial.id)).rejects.toMatchObject({ code: 'node-generation-drift' })
    expect(await readFile(p.config.activationPath, 'utf8')).toBe(before)
    expect((await s.store.load(p.experiment.id)).activeReleaseId).toBe(initial.id)
  }, 30_000)
  it('retains opaque snapshot bytes remotely, recovers implicit batches and retries the same durable receipt', async () => {
    const s = await setup()
    await retainContentGraph(s.transport, s.store, [s.commit])
    expect(await s.store.readJson(s.batch)).toEqual({ native: 'native-token-evidence' })
    for (const ref of [s.weight, s.config]) await expect(s.store.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(s.node.readBytes(s.secret)).rejects.toMatchObject({ code: 'ENOENT' })
    await retainContentGraph(s.transport, s.store, [s.commit])
    expect(await readdir(join(s.store.root, 'remote-retentions'))).toHaveLength(1)
    expect(await readdir(join(s.node.root, 'retained-graphs'))).toHaveLength(1)
    // The next training input uses the exact verified node files without a
    // controller copy, even for the JSON file containing a private-looking ref.
    await uploadSnapshotFiles(s.transport, s.store, [s.snapshot])
    await expect(s.store.readBytes(s.weight)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
  it('refuses a corrupted remote weight and never acknowledges collection', async () => {
    const s = await setup(); await writeFile(s.node.path(s.weight.digest), Buffer.alloc(1024 * 1024, 38))
    await expect(retainContentGraph(s.transport, s.store, [s.commit])).rejects.toMatchObject({ code: 'corrupt-content' })
    await expect(readdir(join(s.store.root, 'remote-retentions'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('verifies private task and verifier dependencies on the controller without uploading or downloading opaque files', async () => {
    const s = await setup()
    const task = await s.store.putJson({ schemaVersion: 2, format: 'harbor-dataset', files: [
      { contentRef: s.secret, sha256: s.secret.digest, size: (await s.store.readBytes(s.secret)).length, path: 'one/instruction.json' },
    ] })
    const projection = await s.node.putJson({ schemaVersion: 2, kind: 'controller-verifier-observation', sourceEvidenceRef: s.secret, taskRef: task })
    const root = await s.node.putJson({ updateCommitRef: s.commit, verificationRef: projection })
    await retainContentGraph(s.transport, s.store, [root])
    expect(await s.store.readJson(projection)).toMatchObject({ sourceEvidenceRef: s.secret })
    for (const ref of [s.secret, task]) await expect(s.node.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(s.store.readBytes(s.weight)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(s.store.path(s.secret.digest), Buffer.alloc((await s.store.readBytes(s.secret)).length, 88))
    await expect(retainContentGraph(s.transport, s.store, [root])).rejects.toMatchObject({ code: 'content-digest-mismatch' })
  }, 30_000)
  it('never accepts a local weight as a substitute for a missing remote weight', async () => {
    const s = await setup()
    await s.store.putBytes(await s.node.readBytes(s.weight), s.weight.mediaType)
    await rm(s.node.path(s.weight.digest))
    await expect(retainContentGraph(s.transport, s.store, [s.commit])).rejects.toMatchObject({ code: 'missing-node-content' })
  })
  it('closes private canonical evidence back through its policy lease to a remote HF snapshot', async () => {
    const s = await setup()
    await s.store.putJson(await s.node.readJson(s.snapshot))
    const lease = await s.store.putJson({ synchronizedWeightsRef: s.snapshot, fencingToken: 'private-controller-fence' })
    const evidence = await s.store.putJson({ inspection: { policyLeaseRef: lease }, verifier: s.secret })
    const root = await s.node.putJson({ sourceEvidenceRef: evidence })
    await retainContentGraph(s.transport, s.store, [root])
    for (const ref of [lease, evidence, s.secret]) await expect(s.node.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(s.store.readBytes(s.weight)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(s.node.path(s.weight.digest))
    await expect(retainContentGraph(s.transport, s.store, [root])).rejects.toMatchObject({ code: 'missing-node-content' })
  }, 30_000)
  it('retains an intermediate rollout export before its descriptor has reached the controller', async () => {
    const s = await setup()
    const lease = await s.store.putJson({ synchronizedWeightsRef: s.snapshot })
    const evidence = await s.store.putJson({ inspection: { policyLeaseRef: lease } })
    const root = await s.node.putJson({ sourceEvidenceRef: evidence })
    await expect(s.store.readBytes(s.snapshot)).rejects.toMatchObject({ code: 'ENOENT' })
    await retainContentGraph(s.transport, s.store, [root])
    expect(await s.store.readJson(s.snapshot)).toEqual(await s.node.readJson(s.snapshot))
    await expect(s.store.readBytes(s.weight)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(s.node.path(s.snapshot.digest))
    await expect(retainContentGraph(s.transport, s.store, [root])).rejects.toMatchObject({ code: 'missing-node-content' })
  }, 30_000)
  it('rejects a missing implicit batch and a stale node generation', async () => {
    const s = await setup(); await rm(s.node.path(s.batch.digest))
    await expect(retainContentGraph(s.transport, s.store, [s.commit])).rejects.toMatchObject({ code: 'missing-node-content' })
    const stale = new ModelNodeTransport(s.transport.connection, { ...s.transport.identity!, generation: 'stale' })
    await expect(retainContentGraph(stale, s.store, [s.snapshot])).rejects.toMatchObject({ code: 'node-generation-drift' })
  })
  it('checks file sizes against manifests before reuse and rejects undeclared snapshot references', async () => {
    const s = await setup(), snapshot = await s.node.readJson<any>(s.snapshot)
    const wrong = await s.node.putJson({ ...snapshot, files: snapshot.files.map((file: any) => ({ ...file, size: file.size + 1 })) })
    await expect(retainContentGraph(s.transport, s.store, [wrong])).rejects.toMatchObject({ code: 'content-size-drift' })
    const leak = await s.node.putJson({ ...snapshot, privateRef: s.secret })
    await expect(retainContentGraph(s.transport, s.store, [leak])).rejects.toMatchObject({ code: 'model-input-reference-leak' })
  })
  it('does not accept a tampered metadata reply or an incomplete remote inventory', async () => {
    const s = await setup()
    const valid = await s.transport.call('cas.retain', { roots: [s.commit] }) as any
    const bad = structuredClone(valid); bad.metadata[0].data = Buffer.from('changed').toString('base64')
    vi.spyOn(s.transport, 'call').mockResolvedValue(bad)
    await expect(retainContentGraph(s.transport, s.store, [s.commit])).rejects.toMatchObject({ code: 'invalid-retention-metadata' })
    await expect(s.store.readBytes(s.commit)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects large unclassified metadata before returning or storing its bytes', async () => {
    const s = await setup(), huge = await s.node.putBytes(Buffer.alloc(16 * 1024 * 1024 + 1), 'application/octet-stream')
    await expect(retainContentGraph(s.transport, s.store, [huge])).rejects.toMatchObject({ code: 'content-metadata-limit' })
    await expect(s.store.readBytes(huge)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
