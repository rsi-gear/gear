import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ModelTrainingStore, atomicWrite } from '../../../src/training/store.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { NodeSlimeModelTrainer } from '../../../src/training/slime.js'
import { TrainingEpisodeCoordinator } from '../../../src/training/episodes.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { sealModelVersion } from '../../../src/training/schema.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'
import type { ModelNodeConnection, NodeIdentity, TrainingRequestV2 } from '../../../src/training/types.js'

it('cancels before first submission through real node subprocess RPC without materializing models or starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-ordered-rpc-'))
  try {
    const configPath = join(root, 'node.json'), jobsRoot = join(root, 'jobs'), nodeRoot = join(root, 'node'), nodeCas = join(root, 'node-cas')
    await atomicWrite(configPath, { schemaVersion: 2, nodeId: 'gpu-node', nodeRoot, storeRoot: nodeCas, jobConfigPath: join(root, 'job.json') })
    await atomicWrite(join(root, 'job.json'), { schemaVersion: 2, storeRoot: nodeCas, jobsRoot, slimePath: '/unused', megatronPath: '/unused',
      gatewayBindHost: '127.0.0.1', gatewayPort: 31000, controllerTimeoutSeconds: 30, episodeTimeoutSeconds: 60 })
    const connection: ModelNodeConnection = { transport: { type: 'local' }, workspace: root, configPath,
      python: ['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'], gateway: { localPort: 31000, nodePort: 31000 } }
    const observed = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
    const identity = { nodeId: observed.nodeId, generation: observed.generation }
    const store = new ModelTrainingStore(join(root, 'controller')), spec = v2spec(await fixture(store))
    const bytes = Buffer.from('fixture weights'), file = await store.putBytes(bytes, 'application/octet-stream')
    const hf = await store.putJson({ schemaVersion: 1, format: 'hf-safetensors', files: [{ path: 'model.safetensors', size: bytes.length, sha256: file.digest, contentRef: file }] })
    const { id: _, ...model } = await store.readJson<any>(spec.initialModel)
    spec.initialModel = await store.putJson(sealModelVersion({ ...model, hfSnapshotRef: hf })); spec.referenceModel = spec.initialModel
    spec.deployment.modelRuntime = { ...spec.deployment.modelRuntime, ...identity }
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    const request = run.request as TrainingRequestV2
    const create = () => {
      const transport = new ModelNodeTransport(connection, identity)
      const episodes = new TrainingEpisodeCoordinator(store, transport, { command: ['hitch-must-not-run'], root: join(root, 'hitch'), workspace: join(root, 'episodes'),
        harnessSourceDirectory: root, python: ['materializer-must-not-run'], episodeTimeoutSeconds: 60 })
      return new NodeSlimeModelTrainer(transport, store, episodes)
    }
    const stopped = await create().control(request, run.idempotencyKey, { schemaVersion: 2, sequence: 1, action: 'pause' })
    expect(stopped.execution).toBe('paused'); expect(stopped.resourcesReleased).toBe(true); expect(stopped.usage.gpuSeconds).toBe(0)
    expect(await create().control(request, run.idempotencyKey, { schemaVersion: 2, sequence: 1, action: 'pause' })).toEqual(stopped)
    expect(await readdir(join(jobsRoot, stopped.handle.jobId))).not.toContain('worker.json')
    await expect(readFile(join(nodeRoot, 'device-leases.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(nodeRoot, 'inference'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(create().submit(request, run.idempotencyKey)).rejects.toMatchObject({ code: 'training-control-stale' })
    expect(await readdir(join(jobsRoot, stopped.handle.jobId))).not.toContain('worker.json')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
