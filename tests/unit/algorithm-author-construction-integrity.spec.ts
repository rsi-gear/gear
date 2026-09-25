import { expect, it } from 'vitest';
import { algorithm, replay, workflow, type AuthorReplayRequest } from '../../src/algorithm/author/index.js';

const request: AuthorReplayRequest = { version: 'gear.author.replay.v1',
  input: { initialAgent: { id: 'agent' }, data: {}, config: { rounds: 2 } }, history: [] };

it('rejects public context rebinding in both branches while local arrays remain mutable', async () => {
  const branch = workflow(async (ctx, name: string) => {
    let rejected = 0;
    for (const change of [
      () => Object.assign(ctx, { config: { rounds: 99 } }),
      () => Object.assign(ctx, { initialAgent: { id: 'changed' } }),
      () => Object.assign(ctx, { data: {} }),
      () => Object.assign(ctx, { capabilities: {} }),
      () => Object.assign(ctx.tasks, { sample: () => null }),
    ]) {
      try { change(); } catch (error) { if (error instanceof TypeError) rejected++; else throw error; }
    }
    const archive: (string | number)[] = [name];
    archive.push((ctx.config as { rounds: number }).rounds);
    return { archive, rejected };
  });
  const parent = algorithm(async ctx => {
    const branches = await ctx.parallel([branch('left'), branch('right')]);
    return ctx.result({ outputs: { branches, rounds: (ctx.config as { rounds: number }).rounds } });
  });
  const finished = await replay(parent, request);
  expect(finished.status).toBe('completed');
  if (finished.status === 'completed') expect(finished.result).toEqual({ outputs: { branches: [
    { ok: true, value: { archive: ['left', 2], rejected: 5 } },
    { ok: true, value: { archive: ['right', 2], rejected: 5 } },
  ], rounds: 2 } });
});

it('keeps caught managed-call construction errors fatal before any fallback frontier', async () => {
  const child = workflow(async (_ctx, value: string) => value);
  const cases = [
    algorithm(async ctx => { try { ctx.operation('', {}); } catch {} return await ctx.now(); }),
    algorithm(async ctx => { try { ctx.operation('valid', { bad: undefined } as never); } catch {} return await ctx.now(); }),
    algorithm(async ctx => { try { ctx.operation('valid', {}, { limits: { calls: Number.NaN } }); } catch {} return await ctx.now(); }),
    algorithm(async ctx => { try { child(undefined as never); } catch {} return await ctx.now(); }),
    algorithm(async ctx => { try { ctx.parallel('invalid' as never); } catch {} return await ctx.now(); }),
  ];
  for (const definition of cases) await expect(replay(definition, request)).rejects.toThrow();
});
