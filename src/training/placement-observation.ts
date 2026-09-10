import { assertDeploymentMatches, freezeExecutionPlacement, parseTrainingDeployment, type DeploymentObservation } from './deployment.js'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { ModelNodeTransport } from './transport.js'
import type { FrozenExecutionPlacement, TrainingDeploymentConfig } from './types.js'
import { randomBytes } from 'node:crypto'
import { providerEnvironment, remoteWorkerRuntime } from './provider-environment.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => {
  requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-placement-observation', 'expected a structured provider/node observation')
  return value as Json
}
export interface PlacementController { command: string[]; root: string }
export interface HitchControllerObservation {
  schema_version: '2'; package_version: string; node_version: string; runtime_id: string
  source: { kind: 'git-checkout'; commit: string; dirty: boolean }
}

export async function observeHitchController(hitch: PlacementController, invoke = jsonProcess): Promise<HitchControllerObservation> {
  const value = object(await invoke(hitch.command, ['--root', hitch.root, 'training', 'runtime', '--json']))
  const source = object(value.source)
  requireContract(value.schema_version === '2' && typeof value.package_version === 'string' && !!value.package_version
    && typeof value.node_version === 'string' && /^v[0-9]+\.[0-9]+\.[0-9]+/.test(value.node_version)
    && typeof value.runtime_id === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.runtime_id),
  'controller-runtime-unavailable', 'Hitch must report its actual versioned controller payload identity')
  requireContract(source.kind === 'git-checkout' && typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit) && typeof source.dirty === 'boolean',
    'controller-source-unavailable', 'v2 training requires an observable Hitch source checkout; a parent repository or declared package version is not source evidence')
  return { schema_version: '2', package_version: value.package_version as string, node_version: value.node_version as string, runtime_id: value.runtime_id as string,
    source: { kind: 'git-checkout', commit: source.commit as string, dirty: source.dirty as boolean } }
}

export function assertHitchCommit(controller: HitchControllerObservation, expected: string): void {
  requireContract(controller.source.commit === expected, 'hitch-commit-drift', 'controller Hitch checkout does not match the frozen training runtime lock')
}

/** Combine registration with fresh resident/environment evidence; this does not certify GPU/sandbox execution. */
export async function observeExecutionProvider(input: TrainingDeploymentConfig, hitch: PlacementController, invoke = jsonProcess) {
  const config = parseTrainingDeployment(input)
  const call = (args: string[]) => invoke(hitch.command, ['--root', hitch.root, ...args])
  const caps = object(await call(['capabilities', '--json']))
  requireContract(caps.controller_runtime_observation === '2', 'controller-runtime-capability-missing', 'Hitch must support controller runtime observation v2')
  const controller = await observeHitchController(hitch, invoke)
  const listing = object(await call(['worker', 'list', '--json']))
  requireContract(Array.isArray(listing.workers), 'missing-provider-observation', 'Hitch did not return registered worker observations')
  const matches = listing.workers.map(object).filter(worker => worker.provider === config.taskExecution.provider)
  requireContract(matches.length === 1, 'ambiguous-execution-provider', 'select a provider with exactly one registered worker for this experiment')
  const worker = matches[0]!, features = object(worker.features)
  requireContract(worker.health === 'healthy' && !worker.revoked_at && (worker.status === undefined || worker.status === 'ready'),
    'execution-provider-unavailable', 'selected execution worker is not healthy and online')
  const remote = config.taskExecution.placement === 'remote'
  if (remote) requireContract(Number.isSafeInteger(worker.generation) && Number(worker.generation) >= 1, 'missing-worker-generation', 'remote execution requires a pinned worker generation')
  for (const field of ['worker_id', 'collision_domain_id']) requireContract(typeof worker[field] === 'string' && !!worker[field], 'missing-provider-identity', `provider is missing ${field}`)
  requireContract(Array.isArray(worker.backends) && worker.backends.some(value => object(value).id === 'harbor') && Array.isArray(worker.platforms),
    'missing-harbor-provider', 'selected provider does not advertise Harbor/platform support')
  const capabilities = { harborDocker: features.docker === true,
    exactTrainingBinding: caps.training_external_binding === '1' && caps.exact_policy_tokens === '1' && caps.training_policy_fencing === '1'
      && (!remote || caps.remote_training_external_binding === '2' && features.training_external_binding === '2'),
    managedModelRoute: caps.managed_model_node === '2' && features.model_proxy === true
      && (!remote || caps.remote_managed_model_node === '2' && features.managed_model_node === '2') }
  requireContract((remote ? caps.remote_execution_observation === '2' && features.execution_observation === '2' : caps.local_execution_observation === '2'),
    'provider-observation-capability-missing', 'Hitch and the selected worker must support fresh execution environment observation v2')
  const nonce = randomBytes(16).toString('hex')
  const evidence = object(await call(['worker', 'observe', config.taskExecution.provider, '--nonce', nonce, '--json']))
  const environment = providerEnvironment(evidence,
    { nonce, provider: worker.provider, workerId: worker.worker_id, collisionDomainId: worker.collision_domain_id, controller, generation: remote ? Number(worker.generation) : null })
  const identity = { provider: worker.provider, workerId: worker.worker_id, collisionDomainId: worker.collision_domain_id,
    generation: worker.generation ?? null, backends: worker.backends, platforms: worker.platforms, controller, environment,
    ...(remote ? { workerRuntime: remoteWorkerRuntime(evidence.worker_runtime, controller) } : {}) }
  return { controller, environment, workerId: String(worker.worker_id),
    provider: { name: config.taskExecution.provider, placement: config.taskExecution.placement, identityDigest: digestJson(identity),
      capabilitiesDigest: digestJson({ features, capabilities }), capabilities } }
}

export async function observeExecutionPlacement(input: TrainingDeploymentConfig, hitch: PlacementController,
  invoke = jsonProcess): Promise<DeploymentObservation & { controller: HitchControllerObservation }> {
  const config = parseTrainingDeployment(input)
  const { controller, provider } = await observeExecutionProvider(config, hitch, invoke)
  const connection = config.nodes[config.modelRuntime.nodeRef]!
  const node = object(await new ModelNodeTransport(connection, null).call('probe', {}))
  requireContract(node.runtimeDigest === digestJson(node.runtime) && Array.isArray(node.gpuUuids)
    && node.gpuUuids.every(uuid => typeof uuid === 'string') && Array.isArray(node.launchers), 'model-node-runtime-drift', 'node probe lacks its actual environment digest/GPU inventory')
  const observation: DeploymentObservation & { controller: HitchControllerObservation } = { controller, node: node as unknown as DeploymentObservation['node'], provider }
  // Reuse strict versioned identity/capability checks before returning evidence.
  freezeExecutionPlacement(config, observation)
  return observation
}

export async function verifyExecutionPlacement(frozen: FrozenExecutionPlacement, config: TrainingDeploymentConfig, hitch: PlacementController, expectedHitchCommit?: string, invoke = jsonProcess): Promise<void> {
  const observation = await observeExecutionPlacement(config, hitch, invoke)
  if (expectedHitchCommit) assertHitchCommit(observation.controller, expectedHitchCommit)
  assertDeploymentMatches(frozen, config, observation)
}
