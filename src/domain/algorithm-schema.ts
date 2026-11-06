import definitions from './algorithm-v1.schema.json' with { type: 'json' }
import { GearError } from './errors.js'

type Schema = {
  $ref?: string
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean | Schema
  items?: Schema
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  maxLength?: number
  pattern?: string
  maxItems?: number
}
const defs = definitions.$defs as Record<string, Schema>
export function validateAlgorithmWire(name: string, value: unknown): void {
  const fail = (path: string): never => {
    throw new GearError('invalid-algorithm-message', `Invalid protocol value at ${path}`)
  }
  const check = (schema: Schema, item: unknown, path: string): void => {
    if (schema.$ref) return check(defs[schema.$ref.split('/').at(-1)!]!, item, path)
    if ('const' in schema) {
      if (item !== schema.const) fail(path)
      return
    }
    if (schema.enum) {
      if (!schema.enum.includes(item)) fail(path)
      return
    }
    if (schema.anyOf) {
      if (
        !schema.anyOf.some((choice) => {
          try {
            check(choice, item, path)
            return true
          } catch {
            return false
          }
        })
      )
        fail(path)
      return
    }
    if (schema.type === 'null' && item === null) return
    if (schema.type === 'string' && typeof item === 'string' && item.isWellFormed()) {
      if (
        (schema.maxLength !== undefined && [...item].length > schema.maxLength) ||
        (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(item))
      )
        fail(path)
      return
    }
    if (schema.type === 'boolean' && typeof item === 'boolean') return
    if (
      (schema.type === 'number' || schema.type === 'integer') &&
      typeof item === 'number' &&
      Number.isFinite(item)
    ) {
      if (item < (schema.minimum ?? -Infinity) || item > (schema.maximum ?? Infinity)) fail(path)
      if (schema.exclusiveMinimum !== undefined && item <= schema.exclusiveMinimum) fail(path)
      if (
        schema.type === 'integer' &&
        (!Number.isSafeInteger(item) ||
          item < (schema.minimum ?? 0) ||
          item > (schema.maximum ?? Number.MAX_SAFE_INTEGER))
      )
        fail(path)
      return
    }
    if (schema.type === 'array' && Array.isArray(item)) {
      if (schema.maxItems !== undefined && item.length > schema.maxItems) fail(path)
      item.forEach((child, i) => check(schema.items!, child, `${path}[${i}]`))
      return
    }
    if (schema.type === 'object' && item && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>
      if (schema.required?.some((key) => !Object.hasOwn(object, key))) fail(path)
      for (const [key, child] of Object.entries(object)) {
        if (!key.isWellFormed()) fail(path)
        const field = schema.properties?.[key] ?? schema.additionalProperties
        if (!field || field === true) fail(`${path}.${key}`)
        check(field as Schema, child, `${path}.${key}`)
      }
      return
    }
    fail(path)
  }
  if (!defs[name]) fail(name)
  check(defs[name]!, value, name)
}
