import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore, assertDigest, durableWrite, sha256 } from '../artifacts.js'
import { assertJson, assertSafeKey, canonicalJson, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { durableCreate } from '../providers/provider-record.js'
import type { ArtifactRef } from '../contracts.js'
import type { SearchJournal } from '../../search/store.js'

export interface CampaignStoreLike<T extends JsonValue> {
  readonly requiresArtifactCheckpoint?: true
  /** withWriter verifies the complete Campaign chain before invoking work. */
  readonly writerHydrates?: true
  readonly identityDigest?: string
  /** Schemas whose projections are durably reconciled before the next effect. */
  readonly projectionSchemas?: readonly string[]
  hydrate?(): Promise<void>
  recoverProjection?(): Promise<void>
  load(): { state: T; seq: number; digest: string } | null
  withWriter<R>(work: () => Promise<R>): Promise<R>
  assertLease(): void
  commit(state: T, event: string): Promise<void>
}

export interface DurableProjectionHost {
  describe(): { implementationDigest: string; schemaIds: string[] }
  /** Idempotently materialize exactly this sealed artifact into host-owned storage. */
  project(ref: ArtifactRef): Promise<void>
}

export interface ArtifactCheckpoint {
  readonly identityDigest?: string
  hydrate(): Promise<void>
  flush(): Promise<void>
}

type Head = { seq: number; digest: string }
type FullRecord<T extends JsonValue> = { seq: number; previous: string | null; event: string; state: T }
type StatePatch = { path: string[]; kind: 'set'; value: JsonValue } | { path: string[]; kind: 'delete' }
type DeltaRecord = { format: 2; seq: number; previous: string; event: string;
  patch: StatePatch[]; stateDigest: string }
type RecordValue<T extends JsonValue> = FullRecord<T> | DeltaRecord

function objectValue(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A nested immutable-state delta; arrays are replaced as one value. */
function statePatch(before: JsonValue, after: JsonValue): StatePatch[] {
  const patch: StatePatch[] = []
  const visit = (oldValue: JsonValue, newValue: JsonValue, path: string[]): void => {
    if (oldValue === newValue) return
    if (objectValue(oldValue) && objectValue(newValue)) {
      // Native JSON serialization cheaply skips large unchanged subtrees.
      // Unequal serialization only asks the walker to inspect them; ordering
      // differences cannot cause a false equality or omit a changed value.
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return
      const keys = [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])].sort()
      for (const key of keys) {
        const child = [...path, key]
        if (!Object.hasOwn(newValue, key)) patch.push({ path: child, kind: 'delete' })
        else if (!Object.hasOwn(oldValue, key)) patch.push({ path: child, kind: 'set', value: newValue[key]! })
        else visit(oldValue[key]!, newValue[key]!, child)
      }
    } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) patch.push({ path, kind: 'set', value: newValue })
    } else if (!Object.is(oldValue, newValue)) patch.push({ path, kind: 'set', value: newValue })
  }
  visit(before, after, [])
  return patch
}

function applyStatePatch<T extends JsonValue>(previous: T, patch: StatePatch[]): T {
  if (!Array.isArray(patch)) throw new Error('Journal-backed campaign patch drift')
  // The journal read gave us a private JSON tree. Mutating that reconstruction
  // avoids cloning the complete growing Campaign state for every small delta.
  let next: JsonValue = previous
  type PathNode = { terminal: boolean; children: Map<string, PathNode> }
  const seen: PathNode = { terminal: false, children: new Map() }
  for (const operation of patch) {
    if (!operation || !Array.isArray(operation.path)
      || !operation.path.every(segment => typeof segment === 'string'))
      throw new Error('Journal-backed campaign patch path drift')
    for (const segment of operation.path) assertSafeKey(segment)
    let node = seen
    for (const segment of operation.path) {
      if (node.terminal) throw new Error('Journal-backed campaign overlapping patch paths')
      let child = node.children.get(segment)
      if (!child) { child = { terminal: false, children: new Map() }; node.children.set(segment, child) }
      node = child
    }
    if (node.terminal || node.children.size) throw new Error('Journal-backed campaign overlapping patch paths')
    node.terminal = true
    if (!operation.path.length) {
      if (operation.kind !== 'set' || !Object.hasOwn(operation, 'value'))
        throw new Error('Journal-backed campaign root patch drift')
      next = structuredClone(operation.value)
      continue
    }
    let parent: JsonValue = next
    for (const segment of operation.path.slice(0, -1)) {
      if (!objectValue(parent) || !Object.hasOwn(parent, segment))
        throw new Error('Journal-backed campaign patch parent drift')
      parent = parent[segment]!
    }
    if (!objectValue(parent)) throw new Error('Journal-backed campaign patch parent drift')
    const key = operation.path.at(-1)!
    if (operation.kind === 'set') {
      if (!Object.hasOwn(operation, 'value')) throw new Error('Journal-backed campaign patch value drift')
      parent[key] = structuredClone(operation.value)
    } else if (operation.kind === 'delete') {
      if (!Object.hasOwn(parent, key)) throw new Error('Journal-backed campaign patch deletion drift')
      delete parent[key]
    } else throw new Error('Journal-backed campaign patch operation drift')
  }
  return next as T
}

