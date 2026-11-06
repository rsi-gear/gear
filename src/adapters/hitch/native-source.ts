import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** Pin the native file manifest at receipt capture, independently of the canonical page. */
export async function nativeManifestDigest(root: string, runId: string): Promise<string | null> {
  if (!/^run_[a-f0-9]{32}$/u.test(runId)) return null
  try {
    const base = await realpath(root)
    for (const path of [join(base, 'runs'), join(base, 'runs', runId)]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return null
    }
    const path = join(base, 'runs', runId, 'trajectory.ref.json')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) return null
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      const bytes = buffer.subarray(0, length)
      const after = await handle.stat(),
        current = await lstat(path)
      const identity = (stat: typeof before) =>
        [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
      if (
        bytes.length !== before.size ||
        identity(before) !== identity(after) ||
        identity(before) !== identity(current)
      )
        return null
      return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
