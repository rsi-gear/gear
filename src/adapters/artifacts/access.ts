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
