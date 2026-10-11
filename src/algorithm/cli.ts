/** Experimental standalone CLI; gear-refine forwarding is wired separately. */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Algorithm, AlgorithmManifest, ArtifactRef, CampaignSpec, ComponentManifest, OperationProvider } from './contracts.js';
import { ALGORITHM_API_VERSION } from './contracts.js';
import { FileArtifactStore } from './artifacts.js';
import { BindingStore } from './bindings.js';
import { PythonOperationProvider, PythonPolicyProvider, TypeScriptPolicyProvider } from './components.js';
import { loadPythonAlgorithm, loadPythonStepAlgorithm, loadPythonComponent, loadPythonProvider, pythonHostBridgeDigest, sourceTreeDigest, type PythonEntry } from './loader.js';
import { AlgorithmRuntime } from './runtime/engine.js';
import { STEP_API_VERSION, type Algorithm as StepAlgorithm } from './author/definition.js';
import { StepAlgorithmAdapter, type ExecutionServices } from './author/step-adapter.js';
import { initStepProject } from './author/project.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, type JsonSchema, type JsonValue } from './schema.js';

type Entry = { language: 'python'; interpreter: string; module: string; export: string; sdkPath?: string; resources?: string[] }
  | { language: 'typescript'; module: string; export: string; resources?: string[] };
type CampaignConfig = {
  schemaVersion: 1; kind: 'algorithm-campaign'; campaignId: string; stateDir: string; concurrency?: number;
  authoring?: 'step';
  host?: 'recorded';
  algorithm?: Entry; hostProfile?: Extract<Entry, { language: 'typescript' }>;
  config: JsonValue; bindings?: Record<string, ArtifactRef>;
  budget: CampaignSpec['budget']; providers?: Entry[]; hooks?: Record<string, Entry>;
};
type HookRequirement = { inputSchema: JsonSchema; outputSchema: JsonSchema; scope: ComponentManifest['scope']; operationKind?: string };
type Loaded = { algorithm?: Algorithm; author?: StepAlgorithm; sourceDigest?: string; requirements: Record<string, HookRequirement>; close(): Promise<void> };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function pathFrom(configDir: string, path: string): string { return isAbsolute(path) ? path : resolve(configDir, path); }
function pythonEntry(entry: Entry, configDir: string, stateDir?: string, artifacts?: FileArtifactStore): PythonEntry {
  if (entry.language !== 'python') throw new Error('Expected Python entry');
  return { configDir, interpreter: entry.interpreter, module: entry.module, export: entry.export,
    ...(entry.sdkPath ? { sdkPath: pathFrom(configDir, entry.sdkPath) } : {}),
    ...(stateDir ? { recordDir: stateDir } : {}), ...(artifacts ? { artifactBridge: artifacts } : {}),
    ...(entry.resources ? { resources: entry.resources } : {}) };
}

async function readConfig(path: string): Promise<{ config: CampaignConfig; configDir: string }> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  assertJson(raw);
  const input = object(raw, 'campaign config');
  if (input.schemaVersion !== 1 || input.kind !== 'algorithm-campaign' || typeof input.campaignId !== 'string' || typeof input.stateDir !== 'string') {
    throw new Error('Expected algorithm-campaign schemaVersion 1 with campaignId and stateDir');
  }
  if (!input.algorithm && !input.hostProfile) throw new Error('Algorithm or hostProfile is required');
  if (input.algorithm) {
    const algorithm = object(input.algorithm, 'algorithm');
    if (algorithm.language !== 'python' && algorithm.language !== 'typescript') throw new Error('Algorithm language must be python or typescript');
    if (typeof algorithm.module !== 'string' || typeof algorithm.export !== 'string') throw new Error('Algorithm module/export required');
    if (algorithm.language === 'python' && typeof algorithm.interpreter !== 'string') throw new Error('Python interpreter required');
  }
  if (input.hostProfile) {
    const profile = object(input.hostProfile, 'hostProfile');
    if (profile.language !== 'typescript' || typeof profile.module !== 'string' || typeof profile.export !== 'string')
      throw new Error('Host profile requires a TypeScript module/export');
  }
  if (input.config === undefined) throw new Error('Campaign config value required');
  if (!input.budget) throw new Error('Budget is required');
  if (input.bindings !== undefined) object(input.bindings, 'bindings');
  if (input.providers !== undefined && !Array.isArray(input.providers)) throw new Error('Providers must be an array');
  if (input.hooks !== undefined) object(input.hooks, 'hooks');
  return { config: input as CampaignConfig, configDir: dirname(resolve(path)) };
}

