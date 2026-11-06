import { digestJson } from './json.js'
import { GearError } from '../../domain/errors.js'
function requireContract(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new GearError(code, message)
}
export interface HitchControllerObservation {
  schema_version: '2'
  package_version: string
  node_version: string
  runtime_id: string
  source:
    | { kind: 'git-checkout'; commit: string; dirty: boolean }
    | { kind: 'unavailable'; commit: null; dirty: null }
}

type Json = Record<string, unknown>
const object = (value: unknown): Json => {
  requireContract(
    !!value && typeof value === 'object' && !Array.isArray(value),
    'invalid-provider-environment',
    'provider observation must contain structured environment evidence',
  )
  return value as Json
}
const text = (value: unknown) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/\s/u.test(value) &&
  [...value].every((character) => character.charCodeAt(0) >= 32)
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const version = (value: unknown) =>
  typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)

const diagnosticStages = {
  ok: ['complete'],
  not_found: ['resolve'],
  io_error: ['resolve', 'fingerprint', 'identity'],
  spawn_error: ['command'],
  nonzero_exit: ['command'],
  signal_exit: ['command'],
  timed_out: ['command'],
  output_limit: ['command'],
  invalid_encoding: ['parse'],
  invalid_json: ['parse'],
  invalid_fields: ['validate'],
  executable_changed: ['identity'],
} as const
interface ProviderProbeDiagnostic {
  probe: 'harbor_version' | 'docker_info' | 'buildx_version'
  attempt: 1 | 2
  stage: (typeof diagnosticStages)[keyof typeof diagnosticStages][number]
  outcome: keyof typeof diagnosticStages
  elapsed_ms: number
  exit_code: number | null
  signal: 'SIGTERM' | 'SIGKILL' | 'other' | null
}

/** Rebuild bounded public metadata; never serialize a provider's raw diagnostic object. */
export function providerDiagnostics(value: unknown): {
  schema_version: '1'
  probes: ProviderProbeDiagnostic[]
} {
  const diagnostics = object(value)
  const message = 'unexpected provider probe diagnostics contract'
  requireContract(
    Object.keys(diagnostics).sort().join(',') === 'probes,schema_version' &&
      diagnostics.schema_version === '1' &&
      Array.isArray(diagnostics.probes) &&
      diagnostics.probes.length >= 1 &&
      diagnostics.probes.length <= 4,
    'invalid-provider-environment',
    message,
  )
  const seen = new Set<string>()
  const probes = Array.from(diagnostics.probes).map((entry: unknown): ProviderProbeDiagnostic => {
    const record = object(entry)
    const { probe, attempt, stage, outcome, elapsed_ms, exit_code, signal } = record
    requireContract(
      Object.keys(record).sort().join(',') === 'attempt,elapsed_ms,exit_code,outcome,probe,signal,stage' &&
        (probe === 'harbor_version' || probe === 'docker_info' || probe === 'buildx_version') &&
        (attempt === 1 || (attempt === 2 && probe === 'docker_info' && seen.has('docker_info:1'))) &&
        typeof stage === 'string' &&
        typeof outcome === 'string' &&
        Object.hasOwn(diagnosticStages, outcome) &&
        (diagnosticStages[outcome as keyof typeof diagnosticStages] as readonly string[]).includes(stage) &&
        Number.isInteger(elapsed_ms) &&
        (elapsed_ms as number) >= 0 &&
        (elapsed_ms as number) <= 30_000 &&
        (exit_code === null ||
          (Number.isInteger(exit_code) &&
            (exit_code as number) >= -2_147_483_648 &&
            (exit_code as number) <= 4_294_967_295)) &&
        (signal === null || signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'other') &&
        (outcome !== 'nonzero_exit' || (exit_code !== null && exit_code !== 0 && signal === null)) &&
        (outcome !== 'signal_exit' || (exit_code === null && signal !== null)) &&
        (outcome !== 'ok' || (exit_code === 0 && signal === null)),
      'invalid-provider-environment',
      message,
    )
    const key = `${probe}:${attempt}`
    requireContract(!seen.has(key), 'invalid-provider-environment', message)
    seen.add(key)
    return {
      probe,
      attempt,
      stage: stage as ProviderProbeDiagnostic['stage'],
      outcome: outcome as ProviderProbeDiagnostic['outcome'],
      elapsed_ms: elapsed_ms as number,
      exit_code: exit_code as number | null,
      signal,
    }
  })
  return { schema_version: '1', probes }
}

