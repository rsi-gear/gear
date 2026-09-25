/** Public-package CPU admission fixture. It never starts a model or submits a Hitch evaluation. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { FileArtifactStore } from 'rsi-gear/algorithm';
import { builtinComponentRef, createConfiguredFreshHostProfile, digestContent,
  digestDatasetRef, digestLegacyDatasetJson, rolloutProviderSemanticDigest, LlmAdapter } from 'rsi-gear/algorithm/harness';

const root = await mkdtemp(join(process.cwd(), '.gear-public-host-check-'));
const runtimeRoot = await mkdtemp(join(tmpdir(), 'gear-public-host-state-'));
const repository = join(root, 'dsh');
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
try {
  await mkdir(repository);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Public Host Fixture');
  git('config', 'user.email', 'fixture@example.com');
  await writeFile(join(repository, 'package.json'), '{"name":"public-host-fixture","private":true}\n');
  git('add', 'package.json'); git('commit', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD');
  await mkdir(join(repository, 'harness', 'plugins'), { recursive: true });
  await mkdir(join(repository, 'harness', 'preset'), { recursive: true });
  await writeFile(join(repository, 'harness', 'plugins', 'context.ts'), 'export const value = 1\n');
  await writeFile(join(repository, 'harness', 'preset', 'agent.cordis.yml'), '- name: ./plugins/context.js\n');
  const artifacts = [];
  for (const path of ['plugins/context.ts', 'preset/agent.cordis.yml']) {
    const content = await readFile(join(repository, 'harness', path));
    artifacts.push({ path, digest: digestContent(content), bytes: content.byteLength });
  }
  const identity = { schemaVersion: 1, dshBaseRef: baseRef, toolchainRef: 'node-22-tsc',
    sandboxProfileRef: 'sandbox-v1', artifacts };
  const manifest = { ...identity, digest: digestContent(JSON.stringify(identity)) };
  await writeFile(join(repository, 'harness', 'manifest.json'), JSON.stringify(manifest));
  git('add', 'harness'); git('commit', '-m', 'initial harness');
  const championRef = git('rev-parse', 'HEAD');

  async function dataset(partition, count) {
    const ref = join(root, partition), tasks = [];
    for (let index = 0; index < count; index++) {
      const id = `task-${index}`, directory = join(ref, id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'task.toml'), 'version = "1.0"\n[verifier]\ntimeout_sec = 60\n');
      await writeFile(join(directory, 'instruction.md'), `${partition} recorded task ${index}\n`);
      tasks.push({ task_id: id, task_digest: await digestDatasetRef(directory) });
    }
    const score = { direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' };
    const source = { schema_version: '1', kind: 'gear-harbor-benchmark',
      benchmark: { id: 'recorded-host-fixture', revision: 'v1' },
      adapter: { id: 'fixture', revision: 'v1', output_protocol: 'gear-harbor-eval-result-v1' },
      scoring: { total_score: { ...score, source_metric: 'completion' } }, tasks };
    await writeFile(join(ref, 'benchmark.adapter.json'), JSON.stringify({ ...source,
      dataset_digest: digestLegacyDatasetJson(source) }));
    return { ref, digest: await digestDatasetRef(ref) };
  }
  const seed = await dataset('seed', 2), heldOut = await dataset('held-out', 1);
  const preset = { id: 'recorded-preset', digest: `sha256:${'7'.repeat(64)}`,
    resources: [{ logicalPath: 'preset/agent.cordis.yml', kind: 'composition', digest: `sha256:${'6'.repeat(64)}` }] };
  const metaAgent = { runtime: { type: 'dsh', version: 'recorded', integrity: `sha256:${'8'.repeat(64)}` },
    preset, model: { provider: 'recorded', model: 'cpu' }, sampling: {} };
  const rolloutProvider = builtinComponentRef('rollout-provider', 'hitch-cli', {});
  const promotion = { minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true,
    maxHeldOutRegression: 0, maxRequiredRegressions: 0 };
  const spec = { evolutionId: 'public-host-check', createdAt: 'recorded',
    initialHarness: { ref: championRef, digest: manifest.digest }, datasets: { seed, heldOut }, metaAgent,
    candidateGeneration: { strategy: builtinComponentRef('candidate-generator', 'dsh-meta-forked-proposals', {}),
      maxCandidates: 1, budget: { attemptTimeoutMs: 60_000, maxAttemptsPerCandidate: 2, roundTimeoutMs: 120_000 } },
    rollout: { provider: rolloutProvider,
      providerSemanticDigest: rolloutProviderSemanticDigest(rolloutProvider, { harnessId: 'deepseek' }, {}),
      taskSampler: builtinComponentRef('task-sampler', 'dataset', {}), repetitions: 2,
      model: 'recorded', sampling: {}, agentConfig: {} },
    evaluation: { judges: [builtinComponentRef('judge', 'task-reward', {})], primaryMetric: 'primaryReward' },
    selection: { assessor: builtinComponentRef('candidate-assessor', 'evaluation-metrics', {}),
      strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}), survivors: 1, timeoutMs: 60_000 },
    promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', promotion) },
    taskBudgetMs: 60_000, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1' };

  const hitchExecutable = join(root, 'recorded-hitch.mjs');
  await writeFile(hitchExecutable, '#!/usr/bin/env node\nthrow Error("No physical Hitch call in admission fixture")\n');
  await chmod(hitchExecutable, 0o755);
  const roleNames = ['rho.difficulty', 'rho.diagnoser', 'rho.self-preference', 'rho.optimizer'];
  const roles = Object.fromEntries(roleNames.map(id => [id, { instruction: `Recorded ${id}`,
    maxModelRequests: 3, maxTokens: 5000, timeoutMs: 20_000 }]));
  const settings = { schemaVersion: 1, recipe: 'rho', spec, workspaceRoot: root, authorityId: 'public-host',
    builder: { repositoryPath: repository, targetRoot: 'harness', dshBaseRef: baseRef,
      toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1' },
    compiler: { command: process.execPath, args: ['-e', 'process.exit(0)'], sandboxMode: 'disabled' },
    hitch: { executable: hitchExecutable, repositoryPath: repository, harnessId: 'deepseek', root: '',
      model: 'recorded', attempts: 1, maxConcurrent: 2, setupTimeoutMs: 10_000, terminationGraceMs: 100,
      maxOutputBytes: 1_048_576, maxTrajectoryOutputBytes: 1_048_576, sampling: {}, agentArgs: [],
      passEnv: [], controlPlane: { mode: 'daemon', requireModelCapture: false } },
    workspace: { repositoryPath: repository, targetRoot: 'harness', maxFiles: 10,
      maxBytes: 200_000, maxDiffBytes: 200_000 },
    operationLimits: { 'execution.rollout': { 'rollout.trials': 1 },
      'execution.role': { 'model.requests': 3, 'model.tokens': 5000, 'evidence.items': 20, 'evidence.bytes': 20_000 },
      'execution.feedback': { 'model.requests': 3, 'model.tokens': 5000,
        'evidence.items': 20, 'evidence.bytes': 20_000 },
      'execution.workspace-edit': { 'model.requests': 3, 'model.tokens': 5000 },
      'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20_000 },
      'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20_000 } },
    roles, runtimeResources: [], modelDestination: { id: 'recorded/cpu', module: './model.mjs',
      provider: 'recorded', model: 'cpu' } };
  await writeFile(join(root, 'model.mjs'), `import { LlmAdapter } from 'rsi-gear/algorithm/harness'
class RecordedAdapter extends LlmAdapter {
  async *stream() { throw Error('CPU admission fixture does not start a model') }
}
export function registerModel(llm) {
  llm.registerAdapter(['recorded'], new RecordedAdapter())
  return { destinationId: 'recorded/cpu', currentDestinationId: () => 'recorded/cpu' }
}
`);
  await writeFile(join(root, 'host.mjs'), `import { createConfiguredFreshHostProfile } from 'rsi-gear/algorithm/harness'
import { registerModel } from './model.mjs'
export const hostProfile = {
  create(context) { return createConfiguredFreshHostProfile(context, { settingsPath: 'host.settings.json', registerModel }) }
}
`);
  await writeFile(join(root, 'host.settings.json'), JSON.stringify(settings));
  const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 4, capability: 'hard' },
    'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 30, capability: 'hard' },
    'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 100_000, capability: 'stop' },
    'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' },
    'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' } };
  const context = { campaignId: 'public-host-check', configDir: root, stateDir: join(runtimeRoot, 'direct-state'),
    config: { coresetSize: 1, historyPageSize: 2, baselineRepeats: 2, proposalCount: 1 }, budget,
    artifacts: new FileArtifactStore(join(runtimeRoot, 'direct-state', 'artifacts')) };
  class RecordedAdapter extends LlmAdapter {
    async *stream() { throw Error('CPU admission fixture does not start a model'); }
  }
  const profile = await createConfiguredFreshHostProfile(context, { settingsPath: 'host.settings.json',
    registerModel: llm => { llm.registerAdapter(['recorded'], new RecordedAdapter());
      return { destinationId: 'recorded/cpu', currentDestinationId: () => 'recorded/cpu' }; } });
  try {
    assert.equal(profile.providers.some(provider => provider.describe().kind === 'execution.rollout'), true);
    assert.equal(profile.providers.some(provider => provider.describe().kind === 'execution.workspace-edit'), true);
    assert.equal(profile.bindings.harness.schemaId, 'harness.directory.v1');
    assert.equal(profile.config.historyTraceAvailable, false);
  } finally { await profile.close(); }
  const python = process.env.GEAR_ALGORITHM_PACKAGE_PYTHON;
  const cli = process.env.GEAR_ALGORITHM_PACKAGE_CLI;
  if (!python || !cli) throw Error('GEAR_ALGORITHM_PACKAGE_PYTHON and GEAR_ALGORITHM_PACKAGE_CLI are required');
  const campaign = { schemaVersion: 1, kind: 'algorithm-campaign', campaignId: 'public-host-cli-check',
    stateDir: join(runtimeRoot, 'cli-state'),
    algorithm: { language: 'python', interpreter: python, module: 'gear_algorithm.recipes.rho', export: 'algorithm' },
    hostProfile: { language: 'typescript', module: './host.mjs', export: 'hostProfile',
      resources: ['./host.settings.json'] },
    config: context.config, budget };
  const configPath = join(root, 'gear.algorithm.json');
  await writeFile(configPath, JSON.stringify(campaign));
  const output = execFileSync(process.execPath, [cli, 'algorithm', 'check', configPath], {
    cwd: root, env: process.env, encoding: 'utf8' });
  const checked = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(checked.ok, true);
  assert.ok(checked.providers.includes('execution.workspace-edit'));
  console.log(JSON.stringify({ configuredPhysicalHost: true, publicCliCheck: true,
    providerCount: checked.providers.length }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}
