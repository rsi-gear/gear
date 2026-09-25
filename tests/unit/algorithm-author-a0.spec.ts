import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { sha256, FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../src/algorithm/runtime/providers.js';
import type { BindingSchema, CampaignSpec, OperationOutcome, OperationProvider, ProviderManifest } from '../../src/algorithm/contracts.js';
import { algorithm, workflow, replay, authorIntentDigest, AUTHOR_WIRE_VERSION, type AuthorReplayRequest } from '../../src/algorithm/author/index.js';
import { AuthorAlgorithmAdapter, AuthorStepLimitExceeded } from '../../src/algorithm/author/adapter.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../src/algorithm/author/providers.js';
import type { JsonValue } from '../../src/algorithm/schema.js';
import { checkAuthorModuleSource } from '../../src/algorithm/author/source-check.js';
import { verifyAuthorOutputGraph } from '../../src/algorithm/author/graph.js';
import { authorHostIdentityDigest, authorNodeRuntimeDigest, authorSourceCheckerDigest, authorSourceClosureDigest } from '../../src/algorithm/author/identity.js';
import { AuthorProcessReplayPort } from '../../src/algorithm/author/process-port.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'gear-author-a0-')); roots.push(root); return root; };
const workerPath = resolve('lib/algorithm/author/worker-entry.js');
const modulePath = resolve('tests/fixtures/algorithm-author-a0.mjs');
const bindings: BindingSchema = { id: 'author-a0.bindings.v1', slots: {} };
const manifest = (kind: string, meteredDimensions: string[] = []): ProviderManifest => ({ kind,
  implementationDigest: sha256(`${kind}.fake.v1`), execution: 'trusted-local', supportsInspect: true,
  meteredDimensions, inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' } });
function create(root: string, options: { dropRole?: boolean; maxWaves?: number; data?: JsonValue; version?: string; modulePath?: string } = {}) {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingStore = new BindingStore(artifacts, bindings);
  const initialBindingSetRef = bindingStore.create({});
  const spec: CampaignSpec = { campaignId: 'author-a0', config: { rounds: 1 }, initialBindingSetRef,
    budget: { calls: { unit: 'call', limit: 50, source: 'rollout', capability: 'stop' } } };
  const physicalKinds = ['author.role', 'author.edit', 'author.rollout', 'author.measure'];
  const physical = physicalKinds.map(kind => new LocalDurableProvider(join(root, 'provider', kind),
    manifest(kind, kind === 'author.rollout' ? ['calls'] : []), envelope => {
      const input = envelope.input as Record<string, unknown>;
      const outcome: OperationOutcome = kind === 'author.role' ? { kind: 'result' as const, value: { prompt: `role-${(input.input as { branch: string }).branch}` } }
        : kind === 'author.edit' ? { kind: 'result' as const, value: { revision: `revision-${input.branch}` } }
        : kind === 'author.rollout' && input.label === 'B-1-4' ? { kind: 'error' as const, code: 'TASK_FAILED', message: 'recorded fake failure' }
        : kind === 'author.rollout' ? { kind: 'result' as const, value: { label: String(input.label), passed: true } }
        : { kind: 'result' as const, value: { scored: true } };
      return { outcome, ...(kind === 'author.rollout' ? { receipt: { source: 'rollout', scope: 'operation' as const,
        operationId: envelope.operationId, cursor: 'done', cumulative: { calls: 1 } } } : {}) };
    }, kind === 'author.role' && options.dropRole ? { dropSubmitResponseOnce: true } : {}));
  const port = new AuthorProcessReplayPort(options.modulePath ?? modulePath, 'sample', workerPath);
  const adapter = new AuthorAlgorithmAdapter({ id: 'a0-sample', implementationDigest: options.version ? sha256(options.version) : port.sourceDigest,
    hostIdentityDigest: port.hostDigest, bindingSchema: bindings, artifacts, bindings: bindingStore, replay: request => port.replay(request),
    initialAgent: null, data: options.data ?? {}, maxFrontierWaves: options.maxWaves ?? 200, clock: () => 123456 });
  const providers: OperationProvider[] = [...physical, new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)];
  const runtime = new AlgorithmRuntime(root, adapter, providers, spec, { artifacts });
  return { runtime, adapter, physical, artifacts };
}

it('replays a real worker-defined two-branch, nested ten-task workflow through the Campaign journal', async () => {
  const root = makeRoot(); const { runtime, adapter, physical, artifacts } = create(root);
  expect(await runtime.tick()).toBe('advanced');
  expect(physical.every(provider => provider.submitCalls === 0)).toBe(true); // committed intent precedes effects
  const first = runtime.snapshot()!;
  expect(Object.values(first.operations).map(item => item.envelope.kind)).toEqual(['author.role', 'author.role']);
  expect(await runtime.runUntilBlocked(100)).toBe('complete');
  const final = runtime.snapshot()!;
  const history = adapter.readHistory(final);
  const counts = Object.fromEntries(['author.role', 'author.edit', 'author.rollout', 'author.measure', 'author.checkpoint', 'author.observe']
    .map(kind => [kind, history.filter(entry => entry.kind === kind).length]));
  expect(counts).toEqual({ 'author.role': 2, 'author.edit': 2, 'author.rollout': 20, 'author.measure': 6,
    'author.checkpoint': 4, 'author.observe': 2 });
  expect(physical[2]!.submitCalls).toBe(20);
  expect(final.spent.calls).toBe(20);
  const result = adapter.readResult(final) as { outputs: { budget: { dimensions: { calls: { spent: number } } }; now: number } };
  expect(result.outputs.budget.dimensions.calls.spent).toBe(20);
  expect(result.outputs.now).toBe(123456);
  const population = history.filter(entry => entry.kind === 'author.checkpoint'
    && entry.address.startsWith('r/') && !entry.address.includes('/p'));
  expect(population).toHaveLength(2);
  const refs = population.map(entry => entry.outcome.kind === 'result' ? (entry.outcome.value as { ref: any }).ref : null);
  expect(refs[0]).not.toEqual(refs[1]);
  expect((artifacts.getJson(refs[0]!) as { name: string }).name).toBe('population');
  expect((artifacts.getJson(refs[1]!) as { name: string }).name).toBe('population');
  expect(history.some(entry => entry.outcome.kind === 'error' && entry.outcome.code === 'TASK_FAILED')).toBe(true);
  expect(final.budgetStartedAt).toBeDefined();
});

it('keeps unknown outside author replay and recovers lost submit response with the original key', async () => {
  const root = makeRoot(); const initial = create(root, { dropRole: true });
  await initial.runtime.tick();
  const original = Object.values(initial.runtime.snapshot()!.operations).map(record => record.envelope.operationId).sort();
  expect(await initial.runtime.runUntilBlocked(2)).toBe('waiting');
  expect(initial.adapter.readHistory(initial.runtime.snapshot()!)).toEqual([]);
  const recovered = create(root);
  expect(Object.values(recovered.runtime.snapshot()!.operations).map(record => record.envelope.operationId).sort()).toEqual(original);
  expect(await recovered.runtime.runUntilBlocked(100)).toBe('complete');
  expect(recovered.physical[0]!.submitCalls).toBe(0);
  expect(recovered.runtime.snapshot()!.spent.calls).toBe(20);
});

it('rejects source, frozen input and frontier limit drift on cold resume', async () => {
  const root = makeRoot(); const base = create(root, { maxWaves: 30 });
  await base.runtime.tick();
  expect(() => create(root, { maxWaves: 31 }).runtime.snapshot()).toThrow('Campaign identity drift');
  expect(() => create(root, { data: { changed: true }, maxWaves: 30 }).runtime.snapshot()).toThrow('Campaign identity drift');
  expect(() => create(root, { version: 'new-source', maxWaves: 30 }).runtime.snapshot()).toThrow('Campaign identity drift');
  const limitedRoot = makeRoot(); const limited = create(limitedRoot, { maxWaves: 1 });
  await limited.runtime.tick();
  await expect(limited.runtime.runUntilBlocked(10)).rejects.toBeInstanceOf(AuthorStepLimitExceeded);
  expect(limited.runtime.snapshot()!.phase).toBe('running');
});

it('rejects duplicate and unconsumed calls, returns empty parallel without an operation, and detects replay drift', async () => {
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] };
  const empty = algorithm(async ctx => ({ values: (await ctx.parallel([])) as JsonValue }));
  expect(await replay(empty, request)).toEqual({ status: 'completed', result: { values: [] } });
  const duplicate = algorithm(async ctx => { const call = ctx.operation('x', {}); await ctx.parallel([call, call]); return null; });
  await expect(replay(duplicate, request)).rejects.toThrow('more than once');
  const unconsumed = algorithm(ctx => { ctx.operation('x', {}); return null; });
  await expect(replay(unconsumed, request)).rejects.toThrow('not consumed');
  const one = algorithm(async ctx => await ctx.operation('x', { value: 1 }));
  const first = await replay(one, request);
  expect(first.status).toBe('waiting');
  if (first.status !== 'waiting') return;
  const changed = algorithm(async ctx => await ctx.operation('x', { value: 2 }));
  await expect(replay(changed, { ...request, history: [{ address: first.frontier[0]!.address, kind: 'x',
    definitionVersion: 'algorithm.v1', inputDigest: '0'.repeat(64), outcome: { kind: 'result', value: null } }] })).rejects.toThrow('input drift');
  const early = algorithm(() => null);
  await expect(replay(early, { ...request, history: [{ address: first.frontier[0]!.address, kind: 'x',
    definitionVersion: 'algorithm.v1', inputDigest: '0'.repeat(64), outcome: { kind: 'result', value: null } }] })).rejects.toThrow('skipped');
});

