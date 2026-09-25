import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson, assertJson, jsonDigest, validateSchema, type JsonSchema, type JsonValue } from '../schema.js';
import type { ArtifactRef, BindingSetRef, OperationOutcome } from '../contracts.js';
import { AUTHOR_WIRE_VERSION_V2, assertAuthorCapabilitiesV1, assertHarnessAgentV1, assertAuthorConfigSchema,
  assertTaskSelectionV1, assertEvaluationV1, assertProposalBatchV1, decodeRoleExecutionResult,
  type AuthorCapabilitiesV1, type AuthorInputV2, type RoleResultV1, type TaskSelectionV1,
  type ProposalBatchV1, type ProposalFailureV1, type AuthorProposalEditInputV1,
  type EvaluationV1, type AuthorSelectionConfigV1,
  type AuthorEvaluationConfigV1, type HarnessAgentV1 } from './a1-contract.js';
export { AUTHOR_WIRE_VERSION_V2, AUTHOR_CAPABILITIES_VERSION, assertAuthorCapabilitiesV1, assertHarnessAgentV1,
  assertTaskSelectionV1, assertRoleResultV1, assertProposalBatchV1, assertEvaluationV1 } from './a1-contract.js';
export type { AuthorCapabilitiesV1, AuthorInputV2, HarnessAgentV1, TaskSelectionV1, RoleResultV1,
  ProposalFailureV1, ProposalBatchV1, TrialV1, EvaluationV1 } from './a1-contract.js';

export const AUTHOR_WIRE_VERSION = 'gear.author.replay.v1' as const;
export type AuthorInputV1 = { initialAgent: JsonValue; data: JsonValue; config: JsonValue };
export type AuthorInput = AuthorInputV1 | AuthorInputV2;
/** The usual v2 research data shape; a custom algorithm can supply its own data type. */
export type AuthorResearchDataV1 = { searchTasks: ArtifactRef; readonly [key: string]: unknown };
export type AuthorHistoryEntry = { address: string; kind: string; definitionVersion: string; inputDigest: string; outcome: OperationOutcome;
  /** V2 only: actual committed kernel operation ID. V1 history omits this field. */ operationId?: string };
export type TrackedOperationResult = { operationId: string; outcome: OperationOutcome };
export type AuthorAtomic = { address: string; kind: string; definitionVersion: string; input: JsonValue; bindingSetRef?: BindingSetRef; limits?: Record<string, number>; startsBudgetClock?: boolean };
export type AuthorReplayRequest = { version: typeof AUTHOR_WIRE_VERSION; input: AuthorInputV1; history: AuthorHistoryEntry[] }
  | { version: typeof AUTHOR_WIRE_VERSION_V2; input: AuthorInputV2; history: AuthorHistoryEntry[] };
export type AuthorReplayReply = { status: 'waiting'; frontier: AuthorAtomic[] } | { status: 'completed'; result: JsonValue };
export type AuthorError = { kind: Exclude<OperationOutcome['kind'], 'result'>; code?: string; message?: string; reason?: string; retryable?: boolean };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AuthorError };
export type OperationOptions = { bindingSetRef?: BindingSetRef; limits?: Record<string, number>; startsBudgetClock?: boolean };
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type AuthorRoleResult = DeepReadonly<RoleResultV1>;
export type AuthorTaskSelection = DeepReadonly<TaskSelectionV1>;
export type AuthorEvaluation = DeepReadonly<EvaluationV1>;
export type AuthorSelectionResult = { agent: DeepReadonly<AuthorInputV2['initialAgent']>;
  evaluation: AuthorEvaluation };
/** The generated search example uses an ordinary interface; runtime validates its declared schema. */
export interface SearchConfig { rounds: number; taskCount: number; proposalCount: number; seed: number }
export const searchConfigSchema: JsonSchema = { type: 'object', required: ['rounds', 'taskCount', 'proposalCount', 'seed'],
  properties: { rounds: { type: 'integer', minimum: 1 }, taskCount: { type: 'integer', minimum: 1 },
    proposalCount: { type: 'integer', minimum: 1 }, seed: { type: 'integer' } }, additionalProperties: false };
export type SearchRoundRecord = { readonly round: number; readonly baseline: AuthorEvaluation;
  readonly proposals: DeepReadonly<ProposalBatchV1>; readonly evaluations: readonly Outcome<AuthorEvaluation>[];
  readonly selected: DeepReadonly<HarnessAgentV1> };

/** Author inputs accept frozen SDK DTOs and recursively readonly JSON; replay still validates actual JSON bytes. */
export type AuthorJsonValue = null | string | number | boolean | readonly AuthorJsonValue[]
  | { readonly [key: string]: AuthorJsonValue }
  | DeepReadonly<BindingSetRef> | DeepReadonly<ArtifactRef> | DeepReadonly<AuthorInputV2['initialAgent']>
  | AuthorRoleResult | AuthorTaskSelection | DeepReadonly<ProposalBatchV1> | DeepReadonly<EvaluationV1>
  | DeepReadonly<SearchRoundRecord>;
export type AuthorResult = { selected?: AuthorJsonValue; outputs?: Record<string, AuthorJsonValue> };
export function authorIntentDigest(item: { input: JsonValue } & OperationOptions): string {
  return jsonDigest({ input: item.input, ...(item.bindingSetRef ? { bindingSetRef: item.bindingSetRef } : {}),
    ...(item.limits ? { limits: item.limits } : {}),
    ...(item.startsBudgetClock === undefined ? {} : { startsBudgetClock: item.startsBudgetClock }) });
}