function safeRoundId(roundId: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(roundId)) throw new Error('Unsafe campaign round id')
}

async function publish<T>(journal: SearchJournal, key: string, value: T): Promise<void> {
  try { await journal.write(key, value) }
  catch (error) {
    // An acknowledged write may be lost after durable publication. Recovery
    // compares the exact value; it never assumes an unobserved write failed.
    const observed = await journal.read<T>(key)
    if (observed === undefined || canonicalJson(observed as JsonValue) !== canonicalJson(value as JsonValue)) throw error
  }
}

/**
 * A SearchJournal-backed campaign head. The surrounding SearchJournal contract
 * requires the evolution's single writer lock; arbitrary SearchJournal.write
 * does not provide a compare-and-swap primitive. No external operation starts
 * until commit has published the head through that journal.
 */
export class JournalCampaignStore<T extends JsonValue> implements CampaignStoreLike<T> {
  readonly requiresArtifactCheckpoint = true as const
  readonly writerHydrates = true as const
  readonly identityDigest: string
  readonly projectionSchemas: readonly string[]
  private readonly projectionManifest: ReturnType<DurableProjectionHost['describe']> | null
  private readonly projectedRefs: ArtifactRef[] = []
  private readonly prefix: string
  private cached: { state: T; seq: number; digest: string } | null = null
  private hydrated = false
  private leased = false
  private readonly context = new AsyncLocalStorage<boolean>()
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly journal: SearchJournal, roundId: string,
    readonly options: { afterCommit?: (state: T, phase: 'hydrate' | 'commit') => Promise<void>;
      projectorIdentityDigest?: string; projectionHost?: DurableProjectionHost } = {}) {
    safeRoundId(roundId)
    if (options.afterCommit) {
      if (!options.projectorIdentityDigest) throw new Error('Campaign projector identity required')
      assertDigest(options.projectorIdentityDigest)
    }
    const projectionManifest = options.projectionHost?.describe() ?? null
    if (projectionManifest) {
      assertDigest(projectionManifest.implementationDigest)
      if (!Array.isArray(projectionManifest.schemaIds) || projectionManifest.schemaIds.length === 0
        || projectionManifest.schemaIds.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]+$/u.test(id))
        || new Set(projectionManifest.schemaIds).size !== projectionManifest.schemaIds.length
        || projectionManifest.schemaIds.some((id, index) => index > 0 && projectionManifest.schemaIds[index - 1]! > id))
        throw new Error('Invalid durable projection manifest')
    }
    this.projectionManifest = projectionManifest === null ? null : structuredClone(projectionManifest)
    this.projectionSchemas = Object.freeze([...(projectionManifest?.schemaIds ?? [])])
    this.prefix = `rounds/${roundId}/campaign/state`
    this.identityDigest = implementationClosureDigest(['runtime/persistence'], {
      backend: 'campaign-state', roundId, projectorIdentityDigest: options.projectorIdentityDigest ?? null,
      projectionManifest: this.projectionManifest })
  }

  private async projectDurable(state: T): Promise<void> {
    const refs = (state as { durableProjections?: ArtifactRef[] }).durableProjections ?? []
    if (!Array.isArray(refs) || this.projectedRefs.length > refs.length)
      throw new Error('Campaign durable projection history drift')
    for (let index = 0; index < this.projectedRefs.length; index++)
      if (canonicalJson(this.projectedRefs[index]) !== canonicalJson(refs[index]))
        throw new Error('Campaign durable projection history drift')
    if (refs.length === 0) return
    const host = this.options.projectionHost
    if (!host || canonicalJson(host.describe()) !== canonicalJson(this.projectionManifest))
      throw new Error('Campaign durable projection host identity drift')
    for (let index = this.projectedRefs.length; index < refs.length; index++) {
      const ref = refs[index]!
      if (!ref || ref.kind !== 'artifact' || typeof ref.schemaId !== 'string'
        || !this.projectionSchemas.includes(ref.schemaId))
        throw new Error('Campaign durable projection schema drift')
      await host.project(structuredClone(ref))
      this.projectedRefs.push(structuredClone(ref))
    }
  }

  private assertProjectionAppendOnly(state: T): void {
    const previous = (this.cached?.state as { durableProjections?: ArtifactRef[] } | undefined)?.durableProjections ?? []
    const next = (state as { durableProjections?: ArtifactRef[] }).durableProjections ?? []
    if (!Array.isArray(next) || next.length < previous.length)
      throw new Error('Campaign durable projection history drift')
    for (let index = 0; index < previous.length; index++)
      if (canonicalJson(previous[index]) !== canonicalJson(next[index]))
        throw new Error('Campaign durable projection history drift')
    if (next.length && (!this.options.projectionHost
      || canonicalJson(this.options.projectionHost.describe()) !== canonicalJson(this.projectionManifest)))
      throw new Error('Campaign durable projection host identity drift')
    for (const ref of next) if (!ref || ref.kind !== 'artifact' || typeof ref.schemaId !== 'string'
      || !this.projectionSchemas.includes(ref.schemaId))
      throw new Error('Campaign durable projection schema drift')
  }

  private recordKey(digest: string): string { return `${this.prefix}/records/${digest}` }
  private headKey(): string { return `${this.prefix}/head` }

  async hydrate(): Promise<void> {
    this.projectedRefs.length = 0
    const head = await this.journal.read<Head>(this.headKey())
    if (head === undefined) { this.cached = null; this.hydrated = true; return }
    if (!Number.isSafeInteger(head.seq) || head.seq < 0) throw new Error('Corrupt journal-backed campaign head')
    assertDigest(head.digest)
    let current: string | null = head.digest
    let expected = head.seq
    const chain: Array<{ record: RecordValue<T>; privateBytes: boolean }> = []
    const seen = new Set<string>()
    while (current !== null) {
      assertDigest(current)
      if (seen.has(current)) throw new Error('Journal-backed campaign cycle')
      seen.add(current)
      const saved: RecordValue<T> | string | undefined =
        await this.journal.read<RecordValue<T> | string>(this.recordKey(current))
      // New records store their exact canonical bytes. Hashing those bytes on
      // every resume verifies the complete chain without re-rendering every
      // historical Campaign state. Older object records remain readable.
      const bytes = typeof saved === 'string' ? saved : saved === undefined ? null : canonicalJson(saved)
      if (bytes === null || sha256(bytes) !== current) throw new Error('Journal-backed campaign record drift')
      let record: RecordValue<T>
      try { record = typeof saved === 'string' ? JSON.parse(saved) as RecordValue<T> : saved! }
      catch (error) { throw new Error('Journal-backed campaign record drift', { cause: error }) }
      if (!record || record.seq !== expected
        || typeof record.event !== 'string') throw new Error('Journal-backed campaign record drift')
      assertJson(record as unknown)
      if ('state' in record) {
        if (Object.hasOwn(record, 'format') || Object.hasOwn(record, 'patch'))
          throw new Error('Journal-backed campaign full record drift')
      } else if (record.format !== 2 || !Array.isArray(record.patch)
        || !Object.hasOwn(record, 'stateDigest') || typeof record.stateDigest !== 'string'
        || typeof record.previous !== 'string') throw new Error('Journal-backed campaign delta record drift')
      chain.push({ record, privateBytes: typeof saved === 'string' })
      current = record.previous
      expected--
    }
    if (expected !== -1 || !chain.length) throw new Error('Incomplete journal-backed campaign chain')
    let latest: T | undefined
    for (const entry of chain.reverse()) {
      const { record } = entry
      // SearchJournal.read does not promise a detached object. A legacy full
      // record may be a shared reference; detach it once before delta replay.
      if ('state' in record) latest = entry.privateBytes ? record.state : structuredClone(record.state)
      else {
        if (latest === undefined) throw new Error('Journal-backed campaign delta lacks a base state')
        latest = applyStatePatch(latest, record.patch)
      }
    }
    if (latest === undefined) throw new Error('Incomplete journal-backed campaign chain')
    const headRecord = chain.at(-1)!.record
    if (!('state' in headRecord) && sha256(canonicalJson(latest)) !== headRecord.stateDigest)
      throw new Error('Journal-backed campaign reconstructed state drift')
    this.cached = { state: latest, seq: head.seq, digest: head.digest }
    this.hydrated = true
  }

  /** Called only after the Kernel validates campaign and artifact identity. */
  async recoverProjection(): Promise<void> {
    if (!this.hydrated) throw new Error('Journal-backed campaign must hydrate before projection recovery')
    if (this.cached) {
      await this.options.afterCommit?.(structuredClone(this.cached.state), 'hydrate')
      await this.projectDurable(this.cached.state)
    }
  }

  load(): { state: T; seq: number; digest: string } | null {
    if (!this.hydrated) throw new Error('Journal-backed campaign must hydrate before load')
    return this.cached === null ? null : structuredClone(this.cached)
  }

  assertLease(): void { if (!this.leased || !this.context.getStore()) throw new Error('Campaign writer lease lost or absent') }

  async withWriter<R>(work: () => Promise<R>): Promise<R> {
    if (this.context.getStore()) throw new Error('Nested campaign writer')
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      await this.hydrate()
      this.leased = true
      return await this.context.run(true, work)
    } finally {
      this.leased = false
      release()
    }
  }

  async commit(state: T, event: string): Promise<void> {
    this.assertLease()
    assertJson(state)
    this.assertProjectionAppendOnly(state)
    if (!event) throw new Error('Campaign journal event required')
    const published = await this.journal.read<Head>(this.headKey())
    if ((published?.digest ?? null) !== (this.cached?.digest ?? null)
      || (published?.seq ?? -1) !== (this.cached?.seq ?? -1))
      throw new Error('Journal-backed campaign head changed under writer')
    const record: RecordValue<T> = this.cached === null
      ? { seq: 0, previous: null, event, state }
      : { format: 2, seq: this.cached.seq + 1, previous: this.cached.digest, event,
        patch: statePatch(this.cached.state, state), stateDigest: sha256(canonicalJson(state)) }
    const bytes = canonicalJson(record)
    const digest = sha256(bytes)
    const existing = await this.journal.read<RecordValue<T> | string>(this.recordKey(digest))
    if (existing !== undefined && (typeof existing === 'string' ? existing : canonicalJson(existing)) !== bytes)
      throw new Error('Immutable campaign record conflict')
    if (existing === undefined) await publish(this.journal, this.recordKey(digest), bytes)
    await publish(this.journal, this.headKey(), { seq: record.seq, digest })
    this.cached = { state: structuredClone(state), seq: record.seq, digest }
    await this.options.afterCommit?.(structuredClone(state), 'commit')
    await this.projectDurable(state)
  }
}

