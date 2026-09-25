import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALGORITHM_API_VERSION, type Algorithm, type CompletionEnvelope, type OperationProvider, type ProviderManifest } from '../../src/algorithm/contracts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { sha256 } from '../../src/algorithm/artifacts.js'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'
import { FileProviderRecordBackend, JournalArtifactStore, JournalCampaignStore, SearchJournalProviderRecordBackend } from '../../src/algorithm/runtime/persistence.js'
import { MemorySearchStore } from '../../src/search/testing.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function cacheRoot(): string { const root = mkdtempSync(join(tmpdir(), 'gear-campaign-journal-')); roots.push(root); return root }

describe('SearchJournal-backed Campaign persistence', () => {
  it('restores the complete verified campaign chain from a reconstructed MemorySearchStore checkpoint', async () => {
    const journal = new MemorySearchStore()
    const first = new JournalCampaignStore(journal, 'round')
    await first.withWriter(async () => {
      await first.commit({ phase: 'started' }, 'decision.initialize')
      await first.commit({ phase: 'complete', spent: 20 }, 'operation.completed')
    })
    const recovered = new JournalCampaignStore(new MemorySearchStore(journal.checkpoint()), 'round')
    await recovered.hydrate()
    expect(recovered.load()?.state).toEqual({ phase: 'complete', spent: 20 })
    expect(recovered.load()?.seq).toBe(1)
    expect(recovered.identityDigest).toBe(first.identityDigest)
  })

  it('accepts a lost acknowledgement only after reading back the exact committed head', async () => {
    const journal = new MemorySearchStore(), write = journal.write.bind(journal)
    let lost = false
    vi.spyOn(journal, 'write').mockImplementation(async (name, value) => {
      await write(name, value)
      if (name.endsWith('/state/head') && !lost) { lost = true; throw new Error('ack lost') }
    })
    const store = new JournalCampaignStore(journal, 'round')
    await store.withWriter(() => store.commit({ phase: 'complete' }, 'decision.complete'))
    expect(lost).toBe(true)
    expect(store.load()?.seq).toBe(0)
    await new JournalCampaignStore(new MemorySearchStore(journal.checkpoint()), 'round').hydrate()
  })

  it('replays a failed post-head projection from the authoritative state on new-store hydrate', async () => {
    const journal = new MemorySearchStore(), projectorIdentityDigest = sha256('budget-projector-v1')
    const first = new JournalCampaignStore<{ spent: { cells: number } }>(journal, 'round', {
      projectorIdentityDigest,
      afterCommit: async () => { throw new Error('projection interrupted after head') },
    })
    await expect(first.withWriter(() => first.commit({ spent: { cells: 20 } }, 'operation.completed')))
      .rejects.toThrow('projection interrupted after head')
    const repaired: Array<{ cells: number }> = []
    const second = new JournalCampaignStore<{ spent: { cells: number } }>(new MemorySearchStore(journal.checkpoint()), 'round', {
      projectorIdentityDigest,
      afterCommit: async state => { repaired.push(state.spent) },
    })
    await second.hydrate()
    expect(repaired).toEqual([])
    await second.recoverProjection()
    expect(repaired).toEqual([{ cells: 20 }])
    expect(second.load()?.state).toEqual({ spent: { cells: 20 } })
    expect(second.identityDigest).toBe(first.identityDigest)
  })

  it('rejects a missing chain link rather than manufacturing an empty campaign', async () => {
    const journal = new MemorySearchStore(), store = new JournalCampaignStore(journal, 'round')
    await store.withWriter(() => store.commit({ step: 1 }, 'decision.initialize'))
    const checkpoint = journal.checkpoint().filter(([key]) => !key.includes('/state/records/'))
    await expect(new JournalCampaignStore(new MemorySearchStore(checkpoint), 'round').hydrate())
      .rejects.toThrow('record drift')
  })

  it('hydrates immutable artifacts and operation intent records before physical effects', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const artifacts = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round')
    const ref = artifacts.putJson({ task: 'frozen' }, 'test.task.v1')
    await artifacts.flush()
    const records = new SearchJournalProviderRecordBackend(journal, 'round')
    const operationId = 'a'.repeat(64)
    expect(await records.create('gepa.evaluate', operationId, { status: 'started', inputDigest: ref.digest }))
      .toEqual({ record: { status: 'started', inputDigest: ref.digest }, created: true })
    const checkpoint = journal.checkpoint()
    const restoredJournal = new MemorySearchStore(checkpoint)
    const restoredArtifacts = new JournalArtifactStore(join(cacheRoot(), 'artifacts'), restoredJournal, 'round')
    await restoredArtifacts.hydrate()
    expect(restoredArtifacts.getJson(ref)).toEqual({ task: 'frozen' })
    const restoredRecords = new SearchJournalProviderRecordBackend(restoredJournal, 'round')
    expect(await restoredRecords.read('gepa.evaluate', operationId))
      .toEqual({ status: 'started', inputDigest: ref.digest })
    expect(await restoredRecords.create('gepa.evaluate', operationId, { status: 'started', inputDigest: ref.digest }))
      .toMatchObject({ created: false })
  })

  it('rebuilds a discarded local artifact cache from the authoritative journal', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const local = join(root, 'artifacts')
    const artifacts = new JournalArtifactStore(local, journal, 'round')
    const ref = artifacts.putJson({ task: 'rebuild-local-cache' }, 'test.task.v1')
    await artifacts.flush()
    rmSync(join(local, 'objects', `${ref.digest}.json`))
    const restored = new JournalArtifactStore(local, new MemorySearchStore(journal.checkpoint()), 'round')
    await restored.hydrate()
    expect(restored.getJson(ref)).toEqual({ task: 'rebuild-local-cache' })
  })

  it('reconstructs a complete Kernel campaign and bindings with no original filesystem', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const bindingSchema = { id: 'journal-bindings.v1', slots: { harness: { schemaId: 'harness.v1', required: true, replaceable: false } } }
    const artifacts = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round')
    const bindings = new BindingStore(artifacts, bindingSchema)
    const harness = artifacts.putJson({ revision: 'h0' }, 'harness.v1')
    const initialBindingSetRef = bindings.create({ harness })
    const recipe: Algorithm = {
      describe: () => ({ id: 'journal-recipe', apiVersion: ALGORITHM_API_VERSION,
        implementationDigest: sha256('journal-recipe-v1'), configSchema: { type: 'object', additionalProperties: false },
        stateSchema: { type: 'object', additionalProperties: true }, bindingSchema }),
      initialize: () => ({ nextState: { harness }, complete: true }),
      reduce: () => { throw new Error('complete recipe must not reduce') },
    }
    const spec = { campaignId: 'journal-campaign', config: {}, initialBindingSetRef, budget: {} }
    const campaign = new JournalCampaignStore(journal, 'round')
    const hydrated = vi.spyOn(campaign, 'hydrate')
    const runtime = new AlgorithmRuntime(root, recipe, [], spec,
      { store: campaign, artifacts })
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect(hydrated).toHaveBeenCalledTimes(1) // the writer verifies the chain once
    expect(runtime.snapshot()?.state).toEqual({ harness })
    const restoredJournal = new MemorySearchStore(journal.checkpoint()), restoredRoot = cacheRoot()
    const restoredArtifacts = new JournalArtifactStore(join(restoredRoot, 'artifacts'), restoredJournal, 'round')
    const restored = new AlgorithmRuntime(restoredRoot, recipe, [], spec,
      { store: new JournalCampaignStore(restoredJournal, 'round'), artifacts: restoredArtifacts })
    await restored.hydrate()
    expect(restored.snapshot()).toEqual(runtime.snapshot())
    expect(new BindingStore(restoredArtifacts, bindingSchema).read(initialBindingSetRef).slots.harness)
      .toEqual(harness)
    expect(await restored.runUntilBlocked()).toBe('complete')

    const changedJournal = new MemorySearchStore(journal.checkpoint()), before = changedJournal.checkpoint()
    let projected = 0
    const changedArtifacts = new JournalArtifactStore(join(cacheRoot(), 'artifacts'), changedJournal, 'round')
    const changed = new AlgorithmRuntime(cacheRoot(), recipe, [], spec, {
      store: new JournalCampaignStore(changedJournal, 'round', {
        projectorIdentityDigest: sha256('different-projector-v1'), afterCommit: async () => { projected++ },
      }), artifacts: changedArtifacts,
    })
    await expect(changed.hydrate()).rejects.toThrow('Campaign identity drift')
    await expect(changed.tick()).rejects.toThrow('Campaign identity drift')
    expect(projected).toBe(0)
    expect(changedJournal.checkpoint()).toEqual(before)
  })

  it('blocks a physical effect when its durable started record fails, then recovers exactly once', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const bindingSchema = { id: 'journal-effect-bindings.v1', slots: { harness: { schemaId: 'harness.v1', required: true, replaceable: false } } }
    const artifacts = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round')
    const bindingSetRef = new BindingStore(artifacts, bindingSchema)
      .create({ harness: artifacts.putJson({ revision: 'h0' }, 'harness.v1') })
    const manifest: ProviderManifest = { kind: 'toy.effect', implementationDigest: sha256('toy.effect.v1'),
      inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['evidenceRef'], properties: { evidenceRef: { type: 'any' } }, additionalProperties: false },
      execution: 'external', supportsInspect: true, meteredDimensions: [] }
    const recipe: Algorithm = {
      describe: () => ({ id: 'journal-effect', apiVersion: ALGORITHM_API_VERSION,
        implementationDigest: sha256('journal-effect-recipe-v1'),
        configSchema: { type: 'object', additionalProperties: false },
        stateSchema: { type: 'object', additionalProperties: true }, bindingSchema }),
      initialize: () => ({ nextState: { step: 'running' }, operations: [{ localKey: 'effect', kind: 'toy.effect', input: { task: 'one' }, limits: {} }] }),
      reduce: ({ completed }) => ({ nextState: { completed }, complete: true }),
    }
    const spec = { campaignId: 'journal-effect-campaign', config: {}, initialBindingSetRef: bindingSetRef, budget: {} }
    let effects = 0
    const provider = (source: MemorySearchStore, cache: JournalArtifactStore): OperationProvider => {
      const backend = new SearchJournalProviderRecordBackend(source, 'round')
      type Saved = { stage: 'started' | 'complete'; completion?: CompletionEnvelope }
      return { describe: () => manifest, preflight: () => {},
        inspect: async envelope => {
          const saved = await backend.read<Saved>('toy.effect', envelope.operationId)
          return saved?.completion ? { status: 'completed', completion: saved.completion }
            : saved ? { status: 'unknown' } : { status: 'not-started' }
        },
        submit: async envelope => {
          await cache.flush()
          const { created } = await backend.create<Saved>('toy.effect', envelope.operationId, { stage: 'started' })
          if (!created) return { status: 'running' }
          effects++
          const evidenceRef = cache.putJson({ task: 'one', run: effects }, 'toy.evidence.v1')
          await cache.flush()
          const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
            inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
            outcome: { kind: 'result', value: { evidenceRef } } }
          await backend.write<Saved>('toy.effect', envelope.operationId, { stage: 'complete', completion })
          return { status: 'completed', completion }
        },
        cancel: async () => ({ status: 'unknown' }),
        collect: async envelope => {
          const observed = await backend.read<Saved>('toy.effect', envelope.operationId)
          if (!observed?.completion) throw new Error('effect not complete')
          return observed.completion
        },
      }
    }
    const write = journal.write.bind(journal)
    let blocked = false
    vi.spyOn(journal, 'write').mockImplementation(async (name, value) => {
      if (name.includes('/campaign/providers/') && !blocked) { blocked = true; throw new Error('intent write unavailable') }
      await write(name, value)
    })
    const initial = new AlgorithmRuntime(root, recipe, [provider(journal, artifacts)], spec,
      { store: new JournalCampaignStore(journal, 'round'), artifacts })
    expect(await initial.runUntilBlocked()).toBe('waiting')
    expect(blocked).toBe(true)
    expect(effects).toBe(0)
    const resumedJournal = new MemorySearchStore(journal.checkpoint()), resumedRoot = cacheRoot()
    const resumedArtifacts = new JournalArtifactStore(join(resumedRoot, 'artifacts'), resumedJournal, 'round')
    const resumed = new AlgorithmRuntime(resumedRoot, recipe, [provider(resumedJournal, resumedArtifacts)], spec,
      { store: new JournalCampaignStore(resumedJournal, 'round'), artifacts: resumedArtifacts })
    expect(await resumed.runUntilBlocked()).toBe('complete')
    expect(effects).toBe(1)
    const finalJournal = new MemorySearchStore(resumedJournal.checkpoint()), finalRoot = cacheRoot()
    const finalArtifacts = new JournalArtifactStore(join(finalRoot, 'artifacts'), finalJournal, 'round')
    const final = new AlgorithmRuntime(finalRoot, recipe, [provider(finalJournal, finalArtifacts)], spec,
      { store: new JournalCampaignStore(finalJournal, 'round'), artifacts: finalArtifacts })
    expect(await final.runUntilBlocked()).toBe('complete')
    expect(effects).toBe(1)
  })

  it('republishes an artifact index after an interrupted index write and rejects corrupted bytes', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const store = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round')
    const ref = store.putJson({ immutable: true }, 'test.v1')
    const write = journal.write.bind(journal)
    let interrupted = false
    vi.spyOn(journal, 'write').mockImplementation(async (name, value) => {
      if (name.endsWith('/artifacts/index') && !interrupted) {
        interrupted = true
        throw new Error('index write failed before publication')
      }
      await write(name, value)
    })
    await expect(store.flush()).rejects.toThrow('index write failed')
    await store.flush()
    expect(interrupted).toBe(true)
    const checkpoint = journal.checkpoint()
    const object = checkpoint.find(([key]) => key.endsWith(`/objects/${ref.digest}`))!
    object[1] = 'bad bytes'
    await expect(new JournalArtifactStore(join(cacheRoot(), 'artifacts'), new MemorySearchStore(checkpoint), 'round').hydrate())
      .rejects.toThrow('artifact drift')
  })

  it('merges a later adapter publication before flushing an older adapter cache', async () => {
    const journal = new MemorySearchStore()
    const first = new JournalArtifactStore(join(cacheRoot(), 'artifacts'), journal, 'round')
    const a = first.putJson({ from: 'first-a' }, 'test.v1')
    await first.flush()
    const second = new JournalArtifactStore(join(cacheRoot(), 'artifacts'), journal, 'round')
    await second.hydrate()
    const b = second.putJson({ from: 'second' }, 'test.v1')
    await second.flush()
    const c = first.putJson({ from: 'first-c' }, 'test.v1')
    await first.flush()
    const restored = new JournalArtifactStore(join(cacheRoot(), 'artifacts'),
      new MemorySearchStore(journal.checkpoint()), 'round')
    await restored.hydrate()
    expect([a, b, c].map(ref => restored.getJson(ref)))
      .toEqual([{ from: 'first-a' }, { from: 'second' }, { from: 'first-c' }])
  })

  it('rejects a changed local published artifact at the next flush', async () => {
    const journal = new MemorySearchStore(), root = cacheRoot()
    const store = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round')
    const ref = store.putJson({ immutable: true }, 'test.v1')
    await store.flush()
    writeFileSync(join(root, 'artifacts', 'objects', `${ref.digest}.json`), 'tampered')
    await expect(store.flush()).rejects.toThrow('Local artifact cache drift')
  })

  it('preserves the legacy local provider record directory through the async backend', async () => {
    const root = cacheRoot(), operationId = 'b'.repeat(64)
    const backend = new FileProviderRecordBackend(root, { 'gepa.publish': 'gepa-publication' })
    expect((await backend.create('gepa.publish', operationId, { stage: 'intent' })).created).toBe(true)
    expect((await backend.create('gepa.publish', operationId, { stage: 'intent' })).created).toBe(false)
    await backend.write('gepa.publish', operationId, { stage: 'complete' })
    expect(await new FileProviderRecordBackend(root, { 'gepa.publish': 'gepa-publication' })
      .read('gepa.publish', operationId)).toEqual({ stage: 'complete' })
  })
})
