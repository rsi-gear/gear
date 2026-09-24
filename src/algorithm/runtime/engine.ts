import { createHash } from 'node:crypto';
import type { Algorithm, AlgorithmDecision, AlgorithmManifest, BudgetPlan, BudgetSnapshot, CampaignSpec, CompletionEnvelope, OperationEnvelope, OperationIntent, OperationOutcome, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt, BindingSetRef } from '../contracts.js';
import { ALGORITHM_API_VERSION } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, validateSchema, type JsonValue } from '../schema.js';
import { CampaignStore } from './store.js';
import { BindingDeriveProvider } from './providers.js';
import { kernelImplementationDigest } from './identity.js';

type OperationRecord = {
  envelope: OperationEnvelope;
  providerManifestDigest: string;
  status: 'intent' | 'running' | 'unknown' | 'completed' | 'cancel-pending' | 'cancelled';
  handle?: string;
  outcome?: OperationOutcome;
  accounted: Record<string, number>;
  released: boolean;
};
type ReceiptCursor = { cursor: string; cumulative: Record<string, number> };
type Observation = { kind: 'inspect'; value: ProviderInspection } | { kind: 'submit'; value: ProviderSubmission } | { kind: 'submit-unknown' };
export type CampaignState = {
  version: 1;
  spec: CampaignSpec;
  algorithmManifestDigest: string;
  kernelImplementationDigest: string;
  providerCatalogDigest: string;
  activeBindingSetRef: BindingSetRef;
  initialBindingSetRef: BindingSetRef;
  state: JsonValue;
  decisionIndex: number;
  operations: Record<string, OperationRecord>;
  spent: Record<string, number>;
  receiptSources: Record<string, ReceiptCursor>;
  phase: 'running' | 'complete';
};

