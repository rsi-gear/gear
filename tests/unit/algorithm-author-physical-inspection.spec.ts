import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectAuthorHitchCapability, inspectAuthorInitialHarness, inspectAuthorMetaModel,
  inspectAuthorReadOnlyPhysicalInputs,
  inspectAuthorSearchDataset } from '../../src/algorithm/author/physical-inspection.js';
import { parseNeutralRuntimeConfig, type NeutralRuntimeConfigV1 } from '../../src/algorithm/author/neutral-runtime-config.js';
import type { AuthorStaticResolution } from '../../src/algorithm/author/run-resolver.js';
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { LlmAdapter } from '../../src/algorithm/dsh-host.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function settings(repository: string, baseRef: string): NeutralRuntimeConfigV1 {
  return { schemaVersion: 1,
    builder: { dshBaseRef: baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', allowedImports: [] },
    compiler: { command: process.execPath, targetRoot: 'harness' },
    hitch: { executable: process.execPath, repositoryPath: repository, harnessId: 'test-harness', root: repository,
      model: 'target-model', attempts: 1, maxConcurrent: 1, setupTimeoutMs: 1000,
      terminationGraceMs: 1000, maxOutputBytes: 1024, maxTrajectoryOutputBytes: 1024,
      sampling: {}, agentArgs: [], passEnv: [], controlPlane: { mode: 'daemon', requireModelCapture: false } },
    sampling: { repetitions: 2 }, taskBudgetMs: 60_000,
    modelDestinations: { meta: { alias: 'lab-meta', destinationId: 'meta-destination', provider: 'test',
      model: 'meta-model', registrationModule: '/opt/gear/model-registration.mjs',
      spec: { runtime: { type: 'dsh', version: 'test', integrity: 'test' },
        preset: { id: 'test', digest: 'sha256:test', resources: [] },
        model: { provider: 'test', model: 'meta-model' }, sampling: {} } },
      target: { alias: 'lab-target', destinationId: 'target-destination', provider: 'test', model: 'target-model' } },
    runtimeResources: ['/opt/gear/model-registration.mjs'] };
}

it('uses the real HarnessBuilder manifest and Git tree validator to resolve an initial branch', async () => {
  const git = await createGitHarnessFixture(); paths.push(git.root);
  const runtime = parseNeutralRuntimeConfig(settings(git.repository, git.baseRef));
  const source = { profile: { workspace: { repository: git.repository, harnessRoot: git.targetRoot },
    hitch: { executable: process.execPath }, inputs: { initialAgent: { gitRef: 'main' } } } } as AuthorStaticResolution;
  expect(await inspectAuthorInitialHarness(source, runtime)).toEqual({ commit: git.championRef,
    tree: gitOutput(git.repository, ['rev-parse', `${git.championRef}^{tree}`]), manifestDigest: git.manifest.digest });
  await expect(inspectAuthorInitialHarness({ ...source, profile: { ...source.profile,
    inputs: { ...source.profile.inputs, initialAgent: { gitRef: git.baseRef } } } }, runtime))
    .rejects.toThrow();
});

it('rejects incomplete or legacy recipe runtime settings before any physical service starts', async () => {
  const git = await createGitHarnessFixture(); paths.push(git.root);
  const valid = settings(git.repository, git.baseRef);
  expect(parseNeutralRuntimeConfig(valid).sampling.repetitions).toBe(2);
  expect(() => parseNeutralRuntimeConfig({ ...valid, recipe: 'rho' })).toThrow('unsupported');
  expect(() => parseNeutralRuntimeConfig({ ...valid, builder: { ...valid.builder, dshBaseRef: 'main' } })).toThrow('exact Git commit');
  expect(() => parseNeutralRuntimeConfig({ ...valid, hitch: { ...valid.hitch, seeds: [7] } })).toThrow();
  expect(() => parseNeutralRuntimeConfig({ ...valid, sampling: { repetitions: 2, seed: 7 } })).toThrow('unsupported');
  expect(() => parseNeutralRuntimeConfig({ ...valid, runtimeResources: [] })).toThrow('explicit resource');
});

it('checks standard compiled task bytes and the declared evaluation metric against the search projector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-author-dataset-inspect-')); paths.push(root);
  const dataset = await standardSearchDataset(root, 2, 'dataset');
  const source = { profile: { inputs: { searchTasks: { compiledDataset: dataset.ref } },
    evaluation: { metric: 'pass_rate', passThreshold: 1, requireAllTrialsValid: true } },
    datasetTaskIds: ['task-0', 'task-1'] } as AuthorStaticResolution;
  expect(await inspectAuthorSearchDataset(source)).toEqual({ schemaVersion: 1, digest: dataset.digest,
    taskIds: ['task-0', 'task-1'], purpose: 'development' });
  await expect(inspectAuthorSearchDataset({ ...source, profile: { ...source.profile,
    evaluation: { ...source.profile.evaluation, passThreshold: 0.8 } } }))
    .rejects.toThrow('pass_rate threshold 1');
  await expect(inspectAuthorSearchDataset({ ...source, profile: { ...source.profile,
    evaluation: { ...source.profile.evaluation, requireAllTrialsValid: false } } }))
    .rejects.toThrow('all valid trials');
  await writeFile(join(dataset.ref, 'task-0', 'instruction.md'), 'different task content\n');
  await expect(inspectAuthorSearchDataset(source)).rejects.toThrow('bytes differ from manifest');
  await writeFile(join(dataset.ref, 'task-0', 'instruction.md'), 'dataset fixture task 0\n');
  const manifestPath = join(dataset.ref, 'benchmark.adapter.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, JSON.stringify({ ...original, dataset_digest: `sha256:${'0'.repeat(64)}` }));
  await expect(inspectAuthorSearchDataset(source)).rejects.toThrow('manifest digest mismatch');
  await writeFile(manifestPath, 'x'.repeat(1024 * 1024 + 1));
  await expect(inspectAuthorSearchDataset(source)).rejects.toThrow('bounded regular file');
});

