import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trainingCommand, trainingController, parseTrainingControllerConfig, type TrainingControllerConfigV2 } from '../../../src/training/cli.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { NodeSlimeModelTrainer, SlimeModelTrainer } from '../../../src/training/slime.js'
import { HitchModelEvaluator } from '../../../src/training/hitch.js'
import { assertHitchCommit, observeExecutionPlacement, observeHitchController } from '../../../src/training/placement-observation.js'
import { freezeExecutionPlacement } from '../../../src/training/deployment.js'
import { digestJson } from '../../../src/training/digest.js'
import type { ModelExperimentState, ModelTrainingRun, ModelTrainingSpecV1 } from '../../../src/training/types.js'
import { fixture } from './fixture.js'
import { deployment, v2spec } from './placement-fixture.js'

describe('versioned public training controller', () => {
  let root: string, store: ModelTrainingStore, legacy: ModelTrainingSpecV1, config: TrainingControllerConfigV2
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-controller-v2-')); store = new ModelTrainingStore(root); legacy = await fixture(store)
    config = { schemaVersion: 2, storeRoot: root, activationPath: join(root, 'active.json'), deployment: deployment(), episodeTimeoutSeconds: 30,
      evaluationGateway: { localPort: 32000, nodePort: 32001 }, hitch: { command: ['hitch'], root: join(root, 'hitch'), workspace: join(root, 'controller'),
        harnessSourceDirectory: '/controller/hitch', python: ['controller-python'], budgets: { timeoutSeconds: 30, setupTimeoutSeconds: 30,
          maxConcurrent: 1, maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 } } }
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  it('public init/admit/status preserve v2 and instantiate node episode/evaluation adapters', async () => {
    const spec = v2spec(legacy), controller = trainingController(parseTrainingControllerConfig(config), spec, store)
    expect(controller.trainer).toBeInstanceOf(NodeSlimeModelTrainer)
    expect(controller.coordinator.evaluator).toBeInstanceOf(HitchModelEvaluator)
    const evaluator = controller.coordinator.evaluator as HitchModelEvaluator
    expect(evaluator.options.modelNode?.gateway).toEqual(config.evaluationGateway)
    expect(evaluator.options.modelNode?.python).toEqual(config.deployment.nodes.gpu!.python)
    expect(evaluator.options.python).toEqual(['controller-python'])
    expect(controller.publisher.options.artifactStorage).toBe('model-node')
    expect(controller.publisher.options.frozenNode).toEqual(spec.deployment.modelRuntime)
    expect(controller.publisher.options.modelNode).toEqual(evaluator.options.modelNode)
    const file = join(root, 'controller.json'), specFile = join(root, 'spec.json')
    await writeFile(file, JSON.stringify(config)); await writeFile(specFile, JSON.stringify(spec))
    const created = await trainingCommand(['init', specFile, '--config', file]) as ModelExperimentState
    const admitted = await trainingCommand(['admit', created.id, '--config', file]) as ModelTrainingRun
    expect(admitted.request.schemaVersion).toBe(2)
    expect(await trainingCommand(['status', created.id, admitted.id, '--config', file])).toEqual(admitted)
    expect((await store.load(created.id)).specDigest).toBe(digestJson(spec))
  })
  it('rejects route collisions, mixed versions and placement changes before launching work', () => {
    expect(() => parseTrainingControllerConfig({ ...config, evaluationGateway: config.deployment.nodes.gpu!.gateway })).toThrow('distinct stable')
    expect(() => trainingController(config, legacy)).toThrow('matching controller version')
    const spec = v2spec(legacy, deployment('remote'))
    expect(() => trainingController(config, spec)).toThrow('frozen experiment')
    expect(() => parseTrainingControllerConfig({ ...config, hitch: { ...config.hitch, modelNode: {} } })).toThrow('separate Hitch node override')
  })
  it('preserves the v1 controller adapter and its original spec digest', () => {
    const original = digestJson(legacy)
    const v1 = { schemaVersion: 1 as const, storeRoot: root, activationPath: config.activationPath, hitch: config.hitch,
      slime: { python: ['local-python'], configPath: '/local/slime.json' } }
    expect(trainingController(parseTrainingControllerConfig(v1), legacy).trainer).toBeInstanceOf(SlimeModelTrainer)
    expect(digestJson(legacy)).toBe(original)
  })
  it('freezes actual provider environment, excludes changing load and daemon instances, and rejects unobserved remote workers', async () => {
    const runtime = { fixture: 'observed-python-environment' }
    vi.spyOn(ModelNodeTransport.prototype, 'call').mockResolvedValue({ nodeId: 'gpu-node', generation: 'boot-1', runtimeDigest: digestJson(runtime), runtime,
      gpuUuids: ['GPU-123'], launchers: ['process'] })
    const worker = { provider: 'local-docker', worker_id: 'local', collision_domain_id: 'docker-engine', health: 'healthy', platforms: ['linux-x64'],
      backends: [{ id: 'harbor', version: 'fixture' }], features: { docker: true, model_proxy: true }, heartbeat_at: 'before', capacity: { allocated: 0 } }
    const capabilities = { training_external_binding: '1', exact_policy_tokens: '1', training_policy_fencing: '1', managed_model_node: '2', controller_runtime_observation: '2', local_execution_observation: '2' }
    const hitchRuntime = { schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: digestJson('actual-runtime'),
      source: { kind: 'git-checkout', commit: legacy.trainer.runtimeLock.hitchCommit, dirty: true } }
    const environment = { schema_version: '2', host_platform: 'linux-x64',
      harbor: { status: 'available', version: '0.21.0', executable_digest: digestJson('harbor') },
      docker: { status: 'available', version: '28.1.0', executable_digest: digestJson('docker'), engine_id: 'observed-engine', os: 'linux', architecture: 'x86_64' },
      buildx: { status: 'unavailable', version: null }, sandbox: { status: 'unverified' } }
    let instance = 'a'.repeat(32)
    const invoke = vi.fn(async (_command, args): Promise<unknown> => args.includes('capabilities') ? capabilities : args.includes('runtime') ? hitchRuntime
      : args.includes('observe') ? { schema_version: '2', provider: worker.provider, worker_id: worker.worker_id, collision_domain_id: worker.collision_domain_id,
        nonce: args[args.indexOf('--nonce') + 1], generation: null, daemon_instance_id: instance,
        daemon_runtime: { schema_version: '2', startup: hitchRuntime, current: hitchRuntime, unchanged: true }, environment, environment_digest: digestJson(environment) }
        : { workers: [worker] })
    const first = await observeExecutionPlacement(config.deployment, config.hitch, invoke)
    worker.heartbeat_at = 'after'; worker.capacity.allocated = 1; instance = 'b'.repeat(32)
    const second = await observeExecutionPlacement(config.deployment, config.hitch, invoke)
    expect(freezeExecutionPlacement(config.deployment, first)).toEqual(freezeExecutionPlacement(config.deployment, second))
    environment.docker.engine_id = 'actual-engine-changed'
    expect((await observeExecutionPlacement(config.deployment, config.hitch, invoke)).provider.identityDigest).not.toBe(first.provider.identityDigest)
    environment.docker.engine_id = 'observed-engine'
    hitchRuntime.runtime_id = digestJson('changed-controller-build')
    expect((await observeExecutionPlacement(config.deployment, config.hitch, invoke)).provider.identityDigest).not.toBe(first.provider.identityDigest)
    worker.collision_domain_id = 'different-engine'
    expect((await observeExecutionPlacement(config.deployment, config.hitch, invoke)).provider.identityDigest).not.toBe(first.provider.identityDigest)
    const remote = { ...worker, provider: 'harbor-remote', generation: 3, status: 'ready' }
    invoke.mockImplementation(async (_command, args) => args.includes('capabilities') ? capabilities : args.includes('runtime') ? hitchRuntime : { workers: [remote] })
    await expect(observeExecutionPlacement(deployment('remote'), config.hitch, invoke)).rejects.toMatchObject({ code: 'provider-observation-capability-missing' })
    const observedRemote = { ...remote, features: { ...remote.features, execution_observation: '2', training_external_binding: '2', managed_model_node: '2' } }
    const remoteCaps: Record<string, string> = { ...capabilities, remote_execution_observation: '2' }
    const workerRuntime = { ...hitchRuntime, node_version: 'v24.0.0' }
    invoke.mockImplementation(async (_command, args) => args.includes('capabilities') ? remoteCaps : args.includes('runtime') ? hitchRuntime
      : args.includes('observe') ? { schema_version: '2', provider: observedRemote.provider, worker_id: observedRemote.worker_id, collision_domain_id: observedRemote.collision_domain_id,
        generation: observedRemote.generation, nonce: args[args.indexOf('--nonce') + 1], daemon_instance_id: instance,
        daemon_runtime: { schema_version: '2', startup: hitchRuntime, current: hitchRuntime, unchanged: true },
        worker_runtime: { schema_version: '2', startup: workerRuntime, current: workerRuntime, unchanged: true }, environment, environment_digest: digestJson(environment) }
        : { workers: [observedRemote] })
    // Runtime/environment observation alone must not open the still-unadvertised full remote training contract.
    await expect(observeExecutionPlacement(deployment('remote'), config.hitch, invoke)).rejects.toThrow('exactTrainingBinding')
    remoteCaps.remote_training_external_binding = '2'; remoteCaps.remote_managed_model_node = '2'
    const remoteFirst = await observeExecutionPlacement(deployment('remote'), config.hitch, invoke)
    workerRuntime.node_version = 'v24.1.0'
    expect((await observeExecutionPlacement(deployment('remote'), config.hitch, invoke)).provider.identityDigest).not.toBe(remoteFirst.provider.identityDigest)
    workerRuntime.runtime_id = digestJson('different-worker-payload')
    await expect(observeExecutionPlacement(deployment('remote'), config.hitch, invoke)).rejects.toMatchObject({ code: 'worker-runtime-drift' })
  })
  it('requires actual Hitch source evidence and rejects a different locked commit', async () => {
    const runtime = { schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: digestJson('runtime'),
      source: { kind: 'git-checkout', commit: legacy.trainer.runtimeLock.hitchCommit, dirty: true } }
    const invoke = vi.fn(async () => runtime)
    const observed = await observeHitchController(config.hitch, invoke)
    assertHitchCommit(observed, legacy.trainer.runtimeLock.hitchCommit)
    expect(() => assertHitchCommit(observed, 'f'.repeat(40))).toThrow('frozen training runtime lock')
    runtime.source.kind = 'unavailable'
    await expect(observeHitchController(config.hitch, invoke)).rejects.toMatchObject({ code: 'controller-source-unavailable' })
  })
})
