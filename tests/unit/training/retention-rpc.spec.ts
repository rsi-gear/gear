import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retainContentGraph } from '../../../src/training/retention.js'
import { ModelNodeTransport, uploadSnapshotFiles } from '../../../src/training/transport.js'
import { atomicWrite, ModelTrainingStore } from '../../../src/training/store.js'
import type { ContentRef, ModelNodeConnection, NodeIdentity } from '../../../src/training/types.js'

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
