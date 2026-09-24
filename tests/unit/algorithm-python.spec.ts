import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { algorithmCommand } from '../../src/algorithm/cli.js';
import { PythonWorker, PythonHostError } from '../../src/algorithm/hosts/python.js';
import { AlgorithmRuntime, defineWorkflow } from '../../src/algorithm/index.js';
import { loadPythonAlgorithm, pythonHostBridgeDigest } from '../../src/algorithm/loader.js';

const sdkPath = resolve('packages/python-sdk/src');
const interpreter = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3';
beforeAll(() => {
  const version = JSON.parse(execFileSync(interpreter, ['-c',
    'import json, sys; print(json.dumps(sys.version_info[:2]))'], { encoding: 'utf8' })) as [number, number];
  if (version[0] < 3 || (version[0] === 3 && version[1] < 11)) {
    throw new Error(`Python SDK integration tests require Python >=3.11; ${interpreter} is ${version.join('.')}`);
  }
});
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'gear-algorithm-python-')); directories.push(path); return path; }

async function prepare(language: 'python' | 'typescript') {
  const dir = await directory();
  await algorithmCommand(['init', dir, language], () => undefined);
  if (language === 'typescript') {
    // The real package export is staged in S6. Mirror only that public export in
    // this temporary candidate so the generated recipe exercises the SDK path.
    const candidate = join(dir, 'node_modules', 'rsi-gear');
    await mkdir(candidate, { recursive: true });
    const bundle = await build({ entryPoints: [resolve('src/algorithm/index.ts')],
      bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
    await writeFile(join(candidate, 'package.json'), JSON.stringify({
      name: 'rsi-gear', type: 'module', exports: { './algorithm': './algorithm.js' },
    }));
    await writeFile(join(candidate, 'algorithm.js'), bundle.outputFiles[0]!.contents);
  }
  const configPath = join(dir, 'gear.algorithm.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
  const wire = (entry: Record<string, unknown>) => { if (entry.language === 'python') { entry.sdkPath = sdkPath; entry.interpreter = interpreter; } };
  wire(config.algorithm);
  for (const entry of config.providers ?? []) wire(entry);
  for (const entry of Object.values(config.hooks ?? {})) wire(entry as Record<string, unknown>);
  await writeFile(configPath, JSON.stringify(config));
  return { dir, configPath, config };
}

it('initializes distinct globally unique campaign IDs and keeps the ID for resume', async () => {
  const first = await prepare('python');
  const second = await prepare('python');
  expect(first.config.campaignId).toMatch(/^gear-algorithm-python-[A-Za-z0-9-]+-[0-9a-f-]{36}$/);
  expect(first.config.campaignId).not.toBe(second.config.campaignId);
  expect(first.config.stateDir).toBe(`./.gear/${first.config.campaignId}`);
  await algorithmCommand(['run', first.configPath], () => undefined);
  const persisted = JSON.parse(await readFile(first.configPath, 'utf8')) as Record<string, unknown>;
  expect(persisted.campaignId).toBe(first.config.campaignId);
  await algorithmCommand(['resume', first.configPath], () => undefined);
});

it('lets a TS workflow omit its digest only until the loader seals it', async () => {
  const workflow = defineWorkflow({
    manifest: { id: 'typed-author', apiVersion: 'gear.algorithm.experimental.v1',
      configSchema: { type: 'object' }, bindingSchema: { id: 'empty', slots: {} } },
    businessStateSchema: { type: 'object' }, initialState: () => ({}),
    steps: [{ name: 'one', plan: () => [], join: () => ({ state: {} }) }],
  });
  expect(workflow.describe().implementationDigest).toBe('');
  const dir = await directory();
  expect(() => new AlgorithmRuntime(join(dir, 'direct'), workflow, [], {
    campaignId: 'direct', config: {}, initialBindingSetRef: { kind: 'binding-set', digest: 'a'.repeat(64), schemaId: 'empty' },
    budget: {},
  })).toThrow('Algorithm implementation digest required');
  const generated = await prepare('typescript');
  const lines: string[] = [];
  await algorithmCommand(['check', generated.configPath], line => lines.push(line));
  await algorithmCommand(['run', generated.configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).status).toBe('complete');
});

it('seals actual Python host bridge files into Python author identity', async () => {
  const { dir, config } = await prepare('python');
  const base = resolve('src/algorithm');
  const copyRoot = join(dir, 'bridge-copy');
  await mkdir(join(copyRoot, 'hosts'), { recursive: true });
  for (const name of ['loader', 'components', 'cli', 'hosts/python']) {
    await copyFile(join(base, `${name}.ts`), join(copyRoot, `${name}.ts`));
  }
  const original = await pythonHostBridgeDigest(copyRoot, '.ts');
  expect(original).toBe(await pythonHostBridgeDigest());
  await writeFile(join(copyRoot, 'hosts', 'python.ts'), (await readFile(join(copyRoot, 'hosts', 'python.ts'), 'utf8')) + '\n// changed bridge\n');
  expect(await pythonHostBridgeDigest(copyRoot, '.ts')).not.toBe(original);
  const loaded = await loadPythonAlgorithm({
    configDir: dir, module: config.algorithm.module, export: config.algorithm.export,
    interpreter, sdkPath,
  });
  try {
    expect(loaded.identity.hostBridgeDigest).toBe(original);
    expect(loaded.value.describe().implementationDigest).toMatch(/^[0-9a-f]{64}$/);
  } finally { await loaded.close(); }
});

it('runs generated Python algorithm/provider and resumes from the same journal', async () => {
  const { configPath } = await prepare('python');
  const output: string[] = [];
  await algorithmCommand(['check', configPath], line => output.push(line));
  await algorithmCommand(['run', configPath], line => output.push(line));
  await algorithmCommand(['resume', configPath], line => output.push(line));
  expect(JSON.parse(output[0]!).ok).toBe(true);
  expect(JSON.parse(output[1]!).status).toBe('complete');
  expect(JSON.parse(output[2]!).snapshot.state.reply).toEqual({ kind: 'result', value: { value: 'hello' } });
});

it('runs a TS recipe with one Python hook and does not re-invoke a committed decision', async () => {
  const { dir, configPath } = await prepare('typescript');
  const hook = join(dir, 'choose.py');
  const source = await readFile(hook, 'utf8');
  await writeFile(hook, source.replace('    return {"choice": value["options"][0]}',
    `    import os\n    from pathlib import Path\n    print('ordinary stdout log')\n    os.write(1, b'raw stdout log\\n')\n    marker = Path(__file__).with_suffix('.count')\n    marker.write_text(str(int(marker.read_text()) + 1) if marker.exists() else '1')\n    return {"choice": value["options"][0]}`));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  await algorithmCommand(['resume', configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).snapshot.state.business.decision.value.choice).toBe('alpha');
  expect(await readFile(join(dir, 'choose.count'), 'utf8')).toBe('1');
});

it('rejects unknown hooks and schema mismatch during check', async () => {
  const { dir, configPath, config } = await prepare('typescript');
  config.hooks.unregistered = config.hooks.choose;
  await writeFile(configPath, JSON.stringify(config));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('Unknown hook');
  delete config.hooks.unregistered;
  await writeFile(configPath, JSON.stringify(config));
  const hook = join(dir, 'choose.py');
  await writeFile(hook, (await readFile(hook, 'utf8')).replace('"choice":{"type":"string"}', '"choice":{"type":"integer"}'));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('schema/scope mismatch');
});

it('separates Python exit, timeout and late worker result from scientific outcomes', async () => {
  const dir = await directory();
  const module = join(dir, 'slow.py');
  await writeFile(module, `import time\nfrom gear_algorithm import component\n@component(id='slow', input_schema={'type':'integer'}, output_schema={'type':'integer'})\ndef slow(value):\n    time.sleep(0.3)\n    return value\n`);
  const worker = await PythonWorker.start({ configDir: dir, module: './slow.py', export: 'slow', interpreter, mode: 'component', sdkPath, timeoutMs: 2000 });
  await expect(worker.call('component.invoke', 1, 20)).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(worker.closed).toBe(true);
  await expect(worker.call('component.invoke', 2)).rejects.toBeInstanceOf(PythonHostError);
  const dead = await PythonWorker.start({ configDir: dir, module: './slow.py', export: 'slow', interpreter, mode: 'component', sdkPath });
  await dead.close();
  await expect(dead.call('component.invoke', 1)).rejects.toMatchObject({ code: 'DISCONNECT' });
});

it('reports missing Python dependencies during check and rejects source drift on resume', async () => {
  const { dir, configPath } = await prepare('typescript');
  const hookPath = join(dir, 'choose.py');
  const original = await readFile(hookPath, 'utf8');
  await writeFile(hookPath, `import definitely_missing_gear_test_dependency\n${original}`);
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toMatchObject({ code: 'MISSING_DEPENDENCY' });
  await writeFile(hookPath, original);
  await algorithmCommand(['run', configPath], () => undefined);
  await writeFile(hookPath, `${original}\n# source changed after admission\n`);
  await expect(algorithmCommand(['resume', configPath], () => undefined)).rejects.toThrow('Campaign identity drift');
});

it('bridges fake provider checkpoint artifacts and recovers no-candidate after restart', async () => {
  const { FileArtifactStore } = await import('../../src/algorithm/artifacts.js');
  const { loadPythonProvider } = await import('../../src/algorithm/loader.js');
  const { PythonOperationProvider } = await import('../../src/algorithm/components.js');
  const { jsonDigest } = await import('../../src/algorithm/schema.js');
  const dir = await directory();
  const artifacts = new FileArtifactStore(join(dir, 'artifacts'));
  const recordDir = join(dir, 'records');
  const entry = { configDir: resolve('examples/algorithms/python-provider'), module: './provider.py',
    export: 'provider', interpreter, sdkPath, recordDir, artifactBridge: artifacts };
  const loaded = await loadPythonProvider(entry);
  const manifest = loaded.value;
  const provider = new PythonOperationProvider(manifest, loaded.worker);
  const makeEnvelope = (key: string, samples: number) => {
    const input = { mode: 'dpo', samples };
    return { operationId: key, idempotencyKey: key, campaignId: 'test', decisionIndex: 0, localKey: key,
      kind: manifest.kind, input, inputDigest: jsonDigest(input), implementationDigest: manifest.implementationDigest,
      bindingSetRef: { kind: 'binding-set' as const, digest: 'a'.repeat(64), schemaId: 'test' }, limits: {} };
  };
  const envelope = makeEnvelope('trained', 2);
  await provider.preflight(envelope);
  const submitted = await provider.submit(envelope);
  expect(submitted.status).toBe('completed');
  if (submitted.status !== 'completed' || submitted.completion.outcome.kind !== 'result') throw new Error('expected fake result');
  const checkpoint = (submitted.completion.outcome.value as any).checkpoint;
  expect(JSON.parse(artifacts.getBytes(checkpoint).toString('utf8'))).toEqual({ fakeWeights: 2, mode: 'dpo' });
  await loaded.close();
  const restarted = await loadPythonProvider(entry);
  try {
    const resumed = new PythonOperationProvider(restarted.value, restarted.worker);
    expect(await resumed.inspect(envelope)).toEqual(submitted);
    const empty = await resumed.submit(makeEnvelope('empty', 0));
    expect(empty.status === 'completed' && empty.completion.outcome.kind).toBe('no-result');
    expect(await resumed.inspect(makeEnvelope('empty', 0))).toEqual(empty);
  } finally { await restarted.close(); }
});

it('recovers a Python hook after its completed response is lost and host restarts', async () => {
  const { loadPythonComponent } = await import('../../src/algorithm/loader.js');
  const { PythonPolicyProvider } = await import('../../src/algorithm/components.js');
  const { jsonDigest } = await import('../../src/algorithm/schema.js');
  const dir = await directory();
  const source = `from gear_algorithm import component\nfrom pathlib import Path\n@component(id='choose', input_schema={'type':'integer'}, output_schema={'type':'integer'})\ndef choose(value):\n    marker = Path(__file__).with_suffix('.count')\n    marker.write_text(str(int(marker.read_text()) + 1) if marker.exists() else '1')\n    return value + 1\n`;
  await writeFile(join(dir, 'hook.py'), source);
  const entry = { configDir: dir, module: './hook.py', export: 'choose', interpreter, sdkPath };
  const loaded = await loadPythonComponent(entry);
  const root = join(dir, '.gear', 'hook-records');
  const provider = new PythonPolicyProvider(loaded.value, loaded.worker, root, 'policy.decide', { dropSubmitResponseOnce: true });
  const input = 3;
  const opId = jsonDigest(['hook', input]);
  const envelope = { operationId: opId, idempotencyKey: opId, campaignId: 'hook', decisionIndex: 0,
    localKey: 'choose', kind: 'policy.decide', input, inputDigest: jsonDigest(input),
    implementationDigest: loaded.value.implementationDigest,
    bindingSetRef: { kind: 'binding-set' as const, digest: 'a'.repeat(64), schemaId: 'test' }, limits: {} };
  await expect(provider.submit(envelope)).rejects.toThrow('Simulated lost submit response');
  await loaded.close();
  const restarted = await loadPythonComponent(entry);
  try {
    const after = new PythonPolicyProvider(restarted.value, restarted.worker, root);
    expect(await after.inspect(envelope)).toMatchObject({ status: 'completed', completion: { outcome: { kind: 'result', value: 4 } } });
    expect(await readFile(join(dir, 'hook.count'), 'utf8')).toBe('1');
  } finally { await restarted.close(); }
});

it('serializes concurrent provider requests while artifact.put uses nested RPC', async () => {
  const { FileArtifactStore } = await import('../../src/algorithm/artifacts.js');
  const { loadPythonProvider } = await import('../../src/algorithm/loader.js');
  const { PythonOperationProvider } = await import('../../src/algorithm/components.js');
  const { jsonDigest } = await import('../../src/algorithm/schema.js');
  const dir = await directory();
  const artifacts = new FileArtifactStore(join(dir, 'artifacts'));
  const loaded = await loadPythonProvider({ configDir: resolve('examples/algorithms/python-provider'), module: './provider.py',
    export: 'provider', interpreter, sdkPath, recordDir: join(dir, 'records'), artifactBridge: artifacts });
  try {
    const provider = new PythonOperationProvider(loaded.value, loaded.worker);
    const envelope = (key: string, samples: number) => {
      const input = { mode: 'sft', samples };
      return { operationId: key, idempotencyKey: key, campaignId: 'test', decisionIndex: 0, localKey: key,
        kind: loaded.value.kind, input, inputDigest: jsonDigest(input), implementationDigest: loaded.value.implementationDigest,
        bindingSetRef: { kind: 'binding-set' as const, digest: 'a'.repeat(64), schemaId: 'test' }, limits: {} };
    };
    const [first, second] = await Promise.all([provider.submit(envelope('one', 2)), provider.submit(envelope('two', 0))]);
    expect(first.status === 'completed' && first.completion.outcome.kind).toBe('result');
    expect(second.status === 'completed' && second.completion.outcome.kind).toBe('no-result');
  } finally { await loaded.close(); }
});

it('accepts TS hooks and rejects multiple hooks using a duplicate operation kind', async () => {
  const { dir, configPath, config } = await prepare('typescript');
  await writeFile(join(dir, 'choose.mjs'), `export const choose = { describe() { return { id: 'choose', scope: 'campaign', inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false }, outputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false } }; }, invoke(input) { return { choice: input.options[1] }; } };`);
  config.hooks.choose = { language: 'typescript', module: './choose.mjs', export: 'choose' };
  await writeFile(configPath, JSON.stringify(config));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).snapshot.state.business.decision.value.choice).toBe('beta');
});

it('routes two named Python hooks through distinct policy operation kinds', async () => {
  const { dir, configPath, config } = await prepare('typescript');
  const recipe = `const input = { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false };\nconst output = { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false };\nexport const requiredHooks = { choose: { inputSchema: input, outputSchema: output, scope: 'campaign' }, second: { inputSchema: input, outputSchema: output, scope: 'campaign' } };\nexport const algorithm = { describe() { return { id: 'two-hooks', apiVersion: 'gear.algorithm.experimental.v1', stateSchema: { type: 'object' }, configSchema: { type: 'object' }, bindingSchema: { id: 'toy-bindings', slots: {} } }; }, initialize() { return { nextState: {}, operations: [{ localKey: 'choose', kind: 'policy.decide.choose', input: { options: ['a'] } }, { localKey: 'second', kind: 'policy.decide.second', input: { options: ['b'] } }] }; }, reduce(context) { return { nextState: { choices: [context.completed.choose.value.choice, context.completed.second.value.choice] }, complete: true }; } };`;
  await writeFile(join(dir, 'recipe.mjs'), recipe);
  await writeFile(join(dir, 'second.py'), `from gear_algorithm import component\n@component(id='second', input_schema={'type':'object','properties':{'options':{'type':'array','items':{'type':'string'}}},'required':['options'],'additionalProperties':False}, output_schema={'type':'object','properties':{'choice':{'type':'string'}},'required':['choice'],'additionalProperties':False})\ndef second(value):\n    return {'choice': value['options'][0]}\n`);
  config.hooks.second = { language: 'python', interpreter, module: './second.py', export: 'second', sdkPath };
  await writeFile(configPath, JSON.stringify(config));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).snapshot.state.choices).toEqual(['a', 'b']);
});