it('uses real Hitch version/daemon/capability commands and never submits an evaluation', async () => {
  const recorded = await createRecordedHitchCliFixture('0.2.8', {},
    { controlPlane: { mode: 'daemon', requireModelCapture: false } });
  paths.push(recorded.fixture.root);
  const source = { profile: { workspace: { repository: recorded.fixture.repository },
    hitch: { executable: recorded.evaluator.options.executable } } } as AuthorStaticResolution;
  const runtime = { ...settings(recorded.fixture.repository, recorded.fixture.baseRef),
    hitch: recorded.evaluator.options };
  const observed = await inspectAuthorHitchCapability(source, runtime, AbortSignal.timeout(10_000));
  expect(observed.daemon).toBe(true);
  expect(observed.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
  const calls = (await readFile(recorded.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  expect(calls.every(args => ['--version', 'daemon', 'capabilities'].includes(args[0]!))).toBe(true);
  expect(calls.some(args => args[0] === 'eval')).toBe(false);
});

it('resolves the registered DSH meta model route without a generation call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-author-model-inspect-')); paths.push(root);
  const module = join(root, 'model.mjs'); await writeFile(module, 'export const destination = "p/model";\n');
  const runtime = settings(root, 'a'.repeat(40));
  runtime.modelDestinations.meta.registrationModule = module;
  runtime.runtimeResources = [module];
  const source = { profile: { models: { meta: 'lab-meta' } } } as AuthorStaticResolution;
  class OfflineAdapter extends LlmAdapter {
    async *stream(): AsyncGenerator<never> { throw new Error('Admission must not generate'); }
  }
  const registered = await inspectAuthorMetaModel(source, parseNeutralRuntimeConfig(runtime), llm => {
    llm.registerAdapter(['test'], new OfflineAdapter());
    return { destinationId: 'meta-destination', currentDestinationId: () => 'meta-destination' };
  });
  expect(registered.destinationDigest).toMatch(/^[a-f0-9]{64}$/);
  await expect(inspectAuthorMetaModel(source, parseNeutralRuntimeConfig(runtime), () =>
    ({ destinationId: 'meta-destination', currentDestinationId: () => 'changed' })))
    .rejects.toThrow('registration unresolved');
});

it('combines frozen runtime bytes with real Git, task, Hitch and model read-only probes', async () => {
  const recorded = await createRecordedHitchCliFixture('0.2.8', {},
    { controlPlane: { mode: 'daemon', requireModelCapture: false } });
  paths.push(recorded.fixture.root);
  const modelRoot = await mkdtemp(join(tmpdir(), 'gear-author-model-route-')); paths.push(modelRoot);
  const module = join(modelRoot, 'registration.mjs');
  await writeFile(module, `export function registerModel(llm) {
    llm.registerAdapter(['test'], {
      providerInfo: provider => ({ id: provider, name: provider }),
      providerRetryPolicy: () => undefined,
      resolveModel: async (provider, id) => ({ provider, id, name: id }),
      async *stream() { throw new Error('Admission must not generate'); }
    });
    return { destinationId: 'meta-destination', currentDestinationId: () => 'meta-destination' };
  }\n`);
  const dataset = await standardSearchDataset(recorded.fixture.root, 2, 'search');
  const config = settings(recorded.fixture.repository, recorded.fixture.baseRef);
  config.hitch = recorded.evaluator.options;
  config.modelDestinations.target.model = 'deepseek-chat';
  config.modelDestinations.meta.registrationModule = module;
  config.runtimeResources = [module];
  const configPath = join(modelRoot, 'neutral-runtime.json');
  const configBytes = JSON.stringify(config);
  await writeFile(configPath, configBytes);
  const source = { profile: { runtimeConfig: configPath,
    workspace: { repository: recorded.fixture.repository, harnessRoot: 'harness' },
    hitch: { executable: recorded.evaluator.options.executable }, models: { meta: 'lab-meta', target: 'lab-target' },
    inputs: { initialAgent: { gitRef: 'main' }, searchTasks: { compiledDataset: dataset.ref } },
    evaluation: { metric: 'pass_rate', passThreshold: 1, requireAllTrialsValid: true } },
    datasetTaskIds: ['task-0', 'task-1'],
  source: { runtimeConfigDigest: createHash('sha256').update(configBytes).digest('hex') } } as AuthorStaticResolution;
  const result = await inspectAuthorReadOnlyPhysicalInputs(source, AbortSignal.timeout(10_000));
  expect(result.git.manifestDigest).toBe(recorded.fixture.manifest.digest);
  expect(result.dataset.digest).toBe(dataset.digest);
  expect(result.hitch.daemon).toBe(true);
  expect(result.metaModel.alias).toBe('lab-meta');
  await writeFile(module, 'export const unrelated = true;\n');
  await expect(inspectAuthorReadOnlyPhysicalInputs(source, AbortSignal.timeout(10_000)))
    .rejects.toThrow('must export registerModel');
  await writeFile(module, 'import x from "unclosed-package"; export function registerModel() { return x; }\n');
  await expect(inspectAuthorReadOnlyPhysicalInputs(source, AbortSignal.timeout(10_000)))
    .rejects.toThrow('outside the frozen single-file closure');
});
