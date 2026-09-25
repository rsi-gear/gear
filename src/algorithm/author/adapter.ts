import { randomBytes, randomUUID } from 'node:crypto';
import type { Algorithm, AlgorithmDecision, AlgorithmManifest, ArtifactRef, BindingSchema, BindingSetRef, DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js';
import { ALGORITHM_API_VERSION } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { verifyAuthorOutputGraph, verifyHarnessAgentBinding, type AuthorGraphPolicy } from './graph.js';
import { validateAuthorCheckpointInput } from './providers.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, validateSchema, type JsonSchema, type JsonValue } from '../schema.js';
import { AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2, authorIntentDigest,
  assertAuthorCapabilitiesV1, assertHarnessAgentV1, type AuthorCapabilitiesV1, type HarnessAgentV1,
  type AuthorAtomic, type AuthorHistoryEntry, type AuthorInput, type AuthorReplayReply, type AuthorReplayRequest } from './index.js';

export type ReplayPort = (request: AuthorReplayRequest) => Promise<AuthorReplayReply>;
export type AuthorWireVersion = typeof AUTHOR_WIRE_VERSION | typeof AUTHOR_WIRE_VERSION_V2;
type Pending = { address: string; localKey: string; kind: string; definitionVersion: string; inputDigest: string };
type AuthorState = { runnerVersion: AuthorWireVersion; historyHeadRef: ArtifactRef | null; pendingGroup: Pending[];
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
function state(value: JsonValue, version: AuthorWireVersion): AuthorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid author state');
  const candidate = value as AuthorState;
  if (candidate.runnerVersion !== version || !Array.isArray(candidate.pendingGroup)
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

type AuthorAdapterBase = {
    id: string; implementationDigest: string; hostIdentityDigest: string; bindingSchema: BindingSchema; artifacts: FileArtifactStore; bindings: BindingStore;
    replay: ReplayPort; initialAgent: JsonValue; data: JsonValue; maxFrontierWaves: number;
    clock?: () => number; seed?: () => number; newId?: () => string;
};
export type AuthorAdapterOptionsV1 = AuthorAdapterBase & { wireVersion?: typeof AUTHOR_WIRE_VERSION };
export type AuthorAdapterOptionsV2 = AuthorAdapterBase & {
  wireVersion: typeof AUTHOR_WIRE_VERSION_V2;
  initialAgent: HarnessAgentV1;
  capabilities: AuthorCapabilitiesV1;
  configSchema: JsonSchema;
  /** Frozen union from static source inspection and physical resolver. */
  requiredOperationKinds: string[];
  executionProfileDigest: string;
  /** Digest of the registered Git verifier and selected-Agent authorization policy, including frozen parameters. */
  trustedAgentPolicyDigest: string;
  /** Trusted host verifies the exact Git commit and manifest under its frozen repository. */
  verifyHarnessGit(commitOid: string, manifestDigest: string): Promise<void> | void;
  /** Trusted host decides which completed outcomes are authorized to become a selected Agent. */
  authorizeSelectedAgent(agent: HarnessAgentV1, initial: HarnessAgentV1,
    history: readonly AuthorHistoryEntry[]): Promise<void> | void;
};
export type AuthorAdapterOptions = AuthorAdapterOptionsV1 | AuthorAdapterOptionsV2;
const A1_BASE_KINDS = ['tasks.sample', 'tasks.consume', 'execution.workspace-edit', 'bindings.derive',
  'execution.rollout', 'author.measurement', 'author.checkpoint', 'author.observe'] as const;
const DIGEST = /^[a-f0-9]{64}$/;

/** Current harness policy: initial binding or a completed trusted derive; future hosts may supply another policy. */
export function authorizeInitialOrDerivedHarness(agent: HarnessAgentV1, initial: HarnessAgentV1,
  history: readonly AuthorHistoryEntry[]): void {
  const selected = agent.bindingSetRef;
  if (canonicalJson(selected) === canonicalJson(initial.bindingSetRef)) return;
  if (history.some(item => item.kind === 'bindings.derive' && item.outcome.kind === 'result'
    && item.outcome.value && typeof item.outcome.value === 'object' && !Array.isArray(item.outcome.value)
    && Object.hasOwn(item.outcome.value, 'bindingSetRef')
    && canonicalJson(item.outcome.value.bindingSetRef) === canonicalJson(selected))) return;
  throw new Error('Selected HarnessAgent was not produced by this Campaign');
}
/** The only mutable workflow state is the AlgorithmRuntime's Campaign state. */
export class AuthorAlgorithmAdapter implements Algorithm {
  readonly options: Readonly<AuthorAdapterBase>;
  private readonly wireVersion: AuthorWireVersion;
  private readonly configSchema: JsonSchema;
  private readonly requiredKinds: string[];
  private readonly v2: { capabilities: AuthorCapabilitiesV1; executionProfileDigest: string; trustedAgentPolicyDigest: string;
    verifyHarnessGit: AuthorAdapterOptionsV2['verifyHarnessGit'];
    authorizeSelectedAgent: AuthorAdapterOptionsV2['authorizeSelectedAgent'] } | undefined;
  constructor(options: AuthorAdapterOptions) {
    assertJson(options.initialAgent); assertJson(options.data); assertJson(options.bindingSchema);
    if (!/^[a-f0-9]{64}$/.test(options.implementationDigest) || !/^[a-f0-9]{64}$/.test(options.hostIdentityDigest))
      throw new Error('Author source/host identity digests required');
    if (!Number.isSafeInteger(options.maxFrontierWaves) || options.maxFrontierWaves < 1)
      throw new Error('Explicit positive maxFrontierWaves required');
    this.wireVersion = options.wireVersion ?? AUTHOR_WIRE_VERSION;
    if (this.wireVersion !== AUTHOR_WIRE_VERSION && this.wireVersion !== AUTHOR_WIRE_VERSION_V2)
      throw new Error('Unsupported author adapter wire version');
    if (this.wireVersion === AUTHOR_WIRE_VERSION_V2) {
      if (options.wireVersion !== AUTHOR_WIRE_VERSION_V2) throw new Error('A1 adapter wire version required');
      assertAuthorCapabilitiesV1(options.capabilities);
      assertHarnessAgentV1(options.initialAgent);
      assertSchema(options.configSchema);
      if (!DIGEST.test(options.executionProfileDigest) || !DIGEST.test(options.trustedAgentPolicyDigest)
        || typeof options.verifyHarnessGit !== 'function'
        || typeof options.authorizeSelectedAgent !== 'function') throw new Error('A1 trusted harness verifier/policy required');
      if (!Array.isArray(options.requiredOperationKinds)
        || options.requiredOperationKinds.some(kind => typeof kind !== 'string'
          || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(kind)
          || /^author\.(?:role|edit|rollout|measure)$/.test(kind)))
        throw new Error('A1 required provider kinds invalid');
      if (Object.keys(options.capabilities.operationLimits).some(kind => /^author\.(?:role|edit|rollout|measure)$/.test(kind)))
        throw new Error('A0 fake operation limits are forbidden in A1');
      const kinds = [...A1_BASE_KINDS, ...options.requiredOperationKinds, ...Object.keys(options.capabilities.operationLimits)];
      if (Object.values(options.capabilities.roles).some(role => role.kind === 'execution.role')) kinds.push('execution.role');
      this.requiredKinds = [...new Set(kinds)].sort();
      this.configSchema = freezeDeep(JSON.parse(canonicalJson(options.configSchema)) as JsonSchema);
      this.v2 = { capabilities: freezeDeep(JSON.parse(canonicalJson(options.capabilities)) as AuthorCapabilitiesV1),
        executionProfileDigest: options.executionProfileDigest, trustedAgentPolicyDigest: options.trustedAgentPolicyDigest,
        verifyHarnessGit: options.verifyHarnessGit, authorizeSelectedAgent: options.authorizeSelectedAgent };
    } else {
      if ('capabilities' in options || 'executionProfileDigest' in options || 'trustedAgentPolicyDigest' in options
        || 'configSchema' in options || 'verifyHarnessGit' in options || 'authorizeSelectedAgent' in options)
        throw new Error('A1 author options require explicit v2 wire version');
      this.requiredKinds = ['author.observe', 'author.checkpoint'];
      this.configSchema = { type: 'object', additionalProperties: true };
    }
    this.initialAgent = freezeDeep(JSON.parse(canonicalJson(options.initialAgent)) as JsonValue);
    this.data = freezeDeep(JSON.parse(canonicalJson(options.data)) as JsonValue);
    this.bindingSchema = freezeDeep(JSON.parse(canonicalJson(options.bindingSchema)) as BindingSchema);
    this.options = Object.freeze({ ...options, initialAgent: this.initialAgent, data: this.data, bindingSchema: this.bindingSchema });
  }
  private readonly initialAgent: JsonValue;
  private readonly data: JsonValue;
  private readonly bindingSchema: BindingSchema;
  private graphPolicy(): AuthorGraphPolicy {
    return this.v2 ? { wireVersion: 'v2', executionProfileDigest: this.v2.executionProfileDigest } : { wireVersion: 'v1' };
  }
  private async verifyAgent(agent: HarnessAgentV1): Promise<void> {
    if (!this.v2) throw new Error('A1 Agent verification requested in A0');
    const harness = verifyHarnessAgentBinding(this.options.artifacts, this.options.bindings,
      agent, this.v2.executionProfileDigest);
    await this.v2.verifyHarnessGit(harness.commitOid, harness.manifestDigest);
  }
  describe(): AlgorithmManifest {
    return { id: this.options.id, apiVersion: ALGORITHM_API_VERSION, implementationDigest: jsonDigest({ sourceDigest: this.options.implementationDigest, hostIdentityDigest: this.options.hostIdentityDigest,
        initialAgent: this.initialAgent, data: this.data, maxFrontierWaves: this.options.maxFrontierWaves, runnerVersion: this.wireVersion,
        ...(this.v2 ? { configSchema: this.configSchema, capabilities: this.v2.capabilities,
          executionProfileDigest: this.v2.executionProfileDigest, trustedAgentPolicyDigest: this.v2.trustedAgentPolicyDigest,
          requiredKinds: this.requiredKinds } : {}) }),
      bindingSchema: this.bindingSchema, configSchema: this.configSchema,
      stateSchema: { type: 'object', additionalProperties: true },
      requiredOperationKinds: this.requiredKinds };
  }
  private emptyState(): AuthorState {
    return { runnerVersion: this.wireVersion, historyHeadRef: null, pendingGroup: [], outputsRef: null, resultRef: null, frontierWaves: 0 };
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
    this.validateHistory(entries);
    if (Buffer.byteLength(canonicalJson(entries)) > 1024 * 1024) throw new Error('Author history exceeds replay wire limit');
    return entries;
  }
  private validateHistory(entries: readonly AuthorHistoryEntry[]): void {
    const addresses = new Set<string>(), operationIds = new Set<string>();
    for (const entry of entries) {
      if (addresses.has(entry.address)) throw new Error('Author history address duplicated');
      addresses.add(entry.address);
      if (this.wireVersion === AUTHOR_WIRE_VERSION_V2) {
        if (typeof entry.operationId !== 'string' || !DIGEST.test(entry.operationId)
          || operationIds.has(entry.operationId)) throw new Error('A1 history operation ID missing, invalid or repeated');
        operationIds.add(entry.operationId);
      } else if (entry.operationId !== undefined) throw new Error('A0 history cannot carry A1 operation ID');
    }
  }
  private append(previous: ArtifactRef | null, entries: AuthorHistoryEntry[]): ArtifactRef {
    this.validateHistory(entries);
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
    if (this.v2) {
      validateSchema(this.configSchema, context.config);
      const initial = this.initialAgent as HarnessAgentV1;
      if (current.frontierWaves === 0 && canonicalJson(initial.bindingSetRef) !== canonicalJson(context.activeBindingSetRef))
        throw new Error('A1 initial Agent and Campaign active binding differ');
      await this.verifyAgent(initial);
    }
    const input: AuthorInput = { initialAgent: this.initialAgent, data: this.data, config: context.config,
      ...(this.v2 ? { capabilities: this.v2.capabilities } : {}) } as AuthorInput;
    const request: AuthorReplayRequest = this.v2
      ? { version: AUTHOR_WIRE_VERSION_V2, input: input as import('./a1-contract.js').AuthorInputV2, history }
      : { version: AUTHOR_WIRE_VERSION, input, history };
    const reply = await this.options.replay(request);
    assertJson(reply);
    if (reply.status === 'completed') {
      verifyAuthorOutputGraph(this.options.artifacts, this.options.bindings, reply.result, this.graphPolicy());
      const result = reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result) ? reply.result : {};
      const selected = result.selected;
      let transition: { bindingTransition: BindingSetRef } | {} = {};
      if (this.v2 && selected !== undefined) {
        assertHarnessAgentV1(selected);
        await this.verifyAgent(selected);
        await this.v2.authorizeSelectedAgent(selected, this.initialAgent as HarnessAgentV1, history);
        transition = { bindingTransition: selected.bindingSetRef };
      } else if (!this.v2 && selected && typeof selected === 'object' && !Array.isArray(selected)
        && selected.kind === 'binding-set') {
        transition = { bindingTransition: selected as BindingSetRef };
      }
      const resultRef = this.options.artifacts.putJson(reply.result, RESULT_SCHEMA);
      const outputsRef = result.outputs && typeof result.outputs === 'object' && !Array.isArray(result.outputs)
        ? this.options.artifacts.putJson({ campaignId: context.campaignId, outputs: result.outputs }, OUTPUTS_SCHEMA) : null;
      const nextState: AuthorState = { ...current, pendingGroup: [], resultRef, outputsRef };
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
      if (item.kind === 'author.checkpoint')
        validateAuthorCheckpointInput(this.options.artifacts, this.options.bindings, item.input, this.graphPolicy());
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
    const current = state(context.state, this.wireVersion);
    if (current.pendingGroup.length === 0) throw new Error('Author reduce without pending group');
    if (this.v2 && (!context.completedOperationIds
      || canonicalJson(Object.keys(context.completedOperationIds).sort())
        !== canonicalJson(current.pendingGroup.map(item => item.localKey).sort())))
      throw new Error('A1 kernel completed operation ID projection missing or inconsistent');
    const entries: AuthorHistoryEntry[] = current.pendingGroup.map(item => {
      const outcome = context.completed[item.localKey];
      if (!outcome) throw new Error(`Missing terminal outcome ${item.localKey}`);
      const operationId = context.completedOperationIds?.[item.localKey];
      if (this.v2 && (typeof operationId !== 'string' || !DIGEST.test(operationId)))
        throw new Error(`A1 kernel completed operation ID missing for ${item.localKey}`);
      return { address: item.address, kind: item.kind, definitionVersion: item.definitionVersion, inputDigest: item.inputDigest, outcome,
        ...(this.v2 ? { operationId: operationId! } : {}) };
    });
    const historyHeadRef = this.append(current.historyHeadRef, entries);
    const next: AuthorState = { ...current, historyHeadRef, pendingGroup: [] };
    return this.plan(context, next, this.history(historyHeadRef));
  }
  readHistory(snapshot: { state: JsonValue }): AuthorHistoryEntry[] { return this.history(state(snapshot.state, this.wireVersion).historyHeadRef); }
  readResult(snapshot: { state: JsonValue }): JsonValue | null {
    const ref = state(snapshot.state, this.wireVersion).resultRef;
    if (!ref) return null;
    const result = this.options.artifacts.getJson(ref);
    verifyAuthorOutputGraph(this.options.artifacts, this.options.bindings, result, this.graphPolicy());
    return result;
  }
}
