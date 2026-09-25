/** Compile-only copy of the v4 user-facing search path: no casts or Gear internals. */
import { algorithm, searchConfigSchema,
  type SearchConfig, type SearchRoundRecord } from '../../src/algorithm/author/index.js';

export const search = algorithm<SearchConfig>(async ctx => {
  let best = ctx.initialAgent;
  const tasks = await ctx.tasks.sample(ctx.data.searchTasks,
    { count: ctx.config.taskCount, seed: ctx.config.seed });
  const archive: SearchRoundRecord[] = [];
  for (let round = 0; round < ctx.config.rounds; round++) {
    const baseline = await ctx.evaluate(best, { tasks });
    if (!baseline.comparable) {
      await ctx.checkpoint('baseline-incomplete', baseline);
      return ctx.result({ outputs: { incomplete: baseline } });
    }
    const proposals = await ctx.propose(best, { feedback: baseline, role: 'optimizer',
      count: ctx.config.proposalCount });
    const evaluations = await ctx.parallel(
      proposals.candidates.map(candidate => ctx.evaluate(candidate, { tasks })));
    const measured = evaluations.flatMap(item => item.ok ? [item.value] : []);
    best = ctx.select([baseline, ...measured],
      { metric: 'pass_rate', requireImprovement: true }).agent;
    archive.push({ round, baseline, proposals, evaluations, selected: best });
    await ctx.checkpoint('population', archive);
  }
  return ctx.result({ selected: best, outputs: { population: archive } });
}, { configSchema: searchConfigSchema });
