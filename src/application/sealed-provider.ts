import { checkEditPaths } from '../domain/edit-scope.js'
import { ArtifactOperations } from '../adapters/storage/artifacts.js'
import { artifactCommand, isArtifactOperation } from '../domain/artifacts.js'
import { WorkspaceOperations } from '../adapters/storage/workspaces.js'
import { isLocalWorkspace, workspaceCommand, workspaceResult } from '../domain/workspaces.js'
import { canonicalDigest } from '../domain/canonical.js'
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
  const workspaces = new WorkspaceOperations(targets)
  const artifacts = new ArtifactOperations(targets)
  const verifyInput = async (request: OperationRequest) => {
    const id = request.operation.parent_id ?? request.operation.candidate_id
    if (id) await targets.verify(id)
    for (const reference of Object.values(candidateReferences(request.operation))) {
      if ((await targets.verify(reference.candidate_id)).digest !== reference.digest)
        throw new GearError('candidate-reference-mismatch', 'Reference candidate identity changed')
    }
    if (request.operation.kind === 'workspace_edit') {
      const command = workspaceCommand(request.operation)
      await workspaces.store.assertOpen(command.source!, request)
    }
    if (['artifact_list', 'artifact_read', 'artifact_diff'].includes(request.operation.kind)) {
      const command = artifactCommand(request.operation)
      await artifacts.tree(command.source)
      if (command.other) await artifacts.tree(command.other)
    }
    await experience?.verify(request)
  }
  const seal = async (request: OperationRequest, value: OperationReceipt): Promise<OperationReceipt> => {
    validateAlgorithmWire('OperationReceipt', value)
    await verifyInput(request)
    // Facts are rebuilt from sealed resources, never accepted from model/provider data.
    const { candidate_change: _claimedChange, ...result } = value.result
    value = { ...value, result }
    if (
      ['workspace_open', 'workspace_edit', 'workspace_apply'].includes(request.operation.kind) &&
      value.result.status === 'complete'
    ) {
      const ref = workspaceResult(value.result),
        command = workspaceCommand(request.operation)
      if (
        !ref ||
        ref.id !== command.output_id ||
        ref.parent_id !== (command.source?.id ?? null) ||
        ref.base_candidate_id !== request.operation.parent_id ||
        ref.base_digest !== (command.source?.base_digest ?? command.base_digest) ||
        ref.root_id !== (command.source?.root_id ?? command.output_id)
      )
        throw new GearError(
          'invalid-workspace-receipt',
          'Operation did not return the requested workspace revision',
        )
      const manifest = await workspaces.store.verify(ref)
      if (command.source)
        checkEditPaths(
          request.operation,
          targets.adapter.mutationPolicy,
          (await workspaces.store.verify(command.source)).resources,
          manifest.resources,
        )
      if (
        manifest.producer.operation_id !== request.operationId ||
        manifest.producer.request_digest !== canonicalDigest(request)
      )
        throw new GearError('invalid-workspace-receipt', 'Workspace revision belongs to another operation')
    }
    if (!value.candidate) return value
    const operation = request.operation
    if (
      !['generate_candidate', 'workspace_seal'].includes(operation.kind) ||
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
    checkEditPaths(
      request.operation,
      targets.adapter.mutationPolicy,
      (await targets.verify(operation.parent_id)).resources,
      manifest.resources,
    )
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
    ...(provider.capabilitiesFor
      ? {
          capabilitiesFor: (operation: OperationRequest['operation']) => provider.capabilitiesFor!(operation),
        }
      : {}),
    ...(provider.validateOperation
      ? {
          validateOperation: (operation: OperationRequest['operation']) =>
            provider.validateOperation!(operation),
        }
      : {}),
    async submit(request, signal) {
      await verifyInput(request)
      return seal(
        request,
        isLocalWorkspace(request.operation.kind)
          ? await workspaces.submit(request)
          : isArtifactOperation(request.operation.kind)
            ? await artifacts.submit(request, signal)
            : await provider.submit(request, signal),
      )
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
      const result = isArtifactOperation(request.operation.kind)
        ? await artifacts
            .inspect(request)
            .then((receipt) =>
              receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const },
            )
        : isLocalWorkspace(request.operation.kind)
          ? await workspaces
              .inspect(request)
              .then((receipt) =>
                receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const },
              )
          : await provider.inspect(request, signal)
      return result.state === 'complete'
        ? { state: 'complete', receipt: await seal(request, result.receipt) }
        : result
    },
    cancel: (request) =>
      isLocalWorkspace(request.operation.kind) || isArtifactOperation(request.operation.kind)
        ? Promise.resolve()
        : provider.cancel(request),
  }
}
