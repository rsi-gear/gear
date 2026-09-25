import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertDigest, sha256 } from '../artifacts.js';
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { implementationClosureDigest } from '../data/identity.js';
import { validateProviderManifest } from '../runtime/provider-manifest.js';
import { digestJson } from '../../state/digest.js';
import type { CompletionEnvelope, OperationEnvelope, OperationOutcome, ProviderManifest } from '../contracts.js';
import type { CommittedRollout, CommittedRolloutResolver } from './measurement.js';
import type { EvaluationRequest } from '../../types.js';

/** The neutral Hitch port owns this bounded, read-only journal projection. */
export type AuthorPhysicalRolloutJournalSnapshot = {
  status: 'intent' | 'reserved' | 'cancelling' | 'cancelled' | 'completed';
  envelope: OperationEnvelope;
  request: EvaluationRequest;
  requestDigest: string;
  submittedIdentity?: JsonValue;
  completion?: CompletionEnvelope;
};
export type AuthorPhysicalRolloutJournalReader = {
  describe(): ProviderManifest;
  readAuthorRolloutJournal(operationId: string):
    Promise<AuthorPhysicalRolloutJournalSnapshot | undefined> | AuthorPhysicalRolloutJournalSnapshot | undefined;
};
export type LocalCommittedRolloutResolverOptions = {
  /** Exact CampaignStore root; its HEAD and journal/ are read without opening a writer lease. */
  campaignJournalRoot: string;
  physicalReader: AuthorPhysicalRolloutJournalReader;
  maxRecords?: number;
  maxRecordBytes?: number;
  maxTotalBytes?: number;
};

type JournalRecord = { seq: number; previous: string | null; event: string; state: JsonValue };
type HistoricalOperation = { envelope: OperationEnvelope; providerManifestDigest: string;
  status: string; outcome?: OperationOutcome; released?: boolean };
type SeenOperation = { envelope: OperationEnvelope; providerManifestDigest: string;
  lastStatus: string; outcome?: OperationOutcome; vanished: boolean; released: boolean;
  completed?: Pick<CommittedRollout, 'envelope' | 'providerManifestDigest' | 'status' | 'outcome'> };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function boundedFile(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Campaign journal file is not a bounded regular file');
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) throw new Error('Campaign journal file exceeded read bound');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size)
      throw new Error('Campaign journal file changed during read');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally { closeSync(fd); }
}
function verifiedChain(root: string, maxRecords: number, maxRecordBytes: number,
  maxTotalBytes: number): JournalRecord[] {
  const head = object(JSON.parse(boundedFile(join(root, 'HEAD'), 4096)), 'Campaign HEAD');
  if (!same(Object.keys(head).sort(), ['seq', 'digest'].sort())
    || !Number.isSafeInteger(head.seq) || (head.seq as number) < 0)
    throw new Error('Campaign HEAD schema or sequence drift');
  assertDigest(head.digest as string);
  const records: JournalRecord[] = [];
  const seen = new Set<string>();
  let digest: string | null = head.digest as string;
  let expected = head.seq as number, bytesRead = 0;
  while (digest !== null) {
    if (records.length >= maxRecords || seen.has(digest)) throw new Error('Campaign journal limit or cycle');
    seen.add(digest);
    const raw = boundedFile(join(root, 'journal', `${digest}.json`), maxRecordBytes);
    bytesRead += Buffer.byteLength(raw);
    if (bytesRead > maxTotalBytes || sha256(raw) !== digest) throw new Error('Campaign journal byte digest or size drift');
    const parsed = JSON.parse(raw) as unknown;
    assertJson(parsed);
    const record = object(parsed, 'Campaign record') as JournalRecord;
    if (!same(Object.keys(record).sort(), ['seq', 'previous', 'event', 'state'].sort())
      || canonicalJson(record as unknown as JsonValue) !== raw
      || record.seq !== expected || typeof record.event !== 'string' || !record.event
      || expected === 0 && record.previous !== null
      || expected > 0 && (typeof record.previous !== 'string' || !/^[a-f0-9]{64}$/u.test(record.previous)))
      throw new Error('Campaign journal sequence or record drift');
    records.push(record);
    digest = record.previous;
    expected--;
  }
  if (expected !== -1 || records.length === 0) throw new Error('Incomplete Campaign journal chain');
  return records.reverse();
}

