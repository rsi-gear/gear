import { algorithm } from '../../lib/algorithm/author/index.js';

export const sample = algorithm(async ctx => {
  const selection = await ctx.tasks.sample(ctx.data.searchTasks, { count: 2, seed: 7 });
  const settled = await ctx.parallel([
    ctx.evaluate(ctx.initialAgent, { tasks: selection }),
    ctx.evaluate(ctx.data.candidate, { tasks: selection }),
  ]);
  const values = settled.flatMap(item => item.ok ? [item.value] : []);
  const winner = ctx.select(values, { metric: 'pass_rate', requireImprovement: true }).agent;
  return ctx.result({ selected: winner, outputs: { selection, evaluations: settled } });
});