const loadedEsmClosures = new Map<string, string>();
let typeScriptLoaderRegistered = false;

/** Explicit ESM loading works throughout our Node range, including with native stripping disabled. */
function registerTypeScriptLoader(): void {
  if (typeScriptLoaderRegistered) return;
  registerHooks({ load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !fileURLToPath(url).endsWith('.ts')) return nextLoad(url, context);
    const path = fileURLToPath(url);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext,
          verbatimModuleSyntax: true } }).outputText };
  } });
  typeScriptLoaderRegistered = true;
}

async function tsModule(entry: Extract<Entry, { language: 'typescript' }>, configDir: string): Promise<{
  module: Record<string, unknown>; exported: Record<string, unknown>; modulePath: string; identity: string; environmentDigest: string
}> {
  const modulePath = pathFrom(configDir, entry.module);
  if (!/\.(mjs|js|ts)$/.test(modulePath)) throw new Error('TypeScript entry must be ESM .ts, .mjs, or .js');
  const relative = modulePath.startsWith(resolve(configDir) + '/') || modulePath.startsWith(resolve(configDir) + '\\');
  if (!relative) throw new Error('TypeScript entry must be inside its configuration directory');
  const sourceDigest = await sourceTreeDigest(configDir, [], true);
  const requireFromProject = createRequire(resolve(configDir, 'gear.algorithm.json'));
  const sdkIdentity: { spec: string; resolved: string; closureDigest: string; entrySha256: string }[] = [];
  for (const spec of ['rsi-gear/algorithm/author']) {
    let resolved: string;
    try { resolved = requireFromProject.resolve(spec); }
    catch { continue; } // Internal host-only projects may not import the public SDK.
    const bytes = await readFile(resolved);
    sdkIdentity.push({ spec, resolved, entrySha256: createHash('sha256').update(bytes).digest('hex'),
      closureDigest: await sourceTreeDigest(dirname(resolved)) });
  }
  const hostBridgeDigest = await pythonHostBridgeDigest();
  const compilerBytes = await readFile(createRequire(import.meta.url).resolve('typescript'));
  const compiler = { version: ts.version, sha256: createHash('sha256').update(compilerBytes).digest('hex') };
  const importClosureDigest = jsonDigest({ sourceDigest, sdkIdentity, hostBridgeDigest, compiler });
  const previousClosureDigest = loadedEsmClosures.get(resolve(configDir));
  if (previousClosureDigest && previousClosureDigest !== importClosureDigest) {
    throw new Error('Campaign identity drift: TypeScript ESM source or SDK changed in this process; start a new process before loading it again');
  }
  loadedEsmClosures.set(resolve(configDir), importClosureDigest);
  const bytes = await readFile(modulePath);
  registerTypeScriptLoader();
  const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const exported = object(module[entry.export], `TS export ${entry.export}`);
  const environmentDigest = jsonDigest({ node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    typescript: compiler });
  const identity = jsonDigest({ language: 'typescript', module: modulePath, export: entry.export,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceTreeDigest: await sourceTreeDigest(configDir, entry.resources ?? []), sdkIdentity,
    hostBridgeDigest, environmentDigest });
  return { module, exported, modulePath, identity, environmentDigest };
}

