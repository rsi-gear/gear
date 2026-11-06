import type { Json, TrialArtifact } from './algorithm-wire.js'

/** Private immutable reader configuration. Never included in algorithm or Meta views. */
export interface ArtifactReaderDescriptor {
  format: string
  implementation_identity: string
  configuration: Json
}
export interface TrajectorySource {
  version: 1
  run_id: string
  candidate_id: string
  operation_id: string
  origin_run_id: string
  origin_candidate_id: string
  receipt_digest: string
  reader_identity: string
  partition: 'seed'
  artifact: TrialArtifact
  digest: string
}
export interface TrajectoryReference {
  ref: string
  candidate_id: string
  task_id: string
  repetition: number
  status: 'available' | 'unavailable'
  content_digest: string | null
  reason: string | null
}
export interface TrajectoryQuery {
  limit?: number
  types?: string[]
  seq_start?: number
  seq_end?: number
  field?: string
  cursor?: string
}
