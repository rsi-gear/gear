import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, opendir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { syncDirectory } from './atomic.js'

export const MAX_EXPERIENCE_BYTES = 12 * 1024 * 1024 // Historical v2 files only.
export const MAX_EXPERIENCE_INDEX_BYTES = 4 * 1024 * 1024
export const MAX_EXPERIENCE_DESCRIPTOR_BYTES = 2 * 1024 * 1024
export const MAX_EXPERIENCE_OBJECT_BYTES = 256 * 1024
export const MAX_EXPERIENCE_FILES = 100_000
export const MAX_EXPERIENCE_ITEM_BYTES = 63 * 1024 - 2048
export const validExperienceDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)

/** Paths are derived from digests; both the store and its sole child directory reject links. */
export class ExperienceFiles {
  constructor(readonly root: string) {}
  path(digest: string, object = false): string {
    if (!validExperienceDigest(digest))
      throw new GearError('invalid-experience-digest', 'Invalid experience digest')
    return join(this.root, ...(object ? ['objects'] : []), digest.slice(7) + '.json')
  }
  private async directory(path: string): Promise<string> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new GearError('experience-file-invalid', 'Experience directories must not be links')
    // Resolve the trusted caller's parent (including macOS /var), never a JSON-provided path.
    return (
      join(await realpath(dirname(path)), path.slice(dirname(path).length + 1)) + `:${info.dev}:${info.ino}`
    )
  }
  private async directories(object: boolean): Promise<string[]> {
    const paths = [await this.directory(this.root)]
    if (object) paths.push(await this.directory(join(this.root, 'objects')))
    return paths
  }
  async read(digest: string, maximum: number, object = false): Promise<unknown> {
    return this.readBounded(digest, maximum, object, 1)
  }
  private async readBounded(
    digest: string,
    maximum: number,
    object: boolean,
    links: number,
  ): Promise<unknown> {
    const parents = await this.directories(object)
    const file = await open(
      this.path(digest, object),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== links || info.size > maximum)
        throw new GearError('experience-file-invalid', 'Experience must be a bounded regular file')
      const bytes = Buffer.alloc(info.size + 1)
      let count = 0
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, count)
        if (!bytesRead) break
        count += bytesRead
      }
      const after = await file.stat()
      if (
        count !== info.size ||
        after.size !== info.size ||
        after.nlink !== links ||
        JSON.stringify(await this.directories(object)) !== JSON.stringify(parents)
      )
        throw new GearError('experience-file-invalid', 'Experience changed during its bounded read')
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)),
      ) as { version?: unknown }
      if (!object && value.version === 3 && info.size > MAX_EXPERIENCE_INDEX_BYTES)
        throw new GearError('experience-size-limit', 'Experience index exceeds 4 MiB')
      return value
    } finally {
      await file.close()
    }
  }
  /** Recover only the link-before-unlink crash window of our immutable publication protocol. */
  private async recoverPublication(
    value: { digest: string },
    maximum: number,
    object: boolean,
  ): Promise<void> {
    const path = this.path(value.digest, object)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink === 1) return
    const prefix = value.digest.slice(7) + '.json.'
    const ownLinks: string[] = []
    let inspected = 0
    for await (const entry of await opendir(dirname(path))) {
      if (++inspected > MAX_EXPERIENCE_FILES)
        throw new GearError(
          'experience-file-invalid',
          'Experience publication recovery exceeds its file bound',
        )
      if (
        !entry.name.startsWith(prefix) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u.test(
          entry.name.slice(prefix.length),
        )
      )
        continue
      const temporary = join(dirname(path), entry.name),
        sibling = await lstat(temporary)
      if (
        sibling.isFile() &&
        !sibling.isSymbolicLink() &&
        sibling.dev === info.dev &&
        sibling.ino === info.ino
      )
        ownLinks.push(temporary)
    }
    if (!ownLinks.length || info.nlink !== ownLinks.length + 1)
      throw new GearError(
        'experience-file-invalid',
        'Experience hardlinks are not owned publication temporaries',
      )
    if (
      canonicalDigest(await this.readBounded(value.digest, maximum, object, info.nlink)) !==
      canonicalDigest(value)
    )
      throw new GearError(
        'experience-identity-mismatch',
        'Interrupted immutable experience publication conflicts',
      )
    for (const temporary of ownLinks) {
      const sibling = await lstat(temporary)
      if (!sibling.isFile() || sibling.dev !== info.dev || sibling.ino !== info.ino)
        throw new GearError('experience-file-invalid', 'Experience publication temporary changed')
      await rm(temporary, { force: true })
    }
    await syncDirectory(dirname(path))
  }
  async publish(value: { digest: string }, maximum: number, object = false): Promise<void> {
    const bytes = JSON.stringify(value)
    if (Buffer.byteLength(bytes) > maximum)
      throw new GearError('experience-size-limit', 'Experience index, descriptor or item exceeds its bound')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.directories(false)
    if (object) await mkdir(join(this.root, 'objects'), { recursive: true, mode: 0o700 })
    await this.directories(object)
    const existing = async () => {
      // Another idempotent publisher can finish or clean up its owned link while we inspect it.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.recoverPublication(value, maximum, object)
          if (canonicalDigest(await this.read(value.digest, maximum, object)) !== canonicalDigest(value))
            throw new GearError('experience-identity-mismatch', 'Immutable experience object conflicts')
          return
        } catch (error) {
          if (
            attempt >= 7 ||
            (!(error instanceof GearError && error.code === 'experience-file-invalid') &&
              (error as NodeJS.ErrnoException).code !== 'ENOENT')
          )
            throw error
          // An absent final file is the normal admission path, not a publication race.
          try {
            await lstat(this.path(value.digest, object))
          } catch {
            throw error
          }
        }
      }
    }
    try {
      await existing()
      await syncDirectory(dirname(this.path(value.digest, object)))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const path = this.path(value.digest, object),
      temporary = path + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await link(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      // Remove our temporary hardlink before enforcing nlink=1 on the published object.
      await rm(temporary, { force: true })
      await existing()
      await syncDirectory(dirname(path))
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
