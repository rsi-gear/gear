import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { benchmarkLimits } from '../python/benchmark-limits.js'

/** Native datasets have different limits and file semantics from editable Targets. */
export async function datasetDigest(root: string): Promise<string> {
  const limits = benchmarkLimits()
  const files: Array<{ path: string; digest: string; executable: boolean; size: number }> = []
  const directories: string[] = []
  let bytes = 0
  const visit = async (relative: string): Promise<void> => {
    const path = join(root, relative),
      info = await lstat(path)
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
      throw new GearError('hitch-dataset-link', 'Frozen datasets cannot contain links')
    if (info.isDirectory()) {
      if (relative) directories.push(relative)
      if (directories.length > limits.maxDirectories)
        throw new GearError('hitch-dataset-limit', 'Dataset has too many directories')
      for (const entry of (await readdir(path)).sort()) await visit(relative ? relative + '/' + entry : entry)
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > limits.maxMaterializedBytes || files.length >= limits.maxFiles)
        throw new GearError(
          'hitch-dataset-limit',
          'Frozen dataset exceeds maxMaterializedBytes or maxFiles in GEAR_BENCHMARK_LIMITS_JSON',
        )
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      files.push({
        path: relative,
        digest: 'sha256:' + hash.digest('hex'),
        executable: Boolean(info.mode & 0o111),
        size: info.size,
      })
    } else
      throw new GearError(
        'hitch-dataset-special-file',
        'Frozen datasets require regular files and directories',
      )
  }
  await visit('')
  return canonicalDigest({ files, directories: directories.sort() })
}