function envelopeRecord(value: unknown, localKey: string, campaignId: string): HistoricalOperation {
  const item = object(value, 'Historical operation');
  const envelope = object(item.envelope, 'Historical operation envelope') as OperationEnvelope;
  if (typeof envelope.operationId !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.operationId)
    || envelope.idempotencyKey !== envelope.operationId || envelope.campaignId !== campaignId
    || envelope.localKey !== localKey || envelope.inputDigest !== jsonDigest(envelope.input)
    || typeof envelope.implementationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.implementationDigest)
    || !Number.isSafeInteger(envelope.decisionIndex) || envelope.decisionIndex < 0
    || envelope.operationId !== jsonDigest([campaignId, envelope.decisionIndex, localKey]))
    throw new Error('Historical operation envelope identity drift');
  if (typeof item.providerManifestDigest !== 'string') throw new Error('Historical provider manifest identity missing');
  assertDigest(item.providerManifestDigest);
  if (!['intent', 'running', 'unknown', 'completed', 'cancel-pending', 'cancelled'].includes(String(item.status))
    || item.status === 'completed' && !item.outcome
    || item.status !== 'completed' && item.outcome !== undefined)
    throw new Error('Historical operation status/outcome drift');
  if (item.outcome !== undefined) assertJson(item.outcome);
  return item as HistoricalOperation;
}

/** Replays the real local CampaignStore chain, including operations later cleared by decision.reduce. */
function committedFromChain(records: JournalRecord[], campaignId: string): Map<string, SeenOperation> {
  const seen = new Map<string, SeenOperation>();
  let identity: string | undefined, priorDecisionIndex = -1;
  for (const [index, { event, state: raw }] of records.entries()) {
    const state = object(raw, 'Campaign state');
    const spec = object(state.spec, 'Campaign spec');
    if (index === 0 && (event !== 'decision.initialize' || state.decisionIndex !== 0))
      throw new Error('Campaign journal has no kernel initialization commit');
    if (state.version !== 1 || spec.campaignId !== campaignId
      || !Number.isSafeInteger(state.decisionIndex) || (state.decisionIndex as number) < priorDecisionIndex)
      throw new Error('Campaign identity or decision history drift');
    priorDecisionIndex = state.decisionIndex as number;
    const currentIdentity = jsonDigest({ spec, algorithmManifestDigest: state.algorithmManifestDigest,
      kernelImplementationDigest: state.kernelImplementationDigest,
      providerCatalogDigest: state.providerCatalogDigest,
      storageBackendDigest: state.storageBackendDigest ?? null,
      initialBindingSetRef: state.initialBindingSetRef });
    if (identity !== undefined && identity !== currentIdentity) throw new Error('Campaign locked implementation or spec drift');
    identity = currentIdentity;
    const operations = object(state.operations, 'Campaign operations');
    const present = new Set<string>();
    let newCompletions = 0;
    for (const [localKey, value] of Object.entries(operations)) {
      const operation = envelopeRecord(value, localKey, campaignId);
      if (operation.envelope.decisionIndex !== state.decisionIndex)
        throw new Error('Historical operation decision index drift');
      const id = operation.envelope.operationId;
      if (present.has(id)) throw new Error('Campaign operation ID appears twice in one state');
      present.add(id);
      const previous = seen.get(id);
      if (previous && (previous.vanished || !same(previous.envelope, operation.envelope)
        || previous.providerManifestDigest !== operation.providerManifestDigest
        || previous.lastStatus === 'completed' && operation.status !== 'completed'
        || previous.outcome && !same(previous.outcome, operation.outcome)))
        throw new Error('Campaign operation identity or terminal outcome changed');
      const becameCompleted = operation.status === 'completed' && previous?.lastStatus !== 'completed';
      if (becameCompleted) {
        if (event !== 'operation.completed' && event !== 'operation.cancel-response')
          throw new Error('Rollout lacks a kernel terminal completion commit');
        newCompletions++;
      }
      const completed = becameCompleted ? { envelope: operation.envelope,
        providerManifestDigest: operation.providerManifestDigest,
        status: 'completed' as const, outcome: operation.outcome! } : previous?.completed;
      seen.set(id, { envelope: operation.envelope, providerManifestDigest: operation.providerManifestDigest,
        lastStatus: operation.status,
        ...(operation.outcome ?? previous?.outcome ? { outcome: (operation.outcome ?? previous?.outcome)! } : {}),
        vanished: false, released: operation.released === true, ...(completed ? { completed } : {}) });
    }
    if (event === 'operation.completed' && newCompletions !== 1
      || event === 'operation.cancel-response' && newCompletions > 1)
      throw new Error('Campaign completion event does not introduce exactly one completed operation');
    for (const [id, previous] of seen) if (!present.has(id) && !previous.vanished) {
      if (event !== 'decision.reduce' || !['completed', 'cancelled'].includes(previous.lastStatus)
        || previous.lastStatus === 'cancelled' && !previous.released)
        throw new Error('Campaign operation disappeared before terminal decision');
      previous.vanished = true;
    }
  }
  return seen;
}