/** Nonce and instance are request context. Only the stable, observed environment enters identity. */
export function providerEnvironment(
  value: unknown,
  expected: {
    nonce: string
    provider: unknown
    workerId: unknown
    collisionDomainId: unknown
    controller: HitchControllerObservation
    generation?: number | null
    daemonInstanceId?: string
  },
): Json {
  const result = object(value)
  requireContract(
    result.schema_version === '2' &&
      result.nonce === expected.nonce &&
      result.provider === expected.provider &&
      result.worker_id === expected.workerId &&
      result.collision_domain_id === expected.collisionDomainId &&
      result.generation === (expected.generation ?? null) &&
      (expected.generation == null ||
        (Number.isSafeInteger(expected.generation) && expected.generation >= 1)) &&
      (expected.daemonInstanceId === undefined || result.daemon_instance_id === expected.daemonInstanceId) &&
      typeof result.daemon_instance_id === 'string' &&
      /^[a-f0-9]{32}$/.test(result.daemon_instance_id),
    'provider-observation-mismatch',
    'fresh provider observation does not match the requested nonce, worker generation or daemon identity',
  )
  const resident = object(result.daemon_runtime)
  requireContract(
    resident.schema_version === '2' &&
      resident.unchanged === true &&
      digestJson(object(resident.startup)) === digestJson(object(resident.current)) &&
      digestJson(resident.current) === digestJson(expected.controller),
    'daemon-runtime-drift',
    'Hitch daemon startup/current runtime must match the CLI runtime; restart the daemon after rebuilding or changing its checkout',
  )
  if (expected.generation != null) remoteWorkerRuntime(result.worker_runtime, expected.controller)
  const environment = object(result.environment)
  requireContract(
    environment.schema_version === '2' &&
      text(environment.host_platform) &&
      result.environment_digest === digestJson(environment),
    'provider-environment-drift',
    'actual provider environment digest is missing or inconsistent',
  )
  assertProviderEnvironmentAvailable(environment, result.diagnostics)
  return environment
}

/** Availability and safe failure details are shared by resident observations and the local SDK. */
export function assertProviderEnvironmentAvailable(value: unknown, rawDiagnostics?: unknown): void {
  const environment = object(value)
  requireContract(
    environment.schema_version === '2' && text(environment.host_platform),
    'invalid-provider-environment',
    'unexpected environment observation contract',
  )
  const diagnostics = rawDiagnostics === undefined ? undefined : providerDiagnostics(rawDiagnostics)
  const harbor = object(environment.harbor),
    docker = object(environment.docker),
    buildx = object(environment.buildx)
  const checks = {
    'harbor.status': harbor.status === 'available',
    'harbor.version': version(harbor.version),
    'harbor.executable_digest': digest(harbor.executable_digest),
    'docker.status': docker.status === 'available',
    'docker.version': version(docker.version),
    'docker.executable_digest': digest(docker.executable_digest),
    'docker.engine_id': text(docker.engine_id),
    'docker.os': docker.os === 'linux',
    'docker.architecture': text(docker.architecture),
  }
  const failed = Object.keys(checks).filter((key) => !checks[key as keyof typeof checks])
  if (failed.length) {
    // Only fixed check names and normalized states are public; raw tool errors may contain secrets.
    const status = (value: unknown) => (value === 'available' || value === 'unavailable' ? value : 'invalid')
    throw new GearError(
      'provider-environment-unavailable',
      `selected execution provider must observe a working Harbor executable and Linux Docker engine; failed checks: ${failed.join(', ')}; harbor=${status(harbor.status)}, docker=${status(docker.status)}${diagnostics ? `; diagnostics=${JSON.stringify(diagnostics)}` : ''}`,
    )
  }
  requireContract(
    ((buildx.status === 'available' && version(buildx.version)) ||
      (buildx.status === 'unavailable' && buildx.version === null)) &&
      object(environment.sandbox).status === 'unverified',
    'invalid-provider-environment',
    'unexpected environment observation contract; version observation does not certify sandbox execution',
  )
}

/** Worker host/Node versions may differ; its executable Hitch payload must match the controller. */
export function remoteWorkerRuntime(value: unknown, controller: HitchControllerObservation): Json {
  const resident = object(value),
    current = object(resident.current),
    source = object(current.source)
  requireContract(
    resident.schema_version === '2' &&
      resident.unchanged === true &&
      digestJson(object(resident.startup)) === digestJson(current) &&
      Object.keys(current).sort().join(',') ===
        'node_version,package_version,runtime_id,schema_version,source' &&
      current.schema_version === '2' &&
      current.runtime_id === controller.runtime_id &&
      current.package_version === controller.package_version &&
      typeof current.node_version === 'string' &&
      /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(current.node_version) &&
      Object.keys(source).sort().join(',') === 'commit,dirty,kind' &&
      ((source.kind === 'git-checkout' &&
        source.commit === controller.source.commit &&
        typeof source.dirty === 'boolean') ||
        (source.kind === 'unavailable' && source.commit === null && source.dirty === null)),
    'worker-runtime-drift',
    'remote worker startup/current Hitch payload must match the controller; restart or update the worker before freezing this deployment',
  )
  return current
}

/** Source-less installed packages still have a measured executable payload. */
export function controllerObservation(value: unknown): HitchControllerObservation {
  const r = object(value),
    source = object(r.source)
  requireContract(
    Object.keys(r).sort().join(',') === 'node_version,package_version,runtime_id,schema_version,source' &&
      r.schema_version === '2' &&
      version(r.package_version) &&
      version(r.node_version) &&
      digest(r.runtime_id) &&
      Object.keys(source).sort().join(',') === 'commit,dirty,kind' &&
      ((source.kind === 'git-checkout' &&
        typeof source.commit === 'string' &&
        /^[a-f0-9]{40}$/.test(source.commit) &&
        typeof source.dirty === 'boolean') ||
        (source.kind === 'unavailable' && source.commit === null && source.dirty === null)),
    'controller-runtime-unavailable',
    'Hitch must report its actual versioned controller payload identity',
  )
  return structuredClone(r) as unknown as HitchControllerObservation
}
