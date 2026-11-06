import { randomBytes } from 'node:crypto'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { controllerObservation, providerEnvironment } from './environment.js'
import { hitchEnvironmentTimeoutMs } from './settings.js'

export const evaluationProvider = 'local-docker'
export type ObservationCall = (
  args: string[],
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>

/** Fresh resident evidence; nonce/daemon instance authenticate a response, not baseline identity. */
export async function observeEvaluationEnvironment(call: ObservationCall, signal: AbortSignal) {
  const daemon = await call(['daemon', 'status', '--json'], signal)
  if (
    daemon.status !== 'running' ||
    typeof daemon.instance_id !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(daemon.instance_id)
  )
    throw new GearError('hitch-daemon-unavailable', 'Start the configured Hitch daemon before evaluating')
  const controller = controllerObservation(await call(['training', 'runtime', '--json'], signal))
  const listing = await call(['worker', 'list', '--json'], signal)
  const workers = Array.isArray(listing.workers)
    ? listing.workers.filter(
        (v): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && v.provider === evaluationProvider,
      )
    : []
  const worker = workers[0]
  if (
    workers.length !== 1 ||
    !worker ||
    worker.health !== 'healthy' ||
    worker.revoked_at ||
    (worker.status !== undefined && worker.status !== 'ready') ||
    typeof worker.worker_id !== 'string' ||
    !worker.worker_id ||
    typeof worker.collision_domain_id !== 'string' ||
    !worker.collision_domain_id
  )
    throw new GearError(
      'execution-provider-unavailable',
      'Hitch requires one healthy local Docker execution worker',
    )
  const nonce = randomBytes(16).toString('hex')
  const response = await call(
    ['worker', 'observe', evaluationProvider, '--nonce', nonce, '--json'],
    signal,
    hitchEnvironmentTimeoutMs,
  )
  const environment = providerEnvironment(response, {
    nonce,
    provider: evaluationProvider,
    workerId: worker.worker_id,
    collisionDomainId: worker.collision_domain_id,
    controller,
    daemonInstanceId: daemon.instance_id,
  })
  return {
    provider: evaluationProvider,
    workerId: worker.worker_id,
    collisionDomainId: worker.collision_domain_id,
    controller,
    environment,
  }
}

export async function assertEvaluationEnvironment(
  call: ObservationCall,
  signal: AbortSignal,
  frozen: Awaited<ReturnType<typeof observeEvaluationEnvironment>>,
) {
  if (canonicalDigest(await observeEvaluationEnvironment(call, signal)) !== canonicalDigest(frozen))
    throw new GearError(
      'hitch-environment-drift',
      'Hitch controller or execution environment changed after this evaluation was frozen',
    )
}