async function loadTsAlgorithm(entry: Extract<Entry, { language: 'typescript' }>, configDir: string,
  context: import('./host-profile.js').AlgorithmHostContext): Promise<Loaded> {
  const { module, exported, identity } = await tsModule(entry, configDir);
  const value = typeof exported.create === 'function'
    ? object(await (exported.create as (context: import('./host-profile.js').AlgorithmHostContext) => unknown).call(exported, context), 'TS algorithm factory result')
    : exported;
  if (typeof value.describe === 'function' && (value.describe as () => { apiVersion: string }).call(value).apiVersion === STEP_API_VERSION) {
    if (typeof value.step !== 'function') throw new Error('Explicit-state algorithm requires step(context)');
    return { author: value as unknown as StepAlgorithm, sourceDigest: identity, requirements: {}, close: async () => undefined };
  }
  if (typeof value.describe !== 'function' || typeof value.initialize !== 'function' || typeof value.reduce !== 'function') {
    throw new Error('TS algorithm export requires describe/initialize/reduce');
  }
  const declared = (value.describe as () => AlgorithmManifest).call(value);
  if (declared.apiVersion !== ALGORITHM_API_VERSION || !declared.id) throw new Error('TS algorithm manifest invalid');
  const manifest: AlgorithmManifest = { ...declared, implementationDigest: jsonDigest({ factorySource: identity,
    declaredImplementation: declared.implementationDigest ?? null }) };
  const algorithm: Algorithm = { describe: () => manifest,
    initialize: decision => (value.initialize as Algorithm['initialize']).call(value, decision),
    reduce: decision => (value.reduce as Algorithm['reduce']).call(value, decision) };
  const requirements = (module.requiredHooks ?? {}) as Record<string, HookRequirement>;
  object(requirements, 'requiredHooks');
  return { algorithm, requirements, close: async () => undefined };
}

async function loadTsComponent(entry: Extract<Entry, { language: 'typescript' }>, configDir: string): Promise<{
  value: ComponentManifest; invoke(input: JsonValue): Promise<JsonValue> | JsonValue; close(): Promise<void>
}> {
  const { exported, identity, environmentDigest } = await tsModule(entry, configDir);
  if (typeof exported.describe !== 'function' || typeof exported.invoke !== 'function') throw new Error('TS component requires describe/invoke');
  const declared = object((exported.describe as () => unknown).call(exported), 'TS component manifest');
  if (typeof declared.id !== 'string' || (declared.scope !== 'campaign' && declared.scope !== 'decision')) throw new Error('Invalid TS component id/scope');
  assertSchema(declared.inputSchema as JsonSchema); assertSchema(declared.outputSchema as JsonSchema);
  const manifest: ComponentManifest = { id: declared.id, apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: identity, environmentDigest, language: 'typescript',
    entrypoint: { module: entry.module, export: entry.export }, inputSchema: declared.inputSchema as JsonSchema,
    outputSchema: declared.outputSchema as JsonSchema, scope: declared.scope, capabilities: [], failureSemantics: 'typed-error' };
  return { value: manifest, invoke: input => (exported.invoke as (input: JsonValue) => Promise<JsonValue> | JsonValue).call(exported, input),
    close: async () => undefined };
}

async function loadTsProvider(entry: Extract<Entry, { language: 'typescript' }>, configDir: string): Promise<{
  value: OperationProvider; source: ComponentManifest; close(): Promise<void>
}> {
  const { exported, identity, environmentDigest } = await tsModule(entry, configDir);
  for (const method of ['describe', 'preflight', 'submit', 'inspect', 'cancel', 'collect']) {
    if (typeof exported[method] !== 'function') throw new Error(`TS provider requires ${method}`);
  }
  const declared = object((exported.describe as () => unknown).call(exported), 'TS provider manifest');
  if (typeof declared.kind !== 'string' || (declared.execution !== 'trusted-local' && declared.execution !== 'external')) throw new Error('Invalid TS provider manifest');
  assertSchema(declared.inputSchema as JsonSchema); assertSchema(declared.outputSchema as JsonSchema);
  if (declared.implementationDigest !== undefined && (typeof declared.implementationDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(declared.implementationDigest))) throw new Error('Invalid TS provider self implementationDigest');
  // A physical provider retains its own identity inside submit/inspect. The
  // loader's source closure is frozen separately in CampaignSpec.components.
  const manifest = { ...declared, implementationDigest: declared.implementationDigest ?? identity,
    meteredDimensions: declared.meteredDimensions ?? [] } as unknown as ReturnType<OperationProvider['describe']>;
  const provider: OperationProvider = { describe: () => manifest,
    preflight: envelope => (exported.preflight as OperationProvider['preflight']).call(exported, envelope),
    submit: envelope => (exported.submit as OperationProvider['submit']).call(exported, envelope),
    inspect: envelope => (exported.inspect as OperationProvider['inspect']).call(exported, envelope),
    cancel: envelope => (exported.cancel as OperationProvider['cancel']).call(exported, envelope),
    collect: envelope => (exported.collect as OperationProvider['collect']).call(exported, envelope) };
  const source: ComponentManifest = { id: `provider.${manifest.kind}`, scope: 'campaign', apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: identity, environmentDigest, language: 'typescript',
    entrypoint: { module: entry.module, export: entry.export },
    inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema,
    capabilities: ['provider', manifest.kind], failureSemantics: 'typed-error' };
  return { value: provider, source, close: async () => undefined };
}

