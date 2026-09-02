import { createHash } from 'node:crypto'
import {
  deriveEventMessage,
  foldRequestHeader,
  foldSurface,
  type EpochHeader,
  type JsonValue,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type {
  ContentExcerpt,
  HitchTrajectory,
  TrajectoryContextEpoch,
  TrajectoryMessageEvidence,
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
  assistantMessages: TrajectoryMessageEvidence[]
  toolActions: TrajectoryToolAction[]
  terminalReason?: JsonValue
}

const DEFAULT_EXCERPT_BYTES = 2_000
const DEFAULT_TAIL_BYTES = 500

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
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

function eventSeq(event: JsonRecord, index: number): number {
  if (!Number.isSafeInteger(event.seq) || event.seq !== index) {
    throw new TypeError(`trajectory event sequence is not contiguous at index ${index}`)
  }
  return event.seq as number
}

function eventData(event: JsonRecord): JsonRecord {
  return record(event.data) ?? {}
}

function eventLocation(event: JsonRecord): { turn?: number; step?: number } {
  const data = eventData(event)
  return {
    ...(Number.isSafeInteger(data.turn) ? { turn: data.turn as number } : {}),
    ...(Number.isSafeInteger(data.step) ? { step: data.step as number } : {}),
  }
}

function messageEvidence(runId: string, event: JsonRecord): TrajectoryMessageEvidence | undefined {
  let message: unknown
  try { message = deriveEventMessage(event as unknown as SessionEvent) }
  catch { return undefined }
  if (message === null || message === undefined) return undefined
  const value = record(message)
  const seq = event.seq as number
  const source = Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((item): item is number => Number.isSafeInteger(item))
    : undefined
  return {
    seq,
    eventType: typeof event.type === 'string' ? event.type : 'unknown',
    role: typeof value?.role === 'string' ? value.role : 'unknown',
    message: contentExcerpt(runId, message, 'message', seq),
    ...(source === undefined || source.length === 0 ? {} : {
      sourceEventSeqs: { count: source.length, first: source[0]!, last: source.at(-1)! },
    }),
  }
}

function surfaceAt(events: JsonRecord[], endExclusive: number): {
  nodes: number[]
  replacements: Array<{ seq: number; start: number; end: number; shadowedSeqs: number[] }>
} {
  const result = foldSurface(events.slice(0, endExclusive) as unknown as SessionEvent[])
  return {
    nodes: [...result.nodes],
    replacements: result.replacements.map(item => ({ ...item, shadowedSeqs: [...item.shadowedSeqs] })),
  }
}

function canonicalHeader(events: JsonRecord[], endExclusive: number): EpochHeader | undefined {
  return foldRequestHeader(events.slice(0, endExclusive) as unknown as SessionEvent[])
}

function headerExcerpt(runId: string, requestSeq: number, header: EpochHeader | undefined): TrajectoryContextEpoch['header'] {
  if (header === undefined) return {}
  return {
    config: header.config as unknown as JsonValue,
    ...(header.adapterDefaults === undefined ? {} : {
      adapterDefaults: header.adapterDefaults as unknown as JsonValue,
    }),
    ...(header.system === undefined ? {} : { system: contentExcerpt(runId, header.system, 'request.header.system', requestSeq) }),
    ...(header.tools === undefined ? {} : { tools: contentExcerpt(runId, header.tools, 'request.header.tools', requestSeq) }),
  }
}

function callIdFromResult(data: JsonRecord): string | undefined {
  const message = record(data.message)
  const source = record(message?.source)
  if (typeof source?.callId === 'string') return source.callId
  const content = Array.isArray(message?.content) ? message.content : []
  for (const wrapper of content) {
    const item = record(wrapper)
    if (!Array.isArray(item?.content)) continue
    for (const block of item.content) {
      const result = record(block)
      if (typeof result?.toolCallId === 'string') return result.toolCallId
    }
  }
  return undefined
}

function errorFromResult(data: JsonRecord): { name: string; code: string } | undefined {
  const error = record(data.error)
  if (error !== undefined) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
    }
  }
  const message = record(data.message)
  const blocks = Array.isArray(message?.content) ? message.content : []
  if (blocks.some(block => record(block)?.isError === true)) {
    return { name: 'ToolResultError', code: 'TOOL_RESULT_ERROR' }
  }
  return undefined
}

function collectPaths(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return
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
    existing.seqEnd = Math.max(existing.seqEnd, seq)
    return existing
  }
  const created: MutableStep = {
    id: `turn-${turn}-step-${step}`,
    turn,
    step,
    seqStart: seq,
    seqEnd: seq,
    assistantMessages: [],
    toolActions: [],
  }
  steps.set(key, created)
  return created
}

