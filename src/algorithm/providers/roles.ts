import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DshMetaAgentSpec } from '../../types.js';
import { digestJson } from '../../state/digest.js';
import { DshMetaAgentHost } from '../../meta/session.js';
import { DshGenerationExecution } from '../../meta/generation-execution.js';
import { MetaOffloadingStore } from '../../meta/offloading-store.js';
import { usageTokens } from '../../meta/offloading-host.js';
import { FileArtifactStore, assertDigest, durableWrite } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import type { ArtifactRef, BudgetPlan, CompletionEnvelope, OperationEnvelope, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js';
import { assertJson, canonicalJson, jsonDigest, validateSchema, type JsonSchema, type JsonValue } from '../schema.js';
import { implementationClosureDigest } from '../data/identity.js';
import { EvidenceService, type EvidenceQuery, type EvidenceRead } from '../data/evidence.js';
import { createRoleEvidenceTools, type EvidenceGrantResolver } from './evidence.js';
import { createRoleRolloutEvidenceTools, type RolloutEvidenceToolOptions,
  type RolloutEvidenceAuthorization, type RolloutEvidenceUsage } from './rollout-evidence.js';
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionReceipt, type ExecutionResult, type PhysicalExecutionPort } from './execution.js';

export type StructuredRoleDefinition = { id: string; spec: DshMetaAgentSpec; instruction: string;
  inputSchema: JsonSchema; resultSchema: JsonSchema; maxModelRequests: number; maxTokens: number; timeoutMs: number;
  producedSchemaId?: string };
export type RoleArtifactPublisher = { implementationDigest: string;
  /** Must be idempotent for an operationId: recovery may finish a completed DSH turn again. */
  publish(roleId: string, result: JsonValue, envelope: OperationEnvelope): Promise<ArtifactRef | undefined> };
export type DshRolePortOptions = { root: string; kind: 'execution.role' | 'execution.feedback';
  host: DshMetaAgentHost; sessionRoles: DshRoleSessionRegistry; artifacts: FileArtifactStore; bindings: BindingStore;
  roles: StructuredRoleDefinition[]; accessPolicyDigest: string; hostRuntimeDigest: string; campaignBudget: BudgetPlan;
  /** Re-read the concrete model/preset/tool host configuration before every operation. */
  currentHostRuntimeDigest(): string;
  authorize(roleId: string, envelope: OperationEnvelope): Promise<void> | void;
  publisher?: RoleArtifactPublisher; requiredSlots: string[] };

