import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { digestDatasetRef } from './dataset.js'

export interface ProjectionQuarantine {
  ref: string
  directory: string
  tree: string
  digest: string
  at: number
  location: 'canonical' | 'quarantine'
}

const statIfPresent = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return undefined
})

/** Inspect under the workspace lock. A journal can outlive either direction of
 * rename; only one matching tree proves which transition needs finishing. */
export async function readProjectionQuarantine(searchRoot: string, key: string): Promise<ProjectionQuarantine | undefined> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('unknown storage quarantine entry')
  const directory = join(searchRoot, 'storage-quarantine', key), info = await statIfPresent(directory)
  if (!info) return undefined
  if (!info.isDirectory()) throw new Error('unsafe storage quarantine directory')
  const names = await readdir(directory)
  // Metadata removal can stop between unlinking record.json and removing its
  // empty directory. There is no tree or ownership claim left to reconcile.
  if (!names.length) return undefined
  const file = join(directory, 'record.json'), tree = join(directory, 'tree'), ref = join(searchRoot, 'datasets', key)
  if (names.some(name => name !== 'record.json' && name !== 'tree') || !(await statIfPresent(file))?.isFile()) throw new Error('invalid storage quarantine record')
  const record = JSON.parse(await readFile(file, 'utf8'))
  if (record?.protocol !== 'gear-storage-quarantine@1' || record.ref !== ref || !Number.isSafeInteger(record.at) || record.at < 0
    || typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.digest)) throw new Error('invalid storage quarantine identity')
  const canonical = await statIfPresent(ref), isolated = await statIfPresent(tree)
  if (Boolean(canonical) === Boolean(isolated) || (canonical ?? isolated)?.isDirectory() !== true) throw new Error('ambiguous storage quarantine trees')
  if (await digestDatasetRef(isolated ? tree : ref) !== record.digest) throw new Error('storage quarantine integrity mismatch')
  return { ref, directory, tree, digest: record.digest, at: record.at, location: isolated ? 'quarantine' : 'canonical' }
}
