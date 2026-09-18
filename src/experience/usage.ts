import { createHash } from 'node:crypto'
import { load as loadYaml } from 'js-yaml'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { digestJson } from '../state/digest.js'
import type {
  HarnessManifest,
  SeedExperienceArtifactUse,
  SeedExperienceChangedArtifact,
  SeedExperienceModificationUse,
  SeedExperienceRecord,
  SeedExperienceTrialUse,
  SeedExperienceUseActionEvidence,
  SeedExperienceUseConditionedResult,
  SeedExperienceUseStatus,
} from '../types.js'

export const EXPERIENCE_USE_EXTRACTOR_VERSION = 'gear-experience-use-v1' as const
export const EXPERIENCE_USE_MAX_ACTION_EXAMPLES = 4
export const EXPERIENCE_USE_MAX_TRIAL_ACTION_EXAMPLES = 16

type JsonRecord = Record<string, unknown>

export interface ExperienceArtifactReader {
  readManifest(ref: string): Promise<HarnessManifest>
  readHarnessFile(ref: string, path: string): Promise<{ content: string; digest: string; bytes: number }>
}

export interface ExperienceChangedArtifactInput {
  identity: SeedExperienceChangedArtifact
  candidateContent?: string
}

export interface ExperienceUsageTraceFile {
  sourcePath: string
  sourceDigest: string
  bytes: number
  sessionId: string
  parentSessionId?: string
  delegationDepth: number
  /** Only event kinds used by the exact evidence matchers are retained. */
  events: JsonValue[]
}

export interface ExperienceUsageTrace {
  schemaVersion: 1
  kind: 'dsh-native-events'
  runId: string
  trajectoryManifestDigest: string
  listedFiles: number
  mainSessionFiles: number
  childSessionFiles: number
  coverage: 'listed-files-complete' | 'partial'
  reason?: ExperienceUsageUnavailableReason
  files: ExperienceUsageTraceFile[]
}

export type ExperienceUsageUnavailableReason =
  | 'reader-unavailable'
  | 'run-id-missing'
  | 'snapshot-run-limit'
  | 'snapshot-byte-limit'
  | 'trajectory-manifest-unavailable'
  | 'trajectory-manifest-invalid'
  | 'native-source-unavailable'
  | 'native-source-invalid'
  | 'native-source-byte-limit'
  | 'native-source-digest-mismatch'
  | 'native-source-parse-failed'

export type ExperienceUsageReadResult =
  | { available: true; trace: ExperienceUsageTrace }
  | {
      available: false
      runId: string
      reason: ExperienceUsageUnavailableReason
      trajectoryManifestDigest?: string
      mainSessionFiles?: number
      childSessionFiles?: number
      listedFiles?: number
      verifiedFiles?: number
      verifiedBytes?: number
    }

