import { defineWorkflow, task } from 'rsi-gear/algorithm';

export const requiredHooks = {
  choose: {
    inputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false },
    scope: 'campaign',
  },
};

export const algorithm = defineWorkflow({
  manifest: { id: 'ts-toy', apiVersion: 'gear.algorithm.experimental.v1',
    configSchema: { type: 'object' }, bindingSchema: { id: 'toy-bindings', slots: {} } },
  businessStateSchema: { type: 'object' },
  initialState: () => ({}),
  steps: [{
    name: 'choose',
    plan: () => [task('choose', 'policy.decide', { options: ['alpha', 'beta'] })],
    join: context => ({ state: { decision: context.completed.choose } }),
  }],
});
