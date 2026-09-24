import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { assertJson, canonicalJson, type JsonValue } from '../schema.js';
import type { ExecutionReceipt, ExecutionResult } from './execution.js';
import type { EvaluationEvidence, HitchTrajectoryReader } from '../../types.js';
import { sanitizePublicValue } from '../../meta/sanitize.js';

/** An operation result supplies both refs; the receipt names the physical producer. */
export type RolloutEvidenceAuthorization = { evidenceRef: ArtifactRef; receiptRef: ArtifactRef };
export type RolloutProjectionPage = {
  reportRef: ArtifactRef;
  traceRefs: ArtifactRef[];
  projectionReceiptRef: ArtifactRef;
  nextOffset?: number;
};
export type RolloutEvidenceUsage = { returnedItems: number; returnedBytes: number; requests: number };
export type RolloutEvidenceToolOptions = {
  stateRoot: string;
  artifacts: FileArtifactStore;
  trajectoryReader: HitchTrajectoryReader;
  /** Host-owned source round held-out reference, never supplied by a role request. */
  heldOutRef: string;
  /** Host-known secret literals removed even when embedded in free-text messages. */
  secretValues?: readonly string[];
  /** Only a host-authorized measurement role may see the physical aggregate score. */
  exposeMeasurement?: boolean;
  maxTraceNodes?: number;
  maxRequests?: number;
};

type ProducerJournal = {
  envelope: OperationEnvelope;
  requestDigest: string;
  identity?: JsonValue;
  status: string;
  completion?: CompletionEnvelope;
};
type SealedRollout = { schemaVersion: 1; kind: 'hitch-daemon-evaluation';
  evidence: EvaluationEvidence; submittedIdentity: JsonValue; requestDigest: string };

const EVENT_TYPES = ['assistant/message', 'tool/error', 'tool/result', 'user/message'];
const PRIVATE_KEY = /(?:grader|label|reward|score|verifier|held.?out)/iu;
function safe(value: unknown, key?: string, depth = 0): JsonValue {
  if (depth > 16) throw new Error('Rollout projection nesting exceeds bound');
  if (key && PRIVATE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => safe(item, undefined, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) =>
    [name, safe(item, name, depth + 1)]));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); }
      catch { /* Ordinary text may begin with a JSON delimiter. */ }
      if (parsed !== undefined) return canonicalJson(safe(parsed, undefined, depth + 1));
    }
    return value.replace(/\b(password|api[_-]?key|authorization|credential|secret|token|grader|label|reward|score)\s*[:=]\s*[^\s,;]+/giu,
    '$1=[REDACTED]');
  }
  return value as JsonValue;
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function isRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Partial<ArtifactRef>;
  return ref.kind === 'artifact' && typeof ref.digest === 'string' && /^[a-f0-9]{64}$/u.test(ref.digest)
    && Number.isSafeInteger(ref.size) && (ref.size as number) >= 0 && typeof ref.mediaType === 'string';
}

/** A digest or tool argument does not authorize a read: the exact pair must occur in the role's frozen input. */
function inRoleInput(input: JsonValue, request: RolloutEvidenceAuthorization): boolean {
  let nodes = 0;
  function visit(value: JsonValue, depth: number): boolean {
    if (++nodes > 20_000 || depth > 24) throw new Error('Role input evidence authorization exceeds bounds');
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1));
    if (!value || typeof value !== 'object') return false;
    if (isRef(value.evidenceRef) && isRef(value.receiptRef)
      && same(value.evidenceRef, request.evidenceRef) && same(value.receiptRef, request.receiptRef)) return true;
    return Object.values(value).some(item => visit(item, depth + 1));
  }
  return visit(input, 0);
}

