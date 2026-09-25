import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../src/algorithm/runtime/providers.js';
import type { BindingSchema, CampaignSpec, OperationProvider, ProviderManifest } from '../../src/algorithm/contracts.js';
import { AuthorAlgorithmAdapter } from '../../src/algorithm/author/adapter.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../src/algorithm/author/providers.js';
import { PythonWorker } from '../../src/algorithm/hosts/python.js';
import { createPythonAuthorReplayPort } from '../../src/algorithm/author/python-port.js';
import type { SealedPythonReplayPort } from '../../src/algorithm/author/python-port.js';
import { authorHostIdentityDigest } from '../../src/algorithm/author/identity.js';
import { AUTHOR_WIRE_VERSION } from '../../src/algorithm/author/index.js';
import type { AuthorReplayRequest } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
const ports: SealedPythonReplayPort[] = [];
afterEach(async () => {
  await Promise.all(ports.splice(0).map(port => port.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'gear-author-py-a0-')); roots.push(root); return root; };
const sdkPath = resolve('packages/python-sdk/src');
const fixtureDir = resolve('packages/python-sdk/tests/fixtures');
const interpreter = [process.env.GEAR_TEST_PYTHON, process.env.GEAR_ALGORITHM_TEST_PYTHON,
  'python3.12', 'python3.11', '/opt/homebrew/bin/python3.11', 'python3'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});
const pythonIt = interpreter ? it : it.skip;
const schema: BindingSchema = { id: 'author-py-a0.bindings.v1', slots: {} };
async function setup(root: string, configDir = fixtureDir) {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, schema);
  const initialBindingSetRef = bindings.create({});
  const spec: CampaignSpec = { campaignId: 'author-py-a0', config: {}, initialBindingSetRef, budget: {} };
  if (!interpreter) throw new Error('Python >=3.11 required for author worker test');
  const port = await createPythonAuthorReplayPort({ configDir, module: 'author_sample.py', export: 'sample', interpreter, sdkPath });
  ports.push(port);
  expect(port.hostDigest).toBe(authorHostIdentityDigest(resolve('src/algorithm')));
  const adapter = new AuthorAlgorithmAdapter({ id: 'author-py-a0', implementationDigest: port.sourceDigest,
    hostIdentityDigest: port.hostDigest, bindingSchema: schema, artifacts, bindings, replay: port,
    initialAgent: null, data: {}, maxFrontierWaves: 20 });
  const kinds = ['author.role', 'author.edit', 'author.rollout', 'author.measure', 'fixture.extra'];
  const providers = kinds.map(kind => new LocalDurableProvider(join(root, 'provider', kind), {
    kind, implementationDigest: sha256(`${kind}.py-fake.v1`), execution: 'trusted-local', supportsInspect: true,
    meteredDimensions: [], inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' },
  } satisfies ProviderManifest, envelope => {
    const input = envelope.input as Record<string, unknown>;
    const value = kind === 'author.role' ? { prompt: 'fake-role' }
      : kind === 'author.edit' ? { revision: `revision-${input.label}` }
      : kind === 'author.rollout' ? { passed: true } : kind === 'author.measure' ? { score: 1 } : {};
    return { outcome: { kind: 'result', value } };
  }));
  const runtime = new AlgorithmRuntime(root, adapter,
    [...providers, new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindings)] as OperationProvider[], spec, { artifacts });
  return { runtime, adapter, providers, port };
}

pythonIt('runs the real Python author worker through the common Campaign adapter', async () => {
  const root = makeRoot(); const { runtime, adapter, providers } = await setup(root);
  await runtime.tick();
  expect(providers.every(provider => provider.submitCalls === 0)).toBe(true);
  expect(await runtime.runUntilBlocked(30)).toBe('complete');
  const history = adapter.readHistory(runtime.snapshot()!);
  expect(history.filter(item => item.kind === 'author.rollout')).toHaveLength(20);
  expect(history.filter(item => item.kind === 'author.checkpoint')).toHaveLength(1);
  expect(providers[0]!.submitCalls).toBe(2);
  expect(adapter.readResult(runtime.snapshot()!)).toMatchObject({ outputs: { population: { ref: { kind: 'artifact' } } } });
});

