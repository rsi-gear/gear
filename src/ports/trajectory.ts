import type { Json, TrialArtifact } from '../domain/algorithm-wire.js'
import type { ArtifactReaderDescriptor, TrajectoryQuery } from '../domain/trajectory.js'

/** Reads an already executed trial's immutable material; no evaluation/model side effects. */
export interface ArtifactReader {
  readonly descriptor: ArtifactReaderDescriptor
  read(artifact: TrialArtifact, query: TrajectoryQuery, signal: AbortSignal): Promise<Json>
}
