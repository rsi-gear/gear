import type { ArtifactRef, BudgetSnapshot, OperationOutcome } from '../contracts.js';
import type { JsonSchema, JsonValue } from '../schema.js';
import type { HarnessAgentV1, TaskSelectionV1, EvaluationV1, ProposalBatchV1, RoleResultV1 } from './a1-contract.js';

export const STEP_API_VERSION = 'gear.algorithm.step.v1' as const;
/** A Candidate names an immutable tested version. Its score belongs to an Evaluation. */
export type Candidate = Readonly<HarnessAgentV1>;
export type TaskSelection = TaskSelectionV1;
export type Evaluation = Omit<EvaluationV1, 'status' | 'comparable' | 'metrics' | 'measurementRef' | 'comparisonKey'> & (
  { status: 'complete'; comparable: true; metrics: Record<string, number>; measurementRef: ArtifactRef; comparisonKey: string }
  | { status: 'incomplete' | 'invalid'; comparable: false; metrics?: never; measurementRef?: never; comparisonKey?: never });
export type Task = { id: string; prompt: string; purpose: 'train' | 'development';
  exposure: { seenInTraining: boolean; graderLabelExposed: boolean }; ancestry: string[] };
export type Evidence = ArtifactRef;
export type Proposals = ProposalBatchV1;
export type RoleResult = RoleResultV1;
export type Failure = Exclude<OperationOutcome, { kind: 'result' }>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export type ServiceRequest<T = unknown> = (
  | { service: 'sample'; source: ArtifactRef; count: number; seed: number }
  | { service: 'tasks'; selection: TaskSelection | ArtifactRef }
  | { service: 'select'; taskIds: string[]; purpose: 'train' | 'development' }
  | { service: 'propose'; parent: Candidate; role: string; count: number; feedback?: Evaluation }
  | { service: 'evaluate'; candidate: Candidate; tasks: TaskSelection }
  | { service: 'role'; role: string; input: JsonValue; candidate?: Candidate }
  | { service: 'call'; capability: string; input: JsonValue; candidate?: Candidate }
) & { readonly resultType?: T };
/** Requests describe effects; constructing one never starts work. */
export const services = {
  sample(source: ArtifactRef, count: number, seed = 0): ServiceRequest<TaskSelection> {
    return { service: 'sample', source, count, seed };
  },
  tasks(selection: TaskSelection | ArtifactRef): ServiceRequest<Task[]> { return { service: 'tasks', selection }; },
  select(taskIds: string[], purpose: 'train' | 'development' = 'development'): ServiceRequest<TaskSelection> {
    return { service: 'select', taskIds, purpose };
  },
  propose(parent: Candidate, options: { role: string; count?: number; feedback?: Evaluation }): ServiceRequest<Proposals> {
    return { service: 'propose', parent, role: options.role, count: options.count ?? 1,
      ...(options.feedback ? { feedback: options.feedback } : {}) };
  },
  evaluate(candidate: Candidate, tasks: TaskSelection): ServiceRequest<Evaluation> {
    return { service: 'evaluate', candidate, tasks };
  },
  role(role: string, input: JsonValue, candidate?: Candidate): ServiceRequest<RoleResult> {
    return { service: 'role', role, input, ...(candidate ? { candidate } : {}) };
  },
  /** Additional host-granted capabilities use the same journal and accounting. */
  call<T = JsonValue>(capability: string, input: JsonValue, candidate?: Candidate): ServiceRequest<T> {
    return { service: 'call', capability, input, ...(candidate ? { candidate } : {}) };
  },
};
export type StepDecision<S = unknown> =
  | { status: 'run'; state: S; requests: Record<string, ServiceRequest> }
  | { status: 'complete'; result: { selected?: Candidate; outputs?: unknown } };
export class Results {
  constructor(readonly values: Record<string, Result<unknown>>) {}
  get<T>(name: string): Result<T> {
    const result = this.values[name];
    if (!result) throw new Error(`No service result named ${name}`);
    return result as Result<T>;
  }
}
export class StepContext<S = unknown, C = JsonValue> {
  readonly services = services;
  readonly results: Results;
  constructor(readonly state: S | null, completed: Record<string, Result<unknown>>,
    readonly config: C, readonly initialCandidate: Candidate, readonly taskSource: ArtifactRef,
    readonly budget: BudgetSnapshot, readonly stepIndex: number) {
    this.results = new Results(completed);
  }
  run(state: S, requests: Record<string, ServiceRequest>): StepDecision<S> {
    return { status: 'run', state, requests };
  }
  finish(result: { selected?: Candidate; outputs?: unknown } = {}): StepDecision<S> {
    return { status: 'complete', result };
  }
}
export interface Algorithm<S = unknown, C = JsonValue> {
  describe(): { apiVersion: typeof STEP_API_VERSION; id: string; configSchema: JsonSchema; stateSchema: JsonSchema };
  step(context: StepContext<S, C>): StepDecision<S> | Promise<StepDecision<S>>;
}
export function algorithm<S = unknown, C = JsonValue>(step: Algorithm<S, C>['step'],
  options: { id?: string; configSchema?: JsonSchema; stateSchema?: JsonSchema } = {}): Algorithm<S, C> {
  return { describe: () => ({ apiVersion: STEP_API_VERSION, id: options.id ?? 'search',
    configSchema: options.configSchema ?? { type: 'object', additionalProperties: true },
    stateSchema: options.stateSchema ?? { type: 'any' } }), step };
}
/** A reproduction pool, chosen by the algorithm. The Campaign remains the factual history. */
export class Archive {
  constructor(readonly candidates: readonly Candidate[] = []) {}
  add(candidate: Candidate): Archive {
    return this.candidates.some(item => item.bindingSetRef.digest === candidate.bindingSetRef.digest)
      ? this : new Archive([...this.candidates, candidate]);
  }
  toJSON(): readonly Candidate[] { return this.candidates; }
}
