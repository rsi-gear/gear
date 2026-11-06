import { gunzipSync } from 'node:zlib'

export function decodeOof(bytes) {
  const encoded = Buffer.from(bytes)
  if (encoded.length > 16 * 1024 ** 2) throw new Error('OOF artifact exceeds file limit')
  const decoded = encoded[0] === 0x1f && encoded[1] === 0x8b
    ? gunzipSync(encoded, { maxOutputLength: 64 * 1024 ** 2 }) : encoded
  return JSON.parse(decoded.toString('utf8'))
}
