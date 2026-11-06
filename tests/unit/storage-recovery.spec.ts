import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { auditStorage } from '../../src/state/storage.js'
import { readProjectionQuarantine } from '../../src/state/projection-quarantine.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
beforeEach(() => { vi.mocked(fs.rename).mockReset().mockImplementation(native.rename) })
afterEach(async () => { for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gear-storage-recovery-')); roots.push(root)
  const search = join(root, 'search'), key = 'a'.repeat(64), ref = join(search, 'datasets', key)
  const report = join(search, 'materializations', `${key}.json`), quarantine = join(search, 'storage-quarantine', key)
  await fs.mkdir(ref, { recursive: true })
  await fs.writeFile(join(ref, 'content'), 'retained dataset')
  const digest = await digestDatasetRef(ref)
  await fs.mkdir(join(search, 'materializations'), { recursive: true })
  await fs.writeFile(report, JSON.stringify({ kind: 'gear-materialization', ref, digest, report: { copiedLogicalBytes: 16 } }))
  return { root, search, key, ref, report, quarantine, digest }
}
const interrupted = () => Object.assign(new Error('injected interruption'), { code: 'EIO' })

describe('retained storage quarantine recovery', () => {
  it('keeps data without ownership proof outside automatic cleanup', async () => {
    const f = await fixture()
    await fs.rm(f.report)
    expect((await auditStorage(f.root, { apply: true })).retained).toContainEqual({ ref: f.ref, reason: 'legacy projection without ownership proof' })
    expect(await digestDatasetRef(f.ref)).toBe(f.digest)
  })

  it.each(['before', 'after'])('reconciles interruption %s quarantine rename without losing data', async boundary => {
    const f = await fixture()
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (args[0] !== f.ref) return native.rename(...args)
      if (boundary === 'after') await native.rename(...args)
      throw interrupted()
    })
    await expect(auditStorage(f.root, { apply: true })).rejects.toThrow('injected interruption')
    vi.mocked(fs.rename).mockImplementation(native.rename)
    expect(await readProjectionQuarantine(f.search, f.key)).toMatchObject({ digest: f.digest, location: boundary === 'before' ? 'canonical' : 'quarantine' })
    const result = await auditStorage(f.root, { apply: true, graceMs: 0 })
    if (boundary === 'before') {
      expect(result.quarantined).toEqual([f.ref])
      expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).deleted).toEqual([f.ref])
    } else expect(result.deleted).toEqual([f.ref])
  })

  async function restoredTree() {
    const f = await fixture()
    await auditStorage(f.root, { apply: true })
    // Persisted crash state: restoration renamed the tree but left its journal.
    await fs.rename(join(f.quarantine, 'tree'), f.ref)
    return f
  }

  it.each([false, true])('reconciles a restored tree with history reference: %s', async referenced => {
    const f = await restoredTree()
    if (referenced) await fs.writeFile(join(f.root, 'history.json'), JSON.stringify({ dataset: f.ref }))
    const result = await auditStorage(f.root, { apply: true, graceMs: 0 })
    if (referenced) {
      expect(result.retained).toContainEqual({ ref: f.ref, reason: 'durable history reference' })
      expect(await digestDatasetRef(f.ref)).toBe(f.digest)
      await expect(fs.lstat(f.quarantine)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(result.quarantined).toEqual([f.ref])
      expect((await auditStorage(f.root, { apply: true, graceMs: 0 })).deleted).toEqual([f.ref])
    }
  })

  it.each(['changed canonical', 'both trees', 'missing tree', 'wrong ref', 'unknown file'])('preserves ambiguous recovery state: %s', async variant => {
    const f = await restoredTree()
    if (variant === 'changed canonical') await fs.writeFile(join(f.ref, 'content'), 'tampered')
    if (variant === 'both trees') await fs.cp(f.ref, join(f.quarantine, 'tree'), { recursive: true })
    if (variant === 'missing tree') await fs.rm(f.ref, { recursive: true })
    if (variant === 'wrong ref') {
      const record = JSON.parse(await fs.readFile(join(f.quarantine, 'record.json'), 'utf8'))
      await fs.writeFile(join(f.quarantine, 'record.json'), JSON.stringify({ ...record, ref: `${f.ref}-other` }))
    }
    if (variant === 'unknown file') await fs.writeFile(join(f.quarantine, 'unowned'), 'preserve')
    const before = await digestDatasetRef(f.quarantine)
    await expect(readProjectionQuarantine(f.search, f.key)).rejects.toThrow()
    await expect(auditStorage(f.root, { apply: true, graceMs: 0 })).rejects.toThrow()
    expect(await digestDatasetRef(f.quarantine)).toBe(before)
  })

  it('tolerates an empty quarantine directory after journal removal', async () => {
    const f = await restoredTree()
    await fs.rm(join(f.quarantine, 'record.json'))
    expect(await readProjectionQuarantine(f.search, f.key)).toBeUndefined()
    expect((await auditStorage(f.root, { apply: true })).quarantined).toEqual([f.ref])
  })
})