export interface ExperienceUsageReader {
  readRuns(runIds: readonly string[], signal: AbortSignal): Promise<Map<string, ExperienceUsageReadResult>>
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function skillName(path: string): string | undefined {
  return path.match(/^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/u)?.[1]
}

/** Mirrors the installed DSH filesystem skill provider's frontmatter/body split. */
export function runtimeSkillBody(content: string, expectedName: string): string | undefined {
  const firstLineEnd = content.indexOf('\n')
  if (firstLineEnd < 0 || content.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  let frontmatterEnd: number | undefined
  let bodyStart: number | undefined
  while (lineStart <= content.length) {
    const nextNewline = content.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? content.length : nextNewline
    if (content.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      frontmatterEnd = lineStart
      bodyStart = nextNewline < 0 ? content.length : nextNewline + 1
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (frontmatterEnd === undefined || bodyStart === undefined) return undefined
  let data: unknown
  try { data = loadYaml(content.slice(firstLineEnd + 1, frontmatterEnd)) }
  catch { return undefined }
  if (record(data)?.name !== expectedName) return undefined
  return content.slice(bodyStart).trim()
}

function skillContentBody(value: string, expectedName: string): string | undefined {
  const escaped = expectedName.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const prefix = `<skill_content name="${escaped}">\n<skill_resources>\n`
  const resourceEnd = '\n</skill_resources>'
  const suffix = '\n</skill_instructions>\n</skill_content>'
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined
  const resourceEndAt = value.indexOf(resourceEnd, prefix.length)
  if (resourceEndAt < 0) return undefined
  const afterResources = value.slice(resourceEndAt + resourceEnd.length)
  const instructionStart = afterResources.match(/^(?:\r?\n)+<skill_instructions>\r?\n/u)?.[0]
  if (instructionStart === undefined) return undefined
  const bodyStart = resourceEndAt + resourceEnd.length + instructionStart.length
  return value.slice(bodyStart, -suffix.length)
}

function textLeaves(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || value === undefined) return output
  if (typeof value === 'string') { output.push(value); return output }
  if (Array.isArray(value)) {
    for (const item of value) textLeaves(item, output, depth + 1)
    return output
  }
  const item = record(value)
  if (item === undefined) return output
  for (const child of Object.values(item)) textLeaves(child, output, depth + 1)
  return output
}

function eventData(value: JsonValue): JsonRecord {
  return record(record(value)?.data) ?? {}
}

function eventType(value: JsonValue): string | undefined {
  const type = record(value)?.type
  return typeof type === 'string' ? type : undefined
}

function eventSeq(value: JsonValue): number | undefined {
  const seq = record(value)?.seq
  return Number.isSafeInteger(seq) ? seq as number : undefined
}

function parsedArguments(value: unknown): JsonRecord | undefined {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) }
    catch { return undefined }
  }
  return record(parsed)
}

function exactArtifactPath(value: string, path: string): boolean {
  if (value === path) return true
  return [
    `/candidate/harness/${path}`,
    `/opt/hitch-harness-artifact/source/harness/${path}`,
  ].includes(value)
}

function argumentPaths(args: JsonRecord | undefined): string[] {
  if (args === undefined) return []
  const values: string[] = []
  for (const key of ['path', 'filePath', 'file_path'] as const) {
    if (typeof args[key] === 'string') values.push(args[key] as string)
  }
  return uniqueSorted(values)
}

function sourceFor(
  file: ExperienceUsageTraceFile,
  action: SeedExperienceUseActionEvidence['action'],
  outcome: SeedExperienceUseActionEvidence['outcome'],
  match: SeedExperienceUseActionEvidence['match'],
  values: Partial<Pick<SeedExperienceUseActionEvidence, 'callSeq' | 'resultSeq' | 'callId' | 'toolName'>>,
): SeedExperienceUseActionEvidence {
  return {
    action,
    outcome,
    sessionId: file.sessionId,
    delegationDepth: file.delegationDepth,
    sourcePath: file.sourcePath,
    sourceDigest: file.sourceDigest,
    ...values,
    match,
  }
}

interface MatchedToolResult {
  event: JsonValue
  content: unknown
  isError: boolean
}

function toolResultsByCallId(events: readonly JsonValue[]): Map<string, MatchedToolResult> {
  const output = new Map<string, MatchedToolResult>()
  for (const event of events) {
    if (eventType(event) !== 'tool/result') continue
    const message = record(eventData(event).message)
    const source = record(message?.source)
    const callId = source?.kind === 'tool' && typeof source.callId === 'string' ? source.callId : undefined
    if (callId === undefined || !Array.isArray(message?.content)) continue
    const result = message.content.map(record).find(item => item?.type === 'tool-result'
      && item.toolCallId === callId)
    if (result === undefined) continue
    if (!output.has(callId)) output.set(callId, {
      event,
      content: result.content,
      isError: result.isError === true,
    })
  }
  return output
}

