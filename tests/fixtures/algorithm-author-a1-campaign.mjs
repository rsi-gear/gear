import { algorithm } from '../../lib/algorithm/author/index.js';

export const sample = algorithm(async ctx => {
  const role = await ctx.role('analyst', { goal: ctx.config.goal });
  const selection = await ctx.tasks.sample(ctx.data.taskViewRef, { count: 2, seed: 7 });
  const archive = await ctx.checkpoint('proof', { role, selection });
  return ctx.result({ selected: ctx.initialAgent,
    outputs: { archive, selectedTaskIds: selection.selectedTaskIds } });
}, { configSchema: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } },
  additionalProperties: false } });
