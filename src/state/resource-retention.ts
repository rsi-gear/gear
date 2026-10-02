import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { digestJson } from './digest.js'
import { RefineStateStore } from './store.js'
import { SearchStore } from '../search/store.js'

/** Release is explicit and generation checked. Terminal status never implies disposal. */
export async function releaseUnusedResourceRetention(stateRoot: string, partition: 'seed' | 'held-out', release: (input: { owner: string; generation: number }) => Promise<void>): Promise<{ releasedOwners: string[] }> {
  stateRoot = resolve(stateRoot)
  const lock = await new RefineStateStore(stateRoot).acquireRoundLock(), store = new SearchStore(join(stateRoot, 'search'))
  try {
    const key = `resource-retention/${partition}`
    const receipt = await store.read<{ protocol: string; state: string; owner: string; generation: number; sourceRef: string; inputDigest: string; planDigest: string; tasks: string[] }>(key)
    if (!receipt || receipt.protocol !== 'gear-resource-retention@1' || !['active', 'releasing', 'released'].includes(receipt.state) || !receipt.owner.startsWith('gear:') || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || !Array.isArray(receipt.tasks) || receipt.tasks.some(t => typeof t !== 'string')) throw new Error('resource retention receipt is missing or invalid')
    const pointers = new Set<string>()
    const referenced = (value: unknown): boolean => {
      if (typeof value === 'string') return [receipt.sourceRef, receipt.inputDigest, receipt.planDigest].includes(value)
      if (Array.isArray(value)) return value.some(referenced)
      if (!value || typeof value !== 'object') return false
      for (const [key, item] of Object.entries(value)) if (key === 'ref' && typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item)) pointers.add(item)
      return Object.values(value).map(referenced).some(Boolean)
    }
    const ignored = new Set(['search/resource-retention', 'search/datasets', 'search/materializations', 'search/selections', 'search/storage-quarantine', 'locks'])
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      for (const name of await readdir(directory)) {
        const relative = prefix ? `${prefix}/${name}` : name; if (ignored.has(relative)) continue
        const file = join(directory, name), info = await lstat(file)
        if (info.isSymbolicLink()) throw new Error('unsafe history path; resources retained')
        if (info.isDirectory()) await visit(file, relative)
        else if (name.endsWith('.json')) {
          if (!info.isFile() || info.size > 64 * 1024 ** 2) throw new Error('invalid history record; resources retained')
          const value = JSON.parse(await readFile(file, 'utf8'))
          if (dirname(file) === join(stateRoot, 'search/objects')) {
            const { digest, ...body } = value
            if (digest !== `sha256:${name.slice(0, -5)}` || digestJson(body) !== digest) throw new Error('corrupt immutable history; resources retained')
          }
          if (referenced(value)) throw new Error('durable Gear history still references these resources')
        }
      }
    }
    await visit(stateRoot)
    for (const pointer of pointers) if (!(await lstat(join(stateRoot, 'search/objects', `${pointer.slice(7)}.json`)).catch(() => undefined))?.isFile()) throw new Error('missing immutable history; resources retained')
    const beforePublish = async () => lock.assertHeld(stateRoot)
    await store.write(key, { ...receipt, state: 'releasing' }, beforePublish)
    const releasedOwners: string[] = []
    for (const task of receipt.tasks) { const owner = `${receipt.owner}:${task}`; await release({ owner, generation: receipt.generation }); releasedOwners.push(owner) }
    await store.write(key, { ...receipt, state: 'released' }, beforePublish)
    return { releasedOwners }
  } finally { await lock.release() }
}