async function loadAlgorithm(entry: Entry, configDir: string,
  context: import('./host-profile.js').AlgorithmHostContext, authoring?: 'step'): Promise<Loaded> {
  if (entry.language === 'typescript') return loadTsAlgorithm(entry, configDir, context);
  if (authoring === 'step') {
    const loaded = await loadPythonStepAlgorithm(pythonEntry(entry, configDir));
    return { author: loaded.value, sourceDigest: loaded.identity.implementationDigest, requirements: {}, close: loaded.close };
  }
  const loaded = await loadPythonAlgorithm(pythonEntry(entry, configDir));
  // Python algorithms express hooks through operation kinds; no implicit overrides.
  return { algorithm: loaded.value, requirements: loaded.requiredHooks, close: loaded.close };
}

async function loadTsHostProfile(entry: Extract<Entry, { language: 'typescript' }>, configDir: string,
  context: import('./host-profile.js').AlgorithmHostContext): Promise<{
    value: import('./host-profile.js').AlgorithmHostProfile; source: ComponentManifest; close(): Promise<void>
  }> {
  const { exported, identity, environmentDigest } = await tsModule(entry, configDir);
  if (typeof exported.create !== 'function') throw new Error('TS host profile requires create(context)');
  const raw = object(await (exported.create as (context: import('./host-profile.js').AlgorithmHostContext) => unknown).call(exported, context), 'host profile result');
  try {
  if (!Array.isArray(raw.providers)) throw new Error('Host profile must return providers array');
  const providers = raw.providers as OperationProvider[];
  for (const provider of providers) {
    if (!provider || typeof provider.describe !== 'function' || typeof provider.preflight !== 'function'
      || typeof provider.submit !== 'function' || typeof provider.inspect !== 'function'
      || typeof provider.cancel !== 'function' || typeof provider.collect !== 'function') {
      throw new Error('Host profile returned an invalid provider');
    }
  }
  const bindings = raw.bindings === undefined ? {} : object(raw.bindings, 'host profile bindings') as Record<string, ArtifactRef>;
  for (const [slot, ref] of Object.entries(bindings)) {
    if (typeof slot !== 'string' || ref?.kind !== 'artifact') throw new Error('Invalid host profile binding');
    context.artifacts.getBytes(ref);
  }
  const algorithm = raw.algorithm === undefined ? undefined : object(raw.algorithm, 'host profile algorithm') as unknown as Algorithm;
  if (raw.config !== undefined) assertJson(raw.config);
  if (raw.close !== undefined && typeof raw.close !== 'function') throw new Error('Host profile close must be a function');
  const source: ComponentManifest = { id: 'host-profile', scope: 'campaign', apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: identity, environmentDigest, language: 'typescript',
    entrypoint: { module: entry.module, export: entry.export }, inputSchema: { type: 'any' },
    outputSchema: { type: 'any' }, capabilities: ['host-profile'], failureSemantics: 'typed-error' };
  return { value: { ...(algorithm ? { algorithm } : {}), providers, bindings,
    ...(raw.execution ? { execution: raw.execution as ExecutionServices } : {}),
    ...(raw.config !== undefined ? { config: raw.config as JsonValue } : {}),
    ...(typeof raw.close === 'function' ? { close: raw.close as () => Promise<void> | void } : {}) }, source,
  close: async () => { if (typeof raw.close === 'function') await (raw.close as () => Promise<void> | void).call(raw); } };
  } catch (error) {
    if (typeof raw.close === 'function') await (raw.close as () => Promise<void> | void).call(raw);
    throw error;
  }
}

