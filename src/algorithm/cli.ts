/** Experimental standalone CLI; gear-refine forwarding is wired separately. */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Algorithm, AlgorithmManifest, ArtifactRef, CampaignSpec, ComponentManifest, OperationProvider } from './contracts.js';
import { ALGORITHM_API_VERSION } from './contracts.js';
import { FileArtifactStore } from './artifacts.js';
import { BindingStore } from './bindings.js';
import { PythonOperationProvider, PythonPolicyProvider, TypeScriptPolicyProvider } from './components.js';
import { loadPythonAlgorithm, loadPythonComponent, loadPythonProvider, pythonHostBridgeDigest, sourceTreeDigest, type PythonEntry } from './loader.js';
import { AlgorithmRuntime } from './runtime/engine.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, type JsonSchema, type JsonValue } from './schema.js';

type Entry = { language: 'python'; interpreter: string; module: string; export: string; sdkPath?: string; resources?: string[] }
  | { language: 'typescript'; module: string; export: string; resources?: string[] };
type CampaignConfig = {
  schemaVersion: 1; kind: 'algorithm-campaign'; campaignId: string; stateDir: string;
  algorithm?: Entry; hostProfile?: Extract<Entry, { language: 'typescript' }>;
  config: JsonValue; bindings?: Record<string, ArtifactRef>;
  budget: CampaignSpec['budget']; providers?: Entry[]; hooks?: Record<string, Entry>;
};
type HookRequirement = { inputSchema: JsonSchema; outputSchema: JsonSchema; scope: ComponentManifest['scope']; operationKind?: string };
type Loaded = { algorithm: Algorithm; requirements: Record<string, HookRequirement>; close(): Promise<void> };

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

async function assertTsSourceClosure(root: string): Promise<{ sdkImports: string[]; sourceDigest: string }> {
  const sdkImports = new Set<string>();
  const sources: { path: string; digest: string }[] = [];
  const skip = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.gear', 'dist', 'build']);
  const base = resolve(root);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`ESM source symlink is outside the closed source tree: ${path}`);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !/\.(mjs|js|cjs)$/.test(entry.name)) continue;
      const source = await readFile(path, 'utf8');
      if (entry.name.endsWith('.cjs') || /\b(?:module\.)?require\s*\(/u.test(source)) {
        throw new Error('CommonJS require needs a separately sealed bundle');
      }
      sources.push({ path: path.slice(base.length + 1), digest: createHash('sha256').update(source).digest('hex') });
      if (/\bimport\s*\(/.test(source) || /\bcreateRequire\s*\(/.test(source)) {
        throw new Error('Dynamic imports and createRequire need a separately sealed bundle');
      }
      const specs = [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map(match => match[1]!);
      for (const spec of specs) {
        if (spec.startsWith('node:')) continue;
        if (['rsi-gear/algorithm', 'rsi-gear/algorithm/testing', 'rsi-gear/algorithm/recipes',
          'rsi-gear/algorithm/gepa',
          'rsi-gear/algorithm/training', 'rsi-gear/algorithm/harness'].includes(spec)) {
          sdkImports.add(spec); continue;
        }
        if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`External ESM import must be bundled: ${spec}`);
        const target = resolve(dirname(path), spec);
        if (!target.startsWith(base + '/')) throw new Error(`ESM import escapes source closure: ${spec}`);
      }
    }
  }
  await visit(base);
  sources.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { sdkImports: [...sdkImports].sort(), sourceDigest: jsonDigest(sources) };
}

