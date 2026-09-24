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
  manifest: Omit<AlgorithmManifest, 'stateSchema'>;
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
    const state: WorkflowState = { stepIndex: index, business };
    if (index === options.steps.length) return { nextState: state, complete: true, ...(bindingTransition ? { bindingTransition } : {}) };
    const operations = parallel(...options.steps[index]!.plan({ ...context, activeBindingSetRef: bindingTransition ?? context.activeBindingSetRef, state: business }));
    return { nextState: state, operations, ...(bindingTransition ? { bindingTransition } : {}) };
  }
  return {
    describe: () => ({ ...options.manifest, stateSchema }),
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
