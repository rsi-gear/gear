import type { ArtifactRef, BindingSetRef } from '../contracts.js';
import { assertJson, assertSchema, type JsonSchema, type JsonValue } from '../schema.js';

export const AUTHOR_WIRE_VERSION_V2 = 'gear.author.replay.v2' as const;
export const AUTHOR_CAPABILITIES_VERSION = 'gear.author.capabilities.v1' as const;

export type HarnessAgentV1 = { schemaVersion: 1; kind: 'harness-agent'; bindingSetRef: BindingSetRef;
  executionProfileDigest: string; proposalIndex?: number };
export type TaskSelectionV1 = { schemaVersion: 1; taskViewRef: ArtifactRef; selectedTaskIds: string[];
  cursor: { viewDigest: string; nextIndex: 0 } };
export type RoleResultV1 = { schemaVersion: 1; output: JsonValue; evidenceRef: ArtifactRef; receiptRef: ArtifactRef };
export type ProposalFailureV1 = { index: number; stage: 'edit' | 'validation' | 'derive'; code: string;
  message: string; evidenceRefs: ArtifactRef[]; checkReportRef?: ArtifactRef };
/** Only sealed identifiers enter the editor input; the host resolves the bounded feedback projection. */
export type AuthorProposalFeedbackV1 = { schemaVersion: 1; subject: HarnessAgentV1;
  taskViewRef: ArtifactRef; measurementRef: ArtifactRef; comparisonKey: string };
export type AuthorProposalEditInputV1 = { roleId: string; baseBindingSetRef: BindingSetRef;
  proposalIndex: number; feedback?: AuthorProposalFeedbackV1 };

export type ProposalBatchV1 = { schemaVersion: 1; requestedCount: number; candidates: HarnessAgentV1[];
  failures: ProposalFailureV1[] };
export type TrialV1 = { taskId: string; repeatIndex: number; status: 'completed' | 'failed' | 'invalid';
  evidenceRef?: ArtifactRef; receiptRef?: ArtifactRef; code?: string };
export type EvaluationV1 = { schemaVersion: 1; subject: HarnessAgentV1; taskViewRef: ArtifactRef;
  status: 'complete' | 'incomplete' | 'invalid'; comparable: boolean; comparisonKey?: string;
  metrics?: Record<string, number>; measurementRef?: ArtifactRef; trials: TrialV1[]; evidenceRefs: ArtifactRef[] };
export type AuthorRoleGrantV1 = { template: 'harness-editor' | 'read-only-analyst';
  kind: 'execution.workspace-edit' | 'execution.role' };
export type AuthorSelectionConfigV1 = { schemaVersion: 1; metric: { id: string;
  direction: 'maximize' | 'minimize'; comparisonPrecision: number; contractDigest: string } };
export type AuthorEvaluationConfigV1 = { schemaVersion: 1; repeatCount: number; maxTrials: number; recipePhase: string;
  samplingDigest: string; environmentDigest: string };
export type AuthorProposalConfigV1 = { schemaVersion: 1; maxCount: number };
export type AuthorCapabilitiesV1 = { version: typeof AUTHOR_CAPABILITIES_VERSION; lockDigest: string;
  roles: Record<string, AuthorRoleGrantV1>; operationLimits: Record<string, Record<string, number>>;
  execution: Record<string, JsonValue> };