/** Sync artifact reads for reducers, with an explicit async durability barrier. */
export class JournalArtifactStore extends FileArtifactStore implements ArtifactCheckpoint {
  readonly identityDigest: string
  private readonly prefix: string
  private readonly published = new Set<string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(root: string, readonly journal: SearchJournal, roundId: string, maxBytes?: number) {
    super(root, maxBytes)
    safeRoundId(roundId)
    this.prefix = `rounds/${roundId}/campaign/artifacts`
    this.identityDigest = implementationClosureDigest(['runtime/persistence'], { backend: 'artifact-cache', roundId, maxBytes: this.maxBytes })
  }

  private indexKey(): string { return `${this.prefix}/index` }
  private objectKey(digest: string): string { return `${this.prefix}/objects/${digest}` }

  async hydrate(): Promise<void> {
    const saved = await this.journal.read<{ digests: string[] }>(this.indexKey())
    if (saved !== undefined && (!Array.isArray(saved?.digests) || new Set(saved.digests).size !== saved.digests.length))
      throw new Error('Journal-backed artifact index drift')
    for (const digest of saved?.digests ?? []) {
      assertDigest(digest)
      const raw = await this.journal.read<string>(this.objectKey(digest))
      if (typeof raw !== 'string' || sha256(raw) !== digest) throw new Error('Journal-backed artifact drift')
      const path = join(this.root, 'objects', `${digest}.json`)
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== raw) throw new Error('Local artifact cache drift')
      } else durableWrite(path, raw)
      this.published.add(digest)
    }
  }

  async flush(): Promise<void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      // Merge the current index and this adapter's prior writes at each
      // durability barrier. Verify each published remote/local pair once.
      const savedIndex = await this.journal.read<{ digests: string[] }>(this.indexKey())
      if (savedIndex !== undefined && (!Array.isArray(savedIndex?.digests)
        || new Set(savedIndex.digests).size !== savedIndex.digests.length))
        throw new Error('Journal-backed artifact index drift')
      for (const digest of new Set([...this.published, ...(savedIndex?.digests ?? [])])) {
        assertDigest(digest)
        const raw = await this.journal.read<string>(this.objectKey(digest))
        if (typeof raw !== 'string' || sha256(raw) !== digest) throw new Error('Journal-backed artifact drift')
        const path = join(this.root, 'objects', `${digest}.json`)
        if (existsSync(path)) {
          if (readFileSync(path, 'utf8') !== raw) throw new Error('Local artifact cache drift')
        } else durableWrite(path, raw)
        this.published.add(digest)
      }
      const files = readdirSync(join(this.root, 'objects')).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()
      for (const file of files) {
        const digest = file.slice(0, -5)
        if (this.published.has(digest)) continue
        const raw = readFileSync(join(this.root, 'objects', file), 'utf8')
        if (sha256(raw) !== digest) throw new Error('Local artifact cache drift')
        const existing = await this.journal.read<string>(this.objectKey(digest))
        if (existing !== undefined && existing !== raw) throw new Error('Immutable artifact conflict')
        if (existing === undefined) await publish(this.journal, this.objectKey(digest), raw)
        this.published.add(digest)
      }
      const index = { digests: [...this.published].sort() }
      if (canonicalJson(savedIndex ?? null) !== canonicalJson(index)) await publish(this.journal, this.indexKey(), index)
    } finally { release() }
  }
}

