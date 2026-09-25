import { algorithm } from '../../lib/algorithm/author/index.js';

export const sample = algorithm(async ctx => {
  const proposals = await ctx.propose(ctx.initialAgent, { role: 'optimizer', count: 1 });
  return ctx.result({ outputs: { proposals } });
});