export type AuthorInputV2 = { initialAgent: HarnessAgentV1; data: JsonValue; config: JsonValue;
  capabilities: AuthorCapabilitiesV1 };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} required`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key))
    throw new Error(`${label}.${key} unexpected`);
}
function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} needs SHA-256 digest`);
}
function gearDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} needs namespaced SHA-256 digest`);
}
function nonnegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}
function ref(value: unknown, schemaId: string | undefined, label: string): asserts value is ArtifactRef {
  const item = object(value, label);
  if (item.kind !== 'artifact' || (item.schemaId !== undefined && (typeof item.schemaId !== 'string' || !item.schemaId))
    || schemaId && item.schemaId !== schemaId
    || typeof item.mediaType !== 'string' || !item.mediaType) throw new Error(`${label} artifact schema mismatch`);
  digest(item.digest, `${label}.digest`); nonnegative(item.size, `${label}.size`);
}
function binding(value: unknown, label: string): asserts value is BindingSetRef {
  const item = object(value, label);
  if (item.kind !== 'binding-set' || typeof item.schemaId !== 'string' || !item.schemaId)
    throw new Error(`${label} binding-set missing`);
  digest(item.digest, `${label}.digest`);
}
export function assertHarnessAgentV1(value: unknown): asserts value is HarnessAgentV1 {
  assertJson(value); const item = object(value, 'HarnessAgent');
  exact(item, ['schemaVersion', 'kind', 'bindingSetRef', 'executionProfileDigest'], ['proposalIndex'], 'HarnessAgent');
  if (item.schemaVersion !== 1 || item.kind !== 'harness-agent') throw new Error('HarnessAgent version/kind invalid');
  binding(item.bindingSetRef, 'HarnessAgent.bindingSetRef');
  digest(item.executionProfileDigest, 'HarnessAgent.executionProfileDigest');
  if (item.proposalIndex !== undefined) nonnegative(item.proposalIndex, 'HarnessAgent.proposalIndex');
}
export function assertTaskSelectionV1(value: unknown): asserts value is TaskSelectionV1 {
  assertJson(value); const item = object(value, 'TaskSelection');
  exact(item, ['schemaVersion', 'taskViewRef', 'selectedTaskIds', 'cursor'], [], 'TaskSelection');
  if (item.schemaVersion !== 1) throw new Error('TaskSelection version invalid');
  ref(item.taskViewRef, 'task.view.v1', 'TaskSelection.taskViewRef');
  if (!Array.isArray(item.selectedTaskIds) || item.selectedTaskIds.length === 0
    || item.selectedTaskIds.some(id => typeof id !== 'string' || !id)
    || new Set(item.selectedTaskIds).size !== item.selectedTaskIds.length) throw new Error('TaskSelection IDs invalid');
  const cursor = object(item.cursor, 'TaskSelection.cursor');
  exact(cursor, ['viewDigest', 'nextIndex'], [], 'TaskSelection.cursor');
  if (cursor.viewDigest !== (item.taskViewRef as ArtifactRef).digest || cursor.nextIndex !== 0)
    throw new Error('TaskSelection cursor must start at selected view');
}
export function assertRoleResultV1(value: unknown): asserts value is RoleResultV1 {
  assertJson(value); const item = object(value, 'RoleResult');
  exact(item, ['schemaVersion', 'output', 'evidenceRef', 'receiptRef'], [], 'RoleResult');
  if (item.schemaVersion !== 1) throw new Error('RoleResult version invalid');
  ref(item.evidenceRef, undefined, 'RoleResult.evidenceRef');
  ref(item.receiptRef, 'execution.receipt.v1', 'RoleResult.receiptRef');
}
/** Decode only a verified physical execution result; a caller supplied RoleResult is not a valid substitute. */
export function decodeRoleExecutionResult(value: unknown, bindingSetDigest: string): RoleResultV1 {
  assertJson(value); const item = object(value, 'RoleExecutionResult');
  if (item.requestedBindingSetDigest !== bindingSetDigest) throw new Error('RoleExecutionResult binding drift');
  const actualBindings = object(item.actualBindings, 'RoleExecutionResult.actualBindings');
  for (const [slot, actual] of Object.entries(actualBindings)) ref(actual, undefined, `RoleExecutionResult.actualBindings.${slot}`);
  ref(item.evidenceRef, undefined, 'RoleExecutionResult.evidenceRef');
  ref(item.receiptRef, 'execution.receipt.v1', 'RoleExecutionResult.receiptRef');
  if (!Object.hasOwn(item, 'structuredResult')) throw new Error('RoleExecutionResult structuredResult missing');
  ref(item.structuredResultRef, 'execution.structured-result.v1', 'RoleExecutionResult.structuredResultRef');
  const result = { schemaVersion: 1, output: item.structuredResult, evidenceRef: item.evidenceRef,
    receiptRef: item.receiptRef };
  assertRoleResultV1(result);
  return result;
}
export function assertProposalBatchV1(value: unknown): asserts value is ProposalBatchV1 {
  assertJson(value); const item = object(value, 'ProposalBatch');
  exact(item, ['schemaVersion', 'requestedCount', 'candidates', 'failures'], [], 'ProposalBatch');
  if (item.schemaVersion !== 1) throw new Error('ProposalBatch version invalid');
  nonnegative(item.requestedCount, 'ProposalBatch.requestedCount');
  if (item.requestedCount === 0 || !Array.isArray(item.candidates) || !Array.isArray(item.failures))
    throw new Error('ProposalBatch count/outcomes invalid');
  const ordinals: number[] = [];
  for (const candidate of item.candidates) {
    assertHarnessAgentV1(candidate);
    if (candidate.proposalIndex === undefined) throw new Error('Proposal candidate ordinal missing');
    ordinals.push(candidate.proposalIndex);
  }
  for (const failure of item.failures) {
    const failed = object(failure, 'ProposalFailure');
    exact(failed, ['index', 'stage', 'code', 'message', 'evidenceRefs'], ['checkReportRef'], 'ProposalFailure');
    nonnegative(failed.index, 'ProposalFailure.index');
    if (!['edit', 'validation', 'derive'].includes(String(failed.stage)) || typeof failed.code !== 'string'
      || !failed.code || typeof failed.message !== 'string' || !Array.isArray(failed.evidenceRefs))
      throw new Error('ProposalFailure fields invalid');
    for (const evidence of failed.evidenceRefs) ref(evidence, undefined, 'ProposalFailure.evidenceRef');
    if (failed.checkReportRef !== undefined) ref(failed.checkReportRef, undefined, 'ProposalFailure.checkReportRef');
    ordinals.push(failed.index);
  }
  const candidateOrdinals = (item.candidates as HarnessAgentV1[]).map(candidate => candidate.proposalIndex!);
  const failureOrdinals = (item.failures as ProposalFailureV1[]).map(failure => failure.index);
  if (candidateOrdinals.some((index, position) => position > 0 && index <= candidateOrdinals[position - 1]!)
    || failureOrdinals.some((index, position) => position > 0 && index <= failureOrdinals[position - 1]!))
    throw new Error('ProposalBatch outcomes must be in ascending ordinal order');
  if (ordinals.length !== item.requestedCount || ordinals.sort((a, b) => a - b).some((ordinal, index) => ordinal !== index))
    throw new Error('ProposalBatch ordinals must partition the requested count');
}
export function assertEvaluationV1(value: unknown): asserts value is EvaluationV1 {
  assertJson(value); const item = object(value, 'Evaluation');
  exact(item, ['schemaVersion', 'subject', 'taskViewRef', 'status', 'comparable', 'trials', 'evidenceRefs'],
    ['comparisonKey', 'metrics', 'measurementRef'], 'Evaluation');
  if (item.schemaVersion !== 1 || !['complete', 'incomplete', 'invalid'].includes(String(item.status))
    || typeof item.comparable !== 'boolean') throw new Error('Evaluation status invalid');
  assertHarnessAgentV1(item.subject); ref(item.taskViewRef, 'task.view.v1', 'Evaluation.taskViewRef');
  if (!Array.isArray(item.trials) || !Array.isArray(item.evidenceRefs)) throw new Error('Evaluation trials/refs invalid');
  for (const evidence of item.evidenceRefs) ref(evidence, undefined, 'Evaluation.evidenceRef');
  const trialKeys = new Set<string>();
  for (const trial of item.trials) {
    const row = object(trial, 'Evaluation.trial');
    exact(row, ['taskId', 'repeatIndex', 'status'], ['evidenceRef', 'receiptRef', 'code'], 'Evaluation.trial');
    if (typeof row.taskId !== 'string' || !row.taskId || !['completed', 'failed', 'invalid'].includes(String(row.status)))
      throw new Error('Evaluation trial invalid');
    nonnegative(row.repeatIndex, 'Evaluation.trial.repeatIndex');
    const key = JSON.stringify([row.taskId, row.repeatIndex]);
    if (trialKeys.has(key)) throw new Error('Evaluation trial duplicated');
    trialKeys.add(key);
    if (row.evidenceRef !== undefined) ref(row.evidenceRef, undefined, 'Evaluation.trial.evidenceRef');
    if (row.receiptRef !== undefined) ref(row.receiptRef, undefined, 'Evaluation.trial.receiptRef');
    if (item.status === 'complete' && row.status !== 'completed')
      throw new Error('Complete Evaluation contains unfinished trial');
  }
  if (item.comparable !== (item.status === 'complete')) throw new Error('Evaluation complete/comparable mismatch');
  if (item.comparable) {
    if (item.trials.length === 0 || item.evidenceRefs.length === 0) throw new Error('Complete Evaluation needs trial evidence');
    digest(item.comparisonKey, 'Evaluation.comparisonKey');
    ref(item.measurementRef, 'measurement.record.v1', 'Evaluation.measurementRef');
    const metrics = object(item.metrics, 'Evaluation.metrics');
    if (Object.keys(metrics).length === 0 || Object.values(metrics).some(metric => typeof metric !== 'number' || !Number.isFinite(metric)))
      throw new Error('Evaluation metrics invalid');
  } else if (item.comparisonKey !== undefined || item.measurementRef !== undefined || item.metrics !== undefined)
    throw new Error('Incomplete Evaluation cannot publish aggregate metrics');
}
export function assertAuthorCapabilitiesV1(value: unknown): asserts value is AuthorCapabilitiesV1 {
  assertJson(value); const item = object(value, 'AuthorCapabilities');
  exact(item, ['version', 'lockDigest', 'roles', 'operationLimits', 'execution'], [], 'AuthorCapabilities');
  if (item.version !== AUTHOR_CAPABILITIES_VERSION) throw new Error('AuthorCapabilities version invalid');
  digest(item.lockDigest, 'AuthorCapabilities.lockDigest');
  for (const [name, raw] of Object.entries(object(item.roles, 'AuthorCapabilities.roles'))) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error(`Invalid role name ${name}`);
    const role = object(raw, `AuthorCapabilities.roles.${name}`);
    exact(role, ['template', 'kind'], [], `AuthorCapabilities.roles.${name}`);
    if (!((role.template === 'read-only-analyst' && role.kind === 'execution.role')
      || (role.template === 'harness-editor' && role.kind === 'execution.workspace-edit')))
      throw new Error(`Role ${name} template/kind mismatch`);
  }
  for (const [kind, raw] of Object.entries(object(item.operationLimits, 'AuthorCapabilities.operationLimits'))) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(kind)) throw new Error(`Invalid operation kind ${kind}`);
    const limits = object(raw, `AuthorCapabilities.operationLimits.${kind}`);
    if (['tasks.sample', 'tasks.consume', 'bindings.derive', 'author.checkpoint',
      'author.observe', 'author.measurement'].includes(kind) && Object.keys(limits).length !== 0)
      throw new Error(`${kind} is a pure operation and cannot carry limits`);
    for (const [dimension, limit] of Object.entries(limits))
      nonnegative(limit, `AuthorCapabilities.operationLimits.${kind}.${dimension}`);
  }
  const execution = object(item.execution, 'AuthorCapabilities.execution');
  if (execution.selection !== undefined) {
    const selection = object(execution.selection, 'AuthorCapabilities.execution.selection');
    exact(selection, ['schemaVersion', 'metric'], [], 'AuthorCapabilities.execution.selection');
    const metric = object(selection.metric, 'AuthorCapabilities.execution.selection.metric');
    exact(metric, ['id', 'direction', 'comparisonPrecision', 'contractDigest'], [],
      'AuthorCapabilities.execution.selection.metric');
    if (selection.schemaVersion !== 1 || typeof metric.id !== 'string' || !metric.id
      || !['maximize', 'minimize'].includes(String(metric.direction))
      || typeof metric.comparisonPrecision !== 'number' || !Number.isFinite(metric.comparisonPrecision)
      || metric.comparisonPrecision <= 0)
      throw new Error('Author selection metric configuration invalid');
    gearDigest(metric.contractDigest, 'Author selection metric contract');
  }
  if (execution.evaluation !== undefined) {
    const evaluation = object(execution.evaluation, 'AuthorCapabilities.execution.evaluation');
    exact(evaluation, ['schemaVersion', 'repeatCount', 'maxTrials', 'recipePhase', 'samplingDigest', 'environmentDigest'], [],
      'AuthorCapabilities.execution.evaluation');
    if (evaluation.schemaVersion !== 1 || !Number.isSafeInteger(evaluation.repeatCount)
      || (evaluation.repeatCount as number) < 1 || (evaluation.repeatCount as number) > 100
      || !Number.isSafeInteger(evaluation.maxTrials) || (evaluation.maxTrials as number) < 1
      || (evaluation.maxTrials as number) > 128
      || evaluation.recipePhase !== 'author.evaluate')
      throw new Error('Author evaluation configuration invalid');
    gearDigest(evaluation.samplingDigest, 'Author evaluation sampling');
    gearDigest(evaluation.environmentDigest, 'Author evaluation environment');
    const rolloutLimits = object(object(item.operationLimits, 'AuthorCapabilities.operationLimits')['execution.rollout'],
      'AuthorCapabilities.operationLimits.execution.rollout');
    exact(rolloutLimits, ['rollout.trials'], [], 'AuthorCapabilities.operationLimits.execution.rollout');
    if (rolloutLimits['rollout.trials'] !== 1) throw new Error('Author evaluation requires one rollout trial reservation');
  }
  if (execution.proposal !== undefined) {
    const proposal = object(execution.proposal, 'AuthorCapabilities.execution.proposal');
    exact(proposal, ['schemaVersion', 'maxCount'], [], 'AuthorCapabilities.execution.proposal');
    if (proposal.schemaVersion !== 1 || !Number.isSafeInteger(proposal.maxCount)
      || (proposal.maxCount as number) < 1 || (proposal.maxCount as number) > 100)
      throw new Error('Author proposal count bound invalid');
  }
}
export function assertAuthorConfigSchema(value: JsonSchema): void { assertSchema(value); }
