import type * as T from '../../../src/training/types.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { digestJson } from '../../../src/training/digest.js'
import { sealModelVersion } from '../../../src/training/schema.js'
import { offlineWindow } from '../../../src/training/offline.js'
import { FixtureTrainer } from './fixture.js'

export async function offlineDataset(store: ModelTrainingStore, model: T.ModelVersion, train: T.DatasetPartition): Promise<T.OfflineTraining> {
  const task = train.tasks[0]!
  const records: T.ContentRef[] = []
  for (let i = 0; i < 4; i++) {
    const body = { schemaVersion: 1 as const, source: { taskId: task.id, family: task.family, taskDigest: task.taskRef.digest },
      tokens: [1, 2, 3 + i, 90, 4], lossMask: [0, 0, 1, 0, 1], tokenRoles: ['user', 'user', 'assistant', 'tool', 'assistant'] }
    records.push(await store.putJson({ ...body, id: digestJson(body) }))
  }
  return { datasetRef: await store.putJson({ schemaVersion: 1, kind: 'offline-sft-dataset', records,
    tokenizerDigest: model.tokenizerDigest, chatTemplateDigest: model.chatTemplateDigest, maskContract: 'assistant-token-mask-v1' }),
    shuffleSeed: 23, maxEpochs: 2, maxSequenceTokens: 64, maskContract: 'assistant-token-mask-v1' }
}
export class OfflineFixtureTrainer extends FixtureTrainer {
  override async inspect(handle: T.TrainingHandle): Promise<T.TrainingStatus> {
    const status = await super.inspect(handle)
    return { ...status, usage: { ...status.usage, rolloutTokens: 0 } }
  }
  override async preflight(request: T.TrainingRequest): Promise<T.TrainingCapabilities> {
    return { ...await super.preflight(request), trainingExternalBinding: false, exactPolicyTokens: false, policyFencing: false }
  }
  override async collect(handle: T.TrainingHandle): Promise<T.TrainingArtifacts> {
    const original = await super.collect(handle), request = this.requests.at(-1)!, config = request.offlineTraining!
    const checkpoint = await this.storeForOffline.readJson<T.TrainerCheckpoint>(original.checkpointRef)
    const data = await this.storeForOffline.readJson<T.OfflineSftDataset>(config.datasetRef)
    const position = (checkpoint.committedUpdate - 1) * request.trainer.rolloutBatchSize
    const recordRefs = offlineWindow(data.records, config.shuffleSeed, position, request.trainer.rolloutBatchSize)
    const body = { schemaVersion: 3, kind: 'offline-sft-batch', trainingRunId: request.trainingRunId,
      recipeDigest: request.recipeDigest, datasetSplitDigest: request.datasetSplitDigest, datasetRef: config.datasetRef,
      samplesRef: await this.storeForOffline.putJson(await Promise.all(recordRefs.map(ref => this.storeForOffline.readJson(ref)))),
      recordRefs, cursorBefore: { position }, cursorAfter: { position: position + recordRefs.length }, state: 'sealed' }
    const batchRef = await this.storeForOffline.putJson({ ...body, id: digestJson(body) })
    checkpoint.dataCursorRef = await this.storeForOffline.putJson({ committedUpdate: checkpoint.committedUpdate,
      batchRef, position: position + recordRefs.length, datasetDigest: config.datasetRef.digest })
    const checkpointRef = await this.storeForOffline.putJson(checkpoint)
    const commit = await this.storeForOffline.readJson<T.UpdateCommitManifest>(original.updateCommitRefs[0]!)
    const updateCommitRefs = [await this.storeForOffline.putJson({ ...commit, checkpointRef, consumedBatchDigest: batchRef.digest, dataCursorRef: checkpoint.dataCursorRef })]
    const { id: _, ...model } = original.model
    return { ...original, checkpointRef, updateCommitRefs, usage: { ...original.usage, rolloutTokens: 0 },
      model: sealModelVersion({ ...model, trainerCheckpointRef: checkpointRef,
        provenanceRef: await this.storeForOffline.putJson({ recipeDigest: request.recipeDigest, updateCommitRefs }) }),
      exportValidationRef: await this.storeForOffline.putJson({ schemaVersion: 1, valid: true, weightsDigest: model.weightsDigest,
        checkpointDigest: checkpointRef.digest, hfSnapshotDigest: model.hfSnapshotRef.digest }) }
  }
  constructor(readonly storeForOffline: ModelTrainingStore) { super(storeForOffline) }
}
