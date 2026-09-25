import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ALGORITHM_API_VERSION, type Algorithm, type ArtifactRef, type CampaignSpec,
  type OperationProvider } from '../../src/algorithm/contracts.js'
import { sha256 } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'
import { JournalArtifactStore, JournalCampaignStore, type DurableProjectionHost } from '../../src/algorithm/runtime/persistence.js'
import { MemorySearchStore } from '../../src/search/testing.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const schemaId = 'toy.durable-projection.v1'
const bindingSchema = { id: 'toy.projection-bindings.v1', slots: {} }
function root(): string { const path = mkdtempSync(join(tmpdir(), 'gear-durable-projection-')); roots.push(path); return path }

function fixture(options: { journal?: MemorySearchStore; bindingRef?: CampaignSpec['initialBindingSetRef'];
  refs?: ArtifactRef[]; projectorDigest?: string; failAfterPublish?: boolean; requireHost?: boolean } = {}) {
  const journal = options.journal ?? new MemorySearchStore()
  const path = root()
  const artifacts = new JournalArtifactStore(join(path, 'artifacts'), journal, 'round')
  const bindingRef = options.bindingRef ?? new BindingStore(artifacts, bindingSchema).create({})
  const refs = options.refs ?? [artifacts.putJson({ stage: 'parents' }, schemaId),
    artifacts.putJson({ stage: 'planning' }, schemaId)]
  const spec: CampaignSpec = { campaignId: 'projection-campaign', config: {}, initialBindingSetRef: bindingRef, budget: {} }
  const projectionCalls: string[] = [], effects: string[] = []
  const host: DurableProjectionHost = {
    describe: () => ({ implementationDigest: options.projectorDigest ?? sha256('toy-projector-v1'), schemaIds: [schemaId] }),
    project: async ref => {
      const stage = (artifacts.getJson(ref) as { stage: string }).stage
      projectionCalls.push(stage)
      await journal.write(`rounds/round/projected-${stage}`, { ref: ref.digest })
      if (options.failAfterPublish) throw new Error('projection acknowledgement lost')
    },
  }
  const algorithm: Algorithm = {
    describe: () => ({ id: 'toy-projection-recipe', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('toy-projection-recipe-v1'), bindingSchema,
      configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true },
      requiredProjectionSchemas: [schemaId] }),
    initialize: () => ({ nextState: { phase: 'first' }, projections: [refs[0]!] }),
    reduce: ({ state }) => {
      const phase = (state as { phase: string }).phase
      if (phase === 'first') return { nextState: { phase: 'second' }, projections: [refs[1]!] }
      if (phase === 'second') return { nextState: { phase: 'effect' },
        operations: [{ localKey: 'effect', kind: 'toy.effect', input: {}, limits: {} }] }
      return { nextState: { phase: 'done' }, complete: true }
    },
  }
  const provider: OperationProvider = {
    describe: () => ({ kind: 'toy.effect', implementationDigest: sha256('toy-effect-v1'),
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      meteredDimensions: [], execution: 'trusted-local', supportsInspect: true }),
    preflight: () => {},
    inspect: async () => ({ status: 'not-started' }),
    submit: async envelope => {
      effects.push('effect')
      expect(await journal.read('rounds/round/projected-parents')).toEqual({ ref: refs[0]!.digest })
      expect(await journal.read('rounds/round/projected-planning')).toEqual({ ref: refs[1]!.digest })
      return { status: 'completed', completion: { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: {} } } }
    },
    cancel: async () => ({ status: 'unknown' }),
    collect: async () => { throw new Error('unused') },
  }
  const store = new JournalCampaignStore(journal, 'round', options.requireHost === false ? {} : { projectionHost: host })
  const runtime = () => new AlgorithmRuntime(path, algorithm, [provider], spec, { store, artifacts })
  return { journal, path, artifacts, bindingRef, refs, spec, algorithm, provider, store, runtime, projectionCalls, effects }
}

it('requires a named durable projection host before admitting a projection recipe', () => {
  const f = fixture({ requireHost: false })
  expect(f.runtime).toThrow('Required durable projection host missing')
})

it('projects each sealed checkpoint once per writer before a subsequent physical operation', async () => {
  const f = fixture(), runtime = f.runtime()
  expect(await runtime.runWithWriterUntilBlocked()).toBe('complete')
  expect(f.projectionCalls).toEqual(['parents', 'planning'])
  expect(f.effects).toEqual(['effect'])
  expect(runtime.snapshot()?.durableProjections).toEqual(f.refs)
  const recoveredJournal = new MemorySearchStore(f.journal.checkpoint())
  const recovered = fixture({ journal: recoveredJournal, bindingRef: f.bindingRef, refs: f.refs })
  await recovered.runtime().hydrate()
  expect(recovered.projectionCalls).toEqual(['parents', 'planning'])
  expect(recovered.effects).toEqual([])
})

it('replays a projection after a committed head loses its projection acknowledgement, without an effect', async () => {
  const f = fixture({ failAfterPublish: true })
  await expect(f.runtime().tick()).rejects.toThrow('projection acknowledgement lost')
  expect(f.effects).toEqual([])
  expect(f.store.load()?.seq).toBe(0)
  const recoveredJournal = new MemorySearchStore(f.journal.checkpoint())
  const recovered = fixture({ journal: recoveredJournal, bindingRef: f.bindingRef, refs: f.refs })
  expect(await recovered.runtime().runWithWriterUntilBlocked()).toBe('complete')
  expect(recovered.projectionCalls).toEqual(['parents', 'planning'])
  expect(recovered.effects).toEqual(['effect'])
})

it('rejects changed projection code before replay or external effects', async () => {
  const f = fixture()
  await f.runtime().tick()
  const checkpoint = f.journal.checkpoint(), journal = new MemorySearchStore(checkpoint)
  const changed = fixture({ journal, bindingRef: f.bindingRef, refs: f.refs,
    projectorDigest: sha256('toy-projector-v2') })
  await expect(changed.runtime().hydrate()).rejects.toThrow('Campaign identity drift')
  expect(changed.projectionCalls).toEqual([])
  expect(changed.effects).toEqual([])
  expect(journal.checkpoint()).toEqual(checkpoint)
})

it('rejects replacement of an already projected prefix before changing the durable head', async () => {
  const journal = new MemorySearchStore(), published: string[] = []
  const host: DurableProjectionHost = {
    describe: () => ({ implementationDigest: sha256('prefix-host'), schemaIds: [schemaId] }),
    project: async ref => { published.push(ref.digest) },
  }
  const first: ArtifactRef = { kind: 'artifact', digest: sha256('first'), mediaType: 'application/json',
    schemaId, size: 1 }
  const replacement: ArtifactRef = { ...first, digest: sha256('replacement') }
  const store = new JournalCampaignStore<{ durableProjections: ArtifactRef[] }>(journal, 'round', {
    projectionHost: host,
  })
  await store.withWriter(async () => {
    await store.commit({ durableProjections: [first] }, 'first')
    const checkpoint = journal.checkpoint()
    await expect(store.commit({ durableProjections: [replacement] }, 'replacement'))
      .rejects.toThrow('projection history drift')
    expect(journal.checkpoint()).toEqual(checkpoint)
  })
  expect(published).toEqual([first.digest])
})
