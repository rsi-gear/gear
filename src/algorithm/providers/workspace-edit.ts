import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DshMetaAgentSpec } from '../../types.js'
import type { CandidateWorkspaceManager, CandidateWorkspaceRequest } from '../../candidate/workspace.js'
import { HarnessBuilder } from '../../harness/builder.js'
import { CompilerCheckError } from '../../harness/check-report.js'
import { SkillCandidateFiles } from '../../skill/files.js'
import { DshMetaAgentHost } from '../../meta/session.js'
import { DshGenerationExecution } from '../../meta/generation-execution.js'
import { MetaOffloadingStore } from '../../meta/offloading-store.js'
import { usageTokens } from '../../meta/offloading-host.js'
import { FileArtifactStore, assertDigest, durableWrite, sha256 } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { ArtifactRef, BindingSetRef, BudgetPlan, CompletionEnvelope, OperationEnvelope, ProviderInspection,
  ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { assertJson, assertSchema, canonicalJson, jsonDigest, validateSchema, type JsonSchema, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { durableCreate } from './provider-record.js'
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionReceipt, type ExecutionResult,
  type PhysicalExecutionPort } from './execution.js'
import type { EvidenceCell } from '../../search/types.js'

export type WorkspaceEditRoleDefinition = { id: string; spec: DshMetaAgentSpec; instruction: string;
  maxModelRequests: number; maxTokens: number; timeoutMs: number;
  /** A scientific model result; host physical metadata is sealed separately and cannot be overwritten. */
  resultSchema?: JsonSchema;
  /** Deterministic host restore from another sealed binding. No model turn is started. */
  restore?: { sourceBindingField: string; filesField: string } }
/** The physical editor port's public operation/structured-result shape. */
export function workspaceEditOperationSchema(side: 'input' | 'result'): JsonSchema {
  return side === 'input' ? { type: 'object', required: ['roleId', 'baseBindingSetRef'], properties: {
    roleId: { type: 'string' }, baseBindingSetRef: { type: 'any' } }, additionalProperties: true }
    : { type: 'object', required: ['schemaVersion', 'roleId', 'sessionId', 'changedPaths',
      'patchDigest', 'accessedRefs', 'workplanRead', 'commitOid', 'manifestDigest'], properties: {
      schemaVersion: { type: 'integer', enum: [1] }, roleId: { type: 'string' }, sessionId: { type: 'string' },
      changedPaths: { type: 'array', items: { type: 'string' } }, patchDigest: { type: 'string' },
      accessedRefs: { type: 'array', items: { type: 'string' } }, workplanRead: { type: 'boolean' },
      commitOid: { type: 'string' }, manifestDigest: { type: 'string' },
      modelResultRef: { type: 'any' } }, additionalProperties: true };
}
export type WorkspaceEditPortOptions = { root: string; host: DshMetaAgentHost; sessions: WorkspaceEditSessionRegistry;
  artifacts: FileArtifactStore; bindings: BindingStore; builder: HarnessBuilder;
  workspaceManager: CandidateWorkspaceManager; roles: WorkspaceEditRoleDefinition[];
  hostRuntimeDigest: string; currentHostRuntimeDigest(): string; accessPolicyDigest: string;
  campaignBudget: BudgetPlan; requiredSlots: string[];
  authorize(roleId: string, envelope: OperationEnvelope): Promise<void> | void;
  files?: SkillCandidateFiles;
  /** Host-owned, audited projection of scientific inputs; raw bindings/evidence never enter the prompt. */
  editorContextDigest?: string; editorContext?(roleId: string, envelope: OperationEnvelope): JsonValue }
export type WorkspaceEditResult = { schemaVersion: 1; roleId: string; sessionId: string;
  changedPaths: string[]; patchDigest: string; accessedRefs: string[]; workplanRead: boolean;
  commitOid: string; manifestDigest: string; modelResultRef?: ArtifactRef; [key: string]: unknown }
export type WorkspaceEditDelivery = { digest: string; workplan: { requiredDiagnosisRefs: string[]; digest: string;
  generationBudget: { deadlineAt: number } };
  dossier: { digest: string }; findings: JsonValue[]; scope?: JsonValue }
type Input = { roleId: string; baseBindingSetRef: { digest: string; schemaId: string };
  delivery?: WorkspaceEditDelivery; diagnosisEvidence?: EvidenceCell[]; [key: string]: unknown }
type EditIntent = { status: 'intent' | 'editing' | 'finalizing'; envelope: OperationEnvelope;
  sessionId: string; roleId: string; parentCommit: string; parentDigest: string;
  deadlineAt: number; prompt: string; promptDigest: string; workspaceId?: string; firstSeq?: number }
type EditDone = { status: 'completed'; envelope: OperationEnvelope; completion: CompletionEnvelope;
  checkReportRef?: ArtifactRef }
type EditCancelled = { status: 'cancelled'; envelope: OperationEnvelope; receipt?: UsageReceipt }
type EditRecord = EditIntent | EditDone | EditCancelled
const RESTORE_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const RESTORE_PROTECTED = new Set(['manifest.json', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.git'])

function restorePath(path: unknown): path is string {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(path)) return false
  const parts = path.split('/')
  return parts.length >= 2 && RESTORE_ROOTS.has(parts[0]!)
    && parts.every(part => part !== '' && part !== '.' && part !== '..' && !RESTORE_PROTECTED.has(part))
}

function inputOf(envelope: OperationEnvelope): Input {
  if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input))
    throw new Error('Workspace edit input must be an object')
  const input = envelope.input as unknown as Input
  if (typeof input.roleId !== 'string' || !input.roleId || !input.baseBindingSetRef
    || canonicalJson(input.baseBindingSetRef) !== canonicalJson(envelope.bindingSetRef))
    throw new Error('Workspace edit base binding does not match operation binding')
  return input
}