function matchingInjection(
  file: ExperienceUsageTraceFile,
  artifact: ExperienceChangedArtifactInput,
  expectedSkillName: string | undefined,
  expectedSkillBody: string | undefined,
): SeedExperienceUseActionEvidence[] {
  if (artifact.candidateContent === undefined) return []
  const actions: SeedExperienceUseActionEvidence[] = []
  for (const event of file.events) {
    const type = eventType(event)
    const data = eventData(event)
    const seq = eventSeq(event)
    if (type === 'user/message' && expectedSkillName !== undefined && expectedSkillBody !== undefined) {
      const source = record(data.source)
      if (source?.kind !== 'skill-invocation' || source.name !== expectedSkillName) continue
      if (!textLeaves(data.content).some(value => skillContentBody(value, expectedSkillName) === expectedSkillBody)) continue
      actions.push(sourceFor(file, 'injected', 'completed', 'skill-name-and-body', {
        ...(seq === undefined ? {} : { callSeq: seq }),
      }))
      continue
    }
    if (type !== 'request/header') continue
    const system = record(data.header)?.system
    if (!textLeaves(system).some(value => sha256(value) === artifact.identity.candidateDigest
      && value === artifact.candidateContent)) continue
    actions.push(sourceFor(file, 'injected', 'completed', 'artifact-content', {
      ...(seq === undefined ? {} : { callSeq: seq }),
    }))
  }
  return actions
}

function artifactUseFromTrace(
  artifact: ExperienceChangedArtifactInput,
  trace: ExperienceUsageTrace,
  resultIndexes: ReadonlyMap<ExperienceUsageTraceFile, ReadonlyMap<string, MatchedToolResult>>,
): SeedExperienceArtifactUse {
  const name = skillName(artifact.identity.path)
  const body = name === undefined || artifact.candidateContent === undefined
    ? undefined
    : runtimeSkillBody(artifact.candidateContent, name)
  const actions: SeedExperienceUseActionEvidence[] = []
  let uncertainMatch = false

  for (const file of trace.files) {
    const resultIndex = resultIndexes.get(file) ?? new Map()
    actions.push(...matchingInjection(file, artifact, name, body))
    for (const event of file.events) {
      if (eventType(event) !== 'tool/call') continue
      const data = eventData(event)
      const toolName = typeof data.name === 'string' ? data.name : undefined
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const callSeq = eventSeq(event)
      const args = parsedArguments(data.arguments)
      if (name !== undefined && toolName === 'skill' && args?.name === name) {
        const result = callId === undefined ? undefined : resultIndex.get(callId)
        const resultSeq = result === undefined ? undefined : eventSeq(result.event)
        const common = {
          ...(callSeq === undefined ? {} : { callSeq }),
          ...(resultSeq === undefined ? {} : { resultSeq }),
          ...(callId === undefined ? {} : { callId }),
          toolName,
        }
        if (result === undefined) { uncertainMatch = true; continue }
        if (callSeq !== undefined && (resultSeq ?? -1) <= callSeq) { uncertainMatch = true; continue }
        if (result.isError) {
          actions.push(sourceFor(file, 'read', 'errored', 'skill-name-attempt', common))
          continue
        }
        const matchedBody = body !== undefined && textLeaves(result.content)
          .some(value => skillContentBody(value, name) === body)
        if (matchedBody) actions.push(sourceFor(file, 'read', 'completed', 'skill-name-and-body', common))
        else uncertainMatch = true
        continue
      }

      if (toolName !== 'read' && toolName !== 'read_file' && toolName !== 'fs.read') continue
      if (!argumentPaths(args).some(value => exactArtifactPath(value, artifact.identity.path))) continue
      const result = callId === undefined ? undefined : resultIndex.get(callId)
      const resultSeq = result === undefined ? undefined : eventSeq(result.event)
      const common = {
        ...(callSeq === undefined ? {} : { callSeq }),
        ...(resultSeq === undefined ? {} : { resultSeq }),
        ...(callId === undefined ? {} : { callId }),
        toolName,
      }
      if (result === undefined) { uncertainMatch = true; continue }
      if (callSeq !== undefined && (resultSeq ?? -1) <= callSeq) { uncertainMatch = true; continue }
      if (result.isError) {
        actions.push(sourceFor(file, 'read', 'errored', 'artifact-path-attempt', common))
        continue
      }
      const matchedContent = artifact.candidateContent !== undefined
        && textLeaves(result.content).some(value => value === artifact.candidateContent)
      if (matchedContent) actions.push(sourceFor(file, 'read', 'completed', 'artifact-path-and-content', common))
      else uncertainMatch = true
    }
  }

  actions.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)
    || left.sessionId.localeCompare(right.sessionId)
    || (left.callSeq ?? -1) - (right.callSeq ?? -1)
    || left.action.localeCompare(right.action))
  const observedActionCount = actions.filter(action => action.outcome === 'completed').length
  const failedActionCount = actions.filter(action => action.outcome === 'errored').length
  const removed = artifact.identity.candidateDigest === undefined
  const supportedNegative = trace.coverage === 'listed-files-complete'
    && name !== undefined && !removed && body !== undefined
  const status: SeedExperienceUseStatus = observedActionCount > 0
    ? 'observed'
    : failedActionCount > 0
      ? 'attempted-failure'
      : uncertainMatch
        ? 'unknown'
        : supportedNegative
          ? 'not-observed'
          : 'unknown'
  return {
    path: artifact.identity.path,
    status,
    observedActionCount,
    failedActionCount,
    ...(status !== 'unknown' ? {} : {
      reason: removed
        ? 'removed-artifact' as const
        : uncertainMatch || name !== undefined || trace.coverage === 'partial'
          ? 'unverified-content' as const
          : 'unsupported-artifact' as const,
    }),
    actions: actions.slice(0, EXPERIENCE_USE_MAX_ACTION_EXAMPLES),
  }
}

