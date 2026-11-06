import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { Json } from '../../domain/algorithm-wire.js'

const framework = fileURLToPath(new URL('../../../python/gear/', import.meta.url))
export async function freezeAlgorithmSource(
  destination: string,
  sources: Array<{ path: string; source: string }> = [],
  dependencies: Json[] = [],
): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const files: Array<{ path: string; digest: string }> = []
  let total = 0
  const put = async (path: string, bytes: Buffer): Promise<void> => {
    total += bytes.length
    if (files.length >= 1024 || total > 16 * 1024 * 1024)
      throw new GearError('algorithm-source-limit', 'Algorithm source exceeds 1024 files or 16 MiB')
    const target = join(destination, path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { flag: 'wx', mode: 0o400 })
    files.push({ path, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
  }
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue
      if (entry.isSymbolicLink())
        throw new GearError('algorithm-source-link', 'Algorithm source contains a symbolic link')
      const next = join(path, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile() && /\.(py|json)$/u.test(entry.name))
        await put(`gear/${relative(framework, next)}`, await readFile(next))
    }
  }
  // The worker never receives the project SDK, benchmark verifier or training implementation.
  await put('gear/__init__.py', Buffer.from('"""Frozen algorithm worker package."""\n'))
  await put('gear/canonical.py', await readFile(join(framework, 'canonical.py')))
  await walk(join(framework, 'algorithms'))
  await walk(join(framework, 'refine'))
  await put('dependencies.json', Buffer.from(JSON.stringify(dependencies)))
  for (const source of sources) {
    if (
      isAbsolute(source.path) ||
      !/^[a-zA-Z0-9_/-]+\.py$/u.test(source.path) ||
      source.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      ['gear', 'gear_training'].includes(source.path.split('/')[0]!.replace(/\.py$/u, ''))
    )
      throw new GearError('algorithm-source-path', 'Source cannot escape its package or replace Gear')
    const info = await lstat(resolve(source.source))
    if (!info.isFile() || info.isSymbolicLink())
      throw new GearError('algorithm-source-path', 'Source must be a regular file')
    await put(source.path, await readFile(source.source))
  }
  return canonicalDigest(files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))))
}
