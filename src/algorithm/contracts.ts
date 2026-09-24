import type { JsonSchema, JsonValue } from './schema.js';

export const ALGORITHM_API_VERSION = 'gear.algorithm.experimental.v1';
export type ArtifactRef = { kind: 'artifact'; digest: string; size: number; mediaType: string; schemaId?: string };
export type BindingSetRef = { kind: 'binding-set'; digest: string; schemaId: string };
export type BindingSet = { apiVersion: typeof ALGORITHM_API_VERSION; schemaId: string; slots: Record<string, ArtifactRef> };
export type BindingSchema = { id: string; slots: Record<string, { schemaId: string; required?: boolean; replaceable?: boolean }> };

export type ResourceLimit = { unit: string; limit: number; source: string; capability: 'hard' | 'stop' };
export type BudgetPlan = Record<string, ResourceLimit>;
/** Read-only accounting view at a decision boundary; remaining excludes live reservations. */
export type BudgetSnapshot = { dimensions: Record<string, ResourceLimit & { spent: number; reserved: number; remaining: number }> };
export type UsageReceipt = { source: string; scope?: 'operation' | 'campaign'; operationId?: string; cursor: string; cumulative: Record<string, number> };

export type OperationIntent = {
  localKey: string;
  kind: string;
  input: JsonValue;
  bindingSetRef?: BindingSetRef;
  limits?: Record<string, number>;
};
export type OperationOutcome =
  | { kind: 'result'; value: JsonValue }
  | { kind: 'no-result'; reason?: string }
  | { kind: 'inconclusive'; reason: string }
  | { kind: 'cancelled'; reason?: string }
  | { kind: 'error'; code: string; message: string; retryable?: boolean };

export type OperationEnvelope = {
  operationId: string;
  idempotencyKey: string;
  campaignId: string;
  decisionIndex: number;
  localKey: string;
  kind: string;
  input: JsonValue;
  inputDigest: string;
  implementationDigest: string;
  bindingSetRef: BindingSetRef;
  limits: Record<string, number>;
};
export type CompletionEnvelope = {
  operationId: string;
  idempotencyKey: string;
  inputDigest: string;
  implementationDigest: string;
  outcome: OperationOutcome;
  receipt?: UsageReceipt;
};
export type ProviderManifest = {
  kind: string;
  implementationDigest: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  meteredDimensions: string[];
  hardLimitDimensions?: string[];
  execution: 'trusted-local' | 'external';
  supportsInspect: true;
};
export type ProviderInspection =
  | { status: 'not-started' | 'unknown'; receipt?: UsageReceipt }
  | { status: 'running'; handle?: string; receipt?: UsageReceipt }
  | { status: 'completed'; completion: CompletionEnvelope }
  | { status: 'cancelled'; releaseConfirmed: boolean; receipt?: UsageReceipt };
export type ProviderSubmission =
  | { status: 'running'; handle?: string; receipt?: UsageReceipt }
  | { status: 'completed'; completion: CompletionEnvelope };
export interface OperationProvider {
  describe(): ProviderManifest;
  preflight(envelope: OperationEnvelope): Promise<void> | void;
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission>;
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection>;
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection>;
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope>;
}

export type AlgorithmDecision = {
  nextState: JsonValue;
  operations?: OperationIntent[];
  bindingTransition?: BindingSetRef;
  complete?: boolean;
};
export type AlgorithmManifest = {
  id: string;
  apiVersion: typeof ALGORITHM_API_VERSION;
  implementationDigest: string;
  stateSchema: JsonSchema;
  configSchema: JsonSchema;
  bindingSchema: BindingSchema;
  /** Operation kinds required before a campaign can be admitted. */
  requiredOperationKinds?: string[];
};
export type CampaignSpec = {
  campaignId: string;
  config: JsonValue;
  initialBindingSetRef: BindingSetRef;
  budget: BudgetPlan;
  components?: Record<string, ComponentManifest>;
};
export type DecisionContext = {
  campaignId: string;
  decisionIndex: number;
  activeBindingSetRef: BindingSetRef;
  config: JsonValue;
  budget?: BudgetSnapshot;
};
export type ReduceContext = DecisionContext & {
  state: JsonValue;
  completed: Record<string, OperationOutcome>;
};
export interface Algorithm {
  describe(): AlgorithmManifest;
  initialize(context: DecisionContext): Promise<AlgorithmDecision> | AlgorithmDecision;
  reduce(context: ReduceContext): Promise<AlgorithmDecision> | AlgorithmDecision;
}

export type ComponentManifest = {
  id: string;
  scope: 'campaign' | 'decision';
  apiVersion: typeof ALGORITHM_API_VERSION;
  implementationDigest: string;
  environmentDigest: string;
  language: 'typescript' | 'python';
  entrypoint: { module: string; export: string; interpreter?: string };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  capabilities: string[];
  failureSemantics: 'typed-error';
};
