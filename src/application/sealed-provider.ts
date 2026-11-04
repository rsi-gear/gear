import type { OperationProvider, OperationReceipt, OperationRequest } from '../ports/operations.js'
import { GearError } from '../domain/errors.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import type { TargetStore } from '../adapters/storage/targets.js'
import type { ExperiencePreparation } from '../ports/experience.js'
import { targetDiff } from '../adapters/storage/target-diff.js'
import type { Json } from '../domain/algorithm-wire.js'
import { candidateReferences } from '../domain/candidate-references.js'

/** Provider proposals become candidates only after core-owned resource checks and sealing. */
export function sealedProvider(
  provider: OperationProvider,
  targets: TargetStore,
  experience?: ExperiencePreparation,
): OperationProvider {
  const verifyInput = async (request: OperationRequest) => {
    const id = request.operation.parent_id ?? request.operation.candidate_id
    if (id) await targets.verify(id)
    for (const reference of Object.values(candidateReferences(request.operation))) {
      if ((await targets.verify(reference.candidate_id)).digest !== reference.digest)
        throw new GearError('candidate-reference-mismatch', 'Reference candidate identity changed')
    }
    await experience?.verify(request)
  }
  const seal = async (request: OperationRequest, value: OperationReceipt): Promise<OperationReceipt> => {
    validateAlgorithmWire('OperationReceipt', value)
    await verifyInput(request)
    // Facts are rebuilt from sealed resources, never accepted from model/provider data.
    const { candidate_change: _claimedChange, ...result } = value.result
    value = { ...value, result }
    if (!value.candidate) return value
    const operation = request.operation
    if (
      operation.kind !== 'generate_candidate' ||
      !operation.parent_id ||
      value.candidate.id !== operation.candidate_id ||
      value.candidate.parent_id !== operation.parent_id
    )
      throw new GearError(
        'invalid-generated-candidate',
        'Provider proposal does not match the reserved mutation',
      )
    const manifest = await targets.seal(value.candidate.id, '', operation.parent_id)
    const candidate = { ...value.candidate, digest: manifest.digest }
    const parent = {
      id: operation.parent_id,
      parent_id: null,
      digest: (await targets.verify(operation.parent_id)).digest,
    }
    return {
      ...value,
      candidate,
      result: {
        ...result,
        candidate_change: (await targetDiff(targets, parent, candidate)) as unknown as Json,
      },
    }
  }
  return {
    identity: provider.identity,
    ...(provider.artifactReader ? { artifactReader: provider.artifactReader } : {}),
    evaluationIdentity: provider.evaluationIdentity ?? provider.identity,
    ...(provider.timeouts ? { timeouts: provider.timeouts } : {}),
    capabilities: provider.capabilities,
    async submit(request, signal) {
      await verifyInput(request)
      return seal(request, await provider.submit(request, signal))
    },
    ...(provider.completeEvidence
      ? {
          async completeEvidence(request: OperationRequest, signal: AbortSignal) {
            await verifyInput(request)
            return seal(request, await provider.completeEvidence!(request, signal))
          },
        }
      : {}),
    async inspect(request, signal) {
      await verifyInput(request)
      const result = await provider.inspect(request, signal)
      return result.state === 'complete'
        ? { state: 'complete', receipt: await seal(request, result.receipt) }
        : result
    },
    cancel: (request) => provider.cancel(request),
  }
}