/** Session identity comes from the provider's durable intent, never from model tool arguments. */
export class DshRoleSessionRegistry {
  private readonly roles = new Map<string, string>();
  private readonly envelopes = new Map<string, OperationEnvelope>();
  private readonly toolQueues = new Map<string, Promise<void>>();
  private usageRoot?: string;
  private hardEvidenceDimensions: string[] = [];
  configureUsageRoot(root: string, hardEvidenceDimensions: string[]): void {
    if (this.usageRoot && this.usageRoot !== root) throw new Error('DSH role usage root changed');
    this.usageRoot = root;
    this.hardEvidenceDimensions = [...hardEvidenceDimensions];
    mkdirSync(root, { recursive: true });
  }
  bind(sessionId: string, roleId: string, envelope: OperationEnvelope): void {
    const previous = this.roles.get(sessionId);
    if (previous && previous !== roleId) throw new Error('DSH session role identity drift');
    const previousEnvelope = this.envelopes.get(sessionId);
    if (previousEnvelope && canonicalJson(previousEnvelope) !== canonicalJson(envelope)) throw new Error('DSH session operation identity drift');
    this.roles.set(sessionId, roleId);
    this.envelopes.set(sessionId, structuredClone(envelope));
  }
  require(sessionId: string): string {
    const role = this.roles.get(sessionId);
    if (!role) throw new Error('DSH session has no authorized role');
    return role;
  }
  envelope(sessionId: string): OperationEnvelope {
    const envelope = this.envelopes.get(sessionId);
    if (!envelope) throw new Error('DSH session has no authorized operation');
    return structuredClone(envelope);
  }
  private usagePath(envelope: OperationEnvelope): string {
    if (!this.usageRoot) throw new Error('DSH role usage store is unconfigured');
    assertDigest(envelope.operationId);
    return join(this.usageRoot, `${envelope.operationId}.json`);
  }
  usage(envelope: OperationEnvelope): RolloutEvidenceUsage {
    const path = this.usagePath(envelope);
    if (!existsSync(path)) return { returnedItems: 0, returnedBytes: 0, requests: 0 };
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { envelope: OperationEnvelope; cumulative: RolloutEvidenceUsage };
    assertJson(saved);
    if (canonicalJson(saved.envelope) !== canonicalJson(envelope)) throw new Error('DSH evidence usage identity drift');
    return saved.cumulative;
  }
  account(sessionId: string, delta: RolloutEvidenceUsage): void {
    const envelope = this.envelope(sessionId);
    const prior = this.usage(envelope);
    const next = { returnedItems: prior.returnedItems + delta.returnedItems,
      returnedBytes: prior.returnedBytes + delta.returnedBytes, requests: prior.requests + delta.requests };
    if (Object.values(next).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid DSH evidence usage');
    for (const [dimension, value] of [['evidence.items', next.returnedItems], ['evidence.bytes', next.returnedBytes]] as const) {
      if (this.hardEvidenceDimensions.includes(dimension) && value > (envelope.limits[dimension] ?? -1)) {
        throw new Error(`DSH role hard ${dimension} delivery limit exceeded`);
      }
    }
    durableWrite(this.usagePath(envelope), canonicalJson({ envelope, cumulative: next }));
  }
  /** Serialize asynchronous projection calls so before/after counters cannot overlap. */
  async deliverRollout<T>(sessionId: string, usage: () => RolloutEvidenceUsage, run: () => Promise<T>): Promise<T> {
    const prior = this.toolQueues.get(sessionId) ?? Promise.resolve();
    const task = prior.then(async () => {
      const before = usage();
      const result = await run();
      const after = usage();
      this.account(sessionId, { returnedItems: after.returnedItems - before.returnedItems,
        returnedBytes: after.returnedBytes - before.returnedBytes, requests: after.requests - before.requests });
      return result;
    });
    this.toolQueues.set(sessionId, task.then(() => {}, () => {}));
    return task;
  }
  release(sessionId: string): void {
    this.roles.delete(sessionId); this.envelopes.delete(sessionId); this.toolQueues.delete(sessionId);
  }
}

/** Mount bounded evidence tools in a DSH context whose preset and other tools the host has already restricted. */
export function createEvidenceDshRoleHost(ctx: Context, sessions: DshRoleSessionRegistry,
  evidence: EvidenceService, resolveGrant: EvidenceGrantResolver, maxEvidenceRequests = 100,
  rolloutEvidence?: RolloutEvidenceToolOptions): DshMetaAgentHost {
  if (!Number.isSafeInteger(maxEvidenceRequests) || maxEvidenceRequests < 1) throw new Error('Invalid role evidence request cap');
  return new DshMetaAgentHost(ctx, async (agentCtx, sessionId) => {
    const roleId = sessions.require(sessionId);
    const tools = createRoleEvidenceTools(evidence, resolveGrant, roleId);
    const rolloutTools = rolloutEvidence ? createRoleRolloutEvidenceTools(rolloutEvidence, sessions.envelope(sessionId)) : undefined;
    let requests = 0;
    const output = { schema: { type: 'json' as const }, render(_args: unknown, value: JsonValue) {
      return [{ type: 'text' as const, text: canonicalJson(value) }];
    } };
    const request = (input: string): unknown => {
      if (Buffer.byteLength(input) > 16 * 1024 || ++requests > maxEvidenceRequests) throw new Error('Role evidence request limit exceeded');
      return JSON.parse(input) as unknown;
    };
    agentCtx.tools.register(defineTool({ name: 'evidence_query',
      description: 'Query only the frozen, role-authorized experience view. Supply a JSON EvidenceQuery object.',
      parameters: { requestJson: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        if (String(exec.agent?.id) !== sessionId) throw new Error('Evidence tool session identity mismatch');
        const result = tools.query(request(args.requestJson) as EvidenceQuery);
        sessions.account(sessionId, result.usage);
        return result as unknown as JsonValue;
      },
    }));
    agentCtx.tools.register(defineTool({ name: 'evidence_read',
      description: 'Read one authorized frozen evidence digest; a digest alone grants no access.',
      parameters: { requestJson: { type: 'string', required: true } }, output,
      async execute(args, exec) {
        if (String(exec.agent?.id) !== sessionId) throw new Error('Evidence tool session identity mismatch');
        const result = tools.read(request(args.requestJson) as EvidenceRead);
        sessions.account(sessionId, result.usage);
        return result as unknown as JsonValue;
      },
    }));
    if (rolloutTools) {
      agentCtx.tools.register(defineTool({ name: 'rollout_evidence_query',
        description: 'Project only an explicitly named completed rollout evidence/receipt pair for this role.',
        parameters: { requestJson: { type: 'string', required: true } }, output,
        async execute(args, exec) {
          if (String(exec.agent?.id) !== sessionId) throw new Error('Rollout evidence tool session identity mismatch');
          const input = request(args.requestJson) as { authorization: RolloutEvidenceAuthorization; offset?: number; limit?: number };
          const page = await sessions.deliverRollout(sessionId, rolloutTools.usage,
            () => rolloutTools.query(input.authorization, input.offset, input.limit));
          return page as unknown as JsonValue;
        },
      }));
      agentCtx.tools.register(defineTool({ name: 'rollout_evidence_read',
        description: 'Read one projected report or trace digest from an authorized rollout pair.',
        parameters: { requestJson: { type: 'string', required: true } }, output,
        async execute(args, exec) {
          if (String(exec.agent?.id) !== sessionId) throw new Error('Rollout evidence tool session identity mismatch');
          const input = request(args.requestJson) as { authorization: RolloutEvidenceAuthorization; contentDigest: string };
          const content = await sessions.deliverRollout(sessionId, rolloutTools.usage,
            () => rolloutTools.read(input.authorization, input.contentDigest));
          return content as unknown as JsonValue;
        },
      }));
    }
  });
}

type RoleIntent = { status: 'intent'; envelope: OperationEnvelope; sessionId: string;
  roleId: string; firstSeq?: number; prompt: string };
type RoleDone = { status: 'completed'; envelope: OperationEnvelope; completion: CompletionEnvelope };
type RoleCancelled = { status: 'cancelled'; envelope: OperationEnvelope; receipt?: UsageReceipt };
type RoleRecord = RoleIntent | RoleDone | RoleCancelled;

function roleSelection(kind: DshRolePortOptions['kind'], input: JsonValue): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Structured role input must be an object');
  const id = kind === 'execution.role' ? input.roleId : input.mode;
  if (typeof id !== 'string' || !id) throw new Error('Structured role identity missing');
  return id;
}
function assistantJson(agent: Agent, firstSeq: number): JsonValue {
  const last = agent.session.events.filter(event => event.seq >= firstSeq && event.type === 'assistant/message').at(-1);
  if (!last || last.type !== 'assistant/message') throw new Error('DSH role produced no durable assistant message');
  const message = agent.session.deriveEventMessage(last);
  if (!message || message.role !== 'assistant' || message.source.kind !== 'model') throw new Error('DSH role result lacks model provenance');
  const texts = message.content.filter(block => block.type === 'text').map(block => block.text);
  if (texts.length !== 1 || Buffer.byteLength(texts[0]!) > 16 * 1024) throw new Error('DSH role result is not one bounded JSON message');
  let value: unknown;
  try { value = JSON.parse(texts[0]!); } catch { throw new Error('DSH role result is not strict JSON'); }
  assertJson(value);
  return value;
}

