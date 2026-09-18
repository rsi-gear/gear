import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stableJson, digestJson } from './digest.js'
import { parseContentRef, parseModelTrainingSpec, parseTrainingRequest, requireContract } from './schema.js'
import { withTrainingFileLock } from './file-lock.js'
export { withTrainingFileLock } from './file-lock.js'
import type { ContentRef, ModelExperimentState } from './types.js'

export const digestBytes = (bytes: Uint8Array | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** fsync data, rename, then fsync its directory: no partial manifest is a commit. */
export async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = await open(temp, 'wx', 0o600)
  try { await fd.writeFile(`${stableJson(value)}\n`); await fd.sync() } finally { await fd.close() }
  try { await rename(temp, path); await syncDirectory(dirname(path)) } finally { await rm(temp, { force: true }) }
}
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export class TrainingContentStore {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }
  path(digest: string): string {
    requireContract(/^sha256:[0-9a-f]{64}$/.test(digest), 'invalid-digest', 'content digest must be sha256')
    return join(this.root, 'objects', digest.slice(7, 9), digest.slice(7))
  }
  async putBytes(bytes: Uint8Array, mediaType: string): Promise<ContentRef> {
    const digest = digestBytes(bytes)
    const path = this.path(digest)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = await open(temp, 'wx', 0o600)
    try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
    try {
      try { await link(temp, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      requireContract(digestBytes(await readFile(path)) === digest, 'corrupt-content', `immutable object is corrupt: ${digest}`)
      await syncDirectory(dirname(path))
    } finally { await rm(temp, { force: true }) }
    return { uri: `cas:${digest}`, digest, mediaType }
  }
  async putJson(value: unknown): Promise<ContentRef> { return this.putBytes(Buffer.from(stableJson(value)), 'application/json') }
  async verifyFile(ref: ContentRef): Promise<{ path: string; size: number }> {
    requireContract(ref.uri === `cas:${ref.digest}`, 'nonportable-content-ref', 'distributed artifacts must be stored in CAS')
    const path = this.path(ref.digest); const hash = createHash('sha256'); let size = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += (chunk as Buffer).length }
    requireContract(`sha256:${hash.digest('hex')}` === ref.digest, 'content-digest-mismatch', 'CAS object changed during streaming verification')
    return { path, size }
  }
  async importStream(ref: ContentRef, expectedSize: number, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    requireContract(ref.uri === `cas:${ref.digest}` && Number.isSafeInteger(expectedSize) && expectedSize >= 0,
      'invalid-stream-content', 'stream import requires a portable CAS ref and exact size')
    const path = this.path(ref.digest); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.incoming`; const fd = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256'); let received = 0
    try {
      for await (const bytes of chunks) {
        received += bytes.length
        requireContract(received <= expectedSize, 'content-transfer-overflow', 'stream exceeds the declared object size')
        hash.update(bytes)
        let written = 0
        while (written < bytes.length) { const result = await fd.write(bytes, written, bytes.length - written); written += result.bytesWritten }
      }
      requireContract(received === expectedSize, 'content-transfer-truncated', 'stream ended before the declared object size')
      requireContract(`sha256:${hash.digest('hex')}` === ref.digest, 'content-digest-mismatch', 'streamed object failed its digest')
      await fd.sync()
      try { await link(temporary, path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      await this.verifyFile(ref); await syncDirectory(dirname(path))
    } finally { await fd.close(); await rm(temporary, { force: true }) }
  }
  async readBytes(input: ContentRef): Promise<Buffer> {
    const ref = parseContentRef(input)
    let path: string
    if (ref.uri === `cas:${ref.digest}`) path = this.path(ref.digest)
    else {
      requireContract(ref.uri.startsWith('file:'), 'unsupported-content-uri', 'content must be in CAS or an explicit file URL')
      path = fileURLToPath(ref.uri)
    }
    const bytes = await readFile(path)
    requireContract(digestBytes(bytes) === ref.digest, 'content-digest-mismatch', `content changed: ${ref.uri}`)
    return bytes
  }
  async readJson<T = unknown>(ref: ContentRef): Promise<T> {
    requireContract(ref.mediaType === 'application/json', 'invalid-media-type', 'expected JSON content')
    return JSON.parse((await this.readBytes(ref)).toString('utf8')) as T
  }
}

/** Short transactions only. Never hold the state lock across GPU jobs or network I/O. */
export class ModelTrainingStore extends TrainingContentStore {
  private statePath(id: string): string {
    requireContract(/^exp_[0-9a-f]{32}$/.test(id), 'invalid-experiment-id', 'invalid model experiment id')
    return join(this.root, 'model-training-v1', id, 'state.json')
  }
  async load(id: string): Promise<ModelExperimentState> {
    const state = JSON.parse(await readFile(this.statePath(id), 'utf8')) as ModelExperimentState
    requireContract(state.schemaVersion === 1 && state.id === id, 'invalid-state', 'model experiment identity mismatch')
    parseModelTrainingSpec(state.spec)
    requireContract(digestJson(state.spec) === state.specDigest, 'experiment-drift', 'sealed experiment specification changed')
    requireContract(state.runs !== null && typeof state.runs === 'object' && Array.isArray(state.releases), 'invalid-state', 'invalid model state')
    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.evaluationControl) requireContract(state.spec.schemaVersion === 2 && Object.keys(run.evaluationControl).length === 3 && run.evaluationControl.schemaVersion === 2
        && Number.isSafeInteger(run.evaluationControl.sequence) && run.evaluationControl.sequence >= 0
        && ['start', 'pause'].includes(run.evaluationControl.action), 'invalid-evaluation-control', 'saved evaluation control intent is invalid')
      if (run.trainingControl) requireContract(state.spec.schemaVersion === 2 && Object.keys(run.trainingControl).length === 3 && run.trainingControl.schemaVersion === 2
        && Number.isSafeInteger(run.trainingControl.sequence) && run.trainingControl.sequence >= 0
        && ['start', 'pause'].includes(run.trainingControl.action), 'invalid-training-control', 'saved training control intent is invalid')
      const request = parseTrainingRequest(run.request)
      requireContract(run.id === runId && request.trainingRunId === runId && request.experimentId === id
        && request.parentModelRef.digest === run.parent.modelRef.digest && request.referenceModelRef.digest === state.spec.referenceModel.digest
        && digestJson(request.trainer) === digestJson(state.spec.trainer) && digestJson(request.rollout) === digestJson(state.spec.rollout)
        && request.schemaVersion === state.spec.schemaVersion && digestJson(request.trainingDevices) === digestJson(state.spec.resources.trainingDevices)
        && (request.schemaVersion !== 2 || (state.spec.schemaVersion === 2 && digestJson(request.deployment) === digestJson(state.spec.deployment)))
        && digestJson(request.fixedHarness) === digestJson(state.spec.fixedHarness) && digestJson(request.trainDataset) === digestJson(state.spec.datasets.train),
        'training-request-drift', 'saved run differs from its frozen experiment')
    }
    return state
  }
  async create(state: ModelExperimentState): Promise<void> {
    await this.locked(state.id, async () => {
      let exists = true
      try { await stat(this.statePath(state.id)) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e }
      requireContract(!exists, 'experiment-exists', 'experiment already exists')
      await atomicWrite(this.statePath(state.id), state)
    })
  }
  async transaction<R>(id: string, fn: (state: ModelExperimentState) => R | Promise<R>): Promise<R> {
    return this.locked(id, async () => {
      const state = await this.load(id)
      const result = await fn(state)
      requireContract(digestJson(state.spec) === state.specDigest, 'experiment-drift', 'a transaction cannot modify the frozen specification')
      await atomicWrite(this.statePath(id), state)
      return result
    })
  }
  private async locked<R>(id: string, fn: () => Promise<R>): Promise<R> {
    return withTrainingFileLock(`${this.statePath(id)}.lock`, fn)
  }
}