function completedProducer(options: RolloutEvidenceToolOptions, role: OperationEnvelope,
  authorization: RolloutEvidenceAuthorization): { journal: ProducerJournal; sealed: SealedRollout } {
  if (!isRef(authorization.evidenceRef) || !isRef(authorization.receiptRef)
    || authorization.evidenceRef.schemaId !== 'execution.rollout.evidence.v1'
    || authorization.receiptRef.schemaId !== 'execution.receipt.v1'
    || !inRoleInput(role.input, authorization)) throw new Error('Rollout evidence is not named in this role operation');
  const receipt = options.artifacts.getJson(authorization.receiptRef) as unknown as ExecutionReceipt;
  if (receipt.schemaVersion !== 1 || typeof receipt.operationId !== 'string') throw new Error('Invalid rollout producer receipt');
  assertDigest(receipt.operationId);
  const path = join(options.stateRoot, 'algorithm-hitch-operations', `${receipt.operationId}.json`);
  if (statSync(path).size > 1024 * 1024) throw new Error('Rollout producer journal exceeds size limit');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as ProducerJournal;
  assertJson(journal);
  const completion = journal.completion;
  if (journal.status !== 'completed' || journal.envelope.campaignId !== role.campaignId
    || journal.envelope.kind !== 'execution.rollout' || journal.envelope.operationId !== receipt.operationId
    || journal.envelope.operationId === role.operationId || !completion || completion.outcome.kind !== 'result'
    || completion.operationId !== receipt.operationId
    || completion.idempotencyKey !== journal.envelope.idempotencyKey
    || completion.inputDigest !== journal.envelope.inputDigest
    || completion.implementationDigest !== journal.envelope.implementationDigest) {
    throw new Error('Rollout producer is not a completed operation in this campaign');
  }
  const output = completion.outcome.value as unknown as ExecutionResult;
  if (!output || !same(output.evidenceRef, authorization.evidenceRef)
    || !same(output.receiptRef, authorization.receiptRef)
    || receipt.inputDigest !== journal.envelope.inputDigest
    || receipt.providerImplementationDigest !== journal.envelope.implementationDigest
    || receipt.loadedBindingSetDigest !== journal.envelope.bindingSetRef.digest
    || receipt.evidenceDigest !== authorization.evidenceRef.digest) {
    throw new Error('Rollout producer completion or receipt identity mismatch');
  }
  const sealed = options.artifacts.getJson(authorization.evidenceRef) as unknown as SealedRollout;
  if (sealed.schemaVersion !== 1 || sealed.kind !== 'hitch-daemon-evaluation'
    || sealed.requestDigest !== journal.requestDigest || !journal.identity
    || !same(sealed.submittedIdentity, journal.identity)
    || sealed.evidence?.completeness !== 'complete' || sealed.evidence.plannedTrialCount !== 1
    || sealed.evidence.trials.length + sealed.evidence.invalidTrials.length !== 1) {
    throw new Error('Rollout sealed physical evaluation identity mismatch');
  }
  const input = journal.envelope.input as { task?: { id?: string } };
  const trial = [...sealed.evidence.trials, ...sealed.evidence.invalidTrials][0];
  const identity = journal.identity as { provider?: unknown; effectiveConfigDigest?: unknown; evalId?: unknown };
  if (!input.task?.id || trial?.taskName !== input.task.id
    || sealed.evidence.provider !== identity.provider
    || sealed.evidence.effectiveConfigDigest !== identity.effectiveConfigDigest
    || identity.evalId !== undefined && sealed.evidence.evalId !== identity.evalId) {
    throw new Error('Rollout physical task or evaluation mismatch');
  }
  return { journal, sealed };
}

function chunks(text: string, maxBytes = 12 * 1024): string[] {
  const parts: string[] = [];
  let current = '', bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) { parts.push(current); current = ''; bytes = 0; }
    current += point; bytes += size;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}

async function expand(value: unknown, reader: HitchTrajectoryReader, runId: string,
  canonicalSha256: string, details: { count: number }, depth = 0): Promise<unknown> {
  if (depth > 8) throw new Error('Rollout trajectory excerpt nesting too deep');
  if (Array.isArray(value)) return Promise.all(value.map(item => expand(item, reader, runId, canonicalSha256, details, depth + 1)));
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  const source = item.source as { runId?: string; seq?: number; field?: string } | undefined;
  if (item.truncated === true && typeof item.preview === 'string' && source) {
    if (source.runId !== runId || !Number.isSafeInteger(source.seq) || typeof source.field !== 'string'
      || ++details.count > 100) throw new Error('Rollout trajectory excerpt source invalid');
    const seq = source.seq as number;
    const page = await reader.inspectTrajectoryEvents(runId, { seqStart: seq, seqEnd: seq,
      field: source.field, canonicalSha256, limit: 1, maxBytes: 256 * 1024 }, new AbortController().signal);
    const fieldEvent = page.events[0] as Record<string, unknown> | undefined;
    const nested = fieldEvent?.event_excerpt as Record<string, unknown> | undefined;
    const full = fieldEvent && Object.hasOwn(fieldEvent, 'value') ? fieldEvent.value : nested?.value;
    if (page.runId !== runId || page.canonicalSha256 !== canonicalSha256 || page.filter.seqStart !== seq
      || page.filter.seqEnd !== seq || page.filter.field !== source.field || page.events.length !== 1 || full === undefined) {
      throw new Error('Rollout trajectory excerpt unavailable or changed');
    }
    return expand(full, reader, runId, canonicalSha256, details, depth + 1);
  }
  return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, child]) =>
    [key, await expand(child, reader, runId, canonicalSha256, details, depth + 1)])));
}

