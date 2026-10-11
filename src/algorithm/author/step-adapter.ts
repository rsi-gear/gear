import type { Algorithm as KernelAlgorithm, AlgorithmManifest, AlgorithmDecision, BindingSchema,
  DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js';
import { ALGORITHM_API_VERSION } from '../contracts.js';
import { assertJson, canonicalJson, jsonDigest, validateSchema, type JsonValue } from '../schema.js';
import { readTaskView } from '../data/tasks.js';
import { implementationClosureDigest } from '../data/identity.js';
import type { FileArtifactStore } from '../artifacts.js';
import type { BindingStore } from '../bindings.js';
import { assertHarnessAgentV1, assertTaskSelectionV1, assertEvaluationV1, assertProposalBatchV1,
  decodeRoleExecutionResult, type AuthorEvaluationConfigV1 } from './a1-contract.js';
import { STEP_API_VERSION, StepContext, type Algorithm, type Candidate, type Evaluation, type Failure,
  type Proposals, type Result, type ServiceRequest, type TaskSelection } from './definition.js';

/** Host-owned capabilities. Algorithms receive DTOs and requests, never accounting envelopes. */
export type ExecutionServices = {
  identityDigest: string;
  bindingSchema: BindingSchema;
  initialCandidate: Candidate;
  taskSource: import('../contracts.js').ArtifactRef;
  experienceSource?: import('../contracts.js').ArtifactRef;
  roles: Record<string, 'editor' | 'analyst'>;
  operationLimits: Record<string, Record<string, number>>;
  evaluation: AuthorEvaluationConfigV1;
  maxProposals: number;
  /** Additional named capabilities explicitly granted by the host. */
  capabilities?: Record<string, { kind: string; limits: Record<string, number> }>;
  verifyCandidate(candidate: Candidate): Promise<void> | void;
};
type EditItem = { index: number; phase: 'edit' | 'derive' | 'done';
  produced?: import('../contracts.js').ArtifactRef };
type Trial = { task: JsonValue; repeat: number; operationId?: string };
type Job = { name: string; request: ServiceRequest; phase: 'start' | 'edit' | 'consume' | 'trials' | 'measure' | 'done';
  result?: Result<unknown>; edits?: EditItem[]; candidates?: Candidate[]; failures?: Proposals['failures']; trials?: Trial[] };
type Pending = { key: string; job: number; stage: string; index: number };
type State = { version: typeof STEP_API_VERSION; authorState: unknown; stepIndex: number;
  jobs: Job[]; pending: Pending[]; result?: unknown };
const success = <T>(value: T): Result<T> => ({ ok: true, value });
const failure = (error: Failure): Result<never> => ({ ok: false, error });

/** The only scheduler remains AlgorithmRuntime. This adapter expands a few finite service protocols. */
export class StepAlgorithmAdapter<S = unknown, C = JsonValue> implements KernelAlgorithm {
  private readonly manifest: AlgorithmManifest;
  constructor(readonly author: Algorithm<S, C>, readonly execution: ExecutionServices,
    readonly artifacts: FileArtifactStore, readonly bindings: BindingStore, sourceDigest: string) {
    const declared = author.describe();
    if (declared.apiVersion !== STEP_API_VERSION) throw new Error('Expected explicit-state algorithm');
    const requiredOperationKinds = Object.keys(execution.operationLimits);
    if (Object.values(execution.roles).includes('editor')) requiredOperationKinds.push('execution.workspace-edit');
    if (Object.values(execution.roles).includes('analyst')) requiredOperationKinds.push('execution.role');
    requiredOperationKinds.push(...Object.values(execution.capabilities ?? {}).map(item => item.kind));
    this.manifest = { id: declared.id, apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: jsonDigest({ sourceDigest, executionIdentity: execution.identityDigest,
        adapter: implementationClosureDigest(['author/definition', 'author/step-adapter'], STEP_API_VERSION) }),
      bindingSchema: execution.bindingSchema, configSchema: declared.configSchema,
      stateSchema: { type: 'object', additionalProperties: true }, requiredOperationKinds: [...new Set(requiredOperationKinds)] };
  }
  describe(): AlgorithmManifest { return this.manifest; }
  async initialize(context: DecisionContext): Promise<AlgorithmDecision> {
    await this.execution.verifyCandidate(this.execution.initialCandidate);
    return this.decide(context, { version: STEP_API_VERSION, authorState: null, stepIndex: 0, jobs: [], pending: [] });
  }
  private async requestJob(name: string, request: ServiceRequest): Promise<Job> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(name)) throw new Error(`Invalid service result name: ${name}`);
    const e = this.execution;
    switch (request.service) {
      case 'sample':
        if (!Number.isSafeInteger(request.count) || request.count < 1 || !Number.isSafeInteger(request.seed))
          throw new Error('Task sample needs a positive count and integer seed');
        return { name, request, phase: 'start' };
      case 'select':
        if (!e.experienceSource) throw new Error('Task selection is not granted by this host');
        if (!Array.isArray(request.taskIds) || !request.taskIds.length || request.taskIds.some(id => typeof id !== 'string')
          || !['train', 'development'].includes(request.purpose)) throw new Error('Task selection needs task IDs and a research purpose');
        return { name, request, phase: 'start' };
      case 'tasks':
        if ('digest' in request.selection) {
          const view = readTaskView(this.artifacts, request.selection);
          request = { service: 'tasks', selection: { schemaVersion: 1, taskViewRef: request.selection,
            selectedTaskIds: view.tasks.map(task => task.id), cursor: { viewDigest: request.selection.digest, nextIndex: 0 } } };
        }
        assertTaskSelectionV1(request.selection);
        return { name, request, phase: 'consume' };
      case 'propose':
        if (e.roles[request.role] !== 'editor' || !Number.isSafeInteger(request.count)
          || request.count < 1 || request.count > e.maxProposals) throw new Error('Proposal exceeds host grant');
        await this.checkCandidate(request.parent);
        if (request.feedback) {
          assertEvaluationV1(request.feedback);
          if (!request.feedback.comparable || canonicalJson(request.feedback.subject) !== canonicalJson(request.parent))
            throw new Error('Proposal feedback must measure its parent');
        }
        return { name, request, phase: 'edit', edits: Array.from({ length: request.count }, (_, index) => ({ index, phase: 'edit' })),
          candidates: [], failures: [] };
      case 'evaluate':
        await this.checkCandidate(request.candidate); assertTaskSelectionV1(request.tasks);
        if (request.tasks.selectedTaskIds.length * e.evaluation.repeatCount > e.evaluation.maxTrials)
          throw new Error('Evaluation exceeds finite host trial bound');
        return { name, request, phase: 'consume' };
      case 'role':
        if (e.roles[request.role] !== 'analyst') throw new Error(`Analyst role not granted: ${request.role}`);
        if (request.candidate) await this.checkCandidate(request.candidate);
        return { name, request, phase: 'start' };
      case 'call':
        if (!Object.hasOwn(e.capabilities ?? {}, request.capability)) throw new Error(`Capability not granted: ${request.capability}`);
        if (request.candidate) await this.checkCandidate(request.candidate);
        return { name, request, phase: 'start' };
      default: throw new Error('Unsupported service request');
    }
  }
  private async checkCandidate(candidate: Candidate): Promise<void> {
    assertHarnessAgentV1(candidate);
    if (candidate.executionProfileDigest !== this.execution.initialCandidate.executionProfileDigest)
      throw new Error('Candidate execution profile changed');
    await this.execution.verifyCandidate(candidate);
  }
  private async decide(context: DecisionContext, current: State): Promise<AlgorithmDecision> {
    const results = Object.fromEntries(current.jobs.map(job => [job.name, job.result!]));
    const reply = await this.author.step(new StepContext<S, C>(current.authorState as S | null, results, context.config as C,
      this.execution.initialCandidate, this.execution.taskSource,
      context.budget ?? { dimensions: {} }, current.stepIndex));
    assertJson(reply);
    if (reply.status === 'complete') {
      if (reply.result.selected) await this.checkCandidate(reply.result.selected);
      assertJson(reply.result);
      this.artifacts.verifyContentRefs(reply.result, this.bindings);
      return { nextState: { version: STEP_API_VERSION, authorState: current.authorState,
        stepIndex: current.stepIndex, jobs: [], pending: [], result: reply.result } as JsonValue,
        complete: true, ...(reply.result.selected ? { bindingTransition: reply.result.selected.bindingSetRef } : {}) };
    }
    if (reply.status !== 'run' || !reply.requests || Array.isArray(reply.requests)
      || typeof reply.requests !== 'object' || Object.keys(reply.requests).length === 0)
      throw new Error('A step must finish or request at least one service');
    validateSchema(this.author.describe().stateSchema, reply.state);
    const jobs: Job[] = [];
    for (const [name, request] of Object.entries(reply.requests)) jobs.push(await this.requestJob(name, request));
    return this.schedule({ version: STEP_API_VERSION, authorState: reply.state,
      stepIndex: current.stepIndex + 1, jobs, pending: [] });
  }
  private schedule(state: State): AlgorithmDecision {
    const operations: OperationIntent[] = [], pending: Pending[] = [];
    const emit = (job: number, stage: string, index: number, kind: string, input: unknown,
      candidate?: Candidate, pure = false, limits?: Record<string, number>): boolean => {
      assertJson(input);
      const key = `j${job}.${stage}.${index}`;
      operations.push({ localKey: key, kind, input,
        ...(candidate ? { bindingSetRef: candidate.bindingSetRef } : {}),
        limits: pure ? {} : limits ?? this.execution.operationLimits[kind] ?? {}, startsBudgetClock: !pure });
      pending.push({ key, job, stage, index }); return true;
    };
    for (const [index, job] of state.jobs.entries()) {
      const request = job.request;
      if (job.phase === 'done') continue;
      if (request.service === 'sample') emit(index, 'sample', 0, 'tasks.sample',
        { sourceTaskViewRef: request.source, count: request.count, seed: request.seed }, undefined, true);
      else if (request.service === 'select') emit(index, 'select', 0, 'tasks.select', {
        experienceViewRef: this.execution.experienceSource!, tasks: request.taskIds.map(id => ({ id, purpose: request.purpose })) }, undefined, true);
      else if (request.service === 'tasks' && 'taskViewRef' in request.selection) emit(index, 'tasks', 0, 'tasks.consume', {
        taskViewRef: request.selection.taskViewRef, cursor: request.selection.cursor, count: request.selection.selectedTaskIds.length }, undefined, true);
      else if (request.service === 'role') emit(index, 'role', 0, 'execution.role',
        { roleId: request.role, input: request.input }, request.candidate ?? this.execution.initialCandidate);
      else if (request.service === 'call') {
        const grant = this.execution.capabilities![request.capability]!;
        emit(index, 'call', 0, grant.kind, request.input, request.candidate, false, grant.limits);
      } else if (request.service === 'propose') {
        for (const item of job.edits!) {
          if (item.phase === 'edit') emit(index, 'edit', item.index, 'execution.workspace-edit', {
            roleId: request.role, baseBindingSetRef: request.parent.bindingSetRef, proposalIndex: item.index,
            ...(request.feedback ? { feedback: { schemaVersion: 1, subject: request.parent,
              taskViewRef: request.feedback.taskViewRef, measurementRef: request.feedback.measurementRef,
              comparisonKey: request.feedback.comparisonKey } } : {}) }, request.parent);
          else if (item.phase === 'derive') emit(index, 'derive', item.index, 'bindings.derive', {
            baseRef: request.parent.bindingSetRef, replacements: { harness: item.produced } }, request.parent, true);
        }
      } else if (request.service === 'evaluate') {
        if (job.phase === 'consume') emit(index, 'consume', 0, 'tasks.consume', {
          taskViewRef: request.tasks.taskViewRef, cursor: request.tasks.cursor,
          count: request.tasks.selectedTaskIds.length }, request.candidate, true);
        else if (job.phase === 'trials') {
          const config = this.execution.evaluation;
          for (const [trialIndex, trial] of job.trials!.entries()) if (!trial.operationId) emit(index, 'trial', trialIndex, 'execution.rollout', {
            task: trial.task, taskViewRef: request.tasks.taskViewRef, repeatIndex: trial.repeat,
            samplingDigest: config.samplingDigest, environmentDigest: config.environmentDigest,
            recipePhase: config.recipePhase, executedRevisionDigest: request.candidate.bindingSetRef.digest }, request.candidate);
        } else if (job.phase === 'measure') emit(index, 'measure', 0, 'author.measurement', {
          subject: request.candidate, selection: request.tasks,
          producerOperationIds: job.trials!.map(item => item.operationId!) }, request.candidate, true);
      }
    }
    if (operations.length === 0) throw new Error('Service batch has no runnable operation');
    state.pending = pending;
    return { nextState: state as JsonValue, operations };
  }
  private accept(job: Job, pending: Pending, outcome: OperationOutcome, operationId: string): void {
    const request = job.request;
    const done = (result: Result<unknown>): void => { job.phase = 'done'; job.result = result; };
    // Even a failed rollout has a committed ID. Measurement decides validity without inventing a score.
    if (pending.stage === 'trial') {
      job.trials![pending.index]!.operationId = operationId;
      if (job.trials!.every(item => item.operationId)) job.phase = 'measure';
      return;
    }
    if (request.service === 'propose') {
      const item = job.edits![pending.index]!;
      if (outcome.kind !== 'result') {
        job.failures!.push({ index: pending.index, stage: pending.stage === 'derive' ? 'derive'
          : outcome.kind === 'no-result' && outcome.reason === 'workspace-edit-fixed-check-failed' ? 'validation' : 'edit',
        code: outcome.kind === 'error' ? outcome.code : outcome.reason ?? outcome.kind,
        message: outcome.kind === 'error' ? outcome.message : outcome.reason ?? outcome.kind, evidenceRefs: [] });
        item.phase = 'done';
      } else if (pending.stage === 'edit') {
        const value = outcome.value as Record<string, JsonValue>;
        if (value.requestedBindingSetDigest !== request.parent.bindingSetRef.digest || !value.producedArtifactRef)
          throw new Error('Editor returned a different parent or no checked artifact');
        item.produced = value.producedArtifactRef as import('../contracts.js').ArtifactRef;
        this.artifacts.getBytes(item.produced);
        item.phase = 'derive';
      } else {
        const bindingSetRef = (outcome.value as { bindingSetRef: Candidate['bindingSetRef'] }).bindingSetRef;
        const candidate: Candidate = { schemaVersion: 1, kind: 'harness-agent', bindingSetRef,
          executionProfileDigest: request.parent.executionProfileDigest, proposalIndex: pending.index };
        assertHarnessAgentV1(candidate); this.bindings.read(candidate.bindingSetRef);
        job.candidates!.push(candidate); item.phase = 'done';
      }
      if (job.edits!.every(item => item.phase === 'done')) {
        const value: Proposals = { schemaVersion: 1, requestedCount: request.count,
          candidates: job.candidates!.sort((a, b) => a.proposalIndex! - b.proposalIndex!),
          failures: job.failures!.sort((a, b) => a.index - b.index) };
        assertProposalBatchV1(value); done(success(value));
      }
      return;
    }
    if (outcome.kind !== 'result') { done(failure(outcome)); return; }
    if (pending.stage === 'sample' && request.service === 'sample') {
      assertTaskSelectionV1(outcome.value);
      if (outcome.value.selectedTaskIds.length !== request.count) throw new Error('Task sample returned an incorrect count');
      done(success(outcome.value));
    } else if (pending.stage === 'select' && request.service === 'select') {
      const { taskViewRef } = outcome.value as { taskViewRef: import('../contracts.js').ArtifactRef };
      const view = readTaskView(this.artifacts, taskViewRef);
      done(success({ schemaVersion: 1, taskViewRef, selectedTaskIds: view.tasks.map(task => task.id),
        cursor: { viewDigest: taskViewRef.digest, nextIndex: 0 } }));
    } else if (pending.stage === 'tasks' && request.service === 'tasks' && 'taskViewRef' in request.selection) {
      const value = outcome.value as { tasks: Array<{ id: string; purpose: string; contentRef: import('../contracts.js').ArtifactRef; exposure: unknown; ancestry: string[] }> };
      if (canonicalJson(value.tasks.map(task => task.id)) !== canonicalJson(request.selection.selectedTaskIds))
        throw new Error('Task read differs from signed selection');
      done(success(value.tasks.map(task => {
        const content = this.artifacts.getJson(task.contentRef) as { prompt: string };
        return { id: task.id, prompt: content.prompt, purpose: task.purpose, exposure: task.exposure, ancestry: task.ancestry };
      })));
    }
    else if (pending.stage === 'role') {
      const candidate = request.service === 'role' ? request.candidate ?? this.execution.initialCandidate : this.execution.initialCandidate;
      done(success(decodeRoleExecutionResult(outcome.value, candidate.bindingSetRef.digest)));
    } else if (pending.stage === 'consume' && request.service === 'evaluate') {
      const value = outcome.value as { tasks: Array<JsonValue & { id: string; purpose: string }>; cursor: { viewDigest: string; nextIndex: number } };
      if (!Array.isArray(value.tasks) || canonicalJson(value.tasks.map(task => task.id)) !== canonicalJson(request.tasks.selectedTaskIds)
        || value.tasks.some(task => task.purpose === 'final-test') || value.cursor.viewDigest !== request.tasks.taskViewRef.digest
        || value.cursor.nextIndex !== value.tasks.length) throw new Error('Task consume differs from signed selection');
      job.trials = value.tasks.flatMap(task => Array.from({ length: this.execution.evaluation.repeatCount }, (_, repeat) => ({ task, repeat })));
      job.phase = 'trials';
    } else if (pending.stage === 'measure' && request.service === 'evaluate') {
      assertEvaluationV1(outcome.value);
      if (canonicalJson(outcome.value.subject) !== canonicalJson(request.candidate)
        || canonicalJson(outcome.value.taskViewRef) !== canonicalJson(request.tasks.taskViewRef))
        throw new Error('Measurement subject or task selection changed');
      done(success(outcome.value));
    } else done(success(outcome.value));
  }
  async reduce(context: ReduceContext): Promise<AlgorithmDecision> {
    const state = context.state as State;
    if (state.version !== STEP_API_VERSION) throw new Error('Unknown algorithm state version');
    for (const pending of state.pending) {
      const outcome = context.completed[pending.key], operationId = context.completedOperationIds?.[pending.key];
      if (!outcome || !operationId) throw new Error('Service result has no committed kernel operation');
      this.accept(state.jobs[pending.job]!, pending, outcome, operationId);
    }
    state.pending = [];
    return state.jobs.every(job => job.phase === 'done') ? this.decide(context, state) : this.schedule(state);
  }
  readResult(snapshot: { state: JsonValue }): unknown | null { return (snapshot.state as State).result ?? null; }
}
