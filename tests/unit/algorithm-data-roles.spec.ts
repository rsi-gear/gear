import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { EvidenceService } from '../../src/algorithm/data/evidence.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { DshRoleSessionRegistry, createDshStructuredAdapter, createEvidenceDshRoleHost } from '../../src/algorithm/providers/roles.js';
import { createEvoSkillCapabilities } from '../../src/algorithm/providers/evo-skills.js';
import { metaAgent } from '../helpers/research-fixture.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(meterEvidence = false, hang = false, timeoutMs = 20_000,
  responseText = JSON.stringify({ difficulty: 4.5, fingerprint: [0.1, 0.2] }), curator = false,
  emitUsage = true) {
  const root = await mkdtemp(join(tmpdir(), 'gear-algorithm-role-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  new AgentRegistry(ctx);
  new SessionStore(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx);
  new LlmRuntime(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  cleanups.push(() => ctx.fiber.dispose());
  ctx.on('session/flush', async () => {});
  ctx.provide('agentPresets', { mount: async () => {} } as never);
  const calls: GenerateOptions[] = [];
  let sawAbort = false;
  class Adapter extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(request);
      if (hang) {
        const signal = request.signal;
        if (!signal) throw new Error('DSH model request has no abort signal');
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { sawAbort = true; reject(signal.reason ?? new Error('model aborted')); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        return;
      }
      yield { type: 'text-delta', index: 0, text: responseText };
      if (emitUsage) yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['p'], new Adapter());
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const sessionRoles = new DshRoleSessionRegistry();
  const evidence = new EvidenceService(artifacts, Buffer.alloc(32, 8));
  const host = createEvidenceDshRoleHost(ctx, sessionRoles, evidence,
    principalId => ({ principalId, viewDigests: [], projections: [] }));
  vi.spyOn(host.offloading, 'pressure').mockResolvedValue({ tokens: 10, fixedTokens: 5, basis: 'offline-fixture' });
  const bindings = new BindingStore(artifacts, { id: curator ? 'evo.bindings.v1' : 'rho.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
    ...(curator ? { skills: { schemaId: 'skills.library.v1', required: true, replaceable: true } } : {}),
  } });
  const harness = artifacts.putJson(curator
    ? { schemaVersion: 1, kind: 'git-harness', commitOid: 'a'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}` }
    : { schemaVersion: 1, kind: 'fixture-harness' }, 'harness.directory.v1');
  const skillBody = curator ? artifacts.putJson({ schemaVersion: 1,
    markdown: '---\nname: alpha\ndescription: Existing Skill.\n---\nKnown content.' }, 'skills.body.v1') : undefined;
  const skillLibrary = skillBody ? artifacts.putJson({ schemaVersion: 1,
    skills: [{ name: 'alpha', contentRef: skillBody }] }, 'skills.library.v1') : undefined;
  const bindingSetRef = bindings.create({ harness, ...(skillLibrary ? { skills: skillLibrary } : {}) });
  const publisher = curator ? createEvoSkillCapabilities({ artifacts, bindings,
    disclosure: { policyDigest: sha256('offline-skill-policy'), currentPolicyDigest: () => sha256('offline-skill-policy'),
      authorize: () => {} } }).publisher : undefined;
  let runtimeDigest = sha256('offline-dsh-host-v1');
  const options = { root: join(root, 'role'), kind: 'execution.role' as const, host, sessionRoles, artifacts, bindings,
    accessPolicyDigest: sha256('role-access-v1'), hostRuntimeDigest: runtimeDigest,
    campaignBudget: { 'model.requests': { unit: 'requests', limit: 20, source: 'dsh-generation', capability: 'hard' as const },
      'model.tokens': { unit: 'tokens', limit: 10_000, source: 'dsh-generation', capability: 'stop' as const },
      ...(meterEvidence ? { 'evidence.items': { unit: 'items', limit: 20, source: 'dsh-generation', capability: 'hard' as const },
        'evidence.bytes': { unit: 'bytes', limit: 10_000, source: 'dsh-generation', capability: 'hard' as const } } : {}) },
    currentHostRuntimeDigest: () => runtimeDigest,
    authorize: (id: string) => { if (id !== (curator ? 'evo.curator' : 'rho.difficulty')) throw new Error('role denied'); },
    ...(publisher ? { publisher } : {}),
    requiredSlots: curator ? ['harness', 'skills'] : ['harness'], roles: [{ id: curator ? 'evo.curator' : 'rho.difficulty', spec: metaAgent(),
      instruction: 'Assess historical difficulty.', maxModelRequests: 1, maxTokens: 500, timeoutMs,
      inputSchema: { type: 'object' as const, required: ['roleId'], properties: {
        roleId: { type: 'string' as const, enum: [curator ? 'evo.curator' : 'rho.difficulty'] },
      }, additionalProperties: true },
      resultSchema: curator ? { type: 'object' as const, required: ['action', 'skills'], properties: {
        action: { type: 'string' as const }, skills: { type: 'array' as const, items: { type: 'any' as const } },
      }, additionalProperties: false } : { type: 'object' as const, required: ['difficulty', 'fingerprint'], properties: {
        difficulty: { type: 'number' as const }, fingerprint: { type: 'array' as const, items: { type: 'number' as const } },
      }, additionalProperties: false },
    }] };
  const adapter = createDshStructuredAdapter(options);
  const input = curator ? { roleId: 'evo.curator', skillsBindingSetRef: bindingSetRef,
    proposals: [{ action: 'NEW', lesson: 'fixture' }], batchTaskIds: ['task-a'] }
    : { roleId: 'rho.difficulty', historySummary: 'fixture only' };
  const envelope: OperationEnvelope = { operationId: sha256('role-op'), idempotencyKey: sha256('role-op'),
    campaignId: 'role-campaign', decisionIndex: 0, localKey: 'difficulty', kind: 'execution.role', input,
    inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest, bindingSetRef,
    limits: { 'model.requests': 1, 'model.tokens': 500,
      ...(meterEvidence ? { 'evidence.items': 10, 'evidence.bytes': 5_000 } : {}) } };
  return { options, adapter, envelope, calls, artifacts, sessionRoles, host, sawAbort: () => sawAbort,
    driftRuntime: () => { runtimeDigest = sha256('offline-dsh-host-v2'); } };
}

describe('S3b DSH role bridge offline protocol (fixture LLM, no external model)', () => {
  it('runs one DSH turn, seals JSON and reopens its completed operation without a second turn', async () => {
    const fixture = await setup();
    const first = await fixture.adapter.submit(fixture.envelope);
    expect(first.status).toBe('completed');
    if (first.status !== 'completed' || first.completion.outcome.kind !== 'result') throw new Error('role output missing');
    const result = first.completion.outcome.value as unknown as { structuredResult: unknown;
      structuredResultRef: { digest: string }; receiptRef: Parameters<FileArtifactStore['getJson']>[0] };
    expect(result.structuredResult).toEqual({ difficulty: 4.5, fingerprint: [0.1, 0.2] });
    expect(fixture.artifacts.getJson(result.structuredResultRef as never)).toEqual(result.structuredResult);
    expect(fixture.artifacts.getJson(result.receiptRef)).toMatchObject({ bindingUse: 'host-admission-only' });
    expect(fixture.calls).toHaveLength(1);
    expect(first.completion.receipt).toMatchObject({ source: 'dsh-generation', scope: 'operation',
      operationId: fixture.envelope.operationId,
      cumulative: { 'model.requests': 1, 'model.tokens': 42 } });
    const reopened = createDshStructuredAdapter(fixture.options);
    expect(await reopened.inspect(fixture.envelope)).toMatchObject({ status: 'completed',
      completion: { receipt: first.completion.receipt } });
    expect(fixture.calls).toHaveLength(1);
  });

  it('denies an unregistered role before creating a DSH session', async () => {
    const fixture = await setup();
    const input = { roleId: 'rho.optimizer' };
    const rejected = { ...fixture.envelope, input, inputDigest: jsonDigest(input) };
    await expect(fixture.adapter.preflight(rejected)).rejects.toThrow(/Unregistered DSH role/);
    expect(fixture.calls).toHaveLength(0);
  });

  it('rejects live host runtime drift before dispatch', async () => {
    const fixture = await setup();
    fixture.driftRuntime();
    await expect(fixture.adapter.submit(fixture.envelope)).rejects.toThrow(/runtime identity drift/);
    expect(fixture.calls).toHaveLength(0);
  });

  it('persists a zero-use prestart cancellation and rejects a delayed submit', async () => {
    const fixture = await setup();
    const cancelled = await fixture.adapter.cancel(fixture.envelope);
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status !== 'cancelled') throw new Error('role cancellation did not settle');
    expect(cancelled.receipt?.cumulative).toEqual({ 'model.requests': 0, 'model.tokens': 0 });
    await expect(fixture.adapter.submit(fixture.envelope)).rejects.toThrow(/cancelled/u);
    expect(fixture.calls).toHaveLength(0);
  });

  it('checks the complete operation envelope on restored results and rejects unsupported hard token claims', async () => {
    const fixture = await setup();
    expect((await fixture.adapter.submit(fixture.envelope)).status).toBe('completed');
    const changed = { ...fixture.envelope, bindingSetRef: fixture.options.bindings.create({ harness:
      fixture.artifacts.putJson({ schemaVersion: 1, kind: 'another-harness' }, 'harness.directory.v1') }) };
    await expect(fixture.adapter.inspect(changed)).rejects.toThrow(/identity drift/u);
    expect(() => createDshStructuredAdapter({ ...fixture.options, campaignBudget: {
      ...fixture.options.campaignBudget,
      'model.tokens': { ...fixture.options.campaignBudget['model.tokens'], capability: 'hard' as const },
    } })).toThrow(/strict hard cap/u);
  });

  it('keeps successful evidence delivery counters across a role-session registry restart', async () => {
    const fixture = await setup();
    fixture.sessionRoles.bind('offline-tool-session', 'rho.difficulty', fixture.envelope);
    fixture.sessionRoles.account('offline-tool-session', { returnedItems: 2, returnedBytes: 90, requests: 1 });
    fixture.sessionRoles.release('offline-tool-session');
    const restored = new DshRoleSessionRegistry();
    restored.configureUsageRoot(join(fixture.options.root, 'tool-usage'), ['evidence.items', 'evidence.bytes']);
    expect(restored.usage(fixture.envelope)).toEqual({ returnedItems: 2, returnedBytes: 90, requests: 1 });
  });

  it('settles persisted role-tool evidence usage together with measured model usage', async () => {
    const fixture = await setup(true);
    const physicalEnvelope = { ...fixture.envelope,
      implementationDigest: fixture.adapter.port.describe().implementationDigest };
    fixture.sessionRoles.bind('prior-tool-session', 'rho.difficulty', physicalEnvelope);
    fixture.sessionRoles.account('prior-tool-session', { returnedItems: 2, returnedBytes: 90, requests: 1 });
    fixture.sessionRoles.release('prior-tool-session');
    const result = await fixture.adapter.submit(fixture.envelope);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('role not complete');
    expect(result.completion.receipt?.cumulative).toEqual({
      'model.requests': 1, 'model.tokens': 42, 'evidence.items': 2, 'evidence.bytes': 90,
    });
    const reopened = createDshStructuredAdapter(fixture.options);
    expect((await reopened.inspect(fixture.envelope)).status).toBe('completed');
  });

  it('serializes concurrent rollout projection tool calls before persisting their deltas', async () => {
    const fixture = await setup(true);
    const session = 'concurrent-tools';
    fixture.sessionRoles.bind(session, 'rho.difficulty', fixture.envelope);
    const counters = { returnedItems: 0, returnedBytes: 0, requests: 0 };
    const usage = () => ({ ...counters });
    const first = fixture.sessionRoles.deliverRollout(session, usage, async () => {
      await Promise.resolve();
      counters.returnedItems += 1; counters.returnedBytes += 10; counters.requests++;
    });
    const second = fixture.sessionRoles.deliverRollout(session, usage, async () => {
      counters.returnedItems += 2; counters.returnedBytes += 20; counters.requests++;
    });
    await Promise.all([first, second]);
    expect(fixture.sessionRoles.usage(fixture.envelope)).toEqual({ returnedItems: 3, returnedBytes: 30, requests: 2 });
  });

  it('aborts a hung model at the role deadline and keeps uncertain billed usage unsettled', async () => {
    const fixture = await setup(false, true, 150);
    await expect(fixture.adapter.submit(fixture.envelope)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.sawAbort()).toBe(true);
    const inspected = await fixture.adapter.inspect(fixture.envelope);
    expect(inspected.status).toBe('unknown');
    expect(fixture.calls).toHaveLength(1);
  });

  it('settles a DSH stop before any model request with explicit zero usage', async () => {
    const fixture = await setup();
    vi.spyOn(fixture.host.offloading, 'pressure').mockRejectedValue(new Error('offline pressure unavailable'));
    const stopped = await fixture.adapter.submit(fixture.envelope);
    expect(stopped.status).toBe('completed');
    if (stopped.status !== 'completed') throw new Error('stopped role did not settle');
    expect(stopped.completion.outcome).toMatchObject({ kind: 'error', code: 'dsh_generation_stopped' });
    expect(stopped.completion.receipt?.cumulative).toEqual({ 'model.requests': 0, 'model.tokens': 0 });
    expect((await fixture.adapter.inspect(fixture.envelope)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(0);
  });

  it('settles malformed model JSON with measured usage and resumes without another request', async () => {
    const fixture = await setup(false, false, 20_000, '{not-json');
    const submitted = await fixture.adapter.submit(fixture.envelope);
    expect(submitted.status).toBe('completed');
    if (submitted.status !== 'completed') throw new Error('malformed output did not settle');
    expect(submitted.completion.outcome).toMatchObject({ kind: 'error', code: 'dsh_role_invalid_json', retryable: false });
    expect(submitted.completion.receipt?.cumulative).toEqual({ 'model.requests': 1, 'model.tokens': 42 });
    const reopened = createDshStructuredAdapter(fixture.options);
    expect(await reopened.inspect(fixture.envelope)).toMatchObject({ status: 'completed', completion: submitted.completion });
    expect(fixture.calls).toHaveLength(1);
  });

  it('keeps malformed output unsettled when the model omits final billed usage', async () => {
    const fixture = await setup(false, false, 20_000, '{not-json', false, false);
    const submitted = await fixture.adapter.submit(fixture.envelope);
    expect(submitted.status).toBe('running');
    expect((await fixture.adapter.inspect(fixture.envelope)).status).toBe('unknown');
    expect(fixture.calls).toHaveLength(1);
  });

  it('settles an output schema mismatch with measured usage and no repeat turn', async () => {
    const fixture = await setup(false, false, 20_000, JSON.stringify({ difficulty: 'hard', fingerprint: [0.1] }));
    const submitted = await fixture.adapter.submit(fixture.envelope);
    expect(submitted.status).toBe('completed');
    if (submitted.status !== 'completed') throw new Error('schema mismatch did not settle');
    expect(submitted.completion.outcome).toMatchObject({ kind: 'error', code: 'dsh_role_schema_mismatch', retryable: false });
    expect(submitted.completion.receipt?.cumulative).toEqual({ 'model.requests': 1, 'model.tokens': 42 });
    const reopened = createDshStructuredAdapter(fixture.options);
    expect((await reopened.inspect(fixture.envelope)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(1);
  });

  it('settles an invalid curator publication only after its known final usage', async () => {
    const fixture = await setup(false, false, 20_000, JSON.stringify({ action: 'ADD',
      skills: [{ name: 'alpha', markdown: '---\nname: alpha\ndescription: Overwrite.\n---\nNew content.' }] }), true);
    const submitted = await fixture.adapter.submit(fixture.envelope);
    expect(submitted.status).toBe('completed');
    if (submitted.status !== 'completed') throw new Error('curator rejection did not settle');
    expect(submitted.completion.outcome).toMatchObject({ kind: 'error',
      code: 'dsh_role_publisher_validation', retryable: false });
    expect(submitted.completion.receipt?.cumulative).toEqual({ 'model.requests': 1, 'model.tokens': 42 });
    const reopened = createDshStructuredAdapter(fixture.options);
    expect((await reopened.inspect(fixture.envelope)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(1);
  });

  it('does not settle an arbitrary publisher storage failure as output validation', async () => {
    const fixture = await setup(false, false, 20_000, JSON.stringify({ action: 'ADD',
      skills: [{ name: 'beta', markdown: '---\nname: beta\ndescription: New Skill.\n---\nNew content.' }] }), true);
    const putJson = fixture.artifacts.putJson.bind(fixture.artifacts);
    vi.spyOn(fixture.artifacts, 'putJson').mockImplementation((value, schemaId) => {
      if (schemaId === 'skills.library.v1') throw new Error('fixture storage failure after body seal');
      return putJson(value, schemaId);
    });
    await expect(fixture.adapter.submit(fixture.envelope)).rejects.toThrow(/storage failure/u);
    expect((await fixture.adapter.inspect(fixture.envelope)).status).toBe('unknown');
    expect(fixture.calls).toHaveLength(1);
  });
});
