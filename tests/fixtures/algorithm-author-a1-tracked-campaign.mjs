import { algorithm } from '../../lib/algorithm/author/index.js';

export const sample = algorithm(async ctx => {
  const tracked = await ctx.trackedOperation('execution.rollout', { taskId: 'task-0' },
    { bindingSetRef: ctx.initialAgent.bindingSetRef, limits: {} });
  return ctx.result({ selected: ctx.initialAgent, outputs: { tracked } });
}, { configSchema: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } },
  additionalProperties: false } });
