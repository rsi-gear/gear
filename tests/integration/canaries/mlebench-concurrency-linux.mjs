// Manual real Linux acceptance, with no model/API calls. Build Gear and Hitch
// first; this script snapshots Hitch once and never rebuilds either repository.
// HITCH_SOURCE=... CANARY_IMAGE=... HITCH_RESOURCE_CONFIG=... \
//   node tests/integration/canaries/mlebench-concurrency-linux.mjs /new/output/root
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initProject } from '../../../lib/application/init.js'
import { ProjectController } from '../../../lib/application/project-controller.js'
import { ProjectApplication } from '../../../lib/application/project-service.js'
import { resolveProject } from '../../../lib/application/project-config.js'
import { checkBenchmark } from '../../../lib/application/benchmark.js'
import { pythonJson } from '../../../lib/application/python.js'
import { HitchOperationProvider } from '../../../lib/adapters/hitch/provider.js'
import { resourceSdkEnvironment } from '../../../lib/adapters/hitch/resource-sdk.js'
import { PiHarnessAdapter } from '../../../lib/adapters/pi/harness.js'
import { canonicalDigest } from '../../../lib/domain/canonical.js'
import { resolveMetric } from '../../../lib/objective/contracts.js'

const root = resolve(process.argv[2] ?? ''), hitch = process.env.HITCH_SOURCE, image = process.env.CANARY_IMAGE
assert(process.argv[2] && hitch && image && process.env.HITCH_RESOURCE_CONFIG,
  'new output root, HITCH_SOURCE, CANARY_IMAGE and HITCH_RESOURCE_CONFIG required')
const holdSeconds = Number(process.env.CANARY_HOLD_SECONDS ?? 30)
assert(Number.isInteger(holdSeconds) && holdSeconds >= 20 && holdSeconds <= 120)
await mkdir(root, { recursive: false })
process.env.GEAR_PROFILE_ROOT = join(root, 'profiles')
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n')
const log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }))
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Gear Canary', '-c', 'user.email=canary@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const state = join(root, 'state'), project = join(root, 'project')
await mkdir(state)
const hostResources = JSON.parse(await readFile(process.env.HITCH_RESOURCE_CONFIG, 'utf8'))
hostResources.workspace = { ...hostResources.workspace, maxWorkspaces: Math.max(hostResources.workspace?.maxWorkspaces ?? 0, 3) }
await writeFile(join(state, 'resource-config.json'), JSON.stringify(hostResources, null, 2))
const { produceTask } = await import(pathToFileURL(join(hitch, 'benchmark-packages/kaggle/analysis.mjs')).href)
const data = join(root, 'public'); await mkdir(data)
await writeFile(join(data, 'train.csv'), 'id,x,label\n1,1,1\n2,2,1\n3,3,1\n4,4,1\n5,5,1\n6,6,1\n')
await writeFile(join(data, 'test.csv'), 'id,x\n101,101\n102,102\n')
await writeFile(join(root, 'expected.csv'), 'id,label\n101,1\n102,1\n')
const produced = await produceTask({ root: state, out: join(root, 'dataset'), id: 'titanic-like-concurrency',
  instruction: 'Fit the ordinary classifier and deliver predictions with the independent experiment receipt.',
  publicDirectory: data, expected: join(root, 'expected.csv'),
  delivery: { format: 'csv', path: 'submission.csv', idColumn: 'id', targetColumns: ['label'], predictIds: ['101', '102'], valueType: 'label', labels: ['0', '1'] },
  evaluation: { mode: 'scored', version: 'concurrency-canary-v1', metric: 'accuracy', grader: { kind: 'builtin' } },
  baseImage: image, platform: 'linux/arm64', timeoutSeconds: 3600, cpus: 1, memoryMb: 1024, verifierCpus: 1, verifierMemoryMb: 256 })
