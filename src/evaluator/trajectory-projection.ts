import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  ContentExcerpt,
  HitchTrajectoryAnalysis,
  HitchTrajectoryContentExcerpt,
  HitchTrajectorySurfaceNode,
  TrajectoryContextEpoch,
  TrajectoryMessageEvidence,
  TrajectoryModelRequestEvidence,
  TrajectoryProjection,
  TrajectorySemanticStep,
  TrajectoryToolAction,
} from '../types.js'

type JsonRecord = Record<string, unknown>

interface MutableStep {
  id: string
  turn: number
  step: number
  seqStart: number
  seqEnd: number
  contextEpochId?: string
  contextEpochIds: string[]
  assistantMessages: TrajectoryMessageEvidence[]
  toolActions: TrajectoryToolAction[]
  modelRequests: TrajectoryModelRequestEvidence[]
  terminalReason?: JsonValue
}

interface SurfaceSnapshot {
  nodes: number[]
  replacementGeneration: number
}

const DEFAULT_EXCERPT_BYTES = 2_000
const DEFAULT_TAIL_BYTES = 500
const SENSITIVE_CONTENT_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/iu

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string {
  const stringify = (item: unknown): string | undefined => JSON.stringify(
    item,
    (key, child) => SENSITIVE_CONTENT_KEY.test(key) ? '[REDACTED]' : child,
  )
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed === 'object' && parsed !== null) return stringify(parsed) ?? value
    } catch {
      // Ordinary message text is not JSON.
    }
    return value
  }
  return stringify(value) ?? String(value)
}

function messageText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    try { return messageText(JSON.parse(value), depth + 1) }
    catch { return value }
  }
  if (Array.isArray(value)) return value.map(item => messageText(item, depth + 1)).filter(Boolean).join('\n')
  const item = record(value)
  if (item === undefined) return String(value)
  if (item.type === 'tool-call') return ''
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) return messageText(item.content, depth + 1)
  return text(value)
}