export interface ProviderRecordBackend {
  read<T>(kind: string, operationId: string): Promise<T | undefined>
  create<T>(kind: string, operationId: string, value: T): Promise<{ record: T; created: boolean }>
  write<T>(kind: string, operationId: string, value: T): Promise<void>
}

/** Keeps the established local record layout while sharing the async SPI. */
export class FileProviderRecordBackend implements ProviderRecordBackend {
  readonly identityDigest: string
  constructor(readonly root: string, readonly directoryAliases: Readonly<Record<string, string>> = {}) {
    for (const [kind, directory] of Object.entries(directoryAliases)) {
      if (!/^[a-z][a-z0-9.-]*$/u.test(kind) || !/^[a-z][a-z0-9.-]*$/u.test(directory))
        throw new Error('Unsafe provider record directory alias')
    }
    this.identityDigest = implementationClosureDigest(['runtime/persistence'], { backend: 'file-provider-record', directoryAliases })
  }
  private path(kind: string, operationId: string): string {
    if (!/^[a-z][a-z0-9.-]*$/u.test(kind)) throw new Error('Unsafe provider kind')
    assertDigest(operationId)
    const directory = join(this.root, this.directoryAliases[kind] ?? kind)
    mkdirSync(directory, { recursive: true })
    return join(directory, `${operationId}.json`)
  }
  async read<T>(kind: string, operationId: string): Promise<T | undefined> {
    const path = this.path(kind, operationId)
    if (!existsSync(path)) return undefined
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    assertJson(value)
    return value as T
  }
  async create<T>(kind: string, operationId: string, value: T): Promise<{ record: T; created: boolean }> {
    assertJson(value)
    const created = durableCreate(this.path(kind, operationId), canonicalJson(value as JsonValue))
    const record = await this.read<T>(kind, operationId)
    if (record === undefined) throw new Error('Provider record vanished after create')
    return { record, created }
  }
  async write<T>(kind: string, operationId: string, value: T): Promise<void> {
    assertJson(value)
    durableWrite(this.path(kind, operationId), canonicalJson(value as JsonValue))
  }
}