async function traceProjection(options: RolloutEvidenceToolOptions, runId: string): Promise<JsonValue[]> {
  const reader = options.trajectoryReader;
  const capabilities = await reader.inspectCapabilities(new AbortController().signal);
  if (capabilities.trajectoryAnalysis !== 1 || capabilities.trajectoryEventsPage !== 1) throw new Error('Hitch bounded trajectory capability unavailable');
  const analysis = await reader.inspectTrajectoryAnalysis(runId, new AbortController().signal);
  if (analysis.runId !== runId || !/^sha256:[a-f0-9]{64}$/u.test(analysis.source.canonicalSha256)
    || analysis.coverage.surface !== 'complete') throw new Error('Rollout trajectory identity or coverage invalid');
  const maxNodes = options.maxTraceNodes ?? 1_000;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000) throw new Error('Invalid rollout trace node cap');
  const trace: JsonValue[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  let matches: number | undefined;
  let eventCount = 0, totalBytes = 0;
  const details = { count: 0 };
  const redactions: JsonValue[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const page = await reader.inspectTrajectoryEvents(runId, { eventTypes: EVENT_TYPES, canonicalSha256: analysis.source.canonicalSha256,
      ...(cursor ? { cursor } : {}), limit: 100, maxBytes: 256 * 1024 }, new AbortController().signal);
    if (page.kind !== 'trajectory-events-page' || page.runId !== runId
      || page.canonicalSha256 !== analysis.source.canonicalSha256
      || page.filter.eventTypes?.join('\0') !== EVENT_TYPES.join('\0')
      || !Number.isSafeInteger(page.totalMatches) || page.totalMatches < 0 || page.events.length > 100
      || matches !== undefined && page.totalMatches !== matches) throw new Error('Rollout trajectory page identity drift');
    matches = page.totalMatches;
    if (page.redactions?.length) redactions.push({ pageIndex, redactions: page.redactions });
    for (const event of page.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || !EVENT_TYPES.includes(String(event.type)) || !Number.isSafeInteger(event.seq)) {
        throw new Error('Rollout trajectory event invalid');
      }
      const expanded = await expand(event, reader, runId, analysis.source.canonicalSha256, details);
      if (Object.hasOwn(expanded as object, 'event_excerpt')) throw new Error('Rollout trajectory excerpt cannot be reconstructed');
      const payload = canonicalJson(safe(sanitizePublicValue(expanded, options.heldOutRef, options.secretValues ?? [])));
      totalBytes += Buffer.byteLength(payload);
      if (totalBytes > 2 * 1024 * 1024) throw new Error('Rollout trajectory projection exceeds byte limit');
      const parts = chunks(payload);
      for (const [partIndex, content] of parts.entries()) {
        trace.push({ runId, canonicalSha256: analysis.source.canonicalSha256,
          eventSeq: Number(event.seq), partIndex, partCount: parts.length, content });
        if (trace.length > maxNodes) throw new Error('Rollout trajectory projection exceeds node cap');
      }
      eventCount++;
    }
    if (page.eof) {
      if (page.nextCursor || eventCount !== matches || trace.length + 1 > maxNodes)
        throw new Error('Rollout trajectory page did not cover selected events within node cap');
      trace.unshift({ kind: 'trajectory-projection-receipt', runId, canonicalSha256: analysis.source.canonicalSha256,
        analysisRedactions: analysis.redactions ?? [], pageRedactions: redactions, selectedEventCount: eventCount });
      return trace;
    }
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('Rollout trajectory cursor did not advance');
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error('Rollout trajectory requires too many pages');
}

