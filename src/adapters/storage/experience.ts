import type { Json } from '../../domain/algorithm-wire.js'
import type {
  ExperienceChunk,
  ExperienceChunkReference,
  ExperienceDescriptor,
  ExperienceIndexEntry,
  ExperienceIndexSnapshot,
  ExperienceRecord,
  ExperienceSnapshot,
  ExperienceView,
} from '../../domain/experience.js'
import type { TrajectoryReference } from '../../domain/trajectory.js'
import { experienceViews } from '../../domain/experience.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import {
  ExperienceFiles,
  MAX_EXPERIENCE_BYTES,
  MAX_EXPERIENCE_DESCRIPTOR_BYTES,
  MAX_EXPERIENCE_FILES,
  MAX_EXPERIENCE_INDEX_BYTES,
  MAX_EXPERIENCE_ITEM_BYTES,
  MAX_EXPERIENCE_OBJECT_BYTES,
} from './experience-files.js'
import {
  detailOwner,
  evidenceOwner,
  experienceObject,
  fail,
  summaryBody,
  verifyChunk,
  verifyDescriptor,
  verifyExperience,
  verifyRecord,
} from './experience-format.js'
export { verifyExperience } from './experience-format.js'
export { MAX_EXPERIENCE_BYTES } from './experience-files.js'

function diffItems(record: ExperienceRecord): Json[] {
  return (experienceObject(record.change).files as Json[]).flatMap((value) => {
    const { patch, ...metadata } = experienceObject(value)
    if (!patch) return [{ ...metadata, patch: patch ?? null, part: 0, parts: 1 }]
    if (typeof patch !== 'string') fail()
    const bytes = Buffer.from(patch),
      chunks: string[] = []
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + 8192, bytes.length)
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
      chunks.push(bytes.subarray(start, end).toString('utf8'))
      start = end
    }
    return chunks.map((chunk, part) => ({ ...metadata, patch: chunk, part, parts: chunks.length }))
  })
}

