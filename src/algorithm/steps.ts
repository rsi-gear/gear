import type { Algorithm, AlgorithmDecision, AlgorithmManifest, BindingSetRef, DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from './contracts.js';
import type { JsonSchema, JsonValue } from './schema.js';
import { validateSchema } from './schema.js';

export function task(localKey: string, kind: string, input: JsonValue, options: { bindingSetRef?: BindingSetRef; limits?: Record<string, number> } = {}): OperationIntent {
  return { localKey, kind, input, ...options };
}
export function parallel(...operations: OperationIntent[]): OperationIntent[] {
  const keys = new Set<string>();
  for (const operation of operations) { if (keys.has(operation.localKey)) throw new Error(`Duplicate parallel key ${operation.localKey}`); keys.add(operation.localKey); }
  return operations;
}
export function decision(nextState: JsonValue, operations: OperationIntent[] = [], bindingTransition?: BindingSetRef): AlgorithmDecision {
  return { nextState, operations, ...(bindingTransition ? { bindingTransition } : {}) };
}

export type WorkflowJoin = { state: JsonValue; bindingTransition?: BindingSetRef };
export type WorkflowStep = {
  name: string;
  plan(context: DecisionContext & { state: JsonValue }): OperationIntent[];
  join(context: ReduceContext & { state: JsonValue }): WorkflowJoin;
};
type WorkflowState = { stepIndex: number; business: JsonValue };

/** Named steps keep cursor/join recovery inside the SDK; callbacks remain pure decisions. */
export function defineWorkflow(options: {
  // Author-facing loader paths seal this from the actual source closure.
  // Direct AlgorithmRuntime callers must still provide a valid digest.
  manifest: Omit<AlgorithmManifest, 'stateSchema' | 'implementationDigest'> & { implementationDigest?: string };
  businessStateSchema: JsonSchema;
  initialState(context: DecisionContext): JsonValue;
  steps: WorkflowStep[];
}): Algorithm {
  if (options.steps.length === 0) throw new Error('Workflow needs a step');
  const names = new Set<string>();
  for (const step of options.steps) { if (!step.name || names.has(step.name)) throw new Error('Workflow step names must be unique'); names.add(step.name); }
  const stateSchema: JsonSchema = {
    type: 'object', properties: { stepIndex: { type: 'integer' }, business: options.businessStateSchema },
    required: ['stepIndex', 'business'], additionalProperties: false,
  };
  function plan(index: number, business: JsonValue, context: DecisionContext, bindingTransition?: BindingSetRef): AlgorithmDecision {
    let current = business;
    let transition = bindingTransition;
    // A named pure step may have no operations. Join it in this decision and
    // continue at most once per declared step, keeping the transition visible
    // to later plans without asking authors to write an event loop.
    for (let cursor = index; cursor < options.steps.length; cursor++) {
      const activeBindingSetRef = transition ?? context.activeBindingSetRef;
      const step = options.steps[cursor]!;
      const operations = parallel(...step.plan({ ...context, activeBindingSetRef, state: current }));
      if (operations.length) return { nextState: { stepIndex: cursor, business: current }, operations,
        ...(transition ? { bindingTransition: transition } : {}) };
      const joined = step.join({ ...context, activeBindingSetRef, state: current, completed: {} });
      validateSchema(options.businessStateSchema, joined.state);
      current = joined.state;
      if (joined.bindingTransition) transition = joined.bindingTransition;
    }
    const state: WorkflowState = { stepIndex: options.steps.length, business: current };
    return { nextState: state, complete: true, ...(transition ? { bindingTransition: transition } : {}) };
  }
  return {
    describe: () => ({ ...options.manifest, stateSchema, implementationDigest: options.manifest.implementationDigest ?? '' }),
    initialize(context) {
      const business = options.initialState(context); validateSchema(options.businessStateSchema, business);
      return plan(0, business, context);
    },
    reduce(context) {
      const workflow = context.state as WorkflowState;
      const step = options.steps[workflow.stepIndex]; if (!step) throw new Error('Workflow cursor out of range');
      const joined = step.join({ ...context, state: workflow.business });
      validateSchema(options.businessStateSchema, joined.state);
      return plan(workflow.stepIndex + 1, joined.state, context, joined.bindingTransition);
    },
  };
}