it('seals the actual author source tree and detects a changed source file', () => {
  const root = makeRoot();
  writeFileSync(join(root, 'author.mjs'), 'export const x = 1;\n');
  const first = authorSourceClosureDigest(root);
  writeFileSync(join(root, 'author.mjs'), 'export const x = 2;\n');
  expect(authorSourceClosureDigest(root)).not.toBe(first);
  const executable = join(root, 'node-executable');
  writeFileSync(executable, 'first binary');
  const nodeBefore = authorNodeRuntimeDigest(executable);
  writeFileSync(executable, 'changed binary');
  expect(authorNodeRuntimeDigest(executable)).not.toBe(nodeBefore);
  const compiler = join(root, 'typescript.js');
  const metadata = join(root, 'typescript-package.json');
  writeFileSync(compiler, 'compiler v1');
  writeFileSync(metadata, '{"version":"v1"}');
  const compilerBefore = authorSourceCheckerDigest(compiler, metadata);
  writeFileSync(compiler, 'compiler v2');
  expect(authorSourceCheckerDigest(compiler, metadata)).not.toBe(compilerBefore);
  const compilerAfter = authorSourceCheckerDigest(compiler, metadata);
  writeFileSync(metadata, '{"version":"v2"}');
  expect(authorSourceCheckerDigest(compiler, metadata)).not.toBe(compilerAfter);
});


