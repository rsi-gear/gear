import type { Json, Operation } from './algorithm-wire.js'
import { GearError } from './errors.js'
export interface MaterialRef {
  operation_id: string
}
export interface MaterialInput {
  operation_id: string
  digest: string
  data: Json
}
export function materialReferences(operation: Operation): Record<string, MaterialRef> {
  const payload = operation.payload as Record<string, unknown> | null
  if (!payload || !Object.hasOwn(payload, 'gear_materials_v1')) return {}
  const refs = payload.gear_materials_v1
  if (!refs || typeof refs !== 'object' || Array.isArray(refs))
    throw new GearError('invalid-material-ref', 'Materials require named completed operation references')
  for (const [name, value] of Object.entries(refs)) {
    if (
      !/^[a-zA-Z0-9_-]+$/u.test(name) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'operation_id' ||
      !/^sha256:[a-f0-9]{64}$/u.test((value as MaterialRef).operation_id)
    )
      throw new GearError('invalid-material-ref', 'Material names and operation references must be canonical')
  }
  return refs as Record<string, MaterialRef>
}
