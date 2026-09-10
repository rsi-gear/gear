import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type { NodeIdentity } from './types.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => {
  requireContract(!!v && typeof v === 'object' && !Array.isArray(v), 'invalid-node-preflight', 'model-node preflight must be structured')
  return v as Json
}
const exact = (v: unknown, keys: string[]) => {
  const value = object(v)
  requireContract(Object.keys(value).length === keys.length && keys.every(key => key in value), 'invalid-node-preflight', 'unexpected model-node preflight fields')
  return value
}
const hash = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const codes = ['training-node-configuration', 'package-torch', 'package-sglang', 'package-psutil', 'package-ray', 'slime-checkout',
  'megatron-checkout', 'host-memory-observation', 'gpu-inventory', 'gpu-process-observation', 'cuda-runtime', 'model-gateway-configuration'] as const
const optionalCodes = ['slime-tracked-runtime', 'slime-export-extension', 'megatron-tracked-runtime', 'runtime-changed-during-observation']

export interface ModelNodePreflight {
  schemaVersion: 2
  kind: 'model-node-preflight'
  node: NodeIdentity
  runtimeDigest: string
  checks: { code: string; status: 'passed' | 'blocked' }[]
  sources: Record<string, { commit: string; patchDigest: string | null; untrackedRuntimeCode: boolean; exportExtension?: boolean }>
  gpus: { uuid: string; name: string; memoryMiB: number; driverVersion: string; activeProcesses: number | null }[]
  hostMemory: { totalBytes: number; availableBytes: number } | null
  cudaVersion: string | null
  ports: { rollout: number | null; inference: number | null }
}

/** Only allow known public observations; never forward an arbitrary node error body. */
export function parseModelNodePreflight(input: unknown, node: NodeIdentity, runtimeDigest: string): ModelNodePreflight {
  const value = exact(input, ['schemaVersion', 'kind', 'node', 'runtimeDigest', 'checks', 'sources', 'gpus', 'hostMemory', 'cudaVersion', 'ports'])
  requireContract(value.schemaVersion === 2 && value.kind === 'model-node-preflight' && digestJson(value.node) === digestJson(node)
    && value.runtimeDigest === runtimeDigest && hash(value.runtimeDigest), 'model-node-runtime-drift', 'model node changed during its preflight')
  requireContract(Array.isArray(value.checks), 'invalid-node-preflight', 'model-node checks are missing')
  const checks = value.checks.map(item => exact(item, ['code', 'status']))
  requireContract(codes.every(code => checks.some(item => item.code === code)) && new Set(checks.map(item => item.code)).size === checks.length
    && checks.every(item => typeof item.code === 'string' && [...codes, ...optionalCodes].includes(item.code)
      && (item.status === 'passed' || item.status === 'blocked')),
  'invalid-node-preflight', 'model-node checks are incomplete or unknown')
  for (const [name, raw] of Object.entries(object(value.sources))) {
    requireContract(['slime', 'megatron'].includes(name), 'invalid-node-preflight', 'unknown model source')
    const source = exact(raw, ['commit', 'patchDigest', 'untrackedRuntimeCode', ...(name === 'slime' ? ['exportExtension'] : [])])
    requireContract(typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit) && (source.patchDigest === null || hash(source.patchDigest))
      && typeof source.untrackedRuntimeCode === 'boolean' && (name !== 'slime' || typeof source.exportExtension === 'boolean'),
    'invalid-node-preflight', 'invalid runtime source observation')
  }
  requireContract(Array.isArray(value.gpus), 'invalid-node-preflight', 'missing GPU inventory')
  const gpus = value.gpus.map(raw => exact(raw, ['uuid', 'name', 'memoryMiB', 'driverVersion', 'activeProcesses']))
  requireContract(new Set(gpus.map(gpu => gpu.uuid)).size === gpus.length && gpus.every(gpu => typeof gpu.uuid === 'string' && /^GPU-[A-Za-z0-9-]+$/.test(gpu.uuid)
    && integer(gpu.memoryMiB) && Number(gpu.memoryMiB) > 0 && (gpu.activeProcesses === null || integer(gpu.activeProcesses))
    && [gpu.name, gpu.driverVersion].every(field => typeof field === 'string' && field.length > 0 && field.length < 256 && !/[\u0000-\u001f]/.test(field))),
  'invalid-node-preflight', 'invalid GPU inventory')
  if (value.hostMemory !== null) {
    const memory = exact(value.hostMemory, ['totalBytes', 'availableBytes'])
    requireContract(integer(memory.totalBytes) && Number(memory.totalBytes) > 0 && integer(memory.availableBytes) && Number(memory.availableBytes) <= Number(memory.totalBytes),
      'invalid-node-preflight', 'invalid host memory observation')
  }
  requireContract(value.cudaVersion === null || typeof value.cudaVersion === 'string' && /^\d+(\.\d+)+$/.test(value.cudaVersion), 'invalid-node-preflight', 'invalid CUDA version')
  const ports = exact(value.ports, ['rollout', 'inference'])
  requireContract(Object.values(ports).every(port => port === null || integer(port) && Number(port) > 0 && Number(port) < 65536), 'invalid-node-preflight', 'invalid model gateway port')
  const passed = (code: string) => checks.find(item => item.code === code)?.status === 'passed'
  requireContract(passed('gpu-inventory') === (gpus.length > 0) && passed('cuda-runtime') === (value.cudaVersion !== null)
    && passed('host-memory-observation') === (value.hostMemory !== null)
    && gpus.every(gpu => passed('gpu-process-observation') === (gpu.activeProcesses !== null))
    && !passed('runtime-changed-during-observation')
    && passed('model-gateway-configuration') === (ports.rollout !== null && ports.inference !== null && ports.rollout !== ports.inference),
  'invalid-node-preflight', 'model-node checks contradict their observations')
  const sources = object(value.sources)
  for (const name of ['slime', 'megatron']) {
    requireContract(passed(`${name}-checkout`) === (name in sources), 'invalid-node-preflight', 'source check has no matching observation')
    if (name in sources) requireContract(checks.some(item => item.code === `${name}-tracked-runtime`)
      && passed(`${name}-tracked-runtime`) === !object(sources[name]).untrackedRuntimeCode
      && (name !== 'slime' || checks.some(item => item.code === 'slime-export-extension')
        && passed('slime-export-extension') === object(sources[name]).exportExtension), 'invalid-node-preflight', 'source checks contradict their observations')
    else requireContract(!checks.some(item => item.code === `${name}-tracked-runtime` || name === 'slime' && item.code === 'slime-export-extension'),
      'invalid-node-preflight', 'source details require a checkout observation')
  }
  return value as unknown as ModelNodePreflight
}
