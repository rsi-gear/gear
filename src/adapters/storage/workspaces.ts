import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertMutationPath } from '../../domain/mutation-policy.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { workspaceCommand, workspaceRef, type WorkspaceRef } from '../../domain/workspaces.js'
import type { Json, OperationReceipt } from '../../domain/algorithm-wire.js'
import type { OperationRequest } from '../../ports/operations.js'
import type { TargetResource } from '../../domain/target.js'
import { publishFile, syncDirectory } from './atomic.js'
import { snapshotTarget, targetResources, type TargetStore } from './targets.js'

interface RevisionManifest extends WorkspaceRef {
  version: 1
  producer: { operation_id: string; request_digest: string }
  resources: TargetResource[]
}
export class WorkspaceStore {
  constructor(readonly runRoot: string) {}
  private directory(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id))
      throw new GearError('invalid-workspace-id', 'Invalid workspace revision ID')
    return join(this.runRoot, 'workspaces/revisions', id)
  }
  files(ref: WorkspaceRef): string {
    return join(this.directory(ref.id), 'files')
  }
  async verify(ref: WorkspaceRef): Promise<RevisionManifest> {
    workspaceRef(ref)
    const manifest = JSON.parse(
      await readFile(join(this.directory(ref.id), 'manifest.json'), 'utf8'),
    ) as RevisionManifest
    const { digest, ...body } = manifest
    if (
      canonicalDigest(body) !== digest ||
      canonicalDigest(this.ref(manifest)) !== canonicalDigest(ref) ||
      canonicalDigest(manifest.resources) !== canonicalDigest(await targetResources(this.files(ref)))
    )
      throw new GearError('workspace-identity-mismatch', 'Frozen workspace revision changed')
    return manifest
  }
  ref(manifest: RevisionManifest): WorkspaceRef {
    return {
      id: manifest.id,
      digest: manifest.digest,
      root_id: manifest.root_id,
      parent_id: manifest.parent_id,
      base_candidate_id: manifest.base_candidate_id,
      base_digest: manifest.base_digest,
    }
  }
  async save(request: OperationRequest, source: string): Promise<WorkspaceRef> {
    const command = workspaceCommand(request.operation),
      revisionId = command.output_id!
    const base = command.source
    const producer = { operation_id: request.operationId, request_digest: canonicalDigest(request) }
    const destination = this.directory(revisionId)
    try {
      const manifest = JSON.parse(
        await readFile(join(destination, 'manifest.json'), 'utf8'),
      ) as RevisionManifest
      if (canonicalDigest(manifest.producer) !== canonicalDigest(producer))
        throw new GearError('workspace-operation-conflict', 'Revision belongs to another operation')
      const ref = this.ref(manifest)
      await this.verify(ref)
      return ref
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(join(this.runRoot, 'workspaces/revisions'), { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(this.runRoot, 'workspaces/revisions/.staging-'))
    try {
      const resources = await snapshotTarget(source, join(temporary, 'files'))
      const body = {
        version: 1 as const,
        id: revisionId,
        root_id: base?.root_id ?? revisionId,
        parent_id: base?.id ?? null,
        base_candidate_id: request.operation.parent_id!,
        base_digest: base?.base_digest ?? command.base_digest!,
        producer,
        resources,
      }
      const manifest = { ...body, digest: canonicalDigest(body) }
      await publishFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { immutable: true })
      await rename(temporary, destination)
      await syncDirectory(join(this.runRoot, 'workspaces/revisions'))
      return this.ref(manifest)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  async assertOpen(ref: WorkspaceRef, request: OperationRequest): Promise<void> {
    await this.verify(ref)
    try {
      const closed = JSON.parse(
        await readFile(join(this.runRoot, 'workspaces/closed', `${ref.root_id}.json`), 'utf8'),
      )
      if (closed.operation_id !== request.operationId || closed.request_digest !== canonicalDigest(request))
        throw new GearError('workspace-closed', 'Workspace has already been sealed or discarded')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  async close(ref: WorkspaceRef, request: OperationRequest): Promise<void> {
    await publishFile(
      join(this.runRoot, 'workspaces/closed', `${ref.root_id}.json`),
      JSON.stringify({
        operation_id: request.operationId,
        request_digest: canonicalDigest(request),
        source: ref,
        kind: request.operation.kind,
      }),
      { immutable: true },
    )
  }
}

/** Local workspace changes have durable receipts and never invoke the model provider. */
export class WorkspaceOperations {
  readonly store: WorkspaceStore
  constructor(readonly targets: TargetStore) {
    this.store = new WorkspaceStore(targets.runRoot)
  }
  private receiptPath(request: OperationRequest): string {
    return join(this.targets.runRoot, 'workspaces/operations', request.operationId.slice(7), 'receipt.json')
  }
  async inspect(request: OperationRequest): Promise<OperationReceipt | null> {
    try {
      const saved = JSON.parse(await readFile(this.receiptPath(request), 'utf8')) as {
        request_digest: string
        receipt: OperationReceipt
      }
      if (saved.request_digest !== canonicalDigest(request))
        throw new GearError(
          'workspace-operation-conflict',
          'Operation identity was reused with different inputs',
        )
      return saved.receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return null
  }
  async submit(request: OperationRequest): Promise<OperationReceipt> {
    const prior = await this.inspect(request)
    if (prior) return prior
    const operation = request.operation,
      command = workspaceCommand(operation)
    let ref: WorkspaceRef
    let candidate: OperationReceipt['candidate'] = null
    if (operation.kind === 'workspace_open') {
      const base = await this.targets.verify(operation.parent_id!)
      if (base.digest !== command.base_digest)
        throw new GearError('workspace-base-mismatch', 'Workspace base differs from the admitted candidate')
      ref = await this.store.save(request, this.targets.path(operation.parent_id!))
    } else {
      ref = command.source!
      await this.store.assertOpen(ref, request)
      if (operation.kind === 'workspace_apply') {
        const edits = (operation.payload as { edits?: Record<string, unknown> }).edits
        if (
          !edits ||
          typeof edits !== 'object' ||
          Array.isArray(edits) ||
          Object.values(edits).some((value) => value !== null && typeof value !== 'string')
        )
          throw new GearError('invalid-workspace-edits', 'Draft edits map allowed paths to text or null')
        for (const path of Object.keys(edits)) assertMutationPath(path, this.targets.adapter.mutationPolicy)
        const temporary = await mkdtemp(join(this.targets.runRoot, 'workspaces/.apply-'))
        try {
          const directory = join(temporary, 'files')
          const resources = await snapshotTarget(this.store.files(ref), directory)
          for (const [path, value] of Object.entries(edits)) {
            const file = join(directory, path)
            if (value === null) await rm(file, { force: true })
            else {
              await mkdir(dirname(file), { recursive: true })
              const old = resources.find((resource) => resource.path === path)
              if (old) await chmod(file, old.executable ? 0o700 : 0o600)
              await writeFile(file, value as string, { mode: 0o600 })
            }
          }
          ref = await this.store.save(request, directory)
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      } else {
        if (operation.kind === 'workspace_seal') {
          const parent = await this.targets.verify(ref.base_candidate_id)
          let reason: string | null = null
          if (canonicalDigest(parent.resources) === canonicalDigest((await this.store.verify(ref)).resources))
            reason = 'workspace unchanged'
          else {
            try {
              await this.targets.adapter.check(this.store.files(ref))
            } catch {
              reason = 'workspace failed Harness validation'
            }
          }
          if (reason) {
            const receipt: OperationReceipt = {
              result: {
                operation_id: request.operationId,
                kind: operation.kind,
                status: 'failed',
                candidate_id: operation.candidate_id,
                data: { reason },
              },
              candidate: null,
              evidence: [],
              physicalAttempts: 0,
              usage: { model_requests: 0, tokens: 0, dollars: 0 },
              provenance: { request_digest: canonicalDigest(request) },
            }
            await publishFile(
              this.receiptPath(request),
              JSON.stringify({ request_digest: canonicalDigest(request), receipt }),
              { immutable: true },
            )
            return receipt
          }
          const destination = this.targets.path(operation.candidate_id!)
          try {
            await targetResources(destination)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
            const temporary = await mkdtemp(join(dirname(destination), '.workspace-seal-'))
            try {
              await snapshotTarget(this.store.files(ref), join(temporary, 'files'))
              await rename(join(temporary, 'files'), destination)
              await syncDirectory(dirname(destination))
            } finally {
              await rm(temporary, { recursive: true, force: true })
            }
          }
          if (
            canonicalDigest(await targetResources(destination)) !==
            canonicalDigest((await this.store.verify(ref)).resources)
          )
            throw new GearError(
              'workspace-seal-conflict',
              'Candidate differs from the requested workspace revision',
            )
          const manifest = await this.targets.seal(operation.candidate_id!, '', operation.parent_id!)
          candidate = { id: operation.candidate_id!, parent_id: operation.parent_id, digest: manifest.digest }
        }
        await this.store.close(ref, request)
      }
    }
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: operation.kind,
        status: 'complete',
        candidate_id: operation.candidate_id,
        data: { workspace: ref } as unknown as Json,
      },
      candidate,
      evidence: [],
      physicalAttempts: 0,
      usage: { model_requests: 0, tokens: 0, dollars: 0 },
      provenance: { request_digest: canonicalDigest(request), workspace_digest: ref.digest },
    }
    await publishFile(
      this.receiptPath(request),
      JSON.stringify({ request_digest: canonicalDigest(request), receipt }),
      { immutable: true },
    )
    return receipt
  }
}
