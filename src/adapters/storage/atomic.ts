import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** macOS/Linux: publish only fsynced bytes, then fsync the containing directory. */
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function publishFile(
  path: string,
  bytes: string | Uint8Array,
  options: { immutable?: boolean; beforePublish?: () => Promise<void> } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await options.beforePublish?.()
    if (options.immutable) {
      try {
        await link(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes)))
          throw new Error(`immutable object conflict: ${path}`)
      }
    } else await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}