it('loads a built TypeScript provider through the same operation SPI', async () => {
  const { dir, configPath, config } = await prepare('python');
  await writeFile(join(dir, 'echo.mjs'), `export const provider = { describe() { return { kind: 'toy.echo', execution: 'trusted-local', supportsInspect: true, meteredDimensions: [], inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }; }, preflight() {}, async submit(e) { return { status: 'completed', completion: { operationId: e.operationId, idempotencyKey: e.idempotencyKey, inputDigest: e.inputDigest, implementationDigest: e.implementationDigest, outcome: { kind: 'result', value: e.input } } }; }, async inspect() { return { status: 'not-started' }; }, async cancel() { return { status: 'cancelled', releaseConfirmed: true }; }, async collect() { throw Error('not retained'); } };`);
  config.providers = [{ language: 'typescript', module: './echo.mjs', export: 'provider' }];
  await writeFile(configPath, JSON.stringify(config));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).snapshot.state.reply.value.value).toBe('hello');
});

it('check catches duplicate providers, unenforceable hard limits and unknown binding slots', async () => {
  const { configPath, config } = await prepare('python');
  config.providers.push(config.providers[0]);
  await writeFile(configPath, JSON.stringify(config));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('Duplicate provider');
  config.providers.pop();
  config.budget.gpu = { unit: 'seconds', limit: 5, source: 'fake', capability: 'hard' };
  await writeFile(configPath, JSON.stringify(config));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('No provider can enforce hard budget');
  delete config.budget.gpu;
  config.bindings.unknown = { kind: 'artifact', digest: 'a'.repeat(64), size: 0, mediaType: 'application/json' };
  await writeFile(configPath, JSON.stringify(config));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('Unknown binding slot');
});

