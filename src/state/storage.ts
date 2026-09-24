import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { digestDatasetRef } from './dataset.js'
import { removeOwnedTree } from './materialize-tree.js'
import { RefineStateStore } from './store.js'
import { digestJson } from './digest.js'
import { readProjectionQuarantine } from './projection-quarantine.js'

export interface StorageAudit {
  protocol: 'gear-storage-audit@1'; dryRun: boolean
  retained: Array<{ ref: string; reason: string }>; eligible: string[]; quarantined: string[]; deleted: string[]
  logicalBytes: number; reports: unknown[]
}
/** No age/PID inference, no history migration; only this explicit state root. */
export async function auditStorage(stateRoot: string, options: { apply?: boolean; graceMs?: number } = {}): Promise<StorageAudit> {
  stateRoot = resolve(stateRoot)
  const grace = options.graceMs ?? 24 * 60 * 60 * 1000
  if (!Number.isSafeInteger(grace) || grace < 0) throw new TypeError('invalid storage grace period')
  const lock = await new RefineStateStore(stateRoot).acquireRoundLock()
  try {
    const search = join(stateRoot, 'search'), datasets = join(search, 'datasets'), quarantine = join(search, 'storage-quarantine')
    const audit: StorageAudit = { protocol: 'gear-storage-audit@1', dryRun: !options.apply, retained: [], eligible: [], quarantined: [], deleted: [], logicalBytes: 0, reports: [] }
    const names = async (directory: string): Promise<string[]> => readdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return [] })
    const references = new Set<string>(), pointers = new Set<string>()
    const strings = (value: unknown): void => {
      if (typeof value === 'string') references.add(value)
      else if (Array.isArray(value)) value.forEach(strings)
      else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) { if (key === 'ref' && typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)) pointers.add(v); strings(v) }
      }
    }
    const visit = async (directory: string): Promise<void> => {
      if (!(await lstat(directory)).isDirectory()) throw new Error('unsafe storage history directory')
      for (const name of await names(directory)) {
        const file = join(directory, name)
        if ([datasets, join(search, 'materializations'), join(search, 'selections'), quarantine, join(stateRoot, 'locks')].includes(file)) continue
        const info = await lstat(file)
        if (info.isSymbolicLink()) throw new Error('storage history contains a symlink; cleanup stopped')
        if (info.isDirectory()) await visit(file)
        else if (name.endsWith('.json')) {
          if (!info.isFile() || info.size > 64 * 1024 ** 2) throw new Error('invalid storage history record')
          const value = JSON.parse(await readFile(file, 'utf8'))
          if (dirname(file) === join(search, 'objects')) {
            const { digest, ...body } = value
            if (digest !== `sha256:${name.slice(0, -5)}` || digestJson(body) !== digest) throw new Error('corrupt immutable history; cleanup stopped')
          }
          strings(value)
        }
      }
    }
    await visit(stateRoot)
    for (const pointer of pointers) if (!references.has(pointer) || !await lstat(join(search, 'objects', `${pointer.slice(7)}.json`)).catch(() => undefined)) throw new Error('missing immutable history; cleanup stopped')
    const referenced = (ref: string) => [...references].some(value => value === ref || value.startsWith(`${ref}/`))
    const owned: Array<{ ref: string; digest: string }> = [], isolated: Array<{ ref: string; directory: string; digest: string; at: number }> = []
    const reconciled: string[] = []
    for (const name of await names(datasets)) {
      const ref = join(datasets, name)
      if (!/^[a-f0-9]{64}$/.test(name)) { audit.retained.push({ ref, reason: 'unpublished or unknown owner; explicit end confirmation required' }); continue }
      const digest = await digestDatasetRef(ref)
      if (referenced(ref)) { audit.retained.push({ ref, reason: 'durable history reference' }); continue }
      const reportFile = join(search, 'materializations', `${name}.json`)
      const report = await readFile(reportFile, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return undefined })
      if (!report) { audit.retained.push({ ref, reason: 'legacy projection without ownership proof' }); continue }
      const record = JSON.parse(report)
      if (record.kind !== 'gear-materialization' || record.ref !== ref || record.digest !== digest) throw new Error('projection ownership/integrity mismatch; cleanup stopped')
      audit.reports.push(record.report); audit.logicalBytes += (record.report.copiedLogicalBytes ?? 0) + (record.report.clonedLogicalBytes ?? 0)
      owned.push({ ref, digest }); audit.eligible.push(ref)
    }
    // Validate all quarantine records before making any change.
    for (const name of await names(quarantine)) {
      const record = await readProjectionQuarantine(search, name)
      if (!record || record.location === 'canonical') { reconciled.push(join(quarantine, name)); continue }
      if (referenced(record.ref)) throw new Error('referenced storage quarantine; cleanup stopped')
      isolated.push(record)
    }
    if (!options.apply) return audit
    await lock.assertHeld(stateRoot)
    // A restored canonical can already have new history references. Finish only
    // its journal removal; the ordinary reference scan decides its retention.
    for (const directory of reconciled) await rm(directory, { recursive: true })
    for (const item of owned) {
      const directory = join(quarantine, item.ref.split('/').at(-1)!)
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'record.json'), JSON.stringify({ protocol: 'gear-storage-quarantine@1', ...item, at: Date.now() }), { flag: 'wx' })
      await rename(item.ref, join(directory, 'tree')); audit.quarantined.push(item.ref)
    }
    for (const item of isolated) if (Date.now() - item.at >= grace) { await removeOwnedTree(join(item.directory, 'tree')); await rm(item.directory, { recursive: true }); audit.deleted.push(item.ref) }
    return audit
  } finally { await lock.release() }
}
