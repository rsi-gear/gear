// Manual real Linux acceptance. No provider calls are made by the deterministic
// Pi fixture; every reserved slot still runs the ordinary Gear -> Hitch path.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initProject } from '../../../lib/application/init.js'
import { ProjectController } from '../../../lib/application/project-controller.js'
import { ProjectApplication } from '../../../lib/application/project-service.js'
import { resolveProject } from '../../../lib/application/project-config.js'
import { checkBenchmark } from '../../../lib/application/benchmark.js'
import { pythonJson } from '../../../lib/application/python.js'
import { HitchOperationProvider } from '../../../lib/adapters/hitch/provider.js'
import { PiHarnessAdapter } from '../../../lib/adapters/pi/harness.js'
import { canonicalDigest } from '../../../lib/domain/canonical.js'
import { resolveMetric, resolveObjective, sealed } from '../../../lib/objective/contracts.js'
import { aggregateRawMetrics, scoreObjectiveProjection } from '../../../lib/objective/scoring.js'

const root = resolve(process.argv[2] ?? ''), hitch = process.env.HITCH_SOURCE, image = process.env.CANARY_IMAGE
assert(process.argv[2] && hitch && image && process.env.HITCH_RESOURCE_CONFIG, 'root, HITCH_SOURCE, CANARY_IMAGE and HITCH_RESOURCE_CONFIG required')
await mkdir(root, { recursive: false })
process.env.GEAR_PROFILE_ROOT = join(root, 'profiles')
const log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }))
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n')
const git = (cwd, ...args) => execFileSync('git', ['-c','user.name=Gear Canary','-c','user.email=canary@example.invalid','-c','commit.gpgsign=false', ...args], {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const state = join(root, 'state'), project = join(root, 'project')
await mkdir(state); await cp(process.env.HITCH_RESOURCE_CONFIG, join(state, 'resource-config.json'))
const resources = await import(pathToFileURL(join(hitch, 'dist/src/resources/index.js')).href)
const parameters = await import(pathToFileURL(join(hitch, 'dist/src/parameters/index.js')).href)
const { produceTask } = await import(pathToFileURL(join(hitch, 'benchmark-packages/kaggle/analysis.mjs')).href)
const data = join(root,'public'); await mkdir(data)
await writeFile(join(data,'train.csv'),'id,x,label\n1,1,1\n2,2,1\n3,3,1\n4,4,1\n5,5,1\n6,6,1\n')
await writeFile(join(data,'test.csv'),'id,x\n101,101\n102,102\n')
await writeFile(join(root,'expected.csv'),'id,label\n101,1\n102,1\n')
const produced = await produceTask({root:state,out:join(root,'dataset'),id:'ordinary-training',instruction:'Fit an ordinary classifier and deliver predictions for the test IDs.',publicDirectory:data,expected:join(root,'expected.csv'),delivery:{format:'csv',path:'submission.csv',idColumn:'id',targetColumns:['label'],predictIds:['101','102'],valueType:'label',labels:['0','1']},evaluation:{mode:'scored',version:'gear-canary-v1',metric:'accuracy',grader:{kind:'builtin'}},baseImage:image,platform:'linux/arm64',timeoutSeconds:120,cpus:1,memoryMb:1024})
assert.equal((await resources.verifyResourceDatasetSource(produced.path)).schema_version,'3')
log({stage:'task-imported',...produced}); await save('produced.json',produced)
// Snapshot before starting a resident daemon; concurrent source edits elsewhere
// cannot change this canary's execution closure.
const { ensureControllerRuntime } = await import(pathToFileURL(join(hitch,'dist/src/controller-runtime/index.js')).href)
const runtime = await ensureControllerRuntime({root:state,payloadRoot:hitch})
const executable=join(runtime.directory,'payload/dist/bin/hitch.js');process.env.GEAR_HITCH_EXECUTABLE=executable
await save('runtime.json',{runtime_id:runtime.runtime_id,executable})
await initProject(project,{adapter:'pi'})
const controller=new ProjectController(new ProjectApplication(project,{provider:async()=>{throw new Error('Authoring cannot contact a provider')}}))
const plan=await controller.invoke('benchmark.import',{source:produced.path,template:'harbor',mode:'research'})
const applied=await controller.invoke('benchmark.apply',{plan_id:plan.plan_id})
const checked=await controller.invoke('benchmark.check'); await controller.dispose()
const resolved=await resolveProject(project), benchmark=await checkBenchmark(project,resolved.config)
await save('authoring.json',{plan,applied,checked});await save('benchmark.json',benchmark)
log({stage:'gear-import-applied',task_ids:benchmark.tasks.map(t=>t.id)})
const runtimeSource=join(root,'ordinary-agent');await mkdir(join(runtimeSource,'packages/coding-agent/dist'),{recursive:true})
let cli=await readFile(join(hitch,'benchmark-packages/kaggle/tests/fixtures/ordinary-agent/cli.js'),'utf8')
cli=cli.replace("parameters['method']['cv']['folds']=4", "parameters['method']['cv']['folds']=int(pathlib.Path('/app/AGENTS.md').read_text().split('folds=')[1].split()[0])")
await writeFile(join(runtimeSource,'packages/coding-agent/dist/cli.js'),cli)
await writeFile(join(runtimeSource,'package.json'),JSON.stringify({name:'gear-mlebench-canary-agent',version:'1.0.0',private:true,type:'module',scripts:{build:'node --check packages/coding-agent/dist/cli.js'}}))
await writeFile(join(runtimeSource,'package-lock.json'),JSON.stringify({name:'gear-mlebench-canary-agent',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'gear-mlebench-canary-agent',version:'1.0.0'}}}))
git(runtimeSource,'init','-q');git(runtimeSource,'add','.');git(runtimeSource,'commit','-qm','Deterministic ordinary task agent');const harnessCommit=git(runtimeSource,'rev-parse','HEAD')
const targets=join(root,'targets'),targetSource=join(root,'target-source'),adapter=new PiHarnessAdapter();await mkdir(targets);await adapter.prepare(targetSource);git(targetSource,'init','-q')
const candidates=[]
for(const [name,folds] of [['baseline',4],['candidate-a',6],['candidate-b',8]]){
 await writeFile(join(targetSource,'AGENTS.md'),`Train the task classifier. Register folds=${folds} before training.\n`)
 git(targetSource,'add','.');git(targetSource,'commit','-qm',name);const id=git(targetSource,'rev-parse','HEAD');await cp(targetSource,join(targets,id),{recursive:true,filter:source=>!source.split('/').includes('.git')});candidates.push({name,id,folds})
}
await save('candidates.json',{harnessCommit,candidates})
execFileSync(executable,['--root',state,'daemon','start','--port','0','--max-concurrent','1','--container-slots','4','--build-slots','2'],{encoding:'utf8',env:process.env})
await save('daemon-resource-policy.json',{maxConcurrent:1,containerSlots:4,buildSlots:2,resourceHostConfiguration:JSON.parse(await readFile(join(state,'resource-config.json'),'utf8'))})
log({stage:'daemon-started'})
try{
 const profile={kind:'hitch',executable,root:state,harnessRef:`pi@git+${pathToFileURL(runtimeSource).href}#${harnessCommit}`,model:'deterministic-no-api',baseImage:image,passEnv:[],timeoutMs:120000,setupTimeoutMs:600000,preparationTimeoutMs:600000,maxConcurrent:1}
 const provider=await HitchOperationProvider.connect(profile,{directory:join(root,'submissions'),targets,adapter,taskIds:[produced.taskId],implementationIdentity:canonicalDigest(await readFile(new URL(import.meta.url),'utf8')),
 compile:(destination,taskIds,baseImage,signal)=>pythonJson(['benchmark','harbor','--output',destination],{benchmark,task_ids:taskIds,base_image:baseImage},signal),
 compilePlanning:(destination,taskIds,baseImage,signal)=>pythonJson(['benchmark','harbor','--output',destination],{benchmark,task_ids:taskIds,base_image:baseImage,planning_only:true},signal),
 seal:(destination,taskIds)=>pythonJson(['benchmark','seal-harbor'],{benchmark,destination,task_ids:taskIds})})
 const metrics=benchmark.adapter_manifest.raw_metrics.metrics.map(resolveMetric),objective=resolveObjective({terms:[{metric:'task_score',weight:1}]},metrics),scope=canonicalDigest({tasks:[produced.taskId],repetitions:[0,1]})
 const comparisons=[],identities=[],receipts=[]
 for(const candidate of candidates){
  const request={runId:'gear-mlebench-linux-canary',operationId:canonicalDigest({candidate:candidate.id,scope}),generation:1,partition:'seed',repetitions:2,slots:[0,1].map(repetition=>({taskId:produced.taskId,repetition})),evidence:[],metrics,operation:{kind:'evaluate_seed',candidate_id:candidate.id,parent_id:null,task_ids:[produced.taskId],scope:'global',rationale:'Complete deterministic task acceptance',payload:null}}
  log({stage:'candidate-started',candidate:candidate.name});await save(`${candidate.name}-request.json`,request)
  const receipt=await provider.submit(request,new AbortController().signal);await save(`${candidate.name}-receipt.json`,receipt);receipts.push(receipt)
  assert.equal(receipt.physicalAttempts,2);assert.equal(receipt.evidence.length,2);assert(receipt.evidence.every(e=>e.status==='valid'&&e.score===1))
  const frozen=JSON.parse(await readFile(join(root,'submissions',request.operationId.slice(7),'plan.json'),'utf8'))
  const records=[]
  for(const group of frozen.groups){
   const inspection=JSON.parse(execFileSync(executable,['--root',state,'eval','inspect',group.evalId,'--json'],{encoding:'utf8',maxBuffer:16*1024*1024}));assert.equal(inspection.result.trials.length,1)
   const trial=inspection.result.trials[0],cell=receipt.evidence.find(e=>e.repetition===group.repetition)
   const page=JSON.parse(execFileSync(executable,['--root',state,'verifier','artifact',trial.run_id,'parameter-evidence.json','--json'],{encoding:'utf8',maxBuffer:16*1024*1024}));const audit=JSON.parse(page.page.text)
   await save(`${candidate.name}-${group.repetition}-parameter-evidence.json`,page)
   assert.equal(audit.state.effective.method.cv.folds,candidate.folds);assert(audit.state.audit.some(a=>a.path==='/method/cv/seed'&&!a.accepted))
   identities.push({candidate:candidate.id,repetition:group.repetition,eval_id:group.evalId,run_id:trial.run_id,evaluation_id:audit.state.evaluation_id,candidate_id:audit.state.candidate_id,execution_id:audit.state.execution_id})
   records.push(sealed({schemaVersion:1,kind:'raw-metrics',taskId:produced.taskId,repetition:group.repetition,runId:trial.run_id,attempt:1,harnessCommit:candidate.id,conditionDigest:scope,originalArtifactRefs:[page.artifact.sha256],metrics:cell.raw_metrics}))
  }
  const aggregate=aggregateRawMetrics(metrics,[{id:produced.taskId,repetitions:[0,1],weight:1}],records),scored=scoreObjectiveProjection(objective,aggregate,scope)
  assert.equal(scored.evidence.score,1);comparisons.push({candidate:candidate.name,id:candidate.id,aggregate,...scored});await save('comparisons.json',comparisons);await save('identities.json',identities)
  log({stage:'candidate-complete',candidate:candidate.name,physicalAttempts:receipt.physicalAttempts,score:scored.evidence.score})
 }
 assert.equal(new Set(identities.map(x=>x.evaluation_id)).size,1);assert.equal(new Set(identities.map(x=>x.candidate_id)).size,3);assert.equal(new Set(identities.map(x=>x.execution_id)).size,6)
 assert.equal(receipts.reduce((n,r)=>n+r.physicalAttempts,0),6)
 const direct=await parameters.admitTaskParameters(join(produced.path,produced.taskId),{identity:{task_id:produced.taskId}});assert.equal(direct.evaluation_id,identities[0].evaluation_id)
 await save('result.json',{status:'passed',controller_runtime:runtime.runtime_id,complete_evaluations:6,retries:0,model_api_calls:0,daemon_capacity:{max_concurrent:1,container_slots:4,build_slots:2},comparisons,identities,limitation:'Configuration action evidence does not certify actual CV. DummyClassifier training is ordinary sklearn with lambda transform; no CV is claimed.'});log({stage:'complete',evaluations:6})
}finally{execFileSync(executable,['--root',state,'daemon','stop'],{encoding:'utf8',env:process.env})}
