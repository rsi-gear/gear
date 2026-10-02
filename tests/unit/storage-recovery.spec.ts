import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeDataset, projectDataset } from '../../src/search/dataset-projection.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { digestJson } from '../../src/state/digest.js'
import { auditStorage } from '../../src/state/storage.js'
import { RefineStateStore } from '../../src/state/store.js'
import { standardSearchDataset } from '../helpers/standard-search-dataset.js'
import { evolutionSpec } from '../helpers/research-fixture.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
beforeEach(() => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(native.writeFile)
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
  vi.mocked(fs.rm).mockReset().mockImplementation(native.rm)
})
afterEach(async () => { for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'gear-storage-recovery-')); roots.push(workspace)
  const root = join(workspace, 'state'), search = join(root, 'search')
  const dataset = await standardSearchDataset(workspace, 2), spec = evolutionSpec()
  spec.datasets = { seed: dataset, heldOut: dataset }
  const description = await describeDataset(spec, 'seed', workspace)
  const key = digestJson({ source: description.sourceDigest, ids: ['task-0'] }).slice(7)
  const ref = join(search, 'datasets', key), report = join(search, 'materializations', `${key}.json`)
  const quarantine = join(search, 'storage-quarantine', key)
  const project = async () => {
    const lock = await new RefineStateStore(root).acquireRoundLock()
    try { return await projectDataset(description, ['task-0'], search, { lock, signal: new AbortController().signal, policy: { mode: 'copy' } }) }
    finally { await lock.release() }
  }
  return { root, search, ref, report, quarantine, project }
}
const interrupted = () => Object.assign(new Error('injected interruption'), { code: 'EIO' })
const absent = async (path: string) => expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })

