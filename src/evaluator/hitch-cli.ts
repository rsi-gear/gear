import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HitchConfig } from '../config.js'
import type {
  EvaluationRequest,
  EvaluationRerunResult,
  EvaluationRerunSelector,
  EvaluationReservation,
  EvaluationTrialSlot,
  FailedEvaluationEvidence,
  HitchCapabilities,
  HitchEvaluationEvidence,
  HitchTrajectoryAnalysis,
  HitchTrajectoryChunkSummary,
  HitchTrajectoryContentExcerpt,
  HitchTrajectoryEventsPage,
  HitchTrajectoryEventsQuery,
  HitchTrajectoryReader,
  HitchTrajectoryRequestBoundary,
  HitchTrajectorySurfaceNode,
  HitchTrialSummary,
  HitchVerifierEvidence,
  InvalidEvaluationTrialSummary,
  LocalSourceTransportSummary,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
  ScoreSummary,
} from '../types.js'
import { isExactGitCommit } from '../types.js'

export interface HitchCliEvaluatorOptions extends HitchConfig {
  repositoryPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface SharedTrajectoryLoad {
  promise: Promise<HitchTrajectoryAnalysis>
  controller: AbortController
  waiters: number
  settled: boolean
}

interface HitchEvaluationIdentity {
  provider: 'hitch-cli'
  effectiveConfigDigest: string
  invocationFingerprint: string
}

type JsonRecord = Record<string, unknown>

interface ParsedRunTrial {
  taskName: string
  trialName: string
  runId: string
  attempt: number
  observationStatus: 'valid' | 'invalid'
  reward?: number
  invalidReason?: string
}

export class HitchEvaluationError extends Error {
  constructor(
    message: string,
    readonly code = 'hitch_evaluation_failed',
    readonly failedEvidence?: FailedEvaluationEvidence,
  ) {
    super(message)
    this.name = 'HitchEvaluationError'
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HitchEvaluationError(`${label} must be an object`, 'invalid_hitch_result')
  }
  return value as JsonRecord
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HitchEvaluationError(`${label} must be a non-empty string`, 'invalid_hitch_result')
  }
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HitchEvaluationError(`${label} must be a finite number`, 'invalid_hitch_result')
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HitchEvaluationError(`${label} must be a non-negative integer`, 'invalid_hitch_result')
  }
  return value as number
}

function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finite(value, label)
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function jsonValue(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`)]))
  }
  throw new HitchEvaluationError(`${label} must be JSON`, 'invalid_hitch_result')
}

const VERIFIER_ARTIFACT_NAMES = new Set([
  'ctrf.json',
  'test-stdout.txt',
  'test-stderr.txt',
  'stdout.txt',
  'stderr.txt',
])

function exactFields(value: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed)
  const unexpected = Object.keys(value).find(field => !allowedFields.has(field))
  if (unexpected !== undefined) {
    throw new HitchEvaluationError(`${label} has unknown field: ${unexpected}`, 'invalid_hitch_result')
  }
}

function verifierArtifact(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  const artifact = record(value, label)
  exactFields(artifact, ['name', 'media_type', 'bytes', 'sha256', 'truncated', 'json', 'text'], label)
  const name = string(artifact.name, `${label}.name`)
  if (!VERIFIER_ARTIFACT_NAMES.has(name)) {
    throw new HitchEvaluationError(`${label}.name is invalid`, 'invalid_hitch_result')
  }
  const mediaType = string(artifact.media_type, `${label}.media_type`)
  const expectedMediaType = name === 'ctrf.json' ? 'application/json' : 'text/plain'
  if (mediaType !== expectedMediaType) {
    throw new HitchEvaluationError(`${label}.media_type is invalid`, 'invalid_hitch_result')
  }
  const bytes = integer(artifact.bytes, `${label}.bytes`)
  const sha256 = string(artifact.sha256, `${label}.sha256`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(sha256)) {
    throw new HitchEvaluationError(`${label}.sha256 is invalid`, 'invalid_hitch_result')
  }
  if (typeof artifact.truncated !== 'boolean') {
    throw new HitchEvaluationError(`${label}.truncated must be boolean`, 'invalid_hitch_result')
  }
  const hasJson = artifact.json !== undefined
  const hasText = artifact.text !== undefined
  if (hasJson === hasText) {
    throw new HitchEvaluationError(`${label} requires exactly one content representation`, 'invalid_hitch_result')
  }
  if (hasText && typeof artifact.text !== 'string') {
    throw new HitchEvaluationError(`${label}.text must be a string`, 'invalid_hitch_result')
  }
  if (hasJson && (mediaType !== 'application/json' || artifact.truncated)) {
    throw new HitchEvaluationError(`${label} may use json only for complete JSON content`, 'invalid_hitch_result')
  }
  if (mediaType === 'application/json' && !artifact.truncated && !hasJson) {
    throw new HitchEvaluationError(`${label} requires json for complete JSON content`, 'invalid_hitch_result')
  }
  return {
    name,
    media_type: mediaType,
    bytes,
    sha256,
    truncated: artifact.truncated,
    ...(hasJson
      ? { json: jsonValue(artifact.json, `${label}.json`) }
      : { text: artifact.text as string }),
  }
}

function verifierDiagnostics(value: unknown): {
  value: import('@deepseek-ai/dsh-session').JsonValue
  hasArtifacts: boolean
} {
  const diagnostics = record(value, 'verifier evidence diagnostics')
  exactFields(
    diagnostics,
    ['ctrf', 'stdout', 'stderr', 'infrastructure_error', 'retry_history'],
    'verifier evidence diagnostics',
  )
  const ctrf = diagnostics.ctrf === undefined
    ? undefined
    : verifierArtifact(diagnostics.ctrf, 'verifier evidence diagnostics.ctrf')
  const artifactArray = (field: 'stdout' | 'stderr'): import('@deepseek-ai/dsh-session').JsonValue[] | undefined => {
    const source = diagnostics[field]
    if (source === undefined) return undefined
    if (!Array.isArray(source)) {
      throw new HitchEvaluationError(`verifier evidence diagnostics.${field} must be an array`, 'invalid_hitch_result')
    }
    return source.map((item, index) => verifierArtifact(
      item,
      `verifier evidence diagnostics.${field}[${index}]`,
    ))
  }
  const stdout = artifactArray('stdout')
  const stderr = artifactArray('stderr')
  const infrastructureError = diagnostics.infrastructure_error === undefined
    ? undefined
    : jsonValue(diagnostics.infrastructure_error, 'verifier evidence diagnostics.infrastructure_error')
  let retryHistory: import('@deepseek-ai/dsh-session').JsonValue[] | undefined
  if (diagnostics.retry_history !== undefined) {
    if (!Array.isArray(diagnostics.retry_history)) {
      throw new HitchEvaluationError('verifier evidence diagnostics.retry_history must be an array', 'invalid_hitch_result')
    }
    retryHistory = diagnostics.retry_history.map((item, index) => jsonValue(
      item,
      `verifier evidence diagnostics.retry_history[${index}]`,
    ))
  }
  const hasArtifacts = ctrf !== undefined || (stdout?.length ?? 0) > 0 || (stderr?.length ?? 0) > 0
  if (!hasArtifacts && infrastructureError === undefined && (retryHistory?.length ?? 0) === 0) {
    throw new HitchEvaluationError('verifier evidence diagnostics must not be empty', 'invalid_hitch_result')
  }
  return {
    value: {
      ...(ctrf === undefined ? {} : { ctrf }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(infrastructureError === undefined ? {} : { infrastructure_error: infrastructureError }),
      ...(retryHistory === undefined ? {} : { retry_history: retryHistory }),
    },
    hasArtifacts,
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new HitchEvaluationError(`${label} must be an array of non-empty strings`, 'invalid_hitch_result')
  }
  return [...value as string[]]
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HitchEvaluationError(`${label} must be boolean`, 'invalid_hitch_result')
  }
  return value
}

function digest(value: unknown, label: string): string {
  const result = string(value, label)
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    throw new HitchEvaluationError(`${label} must be a sha256 digest`, 'invalid_hitch_result')
  }
  return result
}

function counts(value: unknown, label: string): Record<string, number> {
  const source = record(value, label)
  const result: Record<string, number> = {}
  for (const [key, count] of Object.entries(source).sort(([left], [right]) => left.localeCompare(right))) {
    if (key.length === 0 || key.length > 1_024) {
      throw new HitchEvaluationError(`${label} contains an invalid key`, 'invalid_hitch_result')
    }
    result[key] = integer(count, `${label}.${key}`)
  }
  return result
}

function redactions(value: unknown, label: string): Array<{ ruleId: string; count: number }> {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  const result = value.map((item, index) => {
    const entry = record(item, `${label}[${index}]`)
    exactFields(entry, ['rule_id', 'count'], `${label}[${index}]`)
    const ruleId = string(entry.rule_id, `${label}[${index}].rule_id`)
    const count = integer(entry.count, `${label}[${index}].count`)
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ruleId) || count < 1) {
      throw new HitchEvaluationError(`${label}[${index}] is invalid`, 'invalid_hitch_result')
    }
    return { ruleId, count }
  })
  if (new Set(result.map(item => item.ruleId)).size !== result.length
    || result.some((item, index) => index > 0 && result[index - 1]!.ruleId.localeCompare(item.ruleId) >= 0)) {
    throw new HitchEvaluationError(`${label} must be unique and sorted`, 'invalid_hitch_result')
  }
  return result
}

function projectedJsonValue(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => projectedJsonValue(item, `${label}[${index}]`))
  if (typeof value !== 'object') {
    throw new HitchEvaluationError(`${label} must be JSON`, 'invalid_hitch_result')
  }
  const source = value as JsonRecord
  const sourceRef = typeof source.source === 'object' && source.source !== null && !Array.isArray(source.source)
    ? source.source as JsonRecord
    : undefined
  const excerptFields = ['bytes', 'preview', 'sha256', 'source', 'tail', 'truncated']
  if (typeof source.truncated === 'boolean' && sourceRef !== undefined && typeof source.preview === 'string'
    && Object.keys(source).every(key => excerptFields.includes(key))) {
    exactFields(sourceRef, ['run_id', 'seq', 'field'], `${label}.source`)
    const bytes = integer(source.bytes, `${label}.bytes`)
    const sha256 = digest(source.sha256, `${label}.sha256`)
    const runId = string(sourceRef.run_id, `${label}.source.run_id`)
    const seq = integer(sourceRef.seq, `${label}.source.seq`)
    const field = string(sourceRef.field, `${label}.source.field`)
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) {
      throw new HitchEvaluationError(`${label}.source.run_id is invalid`, 'invalid_hitch_result')
    }
    if (source.tail !== undefined && typeof source.tail !== 'string') {
      throw new HitchEvaluationError(`${label}.tail must be a string`, 'invalid_hitch_result')
    }
    return {
      preview: source.preview,
      ...(source.tail === undefined ? {} : { tail: source.tail }),
      bytes,
      sha256,
      truncated: source.truncated,
      source: { runId, seq, field },
    }
  }
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, projectedJsonValue(item, `${label}.${key}`)]))
}

function surfaceOperation(value: unknown, label: string): HitchTrajectorySurfaceNode['surfaceOp'] {
  if (value === 'append') return value
  const operation = record(value, label)
  exactFields(operation, ['op', 'start', 'end'], label)
  if (operation.op !== 'replace') throw new HitchEvaluationError(`${label}.op is invalid`, 'invalid_hitch_result')
  return { op: 'replace', start: integer(operation.start, `${label}.start`), end: integer(operation.end, `${label}.end`) }
}

function surfaceNode(value: unknown, index: number, runId: string, eventCount: number): HitchTrajectorySurfaceNode {
  const label = `trajectory analysis surface.nodes[${index}]`
  const node = record(value, label)
  exactFields(node, ['seq', 'event_type', 'surface_op', 'message'], label)
  const seq = integer(node.seq, `${label}.seq`)
  const eventType = node.event_type
  if (eventType !== 'user/message' && eventType !== 'assistant/message' && eventType !== 'tool/result') {
    throw new HitchEvaluationError(`${label}.event_type is invalid`, 'invalid_hitch_result')
  }
  if (seq >= eventCount) throw new HitchEvaluationError(`${label}.seq is out of range`, 'invalid_hitch_result')
  const message = projectedJsonValue(node.message, `${label}.message`)
  validateProjectedSources(message, runId, `${label}.message`)
  return { seq, eventType, surfaceOp: surfaceOperation(node.surface_op, `${label}.surface_op`), message }
}

function validateProjectedSources(value: unknown, runId: string, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateProjectedSources(item, runId, `${label}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  const item = value as JsonRecord
  const source = typeof item.truncated === 'boolean' && typeof item.preview === 'string'
    && typeof item.source === 'object' && item.source !== null && !Array.isArray(item.source)
    ? item.source as JsonRecord
    : undefined
  if (source !== undefined && source.runId !== runId) {
    throw new HitchEvaluationError(`${label} excerpt belongs to another run`, 'invalid_hitch_result')
  }
  for (const [key, child] of Object.entries(item)) validateProjectedSources(child, runId, `${label}.${key}`)
}

