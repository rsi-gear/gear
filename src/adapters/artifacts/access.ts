import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import type { ExperienceSnapshot } from '../../domain/experience.js'
import type {
  ArtifactReaderDescriptor,
  TrajectoryQuery,
  TrajectoryReference,
} from '../../domain/trajectory.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { TrajectoryStore } from '../storage/trajectory.js'
import { ExperienceStore } from '../storage/experience.js'
import type { TargetStore } from '../storage/targets.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../python/builtin-policy.js'
import { artifactReader } from './reader.js'

/** Shared authorization for operator access and the per-Meta local gateway. */
export async function readSeedTrajectory(
  runRoot: string,
  snapshot: ExperienceSnapshot,
  descriptor: ArtifactReaderDescriptor | undefined,
  params: Record<string, unknown>,
  signal: AbortSignal,
  python?: string,
  baselineReferences: TrajectoryReference[] = [],
): Promise<Json> {
  if (snapshot.implementation_identity !== builtinPolicyImplementationDigest)
    throw new GearError(
      'experience-implementation-mismatch',
      'Trajectory projection requires the frozen implementation',
    )
  if (
    Object.keys(params).some((key) => !['ref', 'source_ref', 'query'].includes(key)) ||
    typeof params.ref !== 'string' ||
    typeof params.source_ref !== 'string'
  )
    throw new GearError(
      'invalid-trajectory-query',
      'Use an experience ref and a trajectory source ref from that frozen record',
    )
  const record = snapshot.records.find((item) => 'experience:' + item.digest.slice(7) === params.ref)
  let reference: TrajectoryReference | undefined
  if (record)
    for await (const item of new ExperienceStore(join(runRoot, 'experience')).trajectoryReferences(
      snapshot,
      record,
    )) {
      if (item.ref === params.source_ref) {
        reference = item
        break
      }
    }
  if (!reference && params.ref === 'baseline')
    reference = baselineReferences.find((item) => item.ref === params.source_ref)
  if (!reference || !/^trajectory:[a-f0-9]{64}$/u.test(reference.ref))
    throw new GearError(
      'trajectory-outside-snapshot',
      'Trajectory is not authorized by this experience snapshot',
    )
  if (!descriptor || reference.status !== 'available')
    throw new GearError('trajectory-unavailable', 'This source has no verified readable trajectory')
  const source = await new TrajectoryStore(join(runRoot, 'trajectory-sources')).read(
    'sha256:' + reference.ref.slice(11),
  )
  if (
    source.run_id !== snapshot.run_id ||
    source.candidate_id !== reference.candidate_id ||
    source.artifact.task_id !== reference.task_id ||
    source.artifact.repetition !== reference.repetition ||
    source.artifact.content_digest !== reference.content_digest ||
    source.reader_identity !== canonicalDigest(descriptor)
  )
    throw new GearError('trajectory-source-changed', 'Trajectory no longer matches its frozen seed binding')
  const query = builtinPolicy<{
    binding: Json
    filter: TrajectoryQuery
    limit: number
    provider_cursor: string | null
  }>(
    'trajectory_query',
    {
      snapshot_digest: snapshot.digest,
      source_ref: reference.ref,
      content_digest: source.artifact.content_digest,
      query: params.query ?? {},
    },
    python,
  )
  const page = await artifactReader(descriptor).read(
    source.artifact,
    {
      ...query.filter,
      limit: query.limit,
      ...(query.provider_cursor === null ? {} : { cursor: query.provider_cursor }),
    },
    signal,
  )
  return builtinPolicy<Json>('trajectory_page', { query, page }, python)
}

/** Read only sealed resources belonging to the candidate or parent in a seed record. */
export async function readSeedCandidateSource(
  snapshot: ExperienceSnapshot,
  targets: TargetStore,
  params: Record<string, unknown>,
): Promise<Json> {
  if (
    Object.keys(params).some((key) => !['ref', 'candidate_id', 'path', 'offset', 'limit'].includes(key)) ||
    typeof params.ref !== 'string' ||
    typeof params.candidate_id !== 'string'
  )
    throw new GearError('invalid-source-query', 'Use a frozen experience ref and candidate ID')
  const record = snapshot.records.find((item) => 'experience:' + item.digest.slice(7) === params.ref)
  if (!record || record.scope.partition !== 'seed')
    throw new GearError('source-outside-snapshot', 'Source is outside the frozen seed snapshot')
  const candidate = [record.candidate, record.parent].find((item) => item.id === params.candidate_id)
  if (!candidate)
    throw new GearError('source-outside-snapshot', 'Candidate is outside the frozen experience record')
  const manifest = await targets.verify(candidate.id)
  if (manifest.digest !== candidate.digest)
    throw new GearError('target-identity-mismatch', 'Frozen source differs from its experience record')
  const offset = params.offset ?? 0,
    limit = params.limit ?? (params.path === undefined ? 50 : 24 * 1024)
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (params.path === undefined ? 50 : 24 * 1024)
  )
    throw new GearError(
      'invalid-source-query',
      'Source path pages are limited to 50 entries and file pages to 24 KiB',
    )
  if (params.path === undefined) {
    if (offset > manifest.resources.length)
      throw new GearError('invalid-source-query', 'Source path page is outside the resource list')
    const items = manifest.resources
      .slice(offset, offset + limit)
      .map(({ path, digest }) => ({ path, digest }))
    return {
      snapshot_digest: snapshot.digest,
      ref: params.ref,
      candidate_id: candidate.id,
      items,
      total: manifest.resources.length,
      next_offset: offset + items.length < manifest.resources.length ? offset + items.length : null,
    }
  }
  if (typeof params.path !== 'string' || !params.path)
    throw new GearError('invalid-source-query', 'Source path must be a non-empty relative path')
  const resource = manifest.resources.find((item) => item.path === params.path)
  if (!resource) throw new GearError('source-outside-snapshot', 'Source path is outside the sealed candidate')
  const bytes = await targets.readResource(candidate.id, resource.path)
  if (offset > bytes.length)
    throw new GearError('invalid-source-query', 'Source byte offset is outside the file')
  const end = Math.min(offset + limit, bytes.length)
  return {
    snapshot_digest: snapshot.digest,
    ref: params.ref,
    candidate_id: candidate.id,
    path: resource.path,
    content_digest: resource.digest,
    encoding: 'base64',
    offset,
    total_bytes: bytes.length,
    next_offset: end < bytes.length ? end : null,
    content: bytes.subarray(offset, end).toString('base64'),
  }
}