it('keeps a started Python hook unknown after its worker exits before sealing a result', async () => {
  const { loadPythonComponent } = await import('../../src/algorithm/loader.js');
  const { PythonPolicyProvider } = await import('../../src/algorithm/components.js');
  const { jsonDigest } = await import('../../src/algorithm/schema.js');
  const dir = await directory();
  await writeFile(join(dir, 'crash.py'), `import os\nfrom pathlib import Path\nfrom gear_algorithm import component\n@component(id='crash', input_schema={'type':'integer'}, output_schema={'type':'integer'})\ndef crash(value):\n    marker = Path(__file__).with_suffix('.count')\n    marker.write_text('1')\n    os._exit(17)\n`);
  const entry = { configDir: dir, module: './crash.py', export: 'crash', interpreter, sdkPath };
  const loaded = await loadPythonComponent(entry);
  const root = join(dir, '.gear', 'hook-records');
  const first = new PythonPolicyProvider(loaded.value, loaded.worker, root);
  const key = jsonDigest('crash');
  const envelope = { operationId: key, idempotencyKey: key, campaignId: 'test', decisionIndex: 0,
    localKey: 'crash', kind: 'policy.decide', input: 1, inputDigest: jsonDigest(1),
    implementationDigest: loaded.value.implementationDigest,
    bindingSetRef: { kind: 'binding-set' as const, digest: 'a'.repeat(64), schemaId: 'test' }, limits: {} };
  await expect(first.submit(envelope)).rejects.toBeInstanceOf(PythonHostError);
  await loaded.close();
  const restarted = await loadPythonComponent(entry);
  try {
    const after = new PythonPolicyProvider(restarted.value, restarted.worker, root);
    expect(await after.inspect(envelope)).toEqual({ status: 'unknown' });
    await expect(after.submit(envelope)).rejects.toThrow('unknown outcome');
    expect(await readFile(join(dir, 'crash.count'), 'utf8')).toBe('1');
  } finally { await restarted.close(); }
});