function overallStatus(artifacts: readonly SeedExperienceArtifactUse[]): SeedExperienceUseStatus {
  if (artifacts.some(item => item.status === 'observed')) return 'observed'
  if (artifacts.some(item => item.status === 'attempted-failure')) return 'attempted-failure'
  if (artifacts.some(item => item.status === 'unknown')) return 'unknown'
  return 'not-observed'
}

function unavailableTrialUse(
  artifacts: readonly ExperienceChangedArtifactInput[],
  runId: string | undefined,
  result: Extract<ExperienceUsageReadResult, { available: false }> | undefined,
  reason: ExperienceUsageUnavailableReason,
): SeedExperienceTrialUse {
  return {
    status: 'unknown',
    artifacts: artifacts.map(artifact => ({
      path: artifact.identity.path,
      status: 'unknown',
      observedActionCount: 0,
      failedActionCount: 0,
      reason: artifact.identity.change === 'deleted'
        ? 'removed-artifact'
        : artifact.candidateContent === undefined
          ? 'unverified-content'
          : 'source-unavailable',
      actions: [],
    })),
    source: {
      extractorVersion: EXPERIENCE_USE_EXTRACTOR_VERSION,
      kind: 'unavailable',
      ...(runId === undefined ? {} : { runId }),
      ...(result?.trajectoryManifestDigest === undefined ? {} : {
        trajectoryManifestDigest: result.trajectoryManifestDigest,
      }),
      mainSessionFiles: result?.mainSessionFiles ?? 0,
      childSessionFiles: result?.childSessionFiles ?? 0,
      listedFiles: result?.listedFiles ?? 0,
      verifiedFiles: result?.verifiedFiles ?? 0,
      verifiedBytes: result?.verifiedBytes ?? 0,
      coverage: result === undefined || (result.verifiedFiles ?? 0) === 0 ? 'unavailable' : 'partial',
      reason,
    },
  }
}

export function extractTrialModificationUse(
  artifacts: readonly ExperienceChangedArtifactInput[],
  runId: string | undefined,
  result: ExperienceUsageReadResult | undefined,
): SeedExperienceTrialUse {
  if (runId === undefined) return unavailableTrialUse(artifacts, undefined, undefined, 'run-id-missing')
  if (result === undefined) return unavailableTrialUse(artifacts, runId, undefined, 'reader-unavailable')
  if (!result.available) return unavailableTrialUse(artifacts, runId, result, result.reason)
  if (result.trace.runId !== runId) return unavailableTrialUse(artifacts, runId, undefined, 'native-source-invalid')
  const resultIndexes = new Map(result.trace.files.map(file => [file, toolResultsByCallId(file.events)]))
  let remainingExamples = EXPERIENCE_USE_MAX_TRIAL_ACTION_EXAMPLES
  const artifactUses = artifacts.map(artifact => {
    const use = artifactUseFromTrace(artifact, result.trace, resultIndexes)
    const actions = use.actions.slice(0, remainingExamples)
    remainingExamples -= actions.length
    return { ...use, actions }
  })
  return {
    status: overallStatus(artifactUses),
    artifacts: artifactUses,
    source: {
      extractorVersion: EXPERIENCE_USE_EXTRACTOR_VERSION,
      kind: 'dsh-native-events',
      runId,
      trajectoryManifestDigest: result.trace.trajectoryManifestDigest,
      mainSessionFiles: result.trace.mainSessionFiles,
      childSessionFiles: result.trace.childSessionFiles,
      listedFiles: result.trace.listedFiles,
      verifiedFiles: result.trace.files.length,
      verifiedBytes: result.trace.files.reduce((sum, file) => sum + file.bytes, 0),
      coverage: result.trace.coverage,
      ...(result.trace.reason === undefined ? {} : { reason: result.trace.reason }),
    },
  }
}

