import { jsonProcess } from './process.js'
import { parseTrainingArtifacts, parseTrainingCapabilities, parseTrainingHandle, parseTrainingRequest, parseTrainingStatus, parseUpdateCommit } from './schema.js'
import type { ModelTrainer, ModelVersion, TrainerCheckpoint, TrainingHandle, TrainingRequest } from './types.js'
import { digestJson } from './digest.js'
import { contentDependencies, ModelNodeTransport, syncContentGraph, uploadSnapshotFiles } from './transport.js'
import { TrainingContentStore } from './store.js'
import { requireContract } from './schema.js'
import type { TrainingEpisodeCoordinator } from './episodes.js'
import type { TrainingControlIntent, TrainingRequestV2, TrainingStatus } from './types.js'
import { retainContentGraph } from './retention.js'

export interface SlimeTrainerOptions { python: string[]; configPath: string; rpcTimeoutMs?: number }
/** Calls the packaged Python bridge installed in the locked training environment. */
export class SlimeModelTrainer implements ModelTrainer {
  constructor(readonly options: SlimeTrainerOptions) {}
  private call(action: string, body: unknown) {
    return jsonProcess(this.options.python, ['-m', 'gear_training.job', action, '--config', this.options.configPath], body, this.options.rpcTimeoutMs ?? 60_000)
  }
  async preflight(request: TrainingRequest) { return parseTrainingCapabilities(await this.call('preflight', { request: parseTrainingRequest(request) })) }
  async submit(request: TrainingRequest, idempotencyKey: string) { return parseTrainingHandle(await this.call('submit', { request: parseTrainingRequest(request), idempotencyKey })) }
  async inspect(handle: TrainingHandle) { return parseTrainingStatus(await this.call('inspect', { handle: parseTrainingHandle(handle) })) }
  async cancel(handle: TrainingHandle) { return parseTrainingStatus(await this.call('cancel', { handle: parseTrainingHandle(handle) })) }
  async collect(handle: TrainingHandle) { return parseTrainingArtifacts(await this.call('collect', { handle: parseTrainingHandle(handle) })) }
}

