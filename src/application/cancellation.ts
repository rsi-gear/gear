import { isAbsolute } from 'node:path'
import type { Json } from '../domain/algorithm-wire.js'
import { GearError } from '../domain/errors.js'
import type { OperationCancellation } from '../ports/operations.js'
import { HitchOperationProvider } from '../adapters/hitch/provider.js'
import { ProcessOperationProvider } from '../adapters/process/operation-provider.js'
import { validateProfile } from './profile-store.js'

function invalid(): never {
  throw new GearError('cancellation-connection-unavailable', 'Frozen cancellation connection is unavailable')
}
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, Json>
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string' || !value) invalid()
  return value as string
}
function path(value: Json | undefined): string {
  const result = text(value)
  if (!isAbsolute(result)) invalid()
  return result
}
function digest(value: Json | undefined): string {
  const result = text(value)
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid()
  return result
}

/** No profile lookup, handshake, SDK preparation, credentials test, or algorithm startup. */
export async function configuredCancellation(snapshot: Json): Promise<OperationCancellation> {
  const data = object(snapshot)
  if (data.version !== 1) invalid()
  if (data.kind === 'hitch')
    return HitchOperationProvider.canceller({
      executable: path(data.executable),
      root: path(data.root),
      directory: path(data.directory),
      identity: digest(data.identity),
    })
  if (data.kind === 'process') {
    const profile = validateProfile(data.profile)
    if ('kind' in profile || !isAbsolute(profile.command[0]!)) invalid()
    return ProcessOperationProvider.canceller(
      profile,
      data.context ?? null,
      digest(data.implementationIdentity),
    )
  }
  if (data.kind === 'composite') {
    return {
      async cancel(request) {
        const selected = request.operation.kind === 'evaluate_seed' ? data.evaluation : data.meta
        await (await configuredCancellation(selected ?? null)).cancel(request)
      },
    }
  }
  return invalid()
}
