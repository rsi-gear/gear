import { createHash } from 'node:crypto'

/** Training v1 canonical JSON: UTF-8, ASCII-sorted keys, ECMAScript numbers.
 * Kept separate from the legacy locale-sorted Harness evolution identity.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => {
      if (!/^[\x20-\x7e]*$/.test(k)) throw new TypeError('training manifest keys must be ASCII')
      return `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`
    }).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('training manifest numbers must be finite')
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('training manifest must be JSON')
  return JSON.stringify(value)
}
export function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}
