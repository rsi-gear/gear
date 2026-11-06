import { isAbsolute } from 'node:path'
import { digestJson } from './digest.js'
import { parseEndpointBinding } from './endpoint-binding.js'
import { requireContract } from './schema.js'
import type { EvaluationEndpointBinding, NodeIdentity } from './types.js'

/** Private, opt-in native runtime configuration. It never enters a task package. */
export interface NativeDeploymentProfile {
  schemaVersion: 1
  name: string
  nodeRef: string
  node: NodeIdentity
  backend: 'supervisor'
  resourceGroup: string
  gpuUuids: string[]
  trainingGpuUuids: string[]
  tensorParallelSize: number
  python: string
  supervisorPython: string
  runtimeLock: {
    environmentDigest: string
    pythonVersion: string
    sglangVersion: string
    supervisorVersion: string
    timeoutBinary: string
    timeoutDigest: string
  }
  endpoint: {
    nodePort: number
    localPort: number
    api: 'chat-completions'
    capabilities: EvaluationEndpointBinding['capabilities']
    generation: EvaluationEndpointBinding['generation']
    serviceConfig: Record<string, unknown>
  }
  engineArgs: string[]
  startupTimeoutSeconds: number
  stopTimeoutSeconds: number
  maxDeploymentAttempts: number
  maxRuntimeSeconds: number
  minFreeDiskBytes: number
}

const hash = (x: unknown): x is string => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x)
const name = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(x)
const word = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && !/[\u0000-\u001f;%]/.test(x)
const path = (x: unknown): x is string => word(x) && isAbsolute(x)
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0
const keys = (x: unknown, expected: string[]): boolean => !!x && typeof x === 'object' && !Array.isArray(x)
  && digestJson(Object.keys(x).sort()) === digestJson(expected.sort())

/** Reject overrides of ownership, devices, model paths, credentials and executable code. */
export const nativeEngineValueFlags = new Set(['--context-length', '--mem-fraction-static', '--tool-call-parser',
  '--reasoning-parser', '--dtype', '--attention-backend', '--schedule-policy', '--max-running-requests', '--chunked-prefill-size'])
export const nativeEngineBooleanFlags = new Set(['--disable-cuda-graph', '--disable-radix-cache', '--enable-deterministic-inference'])

