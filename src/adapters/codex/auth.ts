import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { GearError } from '../../domain/errors.js'

/** Read the same bounded, standalone credential file for execution and local diagnostics. */
export async function codexAuthFile(authHome: string): Promise<Buffer> {
  const file = await open(join(authHome, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw new GearError('codex-auth-invalid', 'Codex auth.json must be a bounded regular file')
    const bytes = await file.readFile()
    if (bytes.length > 1024 * 1024) throw new GearError('codex-auth-invalid', 'Codex auth.json is too large')
    return bytes
  } finally {
    await file.close()
  }
}
