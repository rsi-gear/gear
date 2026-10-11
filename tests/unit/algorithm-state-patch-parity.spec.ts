import { describe, expect, it } from 'vitest'
import { JournalCampaignStore } from '../../src/algorithm/runtime/persistence.js'
import { canonicalJson } from '../../src/algorithm/schema.js'
import { MemorySearchStore } from '../../src/search/testing.js'

describe('Campaign object state patch parity', () => {
  it('keeps sorted patch paths and array replacement across reordered keys and nested changes', async () => {
    const journal = new MemorySearchStore()
    const store = new JournalCampaignStore(journal, 'patch')
    const before = {
      list: [{ a: 1, b: 2 }],
      root: { same: { z: 1, a: 2 }, deleted: 'old', change: -0,
        nested: { a: 1, b: 2 }, empty: {}, gone: { a: 1 } },
      unicode: { '\uE000': 1, '\u{10000}': 2 },
    }
    const after = {
      list: [{ b: 2, a: 1 }],
      root: { same: { a: 2, z: 1 }, change: +0,
        nested: { a: 1, b: 3 }, added: 'new', empty: { child: {} }, gone: {} },
      unicode: { '\u{10000}': 2, '\uE000': 1 },
    }
    await store.withWriter(async () => {
      await store.commit(before, 'initialize')
      await store.commit(after, 'update')
    })
    const head = await journal.read<{ digest: string }>('rounds/patch/campaign/state/head')
    const raw = await journal.read<string>(`rounds/patch/campaign/state/records/${head!.digest}`)
    const record = JSON.parse(raw!) as { patch: unknown[] }
    expect(record.patch).toEqual([
      { path: ['list'], kind: 'set', value: [{ b: 2, a: 1 }] },
      { path: ['root', 'added'], kind: 'set', value: 'new' },
      { path: ['root', 'deleted'], kind: 'delete' },
      { path: ['root', 'empty', 'child'], kind: 'set', value: {} },
      { path: ['root', 'gone', 'a'], kind: 'delete' },
      { path: ['root', 'nested', 'b'], kind: 'set', value: 3 },
    ])
    const recovered = new JournalCampaignStore(new MemorySearchStore(journal.checkpoint()), 'patch')
    await recovered.hydrate()
    expect(canonicalJson(recovered.load()!.state)).toBe(canonicalJson(after))
  })
})
