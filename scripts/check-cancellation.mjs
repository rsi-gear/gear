// Installed control-plane recovery. The fake provider records one unknown submission, no model calls.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const api = path => import(pathToFileURL(join(packageRoot, 'lib', path)).href)
const { ProjectApplication, initProject, resolveProject, saveProfile } = await api('index.js')
const { configuredBindings } = await api('application/profiles.js')
const execute = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'gear-cancellation-proof-'))
const profiles = join(root, 'profiles'), project = join(root, 'project'), script = join(root, 'provider.mjs')
process.env.GEAR_PROFILE_ROOT = profiles
try {
  await mkdir(profiles)
  await writeFile(script, `import {readFile,writeFile,access} from 'node:fs/promises';import {join} from 'node:path';
let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text),root=input.configuration.root;
const blocked=await access(join(root,'block-start')).then(()=>true,()=>false);
if(blocked&&input.action!=='cancel')throw new Error('execution startup is unavailable');
if(input.action==='describe')process.stdout.write(JSON.stringify({version:1,identity:'sha256:'+'a'.repeat(64),capabilities:{seeds:false,temperature:false,subsets:true,idempotentSubmission:true,inspect:true,cancel:true,physicalAttemptAccounting:true,hardDollarBudget:false,generationBudget:false,evidenceProjection:false}}));
else if(input.action==='inspect')process.stdout.write(JSON.stringify({state:'not_submitted'}));
else if(input.action==='submit'){await writeFile(join(root,'submitted.json'),JSON.stringify(input));throw new Error('lost submission reply');}
else if(input.action==='cancel'){const prior=JSON.parse(await readFile(join(root,'submitted.json'),'utf8'));for(const key of ['request','configuration','context','implementationIdentity'])if(JSON.stringify(prior[key])!==JSON.stringify(input[key]))throw new Error('cancellation did not preserve original inputs');await writeFile(join(root,'stopped.json'),'true');process.stdout.write(JSON.stringify({cancelled:true}));}
else throw new Error('unexpected action');`)
  await saveProfile('cancel-target', { command: [process.execPath, script], workingDirectory: root, passEnv: [], timeoutMs: 1000, configuration: { root } })
  await initProject(project)
  const { config } = await resolveProject(project)
  await writeFile(join(project, 'gear.yaml'), JSON.stringify({ ...config, target: { ...config.target, profile: 'cancel-target' } }))
  const app = new ProjectApplication(project, configuredBindings)
  const { runId } = await app.admitEvaluate({ split: 'seed', limit: 1 })
  await assert.rejects(app.resume(runId), { code: 'provider-call-failed' })
  const prior = await app.store.read(runId), run = join(project, '.gear/runs', runId)
  assert.equal(prior.operations[0].status, 'submitted')
  assert.equal((await stat(join(run, 'cancellation.json'))).mode & 0o777, 0o600)
  await writeFile(join(root, 'block-start'), '')
  await rm(profiles, { recursive: true })
  for (const path of ['project.json', 'benchmark.json', 'targets', 'research']) await rm(join(run, path), { recursive: true })
  const result = JSON.parse((await execute(process.execPath, [join(packageRoot, 'lib/cli.js'), '--project', project, '--json', 'cancel', runId], {
    timeout: 20000, env: { ...process.env, GEAR_PYTHON: '/unavailable-algorithm-python' },
  })).stdout)
  assert.equal(result.cancellation, 'confirmed')
  const stopped = await app.store.read(runId)
  assert.equal(stopped.status, 'cancelled')
  assert.deepEqual(stopped.operations, prior.operations)
  assert.equal(stopped.physicalAttempts, prior.physicalAttempts)
  assert.equal(await readFile(join(root, 'stopped.json'), 'utf8'), 'true')
  console.log(JSON.stringify({ installedCLI: true, independentCancellation: true, originalInputsPreserved: true, missingProfileBenchmarkTargetResearchIgnored: true, executionStartupForbidden: true, modelCalls: 0 }))
} finally { await rm(root, { recursive: true, force: true }) }