describe('projection publication and quarantine recovery', () => {
  it.each(['report write', 'report rename'])('never publishes an unowned projection after %s failure', async boundary => {
    const f = await fixture()
    if (boundary === 'report write') vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (dirname(String(args[0])) === dirname(f.report) && String(args[0]).endsWith('.tmp')) throw interrupted()
      return native.writeFile(...args)
    })
    else vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (args[1] === f.report) throw interrupted()
      return native.rename(...args)
    })
    await expect(f.project()).rejects.toThrow('injected interruption')
    await absent(f.ref)
    vi.mocked(fs.writeFile).mockImplementation(native.writeFile); vi.mocked(fs.rename).mockImplementation(native.rename)
    const prepared = await f.project()
    expect(JSON.parse(await fs.readFile(f.report, 'utf8'))).toMatchObject({ ref: f.ref, digest: prepared.digest, report: { copiedFiles: 2 } })
    expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).quarantined).toEqual([f.ref])
    expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).deleted).toEqual([f.ref])
  })

  it.each(['before', 'after'])('recovers an interruption %s canonical rename with ownership intact', async boundary => {
    const f = await fixture()
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (args[1] !== f.ref) return native.rename(...args)
      if (boundary === 'after') await native.rename(...args)
      throw interrupted()
    })
    await expect(f.project()).rejects.toThrow('injected interruption')
    if (boundary === 'after') expect(JSON.parse(await fs.readFile(f.report, 'utf8')).digest).toBe(await digestDatasetRef(f.ref))
    else await absent(f.ref)
    vi.mocked(fs.rename).mockImplementation(native.rename)
    const prepared = await f.project()
    expect((await auditStorage(f.root)).eligible).toEqual([f.ref])
    expect(JSON.parse(await fs.readFile(f.report, 'utf8')).digest).toBe(prepared.digest)
  })

  it('keeps pre-existing projections without ownership proof outside automatic cleanup', async () => {
    const f = await fixture(), prepared = await f.project()
    await fs.rm(f.report)
    expect(await f.project()).toEqual(prepared)
    await absent(f.report)
    expect((await auditStorage(f.root, { apply: true })).retained).toContainEqual({ ref: f.ref, reason: 'legacy projection without ownership proof' })
    expect(await digestDatasetRef(f.ref)).toBe(prepared.digest)
  })

  async function interruptedRestore(f: Awaited<ReturnType<typeof fixture>>) {
    const prepared = await f.project()
    await auditStorage(f.root, { apply: true })
    vi.mocked(fs.rm).mockImplementation(async (...args) => {
      if (args[0] === f.quarantine) throw interrupted()
      return native.rm(...args)
    })
    await expect(f.project()).rejects.toThrow('injected interruption')
    vi.mocked(fs.rm).mockImplementation(native.rm)
    expect(await digestDatasetRef(f.ref)).toBe(prepared.digest)
    await absent(join(f.quarantine, 'tree'))
    return prepared
  }

  it('finishes interrupted restoration on projection reuse without copying or changing identity', async () => {
    const f = await fixture(), prepared = await interruptedRestore(f)
    const inode = (await fs.stat(join(f.ref, 'task-0/instruction.md'))).ino
    expect(await f.project()).toEqual(prepared)
    expect((await fs.stat(join(f.ref, 'task-0/instruction.md'))).ino).toBe(inode)
    await absent(f.quarantine)
    expect(await f.project()).toEqual(prepared)
    expect((await auditStorage(f.root)).eligible).toEqual([f.ref])
  })

  it.each([false, true])('audit reconciles interrupted restoration, with history reference: %s', async referenced => {
    const f = await fixture(), prepared = await interruptedRestore(f)
    if (referenced) await fs.writeFile(join(f.root, 'history.json'), JSON.stringify({ dataset: f.ref }))
    const record = await fs.readFile(join(f.quarantine, 'record.json'))
    await auditStorage(f.root)
    expect(await fs.readFile(join(f.quarantine, 'record.json'))).toEqual(record)
    const result = await auditStorage(f.root, { apply: true, graceMs: 0 })
    if (referenced) {
      expect(result.retained).toContainEqual({ ref: f.ref, reason: 'durable history reference' })
      expect(await digestDatasetRef(f.ref)).toBe(prepared.digest)
      await absent(f.quarantine)
    } else {
      expect(result.quarantined).toEqual([f.ref])
      expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).deleted).toEqual([f.ref])
    }
  })

  it('retries quarantine admission interrupted after journaling but before moving the tree', async () => {
    const f = await fixture(); await f.project()
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (args[0] === f.ref) throw interrupted()
      return native.rename(...args)
    })
    await expect(auditStorage(f.root, { apply: true })).rejects.toThrow('injected interruption')
    vi.mocked(fs.rename).mockImplementation(native.rename)
    expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).quarantined).toEqual([f.ref])
    expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).deleted).toEqual([f.ref])
  })

  it.each(['changed canonical', 'both trees', 'missing tree', 'wrong ref', 'unknown file'])('preserves ambiguous recovery state: %s', async variant => {
    const f = await fixture(); await interruptedRestore(f)
    if (variant === 'changed canonical') await fs.writeFile(join(f.ref, 'task-0/instruction.md'), 'tampered')
    if (variant === 'both trees') await fs.cp(f.ref, join(f.quarantine, 'tree'), { recursive: true })
    if (variant === 'missing tree') await fs.rm(f.ref, { recursive: true })
    if (variant === 'wrong ref') {
      const record = JSON.parse(await fs.readFile(join(f.quarantine, 'record.json'), 'utf8'))
      await fs.writeFile(join(f.quarantine, 'record.json'), JSON.stringify({ ...record, ref: `${f.ref}-other` }))
    }
    if (variant === 'unknown file') await fs.writeFile(join(f.quarantine, 'unowned'), 'preserve')
    const before = await digestDatasetRef(f.quarantine)
    await expect(f.project()).rejects.toThrow()
    await expect(auditStorage(f.root, { apply: true, graceMs: 0 })).rejects.toThrow()
    expect(await digestDatasetRef(f.quarantine)).toBe(before)
  })

  it('tolerates an empty quarantine directory left after removing its restored record', async () => {
    const f = await fixture(), prepared = await interruptedRestore(f)
    await fs.rm(join(f.quarantine, 'record.json'))
    expect(await f.project()).toEqual(prepared)
    expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).quarantined).toEqual([f.ref])
    expect(await fs.readdir(join(f.search, 'storage-quarantine'))).toEqual([basename(f.ref)])
  })
})
