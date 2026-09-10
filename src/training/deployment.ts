import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type * as T from './types.js'

const object = (v: unknown, keys: string[], label: string): Record<string, unknown> => {
  requireContract(!!v && typeof v === 'object' && !Array.isArray(v), 'invalid-deployment', `${label} must be an object`)
  const r = v as Record<string, unknown>
  requireContract(Object.keys(r).length === keys.length && keys.every(k => k in r), 'invalid-deployment', `${label} has unknown or missing fields`)
  return r
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\u0000-\u001f]/.test(v)
const id = (v: unknown): v is string => text(v) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v)
const digest = (v: unknown): boolean => text(v) && /^sha256:[a-f0-9]{64}$/.test(v)
const port = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) < 65536

function taskExecution(v: unknown, frozen: boolean): void {
  const t = object(v, ['placement', 'provider', ...(frozen ? ['providerIdentityDigest', 'capabilitiesDigest'] : [])], 'taskExecution')
  requireContract(['local', 'remote'].includes(String(t.placement)) && id(t.provider), 'invalid-task-execution', 'task execution requires a named local or remote provider')
  requireContract(t.placement !== 'local' || t.provider === 'local-docker', 'invalid-task-execution', 'local Harbor uses local-docker')
  requireContract(t.placement !== 'remote' || t.provider !== 'local-docker', 'invalid-task-execution', 'remote Harbor requires a registered remote provider')
  if (frozen) requireContract(digest(t.providerIdentityDigest) && digest(t.capabilitiesDigest), 'invalid-provider-identity', 'provider identity and capabilities must be frozen')
}
function scheduling(v: unknown): void {
  const g = object(v, ['actorRollout', 'trainEvaluation'], 'gpuScheduling')
  requireContract(['colocated', 'disaggregated'].includes(String(g.actorRollout)) && ['sequential', 'isolated'].includes(String(g.trainEvaluation)),
    'invalid-gpu-scheduling', 'actor/rollout and training/evaluation scheduling must be selected independently')
}

export function parseTrainingDeployment(value: unknown): T.TrainingDeploymentConfig {
  const d = object(value, ['schemaVersion', 'taskExecution', 'modelRuntime', 'gpuScheduling', 'nodes'], 'deployment')
  requireContract(d.schemaVersion === 2, 'invalid-deployment-version', 'deployment schemaVersion must be 2')
  taskExecution(d.taskExecution, false); scheduling(d.gpuScheduling)
  const m = object(d.modelRuntime, ['nodeRef', 'launcher'], 'modelRuntime')
  requireContract(id(m.nodeRef) && ['docker', 'process'].includes(String(m.launcher)), 'invalid-model-node', 'model runtime requires a nodeRef and launcher')
  requireContract(!!d.nodes && typeof d.nodes === 'object' && !Array.isArray(d.nodes), 'invalid-model-node', 'nodes must be a connection map')
  const nodes = d.nodes as Record<string, unknown>
  requireContract(Object.keys(nodes).length > 0 && m.nodeRef in nodes, 'unknown-model-node', 'modelRuntime.nodeRef does not exist')
  const usedPorts = new Set<number>()
  for (const [name, input] of Object.entries(nodes)) {
    requireContract(id(name), 'invalid-model-node', 'invalid node reference')
    const n = object(input, ['transport', 'workspace', 'python', 'configPath', 'gateway'], `nodes.${name}`)
    const transport = n.transport as Record<string, unknown> | null
    object(transport, transport?.type === 'ssh' ? ['type', 'host'] : ['type'], 'node transport')
    requireContract(transport?.type === 'local' || (transport?.type === 'ssh' && id(transport.host)), 'invalid-node-transport', 'use local or an SSH Host alias; SSH credentials stay in user configuration')
    requireContract(text(n.workspace) && n.workspace.startsWith('/') && text(n.configPath) && n.configPath.startsWith('/')
      && Array.isArray(n.python) && n.python.length > 0 && n.python.every(text), 'invalid-node-path', 'node workspace/config paths must be absolute and Python argv explicit')
    const gateway = object(n.gateway, ['localPort', 'nodePort'], 'node gateway')
    requireContract(port(gateway.localPort) && port(gateway.nodePort) && !usedPorts.has(Number(gateway.localPort)), 'invalid-gateway-port', 'gateway ports must be valid and local tunnel ports unique')
    usedPorts.add(Number(gateway.localPort))
  }
  return structuredClone(value) as T.TrainingDeploymentConfig
}

