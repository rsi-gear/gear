import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { authorHostIdentityDigest } from '../../src/algorithm/author/identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
function setup(root: string, configDir = fixtureDir) {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, schema);
  const initialBindingSetRef = bindings.create({});
  const spec: CampaignSpec = { campaignId: 'author-py-a0', config: {}, initialBindingSetRef, budget: {} };
  if (!interpreter) throw new Error('Python >=3.11 required for author worker test');
  const port = createPythonAuthorReplayPort({ configDir, module: 'author_sample.py', export: 'sample', interpreter, sdkPath });
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
  return { runtime, adapter, providers };
}

pythonIt('runs the real Python author worker through the common Campaign adapter', async () => {
  const root = makeRoot(); const { runtime, adapter, providers } = setup(root);
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
  const first = setup(root, source);
  await first.runtime.tick();
  writeFileSync(path, `${original}\n# modified after first frontier\n`);
  await expect(first.runtime.tick()).rejects.toThrow('closure changed');
  expect(first.providers[1]!.submitCalls).toBe(0);
  writeFileSync(path, original);
  const recovered = setup(root, source);
  expect(await recovered.runtime.runUntilBlocked(30)).toBe('complete');
});

pythonIt('rejects a Python module path outside the frozen project tree', () => {
  const root = makeRoot();
  if (!interpreter) throw new Error('Python >=3.11 required for author worker test');
  expect(() => createPythonAuthorReplayPort({ configDir: root, module: join(fixtureDir, 'author_sample.py'),
    export: 'sample', interpreter, sdkPath })).toThrow('escapes frozen configDir');
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
