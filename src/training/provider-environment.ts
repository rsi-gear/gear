import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type { HitchControllerObservation } from './placement-observation.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => {
  requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-provider-environment', 'provider observation must contain structured environment evidence')
  return value as Json
}
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value)
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const version = (value: unknown) => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)

/** Nonce and instance are request context. Only the stable, observed environment enters identity. */
export function providerEnvironment(value: unknown, expected: {
  nonce: string; provider: unknown; workerId: unknown; collisionDomainId: unknown; controller: HitchControllerObservation; generation?: number | null
}): Json {
  const result = object(value)
  requireContract(result.schema_version === '2' && result.nonce === expected.nonce && result.provider === expected.provider
    && result.worker_id === expected.workerId && result.collision_domain_id === expected.collisionDomainId && result.generation === (expected.generation ?? null)
    && (expected.generation == null || Number.isSafeInteger(expected.generation) && expected.generation >= 1)
    && typeof result.daemon_instance_id === 'string' && /^[a-f0-9]{32}$/.test(result.daemon_instance_id),
  'provider-observation-mismatch', 'fresh provider observation does not match the requested nonce, worker generation or daemon identity')
  const resident = object(result.daemon_runtime)
  requireContract(resident.schema_version === '2' && resident.unchanged === true
    && digestJson(object(resident.startup)) === digestJson(object(resident.current))
    && digestJson(resident.current) === digestJson(expected.controller),
  'daemon-runtime-drift', 'Hitch daemon startup/current runtime must match the CLI runtime; restart the daemon after rebuilding or changing its checkout')
  if (expected.generation != null) remoteWorkerRuntime(result.worker_runtime, expected.controller)
  const environment = object(result.environment)
  requireContract(environment.schema_version === '2' && text(environment.host_platform)
    && result.environment_digest === digestJson(environment), 'provider-environment-drift', 'actual provider environment digest is missing or inconsistent')
  const harbor = object(environment.harbor), docker = object(environment.docker), buildx = object(environment.buildx)
  requireContract(harbor.status === 'available' && version(harbor.version) && digest(harbor.executable_digest)
    && docker.status === 'available' && version(docker.version) && digest(docker.executable_digest)
    && text(docker.engine_id) && docker.os === 'linux' && text(docker.architecture),
  'provider-environment-unavailable', 'selected execution provider must observe a working Harbor executable and Linux Docker engine')
  requireContract((buildx.status === 'available' && version(buildx.version) || buildx.status === 'unavailable' && buildx.version === null)
    && object(environment.sandbox).status === 'unverified', 'invalid-provider-environment', 'unexpected environment observation contract; version observation does not certify sandbox execution')
  return environment
}

/** Worker host/Node versions may differ; its executable Hitch payload must match the controller. */
export function remoteWorkerRuntime(value: unknown, controller: HitchControllerObservation): Json {
  const resident = object(value), current = object(resident.current), source = object(current.source)
  requireContract(resident.schema_version === '2' && resident.unchanged === true
    && digestJson(object(resident.startup)) === digestJson(current)
    && Object.keys(current).sort().join(',') === 'node_version,package_version,runtime_id,schema_version,source'
    && current.schema_version === '2' && current.runtime_id === controller.runtime_id && current.package_version === controller.package_version
    && typeof current.node_version === 'string' && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(current.node_version)
    && Object.keys(source).sort().join(',') === 'commit,dirty,kind'
    && (source.kind === 'git-checkout' && source.commit === controller.source.commit && typeof source.dirty === 'boolean'
      || source.kind === 'unavailable' && source.commit === null && source.dirty === null),
  'worker-runtime-drift', 'remote worker startup/current Hitch payload must match the controller; restart or update the worker before freezing this deployment')
  return current
}
