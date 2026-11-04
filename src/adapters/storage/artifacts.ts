import { readResearchTrial } from '../artifacts/research-trial.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import type { OperationReceipt, OperationRequest } from '../../ports/operations.js'
import { artifactCommand, type ArtifactRef } from '../../domain/artifacts.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { treeDiff } from './target-diff.js'
import { WorkspaceStore } from './workspaces.js'
import type { TargetStore } from './targets.js'
import { publishFile } from './atomic.js'

export class ArtifactOperations {
  readonly workspaces: WorkspaceStore
  constructor(readonly targets: TargetStore) {
    this.workspaces = new WorkspaceStore(targets.runRoot)
  }
  private path(request: OperationRequest): string {
    return join(this.targets.runRoot, 'artifact-operations', request.operationId.slice(7), 'receipt.json')
  }
  async tree(ref: ArtifactRef) {
    if ('candidate_id' in ref) {
      const manifest = await this.targets.verify(ref.candidate_id)
      if (manifest.digest !== ref.digest)
        throw new GearError('artifact-identity-mismatch', 'Candidate artifact changed')
      return {
        id: ref.candidate_id,
        digest: ref.digest,
        path: this.targets.path(ref.candidate_id),
        resources: manifest.resources,
      }
    }
    const manifest = await this.workspaces.verify(ref)
    return { id: ref.id, digest: ref.digest, path: this.workspaces.files(ref), resources: manifest.resources }
  }
  async inspect(request: OperationRequest): Promise<OperationReceipt | null> {
    if (request.operation.kind !== 'artifact_trial_read') return this.submit(request)
    try {
      const saved = JSON.parse(await readFile(this.path(request), 'utf8'))
      if (saved.request_digest !== canonicalDigest(request))
        throw new GearError('artifact-operation-conflict', 'Read operation input changed')
      return saved.receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return null
  }
  async submit(
    request: OperationRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<OperationReceipt> {
    if (request.operation.kind === 'artifact_trial_read') {
      const prior = await this.inspect(request)
      if (prior) return prior
    }
    const special = ['artifact_trial_read', 'artifact_material'].includes(request.operation.kind)
    const command = special ? null : artifactCommand(request.operation)
    const source = command ? await this.tree(command.source) : null
    let data: unknown
    if (request.operation.kind === 'artifact_trial_read')
      data = await readResearchTrial(this.targets.runRoot, request, signal)
    else if (request.operation.kind === 'artifact_material') {
      data = (request.operation.payload as { gear_material_v1: Json }).gear_material_v1
      if (data === undefined || Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024)
        throw new GearError('material-too-large', 'Author material must be bounded JSON at most 1 MiB')
    } else if (request.operation.kind === 'artifact_diff')
      data = await treeDiff(source!, await this.tree(command!.other!))
    else if (request.operation.kind === 'artifact_list')
      data = {
        resources: source!.resources,
        harness: this.targets.adapter.describe(),
        mutation_policy: this.targets.adapter.mutationPolicy,
      }
    else {
      const files: Record<string, string> = Object.create(null)
      let bytes = 0
      for (const path of command!.paths!) {
        const resource = source!.resources.find((item) => item.path === path)
        if (!resource)
          throw new GearError('artifact-path-unavailable', 'Path is absent from the requested version')
        const content = await readFile(join(source!.path, resource!.path))
        bytes += content.length
        if (bytes > 1024 * 1024)
          throw new GearError(
            'artifact-read-too-large',
            'Read at most 1 MiB per operation; use file tools for larger resources',
          )
        if (canonicalDigest(content.toString('base64')) !== resource.digest)
          throw new GearError('artifact-identity-mismatch', 'Artifact bytes changed during read')
        try {
          files[path] = new TextDecoder('utf-8', { fatal: true }).decode(content)
        } catch {
          throw new GearError('artifact-binary-file', 'Text read requires UTF-8 resources')
        }
      }
      data = { files: { ...files } }
    }
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: request.operation.kind,
        status: 'complete',
        candidate_id: request.operation.candidate_id,
        data: data as Json,
      },
      candidate: null,
      evidence: [],
      physicalAttempts: 0,
      usage: { model_requests: 0, tokens: 0, dollars: 0 },
      provenance: { request_digest: canonicalDigest(request), source_digest: source?.digest ?? null },
    }
    if (request.operation.kind === 'artifact_trial_read')
      await publishFile(
        this.path(request),
        JSON.stringify({ request_digest: canonicalDigest(request), receipt }),
        { immutable: true },
      )
    return receipt
  }
}