export function parseFrozenExecutionPlacement(value: unknown): T.FrozenExecutionPlacement {
  const d = object(value, ['schemaVersion', 'taskExecution', 'modelRuntime', 'gpuScheduling'], 'frozen deployment')
  requireContract(d.schemaVersion === 2, 'invalid-deployment-version', 'frozen deployment must use schemaVersion 2')
  taskExecution(d.taskExecution, true); scheduling(d.gpuScheduling)
  const m = object(d.modelRuntime, ['nodeRef', 'nodeId', 'generation', 'launcher', 'runtimeDigest'], 'frozen model runtime')
  requireContract(id(m.nodeRef) && id(m.nodeId) && id(m.generation) && ['docker', 'process'].includes(String(m.launcher)) && digest(m.runtimeDigest),
    'invalid-model-node', 'model node identity, generation and runtime must be verified and frozen')
  return structuredClone(value) as T.FrozenExecutionPlacement
}

export function parseNodeGpus(value: unknown, nodeId: string): T.NodeGpu[] {
  requireContract(Array.isArray(value) && value.length > 0, 'invalid-gpu-pool', 'node GPU pool must be nonempty')
  const seen = new Set<string>()
  for (const item of value) {
    const gpu = object(item, ['nodeId', 'gpuUuid'], 'GPU')
    requireContract(gpu.nodeId === nodeId && text(gpu.gpuUuid) && /^GPU-[a-zA-Z0-9-]+$/.test(gpu.gpuUuid), 'invalid-gpu-node', 'GPU UUID must belong to the selected model node')
    const key = digestJson(gpu)
    requireContract(!seen.has(key), 'duplicate-device', 'node GPU identity is repeated'); seen.add(key)
  }
  return structuredClone(value) as T.NodeGpu[]
}

/** Lossless adapters do not mutate the v1 object or rewrite its serialized identity. */
export function actorRolloutPlacement(input: T.ModelTrainingSpec | T.TrainingRequest): 'separate' | 'colocated' {
  return input.schemaVersion === 2 ? (input.deployment.gpuScheduling.actorRollout === 'colocated' ? 'colocated' : 'separate') : input.trainer.placement ?? 'separate'
}
export function trainEvaluationMode(spec: T.ModelTrainingSpec): 'isolated' | 'sequential' {
  return spec.schemaVersion === 2 ? spec.deployment.gpuScheduling.trainEvaluation : spec.resources.mode
}
export function gpuUuids(devices: string[] | T.NodeGpu[]): string[] { return devices.map(d => typeof d === 'string' ? d : d.gpuUuid) }

export interface DeploymentObservation {
  node: T.NodeIdentity & { runtimeDigest: string; gpuUuids: string[]; launchers: ('docker' | 'process')[] }
  provider: { name: string; placement: 'local' | 'remote'; identityDigest: string; capabilitiesDigest: string;
    capabilities: { harborDocker: boolean; exactTrainingBinding: boolean; managedModelRoute: boolean } }
}
export function freezeExecutionPlacement(configInput: unknown, observation: DeploymentObservation): T.FrozenExecutionPlacement {
  const config = parseTrainingDeployment(configInput); const provider = observation.provider
  requireContract(provider.name === config.taskExecution.provider && provider.placement === config.taskExecution.placement,
    'provider-placement-mismatch', 'provider observation does not match the selected execution node')
  for (const key of ['harborDocker', 'exactTrainingBinding', 'managedModelRoute'] as const) {
    requireContract(provider.capabilities[key] === true, 'missing-provider-capability', `${provider.name} lacks ${key}`)
  }
  requireContract(observation.node.launchers.includes(config.modelRuntime.launcher), 'missing-model-launcher', 'model node does not support the selected launcher')
  return parseFrozenExecutionPlacement({ schemaVersion: 2,
    taskExecution: { ...config.taskExecution, providerIdentityDigest: provider.identityDigest, capabilitiesDigest: provider.capabilitiesDigest },
    modelRuntime: { ...config.modelRuntime, nodeId: observation.node.nodeId, generation: observation.node.generation, runtimeDigest: observation.node.runtimeDigest },
    gpuScheduling: config.gpuScheduling })
}

/** Reconnection must resolve the same frozen node; addresses may change, identity may not. */
export function assertDeploymentMatches(frozen: T.FrozenExecutionPlacement, config: T.TrainingDeploymentConfig, observation: DeploymentObservation): void {
  requireContract(digestJson(freezeExecutionPlacement(config, observation)) === digestJson(frozen), 'deployment-drift', 'execution placement changed; initialize a new experiment and baseline')
}
