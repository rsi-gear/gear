import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const interpreter = [process.env.GEAR_ALGORITHM_TEST_PYTHON, 'python3.12', 'python3.11'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});

it.skipIf(!interpreter)('resumes the actual Python CLI after SIGKILL without resubmitting a completed external effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-python-step-kill-')); roots.push(root);
  const cli = resolve('lib/cli.js'), hostModule = pathToFileURL(resolve('lib/algorithm/author/recorded-host.js')).href;
  const state = join(root, '.gear/state'), marker = join(state, 'submitted.json'), release = join(state, 'release');
  writeFileSync(join(root, 'algorithm.py'), `from gear_algorithm import algorithm\n@algorithm\ndef search(ctx):\n    if ctx.state is None:\n        return ctx.run({"phase":"evaluate","saved":17}, tasks=ctx.services.sample(ctx.task_source,1))\n    if ctx.state["phase"] == "evaluate":\n        return ctx.run({"phase":"finish","saved":ctx.state["saved"]}, evaluated=ctx.services.evaluate(ctx.initial_candidate,ctx.results["tasks"].value))\n    assert ctx.state["saved"] == 17\n    return ctx.finish(selected=ctx.initial_candidate,outputs=ctx.results["evaluated"].value)\n`);
  writeFileSync(join(root, 'host.mjs'), `import { createRecordedExecutionHost } from ${JSON.stringify(hostModule)};
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const hostProfile = { async create(context) {
  const host = await createRecordedExecutionHost(context);
  host.providers = host.providers.map(provider => provider.describe().kind !== 'execution.rollout' ? provider : {
    describe: () => provider.describe(), preflight: e => provider.preflight(e), collect: e => provider.collect(e), cancel: e => provider.cancel(e),
    async submit(e) { const result = await provider.submit(e); appendFileSync(join(context.stateDir,'effects.jsonl'), JSON.stringify(e.operationId)+'\\n');
      writeFileSync(join(context.stateDir,'submitted.json'), JSON.stringify({operationId:e.operationId,idempotencyKey:e.idempotencyKey}));
      return {status:'running'}; },
    inspect: e => existsSync(join(context.stateDir,'release')) ? provider.inspect(e)
      : existsSync(join(context.stateDir,'submitted.json')) ? Promise.resolve({status:'running'}) : provider.inspect(e)
  }); return host;
} };
`);
  const config = join(root, 'gear.algorithm.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, kind: 'algorithm-campaign', authoring: 'step', campaignId: 'python-kill',
    stateDir: './.gear/state', algorithm: { language: 'python', interpreter, module: './algorithm.py', export: 'search',
      sdkPath: resolve('packages/python-sdk/src') }, hostProfile: { language: 'typescript', module: './host.mjs', export: 'hostProfile' },
    config: {}, budget: { 'rollout.trials': { unit: 'trials', source: 'execution.rollout', capability: 'hard', limit: 2 } } }));
  const child = spawn(process.execPath, [cli, 'algorithm', 'run', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  try {
    for (let i = 0; i < 500 && !existsSync(marker); i++) {
      if (child.exitCode !== null) throw new Error(`CLI stopped before effect: ${stderr}`);
      await delay(20);
    }
    expect(existsSync(marker), stderr).toBe(true);
    // Wait until the running observation is journaled, then terminate the controller.
    await delay(100);
    const original = JSON.parse(readFileSync(marker, 'utf8'));
    const exited = new Promise(resolveExit => child.once('close', resolveExit));
    child.kill('SIGKILL'); await exited;
    writeFileSync(release, 'resume');
    const output = execFileSync(process.execPath, [cli, 'algorithm', 'resume', config], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result.status).toBe('complete');
    expect(result.result.outputs.comparable).toBe(true);
    expect(result.result.outputs.metrics.pass_rate).toBe(0);
    expect(readFileSync(join(state, 'effects.jsonl'), 'utf8').trim().split('\n')).toEqual([JSON.stringify(original.operationId)]);
    expect(result.snapshot.spent['rollout.trials']).toBe(1);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(original);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}, 45_000);