async function tsModule(entry: Extract<Entry, { language: 'typescript' }>, configDir: string): Promise<{
  module: Record<string, unknown>; exported: Record<string, unknown>; modulePath: string; identity: string; environmentDigest: string
}> {
  const modulePath = pathFrom(configDir, entry.module);
  if (!/\.(mjs|js)$/.test(modulePath)) throw new Error('TypeScript entry must be built ESM .mjs or .js');
  const relative = modulePath.startsWith(resolve(configDir) + '/') || modulePath.startsWith(resolve(configDir) + '\\');
  if (!relative) throw new Error('TypeScript entry must be inside its configuration directory');
  const closure = await assertTsSourceClosure(configDir);
  const requireFromProject = createRequire(resolve(configDir, 'gear.algorithm.json'));
  const sdkIdentity: { spec: string; resolved: string; closureDigest: string; entrySha256: string }[] = [];
  for (const spec of closure.sdkImports) {
    let resolved: string;
    try { resolved = requireFromProject.resolve(spec); }
    catch { throw new Error(`Public Gear SDK import is unavailable: ${spec}`); }
    const bytes = await readFile(resolved);
    sdkIdentity.push({ spec, resolved, entrySha256: createHash('sha256').update(bytes).digest('hex'),
      closureDigest: await sourceTreeDigest(dirname(resolved)) });
  }
  const hostBridgeDigest = await pythonHostBridgeDigest();
  const importClosureDigest = jsonDigest({ sourceDigest: closure.sourceDigest, sdkIdentity, hostBridgeDigest });
  const previousClosureDigest = loadedEsmClosures.get(resolve(configDir));
  if (previousClosureDigest && previousClosureDigest !== importClosureDigest) {
    throw new Error('Campaign identity drift: TypeScript ESM source or SDK changed in this process; start a new process before loading it again');
  }
  loadedEsmClosures.set(resolve(configDir), importClosureDigest);
  const bytes = await readFile(modulePath);
  const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const exported = object(module[entry.export], `TS export ${entry.export}`);
  const environmentDigest = jsonDigest({ node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch });
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
  context: import('./host-profile.js').AlgorithmHostContext): Promise<Loaded> {
  if (entry.language === 'typescript') return loadTsAlgorithm(entry, configDir, context);
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
    await initTemplate(resolve(operand), option === 'typescript' ? 'typescript' : 'python');
    emit(`Created ${resolve(operand)}/gear.algorithm.json`);
    return;
  }
  if (!['check', 'run', 'resume'].includes(action ?? '') || !operand) throw new Error('Usage: algorithm <init|check|run|resume> CONFIG');
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
    const profile = config.hostProfile ? await loadTsHostProfile(config.hostProfile, configDir, context) : undefined;
    if (profile) workers.push(profile);
    if (profile?.value.algorithm && config.algorithm) throw new Error('Both algorithm entry and host profile algorithm supplied');
    const loaded = config.algorithm ? await loadAlgorithm(config.algorithm, configDir, context) : undefined;
    if (loaded) workers.push(loaded);
    const profileAlgorithm = profile?.value.algorithm;
    if (!loaded && !profileAlgorithm) throw new Error('Host profile did not return an algorithm');
    const algorithm: Algorithm = loaded?.algorithm ?? {
      describe: () => { const declared = profileAlgorithm!.describe(); return { ...declared,
        implementationDigest: jsonDigest({ hostProfileSource: profile!.source.implementationDigest,
          declaredImplementation: declared.implementationDigest ?? null }) }; },
      initialize: decision => profileAlgorithm!.initialize(decision),
      reduce: decision => profileAlgorithm!.reduce(decision),
    };
    const resolvedConfig = profile?.value.config ?? config.config;
    const providers: OperationProvider[] = [...profile?.value.providers ?? []];
    const componentManifests: Record<string, ComponentManifest> = {};
    if (profile) componentManifests['host-profile'] = profile.source;
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
    const spec: CampaignSpec = { campaignId: config.campaignId, config: resolvedConfig, initialBindingSetRef,
      budget: config.budget, components: componentManifests };
    const runtime = new AlgorithmRuntime(root, algorithm, providers, spec);
    const existing = runtime.snapshot();
    if (action === 'check') {
      emit(JSON.stringify({ ok: true, campaignId: config.campaignId, algorithm: algorithm.describe().id,
        providers: providers.map(provider => provider.describe().kind), hooks: Object.keys(componentManifests),
        resumable: existing !== null }));
      return;
    }
    if (action === 'run' && existing) throw new Error('Campaign already exists; use resume');
    if (action === 'resume' && !existing) throw new Error('Campaign does not exist; use run');
    const status = await runtime.runUntilBlocked();
    emit(JSON.stringify({ status, campaignId: config.campaignId, snapshot: runtime.snapshot() }));
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

