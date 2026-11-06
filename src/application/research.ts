import { join } from 'node:path'
import type { Json } from '../domain/algorithm-wire.js'
import type { RunJournal } from '../domain/run.js'
import { canonicalDigest } from '../domain/canonical.js'
import { ResearchStore } from '../adapters/storage/research.js'
import { builtinPolicy } from '../adapters/python/builtin-policy.js'
import { pythonObjective } from '../adapters/python/objective.js'

export async function projectResearch(root: string, journal: RunJournal) {
  const bundle = await new ResearchStore(join(root, '.gear/runs', journal.id, 'research')).load(journal)
  // The raw immutable archive remains readable after upgrading Gear. A changed
  // projector must not reinterpret an old run as if it used the frozen code.
  if (journal.spec.objectiveIdentity !== pythonObjective.identity)
    return {
      ...bundle,
      projection: { status: 'unavailable' as const, reason: 'projection-identity-mismatch' },
    }
  let value: Json
  try {
    value = builtinPolicy<Json>('research_project', bundle)
  } catch (error) {
    return {
      ...bundle,
      projection: {
        status: 'unavailable' as const,
        reason: 'projection-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const body = {
    source_digest: bundle.archive.digest,
    implementation_identity: pythonObjective.identity,
    value,
  }
  return { ...bundle, projection: { status: 'available' as const, ...body, digest: canonicalDigest(body) } }
}
