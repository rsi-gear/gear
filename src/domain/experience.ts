import type { Candidate, Json } from './algorithm-wire.js'
import type { TrajectoryReference } from './trajectory.js'

/** The logical record and public ref retain their v2 identity across physical encodings. */
export interface ExperienceRecord {
  version: 2
  source: { [key: string]: Json }
  candidate: Candidate
  parent: Candidate
  scope: { partition: 'seed'; task_ids: string[]; repetitions: number }
  proposal: { rationale: string; hypothesis: string; semantic_targets: string[] }
  change: Json
  classification: Json
  task_results: Json[]
  modification_use: Json
  verifier_trials: Json[]
  trajectory_refs: TrajectoryReference[]
  digest: string
}
export type ExperienceView = 'task-results' | 'diff' | 'trajectory' | 'modification-use' | 'verifier'
export const experienceViews: ExperienceView[] = [
  'task-results',
  'diff',
  'trajectory',
  'modification-use',
  'verifier',
]
export interface ExperienceIndexEntry {
  version: 3
  source: ExperienceRecord['source']
  candidate: Candidate
  parent: Candidate
  scope: ExperienceRecord['scope']
  proposal: ExperienceRecord['proposal']
  change: { files: { path: string }[] }
  classification: Json
  modification_use: { summary: Json }
  /** Original complete logical record digest, not the summary or descriptor digest. */
  digest: string
  summary_digest: string
  descriptor_digest: string
}
export interface ExperienceChunkReference {
  digest: string
  count: number
}
export interface ExperienceDescriptor {
  version: 3
  kind: 'record'
  record_digest: string
  summary_digest: string
  owner: { [key: string]: Json }
  /** Non-array logical metadata, retained for lossless archival reconstruction. */
  metadata: { change: Json; modification_use: Json }
  views: Record<ExperienceView, ExperienceChunkReference[]>
  trajectory_availability: 'available' | 'unavailable' | 'not_captured'
  digest: string
}
export interface ExperienceChunk {
  version: 3
  kind: 'items'
  view: ExperienceView
  owner: { [key: string]: Json }
  items: Json[]
  digest: string
}
export interface LegacyExperienceSnapshot {
  version: 2
  run_id: string
  source_archive_digest: string
  implementation_identity: string
  records: ExperienceRecord[]
  digest: string
}
export interface ExperienceIndexSnapshot {
  version: 3
  run_id: string
  source_archive_digest: string
  implementation_identity: string
  records: ExperienceIndexEntry[]
  digest: string
}
export type ExperienceSnapshot = LegacyExperienceSnapshot | ExperienceIndexSnapshot
export interface ExperienceContext {
  version: 2
  snapshot_digest: string
  implementation_identity: string
  available_records: number
  cards: Json[]
  digest: string
}
