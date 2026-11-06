import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { TrajectorySource } from '../../domain/trajectory.js'
import { publishFile } from './atomic.js'

/** Private source bindings; only an opaque digest is exposed in the experience snapshot. */
export class TrajectoryStore {
  constructor(readonly root: string) {}
  private path(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new GearError('invalid-trajectory-ref', 'Invalid trajectory reference')
    return join(this.root, digest.slice(7) + '.json')
  }
  async read(digest: string): Promise<TrajectorySource> {
    const file = await open(this.path(digest), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new GearError('trajectory-source-invalid', 'Invalid trajectory source file')
      const source = JSON.parse(await file.readFile('utf8')) as TrajectorySource
      const { digest: actual, ...body } = source
      if (
        source.version !== 1 ||
        source.partition !== 'seed' ||
        actual !== digest ||
        canonicalDigest(body) !== digest
      )
        throw new GearError('trajectory-source-changed', 'Frozen trajectory source changed')
      return source
    } finally {
      await file.close()
    }
  }
  async save(body: Omit<TrajectorySource, 'digest'>): Promise<TrajectorySource> {
    const source = { ...body, digest: canonicalDigest(body) }
    try {
      return await this.read(source.digest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const bytes = JSON.stringify(source)
    if (Buffer.byteLength(bytes) > 1024 * 1024)
      throw new GearError('trajectory-source-too-large', 'Trajectory source exceeds its fixed bound')
    await publishFile(this.path(source.digest), bytes, { immutable: true })
    return source
  }
}