pythonIt('rejects a changed Python module before the next Campaign intent and resumes after restoring exact bytes', async () => {
  const root = makeRoot(); const source = join(root, 'author-source'); mkdirSync(source);
  const original = readFileSync(join(fixtureDir, 'author_sample.py'), 'utf8');
  const path = join(source, 'author_sample.py'); writeFileSync(path, original);
  const first = await setup(root, source);
  await first.runtime.tick();
  writeFileSync(path, `${original}\n# modified after first frontier\n`);
  await expect(first.runtime.tick()).rejects.toThrow('closure changed');
  expect(first.providers[1]!.submitCalls).toBe(0);
  writeFileSync(path, original);
  await first.port.close();
  const recovered = await setup(root, source);
  expect(await recovered.runtime.runUntilBlocked(30)).toBe('complete');
});

pythonIt('rejects a Python module path outside the frozen project tree', async () => {
  const root = makeRoot();
  if (!interpreter) throw new Error('Python >=3.11 required for author worker test');
  await expect(createPythonAuthorReplayPort({ configDir: root, module: join(fixtureDir, 'author_sample.py'),
    export: 'sample', interpreter, sdkPath })).rejects.toThrow('escapes frozen configDir');
});

const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] };

pythonIt('uses the admitted worker once, then starts a fresh worker for the next replay', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const started = vi.spyOn(PythonWorker, 'start');
  try {
    const port = await createPythonAuthorReplayPort({ configDir: fixtureDir, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath }); ports.push(port);
    expect(started).toHaveBeenCalledTimes(1);
    const admitted = await started.mock.results[0]!.value as PythonWorker;
    expect((await port(request)).status).toBe('waiting');
    expect(started).toHaveBeenCalledTimes(1);
    expect(admitted.closed).toBe(true);
    expect((await port(request)).status).toBe('waiting');
    expect(started).toHaveBeenCalledTimes(2);
    expect((await port(request)).status).toBe('waiting');
    expect(started).toHaveBeenCalledTimes(3);
  } finally { started.mockRestore(); }
});

pythonIt('disposes an unused admission worker and rejects concurrent replay', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const started = vi.spyOn(PythonWorker, 'start');
  try {
    const unused = await createPythonAuthorReplayPort({ configDir: fixtureDir, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath }); ports.push(unused);
    const worker = await started.mock.results[0]!.value as PythonWorker;
    await Promise.all([unused.close(), unused.close()]);
    expect(worker.closed).toBe(true);
    await expect(unused(request)).rejects.toThrow(/closed/);
    const port = await createPythonAuthorReplayPort({ configDir: fixtureDir, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath }); ports.push(port);
    const first = port(request);
    await expect(port(request)).rejects.toThrow(/Concurrent/);
    expect((await first).status).toBe('waiting');
  } finally { started.mockRestore(); }
});

pythonIt('discards an idle admission worker and uses a fresh same-identity worker', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const started = vi.spyOn(PythonWorker, 'start');
  try {
    const port = await createPythonAuthorReplayPort({ configDir: fixtureDir, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath, admissionIdleMs: 20 }); ports.push(port);
    const admitted = await started.mock.results[0]!.value as PythonWorker;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    expect(admitted.closed).toBe(true);
    expect((await port(request)).status).toBe('waiting');
    expect(started).toHaveBeenCalledTimes(2);
    const resumed = await createPythonAuthorReplayPort({ configDir: fixtureDir, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath }); ports.push(resumed);
    expect(resumed.sourceDigest).toBe(port.sourceDigest);
    expect(resumed.hostDigest).toBe(port.hostDigest);
  } finally { started.mockRestore(); }
});

pythonIt('rejects source drift after admission before the first intent', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const source = makeRoot();
  const original = readFileSync(join(fixtureDir, 'author_sample.py'), 'utf8');
  const path = join(source, 'author_sample.py'); writeFileSync(path, original);
  const started = vi.spyOn(PythonWorker, 'start');
  try {
    const port = await createPythonAuthorReplayPort({ configDir: source, module: 'author_sample.py',
      export: 'sample', interpreter, sdkPath }); ports.push(port);
    const admitted = await started.mock.results[0]!.value as PythonWorker;
    writeFileSync(path, `${original}\n# changed after admission\n`);
    await expect(port(request)).rejects.toThrow(/closure changed/);
    expect(admitted.closed).toBe(true);
    writeFileSync(path, original);
    expect((await port(request)).status).toBe('waiting');
    expect(started).toHaveBeenCalledTimes(2);
  } finally { started.mockRestore(); }
});

