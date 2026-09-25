import { algorithm, workflow } from '../../lib/algorithm/author/index.js';

const tasks = workflow(async (ctx, branch, group, revision) => {
  const labels = Array.from({ length: 5 }, (_, task) => `${branch}-${group}-${task}`);
  const rolls = await ctx.parallel(labels.map(label =>
    ctx.operation('author.rollout', { label, revision }, { limits: { calls: 1 } })));
  const ok = rolls.filter(item => item.ok).length;
  const measured = await ctx.measure({ branch, group, ok, total: rolls.length });
  return { group, rolls, measured };
}, { name: 'tasks', version: 'v1' });

const branch = workflow(async (ctx, branch) => {
  const role = await ctx.role('optimizer', { branch });
  const edit = await ctx.edit({ branch, role });
  const groups = await ctx.parallel([tasks(branch, 0, edit.revision), tasks(branch, 1, edit.revision)]);
  const score = await ctx.measure({ branch, groups });
  await ctx.checkpoint('branch-population', { branch, groups, score });
  return { branch, score, groups };
}, { name: 'branch', version: 'v1' });

export const sample = algorithm(async ctx => {
  const branches = await ctx.parallel([branch('A'), branch('B')]);
  const first = await ctx.checkpoint('population', { branches, round: 0 });
  const second = await ctx.checkpoint('population', { branches, round: 1 });
  const budget = await ctx.budget();
  const now = await ctx.now();
  return ctx.result({ outputs: { first, second, budget, now } });
});