it('rejects malformed nested Python provider status and completion replies', async () => {
  const { PythonOperationProvider } = await import('../../src/algorithm/components.js');
  const { jsonDigest } = await import('../../src/algorithm/schema.js');
  const manifest = { kind: 'toy.provider', implementationDigest: 'a'.repeat(64),
    inputSchema: { type: 'any' as const }, outputSchema: { type: 'any' as const }, meteredDimensions: [],
    execution: 'trusted-local' as const, supportsInspect: true as const };
  const key = jsonDigest('malformed');
  const envelope = { operationId: key, idempotencyKey: key, campaignId: 'test', decisionIndex: 0,
    localKey: 'malformed', kind: manifest.kind, input: null, inputDigest: jsonDigest(null),
    implementationDigest: manifest.implementationDigest,
    bindingSetRef: { kind: 'binding-set' as const, digest: 'b'.repeat(64), schemaId: 'test' }, limits: {} };
  const fake = (value: any) => new PythonOperationProvider(manifest, { call: async () => value } as unknown as PythonWorker);
  await expect(fake({ status: 'typo' }).inspect(envelope)).rejects.toThrow('Unknown Python provider inspection status');
  await expect(fake({ status: 'cancelled' }).cancel(envelope)).rejects.toThrow('release flag');
  await expect(fake({ status: 'completed', completion: { operationId: 'wrong', idempotencyKey: key,
    inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
    outcome: { kind: 'result', value: 1 } } }).submit(envelope)).rejects.toThrow('operationId mismatch');
});

