// Recheck native concurrency after a runtime-only refactor. Requires a completed
// mlebench-concurrency-linux.mjs run. Retains all previous immutable evidence.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? ''), hitch = process.env.HITCH_SOURCE
assert(process.argv[2] && hitch, 'completed canary root and HITCH_SOURCE required')
const prior = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
assert.equal(prior.status, 'passed'); assert.equal(prior.validation_task_executions ?? prior.complete_task_executions, 9)
const state = join(root, 'state'), directory = join(root, 'final-runtime')
await mkdir(directory, { recursive: false })
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n')
const { ensureControllerRuntime } = await import(pathToFileURL(join(hitch, 'dist/src/controller-runtime/index.js')).href)
const runtime = await ensureControllerRuntime({ root: state, payloadRoot: hitch })
const executable = join(runtime.directory, 'payload/dist/bin/hitch.js')
assert.notEqual(runtime.runtime_id, prior.controller_runtime, 'expected a new runtime after the refactor')
await save('runtime.json', { runtime_id: runtime.runtime_id, executable, prior_runtime_id: prior.controller_runtime })
const { args } = JSON.parse(await readFile(join(root, 'native-same-eval-command.json'), 'utf8'))
await save('command.json', { executable, args })
execFileSync(executable, ['--root', state, 'daemon', 'start', '--port', '0', '--max-concurrent', '3', '--container-slots', '6', '--build-slots', '2'], { encoding: 'utf8', env: process.env })
console.log(JSON.stringify({ stage: 'final-runtime-start', runtime: runtime.runtime_id }))
try {
  const result = JSON.parse(execFileSync(executable, args, { encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024, timeout: 900000 }))
  await save('native-result.json', result)
  assert.equal(result.status, 'succeeded'); assert.equal(result.trials.length, 3)
  assert.deepEqual(result.trials.map(t => t.attempt).sort(), [1, 2, 3])
  const records = []
  for (const trial of result.trials) {
    const runDirectory = join(state, 'runs', trial.run_id)
    const request = JSON.parse(await readFile(join(runDirectory, 'request.json'), 'utf8'))
    const execution = JSON.parse(await readFile(join(runDirectory, 'execution.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(join(runDirectory, 'output-artifacts/manifest.json'), 'utf8'))
    const bytes = await readFile(join(runDirectory, 'output-artifacts/files/output/experiment.json'))
    const experiment = JSON.parse(bytes)
    assert.equal(request.timeout_ms, 3600000)
    assert.equal(execution.reservation.cpu_millis, 2000)
    assert.equal(execution.reservation.memory_bytes, 1280 * 1024 ** 2)
    assert.equal(execution.enforced.main_limits.memory_bytes, 1024 ** 3)
    assert.equal(execution.enforced.verifier_limits.memory_bytes, 256 * 1024 ** 2)
    const containers = execution.observed.containers
    assert.equal(containers.filter(c => c.role === 'candidate').length, 1)
    assert.equal(containers.filter(c => c.role === 'verifier').length, 1)
    for (const c of containers) {
      assert.equal(c.cpu_limit_millis, 1000)
      assert.equal(c.memory_limit_bytes, (c.role === 'candidate' ? 1024 : 256) * 1024 ** 2)
    }
    assert.equal(experiment.work_marker_retained, true); assert.equal(experiment.output_marker_retained, true)
    assert.equal(await readFile(join(runDirectory, 'output-artifacts/files/output/concurrency-marker.txt'), 'utf8'), experiment.marker)
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    assert.equal(manifest.entries.find(e => e.path === 'output/experiment.json').sha256, digest)
    records.push({ run_id: trial.run_id, attempt: trial.attempt, eval_id: result.eval_id, output_manifest_digest: manifest.digest,
      artifact_directory: join(runDirectory, 'output-artifacts'), timeout_ms: request.timeout_ms,
      reservation: execution.reservation, enforced: execution.enforced,
      containers: containers.map(c => ({ id: c.container_id, name: c.name, role: c.role, cpu_limit_millis: c.cpu_limit_millis, memory_limit_bytes: c.memory_limit_bytes })), experiment })
  }
  const events = records.flatMap(r => [[BigInt(r.experiment.started_ns), 1], [BigInt(r.experiment.finished_ns), -1]])
  events.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
  let active = 0, peak = 0
  for (const [, change] of events) { active += change; peak = Math.max(active, peak) }
  assert.equal(peak, 3)
  assert.equal(new Set(records.map(r => r.experiment.marker)).size, 3)
  assert.equal(new Set(records.flatMap(r => r.containers.map(c => c.id))).size, 6)
  assert.equal(new Set(records.flatMap(r => r.containers.map(c => c.name))).size, 6)
  const oldMarkers = new Set([...prior.stages.flatMap(s => s.records), ...(prior.recovery_records ?? [])].map(r => r.experiment.marker))
  assert(records.every(r => !oldMarkers.has(r.experiment.marker)))
  const workspaceDirectory = join(state, 'store/benchmark-resources/workspace-records')
  const oldWorkspaces = new Set(prior.workspace_records.map(w => w.id))
  const workspaces = (await Promise.all((await readdir(workspaceDirectory)).map(async name => JSON.parse(await readFile(join(workspaceDirectory, name), 'utf8')))))
    .filter(w => !oldWorkspaces.has(w.id))
  assert.equal(workspaces.length, 3); assert(workspaces.every(w => w.state === 'removed'))
  await save('result.json', { status: 'passed', kind: 'final-runtime-native-concurrency', controller_runtime: runtime.runtime_id,
    previous_controller_runtime: prior.controller_runtime, model_api_calls: 0, complete_task_executions: 3, retries: 0,
    daemon_capacity: { maxConcurrent: 3, containerSlots: 6, buildSlots: 2 }, observed_peak_active_experiments: peak, records,
    workspace_records: workspaces.map(w => ({ id: w.id, state: w.state, taskDirectory: w.taskDirectory })),
    limitations: ['Deterministic synthetic training validates scheduling and isolation, not model quality.', 'The prior nine-run evidence remains unchanged.'] })
  console.log(JSON.stringify({ stage: 'final-runtime-passed', runtime: runtime.runtime_id, peak, tasks: 3, model_api_calls: 0 }))
} finally {
  execFileSync(executable, ['--root', state, 'daemon', 'stop'], { encoding: 'utf8', env: process.env })
}