it('keeps replay integrity failures fatal even if author code catches them', async () => {
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [
    { address: 'r/s0', kind: 'x', definitionVersion: 'algorithm.v1', inputDigest: authorIntentDigest({ input: { value: 1 } }),
      outcome: { kind: 'result', value: 1 } },
  ] };
  const swallowed = algorithm(async ctx => {
    try { await ctx.operation('x', { value: 2 }); } catch { /* author attempts to swallow replay drift */ }
    return await ctx.operation('y', {});
  });
  await expect(replay(swallowed, request)).rejects.toThrow('history input drift');
  const twice = algorithm(async ctx => {
    const call = ctx.operation('x', { value: 1 });
    await call;
    try { await call; } catch { /* illegal duplicate is sticky */ }
    return null;
  });
  await expect(replay(twice, request)).rejects.toThrow('consumed more than once');
  await expect(replay(algorithm(() => null), { ...request,
    history: [{ ...request.history[0]!, outcome: { kind: 'unknown' } as never }] })).rejects.toThrow('nonterminal');
});

it('rejects stolen calls and a branch TypeError while another branch is pending', async () => {
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] };
  let stolen: ReturnType<import('../../src/algorithm/author/index.js').AuthorContext['operation']>;
  const stealing = workflow(async () => { await stolen; return null; }, { name: 'steal' });
  const root = algorithm(async ctx => { stolen = ctx.operation('x', {}); await stealing(); return null; });
  await expect(replay(root, request)).rejects.toThrow('outside its creation scope');

  const left = workflow(async ctx => await ctx.operation('c', {}), { name: 'left' });
  const right = workflow(async ctx => { await ctx.operation('b', {}); throw new TypeError('broken author branch'); }, { name: 'right' });
  const parallel = algorithm(async ctx => await ctx.parallel([left(), right()]));
  const first = await replay(parallel, request);
  expect(first.status).toBe('waiting');
  if (first.status !== 'waiting') return;
  const b = first.frontier.find(item => item.kind === 'b')!;
  await expect(replay(parallel, { ...request, history: [{ address: b.address, kind: b.kind,
    definitionVersion: b.definitionVersion, inputDigest: authorIntentDigest(b), outcome: { kind: 'result', value: null } }] }))
    .rejects.toThrow('broken author branch');
});

