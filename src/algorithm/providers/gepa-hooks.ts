import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore, assertDigest, durableWrite } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { BindingSetRef, CompletionEnvelope, OperationEnvelope } from '../contracts.js'
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { durableCreate } from './provider-record.js'
import { VerifiedExecutionAdapter, type ExecutionResult } from './execution.js'
import { HarnessBuilder } from '../../harness/builder.js'
import { consumptionReceipt, validateReceipt } from '../../search/diagnosis.js'
import { seal, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import type { GeneratedCandidate, SearchExecutionHooks } from '../../search/runtime.js'
import type { CandidateWorkPlan, EvidenceCell, Snapshot } from '../../search/types.js'
import { isExactGitCommit } from '../../types.js'

type GenerationInput = Parameters<SearchExecutionHooks['generate']>[0]
type PhysicalRecord = { schemaVersion: 1; key: string; requestDigest: string; implementationDigest: string;
  stage: 'intent' | 'complete' | 'error'; envelope: OperationEnvelope; parent: Snapshot;
  result?: GeneratedCandidate; error?: { code: string; message: string; usage: { tokens: number; requests: number } } }
export type PhysicalGepaHooksOptions = { root: string; artifacts: FileArtifactStore; bindings: BindingStore;
  builder: HarnessBuilder; editor: VerifiedExecutionAdapter; campaignId: string;
  roleId: string; snapshotBindings: Record<string, BindingSetRef>; expectedMeterSource: string;
  hostIdentityDigest: string }

/** A completed physical execution error carries measured usage; it is never a scientific no-candidate. */
export class GepaPhysicalExecutionError extends Error {
  constructor(readonly code: string, readonly usage: { tokens: number; requests: number }, message: string) {
    super(message); this.name = 'GepaPhysicalExecutionError'
  }
}
export class GepaPhysicalPending extends Error {
  constructor() { super('GEPA physical generation pending'); this.name = 'GepaPhysicalPending' }
}
class GepaPhysicalNotStarted extends Error {
  constructor() { super('GEPA inner workspace edit has not started') }
}
export type PhysicalGenerationInspection =
  | { status: 'complete'; result: GeneratedCandidate }
  | { status: 'error'; code: string; message: string; usage: { tokens: number; requests: number } }
  | { status: 'not-started' }
  | { status: 'unknown' }
export interface PhysicalGenerationInspectionHook extends SearchExecutionHooks {
  inspectGenerationOutcome(key: string): Promise<PhysicalGenerationInspection>
  cancelGenerationOutcome(input: GenerationInput): Promise<PhysicalGenerationInspection>
}
export function hasPhysicalGenerationInspection(hooks: SearchExecutionHooks): hooks is PhysicalGenerationInspectionHook {
  const physical = hooks as Partial<PhysicalGenerationInspectionHook>
  return typeof physical.inspectGenerationOutcome === 'function'
    && typeof physical.cancelGenerationOutcome === 'function'
}

function requiredBudget(plan: CandidateWorkPlan): { tokens: number; requests: number } | undefined {
  const tokens = plan.generationBudget.maxTokens, requests = plan.generationBudget.maxModelRequests
  return Number.isSafeInteger(tokens) && tokens! > 0 && Number.isSafeInteger(requests) && requests! > 0
    ? { tokens: tokens!, requests: requests! } : undefined
}

/** Adapts one operation-owned DSH/Git workspace edit to the old generation result contract. */
export class PhysicalGepaHooks implements PhysicalGenerationInspectionHook {
  readonly implementationDigest: string
  private readonly records: string
  private readonly frozenBindings: Record<string, BindingSetRef>
  private readonly editorDigest: string
  constructor(readonly options: PhysicalGepaHooksOptions) {
    assertDigest(options.hostIdentityDigest)
    if (options.editor.describe().kind !== 'execution.workspace-edit')
      throw new Error('GEPA physical hook requires workspace-edit operation')
    this.editorDigest = options.editor.describe().implementationDigest
    this.frozenBindings = structuredClone(options.snapshotBindings)
    this.records = join(options.root, 'operations'); mkdirSync(this.records, { recursive: true })
    this.implementationDigest = implementationClosureDigest(['providers/gepa-hooks', 'providers/workspace-edit'], {
      editorDigest: this.editorDigest, hostIdentityDigest: options.hostIdentityDigest,
      campaignId: options.campaignId, roleId: options.roleId,
      snapshotBindings: this.frozenBindings, meterSource: options.expectedMeterSource,
      repositoryPath: options.builder.repositoryPath, targetRoot: options.builder.targetRoot })
  }
  private path(key: string): string { assertDigest(key); return join(this.records, `${key}.json`) }
  private read(key: string): PhysicalRecord | undefined {
    const path = this.path(key)
    if (!existsSync(path)) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as PhysicalRecord
    assertJson(record)
    if (record.schemaVersion !== 1 || record.key !== key || record.implementationDigest !== this.implementationDigest
      || record.requestDigest !== jsonDigest({ parent: record.parent, envelope: record.envelope })
      || record.envelope.operationId !== key || record.envelope.idempotencyKey !== key
      || record.envelope.implementationDigest !== this.editorDigest
      || !['intent', 'complete', 'error'].includes(record.stage)
      || record.stage === 'complete' && !record.result
      || record.stage === 'error' && (!record.error || typeof record.error.code !== 'string'
        || typeof record.error.message !== 'string'
        || !Number.isSafeInteger(record.error.usage?.tokens) || record.error.usage.tokens < 0
        || !Number.isSafeInteger(record.error.usage?.requests) || record.error.usage.requests < 0))
      throw new Error('GEPA physical hook record identity drift')
    if (record.stage === 'complete') verifyDigest(record.result!)
    return record
  }
  async verifySnapshot(snapshot: Snapshot): Promise<void> {
    validateSnapshot(snapshot)
    const physical = await this.options.builder.searchSnapshot(snapshot.candidateId, snapshot.commit, snapshot.parentIds)
    if (physical.commit !== snapshot.commit || physical.tree !== snapshot.tree
      || physical.manifestDigest !== snapshot.manifestDigest)
      throw new Error('GEPA Git snapshot differs from sealed physical revision')
  }
  private binding(parent: Snapshot): BindingSetRef {
    const ref = this.frozenBindings[parent.digest]
    if (!ref) throw new Error('GEPA parent has no frozen workspace binding')
    const harnessRef = this.options.bindings.read(ref).slots.harness
    if (!harnessRef || harnessRef.schemaId !== 'harness.directory.v1')
      throw new Error('GEPA parent has no bound Git harness')
    const harness = this.options.artifacts.getJson(harnessRef) as Record<string, unknown>
    if (harness.commitOid !== parent.commit || harness.manifestDigest !== parent.manifestDigest)
      throw new Error('GEPA bound parent differs from verified Git snapshot')
    return ref
  }
  private async prepare(input: GenerationInput): Promise<PhysicalRecord> {
    const { delivery, parent, baseline, idempotencyKey } = input
    assertDigest(idempotencyKey); await this.verifySnapshot(parent)
    if (this.options.editor.describe().implementationDigest !== this.editorDigest)
      throw new Error('GEPA physical editor identity drift')
    verifyDigest(delivery); verifyDigest(delivery.workplan)
    if (!Number.isSafeInteger(delivery.workplan.generationBudget.deadlineAt))
      throw new Error('GEPA physical workplan deadline invalid')
    if (delivery.workplan.parentSnapshotDigest !== parent.digest || baseline.snapshotDigest !== parent.digest)
      throw new Error('GEPA physical workplan parent/baseline mismatch')
    const bindingSetRef = this.binding(parent)
    const required = new Set(delivery.workplan.requiredDiagnosisRefs)
    const diagnosisEvidence: EvidenceCell[] = baseline.cells.filter(cell => required.has(cell.evidenceRef))
    if ([...required].some(ref => !diagnosisEvidence.some(cell => cell.evidenceRef === ref)))
      throw new Error('GEPA physical diagnosis evidence is not in the verified baseline')
    const budget = requiredBudget(delivery.workplan)
    const innerInput = { roleId: this.options.roleId, baseBindingSetRef: bindingSetRef, delivery,
      diagnosisEvidence } as unknown as JsonValue
    const envelope: OperationEnvelope = { operationId: idempotencyKey, idempotencyKey,
      campaignId: this.options.campaignId, decisionIndex: 0, localKey: 'gepa-generate',
      kind: 'execution.workspace-edit', input: innerInput, inputDigest: jsonDigest(innerInput),
      implementationDigest: this.editorDigest, bindingSetRef,
      limits: { 'model.requests': budget?.requests ?? 0, 'model.tokens': budget?.tokens ?? 0 } }
    return { schemaVersion: 1, key: idempotencyKey, implementationDigest: this.implementationDigest,
      requestDigest: jsonDigest({ parent, envelope }), stage: 'intent', envelope, parent }
  }
  private fail(record: PhysicalRecord, usage: { tokens: number; requests: number },
    code: string, message: string): never {
    const error = { code, message, usage }
    durableWrite(this.path(record.key), canonicalJson({ ...record, stage: 'error', error }))
    throw new GepaPhysicalExecutionError(code, usage, message)
  }
  private usage(record: PhysicalRecord, completion: CompletionEnvelope): { tokens: number; requests: number } {
    const receipt = completion.receipt
    if (!receipt || receipt.source !== this.options.expectedMeterSource || receipt.scope !== 'operation'
      || receipt.operationId !== record.key || !Number.isSafeInteger(receipt.cumulative['model.tokens'])
      || receipt.cumulative['model.tokens']! < 0 || !Number.isSafeInteger(receipt.cumulative['model.requests'])
      || receipt.cumulative['model.requests']! < 0)
      throw new Error('GEPA workspace edit lacks final measured model usage')
    return { tokens: receipt.cumulative['model.tokens']!, requests: receipt.cumulative['model.requests']! }
  }
  private async settle(record: PhysicalRecord, completion: CompletionEnvelope): Promise<GeneratedCandidate> {
    if (completion.operationId !== record.key || completion.idempotencyKey !== record.key
      || completion.inputDigest !== record.envelope.inputDigest
      || completion.implementationDigest !== this.editorDigest)
      throw new Error('GEPA workspace edit completion identity drift')
    const usage = this.usage(record, completion)
    if (completion.outcome.kind === 'error') {
      return this.fail(record, usage, completion.outcome.code, completion.outcome.message)
    }
    if (completion.outcome.kind === 'cancelled') {
      return this.fail(record, usage, 'workspace_edit_cancelled', completion.outcome.reason ?? 'Workspace edit cancelled')
    }
    if (completion.outcome.kind === 'no-result' || completion.outcome.kind === 'inconclusive') {
      const result: GeneratedCandidate = seal({ changedPaths: [],
        reason: completion.outcome.reason ?? 'workspace-edit-no-candidate', usage })
      durableWrite(this.path(record.key), canonicalJson({ ...record, stage: 'complete', result }))
      return result
    }
    const value = completion.outcome.value as unknown as ExecutionResult
    if (!value.producedArtifactRef || !value.structuredResultRef || !value.validationReceiptRef)
      return this.fail(record, usage, 'gepa_candidate_proof_missing', 'Workspace edit produced no checked Git candidate')
    const harnessValue = this.options.artifacts.getJson(value.producedArtifactRef)
    const reportValue = this.options.artifacts.getJson(value.structuredResultRef)
    const harness = harnessValue as Record<string, unknown>, report = reportValue as Record<string, unknown>
    if (!harnessValue || typeof harnessValue !== 'object' || Array.isArray(harnessValue)
      || !reportValue || typeof reportValue !== 'object' || Array.isArray(reportValue)
      || harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
      || typeof harness.commitOid !== 'string' || !isExactGitCommit(harness.commitOid)
      || typeof harness.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(harness.manifestDigest)
      || report.commitOid !== harness.commitOid || report.manifestDigest !== harness.manifestDigest
      || typeof report.sessionId !== 'string' || report.sessionId.length === 0 || report.workplanRead !== true
      || !Array.isArray(report.accessedRefs) || report.accessedRefs.some(ref => typeof ref !== 'string')
      || !Array.isArray(report.changedPaths) || report.changedPaths.some(path => typeof path !== 'string'))
      return this.fail(record, usage, 'gepa_candidate_proof_invalid', 'Workspace edit report/Git identity mismatch')
    const delivery = (record.envelope.input as unknown as { delivery: GenerationInput['delivery'] }).delivery
    let receipt
    try {
      receipt = consumptionReceipt(delivery, report.sessionId, report.accessedRefs as string[])
      validateReceipt(receipt, delivery, report.sessionId)
    } catch {
      return this.fail(record, usage, 'gepa_consumption_proof_invalid',
        'Assigned workplan or diagnosis evidence was not consumed')
    }
    const snapshot = await this.options.builder.searchSnapshot(delivery.workplan.candidateId,
      harness.commitOid as string, [record.parent.candidateId])
    const result: GeneratedCandidate = seal({ snapshot, changedPaths: report.changedPaths as string[],
      receipt, sessionId: report.sessionId, usage })
    durableWrite(this.path(record.key), canonicalJson({ ...record, stage: 'complete', result }))
    return result
  }
  private unsubmittedBudgetExpired(record: PhysicalRecord): boolean {
    const delivery = (record.envelope.input as unknown as { delivery: GenerationInput['delivery'] }).delivery
    return !requiredBudget(delivery.workplan)
      || Date.now() >= delivery.workplan.generationBudget.deadlineAt
  }
  private noCandidate(record: PhysicalRecord): GeneratedCandidate {
    const result: GeneratedCandidate = seal({ changedPaths: [], reason: 'generation-budget-unbounded-or-exhausted',
      usage: { tokens: 0, requests: 0 } })
    durableWrite(this.path(record.key), canonicalJson({ ...record, stage: 'complete', result }))
    return result
  }
  private async observed(record: PhysicalRecord, allowStart: boolean): Promise<GeneratedCandidate> {
    if (record.stage === 'complete') return record.result!
    if (record.stage === 'error') throw new GepaPhysicalExecutionError(record.error!.code,
      record.error!.usage, record.error!.message)
    const status = await this.options.editor.inspect(record.envelope)
    if (status.status === 'completed') return this.settle(record, status.completion)
    if (status.status === 'cancelled' && status.releaseConfirmed && status.receipt) {
      return this.settle(record, { operationId: record.key, idempotencyKey: record.key,
        inputDigest: record.envelope.inputDigest, implementationDigest: this.editorDigest,
        outcome: { kind: 'cancelled', reason: 'Inner workspace edit cancelled' }, receipt: status.receipt })
    }
    // The physical editor's durable not-started observation proves no intent was
    // admitted there. A crash after this bridge's intent can safely submit the
    // same key; unknown/running effects are never submitted again.
    if (status.status === 'not-started' && allowStart) {
      if (this.unsubmittedBudgetExpired(record)) return this.noCandidate(record)
      const submitted = await this.options.editor.submit(record.envelope)
      if (submitted.status === 'completed') return this.settle(record, submitted.completion)
    }
    if (status.status === 'not-started') throw new GepaPhysicalNotStarted()
    throw new GepaPhysicalPending()
  }
  async generate(input: GenerationInput): Promise<GeneratedCandidate> {
    const intent = await this.prepare(input)
    const created = durableCreate(this.path(intent.key), canonicalJson(intent))
    if (!created) {
      const prior = this.read(intent.key)!
      if (prior.requestDigest !== intent.requestDigest) throw new Error('GEPA generation same-key input drift')
      return this.observed(prior, true)
    }
    if (this.unsubmittedBudgetExpired(intent)) return this.noCandidate(intent)
    const status = await this.options.editor.submit(intent.envelope)
    if (status.status === 'completed') return this.settle(intent, status.completion)
    throw new GepaPhysicalPending()
  }
  async inspectGenerationOutcome(key: string): Promise<PhysicalGenerationInspection> {
    const record = this.read(key)
    // The bridge journal is written before any editor call. Its absence is an
    // authoritative no-effect observation and lets the outer kernel retry submit.
    if (!record) return { status: 'not-started' }
    try { return { status: 'complete', result: await this.observed(record, false) } }
    catch (error) {
      if (error instanceof GepaPhysicalNotStarted) return { status: 'not-started' }
      if (error instanceof GepaPhysicalPending) return { status: 'unknown' }
      if (error instanceof GepaPhysicalExecutionError) return { status: 'error', code: error.code,
        message: error.message, usage: error.usage }
      throw error
    }
  }
  async inspectGeneration(key: string): Promise<{ status: 'complete'; result: GeneratedCandidate }
    | { status: 'unknown' }> {
    const observed = await this.inspectGenerationOutcome(key)
    if (observed.status === 'error') throw new GepaPhysicalExecutionError(observed.code, observed.usage, observed.message)
    return observed.status === 'not-started' ? { status: 'unknown' } : observed
  }
  async cancelGenerationOutcome(input: GenerationInput): Promise<PhysicalGenerationInspection> {
    const intent = await this.prepare(input)
    durableCreate(this.path(intent.key), canonicalJson(intent))
    const record = this.read(intent.key)!
    if (record.requestDigest !== intent.requestDigest) throw new Error('GEPA generation same-key input drift')
    if (record.stage !== 'intent') return this.inspectGenerationOutcome(intent.key)
    const cancelled = await this.options.editor.cancel(record.envelope)
    if (cancelled.status === 'completed') {
      try { return { status: 'complete', result: await this.settle(record, cancelled.completion) } }
      catch (error) {
        if (error instanceof GepaPhysicalExecutionError) return { status: 'error', code: error.code,
          message: error.message, usage: error.usage }
        throw error
      }
    }
    if (cancelled.status === 'cancelled' && cancelled.releaseConfirmed && cancelled.receipt) {
      try {
        await this.settle(record, { operationId: record.key, idempotencyKey: record.key,
          inputDigest: record.envelope.inputDigest, implementationDigest: this.editorDigest,
          outcome: { kind: 'cancelled', reason: 'Inner workspace edit cancelled' }, receipt: cancelled.receipt })
      } catch (error) {
        if (error instanceof GepaPhysicalExecutionError) return { status: 'error', code: error.code,
          message: error.message, usage: error.usage }
        throw error
      }
    }
    return { status: 'unknown' }
  }
  async commitChampion(): Promise<void> {
    throw new Error('GEPA Campaign binding transition is the only champion writer')
  }
}

export function createPhysicalGepaHooks(options: PhysicalGepaHooksOptions): PhysicalGepaHooks {
  return new PhysicalGepaHooks(options)
}
