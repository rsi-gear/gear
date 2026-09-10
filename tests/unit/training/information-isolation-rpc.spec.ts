import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ModelTrainingStore, atomicWrite } from '../../../src/training/store.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { NodeSlimeModelTrainer } from '../../../src/training/slime.js'
import { sealModelVersion } from '../../../src/training/schema.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'
import type { ModelNodeConnection, NodeIdentity, TrainingRequestV2 } from '../../../src/training/types.js'

it('uploads only authorized bytes through real Python node RPC and keeps private CAS objects on the controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-isolation-rpc-'))
  try {
    const configPath = join(root, 'node.json'), nodeRoot = join(root, 'node'), storeRoot = join(root, 'node-cas')
    await atomicWrite(configPath, { schemaVersion: 2, nodeId: 'gpu-node', nodeRoot, storeRoot, jobConfigPath: join(root, 'job.json') })
    await atomicWrite(join(root, 'job.json'), { schemaVersion: 2, storeRoot, jobsRoot: join(root, 'jobs'), slimePath: '/unused', megatronPath: '/unused',
      gatewayBindHost: '127.0.0.1', gatewayPort: 31000, controllerTimeoutSeconds: 30, episodeTimeoutSeconds: 60 })
    const connection: ModelNodeConnection = { transport: { type: 'local' }, workspace: root, configPath,
      python: ['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'], gateway: { localPort: 31000, nodePort: 31000 } }
    const observed = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
    const identity = { nodeId: observed.nodeId, generation: observed.generation }
    const store = new ModelTrainingStore(join(root, 'controller')), spec = v2spec(await fixture(store))
    const markers = ['DEV-PRIVATE-ISOLATION-SENTINEL', 'HELD-OUT-PRIVATE-ISOLATION-SENTINEL', 'VERIFIER-PRIVATE-ISOLATION-SENTINEL', 'ADMIN-PRIVATE-ISOLATION-SENTINEL']
    const privateRefs = await Promise.all(markers.map(marker => store.putJson({ marker })))
    const config = await store.putJson({ model_type: 'fixture', metadata: { references: privateRefs } })
    const bytes = await store.readBytes(config)
    const hf = await store.putJson({ schemaVersion: 1, format: 'hf-safetensors', files: [{ path: 'config.json', size: bytes.length, sha256: config.digest, contentRef: config }] })
    const { id: _, ...model } = await store.readJson<any>(spec.initialModel)
    spec.initialModel = await store.putJson(sealModelVersion({ ...model, hfSnapshotRef: hf, provenanceRef: privateRefs[0]! }))
    spec.referenceModel = spec.initialModel
    spec.deployment.modelRuntime = { ...spec.deployment.modelRuntime, ...identity }
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    const request = run.request as TrainingRequestV2
    const transport = new ModelNodeTransport(connection, identity)
    const trainer = new NodeSlimeModelTrainer(transport, store, {
      preflight: async () => {}, remember: async () => {}, reconcile: async () => ({ pending: false }),
      withControl: async (_handle, action) => action(async () => ({ pending: false })),
    })
    // This CPU node must remain uncertified. Its upload path still executes real
    // binary RPC in separate Python processes and writes an independent CAS.
    expect((await trainer.preflight(request)).blockers.length).toBeGreaterThan(0)
    const node = new ModelTrainingStore(storeRoot)
    expect(await node.readBytes(config)).toEqual(bytes)
    for (const ref of [...privateRefs, request.trainDataset.tasks[0]!.taskRef]) {
      await expect(node.readBytes(ref)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await store.readBytes(ref)).length).toBeGreaterThan(0)
    }
    const folders = await readdir(join(storeRoot, 'objects'))
    for (const folder of folders) for (const file of await readdir(join(storeRoot, 'objects', folder))) {
      const uploaded = await readFile(join(storeRoot, 'objects', folder, file), 'utf8')
      for (const marker of markers) expect(uploaded).not.toContain(marker)
    }
    await expect(readFile(join(nodeRoot, 'device-leases.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, 'jobs'))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
