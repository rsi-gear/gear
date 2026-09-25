/** TypeScript/JavaScript half of the frozen A0 fake-provider benchmark graph. */
import { algorithm, workflow } from '../../lib/algorithm/author/index.js';

const candidate = workflow(async function candidate(ctx, roundIndex, candidateIndex) {
  const role = await ctx.role('bench-role', { round: roundIndex, candidate: candidateIndex });
  const edit = await ctx.edit({ round: roundIndex, candidate: candidateIndex, role });
  const rollouts = await ctx.parallel(Array.from({ length: 10 }, (_, task) =>
    ctx.rollout({ round: roundIndex, candidate: candidateIndex, task, revision: edit.revision })));
  return await ctx.measure({ round: roundIndex, candidate: candidateIndex, rollouts });
}, { name: 'candidate', version: 'v1' });

export const composite = algorithm(async ctx => {
  const rounds = [];
  for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
    const measured = await ctx.parallel(Array.from({ length: 4 }, (_, index) => candidate(roundIndex, index)));
    rounds.push(measured);
  }
  return ctx.result({ outputs: { rounds } });
});

export const rho_shaped = algorithm(async ctx => {
  const initial = await ctx.measure({ initial: true });
  const ranks = [];
  for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
    const measured = await ctx.parallel(Array.from({ length: 4 }, (_, index) => candidate(roundIndex, index)));
    const rank = await ctx.operation('author.rank', { round: roundIndex, measurements: measured });
    await ctx.checkpoint('population', { round: roundIndex, rank });
    ranks.push(rank);
  }
  return ctx.result({ outputs: { initial, ranks } });
});
