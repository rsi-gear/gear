import { expect, it } from 'vitest'
import { canonicalJson, type JsonValue } from '../../src/algorithm/schema.js'

function reference(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(reference).join(',')}]`
  const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return `{${keys.map(key => `${JSON.stringify(key)}:${reference(value[key]!)}`).join(',')}}`
}

it('keeps UTF-8 canonical key order across ASCII, BMP and astral keys', () => {
  const bmp = String.fromCodePoint(0xe000), astral = String.fromCodePoint(0x10000)
  const accented = String.fromCodePoint(0xe9)
  const values: JsonValue[] = [
    { z: 1, a: 2, '0': 3, '20': 4, '10': 5 },
    { [astral]: 1, [bmp]: 2, a: 3, [accented]: 4 },
    { nested: [{ [bmp]: { x: 1, [astral]: 2 } }, { b: 1, a: 2 }], empty: {} },
    Array.from({ length: 100 }, (_, index) => ({ z: index, a: index + 1, b: index + 2 })),
  ]
  for (const value of values) expect(canonicalJson(value)).toBe(reference(value))
  expect(canonicalJson({ [astral]: 1, [bmp]: 2 }))
    .toBe(`{${JSON.stringify(bmp)}:2,${JSON.stringify(astral)}:1}`)
})
