import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditStorage } from '../../src/state/storage.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { releaseUnusedResourceRetention } from '../../src/state/resource-retention.js'

async function writeReceipt(root: string, receipt: unknown) {
  await mkdir(join(root, 'search/resource-retention'), { recursive: true })
  await writeFile(join(root, 'search/resource-retention/seed.json'), JSON.stringify(receipt))
}

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('retained resource lifecycle', () => {
  it('retains historical absolute refs in any state and quarantines only verified owned orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-storage-audit-')); roots.push(root)
    const search = join(root, 'search'), key = 'a'.repeat(64), ref = join(search, 'datasets', key)
    await mkdir(ref, { recursive: true }); await writeFile(join(ref, 'content'), 'immutable')
    await mkdir(join(search, 'materializations'), { recursive: true })
    await writeFile(join(search, 'materializations', `${key}.json`), JSON.stringify({ kind: 'gear-materialization', ref, digest: await digestDatasetRef(ref), report: { copiedLogicalBytes: 9 } }))
    await writeFile(join(root, 'history.json'), JSON.stringify({ status: 'unknown', request: { dataset: ref } }))
    expect((await auditStorage(root, { apply: true, graceMs: 0 })).retained).toContainEqual({ ref, reason: 'durable history reference' })
    await writeFile(join(root, 'history.json'), '{}')
    expect((await auditStorage(root)).eligible).toEqual([ref])
    expect((await auditStorage(root, { apply: true, graceMs: 0 })).quarantined).toEqual([ref])
    expect((await auditStorage(root, { apply: true, graceMs: 0 })).deleted).toEqual([ref])
  })
  it('fails closed when a history record cannot be parsed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-bad-history-')); roots.push(root)
    await writeFile(join(root, 'history.json'), '{bad')
    await expect(auditStorage(root, { apply: true })).rejects.toThrow()
  })
  it('retains all historical resource owners and retries explicit release with the same generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-resource-release-')); roots.push(root)
    const receipt = { protocol: 'gear-resource-retention@1', state: 'active', owner: 'gear:example', generation: 3, sourceRef: '/source/example', inputDigest: 'input', planDigest: 'plan', tasks: ['a', 'b'] }
    await writeReceipt(root, receipt)
    await writeFile(join(root, 'history.json'), JSON.stringify({ state: 'failed', original: receipt.sourceRef }))
    const released: unknown[] = []
    await expect(releaseUnusedResourceRetention(root, 'seed', async item => { released.push(item) })).rejects.toThrow(/history/)
    expect(released).toEqual([])
    await writeFile(join(root, 'history.json'), '{}')
    await expect(releaseUnusedResourceRetention(root, 'seed', async item => { if (item.owner.endsWith(':b')) throw Error('disconnected'); released.push(item) })).rejects.toThrow('disconnected')
    expect(JSON.parse(await readFile(join(root, 'search/resource-retention/seed.json'), 'utf8'))).toMatchObject({ state: 'releasing' })
    await releaseUnusedResourceRetention(root, 'seed', async item => { released.push(item) })
    expect(released).toEqual([{ owner: 'gear:example:a', generation: 3 }, { owner: 'gear:example:a', generation: 3 }, { owner: 'gear:example:b', generation: 3 }])
    expect(JSON.parse(await readFile(join(root, 'search/resource-retention/seed.json'), 'utf8'))).toMatchObject({ state: 'released' })
  })
  it('does not release an owner when immutable history is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-resource-release-missing-')); roots.push(root)
    await writeReceipt(root, { protocol: 'gear-resource-retention@1', state: 'active', owner: 'gear:example', generation: 1, sourceRef: '/source', inputDigest: 'input', planDigest: 'plan', tasks: [] })
    await writeFile(join(root, 'history.json'), JSON.stringify({ ref: `sha256:${'a'.repeat(64)}` }))
    await expect(releaseUnusedResourceRetention(root, 'seed', async () => { throw Error('must not release') })).rejects.toThrow(/missing immutable/)
  })
})