pythonIt('repeated environment descriptions are stable on an idle worker', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const worker = await PythonWorker.start({ configDir: fixtureDir, module: 'author_sample.py',
    export: 'sample', interpreter, sdkPath, mode: 'author' });
  try {
    const first = await worker.call('environment.describe');
    expect(await worker.call('environment.describe')).toEqual(first);
  } finally { await worker.close(); }
});

pythonIt('cancels admission during partial worker startup and closes the process', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const source = makeRoot();
  const pidPath = join(source, 'worker.pid');
  writeFileSync(join(source, 'slow_author.py'),
    `import os,time\nfrom pathlib import Path\nPath(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))\ntime.sleep(10)\n`);
  const controller = new AbortController();
  const startedAt = performance.now();
  const creating = createPythonAuthorReplayPort({ configDir: source, module: 'slow_author.py',
    export: 'sample', interpreter, sdkPath, timeoutMs: 15_000, signal: controller.signal });
  try {
    for (let attempt = 0; attempt < 300 && !existsSync(pidPath); attempt++)
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    controller.abort();
    await expect(creating).rejects.toThrow(/cancelled/i);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  } finally { controller.abort(); await creating.catch(() => undefined); }
});

pythonIt('cancels PythonWorker while its listener is still starting', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const controller = new AbortController();
  const starting = PythonWorker.start({ configDir: fixtureDir, module: 'author_sample.py',
    export: 'sample', interpreter, sdkPath, mode: 'author' }, controller.signal);
  controller.abort();
  await expect(starting).rejects.toThrow(/cancelled/i);
});

pythonIt('bounds admission startup and reaps a timed-out worker', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const source = makeRoot();
  writeFileSync(join(source, 'slow_author.py'), 'import time\ntime.sleep(10)\n');
  const startedAt = performance.now();
  await expect(createPythonAuthorReplayPort({ configDir: source, module: 'slow_author.py',
    export: 'sample', interpreter, sdkPath, timeoutMs: 100 })).rejects.toThrow(/timed out/i);
  expect(performance.now() - startedAt).toBeLessThan(5_000);
});

pythonIt('cancels an active replay and closes its worker', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required');
  const source = makeRoot();
  writeFileSync(join(source, 'slow_replay.py'),
    'from gear_algorithm.author import algorithm\n@algorithm\nasync def sample(ctx):\n    for _ in range(1000000000):\n        pass\n    return ctx.result(outputs={})\n');
  const controller = new AbortController();
  const started = vi.spyOn(PythonWorker, 'start');
  const port = await createPythonAuthorReplayPort({ configDir: source, module: 'slow_replay.py',
    export: 'sample', interpreter, sdkPath, timeoutMs: 15_000, signal: controller.signal });
  ports.push(port);
  const worker = await started.mock.results[0]!.value as PythonWorker;
  const pending = port(request);
  const rejected = expect(pending).rejects.toThrow(/closed|disconnect|cancelled/i);
  try {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    controller.abort();
    await rejected;
    await port.close();
    expect(worker.closed).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); await port.close(); started.mockRestore(); }
});


pythonIt('clears the normal-exit grace timer when PythonWorker.close finishes', async () => {
  if (!interpreter) throw new Error('Python >=3.11 required for author worker test');
  const worker = await PythonWorker.start({ configDir: fixtureDir, module: 'author_sample.py', export: 'sample',
    interpreter, sdkPath, mode: 'author' });
  const started = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  try {
    await worker.close();
    const grace = started.mock.calls.flatMap((call, index) => call[1] === 1000 ? [started.mock.results[index]?.value] : []);
    expect(grace.length).toBeGreaterThan(0);
    for (const timer of grace) expect(cleared.mock.calls.some(call => call[0] === timer)).toBe(true);
  } finally { started.mockRestore(); cleared.mockRestore(); }
});
