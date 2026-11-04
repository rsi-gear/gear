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
    !['generate_candidate', 'workspace_edit'].includes(operation.kind) ||
    !references ||
    typeof references !== 'object' ||
    Array.isArray(references)
  )
    throw new GearError('invalid-candidate-reference', 'References require a named candidate map on an edit')
  // Bound reference metadata; staging separately caps aggregate resource bytes.
  if (Object.keys(references).length > 128)
    throw new GearError('invalid-candidate-reference', 'An edit supports at most 128 candidate references')
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