export async function algorithmCommand(argv: string[], emit: (line: string) => void = console.log): Promise<void> {
  const [action, operand, option] = argv;
  if (action === 'init') {
    if (!operand) throw new Error('Usage: algorithm init DIRECTORY [python|typescript]');
    await initStepProject(resolve(operand), option === 'typescript' ? 'typescript' : 'python');
    emit(`Created ${resolve(operand)}/gear.algorithm.json`);
    return;
  }
  if (!['check', 'explain', 'run', 'resume'].includes(action ?? '') || !operand) throw new Error('Usage: algorithm <init|check|run|resume> CONFIG');
  const { config, configDir } = await readConfig(operand);
  const root = pathFrom(configDir, config.stateDir);
  const projectRoot = resolve(configDir);
  const gearRoot = resolve(configDir, '.gear');
  if (root.startsWith(projectRoot + '/') && !root.startsWith(gearRoot + '/')) {
    throw new Error('In-project stateDir must be under .gear so runtime records stay outside the source identity');
  }
  const artifacts = new FileArtifactStore(resolve(root, 'artifacts'));
  const context: import('./host-profile.js').AlgorithmHostContext = Object.freeze({
    campaignId: config.campaignId, configDir, stateDir: root, config: structuredClone(config.config),
    budget: structuredClone(config.budget), artifacts,
  });
  const workers: { close(): Promise<void> }[] = [];
  let primaryError: unknown;
  try {
    const profile = config.hostProfile ? await loadTsHostProfile(config.hostProfile, configDir, context)
      : config.host === 'recorded' ? { value: await (await import('./author/recorded-host.js')).createRecordedExecutionHost(context),
        close: async () => undefined, source: undefined } : undefined;
    if (profile) workers.push(profile);
    if (profile?.value.algorithm && config.algorithm) throw new Error('Both algorithm entry and host profile algorithm supplied');
    const loaded = config.algorithm ? await loadAlgorithm(config.algorithm, configDir, context, config.authoring) : undefined;
    if (loaded) workers.push(loaded);
    const profileAlgorithm = profile?.value.algorithm;
    if (!loaded && !profileAlgorithm) throw new Error('Host profile did not return an algorithm');
    const stepAdapter = loaded?.author ? (() => {
      if (!profile?.value.execution) throw new Error('Step algorithm requires an execution host');
      const execution = profile.value.execution;
      return new StepAlgorithmAdapter(loaded.author, execution, artifacts, new BindingStore(artifacts, execution.bindingSchema), loaded.sourceDigest!);
    })() : undefined;
    const algorithm: Algorithm = stepAdapter ?? loaded?.algorithm ?? {
      describe: () => { const declared = profileAlgorithm!.describe(); return { ...declared,
        implementationDigest: jsonDigest({ hostProfileSource: profile!.source?.implementationDigest ?? null,
          declaredImplementation: declared.implementationDigest ?? null }) }; },
      initialize: decision => profileAlgorithm!.initialize(decision),
      reduce: decision => profileAlgorithm!.reduce(decision),
    };
    const resolvedConfig = profile?.value.config ?? config.config;
    const providers: OperationProvider[] = [...profile?.value.providers ?? []];
    const componentManifests: Record<string, ComponentManifest> = {};
    if (profile?.source) componentManifests['host-profile'] = profile.source;
    const expected = loaded?.requirements ?? {};
    for (const name of Object.keys(config.hooks ?? {})) if (!Object.hasOwn(expected, name)) throw new Error(`Unknown hook ${name}`);
    for (const name of Object.keys(expected)) if (!config.hooks?.[name]) throw new Error(`Required hook ${name} is missing`);
    for (const [name, entry] of Object.entries(config.hooks ?? {})) {
      const hook = entry.language === 'python'
        ? await loadPythonComponent(pythonEntry(entry, configDir)) : await loadTsComponent(entry, configDir);
      workers.push(hook);
      const manifest = hook.value;
      if (manifest.id !== name) throw new Error(`Hook ${name} manifest id mismatch: ${manifest.id}`);
      const requirement = expected[name]!;
      if (canonicalJson(manifest.inputSchema) !== canonicalJson(requirement.inputSchema) ||
          canonicalJson(manifest.outputSchema) !== canonicalJson(requirement.outputSchema) || manifest.scope !== requirement.scope) {
        throw new Error(`Hook ${name} schema/scope mismatch`);
      }
      componentManifests[name] = manifest;
      const operationKind = requirement.operationKind ?? (Object.keys(expected).length === 1 ? 'policy.decide' : `policy.decide.${name}`);
      const recordRoot = resolve(root, 'provider-records', 'hooks', name);
      if (entry.language === 'python') {
        if (!('worker' in hook)) throw new Error('Python hook worker missing');
        providers.push(new PythonPolicyProvider(manifest, hook.worker, recordRoot, operationKind));
      } else {
        if (!('invoke' in hook)) throw new Error('TypeScript hook invoke missing');
        providers.push(new TypeScriptPolicyProvider(manifest, hook.invoke, recordRoot, operationKind));
      }
    }
    for (const [index, entry] of (config.providers ?? []).entries()) {
      if (entry.language === 'python') {
        const provider = await loadPythonProvider(pythonEntry(entry, configDir, action === 'check' ? undefined : resolve(root, 'provider-records', String(index)), action === 'check' ? undefined : artifacts));
        workers.push(provider);
        providers.push(new PythonOperationProvider(provider.value, provider.worker));
      } else {
        const provider = await loadTsProvider(entry, configDir);
        workers.push(provider);
        providers.push(provider.value);
        componentManifests[`provider.${index}`] = provider.source;
      }
    }
    await mkdir(root, { recursive: true });
    for (const [dimension, limit] of Object.entries(config.budget)) {
      if (limit.capability === 'hard' && !providers.some(provider => provider.describe().hardLimitDimensions?.includes(dimension))) {
        throw new Error(`No provider can enforce hard budget ${dimension}`);
      }
    }
    const bindings = new BindingStore(artifacts, algorithm.describe().bindingSchema);
    const slotRefs = { ...profile?.value.bindings };
    for (const [slot, ref] of Object.entries(config.bindings ?? {})) {
      if (Object.hasOwn(slotRefs, slot)) throw new Error(`Duplicate initial binding slot ${slot}`);
      slotRefs[slot] = ref;
    }
    const initialBindingSetRef = bindings.create(slotRefs);
    const spec: CampaignSpec = { campaignId: config.campaignId, ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }), config: resolvedConfig, initialBindingSetRef,
      budget: config.budget, components: componentManifests };
    const runtime = new AlgorithmRuntime(root, algorithm, providers, spec);
    const existing = runtime.snapshot();
    if (action === 'check' || action === 'explain') {
      emit(JSON.stringify({ ok: true, campaignId: config.campaignId, algorithm: algorithm.describe().id,
        providers: providers.map(provider => provider.describe().kind), hooks: Object.keys(componentManifests),
        resumable: existing !== null }));
      return;
    }
    if (action === 'run' && existing) throw new Error('Campaign already exists; use resume');
    if (action === 'resume' && !existing) throw new Error('Campaign does not exist; use run');
    const observer = new AbortController();
    const stop = () => observer.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    let status: 'complete' | 'waiting' = 'waiting';
    try {
      while (!observer.signal.aborted) {
        const advanced = await runtime.tick();
        if (advanced === 'complete') { status = 'complete'; break; }
        if (advanced === 'waiting') await new Promise<void>(resolveWait => {
          const done = () => { clearTimeout(timer); observer.signal.removeEventListener('abort', done); resolveWait(); };
          const timer = setTimeout(done, 250);
          observer.signal.addEventListener('abort', done, { once: true });
          if (observer.signal.aborted) done();
        });
      }
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    emit(JSON.stringify({ status, campaignId: config.campaignId, ...(stepAdapter && runtime.snapshot() ? { result: stepAdapter.readResult(runtime.snapshot()!) } : {}), snapshot: runtime.snapshot() }));
  } catch (error) { primaryError = error; throw error; }
  finally {
    const results = await Promise.allSettled(workers.reverse().map(worker => worker.close()));
    const cleanupFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (cleanupFailure) {
      if (primaryError instanceof Error && primaryError.cause === undefined) primaryError.cause = cleanupFailure.reason;
      else if (primaryError === undefined) throw cleanupFailure.reason;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  algorithmCommand(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
