import { existsSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  constructor(readonly root: string, readonly manifest: ProviderManifest, readonly handler: LocalProviderHandler,
    readonly faults: LocalProviderFaults = {}, readonly meteringSource: string = manifest.kind) {
    this.records = join(root, 'operations'); mkdirSync(this.records, { recursive: true });
  }
  describe(): ProviderManifest { return this.manifest; }
  preflight(): void {}
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`); }
  private read(envelope: OperationEnvelope): CompletionEnvelope | 'started' | 'cancelled' | null {
    const path = this.path(envelope); if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const stored = JSON.parse(raw) as CompletionEnvelope | { status: 'started' | 'cancelled'; envelope: OperationEnvelope }; assertJson(stored);
    const identity = 'envelope' in stored ? stored.envelope : stored;
    if (identity.operationId !== envelope.operationId || identity.idempotencyKey !== envelope.idempotencyKey || identity.inputDigest !== envelope.inputDigest || identity.implementationDigest !== envelope.implementationDigest) throw new Error('Local provider identity drift');
    if ('status' in stored) {
      if (stored.status !== 'started' && stored.status !== 'cancelled') throw new Error('Invalid local provider marker');
      return stored.status;
    }
    return stored;
  }
  private zeroReceipt(envelope: OperationEnvelope): UsageReceipt {
    return { source: this.meteringSource, scope: 'operation', operationId: envelope.operationId, cursor: 'cancelled-before-start',
      cumulative: Object.fromEntries(this.manifest.meteredDimensions.map(dimension => [dimension, 0])) };
  }
  /** An fsynced temporary file is linked into the one final name: start and cancel cannot both win. */
  private establish(envelope: OperationEnvelope, status: 'started' | 'cancelled'): boolean {
    const path = this.path(envelope);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, canonicalJson({ status, envelope })); fsyncSync(fd); } finally { closeSync(fd); }
    let created = false;
    try { linkSync(temporary, path); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    const directory = openSync(this.records, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    return created;
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.inspectCalls++;
    if (this.faults.inspectUnknownOnce) { this.faults.inspectUnknownOnce = false; return { status: 'unknown' }; }
    const completion = this.read(envelope);
    return completion === 'started' ? { status: 'unknown' }
      : completion === 'cancelled' ? { status: 'cancelled', releaseConfirmed: this.faults.cancelReleaseConfirmed ?? true,
        receipt: this.zeroReceipt(envelope) }
        : completion ? { status: 'completed', completion } : { status: 'not-started' };
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    this.submitCalls++;
    const existing = this.read(envelope);
    if (existing === 'started') throw new Error('Started local operation has unknown outcome');
    if (existing === 'cancelled') throw new Error('Cancelled local operation cannot be submitted');
    if (existing) return { status: 'completed', completion: existing };
    if (!this.establish(envelope, 'started')) {
      const winner = this.read(envelope);
      if (winner === 'cancelled') throw new Error('Cancelled local operation cannot be submitted');
      if (winner === 'started') throw new Error('Started local operation has unknown outcome');
      if (winner) return { status: 'completed', completion: winner };
      throw new Error('Local operation marker disappeared');
    }
    const path = this.path(envelope);
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
    if (completion === 'cancelled') return { status: 'cancelled', releaseConfirmed: this.faults.cancelReleaseConfirmed ?? true, receipt: this.zeroReceipt(envelope) };
    if (completion) return { status: 'completed', completion };
    if (!this.establish(envelope, 'cancelled')) return this.cancel(envelope);
    return { status: 'cancelled', releaseConfirmed: this.faults.cancelReleaseConfirmed ?? true, receipt: this.zeroReceipt(envelope) };
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const completion = this.read(envelope); if (!completion || completion === 'started' || completion === 'cancelled') throw new Error('Result unavailable'); return completion;
  }
}