/** V2 uses a node protocol plus explicit CAS synchronization, even on one host. */
export class NodeSlimeModelTrainer implements ModelTrainer {
  constructor(readonly transport: ModelNodeTransport, readonly store: TrainingContentStore,
    readonly episodes: Pick<TrainingEpisodeCoordinator, 'preflight' | 'remember' | 'reconcile' | 'withControl'>,
    readonly artifactStorage: 'controller' | 'model-node' = 'controller') {
    requireContract(transport.identity, 'node-not-resolved', 'a node trainer needs a frozen node identity')
  }
  private validateRequest(input: TrainingRequest): TrainingRequestV2 {
    const request = parseTrainingRequest(input)
    requireContract(request.schemaVersion === 2 && request.deployment.modelRuntime.nodeId === this.transport.identity!.nodeId
      && request.deployment.modelRuntime.generation === this.transport.identity!.generation,
    'training-node-drift', 'training request belongs to another model-node generation')
    return request
  }
  private localHandle(input: TrainingHandle): TrainingHandle {
    const handle = parseTrainingHandle(input)
    requireContract(handle.schemaVersion === 2 && digestJson(handle.node) === digestJson(this.transport.identity), 'training-node-drift', 'job handle belongs to another model node')
    const { node: _, ...body } = handle
    return { ...body, schemaVersion: 1 }
  }
  private async inputs(request: TrainingRequest): Promise<void> {
    // Explicit allowlist: task snapshots, environment/verifier contents and
    // dev/held-out artifacts stay with the controller/Harbor workers.
    const reference = await this.store.readJson<ModelVersion>(request.referenceModelRef)
    const descriptors = [request.parentModelRef, request.referenceModelRef, request.trainer.hyperparametersRef, ...request.trainer.runtimeLock.probeEvidenceRefs]
    const files = [request.parentModel.hfSnapshotRef, reference.hfSnapshotRef]
    if (request.resumeCheckpointRef) {
      const checkpoint = await this.store.readJson<TrainerCheckpoint>(request.resumeCheckpointRef)
      descriptors.push(request.resumeCheckpointRef, checkpoint.dataCursorRef)
      files.push(checkpoint.actorStateRef, checkpoint.optimizerStateRef, checkpoint.schedulerAndRngRef, checkpoint.hfExportRef)
    }
    for (const ref of descriptors) await this.transport.upload(this.store, ref)
    // Model provenance, historical task refs and raw probe evidence may point
    // at controller-only data. Only manifest-listed file bytes are uploaded; JSON files are opaque.
    await uploadSnapshotFiles(this.transport, this.store, files)
  }
  async preflight(input: TrainingRequest) {
    const request = this.validateRequest(input)
    const observed = await this.transport.call('probe', {}) as { capabilities?: { orderedTrainingControl?: boolean } }
    requireContract(observed?.capabilities?.orderedTrainingControl === true, 'training-control-unavailable', 'model node must support ordered v2 training control before admission')
    requireContract(this.artifactStorage !== 'model-node' || (observed.capabilities as { remoteCasRetention?: boolean }).remoteCasRetention === true,
      'remote-retention-unavailable', 'model node must support remote CAS retention before admission')
    await this.episodes.preflight(request)
    await this.inputs(request)
    return parseTrainingCapabilities(await this.transport.call('training.preflight', { request }))
  }
  async submit(input: TrainingRequest, idempotencyKey: string) {
    return (await this.control(input, idempotencyKey, { schemaVersion: 2, sequence: 0, action: 'start' })).handle
  }
  async control(input: TrainingRequest, idempotencyKey: string, intent: TrainingControlIntent) {
    const request = this.validateRequest(input)
    requireContract(typeof idempotencyKey === 'string' && !!idempotencyKey, 'missing-idempotency-key', 'node training requires a submission key')
    requireContract(intent.schemaVersion === 2 && Number.isSafeInteger(intent.sequence) && intent.sequence >= 0
      && ['start', 'pause'].includes(intent.action), 'invalid-training-control', 'ordered control requires a valid intent')
    const jobId = `job_${digestJson(idempotencyKey).slice(7, 39)}`
    await this.episodes.remember(request, jobId)
    if (intent.action === 'start') await this.inputs(request)
    const local: TrainingHandle = { schemaVersion: 1, provider: 'slime', jobId, requestDigest: digestJson(request) }
    // Serialize the node observation/command and its episode reconciliation.
    // A slow old pause reply must finish cancelling its old slots before a
    // newer start can admit another incarnation's episodes.
    return this.episodes.withControl(local, async reconcile => {
      if (intent.action === 'start') {
        const existing = await this.transport.call('training.find', { idempotencyKey, requestDigest: digestJson(request) }) as { exists: boolean; status?: unknown }
        requireContract(typeof existing?.exists === 'boolean', 'invalid-job-lookup', 'node did not establish durable submission identity')
        if (existing.exists) {
          const status = parseTrainingStatus(existing.status)
          requireContract(status.handle.jobId === jobId && status.handle.requestDigest === digestJson(request), 'training-request-drift', 'existing command belongs to another job')
          if (!['running', 'completed'].includes(status.execution)) {
            requireContract(status.resourcesReleased, 'previous-resources-not-released', 'previous trainer incarnation still owns resources')
            requireContract(!(await reconcile(true)).pending, 'controller-episodes-pending', 'old Hitch slots must terminate before resuming the trainer')
          }
        }
      }
      const status = parseTrainingStatus(await this.transport.call('training.control', { request, idempotencyKey, intent },
        `control_${digestJson([idempotencyKey, intent]).slice(7)}`))
      requireContract(status.handle.schemaVersion === 1 && status.handle.jobId === jobId && status.handle.requestDigest === digestJson(request),
        'training-request-drift', 'node control returned another immutable job')
      const episodes = await reconcile(intent.action === 'pause' || ['paused', 'failed', 'blocked', 'interrupted'].includes(status.execution))
      return parseTrainingStatus({ ...status, handle: { ...status.handle, schemaVersion: 2, node: this.transport.identity },
        resourcesReleased: status.resourcesReleased && !episodes.pending })
    })
  }
  private async status(handle: TrainingHandle) {
    const local = this.localHandle(handle)
    return this.episodes.withControl(local, async reconcile => {
      const status = parseTrainingStatus(await this.transport.call('training.inspect', { handle: local }))
      requireContract(digestJson(status.handle) === digestJson(local), 'training-handle-drift', 'node returned status for another job')
      const episodes = await reconcile(['paused', 'failed', 'blocked', 'interrupted'].includes(status.execution))
      return parseTrainingStatus({ ...status, handle, resourcesReleased: status.resourcesReleased && !episodes.pending })
    })
  }
  inspect(handle: TrainingHandle) { return this.status(handle) }
  async cancel(_handle: TrainingHandle): Promise<TrainingStatus> {
    requireContract(false, 'training-control-required', 'v2 cancellation requires the original request/key and an ordered pause intent through control()')
  }
  async collect(handle: TrainingHandle) {
    const local = this.localHandle(handle)
    requireContract(!(await this.episodes.reconcile(local)).pending, 'controller-episodes-pending', 'all controller episodes must be resolved before collection')
    const artifacts = parseTrainingArtifacts(await this.transport.call('training.collect', { handle: local }))
    requireContract(digestJson(artifacts.handle) === digestJson(local), 'training-handle-drift', 'node returned another job artifact')
    if (this.artifactStorage === 'model-node') {
      await retainContentGraph(this.transport, this.store, contentDependencies(artifacts))
      return parseTrainingArtifacts({ ...artifacts, handle })
    }
    await syncContentGraph(this.transport, this.store, contentDependencies(artifacts), 'download')
    for (const ref of artifacts.updateCommitRefs) {
      const commit = parseUpdateCommit(await this.store.readJson(ref))
      await syncContentGraph(this.transport, this.store, [{ uri: `cas:${commit.consumedBatchDigest}`, digest: commit.consumedBatchDigest, mediaType: 'application/json' }], 'download')
    }
    // A successful JSON reply alone never completes collect. All promised CAS
    // dependencies must now be durable in the controller store.
    return parseTrainingArtifacts({ ...artifacts, handle })
  }
}