it('makes synchronous workflow exceptions and invalid parallel input sticky across author catches', async () => {
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] };
  const broken = workflow((): never => { throw new TypeError('sync branch failure'); }, { name: 'broken' });
  const direct = algorithm(async ctx => {
    try { await broken(); } catch { return await ctx.operation('fallback', {}); }
    return null;
  });
  await expect(replay(direct, request)).rejects.toThrow('sync branch failure');
  const left = workflow(async ctx => await ctx.operation('pending-left', {}), { name: 'pending' });
  const parallel = algorithm(async ctx => {
    try { await ctx.parallel([left(), broken()]); } catch { return await ctx.operation('fallback', {}); }
    return null;
  });
  await expect(replay(parallel, request)).rejects.toThrow('sync branch failure');
  const invalid = algorithm(async ctx => {
    try { await ctx.parallel([{} as never]); } catch { return await ctx.operation('fallback', {}); }
    return null;
  });
  await expect(replay(invalid, request)).rejects.toThrow('parallel requires ManagedCall');
});

it('rejects a missing output child before committing terminal result', async () => {
  const root = makeRoot();
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingStore = new BindingStore(artifacts, bindings);
  const initialBindingSetRef = bindingStore.create({});
  const missing = { kind: 'artifact' as const, digest: '0'.repeat(64), size: 1,
    mediaType: 'application/json', schemaId: 'author.archive.v1' };
  const definition = algorithm(() => ({ outputs: { missing } }));
  const adapter = new AuthorAlgorithmAdapter({ id: 'missing', implementationDigest: sha256('missing'),
    hostIdentityDigest: sha256('host'), bindingSchema: bindings, artifacts, bindings: bindingStore,
    replay: request => replay(definition, request), initialAgent: null, data: {}, maxFrontierWaves: 10 });
  const runtime = new AlgorithmRuntime(root, adapter, [new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)],
    { campaignId: 'missing', config: {}, initialBindingSetRef, budget: {} }, { artifacts });
  await expect(runtime.tick()).rejects.toThrow();
  expect(runtime.snapshot()).toBeNull();
});


it('refuses a changed TS author source between committed frontier waves', async () => {
  const root = makeRoot(); const source = join(root, 'author-source'); mkdirSync(source);
  const path = join(source, 'sample.mjs');
  const body = `import {algorithm} from ${JSON.stringify(new URL('../../lib/algorithm/author/index.js', import.meta.url).href)};
export const sample=algorithm(async ctx=>{const role=await ctx.role('optimizer',{branch:'A'});return await ctx.edit({branch:'A',role});});\n`;
  writeFileSync(path, body);
  const first = create(root, { modulePath: path });
  expect(await first.runtime.tick()).toBe('advanced');
  writeFileSync(path, `${body}// changed after first intent\n`);
  await expect(first.runtime.tick()).rejects.toThrow('closure changed');
  expect(first.runtime.snapshot()!.phase).toBe('running');
  expect(first.physical[1]!.submitCalls).toBe(0);
  writeFileSync(path, body);
  const restored = create(root, { modulePath: path });
  expect(await restored.runtime.runUntilBlocked()).toBe('complete');
});