export function parseNativeDeploymentProfile(value: unknown): NativeDeploymentProfile {
  const p = structuredClone(value) as NativeDeploymentProfile
  requireContract(keys(p, ['schemaVersion', 'name', 'nodeRef', 'node', 'backend', 'resourceGroup', 'gpuUuids', 'trainingGpuUuids',
    'tensorParallelSize', 'python', 'supervisorPython', 'runtimeLock', 'endpoint', 'engineArgs', 'startupTimeoutSeconds',
    'stopTimeoutSeconds', 'maxDeploymentAttempts', 'maxRuntimeSeconds', 'minFreeDiskBytes']), 'invalid-native-profile', 'native deployment profile has missing or unknown fields')
  requireContract(p.schemaVersion === 1 && p.backend === 'supervisor' && name(p.name) && name(p.nodeRef) && name(p.resourceGroup)
    && keys(p.node, ['nodeId', 'generation']) && word(p.node.nodeId) && word(p.node.generation)
    && path(p.python) && path(p.supervisorPython), 'invalid-native-profile', 'native profile requires a pinned node and explicit Python executables')
  const gpuList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && /^GPU-[A-Za-z0-9-]+$/.test(x)) && new Set(v).size === v.length
  requireContract(gpuList(p.gpuUuids) && p.gpuUuids.length > 0 && gpuList(p.trainingGpuUuids)
    && p.gpuUuids.every(gpu => !p.trainingGpuUuids.includes(gpu)) && positive(p.tensorParallelSize)
    && p.tensorParallelSize === p.gpuUuids.length, 'native-gpu-overlap', 'training and evaluation require disjoint reserved GPU UUIDs and one TP rank per evaluation GPU')
  const r = p.runtimeLock
  requireContract(keys(r, ['environmentDigest', 'pythonVersion', 'sglangVersion', 'supervisorVersion', 'timeoutBinary', 'timeoutDigest'])
    && hash(r.environmentDigest) && hash(r.timeoutDigest) && path(r.timeoutBinary)
    && [r.pythonVersion, r.sglangVersion, r.supervisorVersion].every(word), 'invalid-native-runtime-lock', 'native runtime, Supervisor and deadline utility must be pinned')
  const e = p.endpoint
  requireContract(keys(e, ['nodePort', 'localPort', 'api', 'capabilities', 'generation', 'serviceConfig']) && e.api === 'chat-completions'
    && [e.nodePort, e.localPort].every(port => positive(port) && port <= 65535)
    && keys(e.capabilities, ['streaming', 'tool_calls', 'parallel_tool_calls', 'input_modalities'])
    && e.capabilities.streaming === true && e.capabilities.tool_calls === true && e.capabilities.parallel_tool_calls === false
    && digestJson(e.capabilities.input_modalities) === digestJson(['text']), 'invalid-native-endpoint', 'native evaluation requires the verified streaming and tool-call contract')
  requireContract(Array.isArray(p.engineArgs) && p.engineArgs.every(word), 'invalid-native-engine-args', 'native engine arguments must be explicit safe tokens')
  const flags = new Set<string>()
  for (let i = 0; i < p.engineArgs.length; i++) {
    const flag = p.engineArgs[i]!
    requireContract(!flags.has(flag) && (nativeEngineValueFlags.has(flag) || nativeEngineBooleanFlags.has(flag)),
      'invalid-native-engine-args', 'engine arguments cannot override the model, authentication, devices, deadline or entry point')
    flags.add(flag)
    if (nativeEngineValueFlags.has(flag)) requireContract(word(p.engineArgs[++i]) && !p.engineArgs[i]!.startsWith('--'),
      'invalid-native-engine-args', 'engine option requires one explicit value')
  }
  requireContract(e.serviceConfig?.engine === 'sglang' && e.serviceConfig.engine_version === r.sglangVersion
    && e.serviceConfig.engine_digest === digestJson({ environmentDigest: r.environmentDigest, engineArgs: p.engineArgs }),
    'native-service-config-drift', 'public engine identity must describe the pinned runtime and engine arguments')
  for (const [flag, field] of [['--tool-call-parser', 'tool_parser'], ['--reasoning-parser', 'reasoning_parser']] as const) {
    const index = p.engineArgs.indexOf(flag)
    requireContract(index < 0 ? !e.serviceConfig[field] : e.serviceConfig[field] === p.engineArgs[index + 1],
      'native-service-config-drift', 'declared parser differs from actual engine arguments')
  }
  requireContract([p.startupTimeoutSeconds, p.stopTimeoutSeconds, p.maxDeploymentAttempts, p.maxRuntimeSeconds].every(positive)
    && p.maxDeploymentAttempts <= 16 && p.stopTimeoutSeconds <= 600 && p.startupTimeoutSeconds <= p.maxRuntimeSeconds
    && Number.isSafeInteger(p.minFreeDiskBytes) && p.minFreeDiskBytes >= 0,
    'invalid-native-deadline', 'native preparation, attempts, stop and maximum residence must be bounded')
  const connection = { base_url: 'http://127.0.0.1/v1', auth: { kind: 'env' as const, name: 'GEAR_NATIVE_PROFILE_VALIDATION' } }
  parseEndpointBinding({ schema_version: '1', kind: 'external-endpoint', endpoint_ref: 'endpoint/native-profile-validation',
    endpoint_revision: digestJson({ schema_version: '1', ...connection, wire_model: 'profile-validation', api: e.api, capabilities: e.capabilities }),
    api: e.api, wire_model: 'profile-validation', capabilities: e.capabilities, generation: e.generation, connection,
    deployment_receipt: { schema_version: '1', model_digest: `sha256:${'0'.repeat(64)}`, wire_model: 'profile-validation',
      deployment_ref: 'profile-validation', source: 'gear-native-profile-validation', service_config: e.serviceConfig } }, true)
  return p
}