/** An editor session can only use its own operation's frozen workspace and diagnosis evidence. */
export class WorkspaceEditSessionRegistry {
  private readonly active = new Map<string, { envelope: OperationEnvelope; workspaceId: string; deadlineAt: number }>()
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }) }
  bind(sessionId: string, envelope: OperationEnvelope, workspaceId: string, deadlineAt: number): void {
    const prior = this.active.get(sessionId)
    if (prior && (canonicalJson(prior.envelope) !== canonicalJson(envelope)
      || prior.workspaceId !== workspaceId || prior.deadlineAt !== deadlineAt))
      throw new Error('Workspace editor session identity drift')
    this.active.set(sessionId, { envelope: structuredClone(envelope), workspaceId, deadlineAt })
  }
  release(sessionId: string): void { this.active.delete(sessionId) }
  require(sessionId: string): { envelope: OperationEnvelope; workspaceId: string; deadlineAt: number } {
    const value = this.active.get(sessionId)
    if (!value) throw new Error('Workspace editor session is not bound')
    return value
  }
  private path(operationId: string): string { assertDigest(operationId); return join(this.root, `${operationId}.json`) }
  access(envelope: OperationEnvelope): { workplanRead: boolean; accessedRefs: string[] } {
    const path = this.path(envelope.operationId)
    if (!existsSync(path)) return { workplanRead: false, accessedRefs: [] }
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { envelope: OperationEnvelope;
      workplanRead: boolean; accessedRefs: string[] }
    assertJson(saved)
    if (canonicalJson(saved.envelope) !== canonicalJson(envelope)
      || typeof saved.workplanRead !== 'boolean' || !Array.isArray(saved.accessedRefs)
      || saved.accessedRefs.some(value => typeof value !== 'string'))
      throw new Error('Workspace editor access record drift')
    return { workplanRead: saved.workplanRead, accessedRefs: saved.accessedRefs }
  }
  markWorkplan(sessionId: string): WorkspaceEditDelivery {
    const { envelope } = this.require(sessionId)
    const delivery = inputOf(envelope).delivery
    if (!delivery) throw new Error('No workplan was bound to this editor')
    const prior = this.access(envelope)
    durableWrite(this.path(envelope.operationId), canonicalJson({ envelope, workplanRead: true,
      accessedRefs: prior.accessedRefs }))
    return delivery
  }
  markDiagnosis(sessionId: string, ref: string): EvidenceCell {
    const { envelope } = this.require(sessionId)
    const input = inputOf(envelope)
    if (!input.delivery || !this.access(envelope).workplanRead
      || !input.delivery.workplan.requiredDiagnosisRefs.includes(ref))
      throw new Error('Diagnosis ref is not authorized by the delivered workplan')
    const cell = input.diagnosisEvidence?.find(item => item.evidenceRef === ref)
    if (!cell) throw new Error('Required diagnosis evidence is unavailable')
    const prior = this.access(envelope)
    durableWrite(this.path(envelope.operationId), canonicalJson({ envelope, workplanRead: true,
      accessedRefs: [...new Set([...prior.accessedRefs, ref])].sort() }))
    return cell
  }
}

