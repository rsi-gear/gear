import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { publishFile } from './atomic.js'

/** Only fully verified observations are reused. Their source bindings are part of the key. */
export class ModificationUseStore {
  constructor(readonly root: string) {}
  path(key: string) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(key))
      throw new GearError('invalid-observation-key', 'Invalid observation key')
    return join(this.root, key.slice(7) + '.json')
  }
  async read(key: string): Promise<Json | null> {
    const file = await open(
      this.path(key),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!file) return null
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)
        throw new GearError('modification-observation-invalid', 'Invalid observation cache file')
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== stat.size || length > 8 * 1024 * 1024)
        throw new GearError('modification-observation-changed', 'Verified modification observations changed')
      const { digest, ...body } = JSON.parse(bytes.subarray(0, length).toString('utf8')) as {
        key: string
        value: Json
        digest: string
      }
      if (body.key !== key || canonicalDigest(body) !== digest)
        throw new GearError('modification-observation-changed', 'Verified modification observations changed')
      return body.value
    } finally {
      await file.close()
    }
  }
  async save(key: string, value: Json): Promise<void> {
    const body = { key, value },
      bytes = JSON.stringify({ ...body, digest: canonicalDigest(body) })
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) return
    await publishFile(this.path(key), bytes, { immutable: true })
  }
}