/** Operation-owned DSH session. A crash before durable completion is inspected, never re-prompted. */
export class DshStructuredRolePort implements PhysicalExecutionPort {
  private readonly manifest: ProviderManifest & { kind: 'execution.role' | 'execution.feedback'; structuredResultSchema: JsonSchema };
  private readonly definitions = new Map<string, StructuredRoleDefinition>();
  private readonly records: string;
  private readonly generationStore: MetaOffloadingStore;
  private readonly meteredDimensions: string[];
  private readonly meterSource: string | undefined;
  constructor(readonly options: DshRolePortOptions) {
    if (options.roles.length === 0 || options.requiredSlots.length === 0) throw new Error('DSH role catalog/bindings required');
    assertDigest(options.accessPolicyDigest);
    assertDigest(options.hostRuntimeDigest);
    if (options.currentHostRuntimeDigest() !== options.hostRuntimeDigest) throw new Error('DSH role host runtime identity drift');
    if (options.publisher) assertDigest(options.publisher.implementationDigest);
    this.meteredDimensions = ['model.requests', 'model.tokens', 'evidence.items', 'evidence.bytes']
      .filter(dimension => options.campaignBudget[dimension]);
    if (options.campaignBudget['model.tokens']?.capability === 'hard') {
      throw new Error('DSH token accounting cannot enforce a strict hard cap; use stop capability');
    }
    const sources = new Set(this.meteredDimensions.map(dimension => options.campaignBudget[dimension]!.source));
    if (sources.size > 1) throw new Error('DSH role metered dimensions need a common receipt source');
    this.meterSource = sources.values().next().value as string | undefined;
    if (this.meterSource && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(this.meterSource)) throw new Error('Invalid DSH meter source');
    for (const role of options.roles) {
      if (!role.id || this.definitions.has(role.id) || role.spec.runtime.type !== 'dsh'
        || (role.producedSchemaId !== undefined && !role.producedSchemaId)
        || !Number.isSafeInteger(role.maxModelRequests) || role.maxModelRequests <= 0
        || !Number.isSafeInteger(role.maxTokens) || role.maxTokens <= 0
        || !Number.isSafeInteger(role.timeoutMs) || role.timeoutMs <= 0) throw new Error('Invalid DSH role definition');
      this.definitions.set(role.id, structuredClone(role));
    }
    this.records = join(options.root, 'operations'); mkdirSync(this.records, { recursive: true });
    options.sessionRoles.configureUsageRoot(join(options.root, 'tool-usage'),
      ['evidence.items', 'evidence.bytes'].filter(dimension => options.campaignBudget[dimension]?.capability === 'hard'));
    this.generationStore = new MetaOffloadingStore(join(options.root, 'generation'));
    this.manifest = { kind: options.kind, execution: 'external', supportsInspect: true,
      meteredDimensions: this.meteredDimensions,
      hardLimitDimensions: this.meteredDimensions.filter(dimension => dimension !== 'model.tokens'
        && options.campaignBudget[dimension]!.capability === 'hard'),
      implementationDigest: implementationClosureDigest(['providers/roles', 'providers/execution'], {
        kind: options.kind, accessPolicyDigest: options.accessPolicyDigest,
        hostRuntimeDigest: options.hostRuntimeDigest, requiredSlots: options.requiredSlots,
        meterSource: this.meterSource ?? null, meteredDimensions: this.meteredDimensions,
        meterCapabilities: this.meteredDimensions.map(dimension => [dimension, options.campaignBudget[dimension]!.capability]),
        publisher: options.publisher?.implementationDigest ?? null,
        definitions: [...this.definitions.values()].map(role => ({ ...role, specDigest: digestJson(role.spec) })) }),
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: executionResultSchema, structuredResultSchema: { type: 'object', additionalProperties: true } };
  }
  describe(): ProviderManifest & { kind: 'execution.role' | 'execution.feedback'; structuredResultSchema: JsonSchema } {
    return structuredClone(this.manifest);
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`); }
  private read(envelope: OperationEnvelope): RoleRecord | undefined {
    const path = this.path(envelope);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as RoleRecord;
    assertJson(value);
    if (canonicalJson(value.envelope) !== canonicalJson(envelope))
      throw new Error('DSH role operation identity drift');
    return value;
  }
  private establish(record: RoleRecord): boolean {
    const path = this.path(record.envelope), temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, canonicalJson(record)); fsyncSync(fd); } finally { closeSync(fd); }
    let created = false;
    try { linkSync(temporary, path); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    const directory = openSync(this.records, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    return created;
  }
  private definition(envelope: OperationEnvelope): StructuredRoleDefinition {
    if (this.options.currentHostRuntimeDigest() !== this.options.hostRuntimeDigest) throw new Error('DSH role host runtime identity drift');
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest)
      throw new Error('DSH role provider identity drift');
    const id = roleSelection(this.options.kind, envelope.input);
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unregistered DSH role: ${id}`);
    validateSchema(definition.inputSchema, envelope.input);
    for (const dimension of this.meteredDimensions) {
      if (!Number.isSafeInteger(envelope.limits[dimension]) || envelope.limits[dimension]! < 0) {
        throw new Error(`DSH role reservation ${dimension} missing or invalid`);
      }
    }
    const bound = this.options.bindings.read(envelope.bindingSetRef);
    for (const slot of this.options.requiredSlots) if (!bound.slots[slot]) throw new Error(`DSH role binding ${slot} missing`);
    for (const [slot, ref] of Object.entries(bound.slots)) {
      // Local admission verifies each immutable artifact without sending its
      // content or metadata to the model destination.
      this.options.artifacts.getBytes(ref);
      if (slot === 'model') {
        if (ref.schemaId !== 'model.config.v1') throw new Error('DSH role model binding schema mismatch');
        const value = this.options.artifacts.getJson(ref) as { provider?: unknown; model?: unknown };
        if (value.provider !== definition.spec.model.provider || value.model !== definition.spec.model.model) {
          throw new Error('DSH role model binding differs from host-configured model');
        }
      }
    }
    return definition;
  }
  async preflight(envelope: OperationEnvelope): Promise<void> {
    const role = this.definition(envelope);
    await this.options.authorize(role.id, envelope);
  }
  private async usageReceipt(envelope: OperationEnvelope, agent?: Agent, firstSeq?: number): Promise<UsageReceipt | undefined> {
    if (!this.meterSource) return undefined;
    const state = await this.generationStore.read(envelope.operationId);
    const requests = state?.usage.modelRequests ?? 0;
    const tokens = state?.usage.tokens ?? 0;
    const cumulative: Record<string, number> = {};
    if (this.meteredDimensions.includes('model.requests')) cumulative['model.requests'] = requests;
    if (this.meteredDimensions.includes('model.tokens')) {
      if (requests > 0) {
        if (!agent || firstSeq === undefined) throw new Error('DSH token usage has no recoverable session evidence');
        let measured = 0, actual = 0;
        for (const event of agent.session.events) {
          if (event.seq < firstSeq || event.type !== 'assistant/message') continue;
          if (!event.data.usage) throw new Error('DSH token usage is incomplete; cannot settle Campaign spending');
          measured++;
          actual += usageTokens(event.data.usage);
        }
        if (measured !== requests) throw new Error('DSH token usage is incomplete; cannot settle Campaign spending');
        if (actual !== tokens) throw new Error('DSH token usage disagrees with durable generation state');
      }
      cumulative['model.tokens'] = tokens;
    }
    const evidence = this.options.sessionRoles.usage(envelope);
    if (this.meteredDimensions.includes('evidence.items')) cumulative['evidence.items'] = evidence.returnedItems;
    if (this.meteredDimensions.includes('evidence.bytes')) cumulative['evidence.bytes'] = evidence.returnedBytes;
    return { source: this.meterSource, scope: 'operation', operationId: envelope.operationId,
      cursor: jsonDigest({ operationId: envelope.operationId, revision: state?.revision ?? 0, cumulative }), cumulative };
  }
  private async finish(envelope: OperationEnvelope, intent: RoleIntent, agent: Agent): Promise<CompletionEnvelope> {
    const role = this.definitions.get(intent.roleId)!;
    const checkpoint = await this.options.host.checkpoint(agent);
    const result = assistantJson(agent, intent.firstSeq ?? 0);
    validateSchema(role.resultSchema, result);
    const structuredResultRef = this.options.artifacts.putJson(result, 'execution.structured-result.v1');
    const producedArtifactRef = await this.options.publisher?.publish(role.id, result, envelope);
    if (role.producedSchemaId && producedArtifactRef?.schemaId !== role.producedSchemaId) {
      throw new Error(`DSH role ${role.id} did not publish ${role.producedSchemaId}`);
    }
    if (producedArtifactRef) this.options.artifacts.getBytes(producedArtifactRef);
    const evidenceRef = this.options.artifacts.putJson({ schemaVersion: 1, kind: 'dsh-role-evidence',
      roleId: role.id, sessionId: intent.sessionId, checkpoint, bindingUse: 'host-admission-only' } as unknown as JsonValue,
    'execution.role.evidence.v1');
    const slots = this.options.bindings.read(envelope.bindingSetRef).slots;
    const receipt: ExecutionReceipt = { schemaVersion: 1, providerImplementationDigest: this.manifest.implementationDigest,
      operationId: envelope.operationId, inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: Object.fromEntries(Object.entries(slots).map(([name, ref]) => [name, ref.digest])),
      executionIdentity: checkpoint.prefixDigest, structuredResultDigest: jsonDigest(result), bindingUse: 'host-admission-only' };
    const receiptRef = this.options.artifacts.putJson(receipt as unknown as JsonValue, 'execution.receipt.v1');
    const output: ExecutionResult = { requestedBindingSetDigest: envelope.bindingSetRef.digest, actualBindings: slots,
      evidenceRef, receiptRef, structuredResult: result, structuredResultRef,
      ...(producedArtifactRef ? { producedArtifactRef } : {}) };
    const usage = await this.usageReceipt(envelope, agent, intent.firstSeq);
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
      outcome: { kind: 'result', value: output as unknown as JsonValue }, ...(usage ? { receipt: usage } : {}) };
    durableWrite(this.path(envelope), canonicalJson({ status: 'completed', envelope, completion }));
    return completion;
  }
  private async stopped(envelope: OperationEnvelope, intent: RoleIntent, agent?: Agent): Promise<CompletionEnvelope | undefined> {
    const state = await this.generationStore.read(envelope.operationId);
    if (state?.status !== 'stopped') return undefined;
    let usage: UsageReceipt | undefined;
    try { usage = await this.usageReceipt(envelope, agent, intent.firstSeq); }
    catch { return undefined; } // A reserved request without measured final usage cannot release or settle.
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
      outcome: { kind: 'error', code: 'dsh_generation_stopped',
        message: state.failure?.slice(0, 1_000) ?? 'DSH generation stopped', retryable: false },
      ...(usage ? { receipt: usage } : {}) };
    durableWrite(this.path(envelope), canonicalJson({ status: 'completed', envelope, completion }));
    return completion;
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    await this.preflight(envelope);
    const prior = this.read(envelope);
    if (prior?.status === 'completed') return { status: 'completed', completion: prior.completion };
    if (prior?.status === 'cancelled') throw new Error('DSH role operation was cancelled');
    if (prior) return { status: 'running', handle: prior.sessionId };
    const role = this.definition(envelope);
    const sessionId = randomUUID();
    const prompt = `${role.instruction}\nReturn exactly one JSON object matching the declared schema.\n${canonicalJson({ roleId: role.id, input: envelope.input })}`;
    const intent: RoleIntent = { status: 'intent', envelope, sessionId, roleId: role.id, prompt };
    const path = this.path(envelope);
    if (!this.establish(intent)) return this.submit(envelope);
    this.options.sessionRoles.bind(sessionId, role.id, envelope);
    let handle: Awaited<ReturnType<DshMetaAgentHost['create']>> | undefined;
    try {
      handle = await this.options.host.create(sessionId, role.spec);
      const firstSeq = handle.agent.session.events.length;
      durableWrite(path, canonicalJson({ ...intent, firstSeq }));
      const timeoutSignal = AbortSignal.timeout(role.timeoutMs);
      const execution = new DshGenerationExecution(this.generationStore, this.options.host.generationBudget,
        { evolutionId: `algorithm-${envelope.campaignId}`, specDigest: digestJson(role.spec), roundId: envelope.operationId },
        { executionId: envelope.operationId, attempt: 1, deadlineAt: Date.now() + role.timeoutMs,
          signal: timeoutSignal, budget: {
            maxModelRequests: Math.min(role.maxModelRequests, envelope.limits['model.requests'] ?? role.maxModelRequests),
            maxTokens: Math.min(role.maxTokens, envelope.limits['model.tokens'] ?? role.maxTokens) },
          isComplete: () => false, snapshot: async () => ({}), activate: () => {} });
      try {
        await execution.run(handle.agent, createUserMessage({ content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'gear' } }), firstSeq, () => ({ reason: 'completed' }));
      } catch (error) {
        if (timeoutSignal.aborted) await this.options.host.cancelAndFlush(handle.agent, 'algorithm role deadline');
        const terminal = await this.stopped(envelope, { ...intent, firstSeq }, handle.agent);
        if (terminal) return { status: 'completed', completion: terminal };
        throw error;
      }
      return { status: 'completed', completion: await this.finish(envelope, { ...intent, firstSeq }, handle.agent) };
    } finally { await handle?.dispose(); this.options.sessionRoles.release(sessionId); }
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope);
    const record = this.read(envelope);
    if (!record) return { status: 'not-started' };
    if (record.status === 'completed') return { status: 'completed', completion: record.completion };
    if (record.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(record.receipt ? { receipt: record.receipt } : {}) };
    const execution = await this.generationStore.read(envelope.operationId);
    if (execution?.status === 'stopped') {
      const live = this.options.host.getLive(record.sessionId);
      if (live) {
        const completion = await this.stopped(envelope, record, live);
        if (completion) return { status: 'completed', completion };
      }
      const role = this.definitions.get(record.roleId)!;
      this.options.sessionRoles.bind(record.sessionId, role.id, envelope);
      let handle: Awaited<ReturnType<DshMetaAgentHost['resume']>> | undefined;
      try {
        handle = await this.options.host.resume(record.sessionId, role.spec);
        const completion = await this.stopped(envelope, record, handle.agent);
        if (completion) return { status: 'completed', completion };
      } catch { return { status: 'unknown' }; }
      finally { await handle?.dispose(); this.options.sessionRoles.release(record.sessionId); }
    }
    if (execution?.status === 'completed') {
      const role = this.definitions.get(record.roleId)!;
      const live = this.options.host.getLive(record.sessionId);
      if (live) return { status: 'completed', completion: await this.finish(envelope, record, live) };
      this.options.sessionRoles.bind(record.sessionId, role.id, envelope);
      let handle: Awaited<ReturnType<DshMetaAgentHost['resume']>> | undefined;
      try {
        handle = await this.options.host.resume(record.sessionId, role.spec);
        return { status: 'completed', completion: await this.finish(envelope, record, handle.agent) };
      } finally { await handle?.dispose(); this.options.sessionRoles.release(record.sessionId); }
    }
    return execution?.status === 'running' && this.options.host.getLive(record.sessionId)
      ? { status: 'running', handle: record.sessionId } : { status: 'unknown' };
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const status = await this.inspect(envelope);
    if (status.status === 'completed') return status;
    if (status.status === 'cancelled') return status;
    if (status.status === 'not-started') {
      const receipt = await this.usageReceipt(envelope);
      const tombstone: RoleCancelled = { status: 'cancelled', envelope, ...(receipt ? { receipt } : {}) };
      if (this.establish(tombstone)) return { status: 'cancelled', releaseConfirmed: true,
        ...(receipt ? { receipt } : {}) };
      return this.cancel(envelope);
    }
    const record = this.read(envelope);
    if (!record || record.status !== 'intent') return { status: 'unknown' };
    const live = this.options.host.getLive(record.sessionId);
    if (live) {
      await this.options.host.cancelAndFlush(live, 'algorithm role cancelled');
      const settled = await this.generationStore.read(envelope.operationId);
      if (settled?.status !== 'stopped') return { status: 'unknown' };
    } else if (!await this.options.host.isSessionAbsent(record.sessionId)) return { status: 'unknown' };
    const current = this.read(envelope);
    if (current?.status === 'completed') return { status: 'completed', completion: current.completion };
    let receipt: UsageReceipt | undefined;
    try { receipt = await this.usageReceipt(envelope, live, record.firstSeq); }
    catch { return { status: 'unknown' }; }
    durableWrite(this.path(envelope), canonicalJson({ status: 'cancelled', envelope, ...(receipt ? { receipt } : {}) }));
    return { status: 'cancelled', releaseConfirmed: true, ...(receipt ? { receipt } : {}) };
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const inspected = await this.inspect(envelope);
    if (inspected.status !== 'completed') throw new Error('DSH role result unavailable');
    return inspected.completion;
  }
}

export function createDshStructuredAdapter(options: DshRolePortOptions): VerifiedExecutionAdapter {
  return new VerifiedExecutionAdapter(new DshStructuredRolePort(options), options.artifacts, options.bindings, options.requiredSlots);
}
