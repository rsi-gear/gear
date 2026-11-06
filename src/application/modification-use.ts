import { basename, join } from 'node:path'
import type { Candidate, Json } from '../domain/algorithm-wire.js'
import type { ArtifactReaderDescriptor, TrajectoryReference } from '../domain/trajectory.js'
import type { TargetFileChange } from '../adapters/storage/target-diff.js'
import { canonicalDigest } from '../domain/canonical.js'
import { ModificationUseStore } from '../adapters/storage/modification-use.js'
import { TrajectoryStore } from '../adapters/storage/trajectory.js'
import { modificationUseIdentity, observeModificationUse } from '../adapters/python/modification-use.js'
import { artifactReader } from '../adapters/artifacts/reader.js'

export { modificationUseIdentity }
/** Carried between sequential workers; Python owns the limits and charges. */
export interface ModificationUseBudget {
  state?: Json
}
export async function modificationUse(
  runRoot: string,
  adapter: string,
  candidate: Candidate,
  changes: TargetFileChange[],
  references: TrajectoryReference[],
  descriptor: ArtifactReaderDescriptor | undefined,
  signal: AbortSignal,
  budget: ModificationUseBudget,
): Promise<Json[]> {
  if (!descriptor || adapter !== 'dsh') return []
  // The closed registry verifies the exact configured implementation before any private I/O.
  artifactReader(descriptor)
  const store = new TrajectoryStore(join(runRoot, 'trajectory-sources'))
  const trials = []
  for (const reference of references.filter((reference) => reference.candidate_id === candidate.id)) {
    const source = await store.read('sha256:' + reference.ref.slice(11))
    if (
      source.run_id !== basename(runRoot) ||
      source.reader_identity !== canonicalDigest(descriptor) ||
      source.candidate_id !== candidate.id ||
      source.artifact.task_id !== reference.task_id ||
      source.artifact.repetition !== reference.repetition ||
      source.artifact.content_digest !== reference.content_digest
    )
      throw new Error('Modification source differs from its frozen trajectory binding')
    trials.push({
      task_id: reference.task_id,
      repetition: reference.repetition,
      source_ref: reference.ref,
      source: {
        ...(source.artifact.locator as Record<string, Json>),
        content_digest: source.artifact.content_digest,
      },
    })
  }
  if (!trials.length) return []
  const key = canonicalDigest({
    implementation: modificationUseIdentity,
    candidate,
    changes,
    trials,
    descriptor,
  })
  const cache = new ModificationUseStore(join(runRoot, 'modification-use'))
  const saved = await cache.read(key)
  if (saved) return (saved as { trials: Json[] }).trials
  let result: {
    trials: Array<Json & { source: { coverage: string } }>
    budget: Json
    resources_complete: boolean
  }
  try {
    result = (await observeModificationUse(
      {
        root: (descriptor.configuration as { root: string }).root,
        target_root: join(runRoot, 'targets', candidate.id),
        adapter,
        changes,
        trials,
        budget: budget.state,
      },
      signal,
    )) as typeof result
  } catch {
    signal.throwIfAborted()
    // Consumption is unknown after a crashed worker; do not grant a fresh budget.
    budget.state = { remaining_bytes: 0, remaining_runs: 0 }
    return []
  }
  budget.state = result.budget
  if (
    result.resources_complete &&
    result.trials.every((trial) => trial.source.coverage === 'listed-files-complete')
  )
    await cache.save(key, { trials: result.trials })
  return result.trials
}
