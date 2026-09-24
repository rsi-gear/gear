import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore, assertDigest, durableWrite, sha256 } from '../artifacts.js'
import { assertJson, canonicalJson, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { durableCreate } from '../providers/provider-record.js'
import type { SearchJournal } from '../../search/store.js'

export interface CampaignStoreLike<T extends JsonValue> {
  readonly requiresArtifactCheckpoint?: true
  readonly identityDigest?: string
  hydrate?(): Promise<void>
  recoverProjection?(): Promise<void>
  load(): { state: T; seq: number; digest: string } | null
  withWriter<R>(work: () => Promise<R>): Promise<R>
  assertLease(): void
  commit(state: T, event: string): Promise<void>
}

export interface ArtifactCheckpoint {
  readonly identityDigest?: string
  hydrate(): Promise<void>
  flush(): Promise<void>
}

type Head = { seq: number; digest: string }
type RecordValue<T extends JsonValue> = { seq: number; previous: string | null; event: string; state: T }

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
  readonly identityDigest: string
  private readonly prefix: string
  private cached: { state: T; seq: number; digest: string } | null = null
  private hydrated = false
  private leased = false
  private readonly context = new AsyncLocalStorage<boolean>()
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly journal: SearchJournal, roundId: string,
    readonly options: { afterCommit?: (state: T, phase: 'hydrate' | 'commit') => Promise<void>;
      projectorIdentityDigest?: string } = {}) {
    safeRoundId(roundId)
    if (options.afterCommit) {
      if (!options.projectorIdentityDigest) throw new Error('Campaign projector identity required')
      assertDigest(options.projectorIdentityDigest)
    }
    this.prefix = `rounds/${roundId}/campaign/state`
    this.identityDigest = implementationClosureDigest(['runtime/persistence'], {
      backend: 'campaign-state', roundId, projectorIdentityDigest: options.projectorIdentityDigest ?? null })
  }

  private recordKey(digest: string): string { return `${this.prefix}/records/${digest}` }
  private headKey(): string { return `${this.prefix}/head` }

  async hydrate(): Promise<void> {
    const head = await this.journal.read<Head>(this.headKey())
    if (head === undefined) { this.cached = null; this.hydrated = true; return }
    if (!Number.isSafeInteger(head.seq) || head.seq < 0) throw new Error('Corrupt journal-backed campaign head')
    assertDigest(head.digest)
    let current: string | null = head.digest
    let expected = head.seq
    let latest: T | undefined
    const seen = new Set<string>()
    while (current !== null) {
      assertDigest(current)
      if (seen.has(current)) throw new Error('Journal-backed campaign cycle')
      seen.add(current)
      const record: RecordValue<T> | undefined = await this.journal.read<RecordValue<T>>(this.recordKey(current))
      if (!record || sha256(canonicalJson(record)) !== current || record.seq !== expected
        || typeof record.event !== 'string') throw new Error('Journal-backed campaign record drift')
      assertJson(record as unknown)
      if (latest === undefined) latest = record.state
      current = record.previous
      expected--
    }
    if (expected !== -1 || latest === undefined) throw new Error('Incomplete journal-backed campaign chain')
    this.cached = { state: latest, seq: head.seq, digest: head.digest }
    this.hydrated = true
  }

  /** Called only after the Kernel validates campaign and artifact identity. */
  async recoverProjection(): Promise<void> {
    if (!this.hydrated) throw new Error('Journal-backed campaign must hydrate before projection recovery')
    if (this.cached) await this.options.afterCommit?.(structuredClone(this.cached.state), 'hydrate')
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
    if (!event) throw new Error('Campaign journal event required')
    const published = await this.journal.read<Head>(this.headKey())
    if ((published?.digest ?? null) !== (this.cached?.digest ?? null)
      || (published?.seq ?? -1) !== (this.cached?.seq ?? -1))
      throw new Error('Journal-backed campaign head changed under writer')
    const record: RecordValue<T> = { seq: this.cached === null ? 0 : this.cached.seq + 1,
      previous: this.cached?.digest ?? null, event, state }
    const digest = sha256(canonicalJson(record))
    const existing = await this.journal.read<RecordValue<T>>(this.recordKey(digest))
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('Immutable campaign record conflict')
    if (!existing) await publish(this.journal, this.recordKey(digest), record)
    await publish(this.journal, this.headKey(), { seq: record.seq, digest })
    this.cached = { state: structuredClone(state), seq: record.seq, digest }
    await this.options.afterCommit?.(structuredClone(state), 'commit')
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
      await this.hydrate()
      const files = readdirSync(join(this.root, 'objects')).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()
      for (const file of files) {
        const digest = file.slice(0, -5)
        const raw = readFileSync(join(this.root, 'objects', file), 'utf8')
        if (sha256(raw) !== digest) throw new Error('Local artifact cache drift')
        if (this.published.has(digest)) continue
        const existing = await this.journal.read<string>(this.objectKey(digest))
        if (existing !== undefined && existing !== raw) throw new Error('Immutable artifact conflict')
        if (existing === undefined) await publish(this.journal, this.objectKey(digest), raw)
        this.published.add(digest)
      }
      const index = { digests: [...this.published].sort() }
      const saved = await this.journal.read<typeof index>(this.indexKey())
      if (canonicalJson(saved ?? null) !== canonicalJson(index)) await publish(this.journal, this.indexKey(), index)
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
