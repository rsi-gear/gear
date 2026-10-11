import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { createDefaultFreshHostProfile } from '../../src/algorithm/default-host.js';
import { createRestrictedAlgorithmDshHost, LlmAdapter, CallId,
  type GenerateOptions, type StreamChunk } from '../../src/algorithm/dsh-host.js';
import { loadPythonAlgorithm } from '../../src/algorithm/loader.js';
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createMultiRecordedHitchCliFixture } from '../helpers/algorithm-hitch-multi-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec, metaAgent } from '../helpers/research-fixture.js';

const python = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(!python)('runs the Python RHO recipe through default DSH edit, physical Hitch and paired preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-default-rho-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 2 } };
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler() });
  const recorded = await createMultiRecordedHitchCliFixture(git, { 'task-0': 0.3, 'task-1': 0.2 });
  const workspaceManager = new CandidateWorkspaceManager({ repositoryPath: git.repository,
    targetRoot: git.targetRoot, rootForEvolution: id => join(root, 'workspaces', id),
    maxFiles: 10, maxBytes: 200_000, maxDiffBytes: 200_000 });
  await builder.initialize(); await workspaceManager.initialize();
  const modelCalls: string[] = [];
  const editorTurns = new Map<string, number>();
  const preferenceTurns = new Map<string, number>();
  const pairedReports: Array<{ revisionDigest: string }> = [];
  const pairedTraces: string[] = [];
  class RecordedModel extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      const conversation = JSON.stringify(request.messages);
      const roleId = conversation.includes('OFFLINE_RHO_OPTIMIZER') ? 'rho.optimizer'
        : ['rho.self-preference', 'rho.difficulty', 'rho.diagnoser']
          .find(id => conversation.includes(id));
      if (!roleId) throw new Error('Recorded DSH request has no authorized RHO role');
      modelCalls.push(roleId);
      if (roleId === 'rho.self-preference') {
        const sessionId = String(request.sessionId), turn = preferenceTurns.get(sessionId) ?? 0;
        preferenceTurns.set(sessionId, turn + 1);
        const prompt = request.messages.flatMap(message => message.content)
          .find(block => block.type === 'text' && block.text.includes('"mode":"rho.self-preference"'));
        if (!prompt || prompt.type !== 'text') throw new Error('Paired preference prompt missing');
        const frozen = JSON.parse(prompt.text.slice(prompt.text.lastIndexOf('\n{') + 1)) as {
          input: { authorizedRollouts: Array<{ evidenceRef: unknown; receiptRef: unknown }> } };
        const pairs = frozen.input.authorizedRollouts;
        if (pairs.length !== 2 || JSON.stringify(pairs[0]) === JSON.stringify(pairs[1]))
          throw new Error('Paired preference needs distinct completed producers');
        const results = request.messages.filter(message => message.source.kind === 'tool')
          .map(message => {
            const block = message.content[0];
            if (block?.type !== 'tool-result' || block.content[0]?.type !== 'text')
              throw new Error('Recorded rollout evidence tool result missing');
            return JSON.parse(block.content[0].text) as Record<string, any>;
          });
        if (turn < 6) {
          let name: string, args: Record<string, unknown>;
          if (turn < 2) { name = 'rollout_evidence_query'; args = { authorization: pairs[turn] }; }
          else {
            name = 'rollout_evidence_read';
            const page = results[turn % 2];
            if (!page) throw new Error('Rollout projection page not delivered');
            const contentRef = turn < 4 ? page.reportRef : page.traceRefs.at(-1);
            if (!contentRef) throw new Error('Rollout report/trace ref missing');
            args = { authorization: pairs[turn % 2], contentDigest: contentRef.digest };
          }
          const id = CallId(`paired-${turn}`);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name,
            argumentsDelta: JSON.stringify({ requestJson: JSON.stringify(args) }) };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name,
            arguments: JSON.stringify({ requestJson: JSON.stringify(args) }) } };
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        for (const index of [2, 3]) pairedReports.push(JSON.parse(results[index]?.text) as { revisionDigest: string });
        for (const index of [4, 5]) pairedTraces.push(results[index]?.text as string);
        if (!pairedReports[0]?.revisionDigest || !pairedReports[1]?.revisionDigest
          || pairedReports[0].revisionDigest === pairedReports[1].revisionDigest
          || pairedTraces.some(text => typeof text !== 'string' || !text.includes('run_')))
          throw new Error('Preference model did not receive distinct physical reports and traces');
      }
      if (roleId === 'rho.optimizer') {
        const sessionId = String(request.sessionId), turn = editorTurns.get(sessionId) ?? 0;
        editorTurns.set(sessionId, turn + 1);
        if (turn < 2) {
          const name = turn === 0 ? 'workspace_read' : 'workspace_edit';
          const args = turn === 0 ? { path: 'plugins/context.ts' }
            : { path: 'plugins/context.ts', oldString: 'value = 1', newString: 'value = 2',
              expectedDigest: `sha256:${sha256('export const value = 1\n')}` };
          const id = CallId(`rho-edit-${turn}`);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } };
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      const value = roleId === 'rho.difficulty' ? { difficulty: 8, fingerprint: [1, 0] }
        : roleId === 'rho.diagnoser' ? { diagnosis: 'repair the bound plugin' }
          : roleId === 'rho.self-preference' ? { preference: 2 } : { edited: true };
      yield { type: 'text-delta', index: 0, text: JSON.stringify(value) };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const dsh = await createRestrictedAlgorithmDshHost(llm => { llm.registerAdapter(['p'], new RecordedModel()); });
  const authorDir = join(root, 'python-author'); await mkdir(authorDir);
  const load = () => loadPythonAlgorithm({ configDir: authorDir, module: 'gear_algorithm.recipes.rho',
    export: 'algorithm', interpreter: python!, sdkPath: resolve('packages/python-sdk/src') });
  const loaded = await load();
  try {
    const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 4, capability: 'hard' as const },
      'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 30, capability: 'hard' as const },
      'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const },
      'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' as const },
      'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const } };
    const science = { coresetSize: 1, historyPageSize: 2, baselineRepeats: 2, proposalCount: 1 };
    const stateDir = join(root, 'state'), artifacts = new FileArtifactStore(join(stateDir, 'artifacts'));
    const hostContext = { campaignId: 'default-rho-flow', configDir: root, stateDir,
      config: science, budget, artifacts };
    const role = (id: string) => ({ id, spec: metaAgent(), instruction: `Recorded ${id} role`,
      maxModelRequests: id === 'rho.self-preference' ? 7 : 3,
      maxTokens: id === 'rho.self-preference' ? 20_000 : 10_000, timeoutMs: 20_000,
      inputSchema: { type: 'object' as const, additionalProperties: true },
      resultSchema: { type: 'object' as const, additionalProperties: true } });
    const profile = await createDefaultFreshHostProfile(hostContext, { recipe: 'rho', spec,
      workspaceRoot: root, authorityId: 'default-rho-host', builder, evaluator: recorded.evaluator,
      dshContext: dsh.context, workspaceManager,
      roleDefinitions: [role('rho.difficulty'), role('rho.diagnoser')],
      feedbackRoleDefinitions: [role('rho.self-preference')],
      workspaceEditRoles: [{ id: 'rho.optimizer', spec: metaAgent(), instruction: 'OFFLINE_RHO_OPTIMIZER: Edit the bound plugin.',
        maxModelRequests: 3, maxTokens: 10_000, timeoutMs: 20_000 }],
      modelRuntimeDigest: sha256('recorded-model-v1'), currentModelRuntimeDigest: () => sha256('recorded-model-v1'),
      modelDisclosurePolicyDigest: sha256('recorded-role-policy-v1'),
      currentModelDisclosurePolicyDigest: () => sha256('recorded-role-policy-v1'),
      authorizeModelRole: () => undefined,
      operationLimits: { 'execution.rollout': { 'rollout.trials': 1 },
        'execution.role': { 'model.requests': 3, 'model.tokens': 10_000, 'evidence.items': 20, 'evidence.bytes': 20_000 },
        'execution.feedback': { 'model.requests': 7, 'model.tokens': 20_000,
          'evidence.items': 20, 'evidence.bytes': 20_000 },
        'execution.workspace-edit': { 'model.requests': 3, 'model.tokens': 10_000 },
        'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20_000 },
        'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20_000 } },
    });
    const bindings = new BindingStore(artifacts, loaded.value.describe().bindingSchema);
    const initialBindingSetRef = bindings.create(profile.bindings!);
    const campaign = { campaignId: hostContext.campaignId, config: profile.config!, initialBindingSetRef, budget };
    const runtime = new AlgorithmRuntime(stateDir, loaded.value, profile.providers, campaign);
    let status = await runtime.runUntilBlocked();
    for (let attempt = 0; status !== 'complete' && attempt < 80; attempt++) {
      if (status === 'waiting') await new Promise(resolve => setTimeout(resolve, 100));
      status = await runtime.runUntilBlocked();
    }
    expect(status).toBe('complete');
    const snapshot = runtime.snapshot()!;
    expect((snapshot.state as { accepted: boolean }).accepted).toBe(true);
    expect(snapshot.activeBindingSetRef.digest).not.toBe(initialBindingSetRef.digest);
    const winner = bindings.read(snapshot.activeBindingSetRef).slots.harness!;
    const version = artifacts.getJson(winner) as { commitOid: string; manifestDigest: string };
    expect((await builder.readHarnessFile(version.commitOid, 'plugins/context.ts')).content).toBe('export const value = 2\n');
    expect(modelCalls).toContain('rho.self-preference');
    expect(pairedReports).toHaveLength(2);
    expect(pairedTraces).toHaveLength(2);
    expect(snapshot.spent['rollout.trials']).toBe(3);
    const callsBeforeRestart = modelCalls.length;
    const submits = async () => (await readFile(recorded.invocationLog, 'utf8')).split('\n')
      .filter(Boolean).filter(line => JSON.parse(line)[1] === 'submit').length;
    const submitsBeforeRestart = await submits();
    await loaded.close();
    const reopened = await load();
    try {
      const resumed = new AlgorithmRuntime(stateDir, reopened.value, profile.providers, campaign);
      expect(await resumed.runUntilBlocked(50)).toBe('complete');
      expect(resumed.snapshot()?.activeBindingSetRef.digest).toBe(snapshot.activeBindingSetRef.digest);
    } finally { await reopened.close(); }
    expect(modelCalls).toHaveLength(callsBeforeRestart);
    expect(await submits()).toBe(submitsBeforeRestart);
  } finally { await loaded.close().catch(() => {}); await dsh.close(); }
}, 60_000);
