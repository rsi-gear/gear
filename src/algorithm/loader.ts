import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Algorithm, AlgorithmDecision, AlgorithmManifest, ComponentManifest, DecisionContext, ProviderManifest, ReduceContext } from './contracts.js';
import { ALGORITHM_API_VERSION } from './contracts.js';
import { assertJson, assertSchema, jsonDigest, type JsonSchema, type JsonValue } from './schema.js';
import { PythonWorker, type PythonWorkerOptions } from './hosts/python.js';

export type PythonEntry = Omit<PythonWorkerOptions, 'mode'> & { resources?: string[] };
export type PythonIdentity = { implementationDigest: string; environmentDigest: string; sourceDigest: string; hostBridgeDigest: string; environment: JsonValue };
export type LoadedPython<T> = { value: T; identity: PythonIdentity; worker: PythonWorker; close(): Promise<void> };

function record(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must return a JSON object`);
  return value;
}

function schema(value: JsonValue, label: string): JsonSchema {
  const object = record(value, label);
  assertSchema(object as JsonSchema);
  return object as JsonSchema;
}

export async function sourceTreeDigest(root: string, resources: string[] = []): Promise<string> {
  const files: { path: string; digest: string }[] = [];
  const skip = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.gear', 'dist', 'build']);
  async function visit(directory: string, prefix: string): Promise<void> {
    if (files.length > 1024) throw new Error('Python project has too many source files for experimental loader');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is outside the closed source tree: ${relative}`);
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile() && (/\.(py|pyi|js|mjs|cjs|ts|json|toml|lock|yaml|yml)$/.test(entry.name) || /^requirements.*\.txt$/.test(entry.name))) {
        const bytes = await readFile(path);
        if (bytes.length > 4 * 1024 * 1024) throw new Error(`Python source too large: ${relative}`);
        files.push({ path: relative, digest: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root, '');
  for (const named of resources) {
    const path = resolve(root, named);
    const metadata = await readFile(path);
    if (metadata.length > 64 * 1024 * 1024) throw new Error(`Declared resource too large: ${named}`);
    files.push({ path: `resource:${path}`, digest: createHash('sha256').update(metadata).digest('hex') });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return jsonDigest(files);
}

const PYTHON_HOST_BRIDGE_FILES = ['loader', 'components', 'cli', 'hosts/python'];

/** Hash the actual TS/JS bridge files that interpret Python author code. */
export async function pythonHostBridgeDigest(
  root = dirname(fileURLToPath(import.meta.url)),
  extension = extname(fileURLToPath(import.meta.url)),
): Promise<string> {
  const hash = createHash('sha256');
  for (const name of PYTHON_HOST_BRIDGE_FILES) {
    const relative = `${name}${extension}`;
    const bytes = await readFile(join(root, relative));
    hash.update(relative); hash.update('\0');
    hash.update(String(bytes.length)); hash.update('\0');
    hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}

async function loadWorker(entry: PythonEntry, mode: PythonWorkerOptions['mode']): Promise<{ worker: PythonWorker; identity: PythonIdentity; declared: Record<string, JsonValue> }> {
  const worker = await PythonWorker.start({ ...entry, mode });
  try {
    const declared = record(await worker.call('describe'), 'describe');
    const environment = await worker.call('environment.describe');
    const envObject = record(environment, 'environment.describe');
    if (envObject.fcntlAvailable !== true) throw new Error('Python interpreter needs fcntl for the local durable host');
    const projectDigest = await sourceTreeDigest(resolve(entry.configDir), entry.resources ?? []);
    const sdkDigest = entry.sdkPath ? await sourceTreeDigest(resolve(entry.sdkPath)) : null;
    const hostBridgeDigest = await pythonHostBridgeDigest();
    const sourceDigest = jsonDigest({ projectDigest, sdkDigest, sourcePath: envObject.sourcePath ?? null,
      sourceSha256: envObject.sourceSha256 ?? null, hostBridgeDigest });
    const environmentDigest = jsonDigest({ interpreter: envObject.interpreter ?? null,
      pythonVersion: envObject.pythonVersion ?? null, packages: envObject.packages ?? null, loadedModules: envObject.loadedModules ?? null });
    const implementationDigest = jsonDigest({ language: 'python', mode, module: entry.module,
      export: entry.export, sourceDigest, environmentDigest, declared });
    return { worker, declared, identity: { implementationDigest, environmentDigest, sourceDigest, hostBridgeDigest, environment } };
  } catch (error) { await worker.close(); throw error; }
}

export async function loadPythonAlgorithm(entry: PythonEntry): Promise<LoadedPython<Algorithm> & {
  requiredHooks: Record<string, { inputSchema: JsonSchema; outputSchema: JsonSchema; scope: 'campaign' | 'decision'; operationKind?: string }>
}> {
  const { worker, identity, declared } = await loadWorker(entry, 'algorithm');
  try {
    if (declared.apiVersion !== ALGORITHM_API_VERSION || typeof declared.id !== 'string') throw new Error('Python algorithm manifest has invalid API version or id');
    const stateSchema = schema(declared.stateSchema!, 'stateSchema');
    const configSchema = schema(declared.configSchema!, 'configSchema');
    const bindingSchema = record(declared.bindingSchema!, 'bindingSchema') as unknown as AlgorithmManifest['bindingSchema'];
    const requiredKinds = declared.requiredOperationKinds ?? [];
    if (!Array.isArray(requiredKinds) || !requiredKinds.every(kind => typeof kind === 'string')
      || new Set(requiredKinds).size !== requiredKinds.length) {
      throw new Error('Python algorithm requiredOperationKinds must be a unique string array');
    }
    const configKeys = declared.requiredOperationKindsFromConfig ?? [];
    if (!Array.isArray(configKeys) || !configKeys.every(key => typeof key === 'string')
      || new Set(configKeys).size !== configKeys.length) {
      throw new Error('Python algorithm requiredOperationKindsFromConfig must be a unique string array');
    }
    const projectionSchemas = declared.requiredProjectionSchemas === undefined ? [] : declared.requiredProjectionSchemas;
    if (!Array.isArray(projectionSchemas) || !projectionSchemas.every(id => typeof id === 'string' && id.length > 0)
      || new Set(projectionSchemas).size !== projectionSchemas.length) {
      throw new Error('Python algorithm requiredProjectionSchemas must be a unique nonempty string array');
    }
    const manifest: AlgorithmManifest = { id: declared.id, apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: identity.implementationDigest, stateSchema, configSchema, bindingSchema,
      requiredOperationKinds: requiredKinds as string[], requiredOperationKindsFromConfig: configKeys as string[],
      requiredProjectionSchemas: projectionSchemas as string[] };
    const rawRequirements = declared.requiredHooks ?? {};
    const requirementsObject = record(rawRequirements, 'requiredHooks');
    const requiredHooks: Record<string, { inputSchema: JsonSchema; outputSchema: JsonSchema; scope: 'campaign' | 'decision'; operationKind?: string }> = {};
    for (const [name, value] of Object.entries(requirementsObject)) {
      const requirement = record(value, `requiredHooks.${name}`);
      if (requirement.scope !== 'campaign' && requirement.scope !== 'decision') throw new Error(`Hook ${name} scope invalid`);
      if (requirement.operationKind !== undefined && typeof requirement.operationKind !== 'string') throw new Error(`Hook ${name} operationKind invalid`);
      requiredHooks[name] = { inputSchema: schema(requirement.inputSchema!, `requiredHooks.${name}.inputSchema`),
        outputSchema: schema(requirement.outputSchema!, `requiredHooks.${name}.outputSchema`), scope: requirement.scope,
        ...(requirement.operationKind === undefined ? {} : { operationKind: requirement.operationKind }) };
    }
    const value: Algorithm = {
      describe: () => manifest,
      initialize: async (context: DecisionContext) => record(await worker.call('algorithm.initialize', context), 'initialize') as AlgorithmDecision,
      reduce: async (context: ReduceContext) => record(await worker.call('algorithm.reduce', context), 'reduce') as AlgorithmDecision,
    };
    return { value, identity, worker, requiredHooks, close: () => worker.close() };
  } catch (error) { await worker.close(); throw error; }
}

export async function loadPythonComponent(entry: PythonEntry): Promise<LoadedPython<ComponentManifest>> {
  const { worker, identity, declared } = await loadWorker(entry, 'component');
  try {
    if (declared.apiVersion !== ALGORITHM_API_VERSION || typeof declared.id !== 'string' || declared.language !== 'python') {
      throw new Error('Python component manifest has invalid API version, id or language');
    }
    if (declared.scope !== 'campaign' && declared.scope !== 'decision') throw new Error('Python component scope must be campaign or decision');
    const capabilities = declared.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.every(item => typeof item === 'string')) throw new Error('Python component capabilities must be strings');
    const manifest: ComponentManifest = { id: declared.id, apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: identity.implementationDigest, environmentDigest: identity.environmentDigest,
      language: 'python', entrypoint: { module: entry.module, export: entry.export, interpreter: entry.interpreter },
      inputSchema: schema(declared.inputSchema!, 'inputSchema'), outputSchema: schema(declared.outputSchema!, 'outputSchema'),
      scope: declared.scope, capabilities: capabilities as string[], failureSemantics: 'typed-error' };
    return { value: manifest, identity, worker, close: () => worker.close() };
  } catch (error) { await worker.close(); throw error; }
}

export async function loadPythonProvider(entry: PythonEntry): Promise<LoadedPython<ProviderManifest>> {
  const { worker, identity, declared } = await loadWorker(entry, 'provider');
  try {
    if (typeof declared.kind !== 'string' || !declared.kind) throw new Error('Python provider kind is missing');
    if (declared.execution !== 'trusted-local' && declared.execution !== 'external') throw new Error('Python provider execution must be declared');
    if (declared.supportsInspect !== true) throw new Error('Python provider must support inspect');
    const dimensions = declared.hardLimitDimensions;
    const metered = declared.meteredDimensions;
    if (dimensions !== undefined && (!Array.isArray(dimensions) || !dimensions.every(item => typeof item === 'string'))) {
      throw new Error('Python provider hardLimitDimensions must be strings');
    }
    if (!Array.isArray(metered) || !metered.every(item => typeof item === 'string')) throw new Error('Python provider meteredDimensions must be strings');
    const manifest: ProviderManifest = { kind: declared.kind, implementationDigest: identity.implementationDigest,
      meteredDimensions: metered as string[],
      inputSchema: schema(declared.inputSchema!, 'inputSchema'), outputSchema: schema(declared.outputSchema!, 'outputSchema'),
      execution: declared.execution, supportsInspect: true, ...(dimensions === undefined ? {} : { hardLimitDimensions: dimensions as string[] }) };
    return { value: manifest, identity, worker, close: () => worker.close() };
  } catch (error) { await worker.close(); throw error; }
}

export async function checkPythonEntry(entry: PythonEntry, mode: PythonWorkerOptions['mode']): Promise<PythonIdentity> {
  const loaded = mode === 'algorithm' ? await loadPythonAlgorithm(entry)
    : mode === 'component' ? await loadPythonComponent(entry) : await loadPythonProvider(entry);
  try { return loaded.identity; } finally { await loaded.close(); }
}