function id(value: JsonValue): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function validName(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Invalid identifier: ${value}`); }
function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }

export class AlgorithmRuntime {
  readonly artifacts: FileArtifactStore;
  readonly bindings: BindingStore;
  readonly store: CampaignStore<JsonValue>;
  private readonly providers = new Map<string, OperationProvider>();
  private readonly providerManifestDigests = new Map<string, string>();
  private readonly providerCatalogDigest: string;
  private readonly manifest: AlgorithmManifest;

  constructor(readonly root: string, readonly algorithm: Algorithm, providers: OperationProvider[], readonly spec: CampaignSpec) {
    this.artifacts = new FileArtifactStore(`${root}/artifacts`);
    this.manifest = algorithm.describe();
    if (this.manifest.apiVersion !== ALGORITHM_API_VERSION) throw new Error('Algorithm API version mismatch');
    validName(this.manifest.id); validName(spec.campaignId);
    if (!/^[a-f0-9]{64}$/.test(this.manifest.implementationDigest)) throw new Error('Algorithm implementation digest required');
    assertSchema(this.manifest.stateSchema);
    validateSchema(this.manifest.configSchema, spec.config);
    this.bindings = new BindingStore(this.artifacts, this.manifest.bindingSchema);
    this.store = new CampaignStore<JsonValue>(`${root}/campaign`);
    for (const provider of [new BindingDeriveProvider(this.bindings), ...providers]) {
      const manifest = provider.describe(); this.validateProviderManifest(manifest);
      if (this.providers.has(manifest.kind)) throw new Error(`Duplicate provider ${manifest.kind}`);
      this.providers.set(manifest.kind, provider);
      this.providerManifestDigests.set(manifest.kind, jsonDigest(manifest));
    }
    const requiredKinds = this.manifest.requiredOperationKinds ?? [];
    if (!Array.isArray(requiredKinds) || new Set(requiredKinds).size !== requiredKinds.length)
      throw new Error('Algorithm requiredOperationKinds must be a unique array');
    for (const kind of requiredKinds) {
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
    if (manifest.supportsInspect !== true || !['trusted-local', 'external'].includes(manifest.execution)) throw new Error('Invalid provider capabilities');
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
    for (const operation of Object.values(state.operations)) if (!operation.released) {
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
    for (const operation of Object.values(state.operations)) if (!operation.released) {
      for (const [dimension, amount] of Object.entries(operation.envelope.limits)) {
        reserved[dimension] = (reserved[dimension] ?? 0) + Math.max(0, amount - (operation.accounted[dimension] ?? 0));
      }
    }
    return { dimensions: Object.fromEntries(Object.entries(state.spec.budget).map(([dimension, plan]) => {
      const spent = state.spent[dimension] ?? 0, held = reserved[dimension] ?? 0;
      return [dimension, { ...plan, spent, reserved: held, remaining: Math.max(0, plan.limit - spent - held) }];
    })) };
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
      validName(intent.localKey);
      validName(intent.kind);
      if (!Object.hasOwn(intent, 'input')) throw new Error('Operation input required');
      if (intent.limits !== undefined && (typeof intent.limits !== 'object' || intent.limits === null || Array.isArray(intent.limits))) throw new Error('Operation limits must be an object');
      if (next.operations[intent.localKey]) throw new Error(`Duplicate local key ${intent.localKey}`);
      const { manifest, digest } = this.provider(intent.kind);
      validateSchema(manifest.inputSchema, intent.input);
      this.artifacts.verifyContentRefs(intent.input, this.bindings);
      const bindingSetRef = intent.bindingSetRef ?? active;
      this.validateBinding(bindingSetRef, next.initialBindingSetRef);
      const limits = intent.limits ?? {};
      for (const dimension of manifest.meteredDimensions) if (!Object.hasOwn(limits, dimension)) throw new Error(`Missing reservation ${dimension}`);
      for (const dimension of Object.keys(limits)) {
        if (!manifest.meteredDimensions.includes(dimension)) throw new Error(`Provider does not meter ${dimension}`);
        if (next.spec.budget[dimension]?.capability === 'hard' && !manifest.hardLimitDimensions?.includes(dimension)) throw new Error(`Provider cannot enforce hard limit ${dimension}`);
      }
      const operationId = id([next.spec.campaignId, next.decisionIndex, intent.localKey]);
      const envelope: OperationEnvelope = {
        operationId, idempotencyKey: operationId, campaignId: next.spec.campaignId, decisionIndex: next.decisionIndex,
        localKey: intent.localKey, kind: intent.kind, input: intent.input, inputDigest: jsonDigest(intent.input),
        implementationDigest: manifest.implementationDigest, bindingSetRef, limits,
      };
      next.operations[intent.localKey] = { envelope, providerManifestDigest: digest, status: 'intent', accounted: {}, released: false };
    }
    if (decision.complete) next.phase = 'complete';
    return next;
  }

  private load(): CampaignState | null {
    const saved = this.store.load();
    if (!saved) return null;
    for (const kind of this.providers.keys()) this.provider(kind);
    const state = saved.state as unknown as CampaignState;
    if (state.version !== 1 || canonicalJson(state.spec) !== canonicalJson(this.spec) || state.algorithmManifestDigest !== jsonDigest(this.manifest) || state.kernelImplementationDigest !== kernelImplementationDigest() || state.providerCatalogDigest !== this.providerCatalogDigest) throw new Error('Campaign identity drift');
    this.validateBinding(state.activeBindingSetRef, state.initialBindingSetRef);
    validateSchema(this.manifest.stateSchema, state.state);
    for (const record of Object.values(state.operations)) {
      const { manifest, digest } = this.provider(record.envelope.kind);
      if (digest !== record.providerManifestDigest || manifest.implementationDigest !== record.envelope.implementationDigest || jsonDigest(record.envelope.input) !== record.envelope.inputDigest) throw new Error('Operation identity drift');
      this.validateBinding(record.envelope.bindingSetRef, state.initialBindingSetRef);
    }
    return state;
  }

  snapshot(): CampaignState | null { return this.load(); }

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
    if (value.status === 'unknown' || value.status === 'not-started') return;
    throw new Error('Invalid provider inspect status');
  }

  private async observe(record: OperationRecord): Promise<Observation> {
    const { provider, digest } = this.provider(record.envelope.kind);
    if (digest !== record.providerManifestDigest) throw new Error('Provider manifest drift');
    if (record.status === 'cancel-pending' || (record.status === 'cancelled' && !record.released)) {
      let cancelled: ProviderInspection;
      try { cancelled = await provider.cancel(record.envelope); }
      catch { return { kind: 'inspect', value: { status: 'unknown' } }; }
      this.validateInspection(cancelled);
      return { kind: 'inspect', value: cancelled };
    }
    const inspected = await provider.inspect(record.envelope);
    this.validateInspection(inspected);
    if (inspected.status !== 'not-started' || record.status === 'cancelled') return { kind: 'inspect', value: inspected };
    await provider.preflight(record.envelope);
    this.store.assertLease();
    let submitted;
    try { submitted = await provider.submit(record.envelope); }
    catch { return { kind: 'submit-unknown' }; }
    assertJson(submitted);
    if (submitted.status !== 'running' && submitted.status !== 'completed') throw new Error('Invalid provider submit status');
    return { kind: 'submit', value: submitted };
  }

  private applyObservation(state: CampaignState, record: OperationRecord, observation: Observation): void {
    if (observation.kind === 'submit-unknown') { record.status = 'unknown'; return; }
    const result = observation.value;
    if (result.status === 'completed') { this.complete(state, record, result.completion); return; }
    this.applyReceipt(state, record, result.receipt);
    if (observation.kind === 'inspect') {
      if (result.status === 'cancelled') { if (result.releaseConfirmed) this.requireFinalReceipt(record, result.receipt, this.provider(record.envelope.kind).manifest); record.status = 'cancelled'; record.released = result.releaseConfirmed; return; }
      if (record.status === 'cancel-pending' || record.status === 'cancelled') return;
      if (result.status === 'unknown') { record.status = 'unknown'; return; }
      if (result.status === 'running') { record.status = 'running'; if (result.handle) record.handle = result.handle; return; }
      return;
    }
    if (result.status === 'running') { record.status = 'running'; if (result.handle) record.handle = result.handle; }
  }

  async tick(): Promise<'complete' | 'waiting' | 'advanced'> {
    return this.store.withWriter(async () => {
      const loaded = this.load();
      if (!loaded) {
        this.validateBinding(this.spec.initialBindingSetRef, this.spec.initialBindingSetRef);
        const base: CampaignState = { version: 1, spec: clone(this.spec), algorithmManifestDigest: jsonDigest(this.manifest), kernelImplementationDigest: kernelImplementationDigest(), providerCatalogDigest: this.providerCatalogDigest, activeBindingSetRef: this.spec.initialBindingSetRef, initialBindingSetRef: this.spec.initialBindingSetRef, state: null, decisionIndex: 0, operations: {}, spent: {}, receiptSources: {}, phase: 'running' };
        const decision = await this.algorithm.initialize({ campaignId: this.spec.campaignId, decisionIndex: 0, activeBindingSetRef: this.spec.initialBindingSetRef, config: clone(this.spec.config), budget: this.budgetSnapshot(base) });
        const initialized = this.applyDecision(base, decision);
        await this.store.commit(initialized as unknown as JsonValue, 'decision.initialize');
        return initialized.phase === 'complete' ? 'complete' : 'advanced';
      }
      let state: CampaignState = loaded;
      if (state.phase === 'complete') return 'complete';
      const pending = Object.entries(state.operations).filter(([, record]) => record.status !== 'completed' && !(record.status === 'cancelled' && record.released)).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (let offset = 0; offset < pending.length; offset += 8) {
        const batch = pending.slice(offset, offset + 8);
        const observed = await Promise.allSettled(batch.map(([, record]) => this.observe(record)));
        let failure: unknown;
        for (let index = 0; index < batch.length; index++) {
          const result = observed[index]!;
          if (result.status === 'rejected') { failure ??= result.reason; continue; }
          const key = batch[index]![0];
          const candidate: CampaignState = clone(state);
          const record = candidate.operations[key]!;
          try { this.applyObservation(candidate, record, result.value); }
          catch (error) { failure ??= error; continue; }
          await this.store.commit(candidate as unknown as JsonValue, `operation.${record.status}`);
          state = candidate;
        }
        if (failure) throw failure;
      }
      if (Object.values(state.operations).every(record => record.status === 'completed' || (record.status === 'cancelled' && record.released))) {
        const completed = Object.fromEntries(Object.entries(state.operations).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, record]) => [key, record.outcome ?? { kind: 'cancelled' }])) as Record<string, OperationOutcome>;
        const decision = await this.algorithm.reduce({ campaignId: state.spec.campaignId, decisionIndex: state.decisionIndex + 1, activeBindingSetRef: state.activeBindingSetRef, config: clone(state.spec.config), budget: this.budgetSnapshot(state), state: clone(state.state), completed });
        state.decisionIndex++;
        state = this.applyDecision(state, decision);
        await this.store.commit(state as unknown as JsonValue, 'decision.reduce');
        return state.phase === 'complete' ? 'complete' : 'advanced';
      }
      return 'waiting';
    });
  }

  async runUntilBlocked(maxTicks = 100): Promise<'complete' | 'waiting'> {
    for (let i = 0; i < maxTicks; i++) { const result = await this.tick(); if (result !== 'advanced') return result; }
    throw new Error('Maximum decisions exceeded');
  }

  async cancel(localKey: string): Promise<void> {
    await this.store.withWriter(async () => {
      const state = this.load(); if (!state) throw new Error('Campaign not started');
      const record = state.operations[localKey]; if (!record) throw new Error(`Unknown operation ${localKey}`);
      if (record.status === 'completed' || record.status === 'cancelled') return;
      record.status = 'cancel-pending'; await this.store.commit(state as unknown as JsonValue, 'operation.cancel-intent');
      const result: ProviderInspection = await this.provider(record.envelope.kind).provider.cancel(record.envelope);
      this.validateInspection(result);
      if (result.status === 'completed') this.complete(state, record, result.completion);
      else if (result.status === 'cancelled') { if (result.releaseConfirmed) this.requireFinalReceipt(record, result.receipt, this.provider(record.envelope.kind).manifest); this.applyReceipt(state, record, result.receipt); record.status = 'cancelled'; record.released = result.releaseConfirmed; }
      else this.applyReceipt(state, record, result.receipt);
      await this.store.commit(state as unknown as JsonValue, 'operation.cancel-response');
    });
  }
}
