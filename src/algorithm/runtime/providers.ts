import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionEnvelope, OperationEnvelope, OperationOutcome, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt, BindingSetRef, ArtifactRef } from '../contracts.js';
import { BindingStore } from '../bindings.js';
import { assertDigest, durableWrite, sha256 } from '../artifacts.js';
import { assertJson, canonicalJson, type JsonValue } from '../schema.js';
import { kernelImplementationDigest } from './identity.js';

export class BindingDeriveProvider implements OperationProvider {
  constructor(readonly bindings: BindingStore) {}
  describe(): ProviderManifest {
    return {
      kind: 'bindings.derive', implementationDigest: kernelImplementationDigest(), execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
      inputSchema: { type: 'object', properties: { baseRef: { type: 'any' }, replacements: { type: 'object', additionalProperties: { type: 'any' } } }, required: ['baseRef', 'replacements'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { bindingSetRef: { type: 'any' } }, required: ['bindingSetRef'], additionalProperties: false },
    };
  }
  preflight(envelope: OperationEnvelope): void { this.parse(envelope); }
  private parse(envelope: OperationEnvelope): { baseRef: BindingSetRef; replacements: Record<string, ArtifactRef> } {
    const input = envelope.input as { baseRef: BindingSetRef; replacements: Record<string, ArtifactRef> };
    this.bindings.read(input.baseRef);
    for (const ref of Object.values(input.replacements)) this.bindings.artifacts.getBytes(ref);
    return input;
  }
  private completion(envelope: OperationEnvelope): CompletionEnvelope {
    const { baseRef, replacements } = this.parse(envelope);
    const bindingSetRef = this.bindings.derive(baseRef, replacements);
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, outcome: { kind: 'result', value: { bindingSetRef } } };
  }
  inspect(): Promise<ProviderInspection> { return Promise.resolve({ status: 'not-started' }); }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { return Promise.resolve({ status: 'completed', completion: this.completion(envelope) }); }
  cancel(): Promise<ProviderInspection> { return Promise.resolve({ status: 'cancelled', releaseConfirmed: true }); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { return Promise.resolve(this.completion(envelope)); }
}

export type LocalProviderHandler = (envelope: OperationEnvelope) => Promise<{ outcome: OperationOutcome; receipt?: UsageReceipt }> | { outcome: OperationOutcome; receipt?: UsageReceipt };
export type LocalProviderFaults = { dropSubmitResponseOnce?: boolean; inspectUnknownOnce?: boolean; cancelReleaseConfirmed?: boolean };

/** Trusted local durable helper: persistence and inspect are provided; no OS sandbox is claimed. */
export class LocalDurableProvider implements OperationProvider {
  submitCalls = 0;
  inspectCalls = 0;
  private readonly records: string;
  constructor(readonly root: string, readonly manifest: ProviderManifest, readonly handler: LocalProviderHandler, readonly faults: LocalProviderFaults = {}) {
    this.records = join(root, 'operations'); mkdirSync(this.records, { recursive: true });
  }
  describe(): ProviderManifest { return this.manifest; }
  preflight(): void {}
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`); }
  private read(envelope: OperationEnvelope): CompletionEnvelope | 'started' | null {
    const path = this.path(envelope); if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const stored = JSON.parse(raw) as CompletionEnvelope | { status: 'started'; envelope: OperationEnvelope }; assertJson(stored);
    const identity = 'envelope' in stored ? stored.envelope : stored;
    if (identity.operationId !== envelope.operationId || identity.idempotencyKey !== envelope.idempotencyKey || identity.inputDigest !== envelope.inputDigest || identity.implementationDigest !== envelope.implementationDigest) throw new Error('Local provider identity drift');
    return 'status' in stored ? 'started' : stored;
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.inspectCalls++;
    if (this.faults.inspectUnknownOnce) { this.faults.inspectUnknownOnce = false; return { status: 'unknown' }; }
    const completion = this.read(envelope);
    return completion === 'started' ? { status: 'unknown' } : completion ? { status: 'completed', completion } : { status: 'not-started' };
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    this.submitCalls++;
    const existing = this.read(envelope);
    if (existing === 'started') throw new Error('Started local operation has unknown outcome');
    if (existing) return { status: 'completed', completion: existing };
    const path = this.path(envelope);
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.submit(envelope);
      throw error;
    }
    try { writeFileSync(fd, canonicalJson({ status: 'started', envelope })); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(this.records, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    const result = await this.handler(envelope);
    const completion: CompletionEnvelope = {
      operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, outcome: result.outcome,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
    assertJson(completion);
    durableWrite(path, canonicalJson(completion));
    if (this.faults.dropSubmitResponseOnce) { this.faults.dropSubmitResponseOnce = false; throw new Error('Simulated lost submit response'); }
    return { status: 'completed', completion };
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const completion = this.read(envelope);
    if (completion === 'started') return { status: 'unknown' };
    if (completion) return { status: 'completed', completion };
    return { status: 'cancelled', releaseConfirmed: this.faults.cancelReleaseConfirmed ?? false };
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const completion = this.read(envelope); if (!completion || completion === 'started') throw new Error('Result unavailable'); return completion;
  }
}
