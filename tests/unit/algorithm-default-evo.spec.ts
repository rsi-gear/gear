import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { HarnessBuilder, type HarnessCompiler } from '../../src/harness/builder.js';
import type { CompilerCheckReport } from '../../src/harness/check-report.js';
import type { HarnessManifest } from '../../src/types.js';
import { digestJson } from '../../src/state/digest.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createMultiRecordedHitchCliFixture } from '../helpers/algorithm-hitch-multi-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec, metaAgent } from '../helpers/research-fixture.js';

const interpreter = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const skillBody = '---\nname: retry-check\ndescription: Check the failing tool result before retrying.\n---\n\n# Retry check\n\nInspect a failing tool result and verify the correction.\n';

function modelContext() {
  const ctx = new Context();
  new AgentRegistry(ctx); new SessionStore(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx); new LlmRuntime(ctx);
  return ctx;
}
class OfflinePhysicalSkillCheck implements HarnessCompiler {
  readonly runtimeValidation = true;
  async compile(worktree: string, _signal: AbortSignal, manifest?: HarnessManifest): Promise<CompilerCheckReport> {
    const content = await readFile(join(worktree, 'harness', 'skills', 'retry-check', 'SKILL.md'), 'utf8');
    if (content !== skillBody) throw new Error('Offline runtime read different Skill bytes');
    const passed = { status: 'passed' as const };
    return { ok: true, status: 'passed', runtime: { schemaVersion: 1,
      candidateDigest: manifest!.digest,
      identity: { name: 'offline-skill-runtime', version: '1', lockDigest: digestJson('offline-runtime') },
      load: passed, promptAssembly: passed, skillDiscovery: { status: 'passed', checked: 1, expected: 1 },
      skillRead: { status: 'passed', checked: 1, expected: 1 }, cleanup: passed,
      skills: [{ name: 'retry-check', path: 'skills/retry-check/SKILL.md', provider: 'filesystem',
        contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`, read: 'passed' }] } };
  }
}

type ToolPage = { skills?: Array<{ name: string; contentRef: unknown }>; name?: string; markdown?: string;
  traceRefs?: Array<{ digest: string }>; reportRef?: { digest: string }; text?: string; error?: unknown };
function toolOutputs(request: GenerateOptions): ToolPage[] {
  const pages: ToolPage[] = [];
  for (const message of request.messages) for (const block of message.content) {
    if (block.type !== 'tool-result') continue;
    for (const content of block.content) if (content.type === 'text') {
      let parsed: ToolPage;
      try { parsed = JSON.parse(content.text) as ToolPage; }
      catch { throw new Error('Offline role received malformed tool result JSON'); }
      if (parsed.error !== undefined || !parsed || typeof parsed !== 'object') {
        throw new Error(`Offline role received a failed tool result: ${JSON.stringify(parsed)}`);
      }
      pages.push(parsed);
    }
  }
  return pages;
}
function roleInput(request: GenerateOptions): { roleId: string; input: Record<string, any> } {
  const text = request.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text)
    .find(value => value.includes('"roleId":"evo.'));
  if (!text) throw new Error('Offline model received no Evo role prompt');
  const parsed = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as { roleId: string; input: Record<string, any> };
  if (!parsed.roleId?.startsWith('evo.')) throw new Error('Offline model role prompt invalid');
  return parsed;
}

it.skipIf(!interpreter)('runs two Python Evo batches through DSH Skill tools, real Git overlay and keyed Hitch daemon replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-default-evo-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 1 } };
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new OfflinePhysicalSkillCheck() });
  const recorded = await createMultiRecordedHitchCliFixture(git, { 'task-0': 0, 'task-1': 0 });
  const workspaceManager = new CandidateWorkspaceManager({ repositoryPath: git.repository,
    targetRoot: git.targetRoot, rootForEvolution: id => join(root, 'workspaces', id),
    maxFiles: 10, maxBytes: 200_000, maxDiffBytes: 200_000 });
  const ctx = modelContext();
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.on('session/flush', async () => {});
  ctx.provide('agentPresets', { mount: async () => {} } as never);
  const calls: Array<{ roleId: string; tools: string[] }> = [];
  const disclosed: string[] = [];
  const policyDigest = sha256('explicit-offline-skill-destination');
  class OfflineModel extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      const { roleId, input } = roleInput(request);
      const pages = toolOutputs(request);
      const tool = (name: string, args: object): StreamChunk[] => {
        const id = CallId(`${name}-${calls.length}`);
        return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
          { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } },
          { type: 'finish', reason: { kind: 'tool-calls' } }];
      };
      const json = (value: unknown): StreamChunk[] => [
        { type: 'text-delta', index: 0, text: JSON.stringify(value) },
        { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } },
        { type: 'finish', reason: { kind: 'stop' } }];
      let chunks: StreamChunk[];
      if (roleId === 'evo.retriever') {
        const listing = pages.find(page => Array.isArray(page.skills));
        const read = pages.find(page => typeof page.markdown === 'string');
        if (!listing) chunks = tool('skills_list', {});
        else if (!listing.skills!.length) chunks = json({ skillRefs: [] });
        else if (!read) chunks = tool('skills_read', { requestJson: JSON.stringify({ contentRef: listing.skills![0]!.contentRef }) });
        else {
          expect(read.markdown).toContain('Inspect a failing tool result');
          chunks = json({ skillRefs: [listing.skills![0]!.contentRef] });
        }
      } else if (roleId === 'evo.proposer') {
        const page = pages.find(item => Array.isArray(item.traceRefs));
        const read = pages.find(item => typeof item.text === 'string');
        if (!page) chunks = tool('rollout_evidence_query', { requestJson: JSON.stringify({
          authorization: input.authorizedRollouts[0], offset: 0, limit: 5 }) });
        else if (!read) {
          const traceRef = page.traceRefs?.[1];
          if (!traceRef?.digest) throw new Error('Rollout projection did not expose a trace digest');
          chunks = tool('rollout_evidence_read', { requestJson: JSON.stringify({
            authorization: input.authorizedRollouts[0], contentDigest: traceRef.digest }) });
        } else {
          const trace = JSON.parse(read.text!) as { content?: string };
          if (typeof trace.content !== 'string' || !JSON.stringify(JSON.parse(trace.content)).includes('"isError":true'))
            throw new Error('Offline proposer did not read a real failed tool result');
          chunks = json({ action: 'NEW', lesson: 'Inspect failing tool output before retrying.', trigger: 'tool error' });
        }
      } else if (roleId === 'evo.curator') {
        chunks = input.batchTaskIds.includes('task-0')
          ? json({ action: 'ADD', skills: [{ name: 'retry-check', markdown: skillBody }] })
          : json({ action: 'SKIP' });
      } else throw new Error(`Unexpected Evo role ${roleId}`);
      calls.push({ roleId, tools: request.tools?.map(item => item.name) ?? [] });
      for (const chunk of chunks) yield chunk;
    }
  }
  ctx.llm.registerAdapter(['p'], new OfflineModel());
  const stateRoot = join(root, 'state');
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
  const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 2, capability: 'hard' as const },
    'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 20, capability: 'hard' as const },
    'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 80_000, capability: 'stop' as const },
    'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' as const },
    'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const } };
  const context = { campaignId: 'evo-full-physical', configDir: root, stateDir: stateRoot,
    config: { batchSize: 1, injectionBudget: 1 }, budget, artifacts };
  const definition = (id: string, maxModelRequests: number) => ({ id, spec: metaAgent(),
    instruction: `Offline ${id} role; use the provided bound tools.`, maxModelRequests, maxTokens: 20_000, timeoutMs: 20_000,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: true },
    resultSchema: { type: 'object' as const, properties: {}, additionalProperties: true } });
  const limits = { 'execution.rollout': { 'rollout.trials': 1 },
    'execution.role': { 'model.requests': 3, 'model.tokens': 20_000,
      'evidence.items': 20, 'evidence.bytes': 20_000 },
    'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20_000 },
    'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20_000 } };
  const profile = await createDefaultFreshHostProfile(context, { recipe: 'evo', spec, workspaceRoot: root,
    authorityId: 'offline-evo-host', builder, evaluator: recorded.evaluator, operationLimits: limits,
    dshContext: ctx, workspaceManager,
    roleDefinitions: [definition('evo.retriever', 3), definition('evo.proposer', 3), definition('evo.curator', 1)],
    workspaceEditRoles: [], modelRuntimeDigest: sha256('offline-dsh-model'),
    currentModelRuntimeDigest: () => sha256('offline-dsh-model'),
    modelDisclosurePolicyDigest: sha256('offline-destination'),
    currentModelDisclosurePolicyDigest: () => sha256('offline-destination'),
    authorizeModelRole: () => undefined, passThreshold: 0.5,
    evoSkillDisclosure: { policyDigest, currentPolicyDigest: () => policyDigest,
      authorize(request) { disclosed.push(`${request.roleId}:${request.action}`); } } });
  const bindings = new BindingStore(artifacts, { id: 'evo.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: false },
    skills: { schemaId: 'skills.library.v1', required: true, replaceable: true } } });
  const initialBindingSetRef = bindings.create(profile.bindings!);
  const authorDir = join(root, 'python-author');
  await mkdir(authorDir);
  const load = () => loadPythonAlgorithm({ configDir: authorDir, module: 'gear_algorithm.recipes.evo', export: 'algorithm',
    interpreter: interpreter!, sdkPath: resolve('packages/python-sdk/src') });
  const loaded = await load();
  const campaign = { campaignId: context.campaignId, config: profile.config!,
    initialBindingSetRef, budget };
  try {
    const runtime = new AlgorithmRuntime(stateRoot, loaded.value, profile.providers, campaign);
    let status: string = 'waiting';
    for (let tick = 0; tick < 80 && status !== 'complete'; tick++) status = await runtime.runUntilBlocked(100);
    expect(status).toBe('complete');
    const snapshot = runtime.snapshot()!;
    const history = (snapshot.state as { batchHistory: Array<{ curation: string;
      frozenSkillsBindingSetRef: { digest: string }; nextSkillsBindingSetRef: { digest: string } }> }).batchHistory;
    expect(history).toHaveLength(2);
    expect(history.map(item => item.curation)).toEqual(['ADD', 'curator skipped']);
    expect(history[0]!.nextSkillsBindingSetRef.digest).not.toBe(initialBindingSetRef.digest);
    expect(history[1]!.frozenSkillsBindingSetRef.digest).toBe(history[0]!.nextSkillsBindingSetRef.digest);
    expect(history[1]!.nextSkillsBindingSetRef.digest).toBe(history[0]!.nextSkillsBindingSetRef.digest);
    const libraryRef = bindings.read(snapshot.activeBindingSetRef).slots.skills!;
    expect((artifacts.getJson(libraryRef) as { skills: Array<{ name: string }> }).skills.map(item => item.name))
      .toEqual(['retry-check']);
    expect(disclosed).toContain('evo.retriever:skills_read');
    expect(calls.filter(item => item.roleId === 'evo.proposer')).toHaveLength(6);
    expect(calls.filter(item => item.roleId === 'evo.proposer' && item.tools.includes('rollout_evidence_read')))
      .toHaveLength(6);
    expect(calls.some(item => item.roleId === 'evo.retriever' && item.tools.includes('skills_read'))).toBe(true);
    expect(snapshot.spent['rollout.trials']).toBe(2);
    const journals = await Promise.all((await readdir(join(stateRoot, 'algorithm-hitch-operations')))
      .filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(
        join(stateRoot, 'algorithm-hitch-operations', name), 'utf8')) as { envelope: { input: { task: { id: string } } };
        overlay?: { commitOid: string; receiptRef: { digest: string } };
        completion?: { outcome: { value?: { receiptRef: Parameters<FileArtifactStore['getJson']>[0] } } } }));
    expect(journals).toHaveLength(2);
    const second = journals.find(item => item.envelope.input.task.id === 'task-1');
    expect(second?.overlay?.commitOid).toMatch(/^[a-f0-9]{40}$/);
    expect((await builder.readHarnessFile(second!.overlay!.commitOid, 'skills/retry-check/SKILL.md')).content)
      .toContain('Inspect a failing tool result');
    const physicalReceipt = artifacts.getJson(second!.completion!.outcome.value!.receiptRef) as Record<string, any>;
    expect(physicalReceipt.executedHarnessCommit).toBe(second!.overlay!.commitOid);
    expect(physicalReceipt.skillOverlayReceiptRef.digest).toBe(second!.overlay!.receiptRef.digest);
    expect(physicalReceipt.injectedSkillDigests).toHaveLength(1);
    const evals = await Promise.all((await readdir(recorded.stateDir)).map(async name => JSON.parse(await readFile(
      join(recorded.stateDir, name), 'utf8')) as { key: string; evalId: string; runId: string; commit: string }));
    expect(evals).toHaveLength(2);
    expect(new Set(evals.map(item => item.key)).size).toBe(2);
    expect(new Set(evals.map(item => item.evalId)).size).toBe(2);
    expect(new Set(evals.map(item => item.runId)).size).toBe(2);
    expect(evals.map(item => item.commit)).toContain(second!.overlay!.commitOid);
    const priorCalls = calls.length;
    const priorSubmissions = (await readFile(recorded.invocationLog, 'utf8')).split('\n')
      .filter(Boolean).filter(line => JSON.parse(line)[1] === 'submit').length;
    await loaded.close();
    const reopened = await load();
    try {
      const resumed = new AlgorithmRuntime(stateRoot, reopened.value, profile.providers, campaign);
      expect(await resumed.runUntilBlocked(20)).toBe('complete');
    } finally { await reopened.close(); }
    expect(calls).toHaveLength(priorCalls);
    expect((await readFile(recorded.invocationLog, 'utf8')).split('\n')
      .filter(Boolean).filter(line => JSON.parse(line)[1] === 'submit')).toHaveLength(priorSubmissions);
  } finally {
    await loaded.close().catch(() => {});
    await profile.close?.();
    await ctx.fiber.dispose();
  }
});
