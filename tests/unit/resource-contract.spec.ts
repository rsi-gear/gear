import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonical, identity, parseResourceLock, parseStrictJson, parseTree } from '../../src/state/resource-protocol.js'
import { parseResourceDataset, parseResourceSelection, selectResources } from '../../src/state/resource-contract.js'
import { auditStorage } from '../../src/state/storage.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { SearchStore } from '../../src/search/store.js'
import { seal } from '../../src/search/contracts.js'
import { releaseUnusedResourceRetention } from '../../src/state/resource-retention.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('public Hitch resource contract', () => {
  it('matches the shared canonical identities without Hitch runtime imports', async () => {
    const fixture = JSON.parse(await readFile('test-contracts/hitch-resources-v1.json', 'utf8'))
    const lock = parseResourceLock(fixture.lock)
    expect(canonical(lock)).toBe(fixture.lockCanonical)
    expect(identity(lock.protocol, lock)).toBe(fixture.lockIdentity)
    const dataset = parseResourceDataset(fixture.dataset)
    expect(selectResources(dataset, ['case-1'])).toEqual(parseResourceSelection(fixture.selection))
    expect(parseTree(fixture.tree)).toEqual(fixture.tree)
    expect(() => parseStrictJson('{"x":1,"x":2}')).toThrow(/duplicate/)
    expect(() => parseResourceDataset({ ...fixture.dataset, other: true })).toThrow(/unknown/)
    expect(() => parseResourceSelection({ ...fixture.selection, tasks: [] })).toThrow(/digest/)
  })
  it('does not publish a frozen pointer when cancellation occurs after immutable object storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-freeze-resource-')); roots.push(root)
    const store = new SearchStore(root), controller = new AbortController()
    await expect(store.freezeEvolution('input', () => seal({ data: true }), async () => { controller.abort(); controller.signal.throwIfAborted() })).rejects.toBeDefined()
    expect(await store.read('evolution/input')).toBeUndefined()
  })
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
    const store = new SearchStore(join(root, 'search')), receipt = { protocol: 'gear-resource-retention@1', state: 'active', owner: 'gear:example', generation: 3, sourceRef: '/source/example', inputDigest: 'input', planDigest: 'plan', tasks: ['a', 'b'] }
    await store.write('resource-retention/seed', receipt)
    await writeFile(join(root, 'history.json'), JSON.stringify({ state: 'failed', original: receipt.sourceRef }))
    const released: unknown[] = []
    await expect(releaseUnusedResourceRetention(root, 'seed', async item => { released.push(item) })).rejects.toThrow(/history/)
    expect(released).toEqual([])
    await writeFile(join(root, 'history.json'), '{}')
    await expect(releaseUnusedResourceRetention(root, 'seed', async item => { if (item.owner.endsWith(':b')) throw Error('disconnected'); released.push(item) })).rejects.toThrow('disconnected')
    expect(await store.read('resource-retention/seed')).toMatchObject({ state: 'releasing' })
    await releaseUnusedResourceRetention(root, 'seed', async item => { released.push(item) })
    expect(released).toEqual([{ owner: 'gear:example:a', generation: 3 }, { owner: 'gear:example:a', generation: 3 }, { owner: 'gear:example:b', generation: 3 }])
    expect(await store.read('resource-retention/seed')).toMatchObject({ state: 'released' })
  })
  it('does not release an owner when immutable history is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-resource-release-missing-')); roots.push(root)
    await new SearchStore(join(root, 'search')).write('resource-retention/seed', { protocol: 'gear-resource-retention@1', state: 'active', owner: 'gear:example', generation: 1, sourceRef: '/source', inputDigest: 'input', planDigest: 'plan', tasks: [] })
    await writeFile(join(root, 'history.json'), JSON.stringify({ ref: `sha256:${'a'.repeat(64)}` }))
    await expect(releaseUnusedResourceRetention(root, 'seed', async () => { throw Error('must not release') })).rejects.toThrow(/missing immutable/)
  })
})
