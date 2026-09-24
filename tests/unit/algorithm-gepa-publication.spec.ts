import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaPublicationProvider, type GepaBootstrapPublication, type GepaPublicationInput } from '../../src/algorithm/providers/gepa-publication.js'
import { JournalArtifactStore, SearchJournalProviderRecordBackend } from '../../src/algorithm/runtime/persistence.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import { SearchStore } from '../../src/search/store.js'
import { seal } from '../../src/search/contracts.js'
import { digestJson } from '../../src/state/digest.js'
import { fixtures, settings } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gepa-publication-'))
  roots.push(root)
  const f = fixtures(20), config = settings()
  config.search.taskSetSizing.bridge.ratio = 0
  const legacy = new MemorySearchStore()
  const outcome = await new FailureClusterSearch(legacy, f.provider, f.diagnosis, f.hooks).run({
    evolutionId: 'publication-fixture', roundId: 'r', roundIndex: 0, maxCandidates: 4,
    anchor: f.anchor, championRevisionDigest: digestJson('original-revision'), settings: config,
  }, new AbortController().signal)
  expect(outcome.championChanged).toBe(false)
  const archive = (await legacy.archive())!
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const nextArchiveRef = artifacts.putJson(archive as unknown as JsonValue, 'gepa.research-archive.v1')
  const outcomeRef = artifacts.putJson(outcome as unknown as JsonValue, 'gepa.round-outcome.v1')
  const publication = new SearchStore(join(root, 'publication'))
  const providerRoot = join(root, 'provider')
  const provider = () => new GepaPublicationProvider(providerRoot, artifacts, publication, f.hooks)
  const base: GepaPublicationInput = { roundId: 'r', expectedArchiveDigest: null, nextArchiveRef,
    expectedChampionRevisionDigest: digestJson('original-revision'), outcomeRef }
  const envelope = (input: GepaPublicationInput): OperationEnvelope => {
    const manifest = provider().describe()
    const operationId = jsonDigest(['publication', input])
    return { campaignId: 'publication-fixture', decisionIndex: 0, localKey: 'publish', kind: 'gepa.publish',
      operationId, idempotencyKey: operationId, input: input as unknown as JsonValue,
      inputDigest: jsonDigest(input as unknown as JsonValue), implementationDigest: manifest.implementationDigest,
      bindingSetRef: { kind: 'binding-set', digest: jsonDigest('binding'), schemaId: 'fixture-binding' }, limits: {} }
  }
  return { root, archive, outcome, artifacts, publication, provider, base, envelope }
}