/** Provider intent records use the same SearchJournal and are awaited before effects. */
export class SearchJournalProviderRecordBackend implements ProviderRecordBackend {
  readonly identityDigest: string
  private readonly prefix: string
  constructor(readonly journal: SearchJournal, roundId: string) {
    safeRoundId(roundId)
    this.prefix = `rounds/${roundId}/campaign/providers`
    this.identityDigest = implementationClosureDigest(['runtime/persistence'], { backend: 'provider-record', roundId })
  }
  private key(kind: string, operationId: string): string {
    if (!/^[a-z][a-z0-9.-]*$/u.test(kind)) throw new Error('Unsafe provider kind')
    assertDigest(operationId)
    return `${this.prefix}/${sha256(kind)}/${operationId}`
  }
  async read<T>(kind: string, operationId: string): Promise<T | undefined> {
    return this.journal.read<T>(this.key(kind, operationId))
  }
  async create<T>(kind: string, operationId: string, value: T): Promise<{ record: T; created: boolean }> {
    const key = this.key(kind, operationId)
    assertJson(value)
    const existing = await this.journal.read<T>(key)
    if (existing !== undefined) return { record: existing, created: false }
    await publish(this.journal, key, value)
    return { record: structuredClone(value), created: true }
  }
  async write<T>(kind: string, operationId: string, value: T): Promise<void> {
    assertJson(value)
    await publish(this.journal, this.key(kind, operationId), value)
  }
}