export function projectTrajectory(trajectory: HitchTrajectory): TrajectoryProjection {
  const events = trajectory.events.map((value, index) => {
    const event = record(value)
    if (event === undefined) throw new TypeError(`trajectory event ${index} must be an object`)
    eventSeq(event, index)
    return event
  })
  const eventTypes: Record<string, number> = {}
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }

  let folded: ReturnType<typeof surfaceAt>
  let fidelity: TrajectoryProjection['fidelity']
  const projectionErrors: TrajectoryProjection['errors'] = trajectory.diagnostics.errorExcerpts.map(item => ({ ...item }))
  try {
    folded = surfaceAt(events, events.length)
    fidelity = trajectory.fidelity === 'provider_native'
      ? 'exact-surface'
      : trajectory.fidelity === 'normalized' ? 'normalized-surface' : 'minimal'
  } catch (error) {
    folded = {
      nodes: events
        .filter(event => event.surfaceOp === 'append')
        .flatMap(event => typeof event.seq === 'number' ? [event.seq] : []),
      replacements: [],
    }
    fidelity = 'normalized-surface'
    projectionErrors.unshift({ type: 'surface/fold-error', excerpt: String(error) })
  }

  const allMessages = new Map<number, TrajectoryMessageEvidence>()
  for (const event of events) {
    const evidence = messageEvidence(trajectory.runId, event)
    if (evidence !== undefined) allMessages.set(evidence.seq, evidence)
  }

  const contextEpochs: TrajectoryContextEpoch[] = []
  const epochByStep = new Map<string, string>()
  const epochIndexByStep = new Map<string, number>()
  const modelBoundaryCaptured = new Set<string>()
  let currentTurn: number | undefined
  let currentStep: number | undefined
  let latestRequestSeq: number | undefined
  for (const event of events) {
    const type = event.type
    const location = eventLocation(event)
    if (type === 'turn/start' && location.turn !== undefined) currentTurn = location.turn
    if (type === 'step/start') {
      currentTurn = location.turn ?? currentTurn
      currentStep = location.step
      if (currentTurn !== undefined && currentStep !== undefined) {
        const boundarySeq = event.seq as number
        const key = stepKey(currentTurn, currentStep)
        try {
          const surface = surfaceAt(events, boundarySeq)
          const header = canonicalHeader(events, boundarySeq)
          const id = `turn-${currentTurn}-step-${currentStep}-context`
          const epoch: TrajectoryContextEpoch = {
            id,
            boundarySeq,
            ...(latestRequestSeq === undefined ? {} : { requestSeq: latestRequestSeq }),
            turn: currentTurn,
            step: currentStep,
            header: headerExcerpt(trajectory.runId, latestRequestSeq ?? boundarySeq, header),
            surfaceMessageSeqs: surface.nodes.filter(seq => allMessages.has(seq)),
            replacementGeneration: surface.replacements.length,
          }
          epochIndexByStep.set(key, contextEpochs.length)
          epochByStep.set(key, id)
          contextEpochs.push(epoch)
        } catch (error) {
          projectionErrors.push({ seq: boundarySeq, type: 'step/context-error', excerpt: String(error) })
        }
      }
    }
    if (type === 'request/header') {
      const requestSeq = event.seq as number
      latestRequestSeq = requestSeq
      try {
        const surface = surfaceAt(events, requestSeq)
        const header = canonicalHeader(events, requestSeq + 1)
        const turn = location.turn ?? currentTurn
        const step = location.step ?? currentStep
        const key = turn === undefined || step === undefined ? undefined : stepKey(turn, step)
        const existingIndex = key === undefined ? undefined : epochIndexByStep.get(key)
        if (existingIndex !== undefined) {
          const existing = contextEpochs[existingIndex]!
          contextEpochs[existingIndex] = {
            ...existing,
            requestSeq,
            header: headerExcerpt(trajectory.runId, requestSeq, header),
            surfaceMessageSeqs: surface.nodes.filter(seq => allMessages.has(seq)),
            replacementGeneration: surface.replacements.length,
          }
        } else {
          const id = `request-${requestSeq}`
          contextEpochs.push({
            id,
            boundarySeq: requestSeq,
            requestSeq,
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
            header: headerExcerpt(trajectory.runId, requestSeq, header),
            surfaceMessageSeqs: surface.nodes.filter(seq => allMessages.has(seq)),
            replacementGeneration: surface.replacements.length,
          })
          if (key !== undefined) {
            epochIndexByStep.set(key, contextEpochs.length - 1)
            epochByStep.set(key, id)
          }
        }
      } catch (error) {
        projectionErrors.push({ seq: requestSeq, type: 'request/context-error', excerpt: String(error) })
      }
    }
    if (type === 'assistant/chunk' || type === 'assistant/message') {
      const turn = location.turn ?? currentTurn
      const step = location.step ?? currentStep
      if (turn !== undefined && step !== undefined) {
        const key = stepKey(turn, step)
        const existingIndex = epochIndexByStep.get(key)
        if (existingIndex !== undefined && !modelBoundaryCaptured.has(key)) {
          modelBoundaryCaptured.add(key)
          const boundarySeq = event.seq as number
          try {
            const surface = surfaceAt(events, boundarySeq)
            const header = canonicalHeader(events, boundarySeq)
            const existing = contextEpochs[existingIndex]!
            contextEpochs[existingIndex] = {
              ...existing,
              boundarySeq,
              ...(latestRequestSeq === undefined ? {} : { requestSeq: latestRequestSeq }),
              header: headerExcerpt(trajectory.runId, latestRequestSeq ?? boundarySeq, header),
              surfaceMessageSeqs: surface.nodes.filter(seq => allMessages.has(seq)),
              replacementGeneration: surface.replacements.length,
            }
          } catch (error) {
            projectionErrors.push({ seq: boundarySeq, type: 'model/context-error', excerpt: String(error) })
          }
        }
      }
    }
    if (type === 'step/end') currentStep = undefined
    if (type === 'turn/end') {
      currentStep = undefined
      currentTurn = undefined
    }
  }

  const steps = new Map<string, MutableStep>()
  const calls = new Map<string, TrajectoryToolAction>()
  const files = new Set<string>()
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    const seq = event.seq as number
    const data = eventData(event)
    const location = eventLocation(event)
    if (location.turn === undefined || location.step === undefined) continue
    const step = getStep(steps, location.turn, location.step, seq)
    const contextEpochId = epochByStep.get(stepKey(location.turn, location.step))
    if (step.contextEpochId === undefined && contextEpochId !== undefined) step.contextEpochId = contextEpochId
    if (type === 'assistant/message') {
      const evidence = allMessages.get(seq)
      if (evidence !== undefined) step.assistantMessages.push(evidence)
    } else if (type === 'tool/call') {
      if (typeof data.callId !== 'string' || typeof data.name !== 'string') continue
      const action: TrajectoryToolAction = {
        callId: data.callId,
        name: data.name,
        callSeq: seq,
        arguments: contentExcerpt(trajectory.runId, data.arguments ?? '', 'tool.arguments', seq, 1_200),
        status: 'open',
      }
      calls.set(action.callId, action)
      step.toolActions.push(action)
      collectPaths(parsedArguments(data.arguments), files)
    } else if (type === 'tool/result') {
      const callId = callIdFromResult(data)
      const action = callId === undefined ? undefined : calls.get(callId)
      if (action !== undefined) {
        const error = errorFromResult(data)
        action.resultSeq = seq
        action.result = contentExcerpt(trajectory.runId, data.message ?? data, 'tool.result', seq)
        action.status = error === undefined ? 'completed' : 'errored'
        if (error !== undefined) {
          action.error = error
          if (!projectionErrors.some(item => item.seq === seq && item.type === 'tool/result')) {
            projectionErrors.push({ seq, type: 'tool/result', excerpt: `${error.name}: ${error.code}` })
          }
        }
      }
      collectPaths(data.meta, files)
    } else if (type === 'step/end') {
      const reason = data.reason
      if (reason !== undefined) step.terminalReason = reason as JsonValue
    }
  }

  const semanticSteps: TrajectorySemanticStep[] = [...steps.values()]
    .sort((left, right) => left.seqStart - right.seqStart)
    .map(step => ({ ...step }))
  const messages = [...allMessages.values()].sort((left, right) => left.seq - right.seq)
  const finalAnswer = messages.findLast(message => message.eventType === 'assistant/message' && message.role === 'assistant')
  const keptTypes = new Set(['request/header', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'step/start', 'step/end'])
  const omittedEventTypes = Object.fromEntries(Object.entries(eventTypes).filter(([type]) => !keptTypes.has(type)))

  return {
    schemaVersion: 1,
    runId: trajectory.runId,
    trajectoryDigest: trajectory.trajectoryDigest,
    fidelity,
    rawEventCount: events.length,
    eventTypes,
    omittedEventTypes,
    contextEpochs,
    messages,
    semanticSteps,
    ...(finalAnswer === undefined ? {} : { finalAnswer }),
    pathsObservedThroughTools: [...files].sort(),
    replacements: folded.replacements,
    errors: projectionErrors,
  }
}

export function selectKeySteps(projection: TrajectoryProjection, maxSteps = 8): TrajectorySemanticStep[] {
  if (projection.semanticSteps.length <= maxSteps) return projection.semanticSteps
  const selected = new Map<string, TrajectorySemanticStep>()
  const add = (step: TrajectorySemanticStep | undefined): void => {
    if (step !== undefined && selected.size < maxSteps) selected.set(step.id, step)
  }
  const errorSteps = projection.semanticSteps.filter(step =>
    step.toolActions.some(action => action.status === 'errored' || action.status === 'open'))
  const errorBudget = maxSteps > 1 ? maxSteps - 1 : maxSteps
  for (const step of errorSteps.slice(0, errorBudget)) add(step)
  add(projection.semanticSteps.at(-1))
  add(projection.semanticSteps[0])
  for (const step of projection.semanticSteps.slice(-4)) add(step)
  for (const step of projection.semanticSteps) add(step)
  return [...selected.values()].sort((left, right) => left.seqStart - right.seqStart)
}
