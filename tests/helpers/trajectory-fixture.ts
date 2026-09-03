import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  HitchCapabilities,
  HitchTrajectoryAnalysis,
  HitchTrajectoryEventsPage,
  HitchTrajectoryEventsQuery,
  HitchTrajectoryReader,
  HitchVerifierEvidence,
} from '../../src/types.js'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {}
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function counts(events: readonly JsonRecord[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    result[type] = (result[type] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

export function trajectoryAnalysis(
  runId: string,
  inputEvents: readonly unknown[],
  fidelity: HitchTrajectoryAnalysis['source']['fidelity'] = 'provider_native',
): HitchTrajectoryAnalysis {
  const events: Array<JsonRecord & { seq: number }> = inputEvents.map((event, seq) => ({ ...record(event), seq }))
  const current: number[] = []
  const nodes: HitchTrajectoryAnalysis['surface']['nodes'] = []
  const replacements: HitchTrajectoryAnalysis['surface']['replacements'] = []
  const boundaries: HitchTrajectoryAnalysis['surface']['requestBoundaries'] = []
  const boundaryKeys = new Set<string>()
  const requestHeaders: HitchTrajectoryAnalysis['surface']['requestHeaders'] = []
  const diagnostics: JsonValue[] = []
  const chunkGroups = new Map<string, HitchTrajectoryAnalysis['chunkSummaries'][number]>()
  let latestHeader: JsonValue = null
  let latestHeaderSeq: number | undefined
  let surfaceRevision = 0

  const boundary = (event: JsonRecord, turn: number, step: number): void => {
    const key = `${turn}:${step}`
    if (boundaryKeys.has(key)) return
    boundaryKeys.add(key)
    boundaries.push({
      turn,
      step,
      attempt: 0,
      boundarySeq: event.seq as number,
      surfaceRevision,
      ...(latestHeaderSeq === undefined ? {} : { requestHeaderSeq: latestHeaderSeq }),
    })
  }

  for (const event of events) {
    const type = String(event.type)
    const seq = event.seq as number
    const data = record(event.data)
    if (type === 'assistant/message' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      boundary(event, data.turn as number, data.step as number)
    }
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      const message = type === 'user/message' ? event.data : data.message ?? null
      const operation = event.surfaceOp ?? 'append'
      if (operation === 'append') current.push(seq)
      else {
        const replacement = record(operation)
        const start = current.indexOf(replacement.start as number)
        const end = current.indexOf(replacement.end as number)
        const shadowedSeqs = current.slice(start, end + 1)
        current.splice(start, end - start + 1, seq)
        replacements.push({ seq, start: replacement.start as number, end: replacement.end as number, shadowedSeqs })
      }
      nodes.push({
        seq,
        eventType: type,
        surfaceOp: operation as HitchTrajectoryAnalysis['surface']['nodes'][number]['surfaceOp'],
        message: json(message),
      })
      surfaceRevision += 1
    }
    if (type === 'request/header') {
      latestHeader = json(data.header ?? null)
      latestHeaderSeq = seq
      requestHeaders.push({ seq, header: latestHeader })
    }
    if (type === 'assistant/chunk') {
      const turn = Number.isSafeInteger(data.turn) ? data.turn as number : 0
      const step = Number.isSafeInteger(data.step) ? data.step as number : 0
      boundary(event, turn, step)
      const key = `${turn}:${step}`
      const chunk = record(data.chunk)
      const chunkType = typeof chunk.type === 'string' ? chunk.type : 'unknown'
      const group = chunkGroups.get(key) ?? {
        turn,
        step,
        attempt: 0,
        firstSeq: seq,
        lastSeq: seq,
        count: 0,
        types: {},
        modelBoundarySeq: seq,
      }
      group.lastSeq = seq
      group.count += 1
      group.types[chunkType] = (group.types[chunkType] ?? 0) + 1
      chunkGroups.set(key, group)
      continue
    }
    let projectedData: unknown = event.data ?? null
    if (type === 'request/header') projectedData = { reason: data.reason, request_header_seq: seq }
    else if (type === 'user/message') projectedData = { surface_node_seq: seq }
    else if (type === 'assistant/message' || type === 'tool/result') {
      const { message: _message, ...metadata } = data
      projectedData = { ...metadata, surface_node_seq: seq }
    }
    diagnostics.push(json({
      type,
      seq,
      time: event.time ?? seq,
      data: projectedData,
      ...(event.sourceEventSeqs === undefined ? {} : {
        source_event_seqs_summary: {
          count: Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.length : 0,
          ...(Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0
            ? { first: event.sourceEventSeqs[0], last: event.sourceEventSeqs.at(-1) }
            : {}),
        },
      }),
    }))
  }
  const eventTypes = counts(events)
  const canonical = JSON.stringify(events)
  return {
    schemaVersion: 1,
    kind: 'trajectory-analysis',
    runId,
    source: {
      fidelity,
      provider: 'test',
      sessionId: `session-${runId}`,
      canonicalSha256: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
      canonicalBytes: Buffer.byteLength(canonical),
      eventCount: events.length,
      eventTypes,
    },
    header: latestHeader,
    surface: {
      fidelity: 'exact',
      nodes,
      currentNodeSeqs: current,
      replacements,
      requestBoundaries: boundaries,
      requestHeaders,
    },
    events: diagnostics,
    chunkSummaries: [...chunkGroups.values()],
    omittedEventTypes: eventTypes['assistant/chunk'] === undefined ? {} : { 'assistant/chunk': eventTypes['assistant/chunk'] },
    coverage: {
      surface: 'complete',
      chunks: chunkGroups.size === 0 ? 'omitted' : 'coalesced',
      content: 'complete',
      childSessions: 'unavailable',
    },
  }
}

export function trajectoryEventsPage(
  analysis: HitchTrajectoryAnalysis,
  query: Readonly<HitchTrajectoryEventsQuery>,
): HitchTrajectoryEventsPage {
  let events = analysis.events
  if (query.eventTypes !== undefined) events = events.filter(event => query.eventTypes!.includes(String(record(event).type)))
  if (query.seqStart !== undefined) events = events.filter(event => (record(event).seq as number) >= query.seqStart!)
  if (query.seqEnd !== undefined) events = events.filter(event => (record(event).seq as number) <= query.seqEnd!)
  const limit = query.limit ?? 100
  return {
    schemaVersion: 1,
    kind: 'trajectory-events-page',
    runId: analysis.runId,
    canonicalSha256: analysis.source.canonicalSha256,
    filter: {
      ...(query.eventTypes === undefined ? {} : { eventTypes: query.eventTypes }),
      ...(query.seqStart === undefined ? {} : { seqStart: query.seqStart }),
      ...(query.seqEnd === undefined ? {} : { seqEnd: query.seqEnd }),
      ...(query.field === undefined ? {} : { field: query.field }),
    },
    events: events.slice(0, limit),
    totalMatches: events.length,
    eof: events.length <= limit,
  }
}

export function trajectoryReader(
  analyses: ReadonlyMap<string, HitchTrajectoryAnalysis>,
  inspectVerifierEvidence?: (runId: string, signal: AbortSignal) => Promise<HitchVerifierEvidence>,
): HitchTrajectoryReader {
  const requireAnalysis = (runId: string): HitchTrajectoryAnalysis => {
    const analysis = analyses.get(runId)
    if (analysis === undefined) throw new Error(`missing trajectory fixture ${runId}`)
    return analysis
  }
  const capabilities: HitchCapabilities = { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }
  return {
    async inspectCapabilities() { return capabilities },
    async inspectTrajectoryAnalysis(runId) { return requireAnalysis(runId) },
    async inspectTrajectoryEvents(runId, query) { return trajectoryEventsPage(requireAnalysis(runId), query) },
    ...(inspectVerifierEvidence === undefined ? {} : { inspectVerifierEvidence }),
  }
}