await save('produced.json', produced)
const { ensureControllerRuntime } = await import(pathToFileURL(join(hitch, 'dist/src/controller-runtime/index.js')).href)
const runtime = await ensureControllerRuntime({ root: state, payloadRoot: hitch })
const executable = join(runtime.directory, 'payload/dist/bin/hitch.js')
process.env.GEAR_HITCH_EXECUTABLE = executable
await save('runtime.json', { runtime_id: runtime.runtime_id, executable })
await initProject(project, { adapter: 'pi' })
const controller = new ProjectController(new ProjectApplication(project, { provider: async () => { throw new Error('Authoring must not call a model') } }))
const plan = await controller.invoke('benchmark.import', { source: produced.path, template: 'harbor', mode: 'research' })
const applied = await controller.invoke('benchmark.apply', { plan_id: plan.plan_id })
const checked = await controller.invoke('benchmark.check'); await controller.dispose()
const resolved = await resolveProject(project), benchmark = await checkBenchmark(project, resolved.config)
await save('authoring.json', { plan, applied, checked }); await save('benchmark.json', benchmark)

// Identical absolute marker paths in every sandbox deliberately expose accidental
// volume/workdir reuse. Each sandbox also verifies its marker after the overlap.
const experiment = `import csv,json,pathlib,socket,time,uuid
from sklearn.dummy import DummyClassifier
marker=uuid.uuid4().hex
work=pathlib.Path('/app/concurrency-marker.txt')
output=pathlib.Path('/output');output.mkdir(exist_ok=True)
assert not work.exists(), 'work directory leaked from a different experiment'
assert not (output/'concurrency-marker.txt').exists(), 'output directory leaked from a different experiment'
work.write_text(marker);(output/'concurrency-marker.txt').write_text(marker)
started=time.time_ns()
time.sleep(${holdSeconds})
assert work.read_text()==marker, 'work marker overwritten by another experiment'
assert (output/'concurrency-marker.txt').read_text()==marker, 'output marker overwritten by another experiment'
rows=list(csv.DictReader(pathlib.Path('/data/train.csv').open()))
model=DummyClassifier(strategy='constant',constant=1)
model.fit([[float(r['x'])] for r in rows],[int(r['label']) for r in rows])
prediction=model.predict([[101],[102]])
with (output/'submission.csv').open('w') as f:
 w=csv.writer(f);w.writerow(['id','label']);w.writerows(zip([101,102],prediction))
receipt={'marker':marker,'candidate':pathlib.Path('/app/AGENTS.md').read_text().strip(),'hostname':socket.gethostname(),'started_ns':str(started),'finished_ns':str(time.time_ns()),'workdir':str(pathlib.Path.cwd()),'work_marker_retained':work.read_text()==marker,'output_marker_retained':(output/'concurrency-marker.txt').read_text()==marker,'cpu_max':pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().strip(),'memory_max':pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip()}
(output/'experiment.json').write_text(json.dumps(receipt,sort_keys=True))
print(json.dumps(receipt))
`
const agent = join(root, 'ordinary-agent'); await mkdir(join(agent, 'packages/coding-agent/dist'), { recursive: true })
await writeFile(join(agent, 'packages/coding-agent/dist/cli.js'), `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('pi 1.0.0');process.exit(0)}
const result=spawnSync('python3',['-c',${JSON.stringify(experiment)}],{encoding:'utf8',maxBuffer:65536});
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:result.stdout+result.stderr}],stopReason:result.status===0?'stop':'error'}}));process.exitCode=result.status??1;
`)
await writeFile(join(agent, 'package.json'), JSON.stringify({ name: 'gear-concurrency-canary-agent', version: '1.0.0', private: true, type: 'module', scripts: { build: 'node --check packages/coding-agent/dist/cli.js' } }))
await writeFile(join(agent, 'package-lock.json'), JSON.stringify({ name: 'gear-concurrency-canary-agent', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'gear-concurrency-canary-agent', version: '1.0.0' } } }))
git(agent, 'init', '-q'); git(agent, 'add', '.'); git(agent, 'commit', '-qm', 'Deterministic isolated experiment'); const harnessCommit = git(agent, 'rev-parse', 'HEAD')
const targets = join(root, 'targets'), targetSource = join(root, 'target-source'), adapter = new PiHarnessAdapter()
await mkdir(targets); await adapter.prepare(targetSource); git(targetSource, 'init', '-q')
const candidates = []
for (const name of ['candidate-a', 'candidate-b']) {
  await writeFile(join(targetSource, 'AGENTS.md'), name + '\n')
  git(targetSource, 'add', '.'); git(targetSource, 'commit', '-qm', name)
  const id = git(targetSource, 'rev-parse', 'HEAD')
  await cp(targetSource, join(targets, id), { recursive: true, filter: path => !path.split('/').includes('.git') })
  candidates.push({ name, id })
}
await save('candidates.json', { harnessCommit, candidates })
const daemon = { maxConcurrent: 3, containerSlots: 6, buildSlots: 2 }
execFileSync(executable, ['--root', state, 'daemon', 'start', '--port', '0', '--max-concurrent', '3', '--container-slots', '6', '--build-slots', '2'], { encoding: 'utf8', env: process.env })
log({ stage: 'ready', runtime: runtime.runtime_id, daemon })
const metrics = benchmark.adapter_manifest.raw_metrics.metrics.map(resolveMetric)
const allRecords = [], stages = []
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
try {
  for (const [stage, maxConcurrent, crossCandidate] of [['serial', 1, false], ['parallel', 2, false], ['cross-candidate', 2, true]]) {
    log({ stage: `${stage}-start`, maxConcurrent })
    const directory = join(root, stage)
    const profile = { kind: 'hitch', executable, root: state, harnessRef: `pi@git+${pathToFileURL(agent).href}#${harnessCommit}`,
      model: 'deterministic-no-api', baseImage: image, passEnv: [], timeoutMs: 3600000, setupTimeoutMs: 600000, preparationTimeoutMs: 600000, maxConcurrent }
    const provider = await HitchOperationProvider.connect(profile, { directory, targets, adapter, taskIds: [produced.taskId], implementationIdentity: hash(await readFile(new URL(import.meta.url))),
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
  const workspaceDirectory = join(state, 'store/benchmark-resources/workspace-records')
  const workspaces = await Promise.all((await readdir(workspaceDirectory)).map(async name => JSON.parse(await readFile(join(workspaceDirectory, name), 'utf8'))))
  assert.equal(workspaces.length, 9)
  assert.equal(new Set(workspaces.map(w => w.taskDirectory)).size, 9)
  assert(workspaces.every(w => w.state === 'removed'), 'completed experiment workspace not removed')
  await save('result.json', { status: 'passed', kind: 'real-linux-same-task-concurrency', controller_runtime: runtime.runtime_id,
    platform: 'linux/arm64', complete_task_executions: 9, model_api_calls: 0, retries: 0, daemon_capacity: daemon,
    fixture_limits: { agent_cpus: 1, agent_memory_mib: 1024, verifier_cpus: 1, verifier_memory_mib: 256, agent_timeout_seconds: 3600, verifier_timeout_seconds: 120, cli_timeout_ms: 3600000 },
    stages, workspace_records: workspaces,
    limitations: ['Synthetic fixture checks scheduling/isolation, not Titanic quality.', 'Per-operation maxConcurrent is distinct from daemon-wide capacity. Two concurrent operations may each request their own capacity.', 'Sandbox marker timestamps measure active experiment overlap, not all setup/cleanup time.'] })
  log({ stage: 'complete', tasks: 9, model_api_calls: 0 })
} finally {
  execFileSync(executable, ['--root', state, 'daemon', 'stop'], { encoding: 'utf8', env: process.env })
}
