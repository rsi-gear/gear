import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson, assertJson, jsonDigest, type JsonValue } from '../schema.js';
import type { BindingSetRef, OperationOutcome } from '../contracts.js';

export const AUTHOR_WIRE_VERSION = 'gear.author.replay.v1' as const;
export type AuthorInput = { initialAgent: JsonValue; data: JsonValue; config: JsonValue };
export type AuthorHistoryEntry = { address: string; kind: string; definitionVersion: string; inputDigest: string; outcome: OperationOutcome };
export type AuthorAtomic = { address: string; kind: string; definitionVersion: string; input: JsonValue; bindingSetRef?: BindingSetRef; limits?: Record<string, number>; startsBudgetClock?: boolean };
export type AuthorReplayRequest = { version: typeof AUTHOR_WIRE_VERSION; input: AuthorInput; history: AuthorHistoryEntry[] };
export type AuthorReplayReply = { status: 'waiting'; frontier: AuthorAtomic[] } | { status: 'completed'; result: JsonValue };
export type AuthorError = { kind: Exclude<OperationOutcome['kind'], 'result'>; code?: string; message?: string; reason?: string; retryable?: boolean };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AuthorError };
export type AuthorResult = { selected?: JsonValue; outputs?: Record<string, JsonValue> };
export type OperationOptions = { bindingSetRef?: BindingSetRef; limits?: Record<string, number>; startsBudgetClock?: boolean };
export function authorIntentDigest(item: { input: JsonValue } & OperationOptions): string {
  return jsonDigest({ input: item.input, ...(item.bindingSetRef ? { bindingSetRef: item.bindingSetRef } : {}),
    ...(item.limits ? { limits: item.limits } : {}),
    ...(item.startsBudgetClock === undefined ? {} : { startsBudgetClock: item.startsBudgetClock }) });
}

type Scope = { runner: ReplayRunner; path: string; next: number; definitionVersion: string };
type Action<T> =
  | { tag: 'atomic'; kind: string; input: JsonValue; options: OperationOptions }
  | { tag: 'parallel'; children: ManagedCall<unknown>[] }
  | { tag: 'workflow'; fn: (ctx: AuthorContext, ...args: JsonValue[]) => Promise<T> | T; args: JsonValue[]; version: string };
const activeScope = new AsyncLocalStorage<Scope>();

function clone<T extends JsonValue>(value: T): T { assertJson(value); return JSON.parse(canonicalJson(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function sourceLocation(): string {
  const frames = new Error().stack?.split('\n').slice(1) ?? [];
  return frames.find(line => !line.includes('/algorithm/author/') && !line.includes('node:internal'))?.trim() ?? 'unknown source';
}
function fail(message: string, location?: string): never { throw new Error(`Author replay: ${message}${location ? ` (${location})` : ''}`); }

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

export class AuthorContext {
  readonly initialAgent: JsonValue;
  readonly data: JsonValue;
  readonly config: JsonValue;
  constructor(readonly scope: Scope, input: AuthorInput) {
    this.initialAgent = deepFreeze(clone(input.initialAgent));
    this.data = deepFreeze(clone(input.data));
    this.config = deepFreeze(clone(input.config));
  }
  operation<T extends JsonValue = JsonValue>(kind: string, input: JsonValue, options: OperationOptions = {}): ManagedCall<T> {
    if (typeof kind !== 'string' || !kind) fail('operation kind required');
    const normalized = deepFreeze(clone(input));
    return new ManagedCall<T>({ tag: 'atomic', kind, input: normalized, options: clone(options as JsonValue) as OperationOptions }, this.scope);
  }
  parallel<T extends readonly ManagedCall<unknown>[]>(calls: T): ManagedCall<{ [K in keyof T]: T[K] extends ManagedCall<infer V> ? Outcome<V> : never }> {
    if (!Array.isArray(calls) || !calls.every(call => call instanceof ManagedCall))
      this.scope.runner.recordFatal('parallel requires ManagedCall array');
    if (new Set(calls).size !== calls.length) this.scope.runner.recordFatal('ManagedCall appears in parallel more than once');
    for (const call of calls) if (call.creationScope !== this.scope) this.scope.runner.recordFatal('parallel call belongs to another scope', call.creationLocation);
    return new ManagedCall({ tag: 'parallel', children: [...calls] }, this.scope) as ManagedCall<{ [K in keyof T]: T[K] extends ManagedCall<infer V> ? Outcome<V> : never }>;
  }
  role(name: string, input: JsonValue): ManagedCall<JsonValue> { return this.operation('author.role', { name, input }); }
  edit(input: JsonValue): ManagedCall<JsonValue> { return this.operation('author.edit', input); }
  rollout(input: JsonValue): ManagedCall<JsonValue> { return this.operation('author.rollout', input); }
  measure(input: JsonValue): ManagedCall<JsonValue> { return this.operation('author.measure', input); }
  checkpoint(name: string, value: JsonValue, schema = 'author.archive.v1'): ManagedCall<JsonValue> {
    return this.operation('author.checkpoint', { name, value, schema });
  }
  budget(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'budget' }); }
  now(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'now' }); }
  randomSeed(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'random-seed' }); }
  newId(): ManagedCall<JsonValue> { return this.operation('author.observe', { kind: 'id' }); }
  result(result: AuthorResult): AuthorResult { return deepFreeze(clone(result as JsonValue)) as AuthorResult; }
}

