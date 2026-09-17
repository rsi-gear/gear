import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { HitchConfig } from '../config.js'
import { digestJson } from '../state/digest.js'
import { digestDatasetRef } from '../state/dataset.js'
import type {
  EvaluationRequest,
  EvaluationRerunResult,
  EvaluationRerunSelector,
  EvaluationReservation,
  EvaluationSubmissionIntent,
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
  HitchVerifierDiagnosticPage,
  HitchVerifierDiagnosticPageQuery,
  HitchVerifierEvidence,
  InvalidEvaluationTrialSummary,
  LocalSourceTransportSummary,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
  ScoreSummary,
  EvaluationTrialScores,
  VerifierFeedback,
  VerifierProcessEvidence,
  VerifierStructuredArtifact,
  VerifierTrajectoryRef,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { EvaluationCleanupError } from './cleanup.js'
import type { EvaluationRerunReservation } from '../types.js'

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
type HitchControlPlaneOptions = NonNullable<HitchConfig['controlPlane']>

interface ParsedRunTrial {
  taskName: string
  trialName: string
  runId: string
  attempt: number
  observationStatus: 'valid' | 'invalid'
  reward?: number
  scores?: EvaluationTrialScores
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

function evaluationTrialScores(value: unknown, label: string): EvaluationTrialScores {
  const scores = record(value, label)
  exactFields(scores, ['total_score', 'process_score', 'normalization'], label)
  const totalScore = finite(scores.total_score, `${label}.total_score`)
  const processScore = optionalFinite(scores.process_score, `${label}.process_score`)
  if (scores.normalization !== 'standard' && scores.normalization !== 'legacy-reward') {
    throw new HitchEvaluationError(`${label}.normalization is invalid`, 'invalid_hitch_result')
  }
  if (scores.normalization === 'legacy-reward' && processScore !== undefined) {
    throw new HitchEvaluationError(`${label} legacy normalization cannot include process_score`, 'invalid_hitch_result')
  }
  return {
    totalScore,
    ...(processScore === undefined ? {} : { processScore }),
    normalization: scores.normalization,
  }
}

function verifierTrajectoryRefs(value: unknown, label: string): VerifierTrajectoryRef[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  return value.map((item, index) => {
    const ref = record(item, `${label}[${index}]`)
    exactFields(ref, ['run_id', 'seq_start', 'seq_end'], `${label}[${index}]`)
    const runId = string(ref.run_id, `${label}[${index}].run_id`)
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new HitchEvaluationError(`${label}[${index}].run_id is invalid`, 'invalid_hitch_result')
    const seqStart = ref.seq_start === undefined ? undefined : integer(ref.seq_start, `${label}[${index}].seq_start`)
    const seqEnd = ref.seq_end === undefined ? undefined : integer(ref.seq_end, `${label}[${index}].seq_end`)
    if (seqStart !== undefined && seqEnd !== undefined && seqEnd < seqStart) {
      throw new HitchEvaluationError(`${label}[${index}] range is invalid`, 'invalid_hitch_result')
    }
    return { runId, ...(seqStart === undefined ? {} : { seqStart }), ...(seqEnd === undefined ? {} : { seqEnd }) }
  })
}

function verifierProcessEvidence(value: unknown): VerifierProcessEvidence {
  const process = record(value, 'verifier process evidence')
  exactFields(process, ['schema_version', 'metric', 'score', 'detail_status', 'passed', 'total', 'excluded', 'components'], 'verifier process evidence')
  if (process.schema_version !== '1' || (process.detail_status !== 'components' && process.detail_status !== 'aggregate-only')) {
    throw new HitchEvaluationError('verifier process evidence schema is invalid', 'invalid_hitch_result')
  }
  const metric = string(process.metric, 'verifier process evidence.metric')
  const score = finite(process.score, 'verifier process evidence.score')
  if (process.detail_status === 'aggregate-only') {
    if (process.passed !== undefined || process.total !== undefined || process.excluded !== undefined || process.components !== undefined) {
      throw new HitchEvaluationError('aggregate-only verifier process evidence contains component fields', 'invalid_hitch_result')
    }
    return { schemaVersion: 1, metric, score, detailStatus: 'aggregate-only' }
  }
  const passed = integer(process.passed, 'verifier process evidence.passed')
  const total = integer(process.total, 'verifier process evidence.total')
  const excluded = integer(process.excluded, 'verifier process evidence.excluded')
  if (!Array.isArray(process.components)) throw new HitchEvaluationError('verifier process evidence.components must be an array', 'invalid_hitch_result')
  const components = process.components.map((item, index) => {
    const component = record(item, `verifier process evidence.components[${index}]`)
    exactFields(component, ['id', 'category', 'status', 'weight', 'code', 'public_details', 'private_details_ref', 'trajectory_refs'], `verifier process evidence.components[${index}]`)
    if (component.status !== 'passed' && component.status !== 'failed' && component.status !== 'excluded') {
      throw new HitchEvaluationError(`verifier process evidence.components[${index}].status is invalid`, 'invalid_hitch_result')
    }
    const publicDetails = component.public_details === undefined ? undefined : record(component.public_details, `verifier process evidence.components[${index}].public_details`)
    const trajectoryRefs = component.trajectory_refs === undefined ? undefined : verifierTrajectoryRefs(component.trajectory_refs, `verifier process evidence.components[${index}].trajectory_refs`)
    return {
      id: string(component.id, `verifier process evidence.components[${index}].id`),
      category: string(component.category, `verifier process evidence.components[${index}].category`),
      status: component.status as 'passed' | 'failed' | 'excluded',
      weight: finite(component.weight, `verifier process evidence.components[${index}].weight`),
      ...(component.code === undefined ? {} : { code: string(component.code, `verifier process evidence.components[${index}].code`) }),
      ...(publicDetails === undefined ? {} : {
        publicDetails: Object.fromEntries(Object.entries(publicDetails).map(([key, item]) => [key, jsonValue(item, `verifier process evidence.components[${index}].public_details.${key}`)])),
      }),
      ...(component.private_details_ref === undefined ? {} : { privateDetailsRef: string(component.private_details_ref, `verifier process evidence.components[${index}].private_details_ref`) }),
      ...(trajectoryRefs === undefined ? {} : { trajectoryRefs }),
    }
  })
  if (new Set(components.map(component => component.id)).size !== components.length
    || passed !== components.filter(component => component.status === 'passed').length
    || total !== components.filter(component => component.status !== 'excluded').length
    || excluded !== components.filter(component => component.status === 'excluded').length) {
    throw new HitchEvaluationError('verifier process evidence component counts are inconsistent', 'invalid_hitch_result')
  }
  return { schemaVersion: 1, metric, score, detailStatus: 'components', passed, total, excluded, components }
}

function verifierFeedback(value: unknown, process: VerifierProcessEvidence | undefined): VerifierFeedback {
  const feedback = record(value, 'verifier feedback')
  exactFields(feedback, ['schema_version', 'items'], 'verifier feedback')
  if (feedback.schema_version !== '1' || !Array.isArray(feedback.items)) {
    throw new HitchEvaluationError('verifier feedback schema is invalid', 'invalid_hitch_result')
  }
  const componentIds = new Set(process?.components?.map(component => component.id) ?? [])
  const items = feedback.items.map((item, index) => {
    const entry = record(item, `verifier feedback.items[${index}]`)
    exactFields(entry, ['code', 'severity', 'message', 'component_ids', 'trajectory_refs'], `verifier feedback.items[${index}]`)
    if (entry.severity !== 'info' && entry.severity !== 'warning' && entry.severity !== 'error') {
      throw new HitchEvaluationError(`verifier feedback.items[${index}].severity is invalid`, 'invalid_hitch_result')
    }
    const ids = entry.component_ids === undefined ? undefined : stringArray(entry.component_ids, `verifier feedback.items[${index}].component_ids`)
    if (ids?.some(id => !componentIds.has(id))) throw new HitchEvaluationError('verifier feedback references an unknown process component', 'invalid_hitch_result')
    const refs = entry.trajectory_refs === undefined ? undefined : verifierTrajectoryRefs(entry.trajectory_refs, `verifier feedback.items[${index}].trajectory_refs`)
    return {
      code: string(entry.code, `verifier feedback.items[${index}].code`),
      severity: entry.severity as 'info' | 'warning' | 'error',
      message: string(entry.message, `verifier feedback.items[${index}].message`),
      ...(ids === undefined ? {} : { componentIds: ids }),
      ...(refs === undefined ? {} : { trajectoryRefs: refs }),
    }
  })
  return { schemaVersion: 1, items }
}

function verifierStructuredArtifact(value: unknown, name: 'process' | 'feedback'): VerifierStructuredArtifact {
  const artifact = record(value, `verifier structured artifact ${name}`)
  exactFields(artifact, ['ref', 'bytes', 'sha256'], `verifier structured artifact ${name}`)
  const expected = `verifier/${name}.json` as VerifierStructuredArtifact['ref']
  if (artifact.ref !== expected) throw new HitchEvaluationError(`verifier structured artifact ${name}.ref is invalid`, 'invalid_hitch_result')
  return {
    ref: expected,
    bytes: integer(artifact.bytes, `verifier structured artifact ${name}.bytes`),
    sha256: digest(artifact.sha256, `verifier structured artifact ${name}.sha256`),
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
    exactFields(raw, ['status', 'content', 'streams', 'source_seq_count'], `${label}.partial`)
    if (raw.status !== 'incomplete') throw new HitchEvaluationError(`${label}.partial.status is invalid`, 'invalid_hitch_result')
    if ((raw.content === undefined) === (raw.streams === undefined)) {
      throw new HitchEvaluationError(`${label}.partial requires exactly one of content or streams`, 'invalid_hitch_result')
    }
    const sourceSeqCount = integer(raw.source_seq_count, `${label}.partial.source_seq_count`)
    if (raw.streams === undefined) {
      partial = {
        status: 'incomplete',
        content: hitchContentExcerpt(raw.content, `${label}.partial.content`, runId),
        sourceSeqCount,
      }
    } else {
      if (!Array.isArray(raw.streams) || raw.streams.length < 2) {
        throw new HitchEvaluationError(`${label}.partial.streams requires at least two streams`, 'invalid_hitch_result')
      }
      const streams = raw.streams.map((item, streamIndex) => {
        const streamLabel = `${label}.partial.streams[${streamIndex}]`
        const stream = record(item, streamLabel)
        exactFields(stream, ['block_index', 'block_start_seq', 'kind', 'content', 'source_seq_count'], streamLabel)
        const blockIndex = integer(stream.block_index, `${streamLabel}.block_index`)
        const blockStartSeq = integer(stream.block_start_seq, `${streamLabel}.block_start_seq`)
        if (stream.kind !== 'text' && stream.kind !== 'reasoning' && stream.kind !== 'tool_arguments') {
          throw new HitchEvaluationError(`${streamLabel}.kind is invalid`, 'invalid_hitch_result')
        }
        const content = hitchContentExcerpt(stream.content, `${streamLabel}.content`, runId)
        if (blockStartSeq < firstSeq || blockStartSeq > lastSeq
          || content.source.seq !== blockStartSeq || content.source.field !== 'data.chunk.delta') {
          throw new HitchEvaluationError(`${streamLabel} has an inconsistent source`, 'invalid_hitch_result')
        }
        return {
          blockIndex, blockStartSeq, kind: stream.kind as 'text' | 'reasoning' | 'tool_arguments', content,
          sourceSeqCount: integer(stream.source_seq_count, `${streamLabel}.source_seq_count`),
        }
      })
      if (streams.some((stream, streamIndex) => streamIndex > 0 && streams[streamIndex - 1]!.blockStartSeq >= stream.blockStartSeq)
        || streams.reduce((total, stream) => total + stream.sourceSeqCount, 0) !== sourceSeqCount) {
        throw new HitchEvaluationError(`${label}.partial.streams has inconsistent order or source counts`, 'invalid_hitch_result')
      }
      partial = { status: 'incomplete', streams, sourceSeqCount }
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

function memorySizeBytes(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/iu)
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const multiplier = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'kib' ? 1024 : 1
  const bytes = amount * multiplier
  return Number.isSafeInteger(bytes) && bytes >= 1024 ** 2 && bytes % (1024 ** 2) === 0 ? bytes : undefined
}

function validMemorySize(value: string): boolean {
  return memorySizeBytes(value) !== undefined
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

  private get controlPlane(): HitchControlPlaneOptions {
    return { mode: 'direct', requireModelCapture: false, ...this.options.controlPlane }
  }

  private get daemonMode(): boolean {
    return this.controlPlane.mode === 'daemon'
  }

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
    const controlPlane = this.controlPlane
    if (controlPlane.mode !== 'direct' && controlPlane.mode !== 'daemon') throw new TypeError('hitch.controlPlane.mode is invalid')
    if (controlPlane.provider !== undefined && (!controlPlane.provider.trim() || /[\0\r\n]/u.test(controlPlane.provider))) {
      throw new TypeError('hitch.controlPlane.provider is invalid')
    }
    if (controlPlane.cpuPerTrial !== undefined
      && (!Number.isSafeInteger(controlPlane.cpuPerTrial) || controlPlane.cpuPerTrial <= 0)) {
      throw new TypeError('hitch.controlPlane.cpuPerTrial must be a positive integer')
    }
    if (controlPlane.memoryPerTrial !== undefined && !validMemorySize(controlPlane.memoryPerTrial)) {
      throw new TypeError('hitch.controlPlane.memoryPerTrial must be a positive whole number of MiB using B, KiB, MiB, or GiB')
    }
    if (controlPlane.buildMode !== undefined
      && !new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(controlPlane.buildMode)) {
      throw new TypeError('hitch.controlPlane.buildMode is invalid')
    }
    if (controlPlane.modelCapture !== undefined
      && !new Set(['off', 'native', 'proxy', 'hybrid']).has(controlPlane.modelCapture)) {
      throw new TypeError('hitch.controlPlane.modelCapture is invalid')
    }
    if (controlPlane.modelCapture === 'off' && controlPlane.requireModelCapture) {
      throw new TypeError('hitch.controlPlane.modelCapture=off cannot be required')
    }
    if (controlPlane.mode === 'direct' && this.controlPlanePolicyIsExplicit()) {
      throw new TypeError('hitch.controlPlane execution policy requires mode=daemon')
    }
  }

  async preflight(): Promise<void> {
    await this.checkVersion()
    if (this.daemonMode) await this.checkDaemon()
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
    const minimumPatch = this.daemonMode ? 6 : 5
    const coreAboveMinimum = major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch > minimumPatch)))
    const coreAtMinimum = major === 0 && minor === 2 && patch === minimumPatch
    const supported = coreAboveMinimum || (coreAtMinimum && match[4] === undefined)
    if (!supported) {
      const minimum = `0.2.${minimumPatch}`
      throw new HitchEvaluationError(
        `unsupported Hitch CLI ${match[0].trim()}; Gear requires agent-hitch >= ${minimum}${this.daemonMode ? ' for daemon eval control-plane support' : ' for stable eval identity and multi-attempt rerun'}`,
        'unsupported_hitch_version',
      )
    }
    return sha256(output)
  }

  private async checkDaemon(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new HitchEvaluationError(
        `Hitch daemon status check timed out for root ${this.options.root || '<default>'}`,
        'hitch_daemon_check_failed',
      )),
      5_000,
    )
    let result: ProcessResult
    try {
      result = await this.run([
        ...this.rootArgs(), 'daemon', 'status', '--json',
      ], this.repositoryPath, controller.signal, 64 * 1024)
    } finally {
      clearTimeout(timeout)
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid daemon status JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const health = record(parsed, 'Hitch daemon health')
    if (result.exitCode !== 0 || health.schema_version !== '1' || health.status !== 'running') {
      throw new HitchEvaluationError(
        `Hitch daemon is not running for root ${this.options.root || '<default>'}: ${result.stderr.slice(-4000)}`,
        'hitch_daemon_unavailable',
      )
    }
    const policy = record(health.resource_policy, 'Hitch daemon resource policy')
    this.parseResourceVector(policy.eval_trial, 'Hitch daemon eval trial policy')
  }

  prepareSubmission(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): EvaluationSubmissionIntent | undefined {
    if (!this.daemonMode) return undefined
    this.assertEvaluationRequest(round, request)
    return {
      provider: 'hitch-cli',
      idempotencyKey: this.daemonIdempotencyKey(round, request),
      parameters: {
        root: this.options.root,
        args: [...this.controlPlaneArgs(), ...this.evalRequestArgs(round, request)],
      },
    }
  }

  async reserve(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    signal?.throwIfAborted()
    // A stored intent must remain recoverable even if the configured mode changed.
    if (intent !== undefined) return this.reserveDaemonEvaluation(round, intent, signal)
    if (this.daemonMode) throw new TypeError('Hitch daemon submission requires a persisted submission intent')
    return { provider: 'hitch-cli', evalId: `eval_${randomUUID().replaceAll('-', '')}` }
  }

  private async reserveDaemonEvaluation(
    round: Readonly<RefinementRound>,
    intent: Readonly<EvaluationSubmissionIntent>,
    signal?: AbortSignal,
  ): Promise<EvaluationReservation> {
    const parameters = this.submissionParameters(intent)
    const args = [
      ...(parameters.root.length === 0 ? [] : ['--root', parameters.root]),
      'eval', 'submit',
      '--idempotency-key', intent.idempotencyKey,
      ...parameters.args,
    ]
    const timeout = AbortSignal.timeout(30_000)
    const result = await this.run(args, round.workspaceRoot,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]), 64 * 1024)
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch daemon eval submission failed: ${result.stderr.slice(-4000)}`, 'hitch_eval_submit_failed')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid eval submission JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const accepted = record(parsed, 'Hitch eval submission')
    const evalId = string(accepted.eval_id, 'eval submission eval_id')
    if (accepted.schema_version !== '1' || !/^eval_[0-9a-f]{32}$/u.test(evalId)
      || !new Set(['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed']).has(accepted.status as string)) {
      throw new HitchEvaluationError('Hitch eval submission identity/status is invalid', 'invalid_hitch_result')
    }
    return { provider: 'hitch-cli', evalId }
  }

  private submissionParameters(intent: Readonly<EvaluationSubmissionIntent>): { root: string; args: string[] } {
    if (intent.provider !== 'hitch-cli' || !/^gear-eval-v1-[0-9a-f]{64}$/u.test(intent.idempotencyKey)) {
      throw new TypeError('Hitch submission intent identity is invalid')
    }
    const parameters = record(intent.parameters, 'Hitch submission parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch submission root is invalid')
    return { root: parameters.root, args: stringArray(parameters.args, 'Hitch submission arguments') }
  }

  async recoverReservation(
    round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    intent: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    const parameters = this.submissionParameters(intent)
    try { return await this.reserveDaemonEvaluation(round, intent, signal) }
    catch (submissionError) {
      // Hitch resolves daemon defaults before checking the idempotency index.
      // Changed defaults or unavailable execution capacity can reject a replay
      // even though the original evaluation still exists. Locate its frozen key
      // through the public read-only CLI so it can still be cancelled.
      signal.throwIfAborted()
      const rootArgs = parameters.root.length === 0 ? [] : ['--root', parameters.root]
      const listed = await this.run([...rootArgs, 'eval', 'list', '--json'], this.repositoryPath, signal)
      if (listed.exitCode !== 0) throw submissionError
      const list = record(JSON.parse(listed.stdout), 'Hitch evaluation list')
      if (list.schema_version !== '1' || !Array.isArray(list.evals)) throw submissionError
      for (const value of list.evals) {
        const entry = record(value, 'Hitch listed evaluation')
        const evalId = string(entry.eval_id, 'Hitch listed eval_id')
        if (!/^eval_[0-9a-f]{32}$/u.test(evalId)) throw submissionError
        const inspection = await this.inspectEvaluation(evalId, this.repositoryPath, signal,
          'hitch_eval_recovery_inspect_failed', parameters.root)
        if (inspection.submission === undefined) continue
        const submission = record(inspection.submission, 'Hitch persisted submission')
        if (submission.schema_version === '1' && submission.eval_id === evalId
          && submission.idempotency_key_hash === sha256(intent.idempotencyKey)) {
          return { provider: 'hitch-cli', evalId }
        }
      }
      throw submissionError
    }
  }

  async cancelReservation(
    reservation: Readonly<EvaluationReservation>,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<void> {
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)) {
      throw new TypeError('Hitch cancellation reservation is invalid')
    }
    const root = intent === undefined ? this.options.root : this.submissionParameters(intent).root
    await this.cancelDaemonEvaluation(reservation.evalId, this.repositoryPath, root)
  }

  private controlPlanePolicyIsExplicit(): boolean {
    const policy = this.controlPlane
    return policy.provider !== undefined || policy.cpuPerTrial !== undefined || policy.memoryPerTrial !== undefined
      || policy.buildMode !== undefined || policy.modelCapture !== undefined || policy.requireModelCapture
  }

  private rootArgs(): string[] {
    return this.options.root.length === 0 ? [] : ['--root', this.options.root]
  }

  private controlPlaneArgs(): string[] {
    const policy = this.controlPlane
    return [
      ...(policy.provider === undefined ? [] : ['--provider', policy.provider]),
      ...(policy.cpuPerTrial === undefined ? [] : ['--cpu-per-trial', String(policy.cpuPerTrial)]),
      ...(policy.memoryPerTrial === undefined ? [] : ['--memory-per-trial', policy.memoryPerTrial]),
      ...(policy.buildMode === undefined ? [] : ['--build-mode', policy.buildMode]),
      ...(policy.modelCapture === undefined ? [] : ['--model-capture', policy.modelCapture]),
      ...(policy.requireModelCapture ? ['--require-model-capture'] : []),
    ]
  }

  private evalRequestArgs(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): string[] {
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    return [
      '--backend', 'harbor',
      '--dataset', request.dataset,
      '--harness', `${this.options.harnessId}@${source}`,
      ...(request.condition.model.length === 0 ? [] : ['--model', request.condition.model]),
      '--attempts', String(request.condition.repetitions),
      '--max-concurrent', String(this.options.maxConcurrent),
      '--timeout', `${round.taskBudgetMs}ms`,
      '--setup-timeout', `${this.options.setupTimeoutMs}ms`,
      ...this.options.agentArgs.flatMap(value => ['--agent-arg', value]),
      ...this.options.passEnv.flatMap(value => ['--pass-env', value]),
    ]
  }

  private assertEvaluationRequest(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): void {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    if (request.condition.dataset.ref !== request.dataset || request.condition.timeoutMs !== round.taskBudgetMs) {
      throw new TypeError('Hitch evaluation request does not match its resolved condition')
    }
    if (request.condition.seeds !== undefined) throw new TypeError('Hitch CLI adapter does not support typed rollout seeds')
    if (request.condition.sampling.temperature !== undefined) {
      throw new TypeError('Hitch CLI adapter does not support typed rollout temperature')
    }
  }

  private daemonIdempotencyKey(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): string {
    return `gear-eval-v1-${sha256(JSON.stringify({
      evolutionId: round.evolutionId,
      roundId: round.roundId,
      phase: request.phase,
      conditionId: request.condition.conditionId,
      dataset: request.dataset,
      harnessRef: request.harnessRef,
      model: request.condition.model,
      repetitions: request.condition.repetitions,
      invocation: this.baseParity(round, request),
    })).slice('sha256:'.length)}`
  }

  private baseParity(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): JsonRecord {
    return {
      conditionId: request.condition.conditionId,
      executable: this.options.executable,
      hitchRoot: this.options.root,
      repositoryPath: this.repositoryPath,
      backend: 'harbor',
      dataset: request.dataset,
      harnessId: this.options.harnessId,
      model: request.condition.model,
      attempts: request.condition.repetitions,
      maxConcurrent: this.options.maxConcurrent,
      timeoutMs: round.taskBudgetMs,
      setupTimeoutMs: this.options.setupTimeoutMs,
      agentArgs: this.options.agentArgs,
      passEnv: this.options.passEnv,
      sandboxProfileRef: round.sandboxProfileRef,
      ...(this.daemonMode ? { executionMode: 'daemon' } : {}),
    }
  }

  private parseResourceVector(value: unknown, label: string): JsonRecord {
    const resources = record(value, label)
    for (const field of ['cpu_millis', 'memory_bytes', 'container_slots', 'build_slots']) {
      integer(resources[field], `${label}.${field}`)
    }
    for (const field of ['gpu_count', 'ephemeral_disk_bytes']) {
      if (resources[field] !== undefined) integer(resources[field], `${label}.${field}`)
    }
    return resources
  }

  async evaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity | undefined> {
    signal?.throwIfAborted()
    // Daemon defaults are frozen at submission; prior evidence cannot be reused
    // until the current execution policy can be resolved before submission.
    if (this.daemonMode) return undefined
    // Settled evidence has already passed Hitch planning. Verify that the whole
    // compiled dataset, including its adapter/scoring manifest, is unchanged.
    // Unknown legacy identities stay unresolved; the service must block reuse
    // rather than treating that uncertainty as permission to run more trials.
    if (await this.hasStandardBenchmarkManifest(round, request)) {
      const datasetDigest = await digestDatasetRef(request.dataset, round.workspaceRoot)
      signal?.throwIfAborted()
      if (datasetDigest !== request.condition.dataset.digest) return undefined
    }
    return this.resolveEvaluationIdentity(round, request, signal)
  }

  /** Reads the existing Hitch submission record; this adds no Hitch CLI command or protocol. */
  async submittedEvaluationIdentity(
    round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>, reservation: Readonly<EvaluationReservation>,
    signal: AbortSignal, intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<(HitchEvaluationIdentity & { cohortDigest: string }) | undefined> {
    if (!this.daemonMode) return undefined
    this.assertEvaluationRequest(round, request)
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)) throw new TypeError('invalid evaluation reservation')
    const inspection = await this.inspectEvaluation(reservation.evalId, round.workspaceRoot, signal, 'hitch_eval_inspect_failed',
      intent === undefined ? this.options.root : this.submissionParameters(intent).root)
    const identity = this.daemonEvaluationIdentity(round, request, inspection, await this.resolveEvaluationIdentity(round, request, signal))
    const submission = record(inspection.submission, 'Hitch eval submission')
    // Task projections and candidate commits vary within one paired cohort.
    // All other submitted execution parameters (including daemon defaults) must agree.
    const { dataset: _dataset, harness_ref: _harness, attempts: _attempts,
      benchmark_id: _benchmark, benchmark_revision: _revision, ...submittedConfig } = record(submission.request, 'Hitch eval submitted request')
    const { conditionId: _condition, dataset: _projection, attempts: _repetitions, ...invocation } = this.baseParity(round, request)
    const runtime = await this.runtimeIdentity(signal)
    // Also bind Gear's invocation controls, such as setup timeout and output limits,
    // without including the per-batch conditionId in the common identity.
    return { ...identity, cohortDigest: digestJson({ provider: identity.provider, executionMode: 'daemon', execution: submission.execution,
      request: submittedConfig, scoringContract: 'benchmark-scores-v1',
      invocationFingerprint: this.invocationFingerprint(digestJson(invocation), runtime) }) }
  }

  private async hasStandardBenchmarkManifest(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): Promise<boolean> {
    try {
      await readFile(resolve(round.workspaceRoot, request.dataset, 'benchmark.adapter.json'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async resolveEvaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity> {
    signal?.throwIfAborted()
    const hitchRuntimeIdentity = await this.runtimeIdentity(signal)
    signal?.throwIfAborted()
    const effectiveConfigDigest = this.effectiveConfigDigest(round, request)
    const invocationFingerprint = this.invocationFingerprint(effectiveConfigDigest, hitchRuntimeIdentity)
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

  async inspectVerifierDiagnosticPage(
    runId: string,
    query: Readonly<HitchVerifierDiagnosticPageQuery>,
    signal: AbortSignal,
  ): Promise<HitchVerifierDiagnosticPage> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch verifier diagnostics require a valid run ID')
    const names: readonly HitchVerifierDiagnosticPageQuery['name'][] = [
      'ctrf.json', 'test-stdout.txt', 'test-stderr.txt', 'stdout.txt', 'stderr.txt',
    ]
    if (!names.includes(query.name)) throw new TypeError('Hitch verifier diagnostic name is invalid')
    const offset = query.offset ?? 0
    const limit = query.limit ?? 64 * 1024
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('Hitch verifier diagnostic offset must be a non-negative integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > 64 * 1024) {
      throw new TypeError('Hitch verifier diagnostic limit must be between 4 and 65536')
    }
    if (query.sha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(query.sha256)) {
      throw new TypeError('Hitch verifier diagnostic sha256 is invalid')
    }
    signal.throwIfAborted()
    const capabilityResult = await this.run(['capabilities', '--json'], this.repositoryPath, signal, 16_384)
    if (capabilityResult.exitCode !== 0) {
      throw new HitchEvaluationError(
        'Hitch does not expose bounded verifier diagnostic pages',
        'hitch_verifier_diagnostic_pages_unavailable',
      )
    }
    let parsedCapabilities: unknown
    try { parsedCapabilities = JSON.parse(capabilityResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid capabilities JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const capabilities = record(parsedCapabilities, 'Hitch capabilities')
    if (capabilities.schema_version !== '1') {
      throw new HitchEvaluationError('Hitch verifier diagnostic capability schema is invalid', 'invalid_hitch_result')
    }
    if (capabilities.verifier_diagnostic_pages === undefined) {
      throw new HitchEvaluationError(
        'Hitch does not expose bounded verifier diagnostic pages',
        'hitch_verifier_diagnostic_pages_unavailable',
      )
    }
    if (capabilities.verifier_diagnostic_pages !== '1') {
      throw new HitchEvaluationError('Hitch verifier_diagnostic_pages capability is invalid', 'invalid_hitch_result')
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'verifier', 'artifact', runId, query.name,
      '--offset', String(offset), '--limit', String(limit),
      ...(query.sha256 === undefined ? [] : ['--sha256', query.sha256]),
      '--json',
    ]
    const processResult = await this.run(
      args,
      this.repositoryPath,
      signal,
      Math.min(this.options.maxTrajectoryOutputBytes, limit * 6 + 16 * 1024),
    )
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      const structured = structuredCliError(output)
      throw new HitchEvaluationError(
        structured === undefined
          ? `Hitch verifier artifact failed with exit ${processResult.exitCode}: ${excerpt(output, 1_000)}`
          : `Hitch verifier artifact failed: ${excerpt(structured.message, 1_000)}`,
        structured?.code ?? 'hitch_verifier_diagnostic_page_failed',
      )
    }
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid verifier diagnostic page JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const result = record(parsed, 'Hitch verifier diagnostic page')
    exactFields(result, ['schema_version', 'kind', 'run_id', 'artifact', 'page'], 'Hitch verifier diagnostic page')
    if (result.schema_version !== '1' || result.kind !== 'verifier-diagnostic-page' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch verifier diagnostic page identity does not match the request', 'invalid_hitch_result')
    }
    const artifact = record(result.artifact, 'verifier diagnostic artifact')
    exactFields(artifact, ['name', 'media_type', 'bytes', 'sha256', 'source_complete', 'loss_reason'], 'verifier diagnostic artifact')
    const name = string(artifact.name, 'verifier diagnostic artifact.name')
    if (name !== query.name) throw new HitchEvaluationError('Hitch verifier diagnostic artifact name does not match the request', 'invalid_hitch_result')
    const mediaType = string(artifact.media_type, 'verifier diagnostic artifact.media_type')
    const expectedMediaType = name === 'ctrf.json' ? 'application/json' : 'text/plain'
    if (mediaType !== expectedMediaType) throw new HitchEvaluationError('Hitch verifier diagnostic media type is invalid', 'invalid_hitch_result')
    const bytes = integer(artifact.bytes, 'verifier diagnostic artifact.bytes')
    const sha256 = digest(artifact.sha256, 'verifier diagnostic artifact.sha256')
    if (typeof artifact.source_complete !== 'boolean') {
      throw new HitchEvaluationError('verifier diagnostic artifact.source_complete must be boolean', 'invalid_hitch_result')
    }
    const lossReason = optionalString(artifact.loss_reason, 'verifier diagnostic artifact.loss_reason')
    if (artifact.source_complete && lossReason !== undefined) {
      throw new HitchEvaluationError('complete verifier diagnostic artifact cannot have loss_reason', 'invalid_hitch_result')
    }
    if (!artifact.source_complete && lossReason === undefined) {
      throw new HitchEvaluationError('incomplete verifier diagnostic artifact requires loss_reason', 'invalid_hitch_result')
    }
    if (query.sha256 !== undefined && sha256 !== query.sha256) {
      throw new HitchEvaluationError('Hitch verifier diagnostic artifact changed while paging', 'verifier_diagnostic_version_mismatch')
    }
    const page = record(result.page, 'verifier diagnostic page')
    exactFields(page, ['offset', 'bytes', 'text', 'eof', 'next_offset'], 'verifier diagnostic page')
    const pageOffset = integer(page.offset, 'verifier diagnostic page.offset')
    const pageBytes = integer(page.bytes, 'verifier diagnostic page.bytes')
    if (pageOffset !== offset || typeof page.text !== 'string' || typeof page.eof !== 'boolean'
      || Buffer.byteLength(page.text) !== pageBytes || pageBytes > limit) {
      throw new HitchEvaluationError('Hitch verifier diagnostic page has inconsistent offset or bytes', 'invalid_hitch_result')
    }
    const nextOffset = page.next_offset === undefined
      ? undefined
      : integer(page.next_offset, 'verifier diagnostic page.next_offset')
    if (!artifact.source_complete) {
      if (pageOffset !== 0 || pageBytes !== 0 || page.text !== '' || !page.eof || nextOffset !== undefined) {
        throw new HitchEvaluationError('incomplete verifier diagnostic must return a terminal empty page', 'invalid_hitch_result')
      }
    } else if (page.eof) {
      if (nextOffset !== undefined || pageOffset + pageBytes !== bytes) {
        throw new HitchEvaluationError('Hitch verifier diagnostic EOF is inconsistent', 'invalid_hitch_result')
      }
    } else if (pageBytes === 0 || nextOffset !== pageOffset + pageBytes || nextOffset > bytes) {
      throw new HitchEvaluationError('Hitch verifier diagnostic continuation is inconsistent', 'invalid_hitch_result')
    }
    return {
      schemaVersion: 1,
      kind: 'verifier-diagnostic-page',
      runId,
      artifact: {
        name: query.name,
        mediaType: mediaType as 'application/json' | 'text/plain',
        bytes,
        sha256,
        sourceComplete: artifact.source_complete,
        ...(lossReason === undefined ? {} : { lossReason }),
      },
      page: {
        offset: pageOffset,
        bytes: pageBytes,
        text: page.text,
        eof: page.eof,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      },
    }
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
    exactFields(
      verifierRecord,
      ['status', 'result', 'result_sha256', 'scores', 'process', 'feedback', 'structured_artifacts', 'diagnostics', 'issues'],
      'verifier evidence verifier',
    )
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
    const scores = verifierRecord.scores === undefined
      ? undefined
      : evaluationTrialScores(verifierRecord.scores, 'verifier evidence scores')
    const process = verifierRecord.process === undefined
      ? undefined
      : verifierProcessEvidence(verifierRecord.process)
    const feedback = verifierRecord.feedback === undefined
      ? undefined
      : verifierFeedback(verifierRecord.feedback, process)
    const structuredArtifactsRecord = verifierRecord.structured_artifacts === undefined
      ? undefined
      : record(verifierRecord.structured_artifacts, 'verifier evidence structured_artifacts')
    if (structuredArtifactsRecord !== undefined) {
      exactFields(structuredArtifactsRecord, ['process', 'feedback'], 'verifier evidence structured_artifacts')
      if (structuredArtifactsRecord.process === undefined && structuredArtifactsRecord.feedback === undefined) {
        throw new HitchEvaluationError('verifier evidence structured_artifacts must not be empty', 'invalid_hitch_result')
      }
    }
    const structuredArtifacts = structuredArtifactsRecord === undefined ? undefined : {
      ...(structuredArtifactsRecord.process === undefined ? {} : {
        process: verifierStructuredArtifact(structuredArtifactsRecord.process, 'process'),
      }),
      ...(structuredArtifactsRecord.feedback === undefined ? {} : {
        feedback: verifierStructuredArtifact(structuredArtifactsRecord.feedback, 'feedback'),
      }),
    }
    if (verifierStatus !== 'corrupt') {
      if ((process !== undefined) !== (scores?.processScore !== undefined)) {
        throw new HitchEvaluationError('verifier process availability does not match process_score', 'invalid_hitch_result')
      }
      if (process !== undefined && Math.abs(process.score - scores!.processScore!) > 1e-12) {
        throw new HitchEvaluationError('verifier process score is inconsistent', 'invalid_hitch_result')
      }
      if ((process !== undefined) !== (structuredArtifacts?.process !== undefined)
        || (feedback !== undefined) !== (structuredArtifacts?.feedback !== undefined)) {
        throw new HitchEvaluationError('verifier structured artifact metadata is incomplete', 'invalid_hitch_result')
      }
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
        ...(scores === undefined ? {} : { scores }),
        ...(process === undefined ? {} : { process }),
        ...(feedback === undefined ? {} : { feedback }),
        ...(structuredArtifacts === undefined ? {} : { structuredArtifacts }),
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
    try {
      this.assertEvaluationRequest(round, request)
      if (reservation !== undefined
        && (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))) {
        throw new TypeError('Hitch evaluation reservation is invalid')
      }
      if (this.daemonMode && reservation === undefined) {
        throw new TypeError('Hitch daemon evaluation requires a durable reservation')
      }
      const args = [
        ...this.rootArgs(),
        ...(this.daemonMode
          ? ['eval', 'watch', (reservation as EvaluationReservation).evalId]
          : ['eval', 'run', ...(reservation === undefined ? [] : ['--eval-id', reservation.evalId]), ...this.evalRequestArgs(round, request)]),
        '--output', 'json',
      ]
      let identity = await this.resolveEvaluationIdentity(round, request, signal)
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
      let inspection: JsonRecord | undefined
      if (this.daemonMode) {
        inspection = await this.inspectEvaluation(
          (reservation as EvaluationReservation).evalId,
          round.workspaceRoot,
          signal,
          'hitch_eval_inspect_failed',
        )
        identity = this.daemonEvaluationIdentity(round, request, inspection, identity)
      }
      const evidence = this.parseResult(parsed, processResult, request, identity, true)
      if (reservation !== undefined
        && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
        throw new HitchEvaluationError('Hitch result does not match the reserved evaluation identity', 'hitch_eval_identity_mismatch')
      }
      inspection ??= await this.inspectEvaluation(
        evidence.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_inspect_failed',
      )
      const benchmark = this.assertCompleteTrialSlots(inspection, evidence, request)
      return { ...evidence, benchmark }
    } catch (error) {
      if (this.daemonMode && reservation !== undefined) {
        try {
          await this.cancelReservation(reservation)
        } catch (cancelError) {
          throw new EvaluationCleanupError(error, cancelError)
        }
      }
      throw error
    }
  }

  async inspectResult(
    round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>, reservation: Readonly<EvaluationReservation>,
    signal: AbortSignal, intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<import('../types.js').EvaluationInspection> {
    this.assertEvaluationRequest(round, request)
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)) throw new TypeError('invalid evaluation reservation')
    const inspection = await this.inspectEvaluation(reservation.evalId, round.workspaceRoot, signal, 'hitch_eval_recovery_inspect_failed',
      intent === undefined ? this.options.root : this.submissionParameters(intent).root)
    const control = inspection.control == null ? undefined : record(inspection.control, 'Hitch eval control')
    if (control && (control.schema_version !== '1' || control.eval_id !== reservation.evalId)) throw new HitchEvaluationError('Hitch eval control identity changed', 'invalid_hitch_result')
    const state = control?.state
    if (['queued', 'planning', 'preparing', 'running', 'finalizing', 'cancelling'].includes(String(state))) return { status: 'running' }
    if (!inspection.result) return ['failed', 'cancelled'].includes(String(state))
      ? { status: 'failed', code: 'hitch_eval_terminal_failure', message: `Evaluation ${reservation.evalId} is ${String(state)}` }
      : { status: 'unknown', reason: 'existing evaluation has no durable result' }
    const result = record(inspection.result, 'Hitch existing eval result')
    if (result.status === 'cancelled' || result.status === 'failed' && (!Array.isArray(result.trials) || result.trials.length === 0)) {
      return { status: 'failed', code: 'hitch_eval_terminal_failure', message: `Evaluation ${reservation.evalId} is ${String(result.status)}` }
    }
    const identity = await this.resolveEvaluationIdentity(round, request, signal)
    const evidence = this.parseResult(result, { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') }, request,
      this.daemonMode ? this.daemonEvaluationIdentity(round, request, inspection, identity) : identity, true)
    if (evidence.evalId !== reservation.evalId) throw new HitchEvaluationError('recovered evaluation identity changed', 'hitch_eval_identity_mismatch')
    return { status: 'complete', evidence: { ...evidence, benchmark: this.assertCompleteTrialSlots(inspection, evidence, request) } }
  }

  prepareRerun(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    _selector: Readonly<EvaluationRerunSelector>,
  ): EvaluationRerunReservation | undefined {
    if (!this.daemonMode) return undefined
    return {
      provider: 'hitch-cli', evalId: attempt.evalId,
      rerunId: `rerun_${randomUUID().replaceAll('-', '')}`,
      parameters: { root: attempt.submissionIntent === undefined ? this.options.root : this.submissionParameters(attempt.submissionIntent).root },
    }
  }

  private rerunRoot(reservation: Readonly<EvaluationRerunReservation>): string {
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)
      || !/^rerun_[0-9a-f]{32}$/u.test(reservation.rerunId)) throw new TypeError('Hitch rerun reservation is invalid')
    const parameters = record(reservation.parameters, 'Hitch rerun parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch rerun root is invalid')
    return parameters.root
  }

  async cancelRerun(reservation: Readonly<EvaluationRerunReservation>): Promise<void> {
    const root = this.rerunRoot(reservation)
    const result = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]),
      'eval', 'rerun-cancel', reservation.evalId, reservation.rerunId,
    ], this.repositoryPath, AbortSignal.timeout(30_000), 64 * 1024)
    if (result.exitCode !== 0) throw new HitchEvaluationError(`Hitch rerun cancellation failed: ${result.stderr.slice(-4000)}`, 'hitch_rerun_cancel_failed')
    const cancelled = record(JSON.parse(result.stdout), 'Hitch rerun cancellation')
    if (cancelled.schema_version !== '1' || cancelled.eval_id !== reservation.evalId || cancelled.rerun_id !== reservation.rerunId
      || !['cancelled', 'completed', 'failed'].includes(cancelled.status as string)) {
      throw new HitchEvaluationError('Hitch rerun cancellation did not confirm a stopped operation', 'hitch_rerun_cancel_failed')
    }
  }

  async rerun(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationRerunReservation>,
  ): Promise<EvaluationRerunResult> {
    if (attempt.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId)) {
      throw new TypeError('Hitch evaluation rerun requires an owned Hitch eval id')
    }
    if (attempt.phase !== request.phase || attempt.dataset !== request.dataset
      || attempt.conditionId !== request.condition.conditionId || attempt.requestedCommit !== request.harnessRef
      || attempt.requestedModelId !== request.condition.model) {
      throw new TypeError('Hitch evaluation rerun request does not match the original attempt')
    }
    if (this.daemonMode && reservation === undefined) throw new TypeError('Hitch daemon rerun requires a persisted rerun reservation')
    const root = reservation === undefined ? this.options.root : this.rerunRoot(reservation)
    if (reservation !== undefined && reservation.evalId !== attempt.evalId) throw new TypeError('Hitch rerun reservation does not match its source eval')
    try {
      const identity = await this.resolveEvaluationIdentity(round, request, signal)
      const args = [
        ...(root.length === 0 ? [] : ['--root', root]),
        'eval', 'rerun', attempt.evalId,
        ...(selector.mode === 'invalid'
          ? ['--invalid']
          : selector.taskNames.flatMap(task => ['--task', task])),
        '--type', 'candidate-restart',
        ...(reservation === undefined ? [] : ['--daemon', '--rerun-id', reservation.rerunId]),
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
        || (reservation !== undefined && envelope.rerun_id !== reservation.rerunId)
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
        root,
      )
      const result = record(inspection.result, 'Hitch repaired eval result')
      const evidence = this.parseResult(
        result,
        { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
        request,
        this.daemonMode ? this.daemonEvaluationIdentity(round, request, inspection, identity) : identity,
        true,
      )
      if (evidence.evalId !== attempt.evalId) throw new HitchEvaluationError('repaired evidence eval id changed', 'hitch_eval_identity_mismatch')
      if ((envelope.eval_status === 'succeeded') !== (evidence.completeness === 'complete')) {
        throw new HitchEvaluationError('Hitch rerun status does not match repaired evidence completeness', 'invalid_hitch_result')
      }
      const benchmark = this.assertCompleteTrialSlots(inspection, evidence, request)
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
        evidence: { ...evidence, benchmark },
      }
    } catch (error) {
      if (reservation !== undefined) {
        try { await this.cancelRerun(reservation) }
        catch (cleanupError) { throw new EvaluationCleanupError(error, cleanupError) }
      }
      throw error
    }
  }

  private async inspectEvaluation(
    evalId: string,
    cwd: string,
    signal: AbortSignal,
    failureCode: string,
    root = this.options.root,
  ): Promise<JsonRecord> {
    const inspect = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]),
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

  private async cancelDaemonEvaluation(evalId: string, cwd: string, root: string): Promise<void> {
    const result = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]), 'eval', 'cancel', evalId,
    ], cwd, AbortSignal.timeout(Math.max(5_000, this.options.terminationGraceMs)), 64 * 1024)
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch could not cancel daemon eval ${evalId}: ${result.stderr.slice(-4000)}`, 'hitch_eval_cancel_failed')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid eval cancellation JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const cancelled = record(parsed, 'Hitch eval cancellation')
    if (cancelled.schema_version !== '1' || cancelled.eval_id !== evalId
      || !new Set(['cancelling', 'cancelled', 'succeeded', 'failed']).has(cancelled.status as string)) {
      throw new HitchEvaluationError('Hitch eval cancellation identity/status is invalid', 'invalid_hitch_result')
    }
  }

  private daemonEvaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    inspection: JsonRecord,
    identity: HitchEvaluationIdentity,
  ): HitchEvaluationIdentity {
    const evalId = string(inspection.eval_id, 'Hitch eval inspection eval_id')
    const submission = record(inspection.submission, 'Hitch eval submission record')
    if (submission.schema_version !== '1' || submission.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch eval submission identity is invalid', 'invalid_hitch_result')
    }
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    const submittedRequest = record(submission.request, 'Hitch eval submitted request')
    if (!isDeepStrictEqual(submittedRequest, inspectedRequest)) {
      throw new HitchEvaluationError('Hitch submitted request differs from the eval request', 'invalid_hitch_result')
    }
    const idempotencyKeyHash = string(submission.idempotency_key_hash, 'Hitch eval idempotency key hash')
    if (idempotencyKeyHash !== sha256(this.daemonIdempotencyKey(round, request))) {
      throw new HitchEvaluationError('Hitch eval idempotency identity differs from the Gear reservation', 'invalid_hitch_result')
    }
    const execution = this.assertDaemonExecutionPolicy(submission.execution)
    const submissionDigest = string(submission.submission_digest, 'Hitch eval submission digest')
    if (submissionDigest !== digestJson({ request: submittedRequest, execution })) {
      throw new HitchEvaluationError('Hitch eval submission digest does not match its frozen request and execution policy', 'invalid_hitch_result')
    }
    const submittedAt = string(submission.submitted_at, 'Hitch eval submission timestamp')
    if (!Number.isFinite(Date.parse(submittedAt))) {
      throw new HitchEvaluationError('Hitch eval submission timestamp is invalid', 'invalid_hitch_result')
    }
    const effectiveConfigDigest = digestJson({
      effectiveConfigDigest: identity.effectiveConfigDigest,
      executionMode: 'daemon',
      execution,
    })
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint: this.daemonInvocationFingerprint(effectiveConfigDigest, identity.invocationFingerprint),
    }
  }

  private assertDaemonExecutionPolicy(value: unknown): JsonRecord {
    const execution = record(value, 'Hitch eval execution policy')
    const provider = string(execution.provider, 'Hitch eval execution policy provider')
    const maxParallelism = integer(execution.max_parallelism, 'Hitch eval execution policy max_parallelism')
    if (maxParallelism !== this.options.maxConcurrent) {
      throw new HitchEvaluationError('Hitch eval execution parallelism differs from the Gear condition', 'invalid_hitch_result')
    }
    if (this.controlPlane.provider !== undefined && provider !== this.controlPlane.provider) {
      throw new HitchEvaluationError('Hitch eval execution provider differs from Gear configuration', 'invalid_hitch_result')
    }
    const resources = record(execution.resources, 'Hitch eval execution resources')
    const trial = this.parseResourceVector(resources.default_trial, 'Hitch eval default trial resources')
    if (this.controlPlane.cpuPerTrial !== undefined
      && trial.cpu_millis !== this.controlPlane.cpuPerTrial * 1_000) {
      throw new HitchEvaluationError('Hitch eval CPU reservation differs from Gear configuration', 'invalid_hitch_result')
    }
    if (this.controlPlane.memoryPerTrial !== undefined
      && trial.memory_bytes !== memorySizeBytes(this.controlPlane.memoryPerTrial)) {
      throw new HitchEvaluationError('Hitch eval memory reservation differs from Gear configuration', 'invalid_hitch_result')
    }
    if (resources.setup !== undefined) this.parseResourceVector(resources.setup, 'Hitch eval setup resources')
    const build = record(execution.build, 'Hitch eval build policy')
    const buildMode = string(build.mode, 'Hitch eval build mode')
    if (!new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(buildMode)
      || (this.controlPlane.buildMode !== undefined && buildMode !== this.controlPlane.buildMode)) {
      throw new HitchEvaluationError('Hitch eval build policy differs from Gear configuration', 'invalid_hitch_result')
    }
    const capture = record(execution.model_capture, 'Hitch eval model capture policy')
    const captureMode = string(capture.mode, 'Hitch eval model capture mode')
    if (!new Set(['off', 'native', 'proxy', 'hybrid']).has(captureMode)
      || typeof capture.required !== 'boolean'
      || (this.controlPlane.modelCapture !== undefined && captureMode !== this.controlPlane.modelCapture)
      || capture.required !== this.controlPlane.requireModelCapture) {
      throw new HitchEvaluationError('Hitch eval model capture policy differs from Gear configuration', 'invalid_hitch_result')
    }
    return execution
  }

  private assertCompleteTrialSlots(
    inspection: JsonRecord,
    evidence: HitchEvaluationEvidence,
    request: Readonly<EvaluationRequest>,
  ): { id: string; revision: string } {
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
    const stableAttemptExecution = attemptExecution === 'harbor-attempt-shards-v1'
      || attemptExecution === 'harbor-task-slots-v1'
    if ((attemptExecution !== undefined && !stableAttemptExecution)
      || (attempts > 1 && !stableAttemptExecution)) {
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
    return { id: benchmarkId, revision: benchmarkRevision }
  }

  private effectiveConfigDigest(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): string {
    return sha256(JSON.stringify({
      provider: 'hitch-cli',
      // Evidence collected before this contract lacks benchmark identity and
      // cannot be paired with current scores, even for legacy datasets.
      scoringContract: 'benchmark-scores-v1',
      conditionId: request.condition.conditionId,
      backend: 'harbor',
      harnessId: this.options.harnessId,
      sandboxProfileRef: round.sandboxProfileRef,
    }))
  }

  private invocationFingerprint(effectiveConfigDigest: string, hitchRuntimeIdentity: string): string {
    return sha256(JSON.stringify({
      effectiveConfigDigest,
      hitchRuntimeIdentity,
      maxConcurrent: this.options.maxConcurrent,
      setupTimeoutMs: this.options.setupTimeoutMs,
      terminationGraceMs: this.options.terminationGraceMs,
      maxOutputBytes: this.options.maxOutputBytes,
      maxTrajectoryOutputBytes: this.options.maxTrajectoryOutputBytes,
      maxTrajectoryAnalysisBytes: this.options.maxTrajectoryAnalysisBytes ?? 16 * 1024 * 1024,
      maxTrajectoryEventsBytes: this.options.maxTrajectoryEventsBytes ?? 4 * 1024 * 1024,
    }))
  }

  private daemonInvocationFingerprint(effectiveConfigDigest: string, directInvocationFingerprint: string): string {
    return sha256(JSON.stringify({ effectiveConfigDigest, directInvocationFingerprint }))
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
      && result.trials.length > 0
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
    const processScores = trials.flatMap(trial => trial.scores?.processScore === undefined ? [] : [trial.scores.processScore])
    const processScore = processScores.length === trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
    const summary: ScoreSummary = {
      total,
      passed,
      failed: total - passed,
      score: primaryReward,
      metrics: { primaryReward, totalScore: primaryReward, ...(processScore === undefined ? {} : { processScore }) },
      ...(processScore === undefined ? {} : { process: { score: processScore } }),
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
      ...(processScore === undefined ? {} : { processScore }),
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
      rewards: {
        reward: trial.reward!,
        total_score: trial.scores?.totalScore ?? trial.reward!,
        ...(trial.scores?.processScore === undefined ? {} : { process_score: trial.scores.processScore }),
      },
      scores: trial.scores ?? { totalScore: trial.reward!, normalization: 'legacy-reward' },
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
      : trials.reduce((sum, trial) => sum + trial.scores!.totalScore, 0) / trials.length
    if (trials.length > 0) {
      const reportedPrimaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
      if (Math.abs(reportedPrimaryReward - primaryReward) > 1e-12) {
        throw new HitchEvaluationError('Hitch primary reward does not match valid run observations', 'invalid_hitch_result')
      }
    }
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const processScores = trials.flatMap(trial => trial.scores?.processScore === undefined ? [] : [trial.scores.processScore])
    const processScore = processScores.length === trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
    const summary: ScoreSummary = {
      total: trials.length,
      passed,
      failed: trials.length - passed,
      score: primaryReward,
      metrics: { primaryReward, totalScore: primaryReward, ...(processScore === undefined ? {} : { processScore }) },
      ...(processScore === undefined ? {} : { process: { score: processScore } }),
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
      ...(processScore === undefined ? {} : { processScore }),
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
      const scores = observation === 'valid'
        ? (trial.scores === undefined
            ? { totalScore: reward!, normalization: 'legacy-reward' as const }
            : evaluationTrialScores(trial.scores, `trials[${index}].scores`))
        : undefined
      if (scores !== undefined && scores.totalScore !== reward) {
        throw new HitchEvaluationError(`trials[${index}].scores.total_score does not match reward`, 'invalid_hitch_result')
      }
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
        ...(scores === undefined ? {} : { scores }),
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
      const totalScore = rewards.total_score ?? rewardForTrial(rewards)
      if (totalScore === undefined || rewards.reward !== undefined && Math.abs(rewards.reward - totalScore) > 1e-12) {
        throw new HitchEvaluationError(`summary.trials[${index}] total score is invalid`, 'invalid_hitch_result')
      }
      const scores: EvaluationTrialScores = {
        totalScore,
        ...(rewards.process_score === undefined ? {} : { processScore: rewards.process_score }),
        normalization: rewards.total_score === undefined ? 'legacy-reward' : 'standard',
      }
      return { taskName, ...(trialName === undefined ? {} : { trialName }), status: 'completed', rewards, scores }
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
        env: {
          ...process.env,
          // Hitch controller runtimes are immutable; their Python bridge must not write .pyc files.
          PYTHONDONTWRITEBYTECODE: '1',
        },
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
          terminate()
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
        if (killTimer !== undefined) return
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
