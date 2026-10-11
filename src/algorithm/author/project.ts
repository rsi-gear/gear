import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PYTHON_BEST_OF_N = `from gear_algorithm.author import algorithm


@algorithm(id="best-of-n")
def search(ctx):
    state, svc = ctx.state, ctx.services
    if state is None:
        return ctx.run({"phase": "propose"}, tasks=svc.sample(ctx.task_source, 2, 42))
    if state["phase"] == "propose":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({"phase": "evaluate", "tasks": tasks.value},
                       proposals=svc.propose(ctx.initial_candidate, count=ctx.config["n"]))
    if state["phase"] == "evaluate":
        proposals = ctx.results["proposals"]
        if not proposals.ok:
            return ctx.finish(outputs={"failure": proposals.error})
        candidates = proposals.value["candidates"]
        if not candidates:
            return ctx.finish(outputs={"proposal_failures": proposals.value["failures"]})
        return ctx.run({"phase": "select"}, **{
            f"candidate_{i}": svc.evaluate(candidate, state["tasks"])
            for i, candidate in enumerate(candidates)
        })
    measured = [result.value for result in ctx.results.values()
                if result.ok and result.value["comparable"]]
    if not measured:
        return ctx.finish(outputs={"status": "no_valid_evaluation"})
    # Acceptance belongs to this algorithm. A valid zero remains a measurement.
    best = max(measured, key=lambda evaluation: evaluation["metrics"]["pass_rate"])
    return ctx.finish(selected=best["subject"], outputs={"evaluation": best})
`;
export const TS_BEST_OF_N = `import { algorithm, type Candidate, type Evaluation, type Proposals,
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
      [\`candidate_\${index}\`, ctx.services.evaluate(candidate, state.tasks)])));
  }
  const measured = Object.keys(ctx.results.values).flatMap(name => {
    const result = ctx.results.get<Evaluation>(name);
    return result.ok && result.value.comparable ? [result.value] : [];
  });
  const best = measured.sort((a, b) => (b.metrics.pass_rate ?? 0) - (a.metrics.pass_rate ?? 0))[0];
  return ctx.finish(best ? { selected: best.subject, outputs: { evaluation: best } } : {});
}, { id: 'best-of-n' });
`;

/** A runnable recorded teaching project. Replace only its host setting for physical execution. */
export async function initStepProject(directory: string, language: 'python' | 'typescript'): Promise<void> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length) throw new Error('Algorithm project directory must be empty');
  const campaignId = `search-${randomUUID()}`;
  const config = { schemaVersion: 1, kind: 'algorithm-campaign', authoring: 'step', host: 'recorded',
    campaignId, stateDir: `./.gear/${campaignId}`, concurrency: 8,
    algorithm: { language, ...(language === 'python' ? { interpreter: 'python3' } : {}),
      module: language === 'python' ? './algorithm.py' : './algorithm.ts', export: 'search' },
    config: { n: 4 }, budget: { 'rollout.trials': { unit: 'trials', limit: 100,
      source: 'execution.rollout', capability: 'hard' } } };
  const files = { 'gear.algorithm.json': JSON.stringify(config, null, 2) + '\n',
    ...(language === 'python' ? { 'algorithm.py': PYTHON_BEST_OF_N, 'requirements.txt': 'gear-algorithm==0.1.0a0\n' }
      : { 'algorithm.ts': TS_BEST_OF_N, 'package.json': JSON.stringify({ private: true, type: 'module', dependencies: { 'rsi-gear': '0.1.1' } }, null, 2) + '\n' }) };
  try { for (const [name, content] of Object.entries(files)) await writeFile(resolve(target, name), content, { flag: 'wx' }); }
  catch (error) { for (const name of Object.keys(files)) await rm(resolve(target, name), { force: true }); throw error; }
}
