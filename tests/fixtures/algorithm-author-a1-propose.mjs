import { algorithm } from '../../lib/algorithm/author/index.js';

export const sample = algorithm(async ctx => {
  const proposals = await ctx.propose(ctx.initialAgent,
    { feedback: ctx.data.feedback, role: 'optimizer', count: 3 });
  return ctx.result({ outputs: { proposals } });
});