export async function resolveExperienceChangedArtifacts(
  experience: Readonly<SeedExperienceRecord>,
  reader: ExperienceArtifactReader,
): Promise<ExperienceChangedArtifactInput[]> {
  const [parent, candidate] = await Promise.all([
    reader.readManifest(experience.source.parentHarnessRef),
    reader.readManifest(experience.source.candidateHarnessRef),
  ])
  const parentByPath = new Map(parent.artifacts.map(artifact => [artifact.path, artifact]))
  const candidateByPath = new Map(candidate.artifacts.map(artifact => [artifact.path, artifact]))
  const output: ExperienceChangedArtifactInput[] = []
  for (const changed of experience.change.files) {
    const before = parentByPath.get(changed.path)
    const after = candidateByPath.get(changed.path)
    if ((changed.change === 'created' && (before !== undefined || after === undefined))
      || (changed.change === 'modified' && (before === undefined || after === undefined || before.digest === after.digest))
      || (changed.change === 'deleted' && (before === undefined || after !== undefined))) {
      throw new Error(`changed artifact identity is inconsistent for ${changed.path}`)
    }
    let candidateContent: string | undefined
    if (after !== undefined) {
      const file = await reader.readHarnessFile(experience.source.candidateHarnessRef, changed.path)
      if (file.digest !== after.digest || file.bytes !== after.bytes) {
        throw new Error(`changed artifact content is inconsistent for ${changed.path}`)
      }
      candidateContent = file.content
    }
    output.push({
      identity: {
        path: changed.path,
        change: changed.change,
        ...(before === undefined ? {} : { parentDigest: before.digest }),
        ...(after === undefined ? {} : { candidateDigest: after.digest }),
      },
      ...(candidateContent === undefined ? {} : { candidateContent }),
    })
  }
  return output.sort((left, right) => left.identity.path.localeCompare(right.identity.path))
}

export function experienceCandidateRunIds(experience: Readonly<SeedExperienceRecord>): string[] {
  return uniqueSorted([
    ...experience.observation.taskResults,
    ...experience.observation.excludedTaskResults,
  ].flatMap(item => item.candidate.runId === undefined ? [] : [item.candidate.runId]))
}

function emptyStatusCounts(): Record<SeedExperienceUseStatus, number> {
  return { observed: 0, 'attempted-failure': 0, 'not-observed': 0, unknown: 0 }
}

function conditioned(
  status: SeedExperienceUseStatus,
  results: readonly SeedExperienceRecord['observation']['taskResults'][number][],
): SeedExperienceUseConditionedResult {
  const matching = results.filter(item => item.candidate.modificationUse?.status === status)
  if (matching.length === 0) return { status, validPairs: 0, taskCount: 0 }
  return {
    status,
    validPairs: matching.length,
    taskCount: new Set(matching.map(item => item.taskName)).size,
    baselineMean: matching.reduce((sum, item) => sum + item.baseline.reward, 0) / matching.length,
    candidateMean: matching.reduce((sum, item) => sum + item.candidate.reward, 0) / matching.length,
    meanRewardDelta: matching.reduce((sum, item) => sum + item.rewardDelta, 0) / matching.length,
  }
}

