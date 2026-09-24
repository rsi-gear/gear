import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { assertSchema, canonicalJson, jsonDigest, validateSchema, type JsonSchema, type JsonValue } from '../schema.js';
import { s3ImplementationDigest } from '../data/identity.js';

export type ExecutionKind = 'execution.rollout' | 'execution.feedback' | 'execution.role' | 'execution.workspace-edit';
export type ExecutionResult = {
  requestedBindingSetDigest: string;
  actualBindings: Record<string, ArtifactRef>;
  evidenceRef: ArtifactRef;
  receiptRef: ArtifactRef;
  producedArtifactRef?: ArtifactRef;
  /** Bounded reducer-visible JSON; the same bytes are sealed separately from any edited harness. */
  structuredResult?: JsonValue;
  structuredResultRef?: ArtifactRef;
  validationReceiptRef?: ArtifactRef;
};
export type ExecutionReceipt = {
  schemaVersion: 1;
  providerImplementationDigest: string;
  operationId: string;
  inputDigest: string;
  loadedBindingSetDigest: string;
  evidenceDigest: string;
  actualBindings: Record<string, string>;
  executionIdentity: string;
  samplingDigest?: string;
  environmentDigest?: string;
  structuredResultDigest?: string;
};

/** A physical port owns submit/inspect/cancel and must retain its result under the operation's idempotency key. */
export interface PhysicalExecutionPort extends OperationProvider {
  describe(): ProviderManifest & { kind: ExecutionKind; structuredResultSchema?: JsonSchema };
}

