import { isArtifactOperation } from '../domain/artifacts.js'
import { ModelOperationProvider, type ModelContext } from '../adapters/model/provider.js'
import { isLocalWorkspace } from '../domain/workspaces.js'
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
  if (data.kind === 'model') {
    const profile = validateProfile(data.profile)
    if (!('kind' in profile) || profile.kind !== 'model') invalid()
    const context = object(data.context ?? null)
    return ModelOperationProvider.canceller(
      profile,
      { directory: path(context.directory), tasks: context.tasks as unknown as ModelContext['tasks'] },
      digest(data.identity),
    )
  }
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
        if (isLocalWorkspace(request.operation.kind) || isArtifactOperation(request.operation.kind)) return
        const payload = request.operation.payload
        const role =
          payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.gear_role_v1 : undefined
        const roles =
          data.roles && typeof data.roles === 'object' && !Array.isArray(data.roles) ? data.roles : {}
        const selected =
          request.operation.kind === 'evaluate_seed'
            ? data.evaluation
            : typeof role === 'string' && Object.hasOwn(roles, role)
              ? roles[role]
              : data.meta
        await (await configuredCancellation(selected ?? null)).cancel(request)
      },
    }
  }
  return invalid()
}
