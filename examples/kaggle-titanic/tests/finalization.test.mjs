import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap } from '../prepare.mjs'
import { command, exampleRoot, hash } from '../common.mjs'

async function fixture(t, mode = 'lose-reply') {
  const root = await mkdtemp(join(tmpdir(), 'gear-finalize-')); t.after(() => rm(root, { recursive: true, force: true }))
  const target = await bootstrap(join(root, 'target')), competitionFile = join(root, 'competition.json'), finalizationRef = join(root, 'dataset')
  await mkdir(finalizationRef)
  await writeFile(competitionFile, JSON.stringify({ competition: 'titanic', synthetic: true, submission: {
    id_column: 'PassengerId', target_column: 'Survived', expected_ids: ['892', '893'], rows: 2, allowed_labels: [0, 1],
  } }))
  const taskDigest = hash('task')
  await writeFile(join(finalizationRef, 'benchmark.adapter.json'), JSON.stringify({ dataset_digest: hash('dataset'), tasks: [{ task_id: 'titanic-finalize', task_digest: taskDigest }] }))
  const project = { ...target, competitionFile, competitionDigest: hash(await readFile(competitionFile)), finalizationRef }
  await writeFile(join(root, 'project.json'), JSON.stringify(project))
  const executable = join(root, 'hitch.mjs'), calls = join(root, 'calls.jsonl'), modeFile = join(root, 'mode'), state = join(root, 'eval.json')
  await writeFile(modeFile, mode)
  await writeFile(executable, `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';import{createHash}from'node:crypto';
const args=process.argv.slice(2), mode=readFileSync(${JSON.stringify(modeFile)},'utf8');
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]!=='--root'||args[1]!==${JSON.stringify(join(root, 'hitch'))})process.exit(9);
const a=args.slice(2), opt=name=>a[a.indexOf(name)+1], stateFile=${JSON.stringify(state)};
const digest=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const runId='run_'+'a'.repeat(32), csv='PassengerId,Survived\\n893,1\\n892,0\\n';
if(a[0]==='capabilities') console.log(JSON.stringify({schema_version:'1',run_output_artifacts:'1',run_output_artifact_backends:['local-docker']}));
else if(a[0]==='eval'&&a[1]==='run'){
 if(mode==='before-admission')process.exit(7);
 const evalId=opt('--eval-id');
 if(existsSync(stateFile))throw Error('duplicate training');
 writeFileSync(stateFile,JSON.stringify({schema_version:'1',eval_id:evalId,request:{dataset:opt('--dataset'),harness_ref:opt('--harness')},result:{schema_version:'1',eval_id:evalId,status:'succeeded',trials:[{run_id:runId,task_id:'titanic-finalize',attempt:1,observation_status:'valid',scores:{total_score:1,normalization:'standard'}}]}}));
 if(mode==='lose-reply')process.exit(7); console.log('{}');
}else if(a[0]==='eval'&&a[1]==='inspect'){
 if(!existsSync(stateFile)){console.error('eval not found: '+a[2]);process.exit(3);}
 console.log(readFileSync(stateFile,'utf8'));
}else if(a[0]==='runs'&&a[1]==='artifacts'){
 const evalId=JSON.parse(readFileSync(stateFile,'utf8')).eval_id;
 const body={schema_version:'1',kind:'run-output-artifacts',run_id:runId,eval_id:mode==='wrong-eval'?'eval_'+'f'.repeat(32):evalId,task_id:'titanic-finalize',attempt:1,harness_commit:${JSON.stringify(target.initialChampion.ref)},task_digest:${JSON.stringify(taskDigest)},entries:[{name:'output/predictions.csv',path:'output/predictions.csv',media_type:'text/csv',bytes:Buffer.byteLength(csv),sha256:digest(csv)}]};
 const manifest={...body,digest:digest(canonical(body))};
 if(a[2]==='list')console.log(JSON.stringify(manifest));
 else {if(opt('--manifest-digest')!==manifest.digest)process.exit(8);
 const destination=join(realpathSync(dirname(opt('--out'))),basename(opt('--out')));mkdirSync(join(destination,'output'),{recursive:true});writeFileSync(join(destination,'output/predictions.csv'),csv);
 writeFileSync(join(destination,'hitch-output-manifest.json'),JSON.stringify(manifest));
 console.log(JSON.stringify({schema_version:'1',kind:'run-output-artifacts-export',run_id:runId,manifest_digest:manifest.digest,destination}));}
}else process.exit(11);
`, { mode: 0o755 })
  const config = { taskBudgetMs: 10000, hitch: { executable, root: join(root, 'hitch'), model: 'fixture', setupTimeoutMs: 1000, passEnv: [], agentArgs: [], sampling: {}, controlPlane: { mode: 'direct' } } }
  await writeFile(join(root, 'gear.config.json'), JSON.stringify(config))
  const args = ['--project', root, '--out', join(root, 'final'), '--commit', target.initialChampion.ref, '--manifest-digest', target.initialChampion.manifestDigest]
  const finalize = extra => command(process.execPath, [join(exampleRoot, 'finalize.mjs'), ...args, ...(extra ?? [])])
  const trainingCount = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(x => JSON.parse(x)).filter(a => a[2] === 'eval' && a[3] === 'run').length
  return { root, project, target, calls, modeFile, config, finalize, trainingCount }
}

test('finalization resumes a lost eval reply, exports canonical files and never repeats training', async t => {
  const f = await fixture(t)
  await assert.rejects(f.finalize())
  const completed = JSON.parse(await f.finalize())
  assert.equal(completed.status, 'complete'); assert.equal(completed.inputs.candidateCommit, f.target.initialChampion.ref)
  assert.equal(hash(await readFile(completed.submissionFile)), completed.submissionDigest)
  assert.deepEqual(JSON.parse(await f.finalize()), completed)
  assert.equal(await f.trainingCount(), 1)
})