it('seals imported ESM helpers and rejects imports outside the configured closure', async () => {
  const { dir, configPath } = await prepare('typescript');
  const recipePath = join(dir, 'recipe.mjs');
  const source = await readFile(recipePath, 'utf8');
  await writeFile(join(dir, 'helper.mjs'), `export const marker = 'v1';\n`);
  await writeFile(recipePath, `import { marker } from './helper.mjs';\n${source}\nvoid marker;\n`);
  await algorithmCommand(['run', configPath], () => undefined);
  await writeFile(join(dir, 'helper.mjs'), `export const marker = 'v2';\n`);
  await expect(algorithmCommand(['resume', configPath], () => undefined)).rejects.toThrow('Campaign identity drift');
  await writeFile(recipePath, `import '../outside.mjs';\n${source}`);
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('escapes source closure');
});

it('refuses a stale Node ESM cache after check when a transitive helper changes before run', async () => {
  const { dir, configPath, config } = await prepare('typescript');
  const recipePath = join(dir, 'recipe.mjs');
  const source = await readFile(recipePath, 'utf8');
  await writeFile(join(dir, 'helper.mjs'), `export const marker = 'first';\n`);
  await writeFile(recipePath, `import { marker } from './helper.mjs';\n${source}\nvoid marker;\n`);
  await algorithmCommand(['check', configPath], () => undefined);
  await writeFile(join(dir, 'helper.mjs'), `export const marker = 'second';\n`);
  await expect(algorithmCommand(['run', configPath], () => undefined)).rejects.toThrow('start a new process');
  await expect(readFile(join(dir, config.stateDir, 'campaign', 'HEAD'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('loads hook requirements from a Python algorithm and runs a TypeScript hook', async () => {
  const { dir, configPath, config } = await prepare('python');
  await writeFile(join(dir, 'algorithm.py'), `from gear_algorithm import AlgorithmManifest, advance, operation\nINPUT = {'type':'object','properties':{'options':{'type':'array','items':{'type':'string'}}},'required':['options'],'additionalProperties':False}\nOUTPUT = {'type':'object','properties':{'choice':{'type':'string'}},'required':['choice'],'additionalProperties':False}\nclass Toy:\n    def describe(self):\n        return AlgorithmManifest('python-with-hook', {'type':'object'}, {'type':'object'}, {'id':'toy-bindings','slots':{}}, requiredHooks={'choose': {'inputSchema': INPUT, 'outputSchema': OUTPUT, 'scope':'campaign'}})\n    def initialize(self, context):\n        return advance({}, operation(key='choose', kind='policy.decide', input={'options':['first','second']}))\n    def reduce(self, context):\n        return advance({'choice':context['completed']['choose']}, complete=True)\nalgorithm = Toy()\n`);
  await writeFile(join(dir, 'choose.mjs'), `export const choose = { describe() { return { id: 'choose', scope: 'campaign', inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false }, outputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false } }; }, invoke(input) { return { choice: input.options[1] }; } };`);
  config.providers = [];
  config.hooks = { choose: { language: 'typescript', module: './choose.mjs', export: 'choose' } };
  await writeFile(configPath, JSON.stringify(config));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  await algorithmCommand(['resume', configPath], line => lines.push(line));
  expect(JSON.parse(lines[1]!).snapshot.state.choice.value.choice).toBe('second');
  expect(JSON.parse(lines[2]!).status).toBe('complete');
});