/** No writer, provider dispatch, daemon command, artifact mutation, or second accounting source. */
export function createLocalCommittedRolloutResolver(options: LocalCommittedRolloutResolverOptions): CommittedRolloutResolver {
  const root = resolve(options.campaignJournalRoot);
  const limits = { records: options.maxRecords ?? 10_000,
    recordBytes: options.maxRecordBytes ?? 8 * 1024 * 1024,
    totalBytes: options.maxTotalBytes ?? 256 * 1024 * 1024 };
  if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)
    || limits.recordBytes > limits.totalBytes || limits.records > 100_000
    || limits.totalBytes > 1024 * 1024 * 1024)
    throw new Error('Invalid read-only Campaign journal bounds');
  const physicalManifest = options.physicalReader.describe();
  validateProviderManifest(physicalManifest);
  if (physicalManifest.kind !== 'execution.rollout') throw new Error('Physical reader is not a Hitch rollout');
  const physicalManifestDigest = jsonDigest(physicalManifest);
  const identityDigest = implementationClosureDigest(['author/committed-rollout-resolver'], {
    backend: 'local-CampaignStore.v1', root, limits, physicalManifestDigest });
  return {
    identityDigest,
    async resolve(campaignId, operationIds) {
      if (typeof campaignId !== 'string' || !campaignId
        || !Array.isArray(operationIds) || operationIds.length > 10_000
        || new Set(operationIds).size !== operationIds.length)
        throw new Error('Invalid committed rollout lookup');
      for (const id of operationIds) assertDigest(id);
      if (jsonDigest(options.physicalReader.describe()) !== physicalManifestDigest)
        throw new Error('Physical rollout reader manifest identity drift');
      // HEAD is read once. Every ancestor is hash-verified before any physical journal read.
      const history = committedFromChain(verifiedChain(root, limits.records, limits.recordBytes, limits.totalBytes), campaignId);
      const result: Record<string, CommittedRollout> = {};
      for (const id of operationIds) {
        const kernel = history.get(id)?.completed;
        if (!kernel) continue;
        if (kernel.envelope.kind !== 'execution.rollout') throw new Error('Named source is not a committed rollout');
        const physical = await options.physicalReader.readAuthorRolloutJournal(id);
        if (!physical || physical.status !== 'completed' || !physical.completion
          || physical.request?.phase !== 'author-candidate'
          || physical.requestDigest !== digestJson(physical.request)
          || physical.envelope.operationId !== id
          || physical.envelope.implementationDigest !== physicalManifest.implementationDigest
          || !same(physical.envelope, { ...kernel.envelope, implementationDigest: physicalManifest.implementationDigest })
          || physical.completion.operationId !== id
          || physical.completion.idempotencyKey !== physical.envelope.idempotencyKey
          || physical.completion.inputDigest !== physical.envelope.inputDigest
          || physical.completion.implementationDigest !== physical.envelope.implementationDigest
          || !same(physical.completion.outcome, kernel.outcome))
          throw new Error('Physical Hitch journal does not match kernel-committed rollout');
        result[id] = { ...kernel, physical: { status: 'completed', envelope: structuredClone(physical.envelope),
          completion: structuredClone(physical.completion), request: structuredClone(physical.request),
          requestDigest: physical.requestDigest,
          ...(physical.submittedIdentity === undefined ? {} : { submittedIdentity: structuredClone(physical.submittedIdentity) }) } };
      }
      if (jsonDigest(options.physicalReader.describe()) !== physicalManifestDigest)
        throw new Error('Physical rollout reader manifest changed during lookup');
      return result;
    },
  };
}
