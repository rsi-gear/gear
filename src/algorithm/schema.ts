import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema =
  | { type: 'any'; enum?: JsonValue[] }
  | { type: 'null' | 'boolean' | 'number' | 'integer' | 'string'; enum?: JsonValue[] }
  | { type: 'array'; items: JsonSchema; enum?: JsonValue[] }
  | { type: 'object'; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema; enum?: JsonValue[] };

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function assertSafeKey(key: string): void {
  if (forbidden.has(key) || key.includes('\0') || !key.isWellFormed()) throw new Error(`Unsafe JSON key: ${key}`);
}

export function assertJson(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (!value.isWellFormed()) throw new Error(`${path}: unpaired surrogate`); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(`${path}: non-finite or unsafe number`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) throw new Error(`${path}[${i}]: sparse array`); assertJson(value[i], `${path}[${i}]`); }
    for (const key of Object.keys(value)) if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new Error(`${path}: array has non-index property`);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) { assertSafeKey(key); assertJson(item, `${path}.${key}`); }
    return;
  }
  throw new Error(`${path}: expected plain JSON`);
}

export function canonicalJson(value: unknown): string {
  assertJson(value);
  const render = (item: JsonValue): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(render).join(',')}]`;
    const keys = Object.keys(item).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map(key => `${JSON.stringify(key)}:${render(item[key]!)}`).join(',')}}`;
  };
  return render(value);
}

export function jsonDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

export function assertSchema(schema: JsonSchema): void {
  assertJson(schema);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid schema');
  const types = new Set(['any', 'null', 'boolean', 'number', 'integer', 'string', 'array', 'object']);
  if (!types.has(schema.type)) throw new Error('Unknown schema type');
  const allowed = schema.type === 'object'
    ? new Set(['type', 'enum', 'properties', 'required', 'additionalProperties'])
    : schema.type === 'array' ? new Set(['type', 'enum', 'items']) : new Set(['type', 'enum']);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new Error(`Unsupported schema keyword ${key}`);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error('schema enum must be nonempty');
  }
  if (schema.type === 'array') { if (!schema.items) throw new Error('Array schema requires items'); assertSchema(schema.items); }
  if (schema.type === 'object') {
    if (schema.properties !== undefined && (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties))) throw new Error('Invalid schema properties');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(key => typeof key === 'string'))) throw new Error('Invalid required list');
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && (typeof schema.additionalProperties !== 'object' || schema.additionalProperties === null)) throw new Error('Invalid additionalProperties');
    for (const [key, child] of Object.entries(schema.properties ?? {})) { assertSafeKey(key); assertSchema(child); }
    for (const key of schema.required ?? []) { assertSafeKey(key); if (!(key in (schema.properties ?? {}))) throw new Error(`Required property ${key} has no schema`); }
    if (typeof schema.additionalProperties === 'object') assertSchema(schema.additionalProperties);
  }
}

export function validateSchema(schema: JsonSchema, value: unknown, path = '$'): asserts value is JsonValue {
  assertSchema(schema);
  assertJson(value, path);
  if (schema.enum !== undefined && !schema.enum.some(item => canonicalJson(item) === canonicalJson(value))) throw new Error(`${path}: outside enum`);
  if (schema.type === 'any') return;
  if (schema.type === 'null') { if (value !== null) throw new Error(`${path}: expected null`); return; }
  if (schema.type === 'array') { if (!Array.isArray(value)) throw new Error(`${path}: expected array`); value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`)); return; }
  if (schema.type === 'object') {
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${path}: expected object`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      const child = schema.properties?.[key];
      if (child) validateSchema(child, item, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unexpected`);
      else if (typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties, item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== schema.type && !(schema.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))) throw new Error(`${path}: expected ${schema.type}`);
}