/** Shared operation boundary used by recipes; it refuses a result loaded with a different version. */
export class VerifiedExecutionAdapter implements OperationProvider {
  private readonly manifest: ProviderManifest;
  private readonly sourceManifest: ProviderManifest & { kind: ExecutionKind; structuredResultSchema?: JsonSchema };
  constructor(readonly port: PhysicalExecutionPort, readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    readonly requiredSlots: readonly string[]) {
    const source = port.describe();
    assertDigest(source.implementationDigest);
    if (source.structuredResultSchema) assertSchema(source.structuredResultSchema);
    if (new Set(requiredSlots).size !== requiredSlots.length || requiredSlots.length === 0) throw new Error('Execution required slots are invalid');
    this.sourceManifest = structuredClone(source);
    this.manifest = { ...structuredClone(source), implementationDigest: s3ImplementationDigest('execution.adapter',
      { source, slots: [...requiredSlots].sort() }) };
  }
  describe(): ProviderManifest { return structuredClone(this.manifest); }
  private frozenPort(): ProviderManifest {
    const current = this.port.describe();
    if (canonicalJson(current) !== canonicalJson(this.sourceManifest)) throw new Error('Physical execution port identity drift');
    return current;
  }
  private checkInput(envelope: OperationEnvelope): void {
    this.frozenPort();
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest) throw new Error('Execution adapter identity drift');
    const bound = this.bindings.read(envelope.bindingSetRef);
    for (const slot of this.requiredSlots) if (!bound.slots[slot]) throw new Error(`Execution binding ${slot} missing`);
  }
  private verify(envelope: OperationEnvelope, completion: CompletionEnvelope): CompletionEnvelope {
    const portDigest = this.frozenPort().implementationDigest;
    if (completion.operationId !== envelope.operationId || completion.idempotencyKey !== envelope.idempotencyKey
      || completion.inputDigest !== envelope.inputDigest || completion.implementationDigest !== portDigest) throw new Error('Physical execution completion identity mismatch');
    if (completion.outcome.kind !== 'result') return { ...completion, implementationDigest: envelope.implementationDigest };
    const value = completion.outcome.value as unknown as ExecutionResult;
    if (!value || typeof value !== 'object' || value.requestedBindingSetDigest !== envelope.bindingSetRef.digest
      || !value.actualBindings || !value.evidenceRef || !value.receiptRef) throw new Error('Execution result identity missing');
    const bound = this.bindings.read(envelope.bindingSetRef);
    if (Object.keys(value.actualBindings).sort().join('\0') !== Object.keys(bound.slots).sort().join('\0')) throw new Error('Actual execution binding slots drift');
    for (const [slot, expected] of Object.entries(bound.slots)) {
      const actual = value.actualBindings[slot];
      if (!actual || canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Actual execution version drift: ${slot}`);
      this.artifacts.getBytes(actual);
    }
    this.artifacts.getBytes(value.evidenceRef);
    const receipt = this.artifacts.getJson(value.receiptRef) as unknown as ExecutionReceipt;
    if (receipt.schemaVersion !== 1 || receipt.providerImplementationDigest !== portDigest
      || receipt.operationId !== envelope.operationId || receipt.inputDigest !== envelope.inputDigest
      || receipt.loadedBindingSetDigest !== envelope.bindingSetRef.digest || receipt.evidenceDigest !== value.evidenceRef.digest
      || !receipt.executionIdentity) throw new Error('Execution receipt identity mismatch');
    if (Object.keys(receipt.actualBindings ?? {}).sort().join('\0') !== Object.keys(bound.slots).sort().join('\0')) throw new Error('Execution receipt binding slots drift');
    for (const slot of Object.keys(bound.slots)) if (receipt.actualBindings[slot] !== value.actualBindings[slot]!.digest) throw new Error('Execution receipt loaded version mismatch');
    const input = envelope.input as Record<string, unknown>;
    if (typeof input.samplingDigest === 'string' && receipt.samplingDigest !== input.samplingDigest) throw new Error('Execution sampling identity mismatch');
    if (typeof input.environmentDigest === 'string' && receipt.environmentDigest !== input.environmentDigest) throw new Error('Execution environment identity mismatch');
    if (this.sourceManifest.structuredResultSchema) {
      if (value.structuredResult === undefined || !value.structuredResultRef || !receipt.structuredResultDigest) {
        throw new Error('Structured execution result or sealed artifact missing');
      }
      validateSchema(this.sourceManifest.structuredResultSchema, value.structuredResult);
      if (Buffer.byteLength(canonicalJson(value.structuredResult)) > 16 * 1024) throw new Error('Structured execution result too large');
      const sealed = this.artifacts.getJson(value.structuredResultRef);
      if (canonicalJson(sealed) !== canonicalJson(value.structuredResult)
        || receipt.structuredResultDigest !== jsonDigest(value.structuredResult)) {
        throw new Error('Structured execution result seal mismatch');
      }
    } else if (value.structuredResult !== undefined || value.structuredResultRef !== undefined
      || receipt.structuredResultDigest !== undefined) {
      throw new Error('Unannounced structured execution result');
    }
    if (value.producedArtifactRef) this.artifacts.getBytes(value.producedArtifactRef);
    if (this.manifest.kind === 'execution.workspace-edit') {
      if (!value.producedArtifactRef || !value.validationReceiptRef) throw new Error('Workspace edit requires checked sealed artifact');
      const validation = this.artifacts.getJson(value.validationReceiptRef) as Record<string, unknown>;
      if (validation.valid !== true || validation.producedDigest !== value.producedArtifactRef.digest) throw new Error('Workspace edit validation mismatch');
    }
    return { ...completion, implementationDigest: envelope.implementationDigest };
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { this.checkInput(envelope); await this.port.preflight({ ...envelope, implementationDigest: this.sourceManifest.implementationDigest }); }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    this.checkInput(envelope);
    const actual = await this.port.submit({ ...envelope, implementationDigest: this.sourceManifest.implementationDigest });
    return actual.status === 'completed' ? { status: 'completed', completion: this.verify(envelope, actual.completion) } : actual;
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.checkInput(envelope);
    const actual = await this.port.inspect({ ...envelope, implementationDigest: this.sourceManifest.implementationDigest });
    return actual.status === 'completed' ? { status: 'completed', completion: this.verify(envelope, actual.completion) } : actual;
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.checkInput(envelope);
    const actual = await this.port.cancel({ ...envelope, implementationDigest: this.sourceManifest.implementationDigest });
    return actual.status === 'completed' ? { status: 'completed', completion: this.verify(envelope, actual.completion) } : actual;
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    this.checkInput(envelope);
    return this.verify(envelope, await this.port.collect({ ...envelope, implementationDigest: this.sourceManifest.implementationDigest }));
  }
}

/** Physical adapters can share the same JSON result contract while declaring their own input schema. */
export const executionResultSchema: JsonSchema = { type: 'object', required: ['requestedBindingSetDigest', 'actualBindings', 'evidenceRef', 'receiptRef'],
  properties: { requestedBindingSetDigest: { type: 'string' }, actualBindings: { type: 'object', additionalProperties: { type: 'any' } },
    evidenceRef: { type: 'any' }, receiptRef: { type: 'any' }, producedArtifactRef: { type: 'any' },
    structuredResult: { type: 'any' }, structuredResultRef: { type: 'any' },
    validationReceiptRef: { type: 'any' } }, additionalProperties: false };
