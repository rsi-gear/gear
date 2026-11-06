import { createHash } from 'node:crypto'

/** Gear canonical v1: typed UTF-8, codepoint-sorted keys, IEEE-754 binary64 numbers. */
export function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('canonical strings must be valid Unicode')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new TypeError('canonical numbers must be finite and integers must be safe')
    const bytes = Buffer.alloc(8)
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value)
    return `n${bytes.toString('hex')}`
  }
  if (Array.isArray(value)) {
    if (
      Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))
    )
      throw new TypeError('canonical arrays cannot contain holes')
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    return `{${keys.map((key) => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new TypeError('value is not canonical JSON')
}
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`gear-canonical-v1\n${canonical(value)}`)
    .digest('hex')}`
}
