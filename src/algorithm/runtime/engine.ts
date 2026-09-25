import { createHash } from 'node:crypto';
import type { Algorithm, AlgorithmDecision, AlgorithmManifest, BudgetPlan, BudgetSnapshot, CampaignSpec, CompletionEnvelope, OperationEnvelope, OperationIntent, OperationOutcome, OperationProvider, ProviderInspection, ProviderManifest, ProviderPreflight, ProviderDispatchContext, ProviderSubmission, UsageReceipt, BindingSetRef } from '../contracts.js';
import { ALGORITHM_API_VERSION } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, validateSchema, type JsonValue } from '../schema.js';
import { CampaignStore } from './store.js';
import type { ArtifactCheckpoint, CampaignStoreLike } from './persistence.js';
import { BindingDeriveProvider } from './providers.js';
import { kernelImplementationDigest } from './identity.js';
import { ProviderProtocolError } from '../provider-errors.js';

type OperationRecord = {
  envelope: OperationEnvelope;
  providerManifestDigest: string;
  status: 'intent' | 'running' | 'unknown' | 'completed' | 'cancel-pending' | 'cancelled';
  handle?: string;
  outcome?: OperationOutcome;
  accounted: Record<string, number>;
  released: boolean;
  /** A ready dispatch was durably admitted before submit; a prepared provider plan alone is insufficient. */
  dispatchAdmitted?: true;
};
type ReceiptCursor = { cursor: string; cumulative: Record<string, number> };
type Observation = { kind: 'inspect'; value: ProviderInspection }
  | { kind: 'submit'; value: ProviderSubmission; priorReceipt?: UsageReceipt }
  | { kind: 'submit-unknown'; priorReceipt?: UsageReceipt }
  | { kind: 'submit-protocol-error'; error: ProviderProtocolError; priorReceipt?: UsageReceipt }
  | { kind: 'preflight-error'; error: unknown; priorReceipt?: UsageReceipt };
type PreparedObservation = { kind: 'observed'; observation: Observation }
  | { kind: 'ready'; provider: OperationProvider; envelope: OperationEnvelope;
    priorReceipt?: UsageReceipt; startsBudgetClock: boolean };
export type CampaignState = {
  version: 1;
  spec: CampaignSpec;
  storageBackendDigest?: string;
  algorithmManifestDigest: string;
  kernelImplementationDigest: string;
  providerCatalogDigest: string;
  activeBindingSetRef: BindingSetRef;
  initialBindingSetRef: BindingSetRef;
  state: JsonValue;
  decisionIndex: number;
  operations: Record<string, OperationRecord>;
  /** External repair groups share this Campaign's receipts and budget without advancing the reducer. */
  auxiliaryOperations?: Record<string, Record<string, OperationRecord>>;
  /** First admitted physical reservation, shared by main and auxiliary operations. */
  budgetStartedAt?: number;
  spent: Record<string, number>;
  receiptSources: Record<string, ReceiptCursor>;
  phase: 'running' | 'complete';
};

