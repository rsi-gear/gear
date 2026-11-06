import { publishFile, syncDirectory } from '../adapters/storage/atomic.js'
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
import { proposalInputsDigest, proposalSpec } from './iteration-policy.js'

export const digestBytes = (bytes: Uint8Array | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** fsync data, rename, then fsync its directory: no partial manifest is a commit. */
export async function atomicWrite(path: string, value: unknown): Promise<void> {
  await publishFile(path, `${stableJson(value)}\n`)
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
    // Historical experiments retain their exact bytes and digests for inspection.
    // Their removed managed runtime cannot be resumed by the endpoint coordinator.
    const provider = String(state.spec.evaluation.provider)
    if (provider === 'hitch-endpoint') parseModelTrainingSpec(state.spec)
    else requireContract(['hitch-managed-local', 'hitch-managed'].includes(provider) && [1, 2].includes(state.spec.schemaVersion),
      'invalid-state', 'unknown historical model experiment contract')
    requireContract(digestJson(state.spec) === state.specDigest, 'experiment-drift', 'sealed experiment specification changed')
    requireContract(state.runs !== null && typeof state.runs === 'object' && Array.isArray(state.releases), 'invalid-state', 'invalid model state')
    validateIterationState(state)
    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.evaluationControl) requireContract(Object.keys(run.evaluationControl).length === 3 && run.evaluationControl.schemaVersion === 2
        && Number.isSafeInteger(run.evaluationControl.sequence) && run.evaluationControl.sequence >= 0
        && ['start', 'pause'].includes(run.evaluationControl.action), 'invalid-evaluation-control', 'saved evaluation control intent is invalid')
      if (run.trainingControl) requireContract(state.spec.schemaVersion === 2 && Object.keys(run.trainingControl).length === 3 && run.trainingControl.schemaVersion === 2
        && Number.isSafeInteger(run.trainingControl.sequence) && run.trainingControl.sequence >= 0
        && ['start', 'pause'].includes(run.trainingControl.action), 'invalid-training-control', 'saved training control intent is invalid')
      const request = parseTrainingRequest(run.request)
      const selected = proposalSpec(state.spec, run.iterationRound?.proposalIndex)
      requireContract(run.id === runId && request.trainingRunId === runId && request.experimentId === id
        && request.parentModelRef.digest === run.parent.modelRef.digest && request.referenceModelRef.digest === state.spec.referenceModel.digest
        && digestJson(request.trainer) === digestJson(selected.trainer) && digestJson(request.rollout) === digestJson(selected.rollout)
        && digestJson(request.offlineTraining ?? null) === digestJson(selected.offlineTraining ?? null)
        && digestJson(request.stages ?? null) === digestJson(selected.stages ?? null)
        && request.schemaVersion === state.spec.schemaVersion && digestJson(request.trainingDevices) === digestJson(state.spec.resources.trainingDevices)
        && (request.schemaVersion !== 2 || (state.spec.schemaVersion === 2 && digestJson(request.deployment) === digestJson(state.spec.deployment)))
        && digestJson(request.fixedHarness) === digestJson(state.spec.fixedHarness) && digestJson(request.trainDataset) === digestJson(selected.datasets.train),
        'training-request-drift', 'saved run differs from its frozen experiment')
      requireContract(request.deadlineAt === state.iteration?.deadlineAt, 'training-deadline-drift', 'automatic training retains the original experiment deadline')
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
      validateIterationState(state)
      await atomicWrite(this.statePath(id), state)
      return result
    })
  }
  private async locked<R>(id: string, fn: () => Promise<R>): Promise<R> {
    return withTrainingFileLock(`${this.statePath(id)}.lock`, fn)
  }
}

/** New experiments opt in explicitly; old bytes and their recovery remain intact. */
function validateIterationState(state: ModelExperimentState): void {
  const policy = state.spec.iteration, iteration = state.iteration
  requireContract(!!policy === !!iteration, 'invalid-iteration-state', 'iteration state must match the frozen opt-in policy')
  if (iteration && policy) {
    const validSequence = Number.isSafeInteger(iteration.control?.sequence) && iteration.control.sequence >= 0
    requireContract(iteration.schemaVersion === 1 && validSequence && ['running', 'pausing', 'paused', 'completed', 'failed'].includes(iteration.status)
      && ['start', 'pause'].includes(iteration.control.action)
      && (iteration.status === 'running' && iteration.recovery?.phase === 'pausing'
        ? iteration.control.action === 'pause' : (iteration.status === 'running') === (iteration.control.action === 'start'))
      && Number.isFinite(Date.parse(iteration.startedAt)) && Date.parse(iteration.deadlineAt) === Date.parse(iteration.startedAt) + policy.maxWallClockSeconds * 1000
      && Number.isSafeInteger(iteration.consecutiveRejected) && iteration.consecutiveRejected >= 0
      && Number.isSafeInteger(iteration.nextProposalIndex) && iteration.nextProposalIndex >= 0 && iteration.nextProposalIndex < policy.proposals.length,
    'invalid-iteration-state', 'saved iteration control, deadline or proposal cursor is invalid')
    const entries = Object.entries(iteration.rounds)
    requireContract(entries.length <= policy.maxRounds && entries.every(([index], i) => index === String(i)),
      'invalid-iteration-rounds', 'rounds must form one contiguous durable admission ledger')
    const runs = new Set<string>()
    for (const [index, round] of entries) {
      const run = state.runs[round.runId], identity = run?.iterationRound
      requireContract(run && identity && !runs.has(run.id) && identity.roundIndex === Number(index)
        && identity.proposalIndex === round.proposalIndex && identity.proposalId === policy.proposals[round.proposalIndex]?.id
        && identity.inputsDigest === proposalInputsDigest(state.spec, round.proposalIndex)
        && Number.isSafeInteger(round.recoveries) && round.recoveries >= 0 && round.recoveries <= policy.recovery.maxRunRecoveries
        && (!round.outcome || round.outcome === run.decision?.outcome)
        && (iteration.activeRoundIndex === Number(index) || !!round.outcome),
      'invalid-iteration-rounds', 'round admission, proposal or committed decision differs')
      runs.add(run.id)
    }
    requireContract(Object.keys(state.runs).length === runs.size
      && (iteration.activeRoundIndex === undefined || Number.isSafeInteger(iteration.activeRoundIndex)
        && iteration.rounds[String(iteration.activeRoundIndex)] && !iteration.rounds[String(iteration.activeRoundIndex)]!.outcome),
    'invalid-iteration-rounds', 'an automatic experiment has exactly one current round and no unmapped runs')
    requireContract(!iteration.recovery || iteration.status === 'running' && iteration.recovery.roundIndex === iteration.activeRoundIndex
      && ['pausing', 'resuming'].includes(iteration.recovery.phase), 'invalid-iteration-recovery', 'recovery is bound to the current automatic round')
  }
  requireContract(!state.endpointControl || state.spec.endpointPreparation && Number.isSafeInteger(state.endpointControl.sequence)
    && state.endpointControl.sequence >= 0 && ['start', 'pause'].includes(state.endpointControl.action)
    && Number.isFinite(Date.parse(state.endpointControl.deadlineAt))
    && (!iteration || state.endpointControl.sequence === iteration.control.sequence && state.endpointControl.action === iteration.control.action
      && state.endpointControl.deadlineAt === iteration.deadlineAt),
  'invalid-endpoint-control', 'deployment authority needs an ordered control and fixed deadline')
  requireContract(!state.spec.endpointPreparation || !!state.endpointControl, 'invalid-endpoint-control', 'managed authorization requires its own persistent command fence')
}
