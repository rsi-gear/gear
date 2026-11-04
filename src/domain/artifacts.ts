import type { Operation, SearchView } from './algorithm-wire.js'
import { GearError } from './errors.js'
import { canonicalDigest } from './canonical.js'
import { workspaceRef, workspaceResult, type WorkspaceRef } from './workspaces.js'
import type { CandidateReference } from './candidate-references.js'
export type ArtifactRef = CandidateReference | WorkspaceRef
export const isArtifactOperation = (kind: string): boolean =>
  ['artifact_list', 'artifact_read', 'artifact_diff', 'artifact_trial_read', 'artifact_material'].includes(
    kind,
  )
export function artifactRef(value: unknown): ArtifactRef {
  if (value && typeof value === 'object' && 'root_id' in value) return workspaceRef(value)
  const ref = value as CandidateReference
  if (
    !ref ||
    Object.keys(ref).sort().join(',') !== 'candidate_id,digest' ||
    !/^[a-zA-Z0-9_-]+$/u.test(ref.candidate_id) ||
    !/^sha256:[a-f0-9]{64}$/u.test(ref.digest)
  )
    throw new GearError('invalid-artifact-ref', 'Artifact reads require a sealed candidate or draft revision')
  return ref
}
export function artifactCommand(operation: Operation): {
  source: ArtifactRef
  other?: ArtifactRef
  paths?: string[]
} {
  const command = (operation.payload as Record<string, unknown> | null)?.gear_artifact_v1 as Record<
    string,
    unknown
  >
  if (!isArtifactOperation(operation.kind) || !command || typeof command !== 'object')
    throw new GearError('invalid-artifact-operation', 'Artifact operation requires a read descriptor')
  const source = artifactRef(command.source)
  if (operation.kind === 'artifact_diff') return { source, other: artifactRef(command.other) }
  if (operation.kind === 'artifact_read') {
    if (
      !Array.isArray(command.paths) ||
      !command.paths.length ||
      command.paths.some((path) => typeof path !== 'string')
    )
      throw new GearError('invalid-artifact-operation', 'Artifact read requires explicit file paths')
    return { source, paths: command.paths as string[] }
  }
  return { source }
}
export function validateArtifactReferences(view: SearchView, operation: Operation): void {
  if (operation.kind === 'artifact_material') return
  if (operation.kind === 'artifact_trial_read') {
    const value = (operation.payload as { gear_trial_read_v1?: { trial_id?: string } } | null)
      ?.gear_trial_read_v1
    if (
      !value ||
      !view.research_trials?.some(
        (trial) => trial.id === value.trial_id && trial.candidate_id === operation.candidate_id,
      )
    )
      throw new GearError('trajectory-outside-run', 'Trajectory read must name a visible research trial')
    return
  }
  const command = artifactCommand(operation)
  for (const ref of [command.source, ...(command.other ? [command.other] : [])]) {
    const known =
      'candidate_id' in ref
        ? view.candidates.some((value) => value.id === ref.candidate_id && value.digest === ref.digest)
        : view.completed.some((value) => canonicalDigest(workspaceResult(value)) === canonicalDigest(ref))
    if (!known)
      throw new GearError(
        'artifact-outside-run',
        'Artifact must refer to a known immutable version in this run',
      )
  }
}
