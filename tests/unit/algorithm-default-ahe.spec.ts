import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { CallId, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { afterEach, expect, it } from 'vitest';
import { AlgorithmRuntime } from '../../src/algorithm/index.js';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { createDefaultFreshHostProfile } from '../../src/algorithm/default-host.js';
import { loadPythonAlgorithm } from '../../src/algorithm/loader.js';
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js';
import { HarnessBuilder } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createMultiRecordedHitchCliFixture } from '../helpers/algorithm-hitch-multi-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec, metaAgent } from '../helpers/research-fixture.js';

const interpreter = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Page = { path?: string; text?: string; digest?: string; traceRefs?: Array<{ digest: string }>;
  error?: unknown };
function pages(request: GenerateOptions): Page[] {
  const output: Page[] = [];
  for (const message of request.messages) for (const block of message.content) {
    if (block.type !== 'tool-result') continue;
    for (const content of block.content) if (content.type === 'text') {
      const parsed = JSON.parse(content.text) as Page;
      if (!parsed || typeof parsed !== 'object' || parsed.error !== undefined)
        throw new Error(`Offline AHE tool failed: ${content.text}`);
      output.push(parsed);
    }
  }
  return output;
}
function call(name: string, args: object, index: number): StreamChunk[] {
  const id = CallId(`ahe-${name}-${index}`);
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } }];
}
function answer(value: object): StreamChunk[] {
  return [{ type: 'text-delta', index: 0, text: JSON.stringify(value) },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } }];
}

