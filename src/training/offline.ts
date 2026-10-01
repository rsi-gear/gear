import { digestJson } from './digest.js'
import { parseContentRef, requireContract } from './schema.js'
import type { TrainingContentStore } from './store.js'
import type * as T from './types.js'

/** Validate a closed allowlist of training examples, without traversing source task graphs. */
export async function readOfflineDataset(store: TrainingContentStore, ref: T.ContentRef, model: T.ModelVersion,
  train: T.DatasetPartition, maxTokens: number): Promise<T.OfflineSftDataset> {
  const data = await store.readJson<T.OfflineSftDataset>(ref)
  requireContract(data.schemaVersion === 1 && data.kind === 'offline-sft-dataset'
    && Object.keys(data).sort().join(',') === 'chatTemplateDigest,kind,maskContract,records,schemaVersion,tokenizerDigest'
    && data.tokenizerDigest === model.tokenizerDigest && data.chatTemplateDigest === model.chatTemplateDigest
    && data.maskContract === 'assistant-token-mask-v1' && Array.isArray(data.records) && data.records.length > 0,
  'invalid-offline-dataset', 'SFT dataset must use the frozen actor token semantics and assistant mask contract')
  requireContract(data.records.length <= 1024, 'offline-dataset-limit', 'offline SFT v1 supports at most 1024 records')
  let totalBytes = 0
  const seen = new Set<string>()
  for (const item of data.records) {
    const recordRef = parseContentRef(item)
    requireContract(!seen.has(recordRef.digest), 'duplicate-offline-record', 'SFT records must be unique'); seen.add(recordRef.digest)
    totalBytes += (await store.readBytes(recordRef)).length
    requireContract(totalBytes <= 4 * 1024 * 1024, 'offline-dataset-limit', 'offline SFT v1 tokenized records exceed 4 MiB')
    const record = await store.readJson<T.OfflineSftRecord>(recordRef)
    const { id, ...body } = record
    requireContract(record.schemaVersion === 1 && digestJson(body) === id
      && Object.keys(record).sort().join(',') === 'id,lossMask,schemaVersion,source,tokenRoles,tokens'
      && Object.keys(record.source ?? {}).sort().join(',') === 'family,taskDigest,taskId'
      && train.tasks.some(t => t.id === record.source.taskId && t.family === record.source.family && t.taskRef.digest === record.source.taskDigest),
    'offline-provenance-mismatch', 'each SFT example must identify an authorized train task, family and sealed task content')
    requireContract(Array.isArray(record.tokens) && record.tokens.length > 1 && record.tokens.length <= maxTokens
      && record.tokens.every(t => Number.isSafeInteger(t) && t >= 0 && t < 2147483648)
      && Array.isArray(record.lossMask) && Array.isArray(record.tokenRoles)
      && record.tokens.length === record.lossMask.length && record.tokens.length === record.tokenRoles.length
      && record.lossMask[0] === 0 && record.lossMask.some(m => m === 1)
      && record.lossMask.every((m, i) => (m === 0 || m === 1) && ['system', 'user', 'assistant', 'tool'].includes(record.tokenRoles[i]!)
        && (m === 0 || record.tokenRoles[i] === 'assistant')),
    'invalid-assistant-mask', 'SFT trains only assistant tokens and requires nonempty supervision and an untrained first token')
  }
  return data
}
export async function validateOfflineDataset(store: TrainingContentStore, spec: T.ModelTrainingSpec, model: T.ModelVersion): Promise<T.OfflineSftDataset> {
  const config = spec.offlineTraining!
  const data = await readOfflineDataset(store, config.datasetRef, model, spec.datasets.train, config.maxSequenceTokens)
  requireContract(spec.trainer.rolloutBatchSize * spec.trainer.updatesPerCandidate <= data.records.length * config.maxEpochs,
    'offline-dataset-exhausted', 'configured candidate exceeds the explicit offline epoch limit')
  return data
}
export async function validateOfflineBatch(store: TrainingContentStore, batch: T.OfflineSftBatchManifest,
  request: T.TrainingRequest, checkpoint: T.TrainerCheckpoint, validatedDataset?: T.OfflineSftDataset): Promise<void> {
  const config = request.offlineTraining
  requireContract(config && batch.datasetRef.digest === config.datasetRef.digest, 'batch-recipe-mismatch', 'SFT batch must consume the authorized dataset')
  const dataset = validatedDataset ?? await readOfflineDataset(store, config.datasetRef, request.parentModel, request.trainDataset, config.maxSequenceTokens)
  const samples = await store.readJson<T.OfflineSftRecord[]>(batch.samplesRef)
  const cursor = await store.readJson<{ committedUpdate: number; batchRef: T.ContentRef; position: number; datasetDigest: string }>(checkpoint.dataCursorRef)
  requireContract(batch.recordRefs.length === request.trainer.rolloutBatchSize && Array.isArray(samples) && samples.length === batch.recordRefs.length
    && batch.cursorBefore.position === (checkpoint.committedUpdate - 1) * request.trainer.rolloutBatchSize
    && batch.cursorAfter.position === checkpoint.committedUpdate * request.trainer.rolloutBatchSize
    && cursor.position === batch.cursorAfter.position && cursor.datasetDigest === config.datasetRef.digest
    && cursor.committedUpdate === checkpoint.committedUpdate && cursor.batchRef.digest === digestJson(batch)
    && batch.cursorAfter.position <= dataset.records.length * config.maxEpochs,
  'offline-cursor-drift', 'SFT batch and atomic checkpoint must advance the bounded dataset cursor together')
  const expected = offlineWindow(dataset.records, config.shuffleSeed, batch.cursorBefore.position, samples.length)
  for (let i = 0; i < samples.length; i++) requireContract(batch.recordRefs[i]!.digest === expected[i]!.digest
    && digestJson(samples[i]) === expected[i]!.digest, 'offline-batch-drift', 'SFT batch changed deterministic record order or contents')
}
export function offlineWindow(records: T.ContentRef[], seed: number, position: number, size: number): T.ContentRef[] {
  const result: T.ContentRef[] = []
  const permutations = new Map<number, T.ContentRef[]>()
  for (let index = position; index < position + size; index++) {
    const epoch = Math.floor(index / records.length)
    if (!permutations.has(epoch)) permutations.set(epoch, records.map((ref, i) => ({ ref, i, key: digestJson({ seed, epoch, index: i }) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i).map(item => item.ref))
    result.push(permutations.get(epoch)![index % records.length]!)
  }
  return result
}