function id(value: JsonValue): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function validName(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Invalid identifier: ${value}`); }
function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function frozenCopy<T>(value: T): T {
  const detached = clone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(detached);
  return detached;
}

export class AlgorithmRuntime {
  readonly artifacts: FileArtifactStore;
  readonly bindings: BindingStore;
  readonly store: CampaignStoreLike<JsonValue>;
  private readonly providers = new Map<string, OperationProvider>();
  private readonly providerManifestDigests = new Map<string, string>();
  private readonly providerCatalogDigest: string;
  private readonly manifest: AlgorithmManifest;
  private readonly storageBackendDigest?: string;

  constructor(readonly root: string, readonly algorithm: Algorithm, providers: OperationProvider[], readonly spec: CampaignSpec,
    storage: { store?: CampaignStoreLike<JsonValue>; artifacts?: FileArtifactStore } = {}) {
    this.artifacts = storage.artifacts ?? new FileArtifactStore(`${root}/artifacts`);
    if (storage.store?.requiresArtifactCheckpoint
      && (typeof (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).hydrate !== 'function'
        || typeof (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush !== 'function'))
      throw new Error('Journal-backed Campaign requires a hydratable artifact checkpoint');
    if (storage.store?.requiresArtifactCheckpoint) {
      const artifactIdentity = (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).identityDigest;
      if (!storage.store.identityDigest || !artifactIdentity)
        throw new Error('Journal-backed Campaign storage identity required');
      this.storageBackendDigest = jsonDigest([storage.store.identityDigest, artifactIdentity]);
    }
    this.manifest = algorithm.describe();
    if (this.manifest.apiVersion !== ALGORITHM_API_VERSION) throw new Error('Algorithm API version mismatch');
    validName(this.manifest.id); validName(spec.campaignId);
    if (!/^[a-f0-9]{64}$/.test(this.manifest.implementationDigest)) throw new Error('Algorithm implementation digest required');
    assertSchema(this.manifest.stateSchema);
    validateSchema(this.manifest.configSchema, spec.config);
    this.bindings = new BindingStore(this.artifacts, this.manifest.bindingSchema);
    this.store = storage.store ?? new CampaignStore<JsonValue>(`${root}/campaign`);
    for (const provider of [new BindingDeriveProvider(this.bindings), ...providers]) {
      const manifest = provider.describe(); this.validateProviderManifest(manifest);
      if (this.providers.has(manifest.kind)) throw new Error(`Duplicate provider ${manifest.kind}`);
      this.providers.set(manifest.kind, provider);
      this.providerManifestDigests.set(manifest.kind, jsonDigest(manifest));
    }
    const requiredKinds = this.manifest.requiredOperationKinds ?? [];
    if (!Array.isArray(requiredKinds) || new Set(requiredKinds).size !== requiredKinds.length)
      throw new Error('Algorithm requiredOperationKinds must be a unique array');
    const configKeys = this.manifest.requiredOperationKindsFromConfig ?? [];
    if (!Array.isArray(configKeys) || new Set(configKeys).size !== configKeys.length)
      throw new Error('Algorithm requiredOperationKindsFromConfig must be a unique array');
    const config = spec.config;
    const configuredKinds: string[] = [];
    for (const key of configKeys) {
      validName(key);
      if (!config || Array.isArray(config) || typeof config !== 'object' || !Object.hasOwn(config, key)
        || typeof config[key] !== 'string') {
        throw new Error(`Required operation kind config must be an own string value: ${key}`);
      }
      configuredKinds.push(config[key]);
    }
    for (const kind of new Set([...requiredKinds, ...configuredKinds])) {
      validName(kind);
      if (!this.providers.has(kind)) throw new Error(`Required operation provider missing: ${kind}`);
    }
    this.providerCatalogDigest = jsonDigest(Object.fromEntries([...this.providerManifestDigests].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))));
    this.validateBudget(spec.budget);
    assertJson(spec);
    for (const component of Object.values(spec.components ?? {})) {
      if (component.apiVersion !== ALGORITHM_API_VERSION || !/^[a-f0-9]{64}$/.test(component.implementationDigest) || !/^[a-f0-9]{64}$/.test(component.environmentDigest)) throw new Error('Invalid frozen component identity');
      assertSchema(component.inputSchema); assertSchema(component.outputSchema);
    }
  }

  private validateProviderManifest(manifest: ProviderManifest): void {
    validName(manifest.kind);
    if (!/^[a-f0-9]{64}$/.test(manifest.implementationDigest)) throw new Error('Provider implementation digest required');
    if (manifest.supportsInspect !== true || !['trusted-local', 'external'].includes(manifest.execution)
      || (manifest.supportsIdempotentReplay !== undefined && manifest.supportsIdempotentReplay !== true))
      throw new Error('Invalid provider capabilities');
    if (!Array.isArray(manifest.meteredDimensions) || !manifest.meteredDimensions.every(dimension => typeof dimension === 'string') || new Set(manifest.meteredDimensions).size !== manifest.meteredDimensions.length) throw new Error('Invalid provider metered dimensions');
    for (const dimension of manifest.meteredDimensions) validName(dimension);
    for (const dimension of manifest.hardLimitDimensions ?? []) if (!manifest.meteredDimensions.includes(dimension)) throw new Error('Hard limit dimension must be metered');
    assertSchema(manifest.inputSchema);
    assertSchema(manifest.outputSchema);
  }

  private validateBudget(budget: BudgetPlan): void {
    assertJson(budget);
    for (const [dimension, plan] of Object.entries(budget)) {
      validName(dimension);
      if (!plan.unit || !plan.source || !['hard', 'stop'].includes(plan.capability) || !Number.isFinite(plan.limit) || plan.limit < 0) throw new Error(`Invalid budget ${dimension}`);
    }
  }

  private provider(kind: string): { provider: OperationProvider; manifest: ProviderManifest; digest: string } {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`No provider for ${kind}`);
    const manifest = provider.describe(); this.validateProviderManifest(manifest);
    const digest = jsonDigest(manifest);
    if (digest !== this.providerManifestDigests.get(kind)) throw new Error(`Provider manifest drift: ${kind}`);
    return { provider, manifest, digest };
  }

  private validateBinding(ref: BindingSetRef, baseline: BindingSetRef): void {
    const candidate = this.bindings.read(ref);
    const initial = this.bindings.read(baseline);
    for (const [slot, rule] of Object.entries(this.manifest.bindingSchema.slots)) {
      if (!rule.replaceable && canonicalJson(candidate.slots[slot] ?? null) !== canonicalJson(initial.slots[slot] ?? null)) throw new Error(`Immutable binding slot ${slot} changed`);
    }
  }

  private budgetAdmission(state: CampaignState, intents: OperationIntent[]): void {
    // A stop-capability overrun forbids further work, but a terminal decision
    // must still be persisted so the campaign can report its final accounting.
    if (intents.length === 0) return;
    const needed: Record<string, number> = {};
    const existing = [...Object.values(state.operations),
      ...Object.values(state.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))];
    for (const operation of existing) if (!operation.released) {
      for (const [dimension, amount] of Object.entries(operation.envelope.limits)) needed[dimension] = (needed[dimension] ?? 0) + Math.max(0, amount - (operation.accounted[dimension] ?? 0));
    }
    for (const intent of intents) for (const [dimension, amount] of Object.entries(intent.limits ?? {})) {
      const plan = state.spec.budget[dimension];
      if (!plan || !Number.isFinite(amount) || amount < 0) throw new Error(`Invalid reservation ${dimension}`);
      needed[dimension] = (needed[dimension] ?? 0) + amount;
    }
    for (const [dimension, plan] of Object.entries(state.spec.budget)) if ((state.spent[dimension] ?? 0) + (needed[dimension] ?? 0) > plan.limit) throw new Error(`Budget exceeded: ${dimension}`);
  }

  private budgetSnapshot(state: CampaignState): BudgetSnapshot {
    const reserved: Record<string, number> = {};
    const existing = [...Object.values(state.operations),
      ...Object.values(state.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))];
    for (const operation of existing) if (!operation.released) {
      for (const [dimension, amount] of Object.entries(operation.envelope.limits)) {
        reserved[dimension] = (reserved[dimension] ?? 0) + Math.max(0, amount - (operation.accounted[dimension] ?? 0));
      }
    }
    return { dimensions: Object.fromEntries(Object.entries(state.spec.budget).map(([dimension, plan]) => {
      const spent = state.spent[dimension] ?? 0, held = reserved[dimension] ?? 0;
      return [dimension, { ...plan, spent, reserved: held, remaining: Math.max(0, plan.limit - spent - held) }];
    })) };
  }

  private makeOperation(state: CampaignState, intent: OperationIntent, operationId: string,
    decisionIndex: number, defaultBinding: BindingSetRef): OperationRecord {
    validName(intent.localKey);
    validName(intent.kind);
    if (!Object.hasOwn(intent, 'input')) throw new Error('Operation input required');
    if (intent.limits !== undefined && (typeof intent.limits !== 'object' || intent.limits === null || Array.isArray(intent.limits)))
      throw new Error('Operation limits must be an object');
    if (intent.startsBudgetClock !== undefined && typeof intent.startsBudgetClock !== 'boolean')
      throw new Error('Operation budget clock intent must be boolean');
    const { manifest, digest } = this.provider(intent.kind);
    validateSchema(manifest.inputSchema, intent.input);
    this.artifacts.verifyContentRefs(intent.input, this.bindings);
    const bindingSetRef = intent.bindingSetRef ?? defaultBinding;
    this.validateBinding(bindingSetRef, state.initialBindingSetRef);
    const limits = intent.limits ?? {};
    for (const dimension of manifest.meteredDimensions) if (!Object.hasOwn(limits, dimension)) throw new Error(`Missing reservation ${dimension}`);
    for (const dimension of Object.keys(limits)) {
      if (!manifest.meteredDimensions.includes(dimension)) throw new Error(`Provider does not meter ${dimension}`);
      if (state.spec.budget[dimension]?.capability === 'hard' && !manifest.hardLimitDimensions?.includes(dimension))
        throw new Error(`Provider cannot enforce hard limit ${dimension}`);
    }
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId,
      campaignId: state.spec.campaignId, decisionIndex, localKey: intent.localKey,
      kind: intent.kind, input: intent.input, inputDigest: jsonDigest(intent.input),
      implementationDigest: manifest.implementationDigest, bindingSetRef, limits,
      ...(intent.startsBudgetClock === undefined ? {} : { startsBudgetClock: intent.startsBudgetClock }) };
    return { envelope, providerManifestDigest: digest, status: 'intent', accounted: {}, released: false };
  }

  private applyDecision(state: CampaignState, decision: AlgorithmDecision): CampaignState {
    assertJson(decision);
    if (decision.complete !== undefined && typeof decision.complete !== 'boolean') throw new Error('Decision complete must be boolean');
    if (decision.operations !== undefined && !Array.isArray(decision.operations)) throw new Error('Decision operations must be an array');
    validateSchema(this.manifest.stateSchema, decision.nextState);
    const next = clone(state);
    const active = decision.bindingTransition ?? next.activeBindingSetRef;
    this.validateBinding(active, next.initialBindingSetRef);
    next.activeBindingSetRef = active;
    next.state = decision.nextState;
    next.operations = {};
    const intents = decision.operations ?? [];
    if (decision.complete && intents.length) throw new Error('Completed decision cannot start operations');
    if (!decision.complete && intents.length === 0) throw new Error('Nonterminal decision needs operations');
    this.budgetAdmission(next, intents);
    for (const intent of intents) {
      if (next.operations[intent.localKey]) throw new Error(`Duplicate local key ${intent.localKey}`);
      const operationId = id([next.spec.campaignId, next.decisionIndex, intent.localKey]);
      next.operations[intent.localKey] = this.makeOperation(next, intent, operationId, next.decisionIndex, active);
    }
    if (decision.complete) next.phase = 'complete';
    return next;
  }

  private load(): CampaignState | null {
    const saved = this.store.load();
    if (!saved) return null;
    for (const kind of this.providers.keys()) this.provider(kind);
    const state = saved.state as unknown as CampaignState;
    if (state.version !== 1 || canonicalJson(state.spec) !== canonicalJson(this.spec) || state.algorithmManifestDigest !== jsonDigest(this.manifest) || state.kernelImplementationDigest !== kernelImplementationDigest() || state.providerCatalogDigest !== this.providerCatalogDigest || state.storageBackendDigest !== this.storageBackendDigest) throw new Error('Campaign identity drift');
    if (state.budgetStartedAt !== undefined && (!Number.isSafeInteger(state.budgetStartedAt) || state.budgetStartedAt < 0))
      throw new Error('Campaign budget clock drift');
    this.validateBinding(state.activeBindingSetRef, state.initialBindingSetRef);
    validateSchema(this.manifest.stateSchema, state.state);
    const records = [...Object.values(state.operations),
      ...Object.values(state.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))];
    for (const record of records) {
      const { manifest, digest } = this.provider(record.envelope.kind);
      if (digest !== record.providerManifestDigest || manifest.implementationDigest !== record.envelope.implementationDigest || jsonDigest(record.envelope.input) !== record.envelope.inputDigest) throw new Error('Operation identity drift');
      if (record.envelope.startsBudgetClock !== undefined && typeof record.envelope.startsBudgetClock !== 'boolean')
        throw new Error('Operation budget clock identity drift');
      if (record.dispatchAdmitted !== undefined && record.dispatchAdmitted !== true)
        throw new Error('Operation dispatch admission drift');
      this.validateBinding(record.envelope.bindingSetRef, state.initialBindingSetRef);
    }
    return state;
  }

  snapshot(): CampaignState | null { return this.load(); }

  /** Hydrates a SearchJournal-backed store before synchronous recipe/artifact reads. */
  async hydrate(): Promise<void> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).hydrate?.();
    await this.store.hydrate?.();
    this.load();
    await this.store.recoverProjection?.();
  }

  private withHydratedWriter<R>(work: (loaded: CampaignState | null) => Promise<R>): Promise<R> {
    return this.store.withWriter(async () => {
      // A journal-backed writer has already verified its full chain under the
      // lease. Restore artifacts and validate identity before projection or
      // effects, without re-reading that chain outside and inside the lease.
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).hydrate?.();
      if (this.store.writerHydrates !== true) await this.store.hydrate?.();
      const loaded = this.load();
      await this.store.recoverProjection?.();
      return work(loaded);
    });
  }

  private applyReceipt(state: CampaignState, record: OperationRecord, receipt?: UsageReceipt): void {
    if (!receipt) return;
    assertJson(receipt);
    validName(receipt.source);
    if (typeof receipt.cursor !== 'string' || !receipt.cursor || !receipt.cumulative || typeof receipt.cumulative !== 'object' || Array.isArray(receipt.cumulative)) throw new Error('Invalid usage receipt');
    const scope = receipt.scope ?? 'campaign';
    if (scope !== 'operation' && scope !== 'campaign') throw new Error('Invalid receipt scope');
    if (scope === 'operation' && receipt.operationId !== record.envelope.operationId) throw new Error('Receipt operation identity mismatch');
    if (scope === 'campaign' && receipt.operationId !== undefined) throw new Error('Campaign receipt cannot name operation');
    const sourceKey = scope === 'operation' ? `${receipt.source}:${record.envelope.operationId}` : receipt.source;
    const previous = state.receiptSources[sourceKey];
    if (previous?.cursor === receipt.cursor) {
      if (canonicalJson(previous.cumulative) !== canonicalJson(receipt.cumulative)) throw new Error('Conflicting receipt cursor');
      return;
    }
    for (const [dimension, total] of Object.entries(receipt.cumulative)) {
      if (!state.spec.budget[dimension] || !Number.isFinite(total) || total < (previous?.cumulative[dimension] ?? 0)) throw new Error(`Invalid usage receipt ${dimension}`);
      if (state.spec.budget[dimension].source !== receipt.source) throw new Error(`Usage source mismatch ${dimension}`);
      const delta = total - (previous?.cumulative[dimension] ?? 0);
      if (delta > 0 && !Object.hasOwn(record.envelope.limits, dimension)) throw new Error(`Unreserved usage ${dimension}`);
      if (state.spec.budget[dimension].capability === 'hard' && (record.accounted[dimension] ?? 0) + delta > record.envelope.limits[dimension]!) throw new Error(`Hard operation limit overrun ${dimension}`);
      if (state.spec.budget[dimension].capability === 'hard' && (state.spent[dimension] ?? 0) + delta > state.spec.budget[dimension].limit) throw new Error(`Hard budget overrun ${dimension}`);
      state.spent[dimension] = (state.spent[dimension] ?? 0) + delta;
      record.accounted[dimension] = (record.accounted[dimension] ?? 0) + delta;
    }
    if (previous) for (const dimension of Object.keys(previous.cumulative)) if (!Object.hasOwn(receipt.cumulative, dimension)) throw new Error(`Missing cumulative usage ${dimension}`);
    state.receiptSources[sourceKey] = { cursor: receipt.cursor, cumulative: receipt.cumulative };
  }

  private complete(state: CampaignState, record: OperationRecord, completion: CompletionEnvelope): void {
    assertJson(completion);
    const envelope = record.envelope;
    if (completion.operationId !== envelope.operationId || completion.idempotencyKey !== envelope.idempotencyKey || completion.inputDigest !== envelope.inputDigest || completion.implementationDigest !== envelope.implementationDigest) throw new Error('Completion identity mismatch');
    const { manifest } = this.provider(envelope.kind);
    this.requireFinalReceipt(record, completion.receipt, manifest);
    if (completion.outcome.kind === 'result') {
      validateSchema(manifest.outputSchema, completion.outcome.value);
      this.artifacts.verifyContentRefs(completion.outcome.value, this.bindings);
    } else if (completion.outcome.kind === 'error') {
      if (typeof completion.outcome.code !== 'string' || !completion.outcome.code || typeof completion.outcome.message !== 'string' || !completion.outcome.message || (completion.outcome.retryable !== undefined && typeof completion.outcome.retryable !== 'boolean')) throw new Error('Invalid execution error');
    } else if (completion.outcome.kind === 'no-result') {
      if (completion.outcome.reason !== undefined && typeof completion.outcome.reason !== 'string') throw new Error('Invalid no-result reason');
    } else if (completion.outcome.kind === 'inconclusive') {
      if (typeof completion.outcome.reason !== 'string') throw new Error('Invalid inconclusive reason');
    } else if (completion.outcome.kind === 'cancelled') {
      if (completion.outcome.reason !== undefined && typeof completion.outcome.reason !== 'string') throw new Error('Invalid cancellation reason');
    } else throw new Error('Invalid outcome');
    if (record.status === 'completed') {
      if (canonicalJson(record.outcome) !== canonicalJson(completion.outcome)) throw new Error('Conflicting duplicate completion');
      this.applyReceipt(state, record, completion.receipt); return;
    }
    this.applyReceipt(state, record, completion.receipt);
    record.outcome = completion.outcome; record.status = 'completed'; record.released = true;
  }

  private requireFinalReceipt(record: OperationRecord, receipt: UsageReceipt | undefined, manifest: ProviderManifest): void {
    if (manifest.meteredDimensions.length === 0) return;
    if (!receipt || !receipt.cumulative) throw new Error('Missing final usage receipt');
    for (const dimension of manifest.meteredDimensions) if (!Object.hasOwn(receipt.cumulative, dimension)) throw new Error(`Missing final usage ${dimension}`);
    if (receipt.scope === 'operation' && receipt.operationId !== record.envelope.operationId) throw new Error('Final receipt operation identity mismatch');
  }

  private validateInspection(value: ProviderInspection): void {
    assertJson(value);
    if (!value || typeof value !== 'object' || !('status' in value)) throw new Error('Invalid provider inspection');
    if (value.status === 'completed') { if (!value.completion || typeof value.completion !== 'object') throw new Error('Missing provider completion'); return; }
    if (value.status === 'cancelled') { if (typeof value.releaseConfirmed !== 'boolean') throw new Error('Invalid cancellation release'); return; }
    if (value.status === 'running') { if (value.handle !== undefined && typeof value.handle !== 'string') throw new Error('Invalid provider handle'); return; }
    if (value.status === 'unknown' || value.status === 'not-started' || value.status === 'replay-safe') return;
    throw new Error('Invalid provider inspect status');
  }

  private dispatchClockDisposition(value: void | ProviderPreflight, envelope: OperationEnvelope): boolean {
    if (value === undefined) return true;
    assertJson(value);
    if (!value || typeof value !== 'object' || typeof value.startsBudgetClock !== 'boolean'
      || Object.keys(value).length !== 1) throw new Error('Invalid provider dispatch disposition');
    if (value.startsBudgetClock && envelope.startsBudgetClock !== true)
      throw new Error('Provider cannot start an unrequested budget clock');
    return value.startsBudgetClock;
  }

  private dispatchContext(state: CampaignState, record: OperationRecord, batchOrdinal: number): ProviderDispatchContext {
    const spent = Object.freeze({ ...state.spent });
    const reservedExcludingSelf: Record<string, number> = {};
    const records = [...Object.values(state.operations),
      ...Object.values(state.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))];
    for (const other of records) {
      if (other.envelope.operationId === record.envelope.operationId || other.released) continue;
      for (const [dimension, amount] of Object.entries(other.envelope.limits))
        reservedExcludingSelf[dimension] = (reservedExcludingSelf[dimension] ?? 0)
          + Math.max(0, amount - (other.accounted[dimension] ?? 0));
    }
    return Object.freeze({ ...(state.budgetStartedAt === undefined ? {} : { budgetStartedAt: state.budgetStartedAt }),
      dispatchAdmitted: record.dispatchAdmitted === true, spent,
      reservedExcludingSelf: Object.freeze(reservedExcludingSelf), batchOrdinal });
  }

  private async prepareObservation(record: OperationRecord, context: ProviderDispatchContext): Promise<PreparedObservation> {
    const { provider, manifest, digest } = this.provider(record.envelope.kind);
    if (digest !== record.providerManifestDigest) throw new Error('Provider manifest drift');
    if (record.status === 'cancel-pending' || (record.status === 'cancelled' && !record.released)) {
      let cancelled: ProviderInspection;
      try { cancelled = await provider.cancel(record.envelope); }
      catch (error) {
        if (error instanceof ProviderProtocolError) throw error;
        return { kind: 'observed', observation: { kind: 'inspect', value: { status: 'unknown' } } };
      }
      this.validateInspection(cancelled);
      return { kind: 'observed', observation: { kind: 'inspect', value: cancelled } };
    }
    const inspected = await provider.inspect(record.envelope);
    this.validateInspection(inspected);
    if (inspected.status === 'replay-safe' && manifest.supportsIdempotentReplay !== true)
      throw new Error(`Provider did not declare idempotent replay: ${record.envelope.kind}`);
    if (!['not-started', 'replay-safe'].includes(inspected.status) || record.status === 'cancelled')
      return { kind: 'observed', observation: { kind: 'inspect', value: inspected } };
    const priorReceipt = inspected.status === 'replay-safe' || inspected.status === 'not-started'
      ? inspected.receipt : undefined;
    try {
      const preflight = await provider.preflight(record.envelope);
      const preflightClock = this.dispatchClockDisposition(preflight, record.envelope);
      this.store.assertLease();
      const prepared = provider.prepareForDispatch
        ? await provider.prepareForDispatch(record.envelope, context) : undefined;
      const preparedClock = this.dispatchClockDisposition(prepared, record.envelope);
      return { kind: 'ready', provider, envelope: record.envelope,
        ...(priorReceipt ? { priorReceipt } : {}),
        startsBudgetClock: record.envelope.startsBudgetClock === true && preflightClock && preparedClock };
    } catch (error) {
      return { kind: 'observed', observation: priorReceipt
        ? { kind: 'preflight-error', error, priorReceipt }
        : { kind: 'preflight-error', error } };
    }
  }

  private async submitPrepared(prepared: Extract<PreparedObservation, { kind: 'ready' }>): Promise<Observation> {
    const { provider, envelope, priorReceipt } = prepared;
    this.store.assertLease();
    let submitted;
    try { submitted = await provider.submit(envelope); }
    catch (error) {
      if (error instanceof ProviderProtocolError) return priorReceipt
        ? { kind: 'submit-protocol-error', error, priorReceipt }
        : { kind: 'submit-protocol-error', error };
      return priorReceipt ? { kind: 'submit-unknown', priorReceipt } : { kind: 'submit-unknown' };
    }
    assertJson(submitted);
    if (submitted.status !== 'running' && submitted.status !== 'completed') throw new Error('Invalid provider submit status');
    return priorReceipt ? { kind: 'submit', value: submitted, priorReceipt }
      : { kind: 'submit', value: submitted };
  }

  private async dispatchBatch(batch: Array<[string, OperationRecord]>, state: CampaignState):
    Promise<{ state: CampaignState; observed: PromiseSettledResult<Observation>[] }> {
    // Preparation may persist a provider-owned plan, but it cannot start an effect.
    // A stable order gives every member of a parallel batch a deterministic view
    // of the same authoritative spend and all other held reservations.
    const prepared: PromiseSettledResult<PreparedObservation>[] = [];
    for (let index = 0; index < batch.length; index++) {
      const record = batch[index]![1];
      try { prepared.push({ status: 'fulfilled', value: await this.prepareObservation(
        record, this.dispatchContext(state, record, index)) }); }
      catch (reason) { prepared.push({ status: 'rejected', reason }); }
    }
    const ready = prepared.filter((result): result is PromiseFulfilledResult<Extract<PreparedObservation, { kind: 'ready' }>> =>
      result.status === 'fulfilled' && result.value.kind === 'ready').map(result => result.value);
    const clockStarts = state.budgetStartedAt === undefined && ready.some(result => result.startsBudgetClock);
    if (state.budgetStartedAt === undefined && ready.some(result => result.startsBudgetClock
      && batch.some(([, record]) => record.envelope.operationId === result.envelope.operationId
        && record.dispatchAdmitted === true))) throw new Error('Admitted dispatch budget clock drift');
    const newAdmitted = new Set(batch.filter(([, record]) => record.dispatchAdmitted !== true
      && ready.some(result => result.envelope.operationId === record.envelope.operationId
        && (result.provider.prepareForDispatch !== undefined || result.envelope.startsBudgetClock === true)))
      .map(([, record]) => record.envelope.operationId));
    if (clockStarts || newAdmitted.size > 0) {
      const candidate = clone(state);
      if (clockStarts) {
        candidate.budgetStartedAt = Date.now();
        if (!Number.isSafeInteger(candidate.budgetStartedAt) || candidate.budgetStartedAt < 0)
          throw new Error('Invalid Campaign budget clock timestamp');
      }
      const candidates = [...Object.values(candidate.operations),
        ...Object.values(candidate.auxiliaryOperations ?? {}).flatMap(group => Object.values(group))];
      for (const record of candidates) if (newAdmitted.has(record.envelope.operationId)) {
        record.dispatchAdmitted = true;
        newAdmitted.delete(record.envelope.operationId);
      }
      if (newAdmitted.size > 0) throw new Error('Prepared dispatch operation disappeared');
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
      await this.store.commit(candidate as unknown as JsonValue,
        clockStarts ? 'budget.clock-start' : 'operation.dispatch-admit');
      state = candidate;
    }
    const observed = await Promise.allSettled(prepared.map(result => {
      if (result.status === 'rejected') return Promise.reject(result.reason);
      if (result.value.kind === 'observed') return Promise.resolve(result.value.observation);
      return this.submitPrepared(result.value);
    }));
    return { state, observed };
  }

  private applyObservation(state: CampaignState, record: OperationRecord, observation: Observation): void {
    if (observation.kind !== 'inspect') this.applyReceipt(state, record, observation.priorReceipt);
    if (observation.kind === 'preflight-error') return;
    if (observation.kind === 'submit-unknown' || observation.kind === 'submit-protocol-error') {
      record.status = 'unknown'; return;
    }
    const result = observation.value;
    if (result.status === 'completed') { this.complete(state, record, result.completion); return; }
    this.applyReceipt(state, record, result.receipt);
    if (observation.kind === 'inspect') {
      if (result.status === 'cancelled') { if (result.releaseConfirmed) this.requireFinalReceipt(record, result.receipt, this.provider(record.envelope.kind).manifest); record.status = 'cancelled'; record.released = result.releaseConfirmed; return; }
      if (record.status === 'cancel-pending' || record.status === 'cancelled') return;
      if (result.status === 'unknown' || result.status === 'replay-safe') { record.status = 'unknown'; return; }
      if (result.status === 'running') { record.status = 'running'; if (result.handle) record.handle = result.handle; return; }
      return;
    }
    if (result.status === 'running') { record.status = 'running'; if (result.handle) record.handle = result.handle; }
  }

  async tick(): Promise<'complete' | 'waiting' | 'advanced'> {
    return this.withHydratedWriter(async loaded => (await this.tickLocked(loaded)).status);
  }

  private async tickLocked(loaded: CampaignState | null): Promise<{
    status: 'complete' | 'waiting' | 'advanced'; state: CampaignState
  }> {
      if (!loaded) {
        this.validateBinding(this.spec.initialBindingSetRef, this.spec.initialBindingSetRef);
        const base: CampaignState = { version: 1, spec: clone(this.spec), ...(this.storageBackendDigest ? { storageBackendDigest: this.storageBackendDigest } : {}), algorithmManifestDigest: jsonDigest(this.manifest), kernelImplementationDigest: kernelImplementationDigest(), providerCatalogDigest: this.providerCatalogDigest, activeBindingSetRef: this.spec.initialBindingSetRef, initialBindingSetRef: this.spec.initialBindingSetRef, state: null, decisionIndex: 0, operations: {}, spent: {}, receiptSources: {}, phase: 'running' };
        const decision = await this.algorithm.initialize({ campaignId: this.spec.campaignId, decisionIndex: 0, activeBindingSetRef: this.spec.initialBindingSetRef, config: clone(this.spec.config), budget: this.budgetSnapshot(base) });
        const initialized = this.applyDecision(base, decision);
        await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
        await this.store.commit(initialized as unknown as JsonValue, 'decision.initialize');
        return { status: initialized.phase === 'complete' ? 'complete' : 'advanced', state: initialized };
      }
      let state: CampaignState = loaded;
      if (state.phase === 'complete') return { status: 'complete', state };
      if (Object.values(state.auxiliaryOperations ?? {}).some(group =>
        Object.values(group).some(record => record.status !== 'completed' && !(record.status === 'cancelled' && record.released))))
        return { status: 'waiting', state };
      const pending = Object.entries(state.operations).filter(([, record]) => record.status !== 'completed' && !(record.status === 'cancelled' && record.released)).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (let offset = 0; offset < pending.length; offset += 8) {
        const batch = pending.slice(offset, offset + 8);
        const dispatched = await this.dispatchBatch(batch, state);
        state = dispatched.state;
        const observed = dispatched.observed;
        let failure: unknown;
        for (let index = 0; index < batch.length; index++) {
          const result = observed[index]!;
          if (result.status === 'rejected') { failure ??= result.reason; continue; }
          const key = batch[index]![0];
          const candidate: CampaignState = clone(state);
          const record = candidate.operations[key]!;
          try { this.applyObservation(candidate, record, result.value); }
          catch (error) { failure ??= error; continue; }
          await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
          await this.store.commit(candidate as unknown as JsonValue, `operation.${record.status}`);
          state = candidate;
          if (result.value.kind === 'submit-protocol-error' || result.value.kind === 'preflight-error')
            failure ??= result.value.error;
        }
        if (failure) throw failure;
      }
      if (Object.values(state.operations).every(record => record.status === 'completed' || (record.status === 'cancelled' && record.released))) {
        const completed = Object.fromEntries(Object.entries(state.operations).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, record]) => [key, record.outcome ?? { kind: 'cancelled' }])) as Record<string, OperationOutcome>;
        const decision = await this.algorithm.reduce({ campaignId: state.spec.campaignId, decisionIndex: state.decisionIndex + 1, activeBindingSetRef: state.activeBindingSetRef, config: clone(state.spec.config), budget: this.budgetSnapshot(state), state: clone(state.state), completed });
        state.decisionIndex++;
        state = this.applyDecision(state, decision);
        await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
        await this.store.commit(state as unknown as JsonValue, 'decision.reduce');
        return { status: state.phase === 'complete' ? 'complete' : 'advanced', state };
      }
      return { status: 'waiting', state };
  }

  async runUntilBlocked(maxTicks = 100): Promise<'complete' | 'waiting'> {
    for (let i = 0; i < maxTicks; i++) { const result = await this.tick(); if (result !== 'advanced') return result; }
    throw new Error('Maximum decisions exceeded');
  }

  /** Advances a SearchJournal-owned run under one writer lease. Each step still
   * flushes and commits independently; callbacks run between committed steps.
   * Callers must already own the SearchJournal's cross-process single writer. */
  async runWithWriterUntilBlocked(hooks: {
    beforeTick?: () => void | Promise<void>;
    onAdvanced?: (scientificState: Readonly<JsonValue>) => void | Promise<void>;
  } = {}, maxTicks = Number.MAX_SAFE_INTEGER): Promise<'complete' | 'waiting'> {
    if (this.store.writerHydrates !== true)
      throw new Error('Continuous Campaign writer requires a journal-backed store');
    if (!Number.isSafeInteger(maxTicks) || maxTicks < 1)
      throw new Error('Continuous Campaign writer needs a positive safe step limit');
    return this.withHydratedWriter(async loaded => {
      let state = loaded;
      for (let index = 0; index < maxTicks; index++) {
        await hooks.beforeTick?.();
        this.store.assertLease();
        const step = await this.tickLocked(state);
        state = step.state;
        if (step.status !== 'advanced') return step.status;
        await hooks.onAdvanced?.(frozenCopy(state.state));
      }
      throw new Error('Maximum decisions exceeded');
    });
  }

  /** Adds one host-authorized repair group without changing a scientific decision. */
  async enqueueAuxiliary(groupId: string, intents: OperationIntent[]): Promise<void> {
    validName(groupId);
    if (!Array.isArray(intents) || intents.length === 0) throw new Error('Auxiliary group needs operations');
    const keys = intents.map(intent => intent.localKey);
    for (const key of keys) validName(key);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate auxiliary local key');
    await this.withHydratedWriter(async () => {
      const state = this.load();
      if (!state || state.phase !== 'running') throw new Error('Auxiliary operation requires an active campaign');
      const previous = state.auxiliaryOperations?.[groupId];
      if (previous) {
        if (Object.keys(previous).length !== intents.length) throw new Error('Auxiliary group identity drift');
        for (const intent of intents) {
          const saved = previous[intent.localKey];
          if (!saved) throw new Error('Auxiliary group identity drift');
          const expected = this.makeOperation(state, intent, saved.envelope.operationId,
            saved.envelope.decisionIndex, saved.envelope.bindingSetRef);
          if (canonicalJson(expected.envelope) !== canonicalJson(saved.envelope)
            || expected.providerManifestDigest !== saved.providerManifestDigest)
            throw new Error('Auxiliary group identity drift');
        }
        return;
      }
      for (const group of Object.values(state.auxiliaryOperations ?? {}))
        if (Object.values(group).some(record => record.status !== 'completed' && !(record.status === 'cancelled' && record.released)))
          throw new Error('Another auxiliary group is unresolved; resume its original group ID');
      this.budgetAdmission(state, intents);
      const group: Record<string, OperationRecord> = {};
      for (const intent of intents) {
        const operationId = id([state.spec.campaignId, 'auxiliary', groupId, intent.localKey]);
        group[intent.localKey] = this.makeOperation(state, intent, operationId,
          state.decisionIndex, state.activeBindingSetRef);
      }
      state.auxiliaryOperations = { ...(state.auxiliaryOperations ?? {}), [groupId]: group };
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
      await this.store.commit(state as unknown as JsonValue, `auxiliary.${groupId}.intent`);
    });
  }

  /** Advances only one auxiliary group without calling algorithm.reduce. The host must admit safe provider kinds. */
  private async tickAuxiliary(groupId: string): Promise<'complete' | 'waiting'> {
    return this.withHydratedWriter(async () => {
      const loaded = this.load();
      if (!loaded || loaded.phase !== 'running') throw new Error('Auxiliary operation requires an active campaign');
      let state: CampaignState = loaded;
      const group = state.auxiliaryOperations?.[groupId];
      if (!group) throw new Error(`Unknown auxiliary group ${groupId}`);
      const pending = Object.entries(group).filter(([, record]) =>
        record.status !== 'completed' && !(record.status === 'cancelled' && record.released))
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      if (pending.length === 0) return 'complete';
      for (let offset = 0; offset < pending.length; offset += 8) {
        const batch = pending.slice(offset, offset + 8);
        const dispatched = await this.dispatchBatch(batch, state);
        state = dispatched.state;
        const observed = dispatched.observed;
        let failure: unknown;
        for (let index = 0; index < batch.length; index++) {
          const result = observed[index]!;
          if (result.status === 'rejected') { failure ??= result.reason; continue; }
          const key = batch[index]![0];
          const candidate: CampaignState = clone(state);
          const record = candidate.auxiliaryOperations![groupId]![key]!;
          try { this.applyObservation(candidate, record, result.value); }
          catch (error) { failure ??= error; continue; }
          if (canonicalJson(candidate) !== canonicalJson(state)) {
            await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
            await this.store.commit(candidate as unknown as JsonValue, `auxiliary.${groupId}.${record.status}`);
            state = candidate;
          }
          if (result.value.kind === 'submit-protocol-error' || result.value.kind === 'preflight-error')
            failure ??= result.value.error;
        }
        if (failure) throw failure;
      }
      if (Object.values(state.auxiliaryOperations![groupId]!).every(record =>
        record.status === 'completed' || (record.status === 'cancelled' && record.released))) return 'complete';
      // A still-running physical effect needs an explicit next caller/resume;
      // progress receipts alone do not authorize immediate re-inspection.
      return 'waiting';
    });
  }

  async runAuxiliaryUntilBlocked(groupId: string): Promise<'complete' | 'waiting'> {
    validName(groupId);
    return this.tickAuxiliary(groupId);
  }

  async cancel(localKey: string): Promise<void> {
    await this.withHydratedWriter(async () => {
      const state = this.load(); if (!state) throw new Error('Campaign not started');
      const record = state.operations[localKey]; if (!record) throw new Error(`Unknown operation ${localKey}`);
      if (record.status === 'completed' || record.status === 'cancelled') return;
      record.status = 'cancel-pending';
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
      await this.store.commit(state as unknown as JsonValue, 'operation.cancel-intent');
      const result: ProviderInspection = await this.provider(record.envelope.kind).provider.cancel(record.envelope);
      this.validateInspection(result);
      if (result.status === 'completed') this.complete(state, record, result.completion);
      else if (result.status === 'cancelled') { if (result.releaseConfirmed) this.requireFinalReceipt(record, result.receipt, this.provider(record.envelope.kind).manifest); this.applyReceipt(state, record, result.receipt); record.status = 'cancelled'; record.released = result.releaseConfirmed; }
      else this.applyReceipt(state, record, result.receipt);
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.();
      await this.store.commit(state as unknown as JsonValue, 'operation.cancel-response');
    });
  }
}