function requestBoundary(value: unknown, index: number, runId: string, eventCount: number, nodeCount: number): HitchTrajectoryRequestBoundary {
  const label = `trajectory analysis surface.request_boundaries[${index}]`
  const boundary = record(value, label)
  exactFields(boundary, ['turn', 'step', 'attempt', 'retry_id', 'boundary_seq', 'surface_revision', 'request_header_seq'], label)
  const boundarySeq = integer(boundary.boundary_seq, `${label}.boundary_seq`)
  const surfaceRevision = integer(boundary.surface_revision, `${label}.surface_revision`)
  if (boundarySeq >= eventCount || surfaceRevision > nodeCount) {
    throw new HitchEvaluationError(`${label} is out of range`, 'invalid_hitch_result')
  }
  const attempt = integer(boundary.attempt, `${label}.attempt`)
  if (attempt < 0) throw new HitchEvaluationError(`${label}.attempt must be non-negative`, 'invalid_hitch_result')
  const retryId = boundary.retry_id === undefined
    ? undefined
    : projectedJsonValue(boundary.retry_id, `${label}.retry_id`)
  if (retryId !== undefined) validateProjectedSources(retryId, runId, `${label}.retry_id`)
  return {
    turn: integer(boundary.turn, `${label}.turn`),
    step: integer(boundary.step, `${label}.step`),
    attempt,
    ...(retryId === undefined ? {} : { retryId }),
    boundarySeq,
    surfaceRevision,
    ...(boundary.request_header_seq === undefined ? {} : {
      requestHeaderSeq: integer(boundary.request_header_seq, `${label}.request_header_seq`),
    }),
  }
}

function hitchContentExcerpt(value: unknown, label: string, runId: string): HitchTrajectoryContentExcerpt {
  const projected = projectedJsonValue(value, label)
  const excerpt = record(projected, label)
  const source = record(excerpt.source, `${label}.source`)
  if (typeof excerpt.truncated !== 'boolean' || typeof excerpt.preview !== 'string' || source.runId !== runId) {
    throw new HitchEvaluationError(`${label} is not a bound content excerpt`, 'invalid_hitch_result')
  }
  return projected as unknown as HitchTrajectoryContentExcerpt
}

function chunkSummary(value: unknown, index: number, runId: string, eventCount: number): HitchTrajectoryChunkSummary {
  const label = `trajectory analysis chunk_summaries[${index}]`
  const summary = record(value, label)
  exactFields(summary, [
    'turn', 'step', 'attempt', 'retry_id', 'first_seq', 'last_seq', 'count', 'types', 'model_boundary_seq',
    'usage', 'finish_reason', 'partial',
  ], label)
  const firstSeq = integer(summary.first_seq, `${label}.first_seq`)
  const lastSeq = integer(summary.last_seq, `${label}.last_seq`)
  const count = integer(summary.count, `${label}.count`)
  const types = counts(summary.types, `${label}.types`)
  const modelBoundarySeq = integer(summary.model_boundary_seq, `${label}.model_boundary_seq`)
  if (count < 1 || firstSeq > lastSeq || lastSeq >= eventCount || modelBoundarySeq !== firstSeq
    || Object.values(types).reduce((sum, item) => sum + item, 0) !== count) {
    throw new HitchEvaluationError(`${label} has inconsistent range or counts`, 'invalid_hitch_result')
  }
  const attempt = integer(summary.attempt, `${label}.attempt`)
  if (attempt < 0) throw new HitchEvaluationError(`${label}.attempt must be non-negative`, 'invalid_hitch_result')
  const retryId = summary.retry_id === undefined
    ? undefined
    : projectedJsonValue(summary.retry_id, `${label}.retry_id`)
  if (retryId !== undefined) validateProjectedSources(retryId, runId, `${label}.retry_id`)
  let partial: HitchTrajectoryChunkSummary['partial']
  if (summary.partial !== undefined) {
    const raw = record(summary.partial, `${label}.partial`)
    exactFields(raw, ['status', 'content', 'source_seq_count'], `${label}.partial`)
    if (raw.status !== 'incomplete') throw new HitchEvaluationError(`${label}.partial.status is invalid`, 'invalid_hitch_result')
    partial = {
      status: 'incomplete',
      content: hitchContentExcerpt(raw.content, `${label}.partial.content`, runId),
      sourceSeqCount: integer(raw.source_seq_count, `${label}.partial.source_seq_count`),
    }
  }
  const usage = summary.usage === undefined ? undefined : projectedJsonValue(summary.usage, `${label}.usage`)
  const finishReason = summary.finish_reason === undefined
    ? undefined
    : projectedJsonValue(summary.finish_reason, `${label}.finish_reason`)
  if (usage !== undefined) validateProjectedSources(usage, runId, `${label}.usage`)
  if (finishReason !== undefined) validateProjectedSources(finishReason, runId, `${label}.finish_reason`)
  return {
    turn: integer(summary.turn, `${label}.turn`),
    step: integer(summary.step, `${label}.step`),
    attempt,
    ...(retryId === undefined ? {} : { retryId }),
    firstSeq,
    lastSeq,
    count,
    types,
    modelBoundarySeq,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(partial === undefined ? {} : { partial }),
  }
}