it('verifies metadata on repeated output refs before graph deduplication', () => {
  const root = makeRoot(); const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingStore = new BindingStore(artifacts, bindings);
  const ref = artifacts.putJson({ x: 1 }, 'author.archive.v1');
  expect(() => verifyAuthorOutputGraph(artifacts, bindingStore, [ref, { ...ref, size: ref.size + 1 }])).toThrow('Artifact bytes mismatch');
});

it('recovers after a real controller SIGKILL following physical role results and the next committed intent', async () => {
  const root = makeRoot();
  const child = spawn(process.execPath, [resolve('tests/fixtures/algorithm-author-kill-controller.mjs'), root],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', part => { stderr += part; });
  await new Promise<void>((resolveReady, rejectReady) => {
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectReady(new Error(`controller timeout: ${stderr}`)); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => { out += part; if (out.includes('SECOND_INTENT_COMMITTED')) {
      clearTimeout(timer); resolveReady();
    } });
    child.once('error', rejectReady);
    child.once('exit', (code, signal) => { if (!out.includes('SECOND_INTENT_COMMITTED')) rejectReady(new Error(`controller exited ${code ?? signal}: ${stderr}`)); });
  });
  child.kill('SIGKILL');
  const exit = await new Promise<NodeJS.Signals | null>(resolveExit => child.once('close', (_code, signal) => resolveExit(signal)));
  expect(exit).toBe('SIGKILL');
  const { AlgorithmRuntime: CompiledRuntime } = await import('../../lib/algorithm/runtime/engine.js');
  const { FileArtifactStore: CompiledArtifacts } = await import('../../lib/algorithm/artifacts.js');
  const { BindingStore: CompiledBindings } = await import('../../lib/algorithm/bindings.js');
  const { LocalDurableProvider: CompiledProvider } = await import('../../lib/algorithm/runtime/providers.js');
  const { AuthorAlgorithmAdapter: CompiledAdapter } = await import('../../lib/algorithm/author/adapter.js');
  const { AuthorObserveProvider: CompiledObserve, AuthorCheckpointProvider: CompiledCheckpoint } = await import('../../lib/algorithm/author/providers.js');
  const { AuthorProcessReplayPort: CompiledPort } = await import('../../lib/algorithm/author/process-port.js');
  const artifacts = new CompiledArtifacts(join(root, 'artifacts'));
  const bindingStore = new CompiledBindings(artifacts, bindings);
  const initialBindingSetRef = bindingStore.create({});
  const port = new CompiledPort(modulePath, 'sample', workerPath);
  const adapter = new CompiledAdapter({ id: 'a0-sample', implementationDigest: port.sourceDigest, hostIdentityDigest: port.hostDigest,
    bindingSchema: bindings, artifacts, bindings: bindingStore, replay: (request: AuthorReplayRequest) => port.replay(request),
    initialAgent: null, data: {}, maxFrontierWaves: 200, clock: () => 123456 });
  const physical = ['author.role', 'author.edit', 'author.rollout', 'author.measure'].map(kind =>
    new CompiledProvider(join(root, 'provider', kind), manifest(kind, kind === 'author.rollout' ? ['calls'] : []), envelope => {
      const input = envelope.input as Record<string, unknown>;
      const outcome: OperationOutcome = kind === 'author.role' ? { kind: 'result', value: { prompt: `role-${(input.input as { branch: string }).branch}` } }
        : kind === 'author.edit' ? { kind: 'result', value: { revision: `revision-${input.branch}` } }
        : kind === 'author.rollout' && input.label === 'B-1-4' ? { kind: 'error', code: 'TASK_FAILED', message: 'recorded fake failure' }
        : kind === 'author.rollout' ? { kind: 'result', value: { label: String(input.label), passed: true } }
        : { kind: 'result', value: { scored: true } };
      return { outcome, ...(kind === 'author.rollout' ? { receipt: { source: 'rollout', scope: 'operation' as const, operationId: envelope.operationId,
        cursor: 'done', cumulative: { calls: 1 } } } : {}) };
    }));
  const runtime = new CompiledRuntime(root, adapter, [...physical, new CompiledObserve(), new CompiledCheckpoint(artifacts, bindingStore)],
    { campaignId: 'author-a0', config: { rounds: 1 }, initialBindingSetRef,
      budget: { calls: { unit: 'call', limit: 50, source: 'rollout', capability: 'stop' } } }, { artifacts });
  expect(adapter.readHistory(runtime.snapshot()!).filter(entry => entry.kind === 'author.role')).toHaveLength(2);
  expect(await runtime.runUntilBlocked()).toBe('complete');
  expect(physical[0]!.submitCalls).toBe(0);
  expect(runtime.snapshot()!.spent.calls).toBe(20);
});


