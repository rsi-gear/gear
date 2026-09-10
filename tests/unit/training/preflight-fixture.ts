import { join } from 'node:path'
import type { TrainingControllerConfigV2 } from '../../../src/training/cli.js'
import { digestJson } from '../../../src/training/digest.js'
import type { ModelNodePreflight } from '../../../src/training/node-preflight.js'
import { deployment } from './placement-fixture.js'

export function preflightFixture(root: string) {
  const config: TrainingControllerConfigV2 = { schemaVersion: 2, storeRoot: join(root, 'cas'), activationPath: join(root, 'active.json'),
    deployment: deployment(), episodeTimeoutSeconds: 30, evaluationGateway: { localPort: 32000, nodePort: 32001 },
    hitch: { command: ['hitch'], root: join(root, 'hitch'), workspace: root, harnessSourceDirectory: '/controller/hitch', python: ['controller-python'],
      budgets: { timeoutSeconds: 30, setupTimeoutSeconds: 30, maxConcurrent: 1, maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 } } }
  const runtime = { fixture: 'observed-python-environment' }, node = { nodeId: 'gpu-node', generation: 'boot-1' }
  const probe = { ...node, runtime, runtimeDigest: digestJson(runtime), gpuUuids: ['GPU-123'], launchers: ['process'] }
  const report: ModelNodePreflight = { schemaVersion: 2, kind: 'model-node-preflight', node, runtimeDigest: probe.runtimeDigest,
    checks: ['training-node-configuration', 'package-torch', 'package-sglang', 'package-psutil', 'package-ray', 'slime-checkout', 'megatron-checkout',
      'slime-tracked-runtime', 'slime-export-extension', 'megatron-tracked-runtime', 'host-memory-observation', 'gpu-inventory', 'gpu-process-observation',
      'cuda-runtime', 'model-gateway-configuration'].map(code => ({ code, status: 'passed' })),
    sources: { slime: { commit: 'a'.repeat(40), patchDigest: null, untrackedRuntimeCode: false, exportExtension: true },
      megatron: { commit: 'b'.repeat(40), patchDigest: null, untrackedRuntimeCode: false } },
    gpus: [{ uuid: 'GPU-123', name: 'Fixture GPU', memoryMiB: 81920, driverVersion: '570.1', activeProcesses: 0 }],
    hostMemory: { totalBytes: 256_000_000_000, availableBytes: 128_000_000_000 }, cudaVersion: '12.8', ports: { rollout: 31002, inference: 32001 } }
  const controller = { schema_version: '2', package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: digestJson('controller-payload'),
    source: { kind: 'git-checkout', commit: 'b'.repeat(40), dirty: true } }
  const caps: Record<string, unknown> = { training_external_binding: '1', exact_policy_tokens: '1', training_policy_fencing: '1', managed_model_node: '2',
    controller_runtime_observation: '2', local_execution_observation: '2', training_harnesses: ['training-tool'] }
  const environment = { schema_version: '2', host_platform: 'linux-x64',
    harbor: { status: 'available', version: '0.21.0', executable_digest: digestJson('harbor') },
    docker: { status: 'available', version: '28.1.0', executable_digest: digestJson('docker'), engine_id: 'observed-engine', os: 'linux', architecture: 'x86_64' },
    buildx: { status: 'unavailable', version: null }, sandbox: { status: 'unverified' } }
  const worker = { provider: 'local-docker', worker_id: 'local', collision_domain_id: 'docker-engine', health: 'healthy', platforms: ['linux-x64'],
    backends: [{ id: 'harbor', version: 'fixture' }], features: { docker: true, model_proxy: true } }
  const invoke = async (command: readonly string[], args: readonly string[]): Promise<unknown> => {
    if (command[0] === 'controller-python') return { pythonVersion: '3.12.1', bridgeDigest: digestJson('bridge') }
    if (args.includes('capabilities')) return caps
    if (args.includes('runtime')) return controller
    if (args.includes('observe')) return { schema_version: '2', provider: worker.provider, worker_id: worker.worker_id,
      collision_domain_id: worker.collision_domain_id, nonce: args[args.indexOf('--nonce') + 1], generation: null, daemon_instance_id: 'a'.repeat(32),
      daemon_runtime: { schema_version: '2', startup: controller, current: controller, unchanged: true }, environment, environment_digest: digestJson(environment) }
    if (args.includes('list')) return { workers: [worker] }
    throw new Error('unexpected preflight command')
  }
  return { config, probe, report, controller, caps, environment, invoke }
}