describe('GEPA publication provider', () => {
  it('recovers an archive CAS whose response was lost without reissuing publication', async () => {
    const f = await setup(), envelope = f.envelope(f.base)
    const cas = f.publication.casArchive.bind(f.publication)
    let calls = 0
    f.publication.casArchive = async (...args) => {
      calls++
      await cas(...args)
      throw new Error('response lost after archive CAS')
    }
    await expect(f.provider().submit(envelope)).rejects.toThrow('response lost')
    const recovered = await f.provider().inspect(envelope)
    expect(recovered.status).toBe('replay-safe')
    expect((await f.provider().submit(envelope)).status).toBe('completed')
    expect(calls).toBe(1)
    expect((await f.publication.archive())?.digest).toBe(f.archive.digest)
    expect((await f.provider().collect(envelope)).outcome.kind).toBe('result')
    expect(await f.publication.read('rounds/r/terminal')).toEqual({ ref: f.outcome.digest })
  })

  it('publishes a bootstrap checkpoint before a final outcome using distinct frozen operations', async () => {
    const f = await setup()
    const baselinePlan = f.archive.plans.find(plan => plan.stage === 'baseline-probe')
    const baseline = f.archive.results.find(result => result.stagePlanDigest === baselinePlan?.digest)
    const anchor = f.archive.snapshots.find(snapshot => snapshot.digest === baseline?.snapshotDigest)
    if (!baselinePlan || !baseline || !anchor) throw new Error('fixture baseline archive missing')
    const { digest: ignoredArchiveDigest, ...archiveBody } = f.archive
    const bootstrapArchive = seal({ ...archiveBody, plans: [baselinePlan], results: [baseline], snapshots: [anchor] })
    const bootstrapArchiveRef = f.artifacts.putJson(bootstrapArchive as unknown as JsonValue, 'gepa.research-archive.v1')
    const bootstrap: GepaBootstrapPublication = { schemaVersion: 1, kind: 'bootstrap-archive',
      roundId: 'r', archiveDigest: bootstrapArchive.digest }
    const bootstrapRef = f.artifacts.putJson(bootstrap as unknown as JsonValue, 'gepa.bootstrap-publication.v1')
    const first = f.envelope({ ...f.base, nextArchiveRef: bootstrapArchiveRef, outcomeRef: bootstrapRef })
    const originalWrite = f.publication.write.bind(f.publication)
    const originalCas = f.publication.casArchive.bind(f.publication)
    let failConsumption = true, casCalls = 0, archiveReadable = false
    f.publication.write = async (name, value) => {
      await originalWrite(name, value)
      if (name.startsWith('rounds/r/consumed-') && failConsumption) {
        archiveReadable = (await f.publication.object(bootstrapArchive.digest)).digest === bootstrapArchive.digest
        failConsumption = false
        throw new Error('consumption pointer acknowledgement lost')
      }
    }
    f.publication.casArchive = async (...args) => { casCalls++; return originalCas(...args) }
    await expect(f.provider().submit(first)).rejects.toThrow('consumption pointer acknowledgement lost')
    expect(archiveReadable).toBe(true)
    expect(casCalls).toBe(0)
    expect(await f.publication.archive()).toBeUndefined()
    expect((await f.provider().submit(first)).status).toBe('completed')
    expect(casCalls).toBe(1)
    expect((await f.publication.archive())?.digest).toBe(bootstrapArchive.digest)
    expect(await f.publication.read('rounds/r/bootstrap-publication')).toBeDefined()
    const consumed = await f.publication.read<{ ref: string }>(
      `rounds/r/consumed-${digestJson([baseline.stagePlanDigest, baseline.snapshotDigest]).slice(7)}`)
    expect(await f.publication.object(consumed!.ref)).toMatchObject({ resultDigest: baseline.digest,
      consumer: 'bootstrap-archive', consumerDigest: bootstrapArchive.digest })
    expect(await f.publication.read('rounds/r/terminal')).toBeUndefined()
    const second = f.envelope({ ...f.base, expectedArchiveDigest: bootstrapArchive.digest })
    expect((await f.provider().submit(second)).status).toBe('completed')
    const commit = await f.publication.read<{ ref: string }>('rounds/r/commit')
    expect(await f.publication.object(commit!.ref)).toMatchObject({ expectedArchiveDigest: bootstrapArchive.digest,
      nextArchiveDigest: f.archive.digest, outcome: f.outcome })
    expect((await f.provider().inspect(first)).status).toBe('completed')
  })

  it('freezes the exact final commit intent before archive CAS and resumes after its pointer write loses acknowledgement', async () => {
    const f = await setup()
    const baselinePlan = f.archive.plans.find(plan => plan.stage === 'baseline-probe')
    const baseline = f.archive.results.find(result => result.stagePlanDigest === baselinePlan?.digest)
    const anchor = f.archive.snapshots.find(snapshot => snapshot.digest === baseline?.snapshotDigest)
    if (!baselinePlan || !baseline || !anchor) throw new Error('fixture baseline archive missing')
    const { digest: ignoredArchiveDigest, ...archiveBody } = f.archive
    const bootstrapArchive = seal({ ...archiveBody, plans: [baselinePlan], results: [baseline], snapshots: [anchor] })
    const bootstrapArchiveRef = f.artifacts.putJson(bootstrapArchive as unknown as JsonValue, 'gepa.research-archive.v1')
    const bootstrapRef = f.artifacts.putJson({ schemaVersion: 1, kind: 'bootstrap-archive',
      roundId: 'r', archiveDigest: bootstrapArchive.digest }, 'gepa.bootstrap-publication.v1')
    await f.provider().submit(f.envelope({ ...f.base, nextArchiveRef: bootstrapArchiveRef, outcomeRef: bootstrapRef }))
    const finalInput = { ...f.base, expectedArchiveDigest: bootstrapArchive.digest }
    let barriers = 0
    const finalProvider = () => new GepaPublicationProvider(join(f.root, 'final-provider'), f.artifacts,
      f.publication, { commitChampion: async () => {} }, { beforePublication: async () => { barriers++ },
        publicationBarrierIdentityDigest: digestJson('frozen-budget-barrier').slice(7) })
    const final = { ...f.envelope(finalInput), implementationDigest: finalProvider().describe().implementationDigest }
    const originalWrite = f.publication.write.bind(f.publication)
    const originalCas = f.publication.casArchive.bind(f.publication)
    let failCommit = true, casCalls = 0
    f.publication.write = async (name, value) => {
      if (name === 'rounds/r/commit') {
        expect(barriers).toBeGreaterThan(0)
        expect((await f.publication.object(f.archive.digest)).digest).toBe(f.archive.digest)
      }
      await originalWrite(name, value)
      if (name === 'rounds/r/commit' && failCommit) {
        failCommit = false
        throw new Error('commit pointer acknowledgement lost')
      }
    }
    f.publication.casArchive = async (...args) => { casCalls++; return originalCas(...args) }
    await expect(finalProvider().submit(final)).rejects.toMatchObject({ name: 'ProviderReconcileError',
      cause: { message: 'commit pointer acknowledgement lost' } })
    expect(casCalls).toBe(0)
    expect((await f.publication.archive())?.digest).toBe(bootstrapArchive.digest)
    const pointer = await f.publication.read<{ ref: string }>('rounds/r/commit')
    expect(await f.publication.object(pointer!.ref)).toEqual(seal({
      expectedArchiveDigest: bootstrapArchive.digest, nextArchiveDigest: f.archive.digest,
      expectedChampionRevisionDigest: finalInput.expectedChampionRevisionDigest, outcome: f.outcome }))
    expect((await finalProvider().submit(final)).status).toBe('completed')
    expect(casCalls).toBe(1)
    expect((await f.publication.archive())?.digest).toBe(f.archive.digest)
  })

  it('rejects a bootstrap checkpoint whose archive has no unique baseline evidence', async () => {
    const f = await setup()
    const bootstrapRef = f.artifacts.putJson({ schemaVersion: 1, kind: 'bootstrap-archive',
      roundId: 'r', archiveDigest: f.archive.digest }, 'gepa.bootstrap-publication.v1')
    await expect(f.provider().submit(f.envelope({ ...f.base, outcomeRef: bootstrapRef })))
      .rejects.toThrow('unique verified baseline result')
    expect(await f.publication.archive()).toBeUndefined()
    expect(await f.publication.read('rounds/r/commit')).toBeUndefined()
  })

  it('records an unsuccessful bootstrap terminal without installing its incomplete archive', async () => {
    const f = await setup()
    const { digest: oldDigest, ...body } = f.outcome
    const failure = seal({ ...body, reasonCodes: [...body.reasonCodes, 'bootstrap-execution-unavailable'] })
    const outcomeRef = f.artifacts.putJson(failure as unknown as JsonValue, 'gepa.round-outcome.v1')
    const envelope = f.envelope({ ...f.base, outcomeRef, publishArchive: false })
    const submitted = await f.provider().submit(envelope)
    expect(submitted.status).toBe('completed')
    expect(await f.publication.archive()).toBeUndefined()
    expect(await f.publication.read('rounds/r/terminal')).toEqual({ ref: failure.digest })
    expect((await f.provider().inspect(envelope)).status).toBe('completed')
    if (submitted.status === 'completed' && submitted.completion.outcome.kind === 'result') {
      const output = submitted.completion.outcome.value as { publicationReceiptRef: Parameters<typeof f.artifacts.getJson>[0] }
      expect(f.artifacts.getJson(output.publicationReceiptRef)).toMatchObject({ archiveCommitted: false,
        nextArchiveDigest: f.archive.digest })
    }
  })

  it('preserves the frozen CAS conflict and never changes the archive', async () => {
    const f = await setup(), envelope = f.envelope({ ...f.base,
      expectedArchiveDigest: digestJson('unrelated-archive') })
    await expect(f.provider().submit(envelope)).rejects.toThrow('archive CAS conflict')
    await expect(f.provider().inspect(envelope)).rejects.toThrow('archive CAS conflict')
    expect(await f.publication.archive()).toBeUndefined()
  })

  it('rejects a swapped durable receipt on read-only recovery', async () => {
    const f = await setup(), envelope = f.envelope(f.base)
    await f.provider().submit(envelope)
    const path = join(f.root, 'provider', 'gepa-publication', `${envelope.operationId}.json`)
    const record = JSON.parse(await readFile(path, 'utf8')) as { publicationReceiptRef: unknown }
    record.publicationReceiptRef = f.artifacts.putJson({ forged: true }, 'gepa.publication-receipt.v1')
    await writeFile(path, JSON.stringify(record))
    await expect(f.provider().inspect(envelope)).rejects.toThrow('receipt drift')
  })

  it('checkpoints intent, receipt, and terminal through SearchJournal after the budget barrier', async () => {
    const f = await setup()
    let journal = new MemorySearchStore()
    let barriers = 0
    const makeProvider = async () => {
      const local = await mkdtemp(join(tmpdir(), 'gepa-publication-journal-')); roots.push(local)
      const artifacts = new JournalArtifactStore(join(local, 'artifacts'), journal, 'r')
      await artifacts.hydrate()
      const nextArchiveRef = artifacts.putJson(f.archive as unknown as JsonValue, 'gepa.research-archive.v1')
      const outcomeRef = artifacts.putJson(f.outcome as unknown as JsonValue, 'gepa.round-outcome.v1')
      const provider = new GepaPublicationProvider(join(local, 'provider'), artifacts, journal, {
        commitChampion: async () => {},
      }, { records: new SearchJournalProviderRecordBackend(journal, 'r'),
        beforePublication: async () => { barriers++; expect(await journal.archive()).toBeUndefined() },
        publicationBarrierIdentityDigest: digestJson('budget-projection-barrier').slice(7) })
      return { artifacts, nextArchiveRef, outcomeRef, provider }
    }
    const first = await makeProvider()
    const input = { ...f.base, nextArchiveRef: first.nextArchiveRef, outcomeRef: first.outcomeRef }
    const operationId = jsonDigest(['journal-publication', input])
    const envelope: OperationEnvelope = { ...f.envelope(input), operationId, idempotencyKey: operationId,
      implementationDigest: first.provider.describe().implementationDigest }
    expect((await first.provider.submit(envelope)).status).toBe('completed')
    expect(barriers).toBe(1)
    journal = new MemorySearchStore(journal.checkpoint())
    const resumed = await makeProvider()
    expect(resumed.provider.describe().implementationDigest).toBe(envelope.implementationDigest)
    expect((await resumed.provider.inspect(envelope)).status).toBe('completed')
    expect(barriers).toBe(1)
    expect((await journal.archive())?.digest).toBe(f.archive.digest)
    expect(await journal.read('rounds/r/terminal')).toEqual({ ref: f.outcome.digest })
  })

  it('reconciles a lost champion CAS response using the same frozen revision and nominee', async () => {
    const f = await setup()
    const nominee = f.archive.snapshots.find(snapshot => snapshot.candidateId !== 'anchor')
    expect(nominee).toBeDefined()
    if (!nominee) return
    const { digest: ignored, ...body } = f.outcome
    const outcome = seal({ ...body, championChanged: true, nomineeId: nominee.candidateId,
      reasonCodes: [] })
    const outcomeRef = f.artifacts.putJson(outcome as unknown as JsonValue, 'gepa.round-outcome.v1')
    const input = { ...f.base, outcomeRef, nextChampion: nominee }
    const envelope = f.envelope(input)
    let changed = 0, calls = 0, lost = true
    const hooks = { commitChampion: async (expected: string, next: typeof nominee, roundId: string) => {
      calls++
      expect(expected).toBe(input.expectedChampionRevisionDigest)
      expect(next.digest).toBe(nominee.digest)
      expect(roundId).toBe('r')
      if (!changed) changed++
      if (lost) { lost = false; throw new Error('champion CAS response lost') }
    } }
    const provider = () => new GepaPublicationProvider(join(f.root, 'champion-provider'), f.artifacts, f.publication, hooks)
    const championEnvelope = { ...envelope, implementationDigest: provider().describe().implementationDigest }
    await expect(provider().submit(championEnvelope)).rejects.toThrow('response lost')
    expect((await f.publication.archive())?.digest).toBe(f.archive.digest)
    expect(await f.publication.read('rounds/r/terminal')).toBeUndefined()
    expect((await provider().inspect(championEnvelope)).status).toBe('replay-safe')
    expect((await provider().submit(championEnvelope)).status).toBe('completed')
    expect(changed).toBe(1)
    expect(calls).toBe(2)
    expect(await f.publication.read('rounds/r/terminal')).toEqual({ ref: outcome.digest })
  })

  it('propagates a sustained champion revision conflict without writing a false terminal', async () => {
    const f = await setup()
    const nominee = f.archive.snapshots.find(snapshot => snapshot.candidateId !== 'anchor')
    expect(nominee).toBeDefined()
    if (!nominee) return
    const { digest: ignored, ...body } = f.outcome
    const outcome = seal({ ...body, championChanged: true, nomineeId: nominee.candidateId,
      reasonCodes: [] })
    const outcomeRef = f.artifacts.putJson(outcome as unknown as JsonValue, 'gepa.round-outcome.v1')
    const input = { ...f.base, outcomeRef, nextChampion: nominee }
    const hooks = { commitChampion: async () => { throw new Error('champion revision CAS conflict; external champion was preserved') } }
    const provider = new GepaPublicationProvider(join(f.root, 'conflict-provider'), f.artifacts, f.publication, hooks)
    const envelope = { ...f.envelope(input), implementationDigest: provider.describe().implementationDigest }
    await expect(provider.submit(envelope)).rejects.toThrow('champion revision CAS conflict')
    expect((await provider.inspect(envelope)).status).toBe('replay-safe')
    await expect(provider.submit(envelope)).rejects.toThrow('champion revision CAS conflict')
    expect(await f.publication.read('rounds/r/terminal')).toBeUndefined()
  })
})