function utf8Prefix(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function utf8Tail(value: string, bytes: number): string {
  const buffer = Buffer.from(value)
  return buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8').replace(/^\uFFFD/u, '')
}

export function contentExcerpt(
  runId: string,
  value: unknown,
  field: string,
  seq?: number,
  maxBytes = DEFAULT_EXCERPT_BYTES,
): ContentExcerpt {
  const serialized = text(value)
  const bytes = Buffer.byteLength(serialized)
  const truncated = bytes > maxBytes
  const tailBytes = Math.min(DEFAULT_TAIL_BYTES, Math.floor(maxBytes / 3))
  return {
    preview: truncated ? utf8Prefix(serialized, maxBytes - tailBytes) : serialized,
    ...(truncated ? { tail: utf8Tail(serialized, tailBytes) } : {}),
    bytes,
    sha256: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    truncated,
    source: { runId, ...(seq === undefined ? {} : { seq }), field },
  }
}

function isHitchExcerpt(value: unknown): value is HitchTrajectoryContentExcerpt {
  const item = record(value)
  const source = record(item?.source)
  return item !== undefined
    && typeof item.preview === 'string'
    && (item.tail === undefined || typeof item.tail === 'string')
    && Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0
    && typeof item.sha256 === 'string' && /^sha256:[0-9a-f]{64}$/u.test(item.sha256)
    && typeof item.truncated === 'boolean'
    && source !== undefined
    && typeof source.runId === 'string'
    && Number.isSafeInteger(source.seq) && (source.seq as number) >= 0
    && typeof source.field === 'string'
}

function evidenceExcerpt(runId: string, value: unknown, field: string, seq: number, maxBytes = DEFAULT_EXCERPT_BYTES): ContentExcerpt {
  if (!isHitchExcerpt(value)) return contentExcerpt(runId, value, field, seq, maxBytes)
  let preview: string
  if (value.truncated) {
    preview = `[Long ${field}; open its detailRef to inspect the content.]`
  } else {
    let parsed: unknown
    try { parsed = JSON.parse(value.preview) }
    catch { parsed = value.preview }
    if (value.source.field !== field && typeof parsed === 'object' && parsed !== null) {
      const path = field === 'request.header' ? ['data', 'header'] : field.split('.')
      let selected: unknown = parsed
      for (const part of path) selected = record(selected)?.[part]
      if (selected !== undefined) parsed = selected
    }
    preview = field === 'data' || field.endsWith('.message') ? messageText(parsed) : text(parsed)
  }
  return {
    preview,
    bytes: value.bytes,
    sha256: value.sha256,
    truncated: value.truncated,
    source: { runId: value.source.runId, seq: value.source.seq, field },
  }
}

function messageEvidence(runId: string, node: HitchTrajectorySurfaceNode): TrajectoryMessageEvidence | undefined {
  if (node.message === null) return undefined
  const value = record(node.message)
  const inferredRole = node.eventType === 'user/message'
    ? 'user'
    : node.eventType === 'assistant/message' ? 'assistant' : 'tool'
  const field = node.eventType === 'user/message' ? 'data' : 'data.message'
  return {
    seq: node.seq,
    eventType: node.eventType,
    role: typeof value?.role === 'string' ? value.role : inferredRole,
    message: isHitchExcerpt(node.message)
      ? evidenceExcerpt(runId, node.message, field, node.seq)
      : contentExcerpt(runId, messageText(node.message), field, node.seq),
  }
}

function callIdFromMessage(value: unknown): string | undefined {
  const message = record(value)
  const source = record(message?.source)
  if (typeof source?.callId === 'string') return source.callId
  const content = Array.isArray(message?.content) ? message.content : []
  for (const wrapper of content) {
    const item = record(wrapper)
    if (typeof item?.toolCallId === 'string') return item.toolCallId
    if (!Array.isArray(item?.content)) continue
    for (const block of item.content) {
      const result = record(block)
      if (typeof result?.toolCallId === 'string') return result.toolCallId
    }
  }
  return undefined
}

function errorFromResult(data: JsonRecord, message: unknown): { name: string; code: string } | undefined {
  const error = record(data.error)
  if (error !== undefined) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
    }
  }
  const messageRecord = record(message)
  const blocks = Array.isArray(messageRecord?.content) ? messageRecord.content : []
  if (containsToolError(blocks)) return { name: 'ToolResultError', code: 'TOOL_RESULT_ERROR' }
  return undefined
}

function containsToolError(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false
  if (Array.isArray(value)) return value.some(item => containsToolError(item, depth + 1))
  const item = record(value)
  if (item === undefined) return false
  if (item.isError === true || item.is_error === true) return true
  if (item.error !== undefined && item.error !== null && item.error !== false) return true
  return Object.values(item).some(child => containsToolError(child, depth + 1))
}

function collectPaths(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined || isHitchExcerpt(value)) return
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, depth + 1)
    return
  }
  const item = record(value)
  if (item === undefined) return
  for (const [key, child] of Object.entries(item)) {
    if (typeof child === 'string' && /(?:^|_)(?:file_?path|path|cwd|workdir|directory)$/iu.test(key) && child.startsWith('/')) {
      paths.add(child)
    } else {
      collectPaths(child, paths, depth + 1)
    }
  }
}

function parsedArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch { return undefined }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function getStep(steps: Map<string, MutableStep>, turn: number, step: number, seq: number): MutableStep {
  const key = stepKey(turn, step)
  const existing = steps.get(key)
  if (existing !== undefined) {
    existing.seqStart = Math.min(existing.seqStart, seq)
    existing.seqEnd = Math.max(existing.seqEnd, seq)
    return existing
  }
  const created: MutableStep = {
    id: `turn-${turn}-step-${step}`,
    turn,
    step,
    seqStart: seq,
    seqEnd: seq,
    contextEpochIds: [],
    assistantMessages: [],
    toolActions: [],
    modelRequests: [],
  }
  steps.set(key, created)
  return created
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function surfaceSnapshots(analysis: HitchTrajectoryAnalysis): Map<number, SurfaceSnapshot> {
  const snapshots = new Map<number, SurfaceSnapshot>()
  const current: number[] = []
  let replacements = 0
  snapshots.set(0, { nodes: [], replacementGeneration: 0 })
  for (let index = 0; index < analysis.surface.nodes.length; index += 1) {
    const node = analysis.surface.nodes[index]!
    if (node.surfaceOp === 'append') {
      current.push(node.seq)
    } else {
      const start = current.indexOf(node.surfaceOp.start)
      const end = current.indexOf(node.surfaceOp.end)
      if (start < 0 || end < start) throw new TypeError(`invalid projected surface replacement at seq ${node.seq}`)
      const shadowed = current.slice(start, end + 1)
      const declared = analysis.surface.replacements[replacements]
      if (declared === undefined || declared.seq !== node.seq || declared.start !== node.surfaceOp.start
        || declared.end !== node.surfaceOp.end || !sameNumbers(declared.shadowedSeqs, shadowed)) {
        throw new TypeError(`projected surface replacement evidence mismatch at seq ${node.seq}`)
      }
      current.splice(start, end - start + 1, node.seq)
      replacements += 1
    }
    snapshots.set(index + 1, { nodes: [...current], replacementGeneration: replacements })
  }
  if (replacements !== analysis.surface.replacements.length) {
    throw new TypeError('projected surface has unbound replacement evidence')
  }
  if (!sameNumbers(current, analysis.surface.currentNodeSeqs)) {
    throw new TypeError('projected surface final node sequence does not match its fold')
  }
  return snapshots
}

function headerEvidence(runId: string, seq: number, value: JsonValue | undefined): TrajectoryContextEpoch['header'] {
  if (value === undefined) return {}
  if (isHitchExcerpt(value)) return { configExcerpt: evidenceExcerpt(runId, value, 'request.header', seq) }
  const header = record(value)
  if (header === undefined) return { configExcerpt: contentExcerpt(runId, value, 'request.header', seq) }
  return {
    ...(header.config === undefined ? {} : { config: header.config as JsonValue }),
    ...(header.adapterDefaults === undefined ? {} : { adapterDefaults: header.adapterDefaults as JsonValue }),
    ...(header.system === undefined ? {} : { system: evidenceExcerpt(runId, header.system, 'request.header.system', seq) }),
    ...(header.tools === undefined ? {} : { tools: evidenceExcerpt(runId, header.tools, 'request.header.tools', seq) }),
  }
}

function eventRecord(value: JsonValue, label: string): JsonRecord {
  const event = record(value)
  if (event === undefined || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) {
    throw new TypeError(`${label} must include type and seq`)
  }
  return event
}

function eventLocation(event: JsonRecord): { turn?: number; step?: number } {
  const data = record(event.data)
  return {
    ...(Number.isSafeInteger(data?.turn) ? { turn: data!.turn as number } : {}),
    ...(Number.isSafeInteger(data?.step) ? { step: data!.step as number } : {}),
  }
}

function addProjectionError(
  errors: TrajectoryProjection['errors'],
  runId: string,
  seq: number,
  type: string,
  value: unknown,
): void {
  if (!containsToolError(value) && !/error|failed|exception|retry/iu.test(type)) return
  if (errors.some(item => item.seq === seq && item.type === type)) return
  errors.push({ seq, type, excerpt: contentExcerpt(runId, value, 'event', seq, 1_200).preview })
}

/** Convert Hitch's bounded semantic analysis into Gear's internal trajectory projection. */
export function projectTrajectory(analysis: HitchTrajectoryAnalysis): TrajectoryProjection {
  const nodes = [...analysis.surface.nodes].sort((left, right) => left.seq - right.seq)
  if (!nodes.every((node, index) => index === 0 || node.seq > nodes[index - 1]!.seq)) {
    throw new TypeError('projected surface node sequences must be unique and increasing')
  }
  const normalized: HitchTrajectoryAnalysis = { ...analysis, surface: { ...analysis.surface, nodes } }
  const snapshots = surfaceSnapshots(normalized)
  const sourceEventSeqsBySurfaceNode = new Map<number, { count: number; first: number; last: number }>()
  for (let index = 0; index < analysis.events.length; index += 1) {
    const event = eventRecord(analysis.events[index]!, `trajectory analysis event ${index}`)
    const data = record(event.data)
    const source = record(event.source_event_seqs_summary)
    const surfaceNodeSeq = Number.isSafeInteger(data?.surface_node_seq)
      ? data!.surface_node_seq as number
      : event.seq as number
    if (source === undefined || !Number.isSafeInteger(source.count) || (source.count as number) < 1) continue
    sourceEventSeqsBySurfaceNode.set(surfaceNodeSeq, {
      count: source.count as number,
      first: Number.isSafeInteger(source.first) ? source.first as number : surfaceNodeSeq,
      last: Number.isSafeInteger(source.last) ? source.last as number : surfaceNodeSeq,
    })
  }
  const allMessages = new Map<number, TrajectoryMessageEvidence>()
  const surfaceMessages = new Map<number, JsonValue>()
  for (const node of nodes) {
    surfaceMessages.set(node.seq, node.message)
    const evidence = messageEvidence(analysis.runId, node)
    if (evidence !== undefined) {
      const sourceEventSeqs = sourceEventSeqsBySurfaceNode.get(node.seq)
      allMessages.set(node.seq, sourceEventSeqs === undefined ? evidence : { ...evidence, sourceEventSeqs })
    }
  }

  const headers = new Map(analysis.surface.requestHeaders.map(item => [item.seq, item.header]))
  const contextEpochs: TrajectoryContextEpoch[] = []
  const epochIdsByStep = new Map<string, string[]>()
  for (const boundary of [...analysis.surface.requestBoundaries].sort((left, right) => left.boundarySeq - right.boundarySeq)) {
    const snapshot = snapshots.get(boundary.surfaceRevision)
    if (snapshot === undefined) throw new TypeError(`request boundary ${boundary.boundarySeq} has an invalid surface revision`)
    const base = `turn-${boundary.turn}-step-${boundary.step}`
    const attemptSuffix = `-attempt-${boundary.attempt}`
    const id = `${base}${attemptSuffix}-context`
    const requestHeaderSeq = boundary.requestHeaderSeq
    const epoch: TrajectoryContextEpoch = {
      id,
      boundarySeq: boundary.boundarySeq,
      ...(requestHeaderSeq === undefined ? {} : { requestSeq: requestHeaderSeq }),
      turn: boundary.turn,
      step: boundary.step,
      attempt: boundary.attempt,
      ...(boundary.retryId === undefined ? {} : { retryId: boundary.retryId }),
      header: headerEvidence(
        analysis.runId,
        requestHeaderSeq ?? boundary.boundarySeq,
        requestHeaderSeq === undefined ? undefined : headers.get(requestHeaderSeq),
      ),
      surfaceMessageSeqs: snapshot.nodes.filter(seq => allMessages.has(seq)),
      replacementGeneration: snapshot.replacementGeneration,
    }
    contextEpochs.push(epoch)
    const key = stepKey(boundary.turn, boundary.step)
    epochIdsByStep.set(key, [...(epochIdsByStep.get(key) ?? []), id])
  }

  const steps = new Map<string, MutableStep>()
  for (const boundary of analysis.surface.requestBoundaries) {
    const step = getStep(steps, boundary.turn, boundary.step, boundary.boundarySeq)
    const ids = epochIdsByStep.get(stepKey(boundary.turn, boundary.step)) ?? []
    step.contextEpochIds = [...ids]
    if (step.contextEpochId === undefined && ids[0] !== undefined) step.contextEpochId = ids[0]
  }
  const calls = new Map<string, TrajectoryToolAction>()
  const callsBySeq = new Map<number, TrajectoryToolAction>()
  const files = new Set<string>()
  const projectionErrors: TrajectoryProjection['errors'] = []
  for (let index = 0; index < analysis.events.length; index += 1) {
    const event = eventRecord(analysis.events[index]!, `trajectory analysis event ${index}`)
    const type = event.type as string
    const seq = event.seq as number
    const data = record(event.data) ?? {}
    addProjectionError(projectionErrors, analysis.runId, seq, type, event.event_excerpt ?? data)
    const location = eventLocation(event)
    if (location.turn === undefined || location.step === undefined) continue
    const step = getStep(steps, location.turn, location.step, seq)
    const contextIds = epochIdsByStep.get(stepKey(location.turn, location.step)) ?? []
    if (step.contextEpochIds.length === 0) step.contextEpochIds = [...contextIds]
    if (step.contextEpochId === undefined && contextIds[0] !== undefined) step.contextEpochId = contextIds[0]
    if (type === 'assistant/message') {
      const surfaceNodeSeq = Number.isSafeInteger(data.surface_node_seq) ? data.surface_node_seq as number : seq
      const evidence = allMessages.get(surfaceNodeSeq)
      if (evidence !== undefined && !step.assistantMessages.some(item => item.seq === evidence.seq)) {
        step.assistantMessages.push(evidence)
      }
    } else if (type === 'tool/call') {
      if (typeof data.callId !== 'string' || typeof data.name !== 'string') continue
      const action: TrajectoryToolAction = {
        callId: data.callId,
        name: data.name,
        callSeq: seq,
        arguments: evidenceExcerpt(analysis.runId, data.arguments ?? '', 'data.arguments', seq, 1_200),
        status: 'open',
      }
      calls.set(action.callId, action)
      callsBySeq.set(seq, action)
      step.toolActions.push(action)
      collectPaths(parsedArguments(data.arguments), files)
    } else if (type === 'tool/result') {
      const surfaceNodeSeq = Number.isSafeInteger(data.surface_node_seq) ? data.surface_node_seq as number : seq
      const message = surfaceMessages.get(surfaceNodeSeq)
      const callId = callIdFromMessage(message)
      const sourceSeqs = record(event.source_event_seqs_summary)
      const sourceCallSeq = Number.isSafeInteger(sourceSeqs?.first) ? sourceSeqs!.first as number : undefined
      const action = callId === undefined
        ? (sourceCallSeq === undefined ? undefined : callsBySeq.get(sourceCallSeq))
        : calls.get(callId)
      if (action !== undefined) {
        const error = errorFromResult(data, message)
        action.resultSeq = seq
        action.result = isHitchExcerpt(message)
          ? evidenceExcerpt(analysis.runId, message, 'data.message', surfaceNodeSeq)
          : contentExcerpt(analysis.runId, messageText(message ?? data), 'data.message', surfaceNodeSeq)
        action.status = error !== undefined ? 'errored' : isHitchExcerpt(message) ? 'unknown' : 'completed'
        if (error !== undefined) {
          action.error = error
          if (!projectionErrors.some(item => item.seq === seq && item.type === 'tool/result')) {
            projectionErrors.push({ seq, type: 'tool/result', excerpt: `${error.name}: ${error.code}` })
          }
        } else if (action.status === 'unknown') {
          projectionErrors.push({
            seq,
            type: 'tool/result-status-unknown',
            excerpt: 'Tool result error status is unavailable because its surface message was excerpted.',
          })
        }
      }
      collectPaths(data.meta, files)
    } else if (type === 'step/end' && data.reason !== undefined) {
      step.terminalReason = data.reason as JsonValue
    }
  }

  const epochByBoundary = new Map(contextEpochs.map(epoch => [epoch.boundarySeq, epoch.id]))
  for (const summary of analysis.chunkSummaries) {
    const step = getStep(steps, summary.turn, summary.step, summary.firstSeq)
    step.seqEnd = Math.max(step.seqEnd, summary.lastSeq)
    const contextEpochId = epochByBoundary.get(summary.modelBoundarySeq)
      ?? step.contextEpochIds[Math.min(step.modelRequests.length, Math.max(0, step.contextEpochIds.length - 1))]
    const request: TrajectoryModelRequestEvidence = {
      ...(contextEpochId === undefined ? {} : { contextEpochId }),
      attempt: summary.attempt,
      ...(summary.retryId === undefined ? {} : { retryId: summary.retryId }),
      firstSeq: summary.firstSeq,
      lastSeq: summary.lastSeq,
      chunkCount: summary.count,
      chunkTypes: { ...summary.types },
      ...(summary.usage === undefined ? {} : { usage: summary.usage }),
      ...(summary.finishReason === undefined ? {} : { finishReason: summary.finishReason }),
      ...(summary.partial === undefined ? {} : {
        partial: {
          status: summary.partial.status,
          sourceSeqCount: summary.partial.sourceSeqCount,
          ...(summary.partial.streams === undefined ? {
            content: evidenceExcerpt(
              analysis.runId,
              summary.partial.content,
              'data.chunk.delta',
              summary.firstSeq,
            ),
          } : {
            streams: summary.partial.streams.map(stream => ({
              blockIndex: stream.blockIndex,
              blockStartSeq: stream.blockStartSeq,
              kind: stream.kind,
              content: evidenceExcerpt(
                analysis.runId,
                stream.content,
                'data.chunk.delta',
                stream.blockStartSeq,
              ),
              sourceSeqCount: stream.sourceSeqCount,
            })),
          }),
        },
      }),
    }
    step.modelRequests.push(request)
    addProjectionError(projectionErrors, analysis.runId, summary.lastSeq, 'assistant/chunk', summary.finishReason)
  }

  const semanticSteps: TrajectorySemanticStep[] = [...steps.values()]
    .sort((left, right) => left.seqStart - right.seqStart)
    .map(step => ({
      id: step.id,
      turn: step.turn,
      step: step.step,
      seqStart: step.seqStart,
      seqEnd: step.seqEnd,
      ...(step.contextEpochId === undefined ? {} : { contextEpochId: step.contextEpochId }),
      ...(step.contextEpochIds.length <= 1 ? {} : { contextEpochIds: [...step.contextEpochIds] }),
      assistantMessages: step.assistantMessages,
      toolActions: step.toolActions,
      ...(step.modelRequests.length === 0 ? {} : { modelRequests: step.modelRequests }),
      ...(step.terminalReason === undefined ? {} : { terminalReason: step.terminalReason }),
    }))
  const messages = [...allMessages.values()].sort((left, right) => left.seq - right.seq)
  const finalAnswer = messages.findLast(message => message.eventType === 'assistant/message' && message.role === 'assistant')
  const fidelity: TrajectoryProjection['fidelity'] = analysis.source.fidelity === 'provider_native'
    && analysis.surface.fidelity === 'exact'
    ? 'exact-surface'
    : analysis.source.fidelity === 'minimal'
      ? 'minimal'
      : analysis.surface.fidelity === 'partial' ? 'unavailable' : 'normalized-surface'

  return {
    schemaVersion: 1,
    runId: analysis.runId,
    trajectoryDigest: analysis.source.canonicalSha256,
    fidelity,
    rawEventCount: analysis.source.eventCount,
    eventTypes: { ...analysis.source.eventTypes },
    omittedEventTypes: { ...analysis.omittedEventTypes },
    contextEpochs,
    messages,
    semanticSteps,
    ...(finalAnswer === undefined ? {} : { finalAnswer }),
    pathsObservedThroughTools: [...files].sort(),
    replacements: analysis.surface.replacements.map(item => ({ ...item, shadowedSeqs: [...item.shadowedSeqs] })),
    errors: projectionErrors.sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1)),
    coverage: { ...analysis.coverage },
    ...(analysis.redactions === undefined ? {} : { redactions: analysis.redactions.map(item => ({ ...item })) }),
  }
}
