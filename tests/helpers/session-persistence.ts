import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { PersistenceCoordinator, SessionPersistence, SessionPersistenceRevision,
  type PersistenceBackend, type StoredPrefix } from '@deepseek-ai/dsh-session-persistence'

/** Keeps only committed data across independent DSH contexts. No empty-session shortcut. */
export class MemorySessionBackend implements PersistenceBackend {
  readonly name = 'test-memory'
  readonly records = new Map<SessionId, StoredPrefix>()
  async loadStored(id: SessionId) { return structuredClone(this.records.get(id)) }
  async readStoredRevision(id: SessionId) { return this.records.get(id)?.revision }
  async list() { return [...this.records.values()].map(record => structuredClone(record.meta)) }
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], materialized: boolean) {
    const current = this.records.get(meta.id)
    if (materialized !== (current !== undefined)) throw new Error('incorrect materialization state')
    const prefix = current?.events ?? []
    if (events.length === 0 || events[0]!.seq !== prefix.length) throw new Error('non-contiguous persistence append')
    this.records.set(meta.id, {
      meta: structuredClone(meta), events: structuredClone([...prefix, ...events]),
      revision: SessionPersistenceRevision(`${meta.id}:${prefix.length + events.length}`),
    })
  }
  async commitRepair(meta: SessionHeader, _tornMarker: unknown, closers: readonly SessionEvent[]) {
    if (closers.length) await this.appendBatch(meta, closers, true)
  }
}

/** Uses DSH's real write, prepare, repair and resume coordination. */
export class MemorySessionPersistence extends SessionPersistence {
  readonly supportsRawArtifacts = false
  readonly coordinator: PersistenceCoordinator
  constructor(ctx: Context, readonly backend: MemorySessionBackend) {
    super(ctx)
    this.coordinator = new PersistenceCoordinator(ctx, backend)
  }
  locate() { return undefined }
  create(meta: SessionHeader) { return this.coordinator.create(meta) }
  append(id: SessionId, events: readonly SessionEvent[]) { return this.coordinator.append(id, events) }
  prepare(id: SessionId, signal?: AbortSignal) { return this.coordinator.prepare(id, signal) }
  load(id: SessionId) { return this.coordinator.load(id) }
  inspect(id: SessionId, signal?: AbortSignal) { return this.coordinator.inspect(id, signal) }
  readFrom(id: SessionId, seq: number, signal?: AbortSignal) { return this.coordinator.readFrom(id, seq, signal) }
  list() { return this.backend.list() }
  async listSnapshots() {
    return [...this.backend.records.values()].map(record => ({ header: structuredClone(record.meta), revision: record.revision }))
  }
}
