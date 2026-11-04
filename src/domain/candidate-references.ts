import type { Operation } from './algorithm-wire.js'
import { GearError } from './errors.js'

export interface CandidateReference {
  candidate_id: string
  digest: string
}

/** Named, immutable candidates made readable to an editing operation. */
export function candidateReferences(operation: Operation): Record<string, CandidateReference> {
  const payload = operation.payload
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('gear_candidate_references_v1' in payload)
  )
    return {}
  const references = payload.gear_candidate_references_v1
  if (
    operation.kind !== 'generate_candidate' ||
    !references ||
    typeof references !== 'object' ||
    Array.isArray(references)
  )
    throw new GearError('invalid-candidate-reference', 'References require a named candidate map on an edit')
  // Each candidate is bounded by TargetStore to 64 MiB; cap multiplied disk materialization.
  if (Object.keys(references).length > 8)
    throw new GearError('invalid-candidate-reference', 'An edit supports at most eight candidate references')
  for (const [name, value] of Object.entries(references)) {
    if (
      !/^[a-zA-Z0-9_-]+$/u.test(name) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'candidate_id,digest' ||
      typeof value.candidate_id !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/u.test(value.candidate_id) ||
      typeof value.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.digest)
    )
      throw new GearError(
        'invalid-candidate-reference',
        'References need safe names and sealed candidate identities',
      )
  }
  return references as unknown as Record<string, CandidateReference>
}