/** Role-facing narrow tool surface: only named producer tuples can yield sealed projections. */
export function createRoleRolloutEvidenceTools(options: RolloutEvidenceToolOptions, role: OperationEnvelope): {
  query(authorization: RolloutEvidenceAuthorization, offset?: number, limit?: number): Promise<RolloutProjectionPage>;
  read(authorization: RolloutEvidenceAuthorization, contentDigest: string): Promise<{ text: string; mediaType: string }>;
  usage(): RolloutEvidenceUsage;
} {
  if (!options.heldOutRef) throw new Error('Host-held held-out reference required');
  const maxRequests = options.maxRequests ?? 100;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000) throw new Error('Invalid rollout tool request cap');
  const cumulative: RolloutEvidenceUsage = { returnedItems: 0, returnedBytes: 0, requests: 0 };
  let attempts = 0;
  const cache = new Map<string, Promise<{
    reportRef: ArtifactRef; traceRefs: ArtifactRef[]; projectionReceiptRef: ArtifactRef
  }>>();
  function attempt(): void {
    if (++attempts > maxRequests) throw new Error('Rollout evidence role tool request limit exceeded');
  }
  async function project(authorization: RolloutEvidenceAuthorization): Promise<{
    reportRef: ArtifactRef; traceRefs: ArtifactRef[]; projectionReceiptRef: ArtifactRef
  }> {
    // Revalidate the producer on every call, even when the expensive Hitch
    // trajectory projection is cached within this one immutable role operation.
    const verified = completedProducer(options, role, authorization);
    const key = canonicalJson(authorization);
    const prior = cache.get(key);
    if (prior) return prior;
    const created = materialize(authorization, verified);
    cache.set(key, created);
    try { return await created; } catch (error) { cache.delete(key); throw error; }
  }
  async function materialize(authorization: RolloutEvidenceAuthorization,
    { journal, sealed }: ReturnType<typeof completedProducer>): Promise<{
      reportRef: ArtifactRef; traceRefs: ArtifactRef[]; projectionReceiptRef: ArtifactRef
    }> {
    const trial = sealed.evidence.trials[0];
    const runId = trial?.runId ?? sealed.evidence.invalidTrials[0]?.runId;
    if (!runId || !/^run_[a-f0-9]{32}$/u.test(runId)) throw new Error('Rollout has no verified Hitch run');
    const trace = await traceProjection(options, runId);
    const traceRefs = trace.map(item => options.artifacts.putJson(item, 'execution.rollout.trace-chunk.v1'));
    const measurement = options.exposeMeasurement ? { primaryReward: sealed.evidence.primaryReward,
      summary: sealed.evidence.summary, trialScores: trial?.scores ?? null } : {};
    const reportRef = options.artifacts.putJson({ schemaVersion: 1, kind: 'rollout-task-report',
      producerOperationId: journal.envelope.operationId, taskId: (journal.envelope.input as { task: { id: string } }).task.id,
      evalId: sealed.evidence.evalId, revisionDigest: journal.envelope.bindingSetRef.digest,
      status: trial?.status ?? 'errored', traceChunkCount: traceRefs.length,
      ...measurement } as JsonValue, 'execution.rollout.task-report.v1');
    const projectionReceiptRef = options.artifacts.putJson({ schemaVersion: 1, kind: 'rollout-projection-receipt',
      producerOperationId: journal.envelope.operationId, roleOperationId: role.operationId,
      evidenceDigest: authorization.evidenceRef.digest, reportDigest: reportRef.digest,
      traceDigests: traceRefs.map(ref => ref.digest), scoreExposed: options.exposeMeasurement === true } as JsonValue,
    'execution.rollout.projection-receipt.v1');
    return { reportRef, traceRefs, projectionReceiptRef };
  }
  return {
    async query(authorization, offset = 0, limit = 20) {
      attempt();
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Invalid rollout evidence page');
      }
      const projection = await project(authorization);
      if (offset > projection.traceRefs.length) throw new Error('Rollout evidence page outside projection');
      const page: RolloutProjectionPage = { reportRef: projection.reportRef, traceRefs: projection.traceRefs.slice(offset, offset + limit),
        projectionReceiptRef: projection.projectionReceiptRef,
        ...(offset + limit < projection.traceRefs.length ? { nextOffset: offset + limit } : {}) };
      cumulative.requests++;
      cumulative.returnedItems += 1 + page.traceRefs.length;
      cumulative.returnedBytes += Buffer.byteLength(canonicalJson(page));
      return page;
    },
    async read(authorization, contentDigest) {
      attempt();
      assertDigest(contentDigest);
      const projection = await project(authorization);
      const ref = [projection.reportRef, ...projection.traceRefs].find(item => item.digest === contentDigest);
      if (!ref) throw new Error('Rollout projection digest is not authorized for this role operation');
      const text = options.artifacts.getBytes(ref).toString('utf8');
      cumulative.requests++;
      cumulative.returnedItems++;
      cumulative.returnedBytes += Buffer.byteLength(text);
      return { text, mediaType: ref.mediaType };
    },
    usage: () => ({ ...cumulative }),
  };
}
