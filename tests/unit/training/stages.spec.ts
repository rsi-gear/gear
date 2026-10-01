import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrainingStageCoordinator } from '../../../src/training/stages.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { ModelTrainingStore, TrainingContentStore } from '../../../src/training/store.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { digestJson } from '../../../src/training/digest.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'
import type { ContentRef, TrainingHandle, TrainingRequestV2 } from '../../../src/training/types.js'

type Json = Record<string, any>
describe('controller stage worker bridge', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gear-stage-worker-')); roots.push(root)
    const store = new ModelTrainingStore(join(root, 'controller')), node = new TrainingContentStore(join(root, 'node'))
    const spec = v2spec(await fixture(store))
    const config = { runner: 'different-provider', options: {}, instructionsRef: await store.putBytes(Buffer.from('Select complete native groups'), 'text/plain'), maxRepairs: 1, timeoutSeconds: 3 }
    spec.stages = { datasetBuilder: config }
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec), request = (await coordinator.admit(experiment.id)).request as TrainingRequestV2
    const handle: TrainingHandle = { schemaVersion: 1, provider: 'slime', jobId: `job_${'a'.repeat(32)}`, requestDigest: digestJson(request) }
    const payload = { trainingRunId: request.trainingRunId, trajectories: [] }
    const weights = await node.putJson({ format: 'hf-safetensors', files: [{ contentRef: { uri: 'cas:' + digestJson('weight-bytes'), digest: digestJson('weight-bytes'), mediaType: 'application/octet-stream' } }] })
    const lease = { schemaVersion: 1, trainingRunId: request.trainingRunId, batchId: 'batch', policyVersion: 'behavior', parentModelVersionId: request.parentModel.id,
      synchronizedWeightsRef: weights, runtimeInstanceId: 'runtime', samplingDigest: digestJson({}), fencingToken: 'fence', expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'serving' }
    const intent = { schemaVersion: 1, stage: 'dataset-builder', config, payloadRef: await node.putJson(payload), trainingRunId: request.trainingRunId, weightsRef: weights }
    const entry: Json = { id: digestJson(intent), intent, lease, result: null }
    const transport = new ModelNodeTransport({ transport: { type: 'local' }, workspace: root, python: ['fixture'], configPath: join(root, 'node.json'), gateway: { localPort: 31001, nodePort: 31001 } }, { nodeId: 'gpu', generation: 'boot' })
    const downloads: ContentRef[] = [], uploads: ContentRef[] = []
    vi.spyOn(transport, 'download').mockImplementation(async (destination, ref) => { downloads.push(ref); await destination.putBytes(await node.readBytes(ref), ref.mediaType) })
    vi.spyOn(transport, 'upload').mockImplementation(async (source, ref) => { uploads.push(ref); await node.putBytes(await source.readBytes(ref), ref.mediaType) })
    const rpc = vi.spyOn(transport, 'call').mockImplementation(async (operation, body) => {
      if (operation === 'training.stages.list') return { entries: [entry] }
      if (operation === 'training.stages.inputs') return { refs: [] }
      if (operation === 'training.stages.result') { entry.result = (body as Json).result; return { accepted: true } }
      throw new Error(`unexpected ${operation}`)
    })
    return { root, store, node, config, request, handle, payload, weights, entry, transport, downloads, uploads, rpc }
  }
  it('launches the real Python CLI with a custom provider, publishes once and replays without inference', async () => {
    const s = await setup()
    await writeFile(join(s.root, 'stage_runner_fixture.py'), `import json
from gear_training.agents import AgentResult
class Runner:
    async def run(self, request):
        (request.workspace / 'outputs/manifest.json').write_text(json.dumps({'selectedEpisodeIds': [], 'analysis': 'real custom-provider CLI'}))
        return AgentResult('completed', recovery_id='custom-native-thread')
def factory(provider, options):
    assert provider == 'different-provider'
    return Runner()
`)
    const python = ['env', `PYTHONPATH=${resolve('python')}:${s.root}`, 'PYTHONDONTWRITEBYTECODE=1', 'GEAR_AGENT_RUNNER_FACTORY=stage_runner_fixture:factory', process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3']
    const stages = new TrainingStageCoordinator(s.store, s.transport, { python, workspace: s.root })
    expect((await stages.reconcile(s.handle, s.request, false)).pending).toBe(true)
    const limit = Date.now() + 10_000
    while (!s.entry.result && Date.now() < limit) {
      await new Promise(resolve => setTimeout(resolve, 50)); await stages.reconcile(s.handle, s.request, false)
    }
    expect(s.entry.result?.outcome).toBe('completed')
    expect(s.entry.result.result.runner.recoveryId).toBe('custom-native-thread')
    expect(s.rpc.mock.calls.filter(([op]) => op === 'training.stages.result')).toHaveLength(1)
    const uploaded = s.uploads.length
    expect((await stages.reconcile(s.handle, s.request, false)).pending).toBe(false)
    expect(s.uploads).toHaveLength(uploaded)
    expect(s.downloads.some(ref => ref.digest === s.weights.digest)).toBe(false)
    const output = await s.node.readJson<Json>(s.entry.result.result.outputRef)
    expect(output.selectedEpisodeIds).toEqual([])
    const snapshot = await s.node.readJson<Json>(s.entry.result.result.snapshotRef)
    for (const file of snapshot.files) expect(await s.node.readBytes(file.contentRef)).toBeTruthy()
  }, 15_000)
  it('starts a fresh execution after an infrastructure failure under a new lease and fences pre-registration cancellation', async () => {
    const s = await setup(), launch = vi.fn(), invoke = vi.fn(async (_command: readonly string[], _args: readonly string[]) => ({ stopped: true }))
    const stages = new TrainingStageCoordinator(s.store, s.transport, { python: ['fixture-python'], workspace: s.root }, invoke, launch)
    expect((await stages.reconcile(s.handle, s.request, false)).pending).toBe(true)
    const firstArgs = launch.mock.calls[0]![1] as string[], firstResponse = firstArgs[firstArgs.indexOf('--response-file') + 1]!
    await writeFile(firstResponse, JSON.stringify({ outcome: 'infra-error', message: 'transport failure' }))
    await stages.reconcile(s.handle, s.request, false)
    expect(s.entry.result.outcome).toBe('infra-error')
    s.entry.lease = { ...s.entry.lease, batchId: 'new-batch', runtimeInstanceId: 'new-runtime' }; s.entry.result = null
    expect((await stages.reconcile(s.handle, s.request, false)).pending).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)
    const nextArgs = launch.mock.calls[1]![1] as string[]
    expect(nextArgs[nextArgs.indexOf('--execution-root') + 1]).not.toBe(firstArgs[firstArgs.indexOf('--execution-root') + 1])
    await stages.reconcile(s.handle, s.request, true)
    expect(invoke.mock.calls[0]![1]).toContain('--stop'); expect(launch).toHaveBeenCalledTimes(2)
  })
})
