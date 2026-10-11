import type { ArtifactRef } from '../contracts.js'
import { FileArtifactStore } from '../artifacts.js'
import { implementationClosureDigest } from '../data/identity.js'
import type { SearchJournal } from '../../search/store.js'
import { GepaArchiveViewProvider, type GepaArchiveViewInput } from './gepa-archive-view.js'
import { GepaScienceCheckpointProvider, type GepaScienceCheckpointInput } from './gepa-science-checkpoint.js'

export const GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA = 'gepa.archive-view-projection.v1'
export const GEPA_SCIENCE_PROJECTION_SCHEMA = 'gepa.science-projection.v1'

export type GepaDurableProjectionHostOptions = {
  root: string
  roundId: string
  artifacts: FileArtifactStore
  journal: SearchJournal
}

/** Replays old-journal views only from a Campaign-committed artifact reference. */
export function createGepaDurableProjectionHost(options: GepaDurableProjectionHostOptions): {
  describe(): { implementationDigest: string; schemaIds: string[] }
  project(ref: ArtifactRef): Promise<void>
} {
  const { root, roundId, artifacts, journal } = options
  const schemaIds = [GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA, GEPA_SCIENCE_PROJECTION_SCHEMA]
  const implementationDigest = implementationClosureDigest(['providers/gepa-durable-projections'],
    { roundId, schemaIds })
  const archive = new GepaArchiveViewProvider(root, artifacts, journal)
  const science = new GepaScienceCheckpointProvider(root, artifacts, journal)
  return {
    describe: () => ({ implementationDigest, schemaIds: [...schemaIds] }),
    async project(ref) {
      if (ref.kind !== 'artifact' || ref.mediaType !== 'application/json')
        throw new Error('GEPA projection must be a sealed JSON artifact')
      if (ref.schemaId === GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA) {
        const input = artifacts.getJson(ref) as unknown as GepaArchiveViewInput
        if (input?.roundId !== roundId) throw new Error('GEPA archive view projection round drift')
        await archive.project(input)
        return
      }
      if (ref.schemaId === GEPA_SCIENCE_PROJECTION_SCHEMA) {
        const input = artifacts.getJson(ref) as unknown as GepaScienceCheckpointInput
        if (input?.roundId !== roundId) throw new Error('GEPA science projection round drift')
        await science.project(input)
        return
      }
      throw new Error(`Unsupported GEPA projection schema ${ref.schemaId ?? '(none)'}`)
    },
  }
}