/** One physical DSH edit owns one Git worktree, one model session and one durable operation key. */
export class DshWorkspaceEditPort implements PhysicalExecutionPort {
  private readonly manifest: ProviderManifest & { kind: 'execution.workspace-edit'; structuredResultSchema: JsonSchema }
  private readonly records: string
  private readonly generationStore: MetaOffloadingStore
  private readonly roles = new Map<string, WorkspaceEditRoleDefinition>()
  private readonly metered: string[]
  private readonly meterSource: string | undefined
  private readonly physicalConfigurationDigest: string
  constructor(readonly options: WorkspaceEditPortOptions) {
    if (canonicalJson(options.requiredSlots) !== canonicalJson(['harness']) || options.roles.length === 0)
      throw new Error('Workspace edit supports only an executed harness binding')
    if (options.builder.repositoryPath !== resolve(options.workspaceManager.options.repositoryPath)
      || options.builder.targetRoot !== options.workspaceManager.options.targetRoot)
      throw new Error('Workspace editor builder and workspace target identity mismatch')
    assertDigest(options.hostRuntimeDigest); assertDigest(options.accessPolicyDigest)
    if (!!options.editorContext !== !!options.editorContextDigest) throw new Error('Workspace editor context requires frozen host policy')
    if (options.editorContextDigest) assertDigest(options.editorContextDigest)
    if (options.currentHostRuntimeDigest() !== options.hostRuntimeDigest) throw new Error('Workspace edit host identity drift')
    for (const role of options.roles) {
      if (!role.id || this.roles.has(role.id) || role.spec.runtime.type !== 'dsh'
        || !Number.isSafeInteger(role.maxModelRequests) || role.maxModelRequests < 1
        || !Number.isSafeInteger(role.maxTokens) || role.maxTokens < 1
        || !Number.isSafeInteger(role.timeoutMs) || role.timeoutMs < 1)
        throw new Error('Invalid workspace editor role')
      if (role.resultSchema) assertSchema(role.resultSchema)
      if (role.restore && (!options.files || !role.restore.sourceBindingField || !role.restore.filesField
        || role.resultSchema)) throw new Error('Invalid deterministic workspace restore role')
      this.roles.set(role.id, structuredClone(role))
    }
    if (!options.campaignBudget['model.requests'] || !options.campaignBudget['model.tokens'])
      throw new Error('Workspace editor requires measured model request and token budgets')
    this.metered = ['model.requests', 'model.tokens']
    if (options.campaignBudget['model.tokens']?.capability === 'hard')
      throw new Error('DSH model token accounting cannot enforce a strict hard cap')
    const sources = new Set(this.metered.map(dimension => options.campaignBudget[dimension]!.source))
    if (sources.size > 1) throw new Error('Workspace edit metered dimensions need one source')
    this.meterSource = sources.values().next().value as string | undefined
    this.records = join(options.root, 'operations'); mkdirSync(this.records, { recursive: true })
    this.generationStore = new MetaOffloadingStore(join(options.root, 'generation'))
    this.physicalConfigurationDigest = jsonDigest({ builder: {
      repositoryPath: options.builder.repositoryPath, targetRoot: options.builder.targetRoot,
      dshBaseRef: options.builder.options.dshBaseRef, toolchainRef: options.builder.options.toolchainRef,
      sandboxProfileRef: options.builder.options.sandboxProfileRef }, workspace: {
      repositoryPath: options.workspaceManager.options.repositoryPath,
      targetRoot: options.workspaceManager.options.targetRoot,
      maxFiles: options.workspaceManager.options.maxFiles, maxBytes: options.workspaceManager.options.maxBytes,
      maxDiffBytes: options.workspaceManager.options.maxDiffBytes } })
    this.manifest = { kind: 'execution.workspace-edit', execution: 'external', supportsInspect: true,
      meteredDimensions: this.metered,
      hardLimitDimensions: this.metered.filter(d => options.campaignBudget[d]!.capability === 'hard'),
      implementationDigest: implementationClosureDigest(['providers/workspace-edit', 'providers/execution'], {
        hostRuntimeDigest: options.hostRuntimeDigest, accessPolicyDigest: options.accessPolicyDigest,
        editorContextDigest: options.editorContextDigest ?? null,
        physicalConfigurationDigest: this.physicalConfigurationDigest,
        requiredSlots: options.requiredSlots, roles: [...this.roles.values()], meterSource: this.meterSource ?? null,
        budgetCapabilities: this.metered.map(d => [d, options.campaignBudget[d]!.capability]) }),
      inputSchema: workspaceEditOperationSchema('input'),
      outputSchema: executionResultSchema,
      structuredResultSchema: workspaceEditOperationSchema('result') }
  }
  describe(): ProviderManifest & { kind: 'execution.workspace-edit'; structuredResultSchema: JsonSchema } {
    return structuredClone(this.manifest)
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`) }
  private read(envelope: OperationEnvelope): EditRecord | undefined {
    const path = this.path(envelope)
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as EditRecord
    assertJson(value)
    if (canonicalJson(value.envelope) !== canonicalJson(envelope)) throw new Error('Workspace edit operation identity drift')
    if (value.status !== 'completed' && value.status !== 'cancelled'
      && (!Number.isSafeInteger(value.deadlineAt) || typeof value.prompt !== 'string'
        || value.promptDigest !== jsonDigest(value.prompt) || value.roleId !== inputOf(envelope).roleId))
      throw new Error('Workspace edit frozen prompt or deadline drift')
    return value
  }
  private create(record: EditRecord): boolean { return durableCreate(this.path(record.envelope), canonicalJson(record)) }
  private role(envelope: OperationEnvelope): WorkspaceEditRoleDefinition {
    if (optionsDrift(this.options, this.manifest, envelope)
      || this.currentPhysicalConfigurationDigest() !== this.physicalConfigurationDigest)
      throw new Error('Workspace editor host/provider identity drift')
    const input = inputOf(envelope), role = this.roles.get(input.roleId)
    if (!role) throw new Error(`Unregistered workspace editor role: ${input.roleId}`)
    for (const dimension of this.metered) if (!Number.isSafeInteger(envelope.limits[dimension]) || envelope.limits[dimension]! < 0)
      throw new Error(`Workspace edit reservation ${dimension} missing`)
    return role
  }
  private async parent(envelope: OperationEnvelope): Promise<{ commitOid: string; manifestDigest: string }> {
    const slots = this.options.bindings.read(envelope.bindingSetRef).slots
    if (canonicalJson(Object.keys(slots).sort()) !== canonicalJson(['harness']))
      throw new Error('Workspace edit cannot claim non-harness bindings were executed')
    const ref = slots.harness!
    if (ref.schemaId !== 'harness.directory.v1') throw new Error('Workspace edit harness schema mismatch')
    const value = this.options.artifacts.getJson(ref) as Record<string, unknown>
    if (value.schemaVersion !== 1 || value.kind !== 'git-harness'
      || typeof value.commitOid !== 'string' || typeof value.manifestDigest !== 'string')
      throw new Error('Workspace edit harness artifact malformed')
    const actual = await this.options.builder.readManifest(value.commitOid)
    if (actual.digest !== value.manifestDigest) throw new Error('Workspace edit bound Git manifest drift')
    for (const artifact of Object.values(slots)) this.options.artifacts.getBytes(artifact)
    return { commitOid: value.commitOid, manifestDigest: value.manifestDigest }
  }
  private async restoreSource(envelope: OperationEnvelope, role: WorkspaceEditRoleDefinition): Promise<{
    commitOid: string; manifestDigest: string; files: string[] } | undefined> {
    if (!role.restore) return undefined
    const input = inputOf(envelope)
    const ref = input[role.restore.sourceBindingField] as BindingSetRef | undefined
    const files = input[role.restore.filesField]
    if (!ref || ref.kind !== 'binding-set' || !Array.isArray(files) || files.length === 0
      || files.some(path => !restorePath(path))
      || new Set(files).size !== files.length)
      throw new Error('Workspace restore source or file list is invalid')
    const sourceSlots = this.options.bindings.read(ref).slots
    if (canonicalJson(Object.keys(sourceSlots).sort()) !== canonicalJson(['harness']))
      throw new Error('Workspace restore source must contain only a sealed harness')
    const sourceHarness = sourceSlots.harness
    if (!sourceHarness || sourceHarness.schemaId !== 'harness.directory.v1')
      throw new Error('Workspace restore source has no sealed harness')
    const value = this.options.artifacts.getJson(sourceHarness) as Record<string, unknown>
    if (value.schemaVersion !== 1 || value.kind !== 'git-harness'
      || typeof value.commitOid !== 'string' || typeof value.manifestDigest !== 'string')
      throw new Error('Workspace restore source artifact malformed')
    const manifest = await this.options.builder.readManifest(value.commitOid)
    if (manifest.digest !== value.manifestDigest) throw new Error('Workspace restore source Git identity drift')
    return { commitOid: value.commitOid, manifestDigest: value.manifestDigest, files: files as string[] }
  }
  private currentPhysicalConfigurationDigest(): string {
    const { builder, workspaceManager } = this.options
    return jsonDigest({ builder: { repositoryPath: builder.repositoryPath, targetRoot: builder.targetRoot,
      dshBaseRef: builder.options.dshBaseRef, toolchainRef: builder.options.toolchainRef,
      sandboxProfileRef: builder.options.sandboxProfileRef }, workspace: {
      repositoryPath: workspaceManager.options.repositoryPath, targetRoot: workspaceManager.options.targetRoot,
      maxFiles: workspaceManager.options.maxFiles, maxBytes: workspaceManager.options.maxBytes,
      maxDiffBytes: workspaceManager.options.maxDiffBytes } })
  }
  async preflight(envelope: OperationEnvelope): Promise<void> {
    const role = this.role(envelope)
    await this.parent(envelope)
    const input = inputOf(envelope)
    await this.restoreSource(envelope, role)
    if (input.delivery) {
      if (!Array.isArray(input.delivery.workplan?.requiredDiagnosisRefs) || !Array.isArray(input.diagnosisEvidence)
        || !Number.isSafeInteger(input.delivery.workplan.generationBudget?.deadlineAt)
        || input.delivery.workplan.requiredDiagnosisRefs.some(ref => !input.diagnosisEvidence!.some(cell => cell.evidenceRef === ref)))
        throw new Error('Workspace edit workplan has unresolvable diagnosis evidence')
    }
    await this.options.authorize(role.id, envelope)
  }
  private async receipt(envelope: OperationEnvelope, agent?: Agent, firstSeq?: number): Promise<UsageReceipt | undefined> {
    if (!this.meterSource) return undefined
    const state = await this.generationStore.read(envelope.operationId)
    const requests = state?.usage.modelRequests ?? 0
    let tokens = 0, counted = 0
    if (requests > 0) {
      if (!agent || firstSeq === undefined) throw new Error('Workspace editor model usage lacks durable session evidence')
      for (const event of agent.session.events) if (event.seq >= firstSeq && event.type === 'assistant/message') {
        if (!event.data.usage) throw new Error('Workspace editor model usage is incomplete')
        tokens += usageTokens(event.data.usage); counted++
      }
      if (counted !== requests || tokens !== state!.usage.tokens) throw new Error('Workspace editor measured usage drift')
    }
    const cumulative: Record<string, number> = {}
    if (this.metered.includes('model.requests')) cumulative['model.requests'] = requests
    if (this.metered.includes('model.tokens')) cumulative['model.tokens'] = tokens
    return { source: this.meterSource, scope: 'operation', operationId: envelope.operationId,
      cursor: jsonDigest({ revision: state?.revision ?? 0, cumulative }), cumulative }
  }
  private modelResult(record: EditIntent, agent: Agent): { value: Record<string, JsonValue>; ref?: ArtifactRef } {
    const role = this.roles.get(record.roleId)!
    if (!role.resultSchema) return { value: {} }
    const messages = agent.session.events.filter(event => event.seq >= (record.firstSeq ?? 0)
      && event.type === 'assistant/message')
    const last = messages.at(-1)
    if (!last || last.type !== 'assistant/message') throw new Error('Workspace editor scientific result is missing')
    const message = agent.session.deriveEventMessage(last)
    if (!message || message.role !== 'assistant' || message.source.kind !== 'model')
      throw new Error('Workspace editor scientific result lacks model provenance')
    const texts = message.content.filter(block => block.type === 'text').map(block => block.text)
    if (texts.length !== 1 || Buffer.byteLength(texts[0]!) > 16 * 1024)
      throw new Error('Workspace editor scientific result must be one bounded JSON object')
    const parsed: unknown = JSON.parse(texts[0]!)
    assertJson(parsed); validateSchema(role.resultSchema, parsed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Workspace editor scientific result must be an object')
    const value = parsed as Record<string, JsonValue>
    const reserved = new Set(['schemaVersion', 'roleId', 'sessionId', 'changedPaths', 'patchDigest',
      'accessedRefs', 'workplanRead', 'commitOid', 'manifestDigest', 'modelResultRef'])
    if (Object.keys(value).some(key => reserved.has(key)))
      throw new Error('Workspace editor scientific result attempts to replace host evidence')
    return { value, ref: this.options.artifacts.putJson(value, 'execution.workspace-edit.model-result.v1') }
  }
  private async stopped(envelope: OperationEnvelope, record: EditIntent,
    agent: Agent): Promise<CompletionEnvelope | undefined> {
    if (record.status !== 'editing' || !record.workspaceId || record.firstSeq === undefined) return undefined
    const generation = await this.generationStore.read(envelope.operationId)
    if (generation?.status !== 'stopped') return undefined
    let usage: UsageReceipt | undefined
    try { usage = await this.receipt(envelope, agent, record.firstSeq) }
    catch { return undefined }
    const request: CandidateWorkspaceRequest = { evolutionId: this.evolution(envelope), roundId: 'edit',
      parentHarnessRef: record.parentCommit, parentHarnessDigest: record.parentDigest }
    let handle
    try { handle = this.options.workspaceManager.resolve(record.sessionId) }
    catch { try { handle = await this.options.workspaceManager.restore(record.workspaceId, request) }
      catch { return undefined } }
    if (handle.workspaceId !== record.workspaceId || handle.state !== 'open') return undefined
    const completion: CompletionEnvelope = { operationId: envelope.operationId,
      idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
      implementationDigest: this.manifest.implementationDigest,
      outcome: { kind: 'error', code: 'workspace_edit_generation_stopped',
        message: generation.failure?.slice(0, 1000) ?? 'DSH editor generation stopped', retryable: false },
      ...(usage ? { receipt: usage } : {}) }
    durableWrite(this.path(envelope), canonicalJson({ status: 'completed', envelope, completion }))
    await this.options.workspaceManager.dispose(handle.workspaceId)
    return completion
  }
  private async applyRestore(envelope: OperationEnvelope, record: EditIntent,
    role: WorkspaceEditRoleDefinition): Promise<{ sourceCommit: string; files: string[] }> {
    const source = await this.restoreSource(envelope, role)
    if (!source || !this.options.files) throw new Error('Workspace restore configuration is missing')
    const manifest = await this.options.builder.readManifest(source.commitOid)
    for (const path of source.files) {
      const expected = manifest.artifacts.some(item => item.path === path)
        ? await this.options.builder.readHarnessFile(source.commitOid, path) : undefined
      let current: Awaited<ReturnType<SkillCandidateFiles['read']>> | undefined
      try { current = await this.options.files.read(record.sessionId, path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (expected === undefined) {
        if (current) await this.options.files.remove(record.sessionId, path, current.digest)
      } else if (current?.digest !== `sha256:${sha256(expected.content)}`) {
        await this.options.files.write(record.sessionId, path, expected.content, current?.digest ?? null)
      }
    }
    return { sourceCommit: source.commitOid, files: source.files }
  }
  private async finish(envelope: OperationEnvelope, record: EditIntent, agent?: Agent): Promise<CompletionEnvelope> {
    if (!record.workspaceId) throw new Error('Workspace editor workspace identity missing')
    const manager = this.options.workspaceManager
    const request: CandidateWorkspaceRequest = { evolutionId: this.evolution(envelope), roundId: 'edit',
      parentHarnessRef: record.parentCommit, parentHarnessDigest: record.parentDigest }
    let handle
    try { handle = manager.resolve(record.sessionId) }
    catch { handle = await manager.restore(record.workspaceId, request); manager.bind(handle.workspaceId, record.sessionId) }
    if (handle.workspaceId !== record.workspaceId || handle.parentRef !== record.parentCommit)
      throw new Error('Workspace editor restored different workspace')
    const role = this.roles.get(record.roleId)!
    const restoration = role.restore ? await this.applyRestore(envelope, record, role) : undefined
    if (!restoration && !agent) throw new Error('Workspace editor model session unavailable')
    const usage = await this.receipt(envelope, agent, record.firstSeq)
    const access = this.options.sessions.access(envelope)
    const input = inputOf(envelope)
    const terminal = async (reason: string, error = false, checkReport?: JsonValue): Promise<CompletionEnvelope> => {
      const checkReportRef = checkReport === undefined ? undefined
        : this.options.artifacts.putJson(checkReport, 'execution.workspace-edit.failed-check.v1')
      const completion: CompletionEnvelope = { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: this.manifest.implementationDigest,
        outcome: error ? { kind: 'error', code: reason, message: reason, retryable: false }
          : { kind: 'no-result', reason }, ...(usage ? { receipt: usage } : {}) }
      durableWrite(this.path(envelope), canonicalJson({ status: 'completed', envelope, completion,
        ...(checkReportRef ? { checkReportRef } : {}) }))
      await manager.dispose(handle.workspaceId)
      return completion
    }
    const summary = await manager.preflight(handle.workspaceId)
    if (summary.files.length === 0) return terminal('workspace-edit-no-change')
    if (input.delivery && (!access.workplanRead || input.delivery.workplan.requiredDiagnosisRefs.some(ref => !access.accessedRefs.includes(ref))))
      return terminal('workspace_edit_workplan_not_consumed', true)
    if (Date.now() >= record.deadlineAt) return terminal('workspace-edit-deadline-exhausted')
    let science
    try { science = restoration ? { value: {} as Record<string, JsonValue> }
      : this.modelResult(record, agent!) }
    catch { return terminal('workspace_edit_invalid_scientific_result', true) }
    const signal = AbortSignal.timeout(Math.max(1, record.deadlineAt - Date.now()))
    const checkpoint = restoration
      ? { prefixDigest: jsonDigest({ operationId: envelope.operationId, restoration }) }
      : await this.options.host.checkpoint(agent!)
    let report
    try { report = await this.options.builder.checkWorkspace(handle, signal) }
    catch (error) {
      if (error instanceof CompilerCheckError) return terminal('workspace-edit-fixed-check-failed', false,
        error.report as unknown as JsonValue)
      if (signal.aborted) return terminal('workspace-edit-deadline-exhausted')
      throw error
    }
    if (!report.ok) return terminal('workspace-edit-fixed-check-failed', false, report as unknown as JsonValue)
    durableWrite(this.path(envelope), canonicalJson({ ...record, status: 'finalizing' }))
    const sealed = await manager.seal(handle.workspaceId, signal)
    if (sealed.files.length === 0) throw new Error('Workspace editor produced no changed files')
    manager.markFinalizing(handle.workspaceId)
    await manager.verifySealed(handle.workspaceId, sealed, signal)
    const prepared = await this.options.builder.finalizeWorkspace(handle, sealed, signal)
    await manager.markCommitted(handle.workspaceId)
    const producedArtifactRef = this.options.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
      commitOid: prepared.ref, manifestDigest: prepared.digest }, 'harness.directory.v1')
    const structuredResult: WorkspaceEditResult = { ...science.value, schemaVersion: 1, roleId: record.roleId,
      sessionId: record.sessionId, changedPaths: sealed.files.map(file => file.path), patchDigest: sealed.patchDigest,
      accessedRefs: access.accessedRefs, workplanRead: access.workplanRead,
      commitOid: prepared.ref, manifestDigest: prepared.digest,
      ...(restoration ? { restoredFromCommit: restoration.sourceCommit, restoredFiles: restoration.files } : {}),
      ...(science.ref ? { modelResultRef: science.ref } : {}) }
    const structuredResultRef = this.options.artifacts.putJson(structuredResult as unknown as JsonValue,
      'execution.workspace-edit.result.v1')
    const evidenceRef = this.options.artifacts.putJson({ schemaVersion: 1, sessionId: record.sessionId,
      checkpoint, workplanRead: access.workplanRead, accessedRefs: access.accessedRefs } as unknown as JsonValue,
    'execution.workspace-edit.evidence.v1')
    const slots = this.options.bindings.read(envelope.bindingSetRef).slots
    const executionReceipt: ExecutionReceipt = { schemaVersion: 1,
      providerImplementationDigest: this.manifest.implementationDigest, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: Object.fromEntries(Object.entries(slots).map(([key, ref]) => [key, ref.digest])),
      executionIdentity: checkpoint.prefixDigest, structuredResultDigest: jsonDigest(structuredResult), bindingUse: 'executed' }
    const receiptRef = this.options.artifacts.putJson(executionReceipt as unknown as JsonValue, 'execution.receipt.v1')
    const validationReceiptRef = this.options.artifacts.putJson({ schemaVersion: 1, valid: true,
      producedDigest: producedArtifactRef.digest, checkDigest: jsonDigest(report as unknown as JsonValue),
      finalizedManifestDigest: prepared.digest, patchDigest: sealed.patchDigest } as JsonValue,
    'execution.workspace-edit.validation.v1')
    const output: ExecutionResult = { requestedBindingSetDigest: envelope.bindingSetRef.digest,
      actualBindings: slots, evidenceRef, receiptRef, producedArtifactRef,
      structuredResult: structuredResult as unknown as JsonValue, structuredResultRef, validationReceiptRef }
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
      outcome: { kind: 'result', value: output as unknown as JsonValue }, ...(usage ? { receipt: usage } : {}) }
    durableWrite(this.path(envelope), canonicalJson({ status: 'completed', envelope, completion }))
    await manager.dispose(handle.workspaceId)
    return completion
  }
  private evolution(envelope: OperationEnvelope): string { return `algorithm-workspace-${envelope.operationId.slice(0, 32)}` }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    await this.preflight(envelope)
    const prior = this.read(envelope)
    if (prior?.status === 'completed') return { status: 'completed', completion: prior.completion }
    if (prior?.status === 'cancelled') throw new Error('Workspace edit was cancelled before submit')
    if (prior) return { status: 'running', handle: prior.sessionId }
    const role = this.role(envelope), parent = await this.parent(envelope), sessionId = randomUUID()
    const visible = this.options.editorContext?.(role.id, envelope) ?? { roleId: role.id }
    assertJson(visible)
    const visibleBytes = canonicalJson(visible)
    if (Buffer.byteLength(visibleBytes) > 16 * 1024)
      throw new Error('Workspace editor host projection exceeds prompt limit')
    const prompt = `${role.instruction}\nUse only the mounted workspace tools. For GEPA, call workplan_read and diagnosis_read.\n${visibleBytes}`
    const intent: EditIntent = { status: 'intent', envelope, sessionId, roleId: role.id,
      parentCommit: parent.commitOid, parentDigest: parent.manifestDigest,
      deadlineAt: Math.min(Date.now() + role.timeoutMs,
        inputOf(envelope).delivery?.workplan.generationBudget?.deadlineAt ?? Number.MAX_SAFE_INTEGER),
      prompt, promptDigest: jsonDigest(prompt) }
    if (!this.create(intent)) return this.submit(envelope)
    let handle
    try {
      handle = await this.options.workspaceManager.create({ evolutionId: this.evolution(envelope), roundId: 'edit',
        parentHarnessRef: parent.commitOid, parentHarnessDigest: parent.manifestDigest }, new AbortController().signal)
      const editing: EditIntent = { ...intent, status: 'editing', workspaceId: handle.workspaceId }
      durableWrite(this.path(envelope), canonicalJson(editing))
      this.options.workspaceManager.bind(handle.workspaceId, sessionId)
      this.options.sessions.bind(sessionId, envelope, handle.workspaceId, intent.deadlineAt)
      if (role.restore) {
        try { return { status: 'completed', completion: await this.finish(envelope, editing) } }
        finally { this.options.sessions.release(sessionId) }
      }
      const agentHandle = await this.options.host.create(sessionId, role.spec, true)
      try {
        const firstSeq = agentHandle.agent.session.events.length
        durableWrite(this.path(envelope), canonicalJson({ ...editing, firstSeq }))
        const signal = AbortSignal.timeout(Math.max(1, intent.deadlineAt - Date.now()))
        const execution = new DshGenerationExecution(this.generationStore, this.options.host.generationBudget,
          { evolutionId: this.evolution(envelope), specDigest: jsonDigest(role.spec), roundId: envelope.operationId },
          { executionId: envelope.operationId, attempt: 1, deadlineAt: intent.deadlineAt,
            signal, budget: { maxModelRequests: Math.min(role.maxModelRequests,
              envelope.limits['model.requests'] ?? role.maxModelRequests),
              maxTokens: Math.min(role.maxTokens, envelope.limits['model.tokens'] ?? role.maxTokens) },
            isComplete: () => false, snapshot: async () => ({}), activate: () => {} })
        try { await execution.run(agentHandle.agent, createUserMessage({ content: [{ type: 'text', text: intent.prompt }],
          source: { kind: 'plugin', plugin: 'gear' } }), firstSeq, () => ({ reason: 'completed' })) }
        catch (error) {
          const terminal = await this.stopped(envelope, { ...editing, firstSeq }, agentHandle.agent)
          if (terminal) return { status: 'completed', completion: terminal }
          throw error
        }
        return { status: 'completed', completion: await this.finish(envelope, { ...editing, firstSeq }, agentHandle.agent) }
      } finally { await agentHandle.dispose(); this.options.sessions.release(sessionId) }
    } catch (error) {
      if (error instanceof Error && /identity drift|binding|unregistered|schema mismatch/u.test(error.message)) throw error
      return { status: 'running', handle: sessionId }
    }
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const record = this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.status === 'completed') return { status: 'completed', completion: record.completion }
    if (record.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(record.receipt ? { receipt: record.receipt } : {}) }
    if (record.status === 'intent' || record.status === 'finalizing' || !record.workspaceId)
      return { status: 'unknown' }
    if (this.roles.get(record.roleId)?.restore) {
      try { return { status: 'completed', completion: await this.finish(envelope, record) } }
      catch { return { status: 'unknown' } }
    }
    if (record.firstSeq === undefined) return { status: 'unknown' }
    const generation = await this.generationStore.read(envelope.operationId)
    if (generation?.status === 'stopped') {
      const live = this.options.host.getLive(record.sessionId)
      if (live) {
        const completion = await this.stopped(envelope, record, live)
        return completion ? { status: 'completed', completion } : { status: 'unknown' }
      }
      let agentHandle
      try {
        const request: CandidateWorkspaceRequest = { evolutionId: this.evolution(envelope), roundId: 'edit',
          parentHarnessRef: record.parentCommit, parentHarnessDigest: record.parentDigest }
        const workspace = await this.options.workspaceManager.restore(record.workspaceId, request)
        this.options.workspaceManager.bind(workspace.workspaceId, record.sessionId)
        this.options.sessions.bind(record.sessionId, envelope, workspace.workspaceId, record.deadlineAt)
        agentHandle = await this.options.host.resume(record.sessionId, this.roles.get(record.roleId)!.spec)
        const completion = await this.stopped(envelope, record, agentHandle.agent)
        return completion ? { status: 'completed', completion } : { status: 'unknown' }
      } catch { return { status: 'unknown' } }
      finally { await agentHandle?.dispose(); this.options.sessions.release(record.sessionId) }
    }
    if (generation?.status === 'completed') {
      const role = this.roles.get(record.roleId)!
      const live = this.options.host.getLive(record.sessionId)
      if (live) return { status: 'completed', completion: await this.finish(envelope, record, live) }
      let agentHandle
      try {
        const request: CandidateWorkspaceRequest = { evolutionId: this.evolution(envelope), roundId: 'edit',
          parentHarnessRef: record.parentCommit, parentHarnessDigest: record.parentDigest }
        const workspace = await this.options.workspaceManager.restore(record.workspaceId, request)
        this.options.workspaceManager.bind(workspace.workspaceId, record.sessionId)
        this.options.sessions.bind(record.sessionId, envelope, workspace.workspaceId, record.deadlineAt)
        agentHandle = await this.options.host.resume(record.sessionId, role.spec)
        return { status: 'completed', completion: await this.finish(envelope, record, agentHandle.agent) }
      } catch { return { status: 'unknown' } }
      finally { await agentHandle?.dispose(); this.options.sessions.release(record.sessionId) }
    }
    return generation?.status === 'running' && this.options.host.getLive(record.sessionId)
      ? { status: 'running', handle: record.sessionId } : { status: 'unknown' }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const record = this.read(envelope)
    if (!record) {
      const receipt = await this.receipt(envelope)
      if (this.create({ status: 'cancelled', envelope, ...(receipt ? { receipt } : {}) }))
        return { status: 'cancelled', releaseConfirmed: true, ...(receipt ? { receipt } : {}) }
      return this.cancel(envelope)
    }
    if (record.status === 'completed') return { status: 'completed', completion: record.completion }
    if (record.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(record.receipt ? { receipt: record.receipt } : {}) }
    const live = this.options.host.getLive(record.sessionId)
    if (live) await this.options.host.cancelAndFlush(live, 'algorithm workspace edit cancelled')
    if (!this.roles.get(record.roleId)?.restore) {
      const settled = await this.inspect(envelope)
      if (settled.status === 'completed' || settled.status === 'cancelled') return settled
    }
    // A started edit can have an unobserved Git effect. Without a durable stopped
    // generation and known workspace, cancellation cannot release reservation.
    return { status: 'unknown' }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const status = await this.inspect(envelope)
    if (status.status !== 'completed') throw new Error(`Workspace edit result unavailable: ${status.status}`)
    return status.completion
  }
}

function optionsDrift(options: WorkspaceEditPortOptions, manifest: ProviderManifest, envelope: OperationEnvelope): boolean {
  return options.currentHostRuntimeDigest() !== options.hostRuntimeDigest
    || envelope.kind !== manifest.kind || envelope.implementationDigest !== manifest.implementationDigest
    || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId
}

export function createWorkspaceEditAdapter(options: WorkspaceEditPortOptions): VerifiedExecutionAdapter {
  return new VerifiedExecutionAdapter(new DshWorkspaceEditPort(options), options.artifacts, options.bindings,
    options.requiredSlots)
}
