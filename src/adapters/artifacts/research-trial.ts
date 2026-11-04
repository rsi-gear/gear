import { resolve } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { TrajectoryQuery } from '../../domain/trajectory.js'
import type { OperationRequest } from '../../ports/operations.js'
import { RunStore } from '../storage/run-store.js'
import { artifactReader } from './reader.js'
import { builtinPolicy } from '../python/builtin-policy.js'

/** Resolve a public trial ID through the frozen receipt, never a caller's native locator. */
export async function readResearchTrial(
  runRoot: string,
  request: OperationRequest,
  signal: AbortSignal,
): Promise<Json> {
  const descriptor = (
    request.operation.payload as { gear_trial_read_v1?: { trial_id: string; query?: Json } } | null
  )?.gear_trial_read_v1
  if (!descriptor || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.trial_id))
    throw new GearError('invalid-trajectory-query', 'Use an admitted research trial ID')
  const journal = await new RunStore(resolve(runRoot, '../..')).read(request.runId)
  const trial = journal.researchTrials?.find((item) => item.id === descriptor.trial_id)
  if (
    !trial ||
    trial.candidate_id !== request.operation.candidate_id ||
    !journal.spec.researchData ||
    ![...journal.spec.researchData.train, ...journal.spec.researchData.dev].includes(trial.task_id)
  )
    throw new GearError('trajectory-outside-run', 'Research trajectory is outside the admitted data scope')
  const owner = journal.operations.find(
    (item) =>
      item.status === 'complete' &&
      item.request.partition === 'seed' &&
      item.request.operationId === trial.operation_id,
  )
  const reader = journal.spec.artifactReader
  const artifact = owner?.receipt?.artifacts?.find(
    (item) =>
      item.task_id === trial.task_id &&
      item.repetition === trial.evidence.repetition &&
      item.format === reader?.format,
  )
  if (!artifact || artifact.status !== 'available' || !artifact.content_digest || !reader)
    throw new GearError('trajectory-unavailable', 'This trial has no verified readable trajectory')
  const query = builtinPolicy<{
    binding: Json
    filter: TrajectoryQuery
    limit: number
    provider_cursor: string | null
  }>('trajectory_query', {
    snapshot_digest: canonicalDigest([journal.specDigest, owner!.receipt]),
    source_ref: trial.id,
    content_digest: artifact.content_digest,
    query: descriptor.query ?? {},
  })
  const page = await artifactReader(reader).read(
    artifact,
    {
      ...query.filter,
      limit: query.limit,
      ...(query.provider_cursor ? { cursor: query.provider_cursor } : {}),
    },
    signal,
  )
  return builtinPolicy<Json>('trajectory_page', { query, page })
}
