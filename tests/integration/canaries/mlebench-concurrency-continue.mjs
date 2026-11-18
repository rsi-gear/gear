// Retain the interrupted operation after a frozen host-environment mismatch.
// Never redispatch it; continue with distinct, explicitly named comparison IDs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pythonJson } from '../../../lib/application/python.js'
import { HitchOperationProvider } from '../../../lib/adapters/hitch/provider.js'
import { resourceSdkEnvironment } from '../../../lib/adapters/hitch/resource-sdk.js'
import { PiHarnessAdapter } from '../../../lib/adapters/pi/harness.js'
import { canonicalDigest } from '../../../lib/domain/canonical.js'
import { resolveMetric } from '../../../lib/objective/contracts.js'
const root=resolve(process.argv[2]??''), image=process.env.CANARY_IMAGE
assert(process.argv[2]&&image,'interrupted canary root and CANARY_IMAGE required')
const state=join(root,'state'), targets=join(root,'targets'), agent=join(root,'ordinary-agent'), adapter=new PiHarnessAdapter()
const {runtime_id,executable}=JSON.parse(await readFile(join(root,'runtime.json'),'utf8'))
assert(process.env.HITCH_SOURCE && process.env.HITCH_RESOURCE_CONFIG, 'restore the original daemon environment for its frozen binding')
process.env.GEAR_PROFILE_ROOT=join(root,'profiles')
process.env.GEAR_HITCH_EXECUTABLE=executable
const runtime={runtime_id}, produced=JSON.parse(await readFile(join(root,'produced.json'),'utf8'))
const benchmark=JSON.parse(await readFile(join(root,'benchmark.json'),'utf8'))
const {harnessCommit,candidates}=JSON.parse(await readFile(join(root,'candidates.json'),'utf8'))
const stages=JSON.parse(await readFile(join(root,'stages.json'),'utf8'))
assert([1,3].includes(stages.length));assert.equal(stages[0].stage,'serial')
const allRecords=stages.flatMap(s=>s.records), recoveryRecords=[]
const originalRequests=JSON.parse(await readFile(join(root,'parallel-requests.json'),'utf8'))
const save=(name,value)=>writeFile(join(root,name),JSON.stringify(value,null,2)+'\n')
const log=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}))
const hash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`
await mkdir(join(root,'recovery'),{recursive:true})
await cp(join(root,'parallel',originalRequests[0].request.operationId.slice(7),'plan.json'),join(root,'recovery/before-plan.json'),{force:false})
const beforeRuns=JSON.parse(await readFile(join(root,'recovery/before-sealed-runs.json'),'utf8'))
assert.equal(beforeRuns.length,3)
await save('recovery/before-sealed-runs.json',beforeRuns)
await save('recovery/interruption.json',{stage:'parallel',code:'hitch-call-failed',command:'worker observe',reason:'Concurrent LocalExecutionObserver requests returned execution_observation_busy before one eval was submitted.',completed_physical_attempts:3,model_api_calls:0})
const daemon={maxConcurrent:3,containerSlots:6,buildSlots:2}
execFileSync(executable,['--root',state,'daemon','start','--port','0','--max-concurrent','3','--container-slots','6','--build-slots','2'],{encoding:'utf8',env:process.env})
const metrics=benchmark.adapter_manifest.raw_metrics.metrics.map(resolveMetric)
const maxOverlap = records => {
  const events = records.flatMap(r => [[BigInt(r.experiment.started_ns), 1], [BigInt(r.experiment.finished_ns), -1]])
  events.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
  let active = 0, peak = 0
  for (const [, change] of events) { active += change; peak = Math.max(peak, active) }
  return peak
}
const collectTrial = async ({ trial, stage, operationId, candidate, repetition, evalId }) => {
  const runDirectory = join(state, 'runs', trial.run_id)
  const runRequest = JSON.parse(await readFile(join(runDirectory, 'request.json'), 'utf8'))
  const execution = JSON.parse(await readFile(join(runDirectory, 'execution.json'), 'utf8'))
  assert.equal(runRequest.timeout_ms, 3600000)
  assert.equal(execution.enforced.main_limits.cpu_millis, 1000)
  assert.equal(execution.enforced.main_limits.memory_bytes, 1024 ** 3)
  assert.equal(execution.enforced.verifier_limits.cpu_millis, 1000)
  assert.equal(execution.enforced.verifier_limits.memory_bytes, 256 * 1024 ** 2)
  assert.equal(execution.reservation.cpu_millis, 2000)
  assert.equal(execution.reservation.memory_bytes, 1280 * 1024 ** 2)
  const containers = execution.observed.containers
  assert.equal(containers.filter(c => c.role === 'candidate').length, 1)
  assert.equal(containers.filter(c => c.role === 'verifier').length, 1)
  for (const container of containers) {
    assert.equal(container.cpu_limit_millis, 1000)
    assert.equal(container.memory_limit_bytes, (container.role === 'candidate' ? 1024 : 256) * 1024 ** 2)
  }
  const artifactDirectory = join(runDirectory, 'output-artifacts'), manifest = JSON.parse(await readFile(join(artifactDirectory, 'manifest.json'), 'utf8'))
  const experimentBytes = await readFile(join(artifactDirectory, 'files/output/experiment.json'))
  const experiment = JSON.parse(experimentBytes)
  assert.equal(experiment.candidate, candidate.name)
  assert.equal(experiment.work_marker_retained, true); assert.equal(experiment.output_marker_retained, true)
  assert.equal(await readFile(join(artifactDirectory, 'files/output/concurrency-marker.txt'), 'utf8'), experiment.marker)
  const [quota, period] = experiment.cpu_max.split(' ').map(Number)
  assert.equal(quota / period, 1); assert.equal(Number(experiment.memory_max), 1024 ** 3)
  assert.equal(manifest.entries.find(e => e.path === 'output/experiment.json').sha256, hash(experimentBytes))
  return { stage, operation_id: operationId, candidate: candidate.name, repetition, eval_id: evalId,
    run_id: trial.run_id, task_digest: manifest.task_digest, output_manifest_digest: manifest.digest, artifact_directory: artifactDirectory,
    timeout_ms: runRequest.timeout_ms, resource_reservation: execution.reservation, enforced_resources: execution.enforced,
    containers: containers.map(c => ({ id: c.container_id, name: c.name, role: c.role, image_config_digest: c.image_config_digest,
      cpu_limit_millis: c.cpu_limit_millis, memory_limit_bytes: c.memory_limit_bytes })), experiment }
}
let nativeDataset
if(stages.length===3){const saved=JSON.parse(await readFile(join(root,'native-same-eval-command.json'),'utf8'));nativeDataset=saved.args[saved.args.indexOf('--dataset')+1]}
try {
  const priorPlan=JSON.parse(await readFile(join(root,'recovery/before-plan.json'),'utf8'))
  const retained=priorPlan.groups[1]
  for(const before of beforeRuns){
    const manifest=JSON.parse(await readFile(join(state,'runs',before.run_id,'output-artifacts/manifest.json'),'utf8'))
    if(manifest.eval_id===retained.evalId) recoveryRecords.push(await collectTrial({trial:{run_id:before.run_id},stage:'retained-partial',operationId:originalRequests[0].request.operationId,candidate:candidates[0],repetition:retained.repetition,evalId:retained.evalId}))
  }
  assert.equal(recoveryRecords.length,1)
  await save('recovery/result.json',{status:'not_resumed',reason:'The complete resident environment binding differed after restarting the canary process. The original operation was rejected before submission; its identity was not bypassed.',new_physical_attempts:0,original_operation_id:originalRequests[0].request.operationId,unstarted_eval_id:priorPlan.groups[0].evalId,retained_records:recoveryRecords})

  for(const [stage,maxConcurrent,crossCandidate] of (stages.length===1?[['parallel-fresh',2,false],['cross-candidate',2,true]]:[])) {
    log({stage:`${stage}-start`,maxConcurrent})
    const directory = join(root, stage)
    const profile = { kind: 'hitch', executable, root: state, harnessRef: `pi@git+${pathToFileURL(agent).href}#${harnessCommit}`,
      model: 'deterministic-no-api', baseImage: image, passEnv: [], timeoutMs: 3600000, setupTimeoutMs: 600000, preparationTimeoutMs: 600000, maxConcurrent }
    const provider = await HitchOperationProvider.connect(profile, { directory, targets, adapter, taskIds: [produced.taskId], implementationIdentity: hash(await readFile(new URL('./mlebench-concurrency-linux.mjs', import.meta.url))),
      compile: (destination, taskIds, baseImage, signal, sdk) => pythonJson(['benchmark', 'harbor', '--output', destination], { benchmark, task_ids: taskIds, base_image: baseImage }, signal, resourceSdkEnvironment(sdk)),
      compilePlanning: (destination, taskIds, baseImage, signal, sdk) => pythonJson(['benchmark', 'harbor', '--output', destination], { benchmark, task_ids: taskIds, base_image: baseImage, planning_only: true }, signal, resourceSdkEnvironment(sdk)),
      seal: (destination, taskIds, sdk) => pythonJson(['benchmark', 'seal-harbor'], { benchmark, destination, task_ids: taskIds }, undefined, resourceSdkEnvironment(sdk)) })
    const requests = (crossCandidate ? candidates : [candidates[0]]).map(candidate => ({
      candidate,
      request: { runId: `gear-concurrency-${stage}`, operationId: canonicalDigest({ stage, candidate: candidate.id }), generation: 1, partition: 'seed', repetitions: crossCandidate ? 1 : 2,
        slots: (crossCandidate ? [0] : [0, 1]).map(repetition => ({ taskId: produced.taskId, repetition })), evidence: [], metrics,
        operation: { kind: 'evaluate_seed', candidate_id: candidate.id, parent_id: null, task_ids: [produced.taskId], scope: 'global', rationale: 'Real same-task concurrency acceptance', payload: null } },
    }))
    await save(`${stage}-requests.json`, requests)
    const receipts = await Promise.all(requests.map(async ({ candidate, request }) => {
      const receipt = await provider.submit(request, new AbortController().signal)
      await save(`${stage}-${candidate.name}-receipt.json`, receipt)
      assert.equal(receipt.physicalAttempts, request.slots.length)
      assert.equal(receipt.evidence.length, request.slots.length)
      assert(receipt.evidence.every(e => e.status === 'valid' && e.score === 1))
      return receipt
    }))
    const records = []
    for (const { candidate, request } of requests) {
      const frozen = JSON.parse(await readFile(join(directory, request.operationId.slice(7), 'plan.json'), 'utf8'))
      for (const group of frozen.groups) {
        const inspection = JSON.parse(execFileSync(executable, ['--root', state, 'eval', 'inspect', group.evalId, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
        assert.equal(inspection.result.trials.length, 1)
        nativeDataset ??= group.dataset
        records.push(await collectTrial({ trial: inspection.result.trials[0], stage, operationId: request.operationId, candidate, repetition: group.repetition, evalId: group.evalId }))
      }
    }
    const observed = maxOverlap(records)
    assert.equal(observed, maxConcurrent, `${stage}: observed sandbox activity does not match configured concurrency`)
    stages.push({ stage, profile_max_concurrent: maxConcurrent, operations: requests.length, observed_peak_active_experiments: observed,
      physical_attempts: receipts.reduce((n, r) => n + r.physicalAttempts, 0), records })
    allRecords.push(...records); await save('stages.json', stages)
    log({ stage: `${stage}-passed`, observed_peak_active_experiments: observed })
  }
  log({ stage: 'native-same-eval-start' })
  const nativeArgs = ['--root', state, 'eval', 'run', '--daemon', '--dataset', nativeDataset, '--build-mode', 'backend',
    '--harness', `pi@git+${pathToFileURL(agent).href}#${harnessCommit}`, '--model', 'deterministic-no-api',
    '--attempts', '3', '--max-concurrent', '3', '--infrastructure-retries', '0', '--timeout', '1h', '--setup-timeout', '10m', '--output', 'json']
  await save('native-same-eval-command.json', { executable, args: nativeArgs })
  const nativeResult = JSON.parse(execFileSync(executable, nativeArgs, { encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024, timeout: 900000 }))
  await save('native-same-eval-result.json', nativeResult)
  assert.equal(nativeResult.status, 'succeeded'); assert.equal(nativeResult.trials.length, 3)
  assert.deepEqual(nativeResult.trials.map(t => t.attempt).sort(), [1, 2, 3])
  const nativeRecords = []
  for (const trial of nativeResult.trials) nativeRecords.push(await collectTrial({ trial, stage: 'native-same-eval', candidate: candidates[0], repetition: trial.attempt - 1, evalId: nativeResult.eval_id }))
  assert.equal(maxOverlap(nativeRecords), 3, 'native same-eval attempts did not overlap')
  stages.push({ stage: 'native-same-eval', native_max_concurrent: 3, operations: 1, observed_peak_active_experiments: 3, physical_attempts: 3, records: nativeRecords })
  allRecords.push(...nativeRecords); await save('stages.json', stages)
  log({ stage: 'native-same-eval-passed', observed_peak_active_experiments: 3 })
  for (const field of ['run_id', 'artifact_directory']) assert.equal(new Set(allRecords.map(r => r[field])).size, 9)
  assert.equal(new Set(allRecords.map(r => r.eval_id)).size, 7)
  for (const field of ['marker', 'hostname']) assert.equal(new Set(allRecords.map(r => r.experiment[field])).size, 9)
  assert.equal(new Set(allRecords.flatMap(r => r.containers.map(c => c.id))).size, 18)
  assert.equal(new Set(allRecords.flatMap(r => r.containers.map(c => c.name))).size, 18)
  for (const before of beforeRuns) assert.equal(hash(await readFile(join(state, 'runs', before.run_id, 'output-artifacts/manifest.json'))), before.output_manifest_sha256)
  const everyRecord = [...allRecords, ...recoveryRecords]
  assert.equal(new Set(everyRecord.map(r => r.run_id)).size, 10)
  assert.equal(new Set(everyRecord.map(r => r.experiment.marker)).size, 10)
  assert.equal(new Set(everyRecord.flatMap(r => r.containers.map(c => c.id))).size, 20)
  const workspaceDirectory = join(state, 'store/benchmark-resources/workspace-records')
  const workspaces = await Promise.all((await readdir(workspaceDirectory)).map(async name => JSON.parse(await readFile(join(workspaceDirectory, name), 'utf8'))))
  assert.equal(workspaces.length, 10)
  assert.equal(new Set(workspaces.map(w => w.taskDirectory)).size, 10)
  assert(workspaces.every(w => w.state === 'removed'), 'completed experiment workspace not removed')
  await save('result.json', { status: 'passed', kind: 'real-linux-same-task-concurrency', controller_runtime: runtime.runtime_id,
    platform: 'linux/arm64', complete_task_executions: 10, validation_task_executions: 9, retained_partial_task_executions: 1, model_api_calls: 0, retries: 0, daemon_capacity: daemon,
    fixture_limits: { agent_cpus: 1, agent_memory_mib: 1024, verifier_cpus: 1, verifier_memory_mib: 256, agent_timeout_seconds: 3600, verifier_timeout_seconds: 120, cli_timeout_ms: 3600000 },
    stages, recovery_records: recoveryRecords, workspace_records: workspaces,
    limitations: ['Synthetic fixture checks scheduling/isolation, not Titanic quality.', 'Per-operation maxConcurrent is distinct from daemon-wide capacity. Two concurrent operations may each request their own capacity.', 'Sandbox marker timestamps measure active experiment overlap, not all setup/cleanup time.'] })
  log({ stage: 'complete', tasks: 10, validation_tasks: 9, model_api_calls: 0 })
} finally {
  execFileSync(executable, ['--root', state, 'daemon', 'stop'], { encoding: 'utf8', env: process.env })
}
