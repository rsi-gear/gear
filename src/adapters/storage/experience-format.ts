import type { Json } from '../../domain/algorithm-wire.js'
import type {
  ExperienceChunk,
  ExperienceDescriptor,
  ExperienceIndexEntry,
  ExperienceRecord,
  ExperienceSnapshot,
  ExperienceView,
} from '../../domain/experience.js'
import { experienceViews } from '../../domain/experience.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { MAX_EXPERIENCE_FILES, MAX_EXPERIENCE_ITEM_BYTES, validExperienceDigest } from './experience-files.js'

export function experienceObject(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, Json>
}
export function fail(): never {
  throw new GearError('experience-identity-mismatch', 'Frozen seed experience identity or scope changed')
}
function checkedDigest(value: { digest: string }, expected = value.digest): void {
  const { digest, ...body } = value
  if (!validExperienceDigest(digest) || digest !== expected || canonicalDigest(body) !== digest) fail()
}
export function summaryBody(record: ExperienceIndexEntry) {
  const { summary_digest: _summary, descriptor_digest: _descriptor, ...body } = record
  return body
}
export function verifyRecord(record: ExperienceRecord | ExperienceIndexEntry, runId?: string): void {
  if (record.version === 2) {
    // Historical v2 validation did not require source/proposal/detail fields that v3 indexes need.
    checkedDigest(record)
    if (
      record.scope?.partition !== 'seed' ||
      record.candidate?.parent_id !== record.parent?.id ||
      (runId !== undefined &&
        record.source &&
        Object.hasOwn(record.source, 'run_id') &&
        record.source.run_id !== runId)
    )
      fail()
    return
  }
  if (record.version !== 3) fail()
  const scope = record.scope
  if (
    !scope ||
    scope.partition !== 'seed' ||
    !Array.isArray(scope.task_ids) ||
    !scope.task_ids.length ||
    scope.task_ids.some((id) => typeof id !== 'string' || !id) ||
    new Set(scope.task_ids).size !== scope.task_ids.length ||
    !Number.isSafeInteger(scope.repetitions) ||
    scope.repetitions < 1 ||
    !record.candidate ||
    !record.parent ||
    typeof record.candidate.id !== 'string' ||
    typeof record.parent.id !== 'string' ||
    record.candidate.parent_id !== record.parent.id ||
    !validExperienceDigest(record.candidate.digest) ||
    !validExperienceDigest(record.parent.digest) ||
    !record.source ||
    typeof record.source.run_id !== 'string' ||
    (runId !== undefined && record.source.run_id !== runId) ||
    !record.proposal ||
    typeof record.proposal.rationale !== 'string' ||
    typeof record.proposal.hypothesis !== 'string' ||
    !Array.isArray(record.proposal.semantic_targets) ||
    record.proposal.semantic_targets.some((item) => typeof item !== 'string') ||
    !Array.isArray(experienceObject(record.change).files) ||
    (experienceObject(record.change).files as Json[]).some(
      (item) => typeof experienceObject(item).path !== 'string',
    ) ||
    !experienceObject(experienceObject(record.modification_use).summary) ||
    !experienceObject(record.classification)
  )
    fail()
  if (
    !validExperienceDigest(record.digest) ||
    !validExperienceDigest(record.descriptor_digest) ||
    record.summary_digest !== canonicalDigest(summaryBody(record))
  )
    fail()
}
export function verifyExperience(snapshot: ExperienceSnapshot, digest: string): void {
  checkedDigest(snapshot, digest)
  if (
    ![2, 3].includes(snapshot.version) ||
    (snapshot.version === 3 &&
      (typeof snapshot.run_id !== 'string' ||
        !validExperienceDigest(snapshot.source_archive_digest) ||
        typeof snapshot.implementation_identity !== 'string')) ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length > 4096 ||
    new Set(snapshot.records.map((record) => record.candidate?.id)).size !== snapshot.records.length
  )
    fail()
  for (const record of snapshot.records) {
    if (record.version !== snapshot.version) fail()
    verifyRecord(record, snapshot.run_id)
  }
}
export function evidenceOwner(record: ExperienceRecord | ExperienceIndexEntry): Record<string, Json> {
  return Object.fromEntries(
    ['run_id', 'benchmark_digest', 'evaluation_identity', 'objective_identity', 'objective_digest'].map(
      (key) => [key, record.source[key] ?? null],
    ),
  )
}
export function detailOwner(record: ExperienceIndexEntry, view: ExperienceView): Record<string, Json> {
  return {
    run_id: record.source.run_id!,
    record_digest: record.digest,
    summary_digest: record.summary_digest,
    view,
  }
}
export function verifyDescriptor(value: ExperienceDescriptor, record: ExperienceIndexEntry): void {
  checkedDigest(value, record.descriptor_digest)
  if (
    value.version !== 3 ||
    value.kind !== 'record' ||
    value.record_digest !== record.digest ||
    value.summary_digest !== record.summary_digest ||
    canonicalDigest(value.owner) !== canonicalDigest(evidenceOwner(record)) ||
    !value.metadata ||
    !value.views ||
    Object.keys(value.views).sort().join() !== [...experienceViews].sort().join() ||
    !['available', 'unavailable', 'not_captured'].includes(value.trajectory_availability)
  )
    fail()
  experienceObject(value.metadata.change)
  const metadata = experienceObject(value.metadata.modification_use)
  if (canonicalDigest(metadata.summary) !== canonicalDigest(record.modification_use.summary)) fail()
  let files = 0
  for (const view of experienceViews) {
    if (!Array.isArray(value.views[view])) fail()
    for (const item of value.views[view]) {
      if (
        !validExperienceDigest(item.digest) ||
        !Number.isSafeInteger(item.count) ||
        item.count < 1 ||
        item.count > MAX_EXPERIENCE_FILES
      )
        fail()
      files++
    }
  }
  if (files > MAX_EXPERIENCE_FILES) fail()
}
function scopedItem(item: Json, record: ExperienceIndexEntry, view: ExperienceView): void {
  const value = experienceObject(item)
  if (view === 'diff') {
    if (!record.change.files.some((file) => file.path === value.path)) fail()
    return
  }
  if (typeof value.task_id !== 'string' || !record.scope.task_ids.includes(value.task_id)) fail()
  if (view !== 'task-results') {
    if (
      (view !== 'modification-use' &&
        ![record.candidate.id, record.parent.id].includes(String(value.candidate_id))) ||
      !Number.isSafeInteger(value.repetition) ||
      Number(value.repetition) < 0 ||
      Number(value.repetition) >= record.scope.repetitions
    )
      fail()
  }
  if (
    view === 'trajectory' &&
    (typeof value.ref !== 'string' ||
      !/^trajectory:[a-f0-9]{64}$/u.test(value.ref) ||
      !['available', 'unavailable'].includes(String(value.status)))
  )
    fail()
}
export function verifyChunk(
  chunk: ExperienceChunk,
  digest: string,
  count: number,
  record: ExperienceIndexEntry,
  view: ExperienceView,
): void {
  checkedDigest(chunk, digest)
  if (
    chunk.version !== 3 ||
    chunk.kind !== 'items' ||
    chunk.view !== view ||
    !Array.isArray(chunk.items) ||
    chunk.items.length !== count ||
    count < 1
  )
    fail()
  for (const item of chunk.items) {
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_EXPERIENCE_ITEM_BYTES) fail()
    scopedItem(item, record, view)
  }
  const item = experienceObject(chunk.items[0])
  const owner =
    view === 'verifier'
      ? {
          ...evidenceOwner(record),
          candidate_id: item.candidate_id!,
          task_id: item.task_id!,
          repetition: item.repetition!,
        }
      : detailOwner(record, view)
  if ((view === 'verifier' && count !== 1) || canonicalDigest(chunk.owner) !== canonicalDigest(owner)) fail()
}