type Scope = { runner: ReplayRunner; path: string; next: number; definitionVersion: string };
type Action<T> =
  | { tag: 'atomic'; kind: string; input: JsonValue; options: OperationOptions; decode?: (value: JsonValue) => T; tracked?: true }
  | { tag: 'parallel'; children: ManagedCall<unknown>[] }
  | { tag: 'workflow'; fn: (ctx: AuthorContext, ...args: JsonValue[]) => Promise<T> | T; args: JsonValue[]; version: string };
const activeScope = new AsyncLocalStorage<Scope>();

function clone<T>(value: T): T { assertJson(value); return JSON.parse(canonicalJson(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function freezeManaged<T>(scope: Scope, value: T, label: string): T {
  try { return deepFreeze(clone(value)); }
  catch (error) {
    scope.runner.recordFatal(`${label} invalid: ${error instanceof Error ? error.message : String(error)}`, sourceLocation());
  }
}
function sourceLocation(): string {
  const frames = new Error().stack?.split('\n').slice(1) ?? [];
  return frames.find(line => !line.includes('/algorithm/author/') && !line.includes('node:internal'))?.trim() ?? 'unknown source';
}
function fail(message: string, location?: string): never { throw new Error(`Author replay: ${message}${location ? ` (${location})` : ''}`); }

/** Same decimal-rational half-up comparison as search/contracts.comparisonKey. */
function metricComparisonKey(value: number, quantum: number): bigint {
  const decimal = (number: number): { n: bigint; d: bigint } => {
    if (!Number.isFinite(number)) throw new Error('Selection metric must be finite');
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(String(number));
    if (!match) throw new Error('Selection decimal representation invalid');
    const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
    const digits = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
    return scale < 0 ? { n: digits * 10n ** BigInt(-scale), d: 1n }
      : { n: digits, d: 10n ** BigInt(scale) };
  };
  if (!Number.isFinite(quantum) || quantum <= 0) throw new Error('Selection comparison precision invalid');
  const raw = decimal(value), step = decimal(quantum);
  const n = 2n * raw.n * step.d + raw.d * step.n;
  const d = 2n * raw.d * step.n;
  const q = n / d;
  return n < 0n && n % d !== 0n ? q - 1n : q;
}

/** Calling a managed operation only freezes its input. Then/await transfers control to the replay driver. */
export class ManagedCall<T> implements PromiseLike<T> {
  readonly creationLocation = sourceLocation();
  readonly creationScope: Scope;
  readonly ordinal: number;
  private consumed = false;
  constructor(readonly action: Action<T>, scope: Scope) {
    this.creationScope = scope;
    this.ordinal = scope.next++;
    scope.runner.register(this);
  }
  start(scope: Scope = this.creationScope, parallelTransfer = false): Promise<T> {
    if (this.consumed) this.creationScope.runner.recordFatal('ManagedCall consumed more than once', this.creationLocation);
    if (scope.runner !== this.creationScope.runner) this.creationScope.runner.recordFatal('ManagedCall crossed replay runs', this.creationLocation);
    if (scope !== this.creationScope && !parallelTransfer) this.creationScope.runner.recordFatal('ManagedCall consumed outside its creation scope', this.creationLocation);
    this.consumed = true;
    scope.runner.consumed(this);
    const address = `${scope.path}/s${scope === this.creationScope ? this.ordinal : scope.next++}`;
    return scope.runner.runCall(this.action, address, scope.definitionVersion);
  }
  then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    const scope = activeScope.getStore() ?? this.creationScope;
    return this.start(scope).then(onfulfilled, onrejected);
  }
}

export class AuthorOperationError extends Error {
  constructor(readonly outcome: Exclude<OperationOutcome, { kind: 'result' }>) {
    super(outcome.kind === 'error' ? `${outcome.code}: ${outcome.message}` : `${outcome.kind}: ${outcome.reason ?? ''}`);
    this.name = 'AuthorOperationError';
  }
  toAuthorError(): AuthorError { return clone(this.outcome as JsonValue) as AuthorError; }
}

export class AuthorContext<TConfig = JsonValue, TVersion extends 'v1' | 'v2' = 'v2', TData = AuthorResearchDataV1> {
  readonly initialAgent: TVersion extends 'v2' ? DeepReadonly<AuthorInputV2['initialAgent']> : JsonValue;
  readonly data: TVersion extends 'v2' ? DeepReadonly<TData> : DeepReadonly<JsonValue>;
  readonly config: DeepReadonly<TConfig>;
  readonly capabilities: TVersion extends 'v2' ? DeepReadonly<AuthorCapabilitiesV1> : undefined;
  readonly tasks: { sample: (sourceTaskViewRef: DeepReadonly<ArtifactRef>, options: { count: number; seed: number }) => ManagedCall<AuthorTaskSelection> };
  constructor(readonly scope: Scope, input: AuthorInput) {
    this.initialAgent = deepFreeze(clone(input.initialAgent)) as typeof this.initialAgent;
    this.data = deepFreeze(clone(input.data)) as typeof this.data;
    this.config = deepFreeze(clone(input.config)) as typeof this.config;
    this.capabilities = ('capabilities' in input ? deepFreeze(clone(input.capabilities as JsonValue) as AuthorCapabilitiesV1)
      : undefined) as typeof this.capabilities;
    this.tasks = { sample: (sourceTaskViewRef, options) => {
      if (!this.capabilities) this.scope.runner.recordFatal('tasks.sample requires A1 capabilities');
      if (!sourceTaskViewRef || sourceTaskViewRef.kind !== 'artifact' || sourceTaskViewRef.schemaId !== 'task.view.v1'
        || !Number.isSafeInteger(options.count) || options.count < 1 || !Number.isSafeInteger(options.seed))
        this.scope.runner.recordFatal('tasks.sample requires a task view, positive count and safe seed');
      return this.typedOperation<AuthorTaskSelection>('tasks.sample', { sourceTaskViewRef, count: options.count, seed: options.seed },
        { limits: {}, startsBudgetClock: false }, value => {
          assertTaskSelectionV1(value);
          if (value.selectedTaskIds.length !== options.count) throw new Error('TaskSelection count mismatch');
          return value;
        });
    } };
    Object.freeze(this.tasks);
    Object.freeze(this);
  }
  operation<T extends JsonValue = JsonValue>(kind: string, input: AuthorJsonValue, options: OperationOptions = {}): ManagedCall<T> {
    return this.typedOperation<T>(kind, input, options);
  }
  /** @internal Only built-in A1 workflows should use the tracked terminal outcome. The provider still verifies the ID against the Campaign journal. */
  trackedOperation(kind: 'execution.rollout', input: AuthorJsonValue, options: OperationOptions = {}): ManagedCall<TrackedOperationResult> {
    if (!this.capabilities || kind !== 'execution.rollout') this.scope.runner.recordFatal('tracked operation requires A1 execution.rollout');
    return new ManagedCall<TrackedOperationResult>({ tag: 'atomic', kind,
      input: freezeManaged(this.scope, input, 'tracked operation input') as JsonValue,
      options: freezeManaged(this.scope, options, 'tracked operation options') as OperationOptions,
      tracked: true }, this.scope);
  }
  private typedOperation<T>(kind: string, input: AuthorJsonValue, options: OperationOptions,
    decode?: (value: JsonValue) => T): ManagedCall<T> {
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(kind))
      this.scope.runner.recordFatal('operation kind invalid');
    if (this.capabilities && /^author\.(?:role|edit|rollout|measure)$/.test(kind))
      this.scope.runner.recordFatal(`A0 fake operation ${kind} is not available in A1`);
    const normalized = freezeManaged(this.scope, input, 'operation input');
    const frozenOptions = freezeManaged(this.scope, options, 'operation options');
    return new ManagedCall<T>({ tag: 'atomic', kind, input: normalized as JsonValue,
      options: frozenOptions as OperationOptions, ...(decode ? { decode } : {}) }, this.scope);
  }
  parallel<T extends readonly ManagedCall<unknown>[]>(calls: T): ManagedCall<{ [K in keyof T]: T[K] extends ManagedCall<infer V> ? Outcome<V> : never }> {
    if (!Array.isArray(calls) || !calls.every(call => call instanceof ManagedCall))
      this.scope.runner.recordFatal('parallel requires ManagedCall array');
    if (new Set(calls).size !== calls.length) this.scope.runner.recordFatal('ManagedCall appears in parallel more than once');
    for (const call of calls) if (call.creationScope !== this.scope) this.scope.runner.recordFatal('parallel call belongs to another scope', call.creationLocation);
    return new ManagedCall({ tag: 'parallel', children: [...calls] }, this.scope) as ManagedCall<{ [K in keyof T]: T[K] extends ManagedCall<infer V> ? Outcome<V> : never }>;
  }
  role(name: string, input: AuthorJsonValue): ManagedCall<TVersion extends 'v2' ? AuthorRoleResult : JsonValue> {
    if (!this.capabilities) return this.operation('author.role', { name, input }) as ManagedCall<TVersion extends 'v2' ? AuthorRoleResult : JsonValue>;
    const grant = this.capabilities.roles[name];
    if (!grant || grant.kind !== 'execution.role' || grant.template !== 'read-only-analyst')
      this.scope.runner.recordFatal(`Role ${name} lacks read-only execution.role grant`);
    const agent = this.initialAgent as unknown as AuthorInputV2['initialAgent'];
    return this.typedOperation<AuthorRoleResult>('execution.role', { roleId: name, input }, { bindingSetRef: agent.bindingSetRef,
      limits: this.capabilities.operationLimits['execution.role'] ?? {} }, value =>
      decodeRoleExecutionResult(value, agent.bindingSetRef.digest)) as ManagedCall<TVersion extends 'v2' ? AuthorRoleResult : JsonValue>;
  }
  propose(parent: DeepReadonly<HarnessAgentV1>, options: { feedback?: AuthorEvaluation;
    role: string; count: number }): ManagedCall<DeepReadonly<ProposalBatchV1>> {
    const configured = (this.capabilities as AuthorCapabilitiesV1 | undefined)?.execution.proposal;
    if (!configured || typeof configured !== 'object' || Array.isArray(configured))
      this.scope.runner.recordFatal('propose requires frozen proposal bound');
    if (!options || typeof options.role !== 'string' || !options.role
      || !Number.isSafeInteger(options.count) || options.count < 1
      || options.count > (configured as { maxCount: number }).maxCount)
      this.scope.runner.recordFatal('propose role or count exceeds frozen bound');
    const grant = this.capabilities!.roles[options.role];
    if (!grant || grant.kind !== 'execution.workspace-edit' || grant.template !== 'harness-editor')
      this.scope.runner.recordFatal(`Role ${options.role} lacks harness-editor grant`);
    let feedback: EvaluationV1 | undefined;
    try {
      assertHarnessAgentV1(parent);
      if (options.feedback !== undefined) { assertEvaluationV1(options.feedback); feedback = options.feedback as EvaluationV1; }
    } catch (error) { this.scope.runner.recordFatal(`propose input invalid: ${error instanceof Error ? error.message : String(error)}`); }
    if (parent.executionProfileDigest !== (this.initialAgent as HarnessAgentV1).executionProfileDigest
      || feedback && (!feedback.comparable || canonicalJson(feedback.subject) !== canonicalJson(parent)))
      this.scope.runner.recordFatal('propose parent profile or supplied feedback invalid');
    const limits = this.capabilities!.operationLimits['execution.workspace-edit'];
    if (!limits || !Number.isSafeInteger(limits['model.requests']) || limits['model.requests']! < 1
      || !Number.isSafeInteger(limits['model.tokens']) || limits['model.tokens']! < 1)
      this.scope.runner.recordFatal('propose requires frozen editor model request and token limits');
    return new ManagedCall<DeepReadonly<ProposalBatchV1>>({ tag: 'workflow', fn: authorProposeWorkflow,
      args: [freezeManaged(this.scope, parent, 'propose parent'),
        feedback ? freezeManaged(this.scope, feedback, 'propose feedback') : null,
        options.role, options.count, freezeManaged(this.scope, limits, 'propose limits')] as JsonValue[],
      version: 'author_propose@v1' }, this.scope);
  }
  evaluate(subject: DeepReadonly<HarnessAgentV1>, options: { tasks: AuthorTaskSelection }): ManagedCall<AuthorEvaluation> {
    const configured = (this.capabilities as AuthorCapabilitiesV1 | undefined)?.execution.evaluation;
    if (!configured || typeof configured !== 'object' || Array.isArray(configured))
      this.scope.runner.recordFatal('evaluate requires frozen execution conditions');
    if (!options || !options.tasks) this.scope.runner.recordFatal('evaluate requires a TaskSelection');
    try { assertHarnessAgentV1(subject); assertTaskSelectionV1(options.tasks); }
    catch (error) { this.scope.runner.recordFatal(`evaluate input invalid: ${error instanceof Error ? error.message : String(error)}`); }
    const config = configured as AuthorEvaluationConfigV1;
    if (subject.executionProfileDigest !== (this.initialAgent as HarnessAgentV1).executionProfileDigest
      || options.tasks.selectedTaskIds.length * config.repeatCount > config.maxTrials)
      this.scope.runner.recordFatal('evaluate subject profile or finite trial bound invalid');
    return new ManagedCall<AuthorEvaluation>({ tag: 'workflow', fn: authorEvaluateWorkflow,
      args: [freezeManaged(this.scope, subject, 'evaluate subject'),
        freezeManaged(this.scope, options.tasks, 'evaluate TaskSelection'),
        freezeManaged(this.scope, config, 'evaluate conditions')] as JsonValue[],
      version: 'author_evaluate@v1' }, this.scope);
  }
  select(evaluations: readonly DeepReadonly<EvaluationV1>[], options: { metric: string;
    requireImprovement?: boolean }): AuthorSelectionResult {
    const configured = (this.capabilities as AuthorCapabilitiesV1 | undefined)?.execution.selection;
    if (!configured || typeof configured !== 'object' || Array.isArray(configured))
      this.scope.runner.recordFatal('select requires a frozen selection metric');
    const selection = configured as AuthorSelectionConfigV1;
    if (!options || options.metric !== selection.metric.id
      || options.requireImprovement !== undefined && typeof options.requireImprovement !== 'boolean'
      || !Array.isArray(evaluations) || evaluations.length === 0)
      this.scope.runner.recordFatal('select metric, options or evaluations invalid');
    const complete: EvaluationV1[] = [];
    for (const item of evaluations) {
      try { assertEvaluationV1(item); }
      catch (error) { this.scope.runner.recordFatal(`select Evaluation invalid: ${error instanceof Error ? error.message : String(error)}`); }
      if (!item.comparable) continue;
      if (!Object.hasOwn(item.metrics!, options.metric)) this.scope.runner.recordFatal('select metric missing from complete Evaluation');
      if (complete.length && item.comparisonKey !== complete[0]!.comparisonKey)
        this.scope.runner.recordFatal('select cannot compare different measurement conditions');
      complete.push(item as EvaluationV1);
    }
    if (options.requireImprovement && !evaluations[0]!.comparable)
      this.scope.runner.recordFatal('select requireImprovement needs a complete baseline first');
    if (complete.length === 0) this.scope.runner.recordFatal('select has no comparable Evaluation');
    let best = complete[0]!;
    let bestKey = metricComparisonKey(best.metrics![options.metric]!, selection.metric.comparisonPrecision);
    for (const candidate of complete.slice(1)) {
      const key = metricComparisonKey(candidate.metrics![options.metric]!, selection.metric.comparisonPrecision);
      const better = selection.metric.direction === 'maximize' ? key > bestKey : key < bestKey;
      if (better) { best = candidate; bestKey = key; }
    }
    return deepFreeze(clone({ agent: best.subject, evaluation: best })) as AuthorSelectionResult;
  }
  edit(input: AuthorJsonValue): ManagedCall<JsonValue> { return this.operation('author.edit', input); }
  rollout(input: AuthorJsonValue): ManagedCall<JsonValue> { return this.operation('author.rollout', input); }
  measure(input: AuthorJsonValue): ManagedCall<JsonValue> { return this.operation('author.measure', input); }
  checkpoint(name: string, value: AuthorJsonValue, schema = 'author.archive.v1'): ManagedCall<JsonValue> {
    return this.operation('author.checkpoint', { name, value, schema });
  }
  budget(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'budget' }); }
  now(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'now' }); }
  randomSeed(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'random-seed' }); }
  newId(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'id' }); }
  result(result: AuthorResult): DeepReadonly<AuthorResult> {
    if (this.capabilities && result.selected !== undefined) {
      try { assertHarnessAgentV1(result.selected); }
      catch (error) { this.scope.runner.recordFatal(`selected Agent invalid: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return freezeManaged(this.scope, result, 'author result') as DeepReadonly<AuthorResult>;
  }
}

type AuthorProposalOne = { kind: 'candidate'; candidate: HarnessAgentV1 }
  | { kind: 'failure'; failure: ProposalFailureV1 };
function authorProposalRef(value: unknown, schemaId: string, label: string): ArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} artifact missing`);
  const ref = value as ArtifactRef;
  if (ref.kind !== 'artifact' || ref.schemaId !== schemaId || ref.mediaType !== 'application/json'
    || !/^[a-f0-9]{64}$/u.test(ref.digest) || !Number.isSafeInteger(ref.size) || ref.size < 0)
    throw new Error(`${label} artifact identity invalid`);
  return ref;
}
function authorProposalFailure(index: number, stage: ProposalFailureV1['stage'],
  error: AuthorOperationError, evidenceRefs: ArtifactRef[] = []): ProposalFailureV1 {
  const outcome = error.outcome;
  const code = outcome.kind === 'error' ? outcome.code : outcome.reason || outcome.kind;
  return { index, stage, code, message: outcome.kind === 'error' ? outcome.message : code,
    evidenceRefs };
}
async function authorProposeOne(ctx: AuthorContext, ...args: JsonValue[]): Promise<AuthorProposalOne> {
  const [parent, feedback, role, index, limits] = args as unknown as
    [HarnessAgentV1, EvaluationV1 | null, string, number, Record<string, number>];
  const input: AuthorProposalEditInputV1 = { roleId: role, baseBindingSetRef: parent.bindingSetRef,
    proposalIndex: index, ...(feedback ? { feedback: { schemaVersion: 1, subject: parent,
      taskViewRef: feedback.taskViewRef, measurementRef: feedback.measurementRef!,
      comparisonKey: feedback.comparisonKey! } } : {}) };
  let edited: JsonValue;
  try { edited = await ctx.operation('execution.workspace-edit', input,
    { bindingSetRef: parent.bindingSetRef, limits, startsBudgetClock: true }); }
  catch (error) {
    if (!(error instanceof AuthorOperationError)) throw error;
    const code = error.outcome.kind === 'no-result' ? error.outcome.reason : undefined;
    return { kind: 'failure', failure: authorProposalFailure(index,
      code === 'workspace-edit-fixed-check-failed' ? 'validation' : 'edit', error) };
  }
  if (!edited || typeof edited !== 'object' || Array.isArray(edited))
    ctx.scope.runner.recordFatal('workspace editor returned malformed ExecutionResult');
  const value = edited as Record<string, JsonValue>;
  if (value.requestedBindingSetDigest !== parent.bindingSetRef.digest)
    ctx.scope.runner.recordFatal('workspace editor executed a different parent binding');
  const producedArtifactRef = authorProposalRef(value.producedArtifactRef, 'harness.directory.v1', 'Edited Harness');
  const evidenceRef = authorProposalRef(value.evidenceRef, 'execution.workspace-edit.evidence.v1', 'Edit evidence');
  const receiptRef = authorProposalRef(value.receiptRef, 'execution.receipt.v1', 'Edit receipt');
  const validationReceiptRef = authorProposalRef(value.validationReceiptRef,
    'execution.workspace-edit.validation.v1', 'Edit validation');
  let derived: JsonValue;
  try { derived = await ctx.operation('bindings.derive', { baseRef: parent.bindingSetRef,
    replacements: { harness: producedArtifactRef } },
  { bindingSetRef: parent.bindingSetRef, limits: {}, startsBudgetClock: false }); }
  catch (error) {
    if (!(error instanceof AuthorOperationError)) throw error;
    return { kind: 'failure', failure: authorProposalFailure(index, 'derive', error,
      [evidenceRef, receiptRef, validationReceiptRef]) };
  }
  if (!derived || typeof derived !== 'object' || Array.isArray(derived)
    || !Object.hasOwn(derived, 'bindingSetRef'))
    ctx.scope.runner.recordFatal('bindings.derive returned malformed result');
  const bindingSetRef = (derived as { bindingSetRef: BindingSetRef }).bindingSetRef;
  if (bindingSetRef?.schemaId !== parent.bindingSetRef.schemaId)
    ctx.scope.runner.recordFatal('bindings.derive changed binding schema');
  const candidate: HarnessAgentV1 = { schemaVersion: 1, kind: 'harness-agent',
    bindingSetRef, executionProfileDigest: parent.executionProfileDigest, proposalIndex: index };
  try { assertHarnessAgentV1(candidate); }
  catch (error) { ctx.scope.runner.recordFatal(`bindings.derive candidate invalid: ${error instanceof Error ? error.message : String(error)}`); }
  return { kind: 'candidate', candidate };
}
async function authorProposeWorkflow(ctx: AuthorContext, ...args: JsonValue[]): Promise<DeepReadonly<ProposalBatchV1>> {
  const [parent, feedback, role, count, limits] = args as unknown as
    [HarnessAgentV1, EvaluationV1 | null, string, number, Record<string, number>];
  const calls: ManagedCall<AuthorProposalOne>[] = [];
  for (let index = 0; index < count; index++) calls.push(new ManagedCall<AuthorProposalOne>({ tag: 'workflow',
    fn: authorProposeOne, args: [parent, feedback, role, index, limits] as JsonValue[],
    version: 'author_propose_one@v1' }, ctx.scope));
  const settled = await ctx.parallel(calls);
  const candidates: HarnessAgentV1[] = [], failures: ProposalFailureV1[] = [];
  for (const item of settled) {
    if (!item.ok) ctx.scope.runner.recordFatal('propose branch leaked a business failure');
    if (item.value.kind === 'candidate') candidates.push(item.value.candidate);
    else failures.push(item.value.failure);
  }
  const batch: ProposalBatchV1 = { schemaVersion: 1, requestedCount: count, candidates, failures };
  try { assertProposalBatchV1(batch); }
  catch (error) { ctx.scope.runner.recordFatal(`propose batch invalid: ${error instanceof Error ? error.message : String(error)}`); }
  return deepFreeze(clone(batch));
}

async function authorEvaluateTrial(ctx: AuthorContext, ...args: JsonValue[]): Promise<TrackedOperationResult> {
  const [subject, selection, task, repeatIndex, config] = args as unknown as
    [HarnessAgentV1, TaskSelectionV1, JsonValue, number, AuthorEvaluationConfigV1];
  return ctx.trackedOperation('execution.rollout', { task, taskViewRef: selection.taskViewRef,
    samplingDigest: config.samplingDigest, environmentDigest: config.environmentDigest,
    recipePhase: config.recipePhase, repeatIndex,
    executedRevisionDigest: subject.bindingSetRef.digest },
  { bindingSetRef: subject.bindingSetRef, limits: { 'rollout.trials': 1 }, startsBudgetClock: true });
}

async function authorEvaluateWorkflow(ctx: AuthorContext, ...args: JsonValue[]): Promise<AuthorEvaluation> {
  const [subject, selection, config] = args as unknown as
    [HarnessAgentV1, TaskSelectionV1, AuthorEvaluationConfigV1];
  const consumed = await ctx.operation('tasks.consume', { taskViewRef: selection.taskViewRef,
    cursor: selection.cursor, count: selection.selectedTaskIds.length },
  { limits: {}, startsBudgetClock: false });
  if (!consumed || typeof consumed !== 'object' || Array.isArray(consumed)
    || !Array.isArray(consumed.tasks) || consumed.tasks.length !== selection.selectedTaskIds.length
    || !consumed.cursor || typeof consumed.cursor !== 'object' || Array.isArray(consumed.cursor)
    || Object.keys(consumed.cursor).sort().join(',') !== 'nextIndex,viewDigest'
    || consumed.cursor.viewDigest !== selection.taskViewRef.digest
    || consumed.cursor.nextIndex !== consumed.tasks.length
    || consumed.tasks.some((task, index) => !task || typeof task !== 'object' || Array.isArray(task)
      || task.id !== selection.selectedTaskIds[index] || task.purpose === 'final-test'))
    ctx.scope.runner.recordFatal('tasks.consume did not return the exact signed TaskSelection');
  const calls: ManagedCall<TrackedOperationResult>[] = [];
  for (const task of consumed.tasks) for (let repeatIndex = 0; repeatIndex < config.repeatCount; repeatIndex++) {
    calls.push(new ManagedCall<TrackedOperationResult>({ tag: 'workflow', fn: authorEvaluateTrial,
      args: [subject, selection, task, repeatIndex, config] as JsonValue[],
      version: 'author_evaluate_trial@v1' }, ctx.scope));
  }
  const settled = await ctx.parallel(calls);
  const producerOperationIds = settled.map(item => {
    if (!item.ok || !/^[a-f0-9]{64}$/u.test(item.value.operationId))
      ctx.scope.runner.recordFatal('evaluate trial has no terminal committed operation ID');
    return item.value.operationId;
  });
  const measured = await ctx.operation('author.measurement', { subject, selection, producerOperationIds },
    { bindingSetRef: subject.bindingSetRef, limits: {}, startsBudgetClock: false });
  try { assertEvaluationV1(measured); }
  catch (error) { ctx.scope.runner.recordFatal(`author.measurement result invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (canonicalJson(measured.subject) !== canonicalJson(subject)
    || canonicalJson(measured.taskViewRef) !== canonicalJson(selection.taskViewRef))
    ctx.scope.runner.recordFatal('author.measurement subject or TaskSelection drift');
  return deepFreeze(clone(measured)) as AuthorEvaluation;
}

export type AlgorithmDefinition<TConfig = JsonValue, TVersion extends 'v1' | 'v2' = 'v2', TData = AuthorResearchDataV1> =
  (ctx: AuthorContext<TConfig, TVersion, TData>) => Promise<AuthorJsonValue> | AuthorJsonValue;
const declaredConfigSchemas = new WeakMap<Function, JsonSchema>();
export function algorithm<TConfig = JsonValue, TVersion extends 'v1' | 'v2' = 'v2', TData = AuthorResearchDataV1>(
  fn: AlgorithmDefinition<TConfig, TVersion, TData>, options: { configSchema?: JsonSchema } = {}): AlgorithmDefinition<TConfig, TVersion, TData> {
  if (options.configSchema) {
    assertAuthorConfigSchema(options.configSchema);
    declaredConfigSchemas.set(fn, deepFreeze(clone(options.configSchema as JsonValue)) as JsonSchema);
  }
  Object.defineProperty(fn, 'describe', { value: () => ({ apiVersion: AUTHOR_WIRE_VERSION,
    id: fn.name || 'algorithm', definitionVersion: 'algorithm.v1',
    ...(declaredConfigSchemas.has(fn) ? { configSchema: declaredConfigSchemas.get(fn) } : {}) }), configurable: false });
  return fn;
}
/** A call to this wrapper is lazy; the driver injects a branch-local context when consumed. */
export function workflow<T extends readonly AuthorJsonValue[], R extends AuthorJsonValue>(
  fn: (ctx: AuthorContext, ...args: T) => Promise<R> | R,
  options: { name?: string; version?: string } = {}): (...args: T) => ManagedCall<R> {
  return (...args: T): ManagedCall<R> => {
    const scope = activeScope.getStore();
    if (!scope) fail('workflow invoked outside author replay');
    if ((options.name !== undefined && (typeof options.name !== 'string' || !options.name))
      || (options.version !== undefined && (typeof options.version !== 'string' || !options.version)))
      scope.runner.recordFatal('workflow name or version invalid');
    const frozenArgs = freezeManaged(scope, args, 'workflow arguments');
    return new ManagedCall<R>({ tag: 'workflow', fn: fn as unknown as (ctx: AuthorContext, ...args: JsonValue[]) => Promise<R> | R,
      args: frozenArgs as unknown as JsonValue[], version: `${options.name ?? (fn.name || 'workflow')}@${options.version ?? 'v1'}` }, scope);
  };
}

class ReplayRunner {
  readonly frontier: AuthorAtomic[] = [];
  readonly remaining: Map<string, AuthorHistoryEntry>;
  readonly calls = new Set<ManagedCall<unknown>>();
  readonly visited = new Set<string>();
  fatal: Error | null = null;
  recordFatal(message: string, location?: string): never {
    const error = new Error(`Author replay: ${message}${location ? ` (${location})` : ''}`);
    this.fatal ??= error;
    throw error;
  }
  constructor(readonly request: AuthorReplayRequest) {
    if (request.version !== AUTHOR_WIRE_VERSION && request.version !== AUTHOR_WIRE_VERSION_V2)
      fail('unsupported wire version');
    assertJson(request);
    const requiredInput = request.version === AUTHOR_WIRE_VERSION_V2
      ? ['initialAgent', 'data', 'config', 'capabilities'] : ['initialAgent', 'data', 'config'];
    if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)
      || Object.keys(request.input).length !== requiredInput.length
      || requiredInput.some(key => !Object.hasOwn(request.input, key))) fail('author replay input keys invalid');
    if (request.version === AUTHOR_WIRE_VERSION_V2) {
      assertAuthorCapabilitiesV1(request.input.capabilities);
      assertHarnessAgentV1(request.input.initialAgent);
    } else if (Object.hasOwn(request.input, 'capabilities')) fail('A1 capabilities cannot use A0 wire');
    if (Buffer.byteLength(canonicalJson(request)) > 1024 * 1024) fail('request exceeds 1 MiB');
    this.remaining = new Map();
    const operationIds = new Set<string>();
    for (const entry of request.history) {
      if (this.remaining.has(entry.address)) fail(`duplicate history address ${entry.address}`);
      if (!entry.outcome || !['result', 'error', 'no-result', 'inconclusive', 'cancelled'].includes(entry.outcome.kind))
        fail(`nonterminal/invalid history outcome at ${entry.address}`);
      if (request.version === AUTHOR_WIRE_VERSION_V2) {
        if (typeof entry.operationId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.operationId)
          || operationIds.has(entry.operationId)) fail(`v2 history operation ID missing, invalid or repeated at ${entry.address}`);
        operationIds.add(entry.operationId);
      } else if (entry.operationId !== undefined) fail(`v1 history cannot carry operation ID at ${entry.address}`);
      this.remaining.set(entry.address, entry);
    }
  }
  register(call: ManagedCall<unknown>): void { this.calls.add(call); }
  consumed(call: ManagedCall<unknown>): void { this.calls.delete(call); }
  private atom<T>(action: Extract<Action<T>, { tag: 'atomic' }>, address: string, definitionVersion: string): Promise<T> {
    const digest = authorIntentDigest({ input: action.input, ...action.options });
    const operationVersion = action.tracked ? `${definitionVersion}/tracked-operation@v1` : definitionVersion;
    const prior = this.remaining.get(address);
    if (prior) {
      if (prior.kind !== action.kind || prior.definitionVersion !== operationVersion || prior.inputDigest !== digest) this.recordFatal(`history input drift at ${address}`);
      this.visited.add(address);
      if (action.tracked) return Promise.resolve(deepFreeze(clone({ operationId: prior.operationId!, outcome: prior.outcome })) as T);
      if (prior.outcome.kind !== 'result') return Promise.reject(new AuthorOperationError(prior.outcome));
      try {
        const value = deepFreeze(clone(prior.outcome.value));
        return Promise.resolve(action.decode ? deepFreeze(action.decode(value)) : value as T);
      } catch (error) {
        this.recordFatal(`typed result invalid at ${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.frontier.some(item => item.address === address)) fail(`duplicate frontier address ${address}`);
    this.frontier.push({ address, kind: action.kind, definitionVersion: operationVersion, input: action.input, ...action.options });
    return new Promise(() => {});
  }
  runCall<T>(action: Action<T>, address: string, definitionVersion: string): Promise<T> {
    if (action.tag === 'atomic') return this.atom(action, address, definitionVersion);
    if (action.tag === 'workflow') {
      const child: Scope = { runner: this, path: address, next: 0, definitionVersion: `${definitionVersion}/${action.version}` };
      const ctx = new AuthorContext(child, this.request.input);
      return Promise.resolve().then(() => activeScope.run(child, () => action.fn(ctx, ...action.args))).catch(error => {
        if (!(error instanceof AuthorOperationError))
          this.recordFatal(`workflow failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
    }
    if (action.children.length === 0) return Promise.resolve([] as T);
    const branches = action.children.map((call, index) => {
      const child: Scope = { runner: this, path: `${address}/p${index}`, next: 0, definitionVersion };
      return Promise.resolve().then(() => activeScope.run(child, () => call.start(child, true))).catch(error => {
        if (!(error instanceof AuthorOperationError)) this.recordFatal(`parallel branch failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
    });
    return Promise.allSettled(branches).then(settled => settled.map(item => {
      if (item.status === 'fulfilled') return { ok: true, value: item.value };
      if (item.reason instanceof AuthorOperationError) return { ok: false, error: item.reason.toAuthorError() };
      throw item.reason;
    }) as T);
  }
  checkHistory(): void {
    for (const address of this.remaining.keys()) if (!this.visited.has(address)) fail(`history address skipped or early return: ${address}`);
  }
  checkUnconsumed(): void {
    const call = this.calls.values().next().value;
    if (call) fail('ManagedCall created but not consumed', call.creationLocation);
  }
}

function compareAuthorAddress(a: AuthorAtomic, b: AuthorAtomic): number {
  const left = a.address.split('/'); const right = b.address.split('/');
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index]!; const y = right[index]!;
    if (x === y) continue;
    const mx = /^([sp])(\d+)$/.exec(x); const my = /^([sp])(\d+)$/.exec(y);
    if (mx && my && mx[1] === my[1]) return Number(mx[2]) - Number(my[2]);
    return Buffer.compare(Buffer.from(x), Buffer.from(y));
  }
  return left.length - right.length;
}

/** Pure replay; never invokes a provider. Pending thenables remain unresolved until the next replay. */
export async function replay<TConfig = JsonValue, TVersion extends 'v1' | 'v2' = 'v2', TData = AuthorResearchDataV1>(
  definition: AlgorithmDefinition<TConfig, TVersion, TData>,
  request: AuthorReplayRequest): Promise<AuthorReplayReply> {
  const runner = new ReplayRunner(request);
  const configSchema = declaredConfigSchemas.get(definition);
  if (configSchema) validateSchema(configSchema, request.input.config, '$.input.config');
  const root: Scope = { runner, path: 'r', next: 0, definitionVersion: request.version === AUTHOR_WIRE_VERSION_V2 ? 'algorithm.v2' : 'algorithm.v1' };
  const ctx = new AuthorContext<TConfig, TVersion, TData>(root, request.input);
  let completed = false; let result: AuthorJsonValue | undefined; let failure: unknown;
  Promise.resolve(activeScope.run(root, () => definition(ctx))).then(value => { completed = true; result = value; }, error => { completed = true; failure = error; });
  // A macrotask boundary drains normal Promise continuations without throwing a catchable pause exception.
  await new Promise<void>(resolve => setImmediate(resolve));
  if (runner.fatal) throw runner.fatal;
  runner.checkHistory();
  if (completed) {
    if (failure) throw failure;
    runner.checkUnconsumed();
    assertJson(result);
    if (request.version === AUTHOR_WIRE_VERSION_V2 && result && !Array.isArray(result) && typeof result === 'object'
      && Object.hasOwn(result, 'selected')) {
      const selected = (result as Record<string, unknown>).selected;
      if (selected !== undefined) assertHarnessAgentV1(selected);
    }
    const reply: AuthorReplayReply = { status: 'completed', result: clone(result) };
    if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024) fail('reply exceeds 1 MiB');
    return reply;
  }
  if (runner.frontier.length === 0) fail('workflow did not reach a managed frontier (unsupported bare async/IO)');
  const reply: AuthorReplayReply = { status: 'waiting', frontier: runner.frontier.sort(compareAuthorAddress) };
  if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024) fail('reply exceeds 1 MiB');
  return reply;
}