function trialSlots(value: unknown, label: string): EvaluationTrialSlot[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  return value.map((item, index) => {
    const slot = record(item, `${label}[${index}]`)
    const attempt = integer(slot.attempt, `${label}[${index}].attempt`)
    if (attempt <= 0) throw new HitchEvaluationError(`${label}[${index}].attempt must be positive`, 'invalid_hitch_result')
    return { taskId: string(slot.task_id, `${label}[${index}].task_id`), attempt }
  })
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function rewardForTrial(rewards: Record<string, number>): number | undefined {
  if (rewards.reward !== undefined) return rewards.reward
  return Object.values(rewards)[0]
}

function excerpt(value: unknown, maxBytes = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}…`
}

function structuredCliError(output: string): { code: string; message: string } | undefined {
  for (const line of output.split(/\r?\n/u).reverse()) {
    try {
      const envelope = JSON.parse(line) as unknown
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) continue
      const error = (envelope as JsonRecord).error
      if (typeof error !== 'object' || error === null || Array.isArray(error)) continue
      const detail = error as JsonRecord
      if (typeof detail.code !== 'string' || !/^[a-z0-9_]{1,128}$/u.test(detail.code)
        || typeof detail.message !== 'string') continue
      return { code: detail.code, message: detail.message }
    } catch {
      // Older Hitch versions use plain-text diagnostics.
    }
  }
  return undefined
}

export class HitchCliEvaluator implements RefineEvaluator, HitchTrajectoryReader {
  readonly repositoryPath: string
  private executablePathPromise?: Promise<string>
  private readonly trajectoryCache = new Map<string, { analysis: HitchTrajectoryAnalysis; bytes: number }>()
  private readonly trajectoryDigestByRun = new Map<string, string>()
  private readonly trajectoryLoads = new Map<string, SharedTrajectoryLoad>()
  private trajectoryCacheBytes = 0

  constructor(readonly options: HitchCliEvaluatorOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    if (options.executable.length === 0) throw new TypeError('hitch.executable must not be empty')
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(options.harnessId)) throw new TypeError('hitch.harnessId is invalid')
    if (!Number.isSafeInteger(options.attempts) || options.attempts <= 0) throw new TypeError('hitch.attempts must be a positive integer')
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0) throw new TypeError('hitch.maxConcurrent must be a positive integer')
    if (!Number.isSafeInteger(options.setupTimeoutMs) || options.setupTimeoutMs < 0) throw new TypeError('hitch.setupTimeoutMs must be non-negative')
    if (!Number.isSafeInteger(options.terminationGraceMs) || options.terminationGraceMs < 0) throw new TypeError('hitch.terminationGraceMs must be non-negative')
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) throw new TypeError('hitch.maxOutputBytes must be positive')
    if (!Number.isSafeInteger(options.maxTrajectoryOutputBytes) || options.maxTrajectoryOutputBytes <= 0) {
      throw new TypeError('hitch.maxTrajectoryOutputBytes must be positive')
    }
    if (options.maxTrajectoryAnalysisBytes !== undefined
      && (!Number.isSafeInteger(options.maxTrajectoryAnalysisBytes) || options.maxTrajectoryAnalysisBytes <= 0)) {
      throw new TypeError('hitch.maxTrajectoryAnalysisBytes must be positive')
    }
    if (options.maxTrajectoryEventsBytes !== undefined
      && (!Number.isSafeInteger(options.maxTrajectoryEventsBytes) || options.maxTrajectoryEventsBytes <= 0)) {
      throw new TypeError('hitch.maxTrajectoryEventsBytes must be positive')
    }
    if (options.trajectoryCacheEntries !== undefined
      && (!Number.isSafeInteger(options.trajectoryCacheEntries) || options.trajectoryCacheEntries <= 0)) {
      throw new TypeError('hitch.trajectoryCacheEntries must be positive')
    }
    if (options.trajectoryCacheBytes !== undefined
      && (!Number.isSafeInteger(options.trajectoryCacheBytes) || options.trajectoryCacheBytes <= 0)) {
      throw new TypeError('hitch.trajectoryCacheBytes must be positive')
    }
    if (options.passEnv.some(name => !/^[A-Z_][A-Z0-9_]*$/u.test(name))) throw new TypeError('hitch.passEnv contains an invalid environment variable name')
  }

  async preflight(): Promise<void> {
    await this.checkVersion()
    await this.inspectCapabilities(new AbortController().signal)
  }

  private async checkVersion(signal?: AbortSignal): Promise<string> {
    await this.executablePath()
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(signal?.reason)
    if (signal?.aborted === true) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new HitchEvaluationError(
        `Hitch version check timed out for ${this.options.executable}; Gear requires agent-hitch >= 0.2.5`,
        'hitch_version_check_failed',
      )),
      5_000,
    )
    let result: ProcessResult
    try { result = await this.run(['--version'], this.repositoryPath, controller.signal, 16_384) }
    finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch version check failed: ${output.slice(-4000)}`, 'hitch_version_check_failed')
    }
    const match = output.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\D|$)/u)
    if (match === null) {
      throw new HitchEvaluationError(`unsupported Hitch CLI version output: ${output}`, 'unsupported_hitch_version')
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number]
    const coreAboveMinimum = major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch > 5)))
    const coreAtMinimum = major === 0 && minor === 2 && patch === 5
    const supported = coreAboveMinimum || (coreAtMinimum && match[4] === undefined)
    if (!supported) {
      throw new HitchEvaluationError(
        `unsupported Hitch CLI ${match[0].trim()}; Gear requires agent-hitch >= 0.2.5 for stable eval identity and multi-attempt rerun`,
        'unsupported_hitch_version',
      )
    }
    return sha256(output)
  }

  async reserve(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
  ): Promise<EvaluationReservation> {
    return { provider: 'hitch-cli', evalId: `eval_${randomUUID().replaceAll('-', '')}` }
  }

  async evaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity> {
    return this.resolveEvaluationIdentity(round, request, signal)
  }

  private async resolveEvaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity> {
    signal?.throwIfAborted()
    const hitchRuntimeIdentity = await this.runtimeIdentity(signal)
    signal?.throwIfAborted()
    const effectiveConfigDigest = this.effectiveConfigDigest(round, request, hitchRuntimeIdentity)
    const invocationFingerprint = this.invocationFingerprint(effectiveConfigDigest)
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint,
    }
  }

  async inspectCapabilities(signal: AbortSignal): Promise<HitchCapabilities> {
    signal.throwIfAborted()
    const processResult = await this.run(['capabilities', '--json'], this.repositoryPath, signal, 16_384)
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      throw new HitchEvaluationError(
        `Hitch bounded trajectory capabilities are unavailable: ${excerpt(output, 1_000)}`,
        'hitch_trajectory_capabilities_unavailable',
      )
    }
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid capabilities JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const value = record(parsed, 'Hitch capabilities')
    if (value.schema_version !== '1' || value.trajectory_analysis !== '1' || value.trajectory_events_page !== '1') {
      throw new HitchEvaluationError(
        'Hitch must provide trajectory_analysis=1 and trajectory_events_page=1',
        'hitch_trajectory_capabilities_unavailable',
      )
    }
    if (value.verifier_evidence !== undefined && value.verifier_evidence !== '1') {
      throw new HitchEvaluationError('Hitch verifier_evidence capability is invalid', 'invalid_hitch_result')
    }
    return {
      schemaVersion: 1,
      trajectoryAnalysis: 1,
      trajectoryEventsPage: 1,
      ...(value.verifier_evidence === '1' ? { verifierEvidence: 1 as const } : {}),
    }
  }

  async inspectTrajectoryAnalysis(runId: string, signal: AbortSignal): Promise<HitchTrajectoryAnalysis> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch trajectory requires a valid run ID')
    signal.throwIfAborted()
    const cachedDigest = this.trajectoryDigestByRun.get(runId)
    const cached = cachedDigest === undefined ? undefined : this.trajectoryCache.get(`${runId}:${cachedDigest}`)
    if (cached !== undefined) {
      this.trajectoryCache.delete(`${runId}:${cachedDigest}`)
      this.trajectoryCache.set(`${runId}:${cachedDigest}`, cached)
      return cached.analysis
    }
    const pending = this.trajectoryLoads.get(runId)
    if (pending !== undefined) return this.waitForTrajectoryLoad(runId, pending, signal)
    const controller = new AbortController()
    const shared: SharedTrajectoryLoad = {
      promise: this.fetchTrajectoryAnalysis(runId, controller.signal),
      controller,
      waiters: 0,
      settled: false,
    }
    this.trajectoryLoads.set(runId, shared)
    void shared.promise.then(
      analysis => {
        shared.settled = true
        this.cacheTrajectory(analysis)
        if (this.trajectoryLoads.get(runId) === shared) this.trajectoryLoads.delete(runId)
      },
      () => {
        shared.settled = true
        if (this.trajectoryLoads.get(runId) === shared) this.trajectoryLoads.delete(runId)
      },
    )
    return this.waitForTrajectoryLoad(runId, shared, signal)
  }

  async inspectTrajectoryEvents(
    runId: string,
    query: Readonly<HitchTrajectoryEventsQuery>,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryEventsPage> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch trajectory requires a valid run ID')
    const limit = query.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('trajectory events limit must be between 1 and 1000')
    }
    if (query.seqStart !== undefined && (!Number.isSafeInteger(query.seqStart) || query.seqStart < 0)) {
      throw new TypeError('trajectory events seqStart must be a non-negative integer')
    }
    if (query.seqEnd !== undefined && (!Number.isSafeInteger(query.seqEnd) || query.seqEnd < 0)) {
      throw new TypeError('trajectory events seqEnd must be a non-negative integer')
    }
    if (query.seqStart !== undefined && query.seqEnd !== undefined && query.seqStart > query.seqEnd) {
      throw new TypeError('trajectory events seqStart must not exceed seqEnd')
    }
    if (query.field !== undefined && (query.seqStart === undefined || query.seqStart !== query.seqEnd
      || query.canonicalSha256 === undefined)) {
      throw new TypeError('trajectory events field requires one exact sequence and canonicalSha256')
    }
    if (query.canonicalSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(query.canonicalSha256)) {
      throw new TypeError('trajectory events canonicalSha256 is invalid')
    }
    if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 16_384)) {
      throw new TypeError('trajectory events cursor is invalid')
    }
    const configuredMaxBytes = this.options.maxTrajectoryEventsBytes
      ?? Math.min(this.options.maxTrajectoryOutputBytes, 4 * 1024 * 1024)
    if (query.maxBytes !== undefined && (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1)) {
      throw new TypeError('trajectory events maxBytes must be a positive integer')
    }
    const maxBytes = Math.min(configuredMaxBytes, query.maxBytes ?? configuredMaxBytes)
    const eventTypes = query.eventTypes === undefined
      ? undefined
      : [...new Set(query.eventTypes.filter(value => value.length > 0))].sort()
    if (eventTypes?.length === 0 || eventTypes?.some(value => value.length > 1_024)) {
      throw new TypeError('trajectory events eventTypes must contain event type names of at most 1024 characters')
    }
    const normalizedQuery: HitchTrajectoryEventsQuery = {
      ...query,
      ...(eventTypes === undefined ? {} : { eventTypes }),
      maxBytes,
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'trajectory', 'events', runId,
      ...(eventTypes === undefined ? [] : ['--types', eventTypes.join(',')]),
      ...(query.seqStart === undefined ? [] : ['--seq-start', String(query.seqStart)]),
      ...(query.seqEnd === undefined ? [] : ['--seq-end', String(query.seqEnd)]),
      ...(query.field === undefined ? [] : ['--field', query.field]),
      ...(query.canonicalSha256 === undefined ? [] : ['--canonical-sha256', query.canonicalSha256]),
      ...(query.cursor === undefined ? [] : ['--cursor', query.cursor]),
      '--limit', String(limit), '--max-bytes', String(maxBytes), '--json',
    ]
    const processResult = await this.run(args, this.repositoryPath, signal, maxBytes)
    if (processResult.exitCode !== 0) throw this.trajectoryCommandError('events', runId, processResult)
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid trajectory events JSON (${String(error)})`, 'invalid_hitch_json')
    }
    return this.parseTrajectoryEventsPage(parsed, runId, normalizedQuery, limit)
  }

  async inspectVerifierEvidence(runId: string, signal: AbortSignal): Promise<HitchVerifierEvidence> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch verifier evidence requires a valid run ID')
    signal.throwIfAborted()
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'verifier', 'inspect', runId, '--json',
    ]
    const processResult = await this.run(
      args,
      this.repositoryPath,
      signal,
      this.options.maxTrajectoryOutputBytes,
    )
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      const structured = structuredCliError(output)
      if (structured?.code === 'verifier_evidence_corrupt') {
        return {
          runId,
          verifier: {
            status: 'corrupt',
            issues: [`Hitch could not validate verifier evidence: ${excerpt(structured.message, 512)}`],
          },
        }
      }
      if (output !== 'hitch: unknown command: verifier') {
        throw new HitchEvaluationError(
          `Hitch verifier inspect failed with exit ${processResult.exitCode}: ${excerpt(output, 1_000)}`,
          'hitch_verifier_inspect_failed',
        )
      }
      return {
        runId,
        verifier: {
          status: 'unavailable',
          issues: [`Hitch verifier evidence API is unsupported: ${output}`],
        },
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid verifier evidence JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const result = record(parsed, 'Hitch verifier evidence')
    if (result.schema_version !== '1' || result.kind !== 'verifier-evidence' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch verifier evidence identity does not match the requested run', 'invalid_hitch_result')
    }
    const parentRecord = result.parent === undefined ? undefined : record(result.parent, 'verifier evidence parent')
    const parentAttempt = parentRecord === undefined ? undefined : integer(parentRecord.attempt, 'verifier evidence parent.attempt')
    if (parentAttempt !== undefined && parentAttempt <= 0) {
      throw new HitchEvaluationError('verifier evidence parent.attempt must be positive', 'invalid_hitch_result')
    }
    const parentEvalId = parentRecord === undefined
      ? undefined
      : string(parentRecord.eval_id, 'verifier evidence parent.eval_id')
    if (parentEvalId !== undefined && !/^eval_[0-9a-f]{32}$/u.test(parentEvalId)) {
      throw new HitchEvaluationError('verifier evidence parent.eval_id is invalid', 'invalid_hitch_result')
    }
    const parentTrialId = parentRecord === undefined
      ? undefined
      : string(parentRecord.trial_id, 'verifier evidence parent.trial_id')
    const observationRecord = result.observation === undefined
      ? undefined
      : record(result.observation, 'verifier evidence observation')
    const observationStatus = observationRecord?.status
    if (observationRecord !== undefined && observationStatus !== 'valid' && observationStatus !== 'invalid') {
      throw new HitchEvaluationError('verifier evidence observation.status is invalid', 'invalid_hitch_result')
    }
    const observationReward = observationRecord === undefined
      ? undefined
      : optionalFinite(observationRecord.reward, 'verifier evidence observation.reward')
    const observationInvalidReason = observationRecord === undefined
      ? undefined
      : optionalString(observationRecord.invalid_reason, 'verifier evidence observation.invalid_reason')
    const observationResultRef = observationRecord === undefined
      ? undefined
      : optionalString(observationRecord.verifier_result_ref, 'verifier evidence observation.verifier_result_ref')
    const verifierRecord = record(result.verifier, 'verifier evidence verifier')
    const verifierStatus = verifierRecord.status
    if (verifierStatus !== 'complete' && verifierStatus !== 'result_only'
      && verifierStatus !== 'missing' && verifierStatus !== 'corrupt') {
      throw new HitchEvaluationError('verifier evidence status is invalid', 'invalid_hitch_result')
    }
    const resultSha256 = optionalString(verifierRecord.result_sha256, 'verifier evidence result_sha256')
    if (resultSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(resultSha256)) {
      throw new HitchEvaluationError('verifier evidence result digest is invalid', 'invalid_hitch_result')
    }
    if ((verifierStatus === 'complete' || verifierStatus === 'result_only')
      && (verifierRecord.result === undefined || resultSha256 === undefined)) {
      throw new HitchEvaluationError(`${verifierStatus} verifier evidence requires a result and digest`, 'invalid_hitch_result')
    }
    const parsedDiagnostics = verifierRecord.diagnostics === undefined
      ? undefined
      : verifierDiagnostics(verifierRecord.diagnostics)
    const hasArtifactDiagnostics = parsedDiagnostics?.hasArtifacts === true
    if (verifierStatus === 'complete' && !hasArtifactDiagnostics) {
      throw new HitchEvaluationError('complete verifier evidence requires artifact diagnostics', 'invalid_hitch_result')
    }
    if (verifierStatus === 'result_only' && hasArtifactDiagnostics) {
      throw new HitchEvaluationError('result_only verifier evidence must not include artifact diagnostics', 'invalid_hitch_result')
    }
    if (verifierStatus === 'missing' && (verifierRecord.result !== undefined || resultSha256 !== undefined)) {
      throw new HitchEvaluationError('missing verifier evidence must not include a result or digest', 'invalid_hitch_result')
    }
    const issues = verifierRecord.issues === undefined
      ? undefined
      : stringArray(verifierRecord.issues, 'verifier evidence issues')
    const redactions = result.redactions === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(result.redactions)) {
            throw new HitchEvaluationError('verifier evidence redactions must be an array', 'invalid_hitch_result')
          }
          const values = result.redactions.map((item, index) => {
            const redaction = record(item, `verifier evidence redactions[${index}]`)
            exactFields(redaction, ['rule_id', 'count'], `verifier evidence redactions[${index}]`)
            const ruleId = string(redaction.rule_id, `verifier evidence redactions[${index}].rule_id`)
            const count = integer(redaction.count, `verifier evidence redactions[${index}].count`)
            if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ruleId) || count < 1) {
              throw new HitchEvaluationError(`verifier evidence redactions[${index}] is invalid`, 'invalid_hitch_result')
            }
            return { ruleId, count }
          })
          const canonical = [...values].sort((left, right) => left.ruleId.localeCompare(right.ruleId))
          if (new Set(values.map(item => item.ruleId)).size !== values.length
            || JSON.stringify(canonical) !== JSON.stringify(values)) {
            throw new HitchEvaluationError('verifier evidence redactions must be unique and canonical', 'invalid_hitch_result')
          }
          return values
        })()
    return {
      runId,
      ...(parentRecord === undefined ? {} : {
        parent: {
          evalId: parentEvalId!,
          trialId: parentTrialId!,
          attempt: parentAttempt!,
        },
      }),
      ...(observationRecord === undefined ? {} : {
        observation: {
          status: observationStatus as 'valid' | 'invalid',
          ...(observationReward === undefined ? {} : { reward: observationReward }),
          ...(observationInvalidReason === undefined ? {} : { invalidReason: observationInvalidReason }),
          ...(observationResultRef === undefined ? {} : { verifierResultRef: observationResultRef }),
        },
      }),
      verifier: {
        status: verifierStatus,
        ...(verifierRecord.result === undefined ? {} : { result: jsonValue(verifierRecord.result, 'verifier evidence result') }),
        ...(resultSha256 === undefined ? {} : { resultSha256 }),
        ...(parsedDiagnostics === undefined ? {} : {
          diagnostics: parsedDiagnostics.value,
        }),
        ...(issues === undefined ? {} : { issues }),
      },
      ...(redactions === undefined ? {} : { redactions }),
    }
  }

  private waitForTrajectoryLoad(
    runId: string,
    shared: SharedTrajectoryLoad,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryAnalysis> {
    signal.throwIfAborted()
    shared.waiters += 1
    return new Promise<HitchTrajectoryAnalysis>((resolvePromise, reject) => {
      let completed = false
      const release = (): void => {
        if (completed) return
        completed = true
        signal.removeEventListener('abort', abort)
        shared.waiters -= 1
        if (shared.waiters === 0 && !shared.settled && this.trajectoryLoads.get(runId) === shared) {
          shared.controller.abort(new Error(`trajectory load abandoned for ${runId}`))
        }
      }
      const abort = (): void => {
        release()
        reject(signal.reason ?? new Error('trajectory load aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void shared.promise.then(
        analysis => { release(); resolvePromise(analysis) },
        error => { release(); reject(error) },
      )
    })
  }

  private async fetchTrajectoryAnalysis(runId: string, signal: AbortSignal): Promise<HitchTrajectoryAnalysis> {
    const maxBytes = this.options.maxTrajectoryAnalysisBytes
      ?? Math.min(this.options.maxTrajectoryOutputBytes, 16 * 1024 * 1024)
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'trajectory', 'project', runId, '--profile', 'analysis', '--max-bytes', String(maxBytes), '--json',
    ]
    const processResult = await this.run(args, this.repositoryPath, signal, maxBytes)
    if (processResult.exitCode !== 0) throw this.trajectoryCommandError('project', runId, processResult)
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid trajectory analysis JSON (${String(error)})`, 'invalid_hitch_json')
    }
    return this.parseTrajectoryAnalysis(parsed, runId)
  }

  private parseTrajectoryAnalysis(value: unknown, runId: string): HitchTrajectoryAnalysis {
    const result = record(value, 'Hitch trajectory analysis')
    exactFields(result, [
      'schema_version', 'kind', 'run_id', 'source', 'header', 'surface', 'events', 'chunk_summaries',
      'omitted_event_types', 'coverage', 'redactions',
    ], 'Hitch trajectory analysis')
    if (result.schema_version !== '1' || result.kind !== 'trajectory-analysis' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch trajectory analysis identity does not match the requested run', 'invalid_hitch_result')
    }
    const source = record(result.source, 'trajectory analysis source')
    exactFields(source, [
      'fidelity', 'provider', 'session_id', 'canonical_sha256', 'canonical_bytes', 'event_count', 'event_types',
    ], 'trajectory analysis source')
    if (source.fidelity !== 'provider_native' && source.fidelity !== 'normalized' && source.fidelity !== 'minimal') {
      throw new HitchEvaluationError('trajectory analysis source fidelity is invalid', 'invalid_hitch_result')
    }
    const canonicalSha256 = digest(source.canonical_sha256, 'trajectory analysis source.canonical_sha256')
    const eventCount = integer(source.event_count, 'trajectory analysis source.event_count')
    const eventTypes = counts(source.event_types, 'trajectory analysis source.event_types')
    if (Object.values(eventTypes).reduce((sum, count) => sum + count, 0) !== eventCount) {
      throw new HitchEvaluationError('trajectory analysis source event counts are inconsistent', 'invalid_hitch_result')
    }
    const surface = record(result.surface, 'trajectory analysis surface')
    exactFields(surface, [
      'fidelity', 'nodes', 'current_node_seqs', 'replacements', 'request_boundaries', 'request_headers',
    ], 'trajectory analysis surface')
    if (surface.fidelity !== 'exact' && surface.fidelity !== 'normalized' && surface.fidelity !== 'partial') {
      throw new HitchEvaluationError('trajectory analysis surface fidelity is invalid', 'invalid_hitch_result')
    }
    if (!Array.isArray(surface.nodes) || !Array.isArray(surface.current_node_seqs)
      || !Array.isArray(surface.replacements) || !Array.isArray(surface.request_boundaries)
      || !Array.isArray(surface.request_headers)) {
      throw new HitchEvaluationError('trajectory analysis surface arrays are invalid', 'invalid_hitch_result')
    }
    const nodes = surface.nodes.map((item, index) => surfaceNode(item, index, runId, eventCount))
    if (nodes.some((node, index) => index > 0 && nodes[index - 1]!.seq >= node.seq)) {
      throw new HitchEvaluationError('trajectory analysis surface nodes must be increasing', 'invalid_hitch_result')
    }
    const nodeSeqs = new Set(nodes.map(node => node.seq))
    const currentNodeSeqs = surface.current_node_seqs.map((seq, index) => integer(seq, `surface.current_node_seqs[${index}]`))
    if (currentNodeSeqs.some(seq => !nodeSeqs.has(seq)) || new Set(currentNodeSeqs).size !== currentNodeSeqs.length) {
      throw new HitchEvaluationError('trajectory analysis current surface nodes are invalid', 'invalid_hitch_result')
    }
    const replacements = surface.replacements.map((item, index) => {
      const label = `trajectory analysis surface.replacements[${index}]`
      const replacement = record(item, label)
      exactFields(replacement, ['seq', 'start', 'end', 'shadowed_seqs'], label)
      if (!Array.isArray(replacement.shadowed_seqs)) {
        throw new HitchEvaluationError(`${label}.shadowed_seqs must be an array`, 'invalid_hitch_result')
      }
      return {
        seq: integer(replacement.seq, `${label}.seq`),
        start: integer(replacement.start, `${label}.start`),
        end: integer(replacement.end, `${label}.end`),
        shadowedSeqs: replacement.shadowed_seqs.map((seq, seqIndex) => integer(seq, `${label}.shadowed_seqs[${seqIndex}]`)),
      }
    })
    const requestBoundaries = surface.request_boundaries.map((item, index) => requestBoundary(item, index, runId, eventCount, nodes.length))
    if (requestBoundaries.some((item, index) => index > 0 && requestBoundaries[index - 1]!.boundarySeq >= item.boundarySeq)) {
      throw new HitchEvaluationError('trajectory analysis request boundaries must be increasing', 'invalid_hitch_result')
    }
    if (new Set(requestBoundaries.map(item => `${item.turn}:${item.step}:${item.attempt}`)).size !== requestBoundaries.length) {
      throw new HitchEvaluationError('trajectory analysis request attempts must be unique', 'invalid_hitch_result')
    }
    for (const boundary of requestBoundaries) {
      const priorNode = boundary.surfaceRevision === 0 ? undefined : nodes[boundary.surfaceRevision - 1]
      const nextNode = nodes[boundary.surfaceRevision]
      if ((priorNode !== undefined && priorNode.seq >= boundary.boundarySeq)
        || (nextNode !== undefined && nextNode.seq < boundary.boundarySeq)) {
        throw new HitchEvaluationError('trajectory analysis request boundary has an inconsistent surface revision', 'invalid_hitch_result')
      }
    }
    const requestHeaders = surface.request_headers.map((item, index) => {
      const label = `trajectory analysis surface.request_headers[${index}]`
      const header = record(item, label)
      exactFields(header, ['seq', 'header'], label)
      const seq = integer(header.seq, `${label}.seq`)
      if (seq >= eventCount) throw new HitchEvaluationError(`${label}.seq is out of range`, 'invalid_hitch_result')
      const projected = projectedJsonValue(header.header, `${label}.header`)
      validateProjectedSources(projected, runId, `${label}.header`)
      return { seq, header: projected }
    })
    if (requestHeaders.some((item, index) => index > 0 && requestHeaders[index - 1]!.seq >= item.seq)) {
      throw new HitchEvaluationError('trajectory analysis request headers must be increasing', 'invalid_hitch_result')
    }
    const headerSeqs = new Set(requestHeaders.map(item => item.seq))
    if (requestBoundaries.some(boundary => boundary.requestHeaderSeq !== undefined && !headerSeqs.has(boundary.requestHeaderSeq))) {
      throw new HitchEvaluationError('trajectory analysis request boundary references an unknown header', 'invalid_hitch_result')
    }
    if (requestBoundaries.some(boundary => boundary.requestHeaderSeq !== undefined
      && boundary.requestHeaderSeq >= boundary.boundarySeq)) {
      throw new HitchEvaluationError('trajectory analysis request boundary references a future header', 'invalid_hitch_result')
    }
    if (!Array.isArray(result.events) || !Array.isArray(result.chunk_summaries)) {
      throw new HitchEvaluationError('trajectory analysis events and chunk summaries must be arrays', 'invalid_hitch_result')
    }
    const events = result.events.map((event, index) => {
      const projected = projectedJsonValue(event, `trajectory analysis events[${index}]`)
      validateProjectedSources(projected, runId, `trajectory analysis events[${index}]`)
      const item = record(projected, `trajectory analysis events[${index}]`)
      if (item.type === 'assistant/chunk') {
        throw new HitchEvaluationError('trajectory analysis must not include raw assistant chunks', 'invalid_hitch_result')
      }
      if (typeof item.type !== 'string' || item.type.length === 0 || eventTypes[item.type] === undefined) {
        throw new HitchEvaluationError(`trajectory analysis events[${index}].type is invalid`, 'invalid_hitch_result')
      }
      const seq = integer(item.seq, `trajectory analysis events[${index}].seq`)
      if (seq >= eventCount) throw new HitchEvaluationError(`trajectory analysis events[${index}].seq is out of range`, 'invalid_hitch_result')
      return projected
    })
    if (events.some((event, index) => index > 0
      && (record(events[index - 1], 'trajectory analysis event').seq as number) >= (record(event, 'trajectory analysis event').seq as number))) {
      throw new HitchEvaluationError('trajectory analysis diagnostic events must be increasing', 'invalid_hitch_result')
    }
    const chunkSummaries = result.chunk_summaries.map((item, index) => chunkSummary(item, index, runId, eventCount))
    if (chunkSummaries.some((item, index) => index > 0 && chunkSummaries[index - 1]!.firstSeq >= item.firstSeq)) {
      throw new HitchEvaluationError('trajectory analysis chunk summaries must be increasing', 'invalid_hitch_result')
    }
    const boundariesByAttempt = new Map(requestBoundaries.map(item => [`${item.turn}:${item.step}:${item.attempt}`, item]))
    for (const summary of chunkSummaries) {
      const boundary = boundariesByAttempt.get(`${summary.turn}:${summary.step}:${summary.attempt}`)
      if (boundary === undefined || boundary.boundarySeq !== summary.modelBoundarySeq
        || JSON.stringify(boundary.retryId) !== JSON.stringify(summary.retryId)) {
        throw new HitchEvaluationError('trajectory analysis chunk summary does not match its request boundary', 'invalid_hitch_result')
      }
    }
    const omittedEventTypes = counts(result.omitted_event_types, 'trajectory analysis omitted_event_types')
    for (const [type, count] of Object.entries(omittedEventTypes)) {
      if (count > (eventTypes[type] ?? 0)) {
        throw new HitchEvaluationError(`trajectory analysis omitted count exceeds source count for ${type}`, 'invalid_hitch_result')
      }
    }
    if ((eventTypes['assistant/chunk'] ?? 0) !== (omittedEventTypes['assistant/chunk'] ?? 0)) {
      throw new HitchEvaluationError('trajectory analysis must account for every assistant chunk as omitted', 'invalid_hitch_result')
    }
    const coverage = record(result.coverage, 'trajectory analysis coverage')
    exactFields(coverage, ['surface', 'chunks', 'content', 'child_sessions'], 'trajectory analysis coverage')
    if (coverage.surface !== 'complete' && coverage.surface !== 'partial') {
      throw new HitchEvaluationError('trajectory analysis surface coverage is invalid', 'invalid_hitch_result')
    }
    if (coverage.chunks !== 'coalesced' && coverage.chunks !== 'omitted' && coverage.chunks !== 'partial') {
      throw new HitchEvaluationError('trajectory analysis chunk coverage is invalid', 'invalid_hitch_result')
    }
    if (coverage.content !== 'complete' && coverage.content !== 'excerpted' && coverage.content !== 'partial') {
      throw new HitchEvaluationError('trajectory analysis content coverage is invalid', 'invalid_hitch_result')
    }
    if (coverage.child_sessions !== 'complete' && coverage.child_sessions !== 'partial'
      && coverage.child_sessions !== 'none' && coverage.child_sessions !== 'unavailable') {
      throw new HitchEvaluationError('trajectory analysis child session coverage is invalid', 'invalid_hitch_result')
    }
    const latestHeader = projectedJsonValue(result.header, 'trajectory analysis header')
    validateProjectedSources(latestHeader, runId, 'trajectory analysis header')
    return {
      schemaVersion: 1,
      kind: 'trajectory-analysis',
      runId,
      source: {
        fidelity: source.fidelity,
        ...(source.provider === undefined ? {} : { provider: string(source.provider, 'trajectory analysis source.provider') }),
        sessionId: string(source.session_id, 'trajectory analysis source.session_id'),
        canonicalSha256,
        canonicalBytes: integer(source.canonical_bytes, 'trajectory analysis source.canonical_bytes'),
        eventCount,
        eventTypes,
      },
      header: latestHeader,
      surface: {
        fidelity: surface.fidelity,
        nodes,
        currentNodeSeqs,
        replacements,
        requestBoundaries,
        requestHeaders,
      },
      events,
      chunkSummaries,
      omittedEventTypes,
      coverage: {
        surface: coverage.surface,
        chunks: coverage.chunks,
        content: coverage.content,
        childSessions: coverage.child_sessions,
      },
      ...(result.redactions === undefined ? {} : { redactions: redactions(result.redactions, 'trajectory analysis redactions') }),
    }
  }

  private parseTrajectoryEventsPage(
    value: unknown,
    runId: string,
    query: Readonly<HitchTrajectoryEventsQuery>,
    limit: number,
  ): HitchTrajectoryEventsPage {
    const result = record(value, 'Hitch trajectory events page')
    exactFields(result, [
      'schema_version', 'kind', 'run_id', 'canonical_sha256', 'filter', 'events', 'total_matches',
      'next_cursor', 'eof', 'redactions',
    ], 'Hitch trajectory events page')
    if (result.schema_version !== '1' || result.kind !== 'trajectory-events-page' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch trajectory events identity does not match the requested run', 'invalid_hitch_result')
    }
    const canonicalSha256 = digest(result.canonical_sha256, 'trajectory events canonical_sha256')
    if (query.canonicalSha256 !== undefined && query.canonicalSha256 !== canonicalSha256) {
      throw new HitchEvaluationError('Hitch trajectory events canonical digest mismatch', 'invalid_hitch_result')
    }
    const filter = record(result.filter, 'trajectory events filter')
    exactFields(filter, ['types', 'seq_start', 'seq_end', 'field'], 'trajectory events filter')
    const eventTypes = filter.types === undefined ? undefined : stringArray(filter.types, 'trajectory events filter.types')
    const seqStart = filter.seq_start === undefined ? undefined : integer(filter.seq_start, 'trajectory events filter.seq_start')
    const seqEnd = filter.seq_end === undefined ? undefined : integer(filter.seq_end, 'trajectory events filter.seq_end')
    const field = filter.field === undefined ? undefined : string(filter.field, 'trajectory events filter.field')
    if ((query.eventTypes !== undefined && JSON.stringify(query.eventTypes) !== JSON.stringify(eventTypes))
      || (query.seqStart !== undefined && query.seqStart !== seqStart)
      || (query.seqEnd !== undefined && query.seqEnd !== seqEnd)
      || (query.field !== undefined && query.field !== field)) {
      throw new HitchEvaluationError('trajectory events response filter does not match the request', 'invalid_hitch_result')
    }
    if (!Array.isArray(result.events)) throw new HitchEvaluationError('trajectory events events must be an array', 'invalid_hitch_result')
    if (result.events.length > limit) throw new HitchEvaluationError('trajectory events page exceeds requested limit', 'invalid_hitch_result')
    const events = result.events.map((event, index) => {
      const projected = projectedJsonValue(event, `trajectory events events[${index}]`)
      validateProjectedSources(projected, runId, `trajectory events events[${index}]`)
      const item = record(projected, `trajectory events events[${index}]`)
      const type = string(item.type, `trajectory events events[${index}].type`)
      const seq = integer(item.seq, `trajectory events events[${index}].seq`)
      if ((seqStart !== undefined && seq < seqStart) || (seqEnd !== undefined && seq > seqEnd)) {
        throw new HitchEvaluationError('trajectory events response contains an event outside its sequence filter', 'invalid_hitch_result')
      }
      if (field === undefined && eventTypes !== undefined && !eventTypes.includes(type)) {
        throw new HitchEvaluationError('trajectory events response contains an event outside its type filter', 'invalid_hitch_result')
      }
      return projected
    })
    if (events.some((event, index) => index > 0
      && (record(events[index - 1], 'trajectory event').seq as number) >= (record(event, 'trajectory event').seq as number))) {
      throw new HitchEvaluationError('trajectory events response must be increasing', 'invalid_hitch_result')
    }
    const totalMatches = integer(result.total_matches, 'trajectory events total_matches')
    if (totalMatches < events.length) throw new HitchEvaluationError('trajectory events total_matches is inconsistent', 'invalid_hitch_result')
    const eof = booleanValue(result.eof, 'trajectory events eof')
    const nextCursor = result.next_cursor === undefined ? undefined : string(result.next_cursor, 'trajectory events next_cursor')
    if ((eof && nextCursor !== undefined) || (!eof && nextCursor === undefined)) {
      throw new HitchEvaluationError('trajectory events cursor/eof state is inconsistent', 'invalid_hitch_result')
    }
    return {
      schemaVersion: 1,
      kind: 'trajectory-events-page',
      runId,
      canonicalSha256,
      filter: {
        ...(eventTypes === undefined ? {} : { eventTypes }),
        ...(seqStart === undefined ? {} : { seqStart }),
        ...(seqEnd === undefined ? {} : { seqEnd }),
        ...(field === undefined ? {} : { field }),
      },
      events,
      totalMatches,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      eof,
      ...(result.redactions === undefined ? {} : { redactions: redactions(result.redactions, 'trajectory events redactions') }),
    }
  }

  private trajectoryCommandError(action: 'project' | 'events', runId: string, result: ProcessResult): HitchEvaluationError {
    const output = `${result.stderr}\n${result.stdout}`.trim()
    const structured = structuredCliError(output)
    const stableCode = structured?.code
      ?? output.match(/(?:^|\s)(trajectory_[a-z0-9_]+):/u)?.[1]
      ?? `hitch_trajectory_${action}_failed`
    return new HitchEvaluationError(
      `Hitch trajectory ${action} failed for ${runId}: ${excerpt(structured?.message ?? output, 2_000)}`,
      stableCode,
    )
  }

  private cacheTrajectory(analysis: HitchTrajectoryAnalysis): void {
    const maxEntries = this.options.trajectoryCacheEntries ?? 8
    const maxBytes = this.options.trajectoryCacheBytes ?? 256 * 1024 * 1024
    const bytes = Buffer.byteLength(JSON.stringify(analysis))
    if (bytes > maxBytes) return
    const previousDigest = this.trajectoryDigestByRun.get(analysis.runId)
    if (previousDigest !== undefined) {
      const previousKey = `${analysis.runId}:${previousDigest}`
      const previous = this.trajectoryCache.get(previousKey)
      if (previous !== undefined) this.trajectoryCacheBytes -= previous.bytes
      this.trajectoryCache.delete(previousKey)
    }
    const key = `${analysis.runId}:${analysis.source.canonicalSha256}`
    this.trajectoryCache.set(key, { analysis, bytes })
    this.trajectoryDigestByRun.set(analysis.runId, analysis.source.canonicalSha256)
    this.trajectoryCacheBytes += bytes
    while (this.trajectoryCache.size > maxEntries || this.trajectoryCacheBytes > maxBytes) {
      const oldest = this.trajectoryCache.entries().next().value as [string, { analysis: HitchTrajectoryAnalysis; bytes: number }] | undefined
      if (oldest === undefined) break
      this.trajectoryCache.delete(oldest[0])
      this.trajectoryCacheBytes -= oldest[1].bytes
      if (this.trajectoryDigestByRun.get(oldest[1].analysis.runId) === oldest[1].analysis.source.canonicalSha256) {
        this.trajectoryDigestByRun.delete(oldest[1].analysis.runId)
      }
    }
  }

  async evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    if (request.condition.dataset.ref !== request.dataset || request.condition.timeoutMs !== round.taskBudgetMs) {
      throw new TypeError('Hitch evaluation request does not match its resolved condition')
    }
    if (request.condition.seeds !== undefined) throw new TypeError('Hitch CLI adapter does not support typed rollout seeds')
    if (request.condition.sampling.temperature !== undefined) {
      throw new TypeError('Hitch CLI adapter does not support typed rollout temperature')
    }
    if (reservation !== undefined
      && (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))) {
      throw new TypeError('Hitch evaluation reservation is invalid')
    }
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    const harness = `${this.options.harnessId}@${source}`
    const identity = await this.resolveEvaluationIdentity(round, request, signal)
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'run',
      '--backend', 'harbor',
      ...(reservation === undefined ? [] : ['--eval-id', reservation.evalId]),
      '--dataset', request.dataset,
      '--harness', harness,
      ...(request.condition.model.length === 0 ? [] : ['--model', request.condition.model]),
      '--attempts', String(request.condition.repetitions),
      '--max-concurrent', String(this.options.maxConcurrent),
      '--timeout', `${round.taskBudgetMs}ms`,
      '--setup-timeout', `${this.options.setupTimeoutMs}ms`,
      ...this.options.agentArgs.flatMap(value => ['--agent-arg', value]),
      ...this.options.passEnv.flatMap(value => ['--pass-env', value]),
      '--output', 'json',
    ]
    const processResult = await this.run(args, round.workspaceRoot, signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid JSON (${String(error)}); stderr: ${processResult.stderr.slice(-4000)}`,
        'invalid_hitch_json',
      )
    }
    const evidence = this.parseResult(parsed, processResult, request, identity, true)
    if (reservation !== undefined
      && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
      throw new HitchEvaluationError('Hitch result does not match the reserved evaluation identity', 'hitch_eval_identity_mismatch')
    }
    const inspection = await this.inspectEvaluation(
      evidence.evalId,
      round.workspaceRoot,
      signal,
      'hitch_eval_inspect_failed',
    )
    this.assertCompleteTrialSlots(inspection, evidence, request)
    return evidence
  }

  async rerun(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
  ): Promise<EvaluationRerunResult> {
    if (attempt.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId)) {
      throw new TypeError('Hitch evaluation rerun requires an owned Hitch eval id')
    }
    if (attempt.phase !== request.phase || attempt.dataset !== request.dataset
      || attempt.conditionId !== request.condition.conditionId || attempt.requestedCommit !== request.harnessRef
      || attempt.requestedModelId !== request.condition.model) {
      throw new TypeError('Hitch evaluation rerun request does not match the original attempt')
    }
    const identity = await this.resolveEvaluationIdentity(round, request, signal)
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'rerun', attempt.evalId,
      ...(selector.mode === 'invalid'
        ? ['--invalid']
        : selector.taskNames.flatMap(task => ['--task', task])),
      '--output', 'json',
    ]
    const processResult = await this.run(args, round.workspaceRoot, signal)
    if (processResult.exitCode !== 0) {
      throw new HitchEvaluationError(
        `Hitch eval rerun failed for ${attempt.evalId}: ${processResult.stderr.slice(-4000)}`,
        'hitch_eval_rerun_failed',
      )
    }
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid rerun JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const envelope = record(parsed, 'Hitch rerun result')
    if (envelope.schema_version !== '1' || envelope.kind !== 'eval-rerun' || envelope.eval_id !== attempt.evalId
      || envelope.status !== 'completed' || (envelope.eval_status !== 'succeeded' && envelope.eval_status !== 'failed')) {
      throw new HitchEvaluationError('Hitch rerun result identity/status is invalid', 'invalid_hitch_result')
    }
    const selectedTasks = stringArray(envelope.selected_tasks, 'selected_tasks')
    const repairedTasks = stringArray(envelope.repaired_tasks, 'repaired_tasks')
    const remainingInvalidTasks = stringArray(envelope.remaining_invalid_tasks, 'remaining_invalid_tasks')
    const selectedTrials = envelope.selected_trials === undefined ? undefined : trialSlots(envelope.selected_trials, 'selected_trials')
    const repairedTrials = envelope.repaired_trials === undefined ? undefined : trialSlots(envelope.repaired_trials, 'repaired_trials')
    const remainingInvalidTrials = envelope.remaining_invalid_trials === undefined
      ? undefined : trialSlots(envelope.remaining_invalid_trials, 'remaining_invalid_trials')
    if (envelope.eval_status === 'succeeded'
      && (remainingInvalidTasks.length > 0 || (remainingInvalidTrials?.length ?? 0) > 0)) {
      throw new HitchEvaluationError('Hitch rerun succeeded with remaining invalid slots', 'invalid_hitch_result')
    }
    const inspection = await this.inspectEvaluation(
      attempt.evalId,
      round.workspaceRoot,
      signal,
      'hitch_eval_rerun_inspect_failed',
    )
    const result = record(inspection.result, 'Hitch repaired eval result')
    const evidence = this.parseResult(
      result,
      { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
      request,
      identity,
      true,
    )
    if (evidence.evalId !== attempt.evalId) throw new HitchEvaluationError('repaired evidence eval id changed', 'hitch_eval_identity_mismatch')
    if ((envelope.eval_status === 'succeeded') !== (evidence.completeness === 'complete')) {
      throw new HitchEvaluationError('Hitch rerun status does not match repaired evidence completeness', 'invalid_hitch_result')
    }
    this.assertCompleteTrialSlots(inspection, evidence, request)
    return {
      provider: 'hitch-cli',
      evalId: attempt.evalId,
      selectedTasks,
      repairedTasks,
      remainingInvalidTasks,
      ...(selectedTrials === undefined ? {} : { selectedTrials }),
      ...(repairedTrials === undefined ? {} : { repairedTrials }),
      ...(remainingInvalidTrials === undefined ? {} : { remainingInvalidTrials }),
      evalStatus: envelope.eval_status,
      evidence,
    }
  }

  private async inspectEvaluation(
    evalId: string,
    cwd: string,
    signal: AbortSignal,
    failureCode: string,
  ): Promise<JsonRecord> {
    const inspect = await this.run([
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'inspect', evalId, '--json',
    ], cwd, signal)
    if (inspect.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch could not inspect eval ${evalId}`, failureCode)
    }
    let inspectionValue: unknown
    try { inspectionValue = JSON.parse(inspect.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid inspect JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const inspection = record(inspectionValue, 'Hitch eval inspection')
    if (inspection.schema_version !== '1' || inspection.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch inspection identity is invalid', 'invalid_hitch_result')
    }
    return inspection
  }

  private assertCompleteTrialSlots(
    inspection: JsonRecord,
    evidence: HitchEvaluationEvidence,
    request: Readonly<EvaluationRequest>,
  ): void {
    const plan = record(inspection.plan, 'Hitch eval plan')
    if (plan.schema_version !== '1' || plan.eval_id !== evidence.evalId) {
      throw new HitchEvaluationError('Hitch eval plan identity is invalid', 'invalid_hitch_result')
    }
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    if (inspectedRequest.schema_version !== '1' || inspectedRequest.backend !== 'harbor'
      || inspectedRequest.dataset !== request.dataset
      || inspectedRequest.model !== request.condition.model) {
      throw new HitchEvaluationError('Hitch eval request does not match the frozen Gear condition', 'invalid_hitch_result')
    }
    const attempts = integer(plan.attempts, 'plan.attempts')
    const requestedAttempts = integer(inspectedRequest.attempts, 'request.attempts')
    if (attempts <= 0 || attempts !== request.condition.repetitions || requestedAttempts !== attempts) {
      throw new HitchEvaluationError('Hitch eval plan attempts do not match the frozen condition', 'invalid_hitch_result')
    }
    const attemptExecution = plan.attempt_execution
    if ((attemptExecution !== undefined && attemptExecution !== 'harbor-attempt-shards-v1')
      || (attempts > 1 && attemptExecution !== 'harbor-attempt-shards-v1')) {
      throw new HitchEvaluationError('Hitch eval plan has no stable logical-attempt identity', 'invalid_hitch_result')
    }
    const benchmarkId = string(inspectedRequest.benchmark_id, 'request.benchmark_id')
    const benchmarkRevision = string(inspectedRequest.benchmark_revision, 'request.benchmark_revision')
    if (plan.backend !== 'harbor' || plan.dataset !== inspectedRequest.dataset
      || plan.benchmark_id !== benchmarkId || plan.benchmark_revision !== benchmarkRevision) {
      throw new HitchEvaluationError('Hitch eval request and plan dataset identity differ', 'invalid_hitch_result')
    }
    const candidate = record(plan.candidate, 'plan.candidate')
    const requestedHarnessRef = string(inspectedRequest.harness_ref, 'request.harness_ref')
    if (candidate.requested_harness_ref !== requestedHarnessRef
      || candidate.harness_id !== this.options.harnessId
      || candidate.revision_identity !== evidence.revisionIdentity) {
      throw new HitchEvaluationError('Hitch eval plan candidate identity differs from the result', 'invalid_hitch_result')
    }
    const lockedHarnessRef = string(candidate.harness_ref, 'plan.candidate.harness_ref')
    const lockedCommit = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)?.[1]
    if (lockedCommit !== request.harnessRef || lockedCommit !== evidence.actualCommit
      || lockedHarnessRef !== `${this.options.harnessId}@commit:${lockedCommit}`) {
      throw new HitchEvaluationError('Hitch eval plan candidate commit differs from the request', 'invalid_hitch_result')
    }
    const tasks = stringArray(plan.tasks, 'plan.tasks')
    const plannedTasks = new Set(tasks)
    if (tasks.length === 0 || plannedTasks.size !== tasks.length) {
      throw new HitchEvaluationError('Hitch eval plan tasks must be non-empty and unique', 'invalid_hitch_result')
    }
    const expectedTrials = tasks.length * attempts
    if (!Number.isSafeInteger(expectedTrials)) {
      throw new HitchEvaluationError('Hitch eval plan trial count exceeds the safe integer range', 'invalid_hitch_result')
    }
    const slots = new Set<string>()
    for (const trial of [...evidence.trials, ...evidence.invalidTrials]) {
      if (!plannedTasks.has(trial.taskName)) {
        throw new HitchEvaluationError(`Hitch evidence contains task outside the frozen plan: ${trial.taskName}`, 'invalid_hitch_result')
      }
      const logicalAttempt = trial.attempt ?? (attempts === 1 ? 1 : undefined)
      if (logicalAttempt === undefined || !Number.isSafeInteger(logicalAttempt)
        || logicalAttempt < 1 || logicalAttempt > attempts) {
        throw new HitchEvaluationError(
          `Hitch evidence attempt is outside frozen range 1..${attempts}: ${trial.taskName}#${String(trial.attempt)}`,
          'invalid_hitch_result',
        )
      }
      const slot = `${trial.taskName}\0${logicalAttempt}`
      if (slots.has(slot)) {
        throw new HitchEvaluationError(`Hitch evidence contains duplicate logical slot: ${trial.taskName}#${logicalAttempt}`, 'invalid_hitch_result')
      }
      slots.add(slot)
    }
    if (slots.size !== expectedTrials) {
      const missing: string[] = []
      for (const task of tasks) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!slots.has(`${task}\0${attempt}`)) missing.push(`${task}#${attempt}`)
        }
      }
      throw new HitchEvaluationError(
        `Hitch evidence is missing frozen logical slots: ${missing.join(', ')}`,
        'invalid_hitch_result',
      )
    }
  }

  private effectiveConfigDigest(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    hitchRuntimeIdentity: string,
  ): string {
    return sha256(JSON.stringify({
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      hitchRuntimeIdentity,
      backend: 'harbor',
      harnessId: this.options.harnessId,
      sandboxProfileRef: round.sandboxProfileRef,
    }))
  }

  private invocationFingerprint(effectiveConfigDigest: string): string {
    return sha256(JSON.stringify({
      effectiveConfigDigest,
      maxConcurrent: this.options.maxConcurrent,
      setupTimeoutMs: this.options.setupTimeoutMs,
      terminationGraceMs: this.options.terminationGraceMs,
      maxOutputBytes: this.options.maxOutputBytes,
      maxTrajectoryOutputBytes: this.options.maxTrajectoryOutputBytes,
      maxTrajectoryAnalysisBytes: this.options.maxTrajectoryAnalysisBytes ?? 16 * 1024 * 1024,
      maxTrajectoryEventsBytes: this.options.maxTrajectoryEventsBytes ?? 4 * 1024 * 1024,
    }))
  }

  private executablePath(): Promise<string> {
    this.executablePathPromise ??= this.resolveExecutablePath()
    return this.executablePathPromise
  }

  private async runtimeIdentity(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const executablePath = await this.executablePath()
    const readExecutable = async (): Promise<Uint8Array> => readFile(executablePath).catch(error => {
      throw new HitchEvaluationError(
        `cannot fingerprint Hitch executable ${executablePath}: ${String(error)}`,
        'hitch_version_check_failed',
      )
    })
    const executableDigestBefore = sha256(await readExecutable())
    signal?.throwIfAborted()
    const versionOutputDigest = await this.checkVersion(signal)
    signal?.throwIfAborted()
    const executableDigest = sha256(await readExecutable())
    if (executableDigest !== executableDigestBefore) {
      throw new HitchEvaluationError(
        `Hitch executable changed while its runtime identity was being validated: ${executablePath}`,
        'hitch_version_check_failed',
      )
    }
    return sha256(JSON.stringify({
      versionOutputDigest,
      executableDigest,
    }))
  }

  private async resolveExecutablePath(): Promise<string> {
    const candidates = this.options.executable.includes('/')
      ? [resolve(this.repositoryPath, this.options.executable)]
      : (process.env.PATH ?? '').split(delimiter)
        .filter(path => path.length > 0)
        .map(path => resolve(path, this.options.executable))
    for (const candidate of candidates) {
      try { return await realpath(candidate) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new HitchEvaluationError(
            `cannot resolve Hitch executable ${candidate}: ${String(error)}`,
            'hitch_version_check_failed',
          )
        }
      }
    }
    throw new HitchEvaluationError(
      `cannot resolve Hitch executable for runtime fingerprint: ${this.options.executable}`,
      'hitch_version_check_failed',
    )
  }

  private parseResult(
    value: unknown,
    processResult: ProcessResult,
    request: Readonly<EvaluationRequest>,
    identity: HitchEvaluationIdentity,
    allowFailedRunEvidence = false,
  ): HitchEvaluationEvidence {
    const result = record(value, 'Hitch result')
    if (result.schema_version !== '1') throw new HitchEvaluationError('unsupported Hitch eval schema', 'unsupported_hitch_schema')
    const evalId = string(result.eval_id, 'eval_id')
    if (!/^eval_[0-9a-f]{32}$/u.test(evalId)) throw new HitchEvaluationError('invalid Hitch eval_id', 'invalid_hitch_result')
    const exitCode = integer(result.exit_code, 'exit_code')
    if (processResult.exitCode !== exitCode) {
      throw new HitchEvaluationError(`Hitch process/result exit mismatch: ${processResult.exitCode} != ${exitCode}`)
    }
    const failedRunEvidence = allowFailedRunEvidence
      && result.status === 'failed'
      && exitCode !== 0
      && Array.isArray(result.trials)
    if ((result.status !== 'succeeded' || exitCode !== 0) && !failedRunEvidence) {
      const error = typeof result.error === 'object' && result.error !== null ? result.error as JsonRecord : {}
      throw new HitchEvaluationError(
        `Hitch eval ${evalId} failed (${String(error.code ?? result.status)}): ${String(error.message ?? processResult.stderr).slice(-4000)}`,
        typeof error.code === 'string' ? error.code : 'hitch_eval_failed',
      )
    }
    if (result.dataset !== request.dataset) throw new HitchEvaluationError('Hitch result dataset does not match the request')
    const candidate = record(result.candidate, 'candidate')
    const revisionIdentity = string(candidate.revision_identity, 'candidate.revision_identity')
    const lockedHarnessRef = string(candidate.harness_ref, 'candidate.harness_ref')
    const match = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)
    if (match?.[1] === undefined) throw new HitchEvaluationError('Hitch candidate does not contain a locked commit')
    const actualCommit = match[1]
    if (lockedHarnessRef !== `${this.options.harnessId}@commit:${actualCommit}`) {
      throw new HitchEvaluationError('Hitch candidate harness id does not match the configured adapter', 'hitch_commit_mismatch')
    }
    if (actualCommit !== request.harnessRef) {
      throw new HitchEvaluationError(`Hitch resolved ${actualCommit}, expected ${request.harnessRef}`, 'hitch_commit_mismatch')
    }
    const transport = this.parseTransport(result.local_source_transport)
    if (transport.commit !== request.harnessRef || transport.resolutionIdentity !== revisionIdentity) {
      throw new HitchEvaluationError('Hitch local source transport identity does not match the locked candidate', 'hitch_transport_mismatch')
    }
    const summaryValue = record(result.summary, 'summary')
    if (Array.isArray(result.trials)) {
      const evidence = this.parseRunCenteredResult(
        result,
        summaryValue,
        evalId,
        request,
        actualCommit,
        revisionIdentity,
        identity,
        transport,
      )
      if ((result.status === 'succeeded') !== (evidence.completeness === 'complete')) {
        throw new HitchEvaluationError(
          'Hitch result status does not match run evidence completeness',
          'invalid_hitch_result',
        )
      }
      return evidence
    }
    const total = integer(summaryValue.n_trials, 'summary.n_trials')
    const completed = integer(summaryValue.n_completed, 'summary.n_completed')
    const errored = integer(summaryValue.n_errored, 'summary.n_errored')
    const cancelled = integer(summaryValue.n_cancelled, 'summary.n_cancelled')
    if (total <= 0 || completed !== total || errored !== 0 || cancelled !== 0) {
      throw new HitchEvaluationError(
        `Hitch eval has incomplete trials: total=${total}, completed=${completed}, errored=${errored}, cancelled=${cancelled}`,
        'hitch_infrastructure_failure',
      )
    }
    const primaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
    const trials = this.parseTrials(summaryValue.trials)
    if (trials.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const summary: ScoreSummary = {
      total,
      passed,
      failed: total - passed,
      score: primaryReward,
      metrics: { primaryReward },
    }
    return {
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: identity.effectiveConfigDigest,
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint: identity.invocationFingerprint,
      completeness: 'complete',
      plannedTrialCount: total,
      primaryReward,
      summary,
      trials,
      invalidTrials: [],
      localSourceTransport: transport,
    }
  }

  private parseRunCenteredResult(
    result: JsonRecord,
    summaryValue: JsonRecord,
    evalId: string,
    request: Readonly<EvaluationRequest>,
    actualCommit: string,
    revisionIdentity: string,
    identity: HitchEvaluationIdentity,
    transport: LocalSourceTransportSummary,
  ): HitchEvaluationEvidence {
    const total = integer(summaryValue.n_trials, 'summary.n_trials')
    const completed = integer(summaryValue.n_completed, 'summary.n_completed')
    const invalid = integer(summaryValue.n_invalid, 'summary.n_invalid')
    const parsed = this.parseRunTrials(result.trials)
    if (total <= 0 || parsed.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
    const valid = parsed.filter(trial => trial.observationStatus === 'valid')
    const invalidObservations = parsed.filter(trial => trial.observationStatus === 'invalid')
    if (completed !== valid.length || invalid !== invalidObservations.length || completed + invalid !== total) {
      throw new HitchEvaluationError(
        `Hitch observation counts are inconsistent: total=${total}, completed=${completed}, invalid=${invalid}`,
        'invalid_hitch_result',
      )
    }
    const trials: HitchTrialSummary[] = valid.map(trial => ({
      taskName: trial.taskName,
      trialName: trial.trialName,
      runId: trial.runId,
      attempt: trial.attempt,
      status: 'completed',
      rewards: { reward: trial.reward! },
    }))
    const invalidTrials: InvalidEvaluationTrialSummary[] = invalidObservations.map(trial => ({
      taskName: trial.taskName,
      trialName: trial.trialName,
      runId: trial.runId,
      attempt: trial.attempt,
      status: 'errored',
      invalidReason: trial.invalidReason!,
    }))
    const primaryReward = trials.length === 0
      ? 0
      : trials.reduce((sum, trial) => sum + trial.rewards.reward!, 0) / trials.length
    if (trials.length > 0) {
      const reportedPrimaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
      if (Math.abs(reportedPrimaryReward - primaryReward) > 1e-12) {
        throw new HitchEvaluationError('Hitch primary reward does not match valid run observations', 'invalid_hitch_result')
      }
    }
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const summary: ScoreSummary = {
      total: trials.length,
      passed,
      failed: trials.length - passed,
      score: primaryReward,
      metrics: { primaryReward },
    }
    return {
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: identity.effectiveConfigDigest,
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint: identity.invocationFingerprint,
      completeness: invalidTrials.length === 0 ? 'complete' : 'partial',
      plannedTrialCount: total,
      primaryReward,
      summary,
      trials,
      invalidTrials,
      localSourceTransport: transport,
    }
  }

  private parseRunTrials(value: unknown): ParsedRunTrial[] {
    if (!Array.isArray(value)) throw new HitchEvaluationError('trials must be an array', 'invalid_hitch_result')
    return value.map((item, index) => {
      const trial = record(item, `trials[${index}]`)
      const runId = string(trial.run_id, `trials[${index}].run_id`)
      if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new HitchEvaluationError(`trials[${index}].run_id is invalid`, 'invalid_hitch_result')
      const observation = string(trial.observation_status, `trials[${index}].observation_status`)
      if (observation !== 'valid' && observation !== 'invalid') {
        throw new HitchEvaluationError(`trials[${index}].observation_status is invalid`, 'invalid_hitch_result')
      }
      const reward = observation === 'valid' ? finite(trial.reward, `trials[${index}].reward`) : undefined
      const invalidReason = observation === 'invalid'
        ? string(trial.invalid_reason, `trials[${index}].invalid_reason`)
        : undefined
      const attempt = integer(trial.attempt, `trials[${index}].attempt`)
      if (attempt <= 0) throw new HitchEvaluationError(`trials[${index}].attempt must be positive`, 'invalid_hitch_result')
      return {
        taskName: string(trial.task_id, `trials[${index}].task_id`),
        trialName: string(trial.trial_id, `trials[${index}].trial_id`),
        runId,
        attempt,
        observationStatus: observation,
        ...(reward === undefined ? {} : { reward }),
        ...(invalidReason === undefined ? {} : { invalidReason }),
      }
    })
  }

  private parseTrials(value: unknown): HitchTrialSummary[] {
    if (!Array.isArray(value)) throw new HitchEvaluationError('summary.trials must be an array', 'invalid_hitch_result')
    return value.map((item, index) => {
      const trial = record(item, `summary.trials[${index}]`)
      const status = trial.status
      if (status !== 'completed') {
        throw new HitchEvaluationError(`summary.trials[${index}].status is invalid`, 'invalid_hitch_result')
      }
      const rewardsValue = record(trial.rewards, `summary.trials[${index}].rewards`)
      const rewards: Record<string, number> = {}
      for (const [name, reward] of Object.entries(rewardsValue)) rewards[name] = finite(reward, `trial reward ${name}`)
      const taskName = string(trial.task_name, `summary.trials[${index}].task_name`)
      const trialName = typeof trial.trial_name === 'string' && trial.trial_name.length > 0 ? trial.trial_name : undefined
      return { taskName, ...(trialName === undefined ? {} : { trialName }), status: 'completed', rewards }
    })
  }

  private parseTransport(value: unknown): LocalSourceTransportSummary {
    const transport = record(value, 'local_source_transport')
    if (transport.kind !== 'local-git-commit') {
      throw new HitchEvaluationError('Hitch result is missing local exact commit transport evidence', 'missing_hitch_transport')
    }
    const commit = string(transport.commit, 'local_source_transport.commit')
    const tree = string(transport.tree, 'local_source_transport.tree')
    if (!isExactGitCommit(commit) || !isExactGitCommit(tree)) {
      throw new HitchEvaluationError('Hitch transport commit/tree is not an exact Git OID', 'invalid_hitch_result')
    }
    const payloadSha256 = string(transport.payload_sha256, 'local_source_transport.payload_sha256')
    if (!/^sha256:[0-9a-f]{64}$/u.test(payloadSha256)) {
      throw new HitchEvaluationError('Hitch transport payload digest is invalid', 'invalid_hitch_result')
    }
    return {
      kind: 'local-git-commit',
      resolutionIdentity: string(transport.resolution_identity, 'local_source_transport.resolution_identity'),
      commit,
      tree,
      payloadSha256,
      payloadBytes: integer(transport.payload_bytes, 'local_source_transport.payload_bytes'),
    }
  }

  private async run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    maxOutputBytes = this.options.maxOutputBytes,
  ): Promise<ProcessResult> {
    signal.throwIfAborted()
    const executablePath = await this.executablePath()
    signal.throwIfAborted()
    return new Promise<ProcessResult>((resolvePromise, reject) => {
      const child = spawn(executablePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let overflow: 'stdout' | 'stderr' | undefined
      let killTimer: NodeJS.Timeout | undefined
      const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
        if (overflow !== undefined) return
        const chunkBytes = Buffer.byteLength(chunk)
        const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes
        if (currentBytes + chunkBytes > maxOutputBytes) {
          overflow = stream
          child.kill('SIGTERM')
          return
        }
        if (stream === 'stdout') {
          stdoutChunks.push(chunk)
          stdoutBytes += chunkBytes
        } else {
          stderrChunks.push(chunk)
          stderrBytes += chunkBytes
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { append('stdout', chunk) })
      child.stderr.on('data', (chunk: string) => { append('stderr', chunk) })
      const terminate = (): void => {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), this.options.terminationGraceMs)
      }
      signal.addEventListener('abort', terminate, { once: true })
      child.once('error', error => {
        signal.removeEventListener('abort', terminate)
        if (killTimer !== undefined) clearTimeout(killTimer)
        reject(new HitchEvaluationError(`failed to start Hitch CLI: ${error.message}`, 'hitch_unavailable'))
      })
      child.once('exit', (code, childSignal) => {
        signal.removeEventListener('abort', terminate)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (signal.aborted) return reject(signal.reason)
        if (overflow !== undefined) {
          return reject(new HitchEvaluationError(`Hitch ${overflow} exceeded ${maxOutputBytes} bytes`, 'hitch_output_overflow'))
        }
        if (code === null) return reject(new HitchEvaluationError(`Hitch exited from signal ${childSignal ?? 'unknown'}`))
        resolvePromise({ stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: code })
      })
    })
  }
}
