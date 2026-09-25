import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, OperationOutcome } from '../contracts.js';
import { FileArtifactStore, sha256 } from '../artifacts.js';
import { assertJson, canonicalJson, jsonDigest, validateSchema, type JsonValue } from '../schema.js';
import { BindingStore } from '../bindings.js';
import { verifyAuthorOutputGraph, type AuthorGraphPolicy } from './graph.js';

abstract class PureAuthorProvider implements OperationProvider {
  abstract readonly kind: string;
  abstract value(envelope: OperationEnvelope): JsonValue;
  validate(_envelope: OperationEnvelope): void {}
  describe(): ProviderManifest {
    return { kind: this.kind, implementationDigest: sha256(`${this.kind}.v1`), execution: 'trusted-local', supportsInspect: true,
      meteredDimensions: [], inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' } };
  }
  preflight(envelope: OperationEnvelope): void {
    const manifest = this.describe();
    if (envelope.kind !== manifest.kind || envelope.implementationDigest !== manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input)) throw new Error(`${this.kind} operation identity drift`);
    validateSchema(manifest.inputSchema, envelope.input);
    if (Object.keys(envelope.limits).length !== 0 || envelope.startsBudgetClock === true) throw new Error(`${this.kind} must not meter or start clock`);
    this.validate(envelope);
  }
  private completion(envelope: OperationEnvelope): CompletionEnvelope {
    this.preflight(envelope);
    const outcome: OperationOutcome = { kind: 'result', value: this.value(envelope) };
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, outcome };
  }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { this.preflight(envelope); return Promise.resolve({ status: 'not-started' }); }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { return Promise.resolve({ status: 'completed', completion: this.completion(envelope) }); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { return Promise.resolve(this.completion(envelope)); }
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection> { this.preflight(envelope); return Promise.resolve({ status: 'cancelled', releaseConfirmed: true }); }
}

/** Frozen in the committed intent; recomputation never reads the current clock or budget. */
export class AuthorObserveProvider extends PureAuthorProvider {
  readonly kind = 'author.observe';
  validate(envelope: OperationEnvelope): void { this.frozenValue(envelope); }
  private frozenValue(envelope: OperationEnvelope): JsonValue {
    const input = envelope.input as { kind?: string; value?: JsonValue; campaignId?: string; decisionIndex?: number; snapshotDigest?: string };
    if (!['budget', 'now', 'random-seed', 'id'].includes(input.kind ?? '')
      || input.campaignId !== envelope.campaignId || input.decisionIndex !== envelope.decisionIndex
      || !/^[a-f0-9]{64}$/.test(input.snapshotDigest ?? '')) throw new Error('Invalid frozen author observation');
    assertJson(input.value);
    return input.value!;
  }
  value(envelope: OperationEnvelope): JsonValue { return this.frozenValue(envelope); }
}

export function validateAuthorCheckpointInput(artifacts: FileArtifactStore, bindings: BindingStore, raw: JsonValue,
  policy: AuthorGraphPolicy = {}):
  { name: string; value: JsonValue; schema: 'author.archive.v1' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid checkpoint input');
  const input = raw as { name?: string; value?: JsonValue; schema?: string };
  if (!input.name || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(input.name) || input.schema !== 'author.archive.v1')
    throw new Error('Author checkpoint requires valid name and built-in author.archive.v1 schema');
  assertJson(input.value);
  verifyAuthorOutputGraph(artifacts, bindings, input.value!, policy);
  if (Buffer.byteLength(canonicalJson(input.value)) > 256 * 1024) throw new Error('Author checkpoint value exceeds 256 KiB chunk limit');
  return { name: input.name, value: input.value!, schema: 'author.archive.v1' };
}

/** Same logical address yields the same immutable OutputEntry, including on collect after lost reply. */
export class AuthorCheckpointProvider extends PureAuthorProvider {
  readonly kind = 'author.checkpoint';
  readonly policy: Readonly<AuthorGraphPolicy>;
  constructor(readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    policy: AuthorGraphPolicy = {}) {
    super();
    if (policy.wireVersion !== undefined && policy.wireVersion !== 'v1' && policy.wireVersion !== 'v2')
      throw new Error('Unsupported author checkpoint wire version');
    this.policy = Object.freeze({ ...policy });
    if (this.policy.wireVersion === 'v2' && !/^[a-f0-9]{64}$/.test(this.policy.executionProfileDigest ?? ''))
      throw new Error('A1 checkpoint needs frozen execution profile');
  }
  describe(): ProviderManifest {
    const base = super.describe();
    return this.policy.wireVersion === 'v2'
      ? { ...base, implementationDigest: sha256(`${this.kind}.v2:${this.policy.executionProfileDigest ?? ''}`) }
      : base;
  }
  validate(envelope: OperationEnvelope): void {
    validateAuthorCheckpointInput(this.artifacts, this.bindings, envelope.input, this.policy);
  }
  value(envelope: OperationEnvelope): JsonValue {
    const input = validateAuthorCheckpointInput(this.artifacts, this.bindings, envelope.input, this.policy);
    const valueRef = this.artifacts.putJson(input.value!, input.schema);
    const entry = { name: input.name, schema: input.schema, valueRef, campaignId: envelope.campaignId,
      logicalAddress: envelope.localKey, operationId: envelope.operationId, decisionIndex: envelope.decisionIndex };
    return { ref: this.artifacts.putJson(entry, 'author.output-entry.v1') };
  }
}