it('reports known replay-unsafe TS source patterns with file and line', () => {
  const root = makeRoot(); const path = join(root, 'author.mjs');
  const cases = [
    ['export const a=()=>Date.now();', 'Date.now'],
    ['export const a=()=>Math.random();', 'Math.random'],
    ["import fs from 'node:fs'; export const a=()=>1;", 'direct external IO'],
    ['export const a=async()=>Promise.all([]);', 'Promise.all'],
    ['export const a=()=>fetch("x");', 'fetch'],
    ['export const a=()=>new Promise(()=>{});', 'bare Promise'],
    ['export const a=()=>process.env.X;', 'process.env'],
    ['let shared=0; export const a=()=>shared;', 'top-level mutable'],
    ['export async function a(ctx){try{return 1;}finally{ctx.operation("x",{});}}', 'finally'],
  ] as const;
  for (const [source, reason] of cases) {
    writeFileSync(path, source);
    expect(() => checkAuthorModuleSource(path)).toThrow(reason);
    expect(() => checkAuthorModuleSource(path)).toThrow(`${path}:1:`);
  }
});


it('freezes budget, wall time, random seed and ID observations without metering or starting the budget clock', async () => {
  const root = makeRoot(); const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingStore = new BindingStore(artifacts, bindings);
  const initialBindingSetRef = bindingStore.create({});
  let time = 100; let seed = 7; let id = 'id-1';
  const definition = algorithm(async ctx => {
    const budget = await ctx.budget(); const now = await ctx.now();
    const randomSeed = await ctx.randomSeed(); const newId = await ctx.newId();
    return ctx.result({ outputs: { budget, now, randomSeed, newId } });
  });
  const adapter = new AuthorAlgorithmAdapter({ id: 'observe-only', implementationDigest: sha256('observe-only'),
    hostIdentityDigest: sha256('host'), bindingSchema: bindings, artifacts, bindings: bindingStore,
    replay: request => replay(definition, request), initialAgent: null, data: {}, maxFrontierWaves: 10,
    clock: () => time, seed: () => seed, newId: () => id });
  const runtime = new AlgorithmRuntime(root, adapter, [new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)],
    { campaignId: 'observe-only', config: {}, initialBindingSetRef, budget: {} }, { artifacts });
  await runtime.tick(); // budget intent
  expect(runtime.snapshot()!.budgetStartedAt).toBeUndefined();
  await runtime.tick(); // budget result, now=100 intent
  const now = Object.values(runtime.snapshot()!.operations)[0]!.envelope.input as { value: number };
  expect(now.value).toBe(100);
  time = 200; seed = 7;
  await runtime.tick(); // now result, seed=7 intent
  seed = 999;
  await runtime.tick(); // seed result, id-1 intent
  id = 'id-2';
  expect(await runtime.runUntilBlocked()).toBe('complete');
  const result = adapter.readResult(runtime.snapshot()!) as { outputs: { now: number; randomSeed: number; newId: string } };
  expect(result.outputs).toMatchObject({ now: 100, randomSeed: 7, newId: 'id-1' });
  expect(runtime.snapshot()!.spent).toEqual({});
  expect(runtime.snapshot()!.budgetStartedAt).toBeUndefined();
});


