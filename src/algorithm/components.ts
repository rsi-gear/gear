import type { CompletionEnvelope, ComponentManifest, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission } from './contracts.js';
import { assertJson, validateSchema, type JsonValue } from './schema.js';
import { PythonHostError, PythonWorker } from './hosts/python.js';
import { LocalDurableProvider, type LocalProviderFaults } from './runtime/providers.js';

function completion(envelope: OperationEnvelope, outcome: CompletionEnvelope['outcome']): CompletionEnvelope {
  return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
    inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, outcome };
}

/** A named policy hook backed by S1's started/result durable operation helper. */
export class PythonPolicyProvider implements OperationProvider {
  readonly #inner: LocalDurableProvider;
  constructor(readonly manifest: ComponentManifest, readonly worker: PythonWorker, recordRoot: string,
              readonly operationKind = 'policy.decide', faults: LocalProviderFaults = {}) {
    if (manifest.language !== 'python') throw new Error('PythonPolicyProvider requires a Python component');
    const providerManifest: ProviderManifest = { kind: operationKind, implementationDigest: manifest.implementationDigest,
      inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema,
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: [] };
    this.#inner = new LocalDurableProvider(recordRoot, providerManifest, async envelope => {
      try {
        const output = await this.worker.call('component.invoke', envelope.input);
        validateSchema(this.manifest.outputSchema, output);
        return { outcome: { kind: 'result' as const, value: output } };
      } catch (error) {
        if (!(error instanceof PythonHostError) || !['PYTHON_ERROR', 'VALIDATION'].includes(error.code)) throw error;
        return { outcome: { kind: 'error' as const, code: error.code, message: error.message } };
      }
    }, faults);
  }
  describe(): ProviderManifest { return this.#inner.describe(); }
  preflight(envelope: OperationEnvelope): Promise<void> | void {
    validateSchema(this.manifest.inputSchema, envelope.input);
    return this.#inner.preflight();
  }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { return this.#inner.submit(envelope); }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.#inner.inspect(envelope); }
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.#inner.cancel(envelope); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { return this.#inner.collect(envelope); }
}

function responseObject(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`Invalid Python provider ${label}`);
  return value;
}
function validateReceipt(value: JsonValue | undefined, dimensions: string[] = []): void {
  if (value === undefined) { if (dimensions.length) throw new Error('Python provider final usage receipt missing'); return; }
  const receipt = responseObject(value, 'receipt');
  if (typeof receipt.source !== 'string' || !receipt.source || typeof receipt.cursor !== 'string' || !receipt.cursor) throw new Error('Invalid Python provider receipt identity');
  if (receipt.scope !== undefined && receipt.scope !== 'operation' && receipt.scope !== 'campaign') throw new Error('Invalid Python provider receipt scope');
  if (receipt.operationId !== undefined && typeof receipt.operationId !== 'string') throw new Error('Invalid Python provider receipt operationId');
  if (receipt.scope === 'operation' && !receipt.operationId) throw new Error('Operation receipt needs operationId');
  const cumulative = responseObject(receipt.cumulative!, 'receipt cumulative');
  for (const dimension of dimensions) if (!Object.hasOwn(cumulative, dimension)) throw new Error(`Python provider final usage missing ${dimension}`);
  for (const amount of Object.values(cumulative)) if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('Invalid Python provider usage amount');
}
function validateCompletion(value: JsonValue, envelope: OperationEnvelope, manifest: ProviderManifest): CompletionEnvelope {
  const completion = responseObject(value, 'completion');
  for (const key of ['operationId', 'idempotencyKey', 'inputDigest', 'implementationDigest'] as const) {
    if (completion[key] !== envelope[key]) throw new Error(`Python provider completion ${key} mismatch`);
  }
  const outcome = responseObject(completion.outcome!, 'outcome');
  if (outcome.kind === 'result') {
    if (!Object.hasOwn(outcome, 'value')) throw new Error('Python provider result value missing');
    validateSchema(manifest.outputSchema, outcome.value);
  } else if (outcome.kind === 'no-result') {
    if (outcome.reason !== undefined && typeof outcome.reason !== 'string') throw new Error('Invalid no-result reason');
  } else if (outcome.kind === 'inconclusive') {
    if (typeof outcome.reason !== 'string') throw new Error('Invalid inconclusive reason');
  } else if (outcome.kind === 'cancelled') {
    if (outcome.reason !== undefined && typeof outcome.reason !== 'string') throw new Error('Invalid cancelled reason');
  } else if (outcome.kind === 'error') {
    if (typeof outcome.code !== 'string' || !outcome.code || typeof outcome.message !== 'string' || !outcome.message ||
        (outcome.retryable !== undefined && typeof outcome.retryable !== 'boolean')) throw new Error('Invalid execution error');
  } else throw new Error('Unknown Python provider outcome');
  validateReceipt(completion.receipt, manifest.meteredDimensions);
  return completion as CompletionEnvelope;
}
function validateInspection(value: JsonValue, envelope: OperationEnvelope, manifest: ProviderManifest): ProviderInspection {
  const inspection = responseObject(value, 'inspection');
  if (inspection.status === 'completed') validateCompletion(inspection.completion!, envelope, manifest);
  else if (inspection.status === 'running') {
    if (inspection.handle !== undefined && typeof inspection.handle !== 'string') throw new Error('Invalid Python provider handle');
    validateReceipt(inspection.receipt);
  } else if (inspection.status === 'cancelled') {
    if (typeof inspection.releaseConfirmed !== 'boolean') throw new Error('Invalid cancellation release flag');
    validateReceipt(inspection.receipt, inspection.releaseConfirmed ? manifest.meteredDimensions : []);
  } else if (inspection.status === 'unknown' || inspection.status === 'not-started') validateReceipt(inspection.receipt);
  else throw new Error('Unknown Python provider inspection status');
  return inspection as ProviderInspection;
}