it.skipIf(!interpreter)('runs three measured Python AHE rounds with physical rollback, trace attribution and durable restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-default-ahe-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 2 } };
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: { compile: async worktree => {
      const source = await readFile(join(worktree, 'harness', 'plugins', 'context.ts'), 'utf8');
      if (!['export const value = 1\n', 'export const value = 2\n'].includes(source))
        throw new Error('Offline fixed compiler rejected the context source');
    } } });
  const recorded = await createMultiRecordedHitchCliFixture(git, {}, undefined, {
    path: 'harness/plugins/context.ts', rules: [
      { contains: 'value = 2', rewardByTask: { 'task-0': 1, 'task-1': 0 } },
      { contains: 'value = 1', rewardByTask: { 'task-0': 0, 'task-1': 1 } },
    ] });
  const workspaceManager = new CandidateWorkspaceManager({ repositoryPath: git.repository,
    targetRoot: git.targetRoot, rootForEvolution: id => join(root, 'workspaces', id),
    maxFiles: 10, maxBytes: 200_000, maxDiffBytes: 200_000 });
  const ctx = new Context();
  new AgentRegistry(ctx); new SessionStore(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx); new LlmRuntime(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.on('session/flush', async () => {});
  ctx.provide('agentPresets', { mount: async () => {} } as never);
  const calls: Array<{ role: string; tools: string[] }> = [];
  const readTraceRounds: number[] = [];
  const evolved: Array<{ round: number; predictions: { predictedFixes: string[]; riskTasks: string[] } }> = [];
  class OfflineAheModel extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      const texts = request.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text);
      const visible = texts.find(text => text.includes('OFFLINE_AHE_EVOLVER'));
      const attribution = texts.find(text => text.includes('"roleId":"ahe.attributor"'));
      const results = pages(request);
      let chunks: StreamChunk[];
      let role: string;
      if (visible) {
        role = 'ahe.evolver';
        const projection = JSON.parse(visible.slice(visible.lastIndexOf('\n') + 1)) as {
          measurement: { round: number } };
        const round = projection.measurement.round;
        const readPaths = results.filter(item => typeof item.path === 'string');
        if (round === 0) {
          if (readPaths.length === 0) chunks = call('workspace_read', { path: 'plugins/context.ts' }, calls.length);
          else if (results.length === 1) {
            expect(results[0]!.text).toBe('export const value = 1\n');
            chunks = call('workspace_edit', { path: 'plugins/context.ts', oldString: 'value = 1',
              newString: 'value = 2', expectedDigest: `sha256:${sha256('export const value = 1\n')}` }, calls.length);
          } else if (results.length === 2) chunks = call('workspace_write', { requestJson: JSON.stringify({
            path: 'prompts/marker.md', text: 'candidate-one\n', expectedDigest: null }) }, calls.length);
          else {
            const prediction = { predictedFixes: ['task-0'], riskTasks: ['task-1'] };
            evolved.push({ round, predictions: prediction }); chunks = answer(prediction);
          }
        } else if (round === 1) {
          if (results.length === 0) chunks = call('workspace_read', { path: 'plugins/context.ts' }, calls.length);
          else if (results.length === 1) {
            expect(results[0]!.text).toBe('export const value = 1\n');
            chunks = call('workspace_read', { path: 'prompts/marker.md' }, calls.length);
          } else if (results.length === 2) {
            expect(results[1]!.text).toBe('candidate-one\n');
            chunks = call('workspace_edit', { path: 'prompts/marker.md', oldString: 'candidate-one',
              newString: 'candidate-two', expectedDigest: `sha256:${sha256('candidate-one\n')}` }, calls.length);
          } else {
            const prediction = { predictedFixes: ['task-1'], riskTasks: ['task-0'] };
            evolved.push({ round, predictions: prediction }); chunks = answer(prediction);
          }
        } else throw new Error(`Unexpected AHE evolver round ${round}`);
      } else if (attribution) {
        role = 'ahe.attributor';
        const parsed = JSON.parse(attribution.slice(attribution.lastIndexOf('\n') + 1)) as {
          input: { currentMeasurement: { round: number; authorizedRollouts: Record<string, unknown[]> } } };
        const measurement = parsed.input.currentMeasurement;
        const regressed = measurement.round === 1 ? 'task-1' : 'task-0';
        const page = results.find(item => Array.isArray(item.traceRefs));
        const read = results.find(item => typeof item.text === 'string');
        if (!page) chunks = call('rollout_evidence_query', { requestJson: JSON.stringify({
          authorization: measurement.authorizedRollouts[regressed]![0], offset: 0, limit: 5 }) }, calls.length);
        else if (!read) {
          const traceRef = page.traceRefs?.[1];
          if (!traceRef?.digest) throw new Error('AHE attribution query omitted physical trace content');
          chunks = call('rollout_evidence_read', { requestJson: JSON.stringify({
            authorization: measurement.authorizedRollouts[regressed]![0], contentDigest: traceRef.digest }) }, calls.length);
        } else {
          const trace = JSON.parse(read.text!) as { content?: string };
          if (typeof trace.content !== 'string' || !JSON.stringify(JSON.parse(trace.content)).includes('"isError":true'))
            throw new Error('AHE attributor did not read real failing-tool trace content');
          readTraceRounds.push(measurement.round);
          chunks = answer({ rollbackFiles: measurement.round === 1 ? ['plugins/context.ts'] : [] });
        }
      } else throw new Error('Unexpected AHE model request');
      calls.push({ role, tools: request.tools?.map(item => item.name) ?? [] });
      for (const chunk of chunks) yield chunk;
    }
  }
  ctx.llm.registerAdapter(['p'], new OfflineAheModel());
  const stateRoot = join(root, 'state');
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
  const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 12, capability: 'hard' as const },
    'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 30, capability: 'hard' as const },
    'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const },
    'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' as const },
    'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const } };
  const context = { campaignId: 'ahe-full-physical', configDir: root, stateDir: stateRoot,
    config: { taskCount: 2, rounds: 3, rolloutsPerTask: 2 }, budget, artifacts };
  const definition = (id: string, maxModelRequests: number) => ({ id, spec: metaAgent(),
    instruction: `OFFLINE_AHE_${id.toUpperCase()}`, maxModelRequests, maxTokens: 20_000, timeoutMs: 30_000,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: true },
    resultSchema: { type: 'object' as const, properties: {}, additionalProperties: true } });
  const editor = (id: string, maxModelRequests: number) => ({ id, spec: metaAgent(),
    instruction: `OFFLINE_AHE_${id === 'ahe.evolver' ? 'EVOLVER' : 'ROLLBACK'}`,
    maxModelRequests, maxTokens: 20_000, timeoutMs: 30_000 });
  const limits = { 'execution.rollout': { 'rollout.trials': 1 },
    'execution.role': { 'model.requests': 4, 'model.tokens': 20_000,
      'evidence.items': 20, 'evidence.bytes': 20_000 },
    'execution.workspace-edit': { 'model.requests': 5, 'model.tokens': 20_000 },
    'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20_000 },
    'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20_000 } };
  const profile = await createDefaultFreshHostProfile(context, { recipe: 'ahe', spec, workspaceRoot: root,
    authorityId: 'offline-ahe-host', builder, evaluator: recorded.evaluator, operationLimits: limits,
    dshContext: ctx, workspaceManager, roleDefinitions: [definition('ahe.attributor', 4)],
    feedbackRoleDefinitions: [], workspaceEditRoles: [editor('ahe.evolver', 5), editor('ahe.rollback', 1)],
    modelRuntimeDigest: sha256('offline-ahe-model'), currentModelRuntimeDigest: () => sha256('offline-ahe-model'),
    modelDisclosurePolicyDigest: sha256('offline-ahe-destination'),
    currentModelDisclosurePolicyDigest: () => sha256('offline-ahe-destination'),
    authorizeModelRole: () => undefined, passThreshold: 0.5 });
  const bindings = new BindingStore(artifacts, { id: 'ahe.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
  const initialBindingSetRef = bindings.create(profile.bindings!);
  const authorDir = join(root, 'python-author'); await mkdir(authorDir);
  const load = () => loadPythonAlgorithm({ configDir: authorDir, module: 'gear_algorithm.recipes.ahe', export: 'algorithm',
    interpreter: interpreter!, sdkPath: resolve('packages/python-sdk/src') });
  const loaded = await load();
  const campaign = { campaignId: context.campaignId, config: profile.config!, initialBindingSetRef, budget };
  try {
    const runtime = new AlgorithmRuntime(stateRoot, loaded.value, profile.providers, campaign);
    let status: string = 'waiting';
    for (let tick = 0; tick < 200 && status !== 'complete'; tick++) status = await runtime.runUntilBlocked(100);
    expect(status).toBe('complete');
    const snapshot = runtime.snapshot()!;
    const state = snapshot.state as unknown as { measurement: { round: number; bindingSetRef: { digest: string };
      taskPassed: Record<string, boolean> }; predictionVerdict: { regressions: string[] };
      attribution: { rollbackFiles: string[] }; selectedBestMeasured: { digest: string } };
    expect(state.measurement.round).toBe(2);
    expect(state.measurement.taskPassed).toEqual({ 'task-0': false, 'task-1': true });
    expect(state.predictionVerdict.regressions).toContain('task-0');
    expect(evolved.map(item => item.predictions)).toEqual([
      { predictedFixes: ['task-0'], riskTasks: ['task-1'] },
      { predictedFixes: ['task-1'], riskTasks: ['task-0'] }]);
    expect(readTraceRounds).toEqual([1, 2]);
    expect(calls.filter(item => item.role === 'ahe.attributor' && item.tools.includes('rollout_evidence_query')))
      .toHaveLength(6);
    expect(calls.filter(item => item.role === 'ahe.attributor' && item.tools.includes('rollout_evidence_read')))
      .toHaveLength(6);
    expect(snapshot.spent['rollout.trials']).toBe(12);
    const measuredHarness = artifacts.getJson(bindings.read(state.measurement.bindingSetRef as never).slots.harness!) as { commitOid: string };
    expect((await builder.readHarnessFile(measuredHarness.commitOid, 'plugins/context.ts')).content)
      .toBe('export const value = 1\n');
    expect((await builder.readHarnessFile(measuredHarness.commitOid, 'prompts/marker.md')).content)
      .toBe('candidate-two\n');
    const editRecords = await Promise.all((await readdir(join(stateRoot, 'physical', 'edit', 'operations')))
      .filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(
        join(stateRoot, 'physical', 'edit', 'operations', name), 'utf8')) as {
        envelope: { input: { roleId: string } }; completion?: { outcome: { value?: { structuredResult?: {
          restoredFiles?: string[]; restoredFromCommit?: string; commitOid?: string } } } } }));
    const rollback = editRecords.find(item => item.envelope.input.roleId === 'ahe.rollback');
    expect(rollback?.completion?.outcome.value?.structuredResult?.restoredFiles).toEqual(['plugins/context.ts']);
    const rollbackCommit = rollback!.completion!.outcome.value!.structuredResult!.commitOid!;
    expect((await builder.readHarnessFile(rollbackCommit, 'plugins/context.ts')).content)
      .toBe('export const value = 1\n');
    expect((await builder.readHarnessFile(rollbackCommit, 'prompts/marker.md')).content)
      .toBe('candidate-one\n');
    const evaluations = await Promise.all((await readdir(recorded.stateDir)).map(async name => JSON.parse(await readFile(
      join(recorded.stateDir, name), 'utf8')) as { key: string; commit: string; taskId: string; reward: number }));
    expect(evaluations).toHaveLength(12);
    expect(evaluations.filter(item => item.commit === measuredHarness.commitOid))
      .toHaveLength(4);
    const priorCalls = calls.length;
    const priorSubmits = (await readFile(recorded.invocationLog, 'utf8')).split('\n')
      .filter(Boolean).filter(line => JSON.parse(line)[1] === 'submit').length;
    await loaded.close();
    const reopened = await load();
    try {
      const resumed = new AlgorithmRuntime(stateRoot, reopened.value, profile.providers, campaign);
      expect(await resumed.runUntilBlocked(50)).toBe('complete');
    } finally { await reopened.close(); }
    expect(calls).toHaveLength(priorCalls);
    expect((await readFile(recorded.invocationLog, 'utf8')).split('\n')
      .filter(Boolean).filter(line => JSON.parse(line)[1] === 'submit')).toHaveLength(priorSubmits);
  } finally {
    await loaded.close().catch(() => {});
    await profile.close?.();
    await ctx.fiber.dispose();
  }
});