async function initTemplate(directory: string, language: 'python' | 'typescript'): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'gear.algorithm.json');
  try { await stat(path); throw new Error(`Template already exists: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const basename = directory.split(/[\\/]/).at(-1)?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'campaign';
  const prefix = /^[A-Za-z]/u.test(basename) ? basename : `campaign-${basename}`;
  const campaignId = `${prefix}-${randomUUID()}`;
  const config = { schemaVersion: 1, kind: 'algorithm-campaign', campaignId, stateDir: `./.gear/${campaignId}`,
    algorithm: language === 'python'
      ? { language: 'python', interpreter: 'python3.11', module: './algorithm.py', export: 'algorithm' }
      : { language: 'typescript', module: './recipe.mjs', export: 'algorithm' },
    config: {}, bindings: {}, budget: {}, hooks: language === 'typescript'
      ? { choose: { language: 'python', interpreter: 'python3.11', module: './choose.py', export: 'choose' } }
      : undefined,
    providers: language === 'python'
      ? [{ language: 'python', interpreter: 'python3.11', module: './echo.py', export: 'provider' }] : [] };
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  if (language === 'python') {
    await writeFile(resolve(directory, 'algorithm.py'), PYTHON_ALGORITHM, { flag: 'wx' });
    await writeFile(resolve(directory, 'echo.py'), PYTHON_ECHO, { flag: 'wx' });
  } else {
    await writeFile(resolve(directory, 'recipe.mjs'), TS_RECIPE, { flag: 'wx' });
    await writeFile(resolve(directory, 'choose.py'), PYTHON_HOOK, { flag: 'wx' });
  }
}

const PYTHON_ALGORITHM = `from gear_algorithm import AlgorithmManifest, advance, task\n\n@task("echo", kind="toy.echo")\ndef echo(value):\n    return {"value": value}\n\nclass Toy:\n    def describe(self):\n        return AlgorithmManifest(id="python-toy", stateSchema={"type":"object"}, configSchema={"type":"object"}, bindingSchema={"id":"toy-bindings","slots":{}}, requiredOperationKinds=("toy.echo",))\n    def initialize(self, context):\n        return advance({"step":"echo"}, echo("hello"))\n    def reduce(self, context):\n        return advance({"step":"done","reply":context["completed"]["echo"]}, complete=True)\n\nalgorithm = Toy()\n`;
const PYTHON_ECHO = `from gear_algorithm import DurableLocalProvider, ProviderManifest\n\nclass Echo(DurableLocalProvider):\n    def __init__(self):\n        super().__init__(ProviderManifest("toy.echo", {"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False}, {"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False}))\n    def execute(self, request):\n        return {"kind":"result","value":request["input"]}\n\nprovider = Echo()\n`;
const PYTHON_HOOK = `from gear_algorithm import component\n\n@component(id="choose", input_schema={"type":"object","properties":{"options":{"type":"array","items":{"type":"string"}}},"required":["options"],"additionalProperties":False}, output_schema={"type":"object","properties":{"choice":{"type":"string"}},"required":["choice"],"additionalProperties":False}, scope="campaign")\ndef choose(value):\n    return {"choice": value["options"][0]}\n`;
const TS_RECIPE = `import { defineWorkflow, task } from 'rsi-gear/algorithm';\n\nexport const requiredHooks = { choose: { inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false }, outputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false }, scope: 'campaign' } };\n\nexport const algorithm = defineWorkflow({\n  manifest: { id: 'ts-toy', apiVersion: 'gear.algorithm.experimental.v1', configSchema: { type: 'object' }, bindingSchema: { id: 'toy-bindings', slots: {} }, requiredOperationKinds: ['policy.decide'] },\n  businessStateSchema: { type: 'object' },\n  initialState: () => ({}),\n  steps: [{\n    name: 'choose',\n    plan: () => [task('choose', 'policy.decide', { options: ['alpha', 'beta'] })],\n    join: context => ({ state: { decision: context.completed.choose } }),\n  }],\n});\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  algorithmCommand(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