/** Forward a Python provider through the public operation SPI. */
export class PythonOperationProvider implements OperationProvider {
  constructor(readonly manifest: ProviderManifest, readonly worker: PythonWorker) {}
  describe(): ProviderManifest { return this.manifest; }
  async preflight(envelope: OperationEnvelope): Promise<void> {
    validateSchema(this.manifest.inputSchema, envelope.input);
    const response = responseObject(await this.worker.call('provider.preflight', envelope), 'preflight');
    if (response.ok !== true) throw new Error('Python provider preflight failed');
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const response = responseObject(await this.worker.call('provider.submit', envelope), 'submission');
    if (response.status === 'completed') validateCompletion(response.completion!, envelope, this.manifest);
    else if (response.status === 'running') {
      if (response.handle !== undefined && typeof response.handle !== 'string') throw new Error('Invalid Python provider handle');
      validateReceipt(response.receipt);
    } else throw new Error('Unknown Python provider submission status');
    return response as ProviderSubmission;
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    return validateInspection(await this.worker.call('provider.inspect', envelope), envelope, this.manifest);
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    return validateInspection(await this.worker.call('provider.cancel', envelope), envelope, this.manifest);
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    return validateCompletion(await this.worker.call('provider.collect', envelope), envelope, this.manifest);
  }
}

/** A built ESM policy hook; it shares the same durable started/result boundary. */
export class TypeScriptPolicyProvider implements OperationProvider {
  readonly #inner: LocalDurableProvider;
  constructor(readonly manifest: ComponentManifest, invoke: (input: JsonValue) => Promise<JsonValue> | JsonValue,
              recordRoot: string, readonly operationKind = 'policy.decide') {
    if (manifest.language !== 'typescript') throw new Error('TypeScriptPolicyProvider requires a TypeScript component');
    const providerManifest: ProviderManifest = { kind: operationKind, implementationDigest: manifest.implementationDigest,
      inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema,
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: [] };
    this.#inner = new LocalDurableProvider(recordRoot, providerManifest, async envelope => {
      try {
        const output = await invoke(envelope.input);
        validateSchema(manifest.outputSchema, output);
        return { outcome: { kind: 'result' as const, value: output } };
      } catch (error) {
        return { outcome: { kind: 'error' as const, code: 'TYPESCRIPT_HOOK_ERROR',
          message: error instanceof Error ? error.message : String(error) } };
      }
    });
  }
  describe(): ProviderManifest { return this.#inner.describe(); }
  preflight(envelope: OperationEnvelope): Promise<void> | void { validateSchema(this.manifest.inputSchema, envelope.input); return this.#inner.preflight(); }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { return this.#inner.submit(envelope); }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.#inner.inspect(envelope); }
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.#inner.cancel(envelope); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { return this.#inner.collect(envelope); }
}