/** Small immutable indexes authorize separately bounded, content-addressed detail objects. */
export class ExperienceStore {
  readonly files: ExperienceFiles
  constructor(readonly root: string) {
    this.files = new ExperienceFiles(root)
  }
  async read(digest: string): Promise<ExperienceSnapshot> {
    // v2 retains its historical file bound; v3 is rejected above its tighter index bound.
    const snapshot = (await this.files.read(digest, MAX_EXPERIENCE_BYTES)) as ExperienceSnapshot
    verifyExperience(snapshot, digest)
    if (snapshot.version === 3 && Buffer.byteLength(JSON.stringify(snapshot)) > MAX_EXPERIENCE_INDEX_BYTES)
      throw new GearError('experience-size-limit', 'Experience index exceeds 4 MiB')
    return snapshot
  }
  async persistRecord(record: ExperienceRecord): Promise<ExperienceIndexEntry> {
    verifyRecord(record)
    const change = experienceObject(record.change),
      use = experienceObject(record.modification_use)
    const summary = {
      version: 3 as const,
      source: record.source,
      candidate: record.candidate,
      parent: record.parent,
      scope: record.scope,
      proposal: record.proposal,
      change: {
        files: (change.files as Json[]).map((file) => ({ path: String(experienceObject(file).path) })),
      },
      classification: record.classification,
      modification_use: { summary: use.summary! },
      digest: record.digest,
    }
    // The descriptor is bound to this exact summary and the original logical record identity.
    const entry: ExperienceIndexEntry = {
      ...summary,
      summary_digest: canonicalDigest(summary),
      descriptor_digest: '',
    }
    const views = {} as ExperienceDescriptor['views']
    const arrays: Record<ExperienceView, Json[]> = {
      'task-results': record.task_results,
      diff: diffItems(record),
      trajectory: record.trajectory_refs as unknown as Json[],
      'modification-use': use.trials as Json[],
      verifier: record.verifier_trials,
    }
    for (const view of experienceViews) {
      views[view] = []
      let items: Json[] = [],
        size = 0
      const flush = async () => {
        if (!items.length) return
        const first = experienceObject(items[0])
        const owner =
          view === 'verifier'
            ? {
                ...evidenceOwner(entry),
                candidate_id: first.candidate_id!,
                task_id: first.task_id!,
                repetition: first.repetition!,
              }
            : detailOwner(entry, view)
        const body = { version: 3 as const, kind: 'items' as const, view, owner, items }
        const chunk: ExperienceChunk = { ...body, digest: canonicalDigest(body) }
        verifyChunk(chunk, chunk.digest, items.length, entry, view)
        await this.files.publish(chunk, MAX_EXPERIENCE_OBJECT_BYTES, true)
        views[view].push({ digest: chunk.digest, count: items.length })
        items = []
        size = 0
      }
      if (!Array.isArray(arrays[view])) fail()
      for (const item of arrays[view]) {
        const length = Buffer.byteLength(JSON.stringify(item))
        const reserved =
          view === 'modification-use' ? Buffer.byteLength(JSON.stringify({ summary: use.summary })) : 0
        if (length > MAX_EXPERIENCE_ITEM_BYTES || length + reserved > 64 * 1024 - 2048)
          throw new GearError('experience-size-limit', 'Experience item exceeds the bounded read size')
        if (items.length && (view === 'verifier' || size + length > 192 * 1024)) await flush()
        items.push(item)
        size += length
      }
      await flush()
    }
    const { files: _files, ...changeMetadata } = change
    const { trials: _trials, ...useMetadata } = use
    const body = {
      version: 3 as const,
      kind: 'record' as const,
      record_digest: record.digest,
      summary_digest: entry.summary_digest,
      owner: evidenceOwner(entry),
      metadata: { change: changeMetadata, modification_use: useMetadata },
      views,
      trajectory_availability: record.trajectory_refs.some((ref) => ref.status === 'available')
        ? ('available' as const)
        : record.trajectory_refs.length
          ? ('unavailable' as const)
          : ('not_captured' as const),
    }
    const descriptor: ExperienceDescriptor = { ...body, digest: canonicalDigest(body) }
    entry.descriptor_digest = descriptor.digest
    verifyRecord(entry)
    verifyDescriptor(descriptor, entry)
    await this.files.publish(descriptor, MAX_EXPERIENCE_DESCRIPTOR_BYTES, true)
    return entry
  }
  async descriptor(
    snapshot: ExperienceSnapshot,
    record: ExperienceIndexEntry,
  ): Promise<ExperienceDescriptor> {
    if (
      snapshot.version !== 3 ||
      !snapshot.records.some(
        (item) =>
          item.digest === record.digest &&
          item.descriptor_digest === record.descriptor_digest &&
          canonicalDigest(summaryBody(item)) === canonicalDigest(summaryBody(record)),
      )
    )
      fail()
    const value = (await this.files.read(
      record.descriptor_digest,
      MAX_EXPERIENCE_DESCRIPTOR_BYTES,
      true,
    )) as ExperienceDescriptor
    verifyDescriptor(value, record)
    return value
  }
  private async chunk(record: ExperienceIndexEntry, view: ExperienceView, ref: ExperienceChunkReference) {
    const value = (await this.files.read(ref.digest, MAX_EXPERIENCE_OBJECT_BYTES, true)) as ExperienceChunk
    verifyChunk(value, ref.digest, ref.count, record, view)
    return value
  }
  async readItems(
    snapshot: ExperienceIndexSnapshot,
    record: ExperienceIndexEntry,
    view: ExperienceView,
    start: number,
    limit: number,
  ): Promise<Json[]> {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !experienceViews.includes(view)
    )
      fail()
    const descriptor = await this.descriptor(snapshot, record),
      result: Json[] = []
    let offset = 0
    for (const ref of descriptor.views[view]) {
      if (offset + ref.count > start && offset < start + limit) {
        const chunk = await this.chunk(record, view, ref)
        result.push(...chunk.items.slice(Math.max(0, start - offset), start + limit - offset))
      }
      offset += ref.count
      if (offset >= start + limit) break
    }
    return result
  }
  async *trajectoryReferences(
    snapshot: ExperienceSnapshot,
    record: ExperienceRecord | ExperienceIndexEntry,
  ): AsyncGenerator<TrajectoryReference> {
    if (record.version === 2) {
      for (const reference of record.trajectory_refs) {
        if (
          !record.scope.task_ids.includes(reference.task_id) ||
          ![record.candidate.id, record.parent.id].includes(reference.candidate_id) ||
          !Number.isSafeInteger(reference.repetition) ||
          reference.repetition < 0 ||
          reference.repetition >= record.scope.repetitions ||
          !/^trajectory:[a-f0-9]{64}$/u.test(reference.ref)
        )
          fail()
        yield reference
      }
      return
    }
    const descriptor = await this.descriptor(snapshot, record)
    for (const ref of descriptor.views.trajectory) {
      const chunk = await this.chunk(record, 'trajectory', ref)
      yield* chunk.items as unknown as TrajectoryReference[]
    }
  }
  private async *objects(snapshot: ExperienceSnapshot) {
    const seen = new Set<string>([snapshot.digest])
    if (snapshot.version === 2) return
    for (const record of snapshot.records) {
      const descriptor = await this.descriptor(snapshot, record)
      if (!seen.has(descriptor.digest)) {
        seen.add(descriptor.digest)
        yield { value: descriptor, maximum: MAX_EXPERIENCE_DESCRIPTOR_BYTES }
      }
      for (const view of experienceViews)
        for (const ref of descriptor.views[view]) {
          // Validate scope even for a shared object reused by another record.
          const chunk = await this.chunk(record, view, ref)
          if (!seen.has(chunk.digest)) {
            seen.add(chunk.digest)
            yield { value: chunk, maximum: MAX_EXPERIENCE_OBJECT_BYTES }
          }
          if (seen.size > MAX_EXPERIENCE_FILES)
            throw new GearError('experience-size-limit', 'Experience closure exceeds 100000 files')
        }
    }
  }
  async verifyClosure(snapshot: ExperienceSnapshot): Promise<{ files: number; bytes: number }> {
    verifyExperience(snapshot, snapshot.digest)
    let files = 1,
      bytes = Buffer.byteLength(JSON.stringify(snapshot))
    for await (const object of this.objects(snapshot)) {
      files++
      bytes += Buffer.byteLength(JSON.stringify(object.value))
    }
    return { files, bytes }
  }
  async copyClosure(
    snapshot: ExperienceSnapshot,
    destinationRoot: string,
  ): Promise<{ files: number; bytes: number }> {
    verifyExperience(snapshot, snapshot.digest)
    const destination = new ExperienceFiles(destinationRoot)
    let files = 1,
      bytes = Buffer.byteLength(JSON.stringify(snapshot))
    for await (const object of this.objects(snapshot)) {
      await destination.publish(object.value, object.maximum, true)
      files++
      bytes += Buffer.byteLength(JSON.stringify(object.value))
    }
    await destination.publish(
      snapshot,
      snapshot.version === 2 ? MAX_EXPERIENCE_BYTES : MAX_EXPERIENCE_INDEX_BYTES,
    )
    return { files, bytes }
  }
  async save(snapshot: ExperienceSnapshot): Promise<void> {
    await this.verifyClosure(snapshot)
    // Publishing the index is the sole commit point; orphaned dependencies grant no access.
    await this.files.publish(
      snapshot,
      snapshot.version === 2 ? MAX_EXPERIENCE_BYTES : MAX_EXPERIENCE_INDEX_BYTES,
    )
  }
}