it('keeps cancelled but unreleased author operations unresolved until provider release is confirmed', async () => {
  const root = makeRoot(); const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingStore = new BindingStore(artifacts, bindings);
  const initialBindingSetRef = bindingStore.create({});
  let released = false;
  const stuck: OperationProvider = {
    describe: () => manifest('author.stuck'), preflight: () => {},
    submit: async () => ({ status: 'running' }), inspect: async () => ({ status: 'running' }),
    cancel: async () => ({ status: 'cancelled', releaseConfirmed: released }),
    collect: async () => { throw new Error('not collected'); },
  };
  const good = new LocalDurableProvider(join(root, 'good'), manifest('author.good'), () =>
    ({ outcome: { kind: 'result', value: 'good' } }));
  const definition = algorithm(async ctx => ctx.result({ outputs: { settled: await ctx.parallel([
    ctx.operation('author.stuck', {}), ctx.operation('author.good', {}),
  ]) as JsonValue } }));
  const adapter = new AuthorAlgorithmAdapter({ id: 'cancelled', implementationDigest: sha256('cancelled'),
    hostIdentityDigest: sha256('host'), bindingSchema: bindings, artifacts, bindings: bindingStore,
    replay: request => replay(definition, request), initialAgent: null, data: {}, maxFrontierWaves: 10 });
  const runtime = new AlgorithmRuntime(root, adapter, [stuck, good, new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)],
    { campaignId: 'cancelled', config: {}, initialBindingSetRef, budget: {} }, { artifacts });
  await runtime.tick();
  const stuckKey = Object.entries(runtime.snapshot()!.operations).find(([, record]) => record.envelope.kind === 'author.stuck')![0];
  expect(await runtime.tick()).toBe('waiting');
  await runtime.cancel(stuckKey);
  expect(runtime.snapshot()!.operations[stuckKey]!.released).toBe(false);
  expect(await runtime.tick()).toBe('waiting');
  expect(adapter.readHistory(runtime.snapshot()!)).toEqual([]);
  released = true;
  expect(await runtime.runUntilBlocked()).toBe('complete');
  expect(good.submitCalls).toBe(1);
  const result = adapter.readResult(runtime.snapshot()!) as { outputs: { settled: Array<{ ok: boolean }> } };
  expect(result.outputs.settled.map(item => item.ok)).toEqual([false, true]);
});

it('bounds worker CPU and history wire size before planning another effect', async () => {
  const root = makeRoot(); const source = join(root, 'source'); mkdirSync(source);
  const path = join(source, 'stuck.mjs');
  writeFileSync(path, 'export const stuck=()=>{while(true){}};\n');
  const port = new AuthorProcessReplayPort(path, 'stuck', workerPath, 100);
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION,
    input: { initialAgent: null, data: {}, config: {} }, history: [] };
  await expect(port.replay(request)).rejects.toThrow('exceeded');
  const oversized: AuthorReplayRequest = { ...request, history: [{ address: 'r/s0', kind: 'x', definitionVersion: 'algorithm.v1',
    inputDigest: '0'.repeat(64), outcome: { kind: 'result', value: 'x'.repeat(1024 * 1024) } }] };
  await expect(replay(algorithm(() => null), oversized)).rejects.toThrow('exceeds 1 MiB');
});


it('rejects invalid checkpoint name, schema, size and child ref before committing any intent', async () => {
  const cases: Array<[string, JsonValue, string]> = [
    ['', { x: 1 }, 'author.archive.v1'],
    ['population', { x: 1 }, 'custom.v1'],
    ['population', { x: 'x'.repeat(256 * 1024) }, 'author.archive.v1'],
    ['population', { child: { kind: 'artifact', digest: '0'.repeat(64), size: 1,
      mediaType: 'application/json', schemaId: 'author.archive.v1' } }, 'author.archive.v1'],
  ];
  for (const [name, value, schemaId] of cases) {
    const root = makeRoot(); const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const bindingStore = new BindingStore(artifacts, bindings);
    const initialBindingSetRef = bindingStore.create({});
    const definition = algorithm(async ctx => { await ctx.checkpoint(name, value, schemaId); return null; });
    const adapter = new AuthorAlgorithmAdapter({ id: 'bad-checkpoint', implementationDigest: sha256('bad-checkpoint'),
      hostIdentityDigest: sha256('host'), bindingSchema: bindings, artifacts, bindings: bindingStore,
      replay: request => replay(definition, request), initialAgent: null, data: {}, maxFrontierWaves: 10 });
    const checkpoint = new AuthorCheckpointProvider(artifacts, bindingStore);
    const runtime = new AlgorithmRuntime(root, adapter, [new AuthorObserveProvider(), checkpoint],
      { campaignId: 'bad-checkpoint', config: {}, initialBindingSetRef, budget: {} }, { artifacts });
    await expect(runtime.tick()).rejects.toThrow();
    expect(runtime.snapshot()).toBeNull();
  }
});


