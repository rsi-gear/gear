import { describe, expect, it } from 'vitest'
import { sha256 } from '../../src/algorithm/artifacts.js'
import { JournalCampaignStore } from '../../src/algorithm/runtime/persistence.js'
import { canonicalJson } from '../../src/algorithm/schema.js'
import { SearchJournalBase } from '../../src/search/store.js'
import { MemorySearchStore } from '../../src/search/testing.js'

type RecordFixture = { format?: number; state?: unknown; patch?: Array<{ value?: unknown }> }
function recordValue(value: unknown): RecordFixture {
  return (typeof value === 'string' ? JSON.parse(value) : value) as RecordFixture
}

describe('journal-backed Campaign state deltas', () => {
  it('keeps immutable history compact and restores the exact latest state from a new journal', async () => {
    const journal = new MemorySearchStore()
    const store = new JournalCampaignStore(journal, 'round')
    const unchanged = Array.from({ length: 2_048 }, (_, index) => `task-${index}:${'x'.repeat(96)}`)
    const base = { phase: 'running', evidence: unchanged,
      nested: { counter: 0, markers: ['initial'], removable: 'old' } }
    await store.withWriter(async () => {
      await store.commit(base, 'decision.initialize')
      for (let counter = 1; counter <= 40; counter++) {
        await store.commit({ phase: 'running', evidence: unchanged,
          nested: { counter, markers: counter === 40 ? ['final'] : ['initial'],
            ...(counter < 40 ? { removable: 'old' } : {}) } }, 'operation.completed')
      }
    })
    const checkpoint = journal.checkpoint()
    const records = checkpoint.filter(([path]) => path.includes('/campaign/state/records/'))
    expect(records).toHaveLength(41)
    expect(recordValue(records[0]![1]).state).toEqual(base)
    expect(records.slice(1).every(([, record]) => recordValue(record).format === 2)).toBe(true)
    const bytes = records.reduce((sum, [, record]) => sum +
      (typeof record === 'string' ? record.length : canonicalJson(record).length), 0)
    expect(bytes).toBeLessThan(canonicalJson(base).length * 3)
    const recovered = new JournalCampaignStore(new MemorySearchStore(checkpoint), 'round')
    await recovered.hydrate()
    expect(recovered.load()).toEqual(store.load())
    expect(recovered.load()?.state).toEqual({ phase: 'running', evidence: unchanged,
      nested: { counter: 40, markers: ['final'] } })
  })

  it('rejects altered delta bytes and a missing historical link', async () => {
    const journal = new MemorySearchStore(), store = new JournalCampaignStore(journal, 'round')
    await store.withWriter(async () => {
      await store.commit({ nested: { a: 1, b: 2 }, list: [1] }, 'initialize')
      await store.commit({ nested: { a: 3, c: 4 }, list: [1, 2] }, 'update')
      await store.commit({ nested: { a: 5, c: 4 }, list: [1, 2] }, 'update')
    })
    const checkpoint = journal.checkpoint()
    const changed = structuredClone(checkpoint)
    const delta = changed.find(([, value]) => recordValue(value).format === 2)!
    const record = recordValue(delta[1])
    const patch = record.patch!
    patch.find(operation => Object.hasOwn(operation, 'value'))!.value = 'tampered'
    delta[1] = canonicalJson(record)
    await expect(new JournalCampaignStore(new MemorySearchStore(changed), 'round').hydrate())
      .rejects.toThrow('record drift')
    const missing = checkpoint.filter(([key]) => key !== delta[0])
    await expect(new JournalCampaignStore(new MemorySearchStore(missing), 'round').hydrate())
      .rejects.toThrow('record drift')
  })

  it('reads an old full-state chain and appends a verified delta without rewriting history', async () => {
    const journal = new MemorySearchStore(), prefix = 'rounds/round/campaign/state'
    const first = { seq: 0, previous: null, event: 'legacy.initialize', state: { value: 1 } }
    const firstDigest = sha256(canonicalJson(first))
    const second = { seq: 1, previous: firstDigest, event: 'legacy.update', state: { value: 2 } }
    const secondDigest = sha256(canonicalJson(second))
    await journal.write(`${prefix}/records/${firstDigest}`, first)
    await journal.write(`${prefix}/records/${secondDigest}`, second)
    await journal.write(`${prefix}/head`, { seq: 1, digest: secondDigest })
    const before = journal.checkpoint()
    const store = new JournalCampaignStore(journal, 'round')
    await store.hydrate()
    expect(store.load()?.state).toEqual({ value: 2 })
    await store.withWriter(() => store.commit({ value: 3 }, 'new.update'))
    expect(before.filter(([key]) => key.includes('/records/')).every(([key, value]) =>
      journal.checkpoint().some(([candidate, current]) =>
      candidate === key && canonicalJson(current) === canonicalJson(value)))).toBe(true)
    const latest = new JournalCampaignStore(new MemorySearchStore(journal.checkpoint()), 'round')
    await latest.hydrate()
    expect(latest.load()?.state).toEqual({ value: 3 })
    expect(latest.load()?.seq).toBe(2)
  })

  it('does not mutate a legacy full record returned as a shared journal object', async () => {
    class SharedObjectJournal extends SearchJournalBase {
      readonly values = new Map<string, unknown>()
      async read<T>(name: string): Promise<T | undefined> { return this.values.get(name) as T | undefined }
      async write(name: string, value: unknown): Promise<void> { this.values.set(name, value) }
      async put<T extends { digest: string }>(_value: T): Promise<string> { throw new Error('unused') }
    }
    const journal = new SharedObjectJournal(), prefix = 'rounds/round/campaign/state'
    const full = { seq: 0, previous: null, event: 'legacy.initialize', state: { nested: { value: 1 } } }
    const fullDigest = sha256(canonicalJson(full))
    const nextState = { nested: { value: 2 } }
    const delta = { format: 2, seq: 1, previous: fullDigest, event: 'update',
      patch: [{ path: ['nested', 'value'], kind: 'set', value: 2 }],
      stateDigest: sha256(canonicalJson(nextState)) }
    const deltaBytes = canonicalJson(delta), deltaDigest = sha256(deltaBytes)
    await journal.write(`${prefix}/records/${fullDigest}`, full)
    await journal.write(`${prefix}/records/${deltaDigest}`, deltaBytes)
    await journal.write(`${prefix}/head`, { seq: 1, digest: deltaDigest })
    const originalBytes = canonicalJson(full)
    const store = new JournalCampaignStore(journal, 'round')
    await store.hydrate()
    expect(store.load()?.state).toEqual(nextState)
    expect(canonicalJson(full)).toBe(originalBytes)
    expect(full.state.nested.value).toBe(1)
    expect(await journal.read(`${prefix}/records/${fullDigest}`)).toBe(full)
  })

  it('verifies the reconstructed head state and rejects unsafe or overlapping patch paths', async () => {
    const prefix = 'rounds/round/campaign/state'
    const base = { seq: 0, previous: null, event: 'initialize', state: { a: 1, b: 2 } }
    const baseDigest = sha256(canonicalJson(base))
    const hydrate = async (patch: unknown, stateDigest: string) => {
      const journal = new MemorySearchStore()
      const delta = { format: 2, seq: 1, previous: baseDigest, event: 'update', patch, stateDigest }
      const deltaDigest = sha256(canonicalJson(delta))
      await journal.write(`${prefix}/records/${baseDigest}`, base)
      await journal.write(`${prefix}/records/${deltaDigest}`, delta)
      await journal.write(`${prefix}/head`, { seq: 1, digest: deltaDigest })
      return new JournalCampaignStore(journal, 'round').hydrate()
    }
    const changed = [{ path: ['a'], kind: 'set', value: 3 }]
    await expect(hydrate(changed, sha256(canonicalJson({ a: 999, b: 2 }))))
      .rejects.toThrow('reconstructed state drift')
    await expect(hydrate([{ path: ['__proto__'], kind: 'set', value: 3 }],
      sha256(canonicalJson({ a: 1, b: 2 })))).rejects.toThrow('Unsafe JSON key')
    await expect(hydrate([...changed, { path: ['a', 'nested'], kind: 'set', value: 4 }],
      sha256(canonicalJson({ a: 3, b: 2 })))).rejects.toThrow('overlapping patch paths')
  })
})
