import type { JsonValue } from '@deepseek-ai/dsh-session'

export const PUBLIC_SENSITIVE_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/iu

function sanitizeKey(name: string, heldOutRef: string | undefined, secretValues: readonly string[]): string {
  let result = name
  for (const secret of secretValues) result = result.split(secret).join('[REDACTED]')
  if (heldOutRef !== undefined && heldOutRef.length > 0) {
    result = result.split(heldOutRef).join('[REDACTED_HELD_OUT]')
  }
  return result
}

export function sanitizePublicValue(
  value: unknown,
  heldOutRef: string | undefined,
  secretValues: readonly string[],
  key?: string,
): JsonValue {
  if (key !== undefined && PUBLIC_SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    let text = value
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { text = JSON.stringify(sanitizePublicValue(JSON.parse(text), heldOutRef, secretValues), null, 2) }
      catch { /* Ordinary text that merely starts like JSON. */ }
    }
    for (const secret of secretValues) text = text.split(secret).join('[REDACTED]')
    if (heldOutRef !== undefined && heldOutRef.length > 0) {
      text = text.split(heldOutRef).join('[REDACTED_HELD_OUT]')
    }
    return text
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => sanitizePublicValue(item, heldOutRef, secretValues))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      sanitizeKey(name, heldOutRef, secretValues),
      sanitizePublicValue(item, heldOutRef, secretValues, name),
    ])) as JsonValue
  }
  return String(value)
}
