import { algorithm, type Candidate, type Evaluation, type Proposals,
  type TaskSelection } from 'rsi-gear/algorithm/author';

type State = { phase: 'propose' } | { phase: 'evaluate'; tasks: TaskSelection } | { phase: 'select' };
type Config = { n: number };
export const search = algorithm<State, Config>(ctx => {
  const state = ctx.state;
  if (state === null) return ctx.run({ phase: 'propose' }, {
    tasks: ctx.services.sample(ctx.taskSource, 2, 42),
  });
  if (state.phase === 'propose') {
    const tasks = ctx.results.get<TaskSelection>('tasks');
    if (!tasks.ok) return ctx.finish({ outputs: tasks.error });
    return ctx.run({ phase: 'evaluate', tasks: tasks.value }, {
      proposals: ctx.services.propose(ctx.initialCandidate, { role: 'optimizer', count: ctx.config.n }),
    });
  }
  if (state.phase === 'evaluate') {
    const proposals = ctx.results.get<Proposals>('proposals');
    if (!proposals.ok || !proposals.value.candidates.length) return ctx.finish();
    return ctx.run({ phase: 'select' }, Object.fromEntries(proposals.value.candidates.map((candidate, index) =>
      [`candidate_${index}`, ctx.services.evaluate(candidate, state.tasks)])));
  }
  const measured = Object.keys(ctx.results.values).flatMap(name => {
    const result = ctx.results.get<Evaluation>(name);
    return result.ok && result.value.comparable ? [result.value] : [];
  });
  const best = measured.sort((a, b) => (b.metrics.pass_rate ?? 0) - (a.metrics.pass_rate ?? 0))[0];
  return ctx.finish(best ? { selected: best.subject, outputs: { evaluation: best } } : {});
}, { id: 'best-of-n' });
