import definitions from './schema.json' with { type: 'json' }

type JsonSchema = { $ref?: string; const?: unknown; type?: string; anyOf?: JsonSchema[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema; items?: JsonSchema }
const defs = definitions.$defs as Record<string, JsonSchema>

/** Structural JSON validation complements the semantic identity/budget checks. */
export function validateSearchSchema(name: string, value: unknown): void {
  const root = defs[name]
  if (!root) throw new TypeError(`unknown search schema: ${name}`)
  const check = (schema: JsonSchema, item: unknown, path: string): void => {
    if (schema.$ref) { const ref = defs[schema.$ref.slice('#/$defs/'.length)]; if (!ref) throw new TypeError(`unknown schema reference ${schema.$ref}`); check(ref, item, path); return }
    if ('const' in schema && item !== schema.const) throw new TypeError(`${path} has an unsupported value`)
    if (schema.anyOf) {
      if (!schema.anyOf.some(alternative => { try { check(alternative, item, path); return true } catch { return false } })) throw new TypeError(`${path} does not match its declared union`)
      return
    }
    if (!schema.type) return
    if (schema.type === 'null') { if (item !== null) throw new TypeError(`${path} must be null`); return }
    if (schema.type === 'array') {
      if (!Array.isArray(item)) throw new TypeError(`${path} must be an array`)
      if (schema.items) for (const [index, child] of item.entries()) check(schema.items, child, `${path}[${index}]`)
      return
    }
    if (schema.type === 'object') {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new TypeError(`${path} must be an object`)
      const object = item as Record<string, unknown>
      for (const required of schema.required ?? []) if (!(required in object) || object[required] === undefined) throw new TypeError(`${path}.${required} is required`)
      for (const [key, child] of Object.entries(object)) {
        if (child === undefined) continue
        const property = schema.properties?.[key]
        if (property) check(property, child, `${path}.${key}`)
        else if (schema.additionalProperties === false) throw new TypeError(`${path}.${key} is not supported`)
        else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, child, `${path}.${key}`)
      }
      return
    }
    if (typeof item !== schema.type || schema.type === 'number' && !Number.isFinite(item)) throw new TypeError(`${path} must be a finite ${schema.type}`)
  }
  check(root, value, name)
}
export const searchJsonSchema = definitions