it('checks imported TS helpers and seals their bytes while rejecting imports outside the source root', async () => {
  const root = makeRoot(); const source = join(root, 'source'); mkdirSync(source);
  const helper = join(source, 'helper.mjs'); const outside = join(root, 'outside.mjs');
  const entry = join(source, 'author.mjs');
  const sdk = new URL('../../lib/algorithm/author/index.js', import.meta.url).href;
  writeFileSync(outside, 'export const outside=1;\n');
  writeFileSync(entry, "import '../outside.mjs'; export const sample=()=>null;\n");
  expect(() => new AuthorProcessReplayPort(entry, 'sample', workerPath)).toThrow('escapes frozen source root');
  writeFileSync(entry, "import 'left-pad'; export const sample=()=>null;\n");
  expect(() => new AuthorProcessReplayPort(entry, 'sample', workerPath)).toThrow('bare package import');
  writeFileSync(entry, "import 'node:crypto'; export const sample=()=>null;\n");
  expect(() => new AuthorProcessReplayPort(entry, 'sample', workerPath)).toThrow('bare package import');
  writeFileSync(entry, "import './helper.mjs'; export const sample=()=>null;\n");
  writeFileSync(helper, 'export const unsafe=()=>Date.now();\n');
  expect(() => new AuthorProcessReplayPort(entry, 'sample', workerPath)).toThrow('Date.now');
  writeFileSync(helper, 'export const helper=1;\n');
  writeFileSync(entry, `import './helper.mjs'; import {algorithm} from ${JSON.stringify(sdk)};\nexport const sample=algorithm(async ctx=>await ctx.operation('x',{}));\n`);
  const port = new AuthorProcessReplayPort(entry, 'sample', workerPath);
  expect(port.hostDigest).toBe(authorHostIdentityDigest(port.hostRoot));
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION,
    input: { initialAgent: null, data: {}, config: {} }, history: [] };
  expect((await port.replay(request)).status).toBe('waiting');
  writeFileSync(helper, 'export const helper=2;\n');
  await expect(port.replay(request)).rejects.toThrow('closure changed');
});


it('rejects forged control budgets, clock starts and binding overrides before intent commit', async () => {
  const controls = [
    { kind: 'author.observe', input: { kind: 'now' }, startsBudgetClock: true },
    { kind: 'author.observe', input: { kind: 'now' }, startsBudgetClock: 'yes' as never },
    { kind: 'author.checkpoint', input: { name: 'population', value: {}, schema: 'author.archive.v1' }, startsBudgetClock: null as never },
    { kind: 'author.checkpoint', input: { name: 'population', value: {}, schema: 'author.archive.v1' }, limits: { calls: 1 } },
  ] as const;
  for (const control of controls) {
    const root = makeRoot(); const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const bindingStore = new BindingStore(artifacts, bindings);
    const initialBindingSetRef = bindingStore.create({});
    const adapter = new AuthorAlgorithmAdapter({ id: 'forged-control', implementationDigest: sha256('forged'),
      hostIdentityDigest: sha256('host'), bindingSchema: bindings, artifacts, bindings: bindingStore,
      replay: async () => ({ status: 'waiting', frontier: [{ address: 'r/s0', definitionVersion: 'algorithm.v1', ...control }] }),
      initialAgent: null, data: {}, maxFrontierWaves: 10 });
    const runtime = new AlgorithmRuntime(root, adapter, [new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)],
      { campaignId: 'forged-control', config: {}, initialBindingSetRef, budget: {} }, { artifacts });
    await expect(runtime.tick()).rejects.toThrow('pure control');
    expect(runtime.snapshot()).toBeNull();
  }
});