test('finalization retries only after explicit proof of no admitted eval', async t => {
  const f = await fixture(t, 'before-admission')
  await assert.rejects(f.finalize())
  await assert.rejects(f.finalize(), /eval not found/)
  assert.equal(await f.trainingCount(), 1)
  await writeFile(f.modeFile, 'normal')
  const completed = JSON.parse(await f.finalize(['--retry-unstarted']))
  assert.equal(completed.status, 'complete'); assert.equal(await f.trainingCount(), 2)
})

test('finalization rejects another eval output and a stale candidate source manifest', async t => {
  const f = await fixture(t, 'wrong-eval')
  await assert.rejects(f.finalize(), /provenance/)
  await assert.rejects(readFile(join(f.root, 'final/submission.csv')), { code: 'ENOENT' })
  await writeFile(join(f.project.targetRepository, 'harness/workflows/titanic/pipeline.py'), '# changed without manifest\n')
  await command('git', ['add', '.'], { cwd: f.project.targetRepository })
  await command('git', ['commit', '--no-gpg-sign', '-m', 'Unsealed pipeline'], { cwd: f.project.targetRepository })
  const commit = await command('git', ['rev-parse', 'HEAD'], { cwd: f.project.targetRepository })
  const { selectedCandidate } = await import('../finalize.mjs')
  await assert.rejects(selectedCandidate(f.project, commit, f.target.initialChampion.manifestDigest), /source digest/)
  await writeFile(join(f.project.targetRepository, 'fixed/runner.py'), '# invalid fixed runner\n')
  await command('git', ['add', '.'], { cwd: f.project.targetRepository })
  await command('git', ['commit', '--no-gpg-sign', '-m', 'Changed fixed carrier'], { cwd: f.project.targetRepository })
  const changed = await command('git', ['rev-parse', 'HEAD'], { cwd: f.project.targetRepository })
  await assert.rejects(selectedCandidate(f.project, changed, f.target.initialChampion.manifestDigest), /fixed carrier/)
})

test('start rejects a carrier prepared without a committed package lock', async t => {
  const f = await fixture(t)
  const template = join(f.root, 'incomplete-template')
  await cp(join(exampleRoot, 'target-carrier'), template, { recursive: true })
  await rm(join(template, 'pnpm-lock.yaml'))
  const incomplete = await bootstrap(join(f.root, 'incomplete-target'), { template })
  const { buildConfig } = await import('../start.mjs')
  await assert.rejects(buildConfig(f.config, { ...f.project, ...incomplete }, f.root), /no committed pnpm-lock/)
})

test('start prepares a full-fold config and usable Hitch working directory', async t => {
  const f = await fixture(t)
  const seed = join(f.root, 'seed')
  await mkdir(seed)
  const ids = Array.from({ length: 5 }, (_, i) => `titanic-dev-fold-${i}`)
  await writeFile(join(seed, 'benchmark.adapter.json'), JSON.stringify({ tasks: ids.map(task_id => ({ task_id })) }))
  const { buildConfig } = await import('../start.mjs')
  const deployment = { ...f.config, metaModel: { provider: 'fixture', model: 'fixture' }, metaSampling: {},
    metaAdapter: { kind: 'skill', runtimeType: 'fixture', runtimeVersion: '1', runtimeIntegrity: hash('fixture runtime'),
      harnessId: 'refine', harnessDigest: hash('fixture skill') } }
  const project = { ...f.project, seedTaskRef: seed, heldOutRef: join(f.root, 'held-out'), hitchRoot: f.config.hitch.root }
  const config = await buildConfig(deployment, project, f.root)
  assert.deepEqual(config.search.scopeSampling.sharedCoreTaskIds, ids)
  assert.equal(config.candidateWorkspace.shellEnabled, false)
  assert.equal(config.hitch.controlPlane.mode, 'direct')
  assert.equal(config.initialChampion.manifestDigest, f.project.initialChampion.manifestDigest)
  assert.deepEqual(config.compiler.args, [join(f.project.targetRepository, 'fixed/check.mjs')])
  for (const budget of [config.budgets.round, config.budgets.evolution]) {
    assert.equal(Object.hasOwn(budget, 'maxGenerationTokens'), false)
    assert.equal(Object.hasOwn(budget, 'maxGenerationRequests'), false)
    assert.ok(budget.maxNewRolloutCells > 0)
    assert.ok(budget.timeoutMs > 0)
  }
  await assert.rejects(stat(config.workspaceRoot), { code: 'ENOENT' })
  await writeFile(join(f.root, 'project.json'), JSON.stringify(project))
  const baseConfig = join(f.root, 'base-config.json')
  await writeFile(baseConfig, JSON.stringify(deployment))
  await command(process.execPath, [join(exampleRoot, 'start.mjs'), '--project', f.root, '--config', baseConfig, '--prepare-only'])
  const prepared = JSON.parse(await readFile(join(f.root, 'gear.config.json'), 'utf8'))
  assert.equal(prepared.workspaceRoot, config.workspaceRoot)
  assert.equal((await stat(prepared.workspaceRoot)).isDirectory(), true)
  const capability = JSON.parse(await command(prepared.hitch.executable,
    ['--root', prepared.hitch.root, 'capabilities', '--json'], { cwd: prepared.workspaceRoot }))
  assert.equal(capability.run_output_artifacts, '1')
})
