import { randomBytes, randomUUID } from 'node:crypto';
import type { Algorithm, AlgorithmDecision, AlgorithmManifest, ArtifactRef, BindingSchema, DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js';
import { ALGORITHM_API_VERSION } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { verifyAuthorOutputGraph } from './graph.js';
import { validateAuthorCheckpointInput } from './providers.js';
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { AUTHOR_WIRE_VERSION, authorIntentDigest, type AuthorAtomic, type AuthorHistoryEntry, type AuthorInput, type AuthorReplayReply, type AuthorReplayRequest } from './index.js';

export type ReplayPort = (request: AuthorReplayRequest) => Promise<AuthorReplayReply>;
type Pending = { address: string; localKey: string; kind: string; definitionVersion: string; inputDigest: string };
type AuthorState = { runnerVersion: typeof AUTHOR_WIRE_VERSION; historyHeadRef: ArtifactRef | null; pendingGroup: Pending[];
  outputsRef: ArtifactRef | null; resultRef: ArtifactRef | null; frontierWaves: number };
type HistoryPage = { previous: ArtifactRef | null; entries: AuthorHistoryEntry[] };
const HISTORY_PAGE_SCHEMA = 'author.history-page.v1';
const RESULT_SCHEMA = 'author.result.v1';
const OUTPUTS_SCHEMA = 'author.outputs.v1';

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function state(value: JsonValue): AuthorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid author state');
  const candidate = value as AuthorState;
  if (candidate.runnerVersion !== AUTHOR_WIRE_VERSION || !Array.isArray(candidate.pendingGroup)
    || !Number.isSafeInteger(candidate.frontierWaves) || candidate.frontierWaves < 0)
    throw new Error('Author state identity drift');
  return candidate;
}
function key(address: string): string {
  if (!/^r(?:\/(?:s|p|stage|task|candidate)[A-Za-z0-9._-]+)*$/.test(address)) throw new Error(`Invalid author address ${address}`);
  const localKey = `a.${address.replaceAll('/', '.')}`;
  if (localKey.length > 128) throw new Error(`Author address exceeds kernel local-key limit: ${address}`);
  return localKey;
}
export class AuthorStepLimitExceeded extends Error {
  constructor(readonly committed: number, readonly limit: number) { super(`AuthorStepLimitExceeded: ${committed}/${limit} frontier waves committed`); }
}