function projectionOf(recordValue: Omit<SeedExperienceRecord, 'recordDigest'>): Record<string, unknown> {
  return {
    source: recordValue.source,
    applicability: recordValue.applicability,
    proposal: recordValue.proposal,
    change: recordValue.change,
    observation: recordValue.observation,
  }
}

/** Digest of the immutable seed outcome before optional use observation was derived. */
export function seedExperienceUseBaseDigest(experience: Readonly<SeedExperienceRecord>): string {
  const withoutTrialUse = <T extends SeedExperienceRecord['observation']['taskResults'][number]
    | SeedExperienceRecord['observation']['excludedTaskResults'][number]>(item: T): T => {
    const { modificationUse: _modificationUse, ...candidate } = item.candidate
    return { ...item, baseline: { ...item.baseline }, candidate } as T
  }
  const { modificationUse: _modificationUse, ...observation } = experience.observation
  return digestJson({
    source: experience.source,
    applicability: experience.applicability,
    proposal: experience.proposal,
    change: experience.change,
    observation: {
      ...observation,
      taskResults: observation.taskResults.map(withoutTrialUse),
      excludedTaskResults: observation.excludedTaskResults.map(withoutTrialUse),
    },
  })
}

/** Only complete verified observations are safe to reuse instead of retrying source reads. */
export function isReusableSeedExperienceUse(experience: Readonly<SeedExperienceRecord>): boolean {
  const use = experience.observation.modificationUse
  if (use?.extractorVersion !== EXPERIENCE_USE_EXTRACTOR_VERSION) return false
  const trials = [...experience.observation.taskResults, ...experience.observation.excludedTaskResults]
  return trials.length > 0 && trials.length === use.candidateTrials
    && trials.every(item => item.candidate.modificationUse?.source.extractorVersion === EXPERIENCE_USE_EXTRACTOR_VERSION
      && item.candidate.modificationUse.source.coverage === 'listed-files-complete')
}

export function enrichSeedExperienceUse(
  experience: Readonly<SeedExperienceRecord>,
  artifacts: readonly ExperienceChangedArtifactInput[],
  reads: ReadonlyMap<string, ExperienceUsageReadResult>,
): SeedExperienceRecord {
  const annotate = <T extends SeedExperienceRecord['observation']['taskResults'][number]
    | SeedExperienceRecord['observation']['excludedTaskResults'][number]>(item: T): T => ({
      ...item,
      baseline: { ...item.baseline },
      candidate: {
        ...item.candidate,
        modificationUse: extractTrialModificationUse(
          artifacts,
          item.candidate.runId,
          item.candidate.runId === undefined ? undefined : reads.get(item.candidate.runId),
        ),
      },
    })
  const taskResults = experience.observation.taskResults.map(annotate)
  const excludedTaskResults = experience.observation.excludedTaskResults.map(annotate)
  const all = [...taskResults, ...excludedTaskResults]
  const statusCounts = emptyStatusCounts()
  const validPairStatusCounts = emptyStatusCounts()
  for (const item of all) statusCounts[item.candidate.modificationUse!.status] += 1
  for (const item of taskResults) validPairStatusCounts[item.candidate.modificationUse!.status] += 1
  const statuses: SeedExperienceUseStatus[] = ['observed', 'attempted-failure', 'not-observed', 'unknown']
  const modificationUse: SeedExperienceModificationUse = {
    schemaVersion: 1,
    extractorVersion: EXPERIENCE_USE_EXTRACTOR_VERSION,
    artifacts: artifacts.map(item => ({ ...item.identity })),
    candidateTrials: all.length,
    statusCounts,
    validPairStatusCounts,
    conditionedResults: statuses.map(status => conditioned(status, taskResults)),
  }
  const { recordDigest: _recordDigest, ...currentBase } = experience
  const base: Omit<SeedExperienceRecord, 'recordDigest'> = {
    ...currentBase,
    seedProjectionDigest: '',
    observation: {
      ...experience.observation,
      taskResults,
      excludedTaskResults,
      modificationUse,
    },
  }
  base.seedProjectionDigest = digestJson(projectionOf(base))
  return { ...base, recordDigest: digestJson(base) }
}