export type AlgorithmDefinition = (ctx: AuthorContext) => Promise<JsonValue> | JsonValue;
export function algorithm<T extends AlgorithmDefinition>(fn: T): T { return fn; }
/** A call to this wrapper is lazy; the driver injects a branch-local context when consumed. */
export function workflow<T extends JsonValue[], R extends JsonValue>(fn: (ctx: AuthorContext, ...args: T) => Promise<R> | R, options: { name?: string; version?: string } = {}): (...args: T) => ManagedCall<R> {
  return (...args: T): ManagedCall<R> => {
    const scope = activeScope.getStore();
    if (!scope) fail('workflow invoked outside author replay');
    const frozenArgs = deepFreeze(clone(args));
    return new ManagedCall<R>({ tag: 'workflow', fn: fn as (ctx: AuthorContext, ...args: JsonValue[]) => Promise<R> | R, args: frozenArgs, version: `${options.name ?? (fn.name || 'workflow')}@${options.version ?? 'v1'}` }, scope);
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
    if (request.version !== AUTHOR_WIRE_VERSION) fail('unsupported wire version');
    assertJson(request);
    if (Buffer.byteLength(canonicalJson(request)) > 1024 * 1024) fail('request exceeds 1 MiB');
    this.remaining = new Map();
    for (const entry of request.history) {
      if (this.remaining.has(entry.address)) fail(`duplicate history address ${entry.address}`);
      if (!entry.outcome || !['result', 'error', 'no-result', 'inconclusive', 'cancelled'].includes(entry.outcome.kind))
        fail(`nonterminal/invalid history outcome at ${entry.address}`);
      this.remaining.set(entry.address, entry);
    }
  }
  register(call: ManagedCall<unknown>): void { this.calls.add(call); }
  consumed(call: ManagedCall<unknown>): void { this.calls.delete(call); }
  private atom(action: Extract<Action<unknown>, { tag: 'atomic' }>, address: string, definitionVersion: string): Promise<JsonValue> {
    const digest = authorIntentDigest({ input: action.input, ...action.options });
    const prior = this.remaining.get(address);
    if (prior) {
      if (prior.kind !== action.kind || prior.definitionVersion !== definitionVersion || prior.inputDigest !== digest) this.recordFatal(`history input drift at ${address}`);
      this.visited.add(address);
      return prior.outcome.kind === 'result' ? Promise.resolve(deepFreeze(clone(prior.outcome.value)))
        : Promise.reject(new AuthorOperationError(prior.outcome));
    }
    if (this.frontier.some(item => item.address === address)) fail(`duplicate frontier address ${address}`);
    this.frontier.push({ address, kind: action.kind, definitionVersion, input: action.input, ...action.options });
    return new Promise(() => {});
  }
  runCall<T>(action: Action<T>, address: string, definitionVersion: string): Promise<T> {
    if (action.tag === 'atomic') return this.atom(action, address, definitionVersion) as Promise<T>;
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
export async function replay(definition: AlgorithmDefinition, request: AuthorReplayRequest): Promise<AuthorReplayReply> {
  const runner = new ReplayRunner(request);
  const root: Scope = { runner, path: 'r', next: 0, definitionVersion: 'algorithm.v1' };
  const ctx = new AuthorContext(root, request.input);
  let completed = false; let result: JsonValue | undefined; let failure: unknown;
  Promise.resolve(activeScope.run(root, () => definition(ctx))).then(value => { completed = true; result = value; }, error => { completed = true; failure = error; });
  // A macrotask boundary drains normal Promise continuations without throwing a catchable pause exception.
  await new Promise<void>(resolve => setImmediate(resolve));
  if (runner.fatal) throw runner.fatal;
  runner.checkHistory();
  if (completed) {
    if (failure) throw failure;
    runner.checkUnconsumed();
    assertJson(result);
    const reply: AuthorReplayReply = { status: 'completed', result: clone(result) };
    if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024) fail('reply exceeds 1 MiB');
    return reply;
  }
  if (runner.frontier.length === 0) fail('workflow did not reach a managed frontier (unsupported bare async/IO)');
  const reply: AuthorReplayReply = { status: 'waiting', frontier: runner.frontier.sort(compareAuthorAddress) };
  if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024) fail('reply exceeds 1 MiB');
  return reply;
}