export type AuthorAdapterOptions = {
    id: string; implementationDigest: string; hostIdentityDigest: string; bindingSchema: BindingSchema; artifacts: FileArtifactStore; bindings: BindingStore;
    replay: ReplayPort; initialAgent: JsonValue; data: JsonValue; maxFrontierWaves: number;
    clock?: () => number; seed?: () => number; newId?: () => string;
};
/** The only mutable workflow state is the AlgorithmRuntime's Campaign state. */
export class AuthorAlgorithmAdapter implements Algorithm {
  readonly options: Readonly<AuthorAdapterOptions>;
  constructor(options: AuthorAdapterOptions) {
    assertJson(options.initialAgent); assertJson(options.data); assertJson(options.bindingSchema);
    if (!/^[a-f0-9]{64}$/.test(options.implementationDigest) || !/^[a-f0-9]{64}$/.test(options.hostIdentityDigest))
      throw new Error('Author source/host identity digests required');
    if (!Number.isSafeInteger(options.maxFrontierWaves) || options.maxFrontierWaves < 1)
      throw new Error('Explicit positive maxFrontierWaves required');
    this.initialAgent = freezeDeep(JSON.parse(canonicalJson(options.initialAgent)) as JsonValue);
    this.data = freezeDeep(JSON.parse(canonicalJson(options.data)) as JsonValue);
    this.bindingSchema = freezeDeep(JSON.parse(canonicalJson(options.bindingSchema)) as BindingSchema);
    this.options = Object.freeze({ ...options, initialAgent: this.initialAgent, data: this.data, bindingSchema: this.bindingSchema });
  }
  private readonly initialAgent: JsonValue;
  private readonly data: JsonValue;
  private readonly bindingSchema: BindingSchema;
  describe(): AlgorithmManifest {
    return { id: this.options.id, apiVersion: ALGORITHM_API_VERSION, implementationDigest: jsonDigest({ sourceDigest: this.options.implementationDigest, hostIdentityDigest: this.options.hostIdentityDigest,
        initialAgent: this.initialAgent, data: this.data, maxFrontierWaves: this.options.maxFrontierWaves, runnerVersion: AUTHOR_WIRE_VERSION }),
      bindingSchema: this.bindingSchema, configSchema: { type: 'object', additionalProperties: true },
      stateSchema: { type: 'object', additionalProperties: true },
      requiredOperationKinds: ['author.observe', 'author.checkpoint'] };
  }
  private emptyState(): AuthorState {
    return { runnerVersion: AUTHOR_WIRE_VERSION, historyHeadRef: null, pendingGroup: [], outputsRef: null, resultRef: null, frontierWaves: 0 };
  }
  private history(head: ArtifactRef | null): AuthorHistoryEntry[] {
    const pages: HistoryPage[] = [];
    const seen = new Set<string>();
    while (head) {
      if (seen.has(head.digest)) throw new Error('Author history cycle');
      seen.add(head.digest);
      if (head.schemaId !== HISTORY_PAGE_SCHEMA || head.size > 256 * 1024) throw new Error('Invalid author history page');
      const page = this.options.artifacts.getJson(head) as HistoryPage;
      if (!page || !Array.isArray(page.entries)) throw new Error('Invalid author history page content');
      pages.push(page);
      head = page.previous;
    }
    const entries = pages.reverse().flatMap(page => page.entries);
    if (Buffer.byteLength(canonicalJson(entries)) > 1024 * 1024) throw new Error('Author history exceeds A0 replay wire limit');
    return entries;
  }
  private append(previous: ArtifactRef | null, entries: AuthorHistoryEntry[]): ArtifactRef {
    const page: HistoryPage = { previous, entries };
    const bytes = Buffer.byteLength(canonicalJson(page));
    if (bytes > 256 * 1024) throw new Error('Author history page exceeds 256 KiB');
    return this.options.artifacts.putJson(page as JsonValue, HISTORY_PAGE_SCHEMA);
  }
  private observe(item: AuthorAtomic, context: DecisionContext): JsonValue {
    const request = item.input as { kind?: string };
    const kind = request.kind;
    const value: JsonValue = kind === 'budget' ? (context.budget ?? { dimensions: {} }) as JsonValue
      : kind === 'now' ? (this.options.clock ?? Date.now)()
      : kind === 'random-seed' ? (this.options.seed ?? (() => randomBytes(4).readUInt32BE(0)))()
      : kind === 'id' ? (this.options.newId ?? randomUUID)()
      : (() => { throw new Error(`Unknown author observation kind: ${kind}`); })();
    assertJson(value);
    return { kind, value, campaignId: context.campaignId, decisionIndex: context.decisionIndex,
      snapshotDigest: jsonDigest({ budget: context.budget ?? null, decisionIndex: context.decisionIndex }) };
  }
  private async plan(context: DecisionContext, current: AuthorState, history: AuthorHistoryEntry[]): Promise<AlgorithmDecision> {
    const input: AuthorInput = { initialAgent: this.initialAgent, data: this.data, config: context.config };
    const reply = await this.options.replay({ version: AUTHOR_WIRE_VERSION, input, history });
    assertJson(reply);
    if (reply.status === 'completed') {
      verifyAuthorOutputGraph(this.options.artifacts, this.options.bindings, reply.result);
      const resultRef = this.options.artifacts.putJson(reply.result, RESULT_SCHEMA);
      const result = reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result) ? reply.result : {};
      const outputsRef = result.outputs && typeof result.outputs === 'object' && !Array.isArray(result.outputs)
        ? this.options.artifacts.putJson({ campaignId: context.campaignId, outputs: result.outputs }, OUTPUTS_SCHEMA) : null;
      const nextState: AuthorState = { ...current, pendingGroup: [], resultRef, outputsRef };
      const selected = result.selected;
      const transition = selected && typeof selected === 'object' && !Array.isArray(selected)
        && selected.kind === 'binding-set' ? { bindingTransition: selected as unknown as import('../contracts.js').BindingSetRef } : {};
      return { nextState: nextState as JsonValue, complete: true, ...transition };
    }
    if (reply.status !== 'waiting' || !Array.isArray(reply.frontier) || reply.frontier.length === 0) throw new Error('Author replay produced empty frontier');
    const maxWaves = this.options.maxFrontierWaves;
    if (current.frontierWaves >= maxWaves) throw new AuthorStepLimitExceeded(current.frontierWaves, maxWaves);
    const pendingGroup: Pending[] = [];
    const operations: OperationIntent[] = [];
    const seen = new Set<string>();
    for (const item of reply.frontier) {
      const localKey = key(item.address);
      if (seen.has(localKey)) throw new Error(`Duplicate author address ${item.address}`);
      seen.add(localKey);
      const pureControl = item.kind === 'author.observe' || item.kind === 'author.checkpoint';
      if (item.kind === 'author.checkpoint') validateAuthorCheckpointInput(this.options.artifacts, this.options.bindings, item.input);
      if (pureControl && (item.bindingSetRef !== undefined || (item.startsBudgetClock !== undefined && item.startsBudgetClock !== false)
        || (item.limits !== undefined && (item.limits === null || Array.isArray(item.limits)
          || typeof item.limits !== 'object' || Object.keys(item.limits).length > 0))))
        throw new Error('Author pure control operation cannot request binding override, budget or clock start');
      const input = item.kind === 'author.observe' ? this.observe(item, context) : item.input;
      pendingGroup.push({ address: item.address, localKey, kind: item.kind, definitionVersion: item.definitionVersion, inputDigest: authorIntentDigest(item) });
      operations.push({ localKey, kind: item.kind, input,
        ...(item.bindingSetRef ? { bindingSetRef: item.bindingSetRef } : {}),
        limits: item.kind === 'author.observe' || item.kind === 'author.checkpoint' ? {} : item.limits ?? {},
        startsBudgetClock: item.kind === 'author.observe' || item.kind === 'author.checkpoint' ? false : item.startsBudgetClock ?? true });
    }
    return { nextState: { ...current, pendingGroup, frontierWaves: current.frontierWaves + 1 } as JsonValue, operations };
  }
  initialize(context: DecisionContext): Promise<AlgorithmDecision> { return this.plan(context, this.emptyState(), []); }
  async reduce(context: ReduceContext): Promise<AlgorithmDecision> {
    const current = state(context.state);
    if (current.pendingGroup.length === 0) throw new Error('Author reduce without pending group');
    const entries: AuthorHistoryEntry[] = current.pendingGroup.map(item => {
      const outcome = context.completed[item.localKey];
      if (!outcome) throw new Error(`Missing terminal outcome ${item.localKey}`);
      return { address: item.address, kind: item.kind, definitionVersion: item.definitionVersion, inputDigest: item.inputDigest, outcome };
    });
    const historyHeadRef = this.append(current.historyHeadRef, entries);
    const next: AuthorState = { ...current, historyHeadRef, pendingGroup: [] };
    return this.plan(context, next, this.history(historyHeadRef));
  }
  readHistory(snapshot: { state: JsonValue }): AuthorHistoryEntry[] { return this.history(state(snapshot.state).historyHeadRef); }
  readResult(snapshot: { state: JsonValue }): JsonValue | null {
    const ref = state(snapshot.state).resultRef;
    if (!ref) return null;
    const result = this.options.artifacts.getJson(ref);
    verifyAuthorOutputGraph(this.options.artifacts, this.options.bindings, result);
    return result;
  }
}
