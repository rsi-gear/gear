// Actual read-only Hitch inspect transport over synthetic records; no daemon/model.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const executable = process.env.GEAR_TEST_HITCH
if (!executable) throw new Error('Set GEAR_TEST_HITCH to the Hitch CLI executable')
const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const { assertHitchExecutionConditions } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/conditions.js')).href)
const { hitchJson } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/transport.js')).href)
let hitchRoot = dirname(await realpath(executable))
let evalsExport
let backendsExport
for (;;) {
  const metadata = await readFile(join(hitchRoot, 'package.json'), 'utf8').then(JSON.parse, () => null)
  if (metadata?.name === 'agent-hitch' && typeof metadata.exports?.['./evals'] === 'string') {
    evalsExport = pathToFileURL(join(hitchRoot, metadata.exports['./evals'])).href
    backendsExport = pathToFileURL(join(hitchRoot, metadata.exports['./backends'])).href
    break
  }
  if (dirname(hitchRoot) === hitchRoot) throw new Error('Hitch executable must belong to an installed agent-hitch package with public evals API')
  hitchRoot = dirname(hitchRoot)
}
const { buildEvalExecutionPlan } = await import(evalsExport)
const { lockedHarnessRef } = await import(backendsExport)
const root = await mkdtemp(join(tmpdir(), 'gear-hitch-conditions-'))
try {
  const harnesses = ['deepseek@version:0.1.1-rc.2', 'pi@version:0.84.1',
    `deepseek@git+${pathToFileURL(join(root, 'repository')).href}#${'1'.repeat(40)}`]
  for (const [index, harness] of harnesses.entries()) {
    const evalId = 'eval_' + 'abc'[index].repeat(32)
    const expected = { evalId, taskIds: ['a'], controllerRuntimeId: 'sha256:' + 'd'.repeat(64), provider: 'local-docker', dataset: join(root, 'dataset'), harnessRef: harness,
      revisionIdentity: 'sha256:' + 'c'.repeat(64), model: 'fixture', timeoutMs: 3000, maxConcurrent: 1, setupTimeoutMs: 30000,
      agentArgs: harness.startsWith('pi') ? ['--approve', '--offline'] : ['--patch', '/opt/gear-target.patch.yml'], passEnv: [], environmentBinding: 'hmac-sha256:' + 'e'.repeat(64) }
    const directory = join(root, 'evals', evalId)
    await mkdir(directory, { recursive: true })
    const request = { schema_version: '1', backend: 'harbor', dataset: expected.dataset, harness_ref: harness,
      model: expected.model, environment_binding: expected.environmentBinding, attempts: 1, max_concurrent: 1, infrastructure_retries: 0,
      setup_timeout_ms: 30000, infrastructure_retry_backoff_ms: 0, benchmark_id: 'fixture', benchmark_revision: 'fixture',
      timeout_ms: expected.timeoutMs, agent_args: expected.agentArgs, pass_env: [] }
    const localGit = harness.includes('@git+')
    const resolved = { harness_id: harness.split('@')[0], revision: localGit
      ? { type: 'commit', commit: harness.slice(harness.lastIndexOf('#') + 1) }
      : { type: 'version', version: harness.split('@version:')[1] } }
    const candidate = { revision_identity: expected.revisionIdentity, model: expected.model,
      harness_id: resolved.harness_id, harness_ref: lockedHarnessRef(resolved), requested_harness_ref: harness }
    const artifact = { artifact_id: 'sha256:' + 'e'.repeat(64), artifact_integrity: 'sha256:' + 'f'.repeat(64), entrypoint_integrity: 'sha256:' + '1'.repeat(64),
      harness_id: candidate.harness_id, revision_identity: expected.revisionIdentity, platform: 'linux-arm64', node_version: 'v22.23.0', source_type: localGit ? 'git' : 'npm', storage: 'harbor-artifact-cache-v2' }
    expected.artifactPins = [{ platform: artifact.platform, artifact_id: artifact.artifact_id,
      artifact_integrity: artifact.artifact_integrity, entrypoint_integrity: artifact.entrypoint_integrity }]
    request.artifact_pins = expected.artifactPins
    const runtime = { docker_platform: 'linux/arm64', artifact_platform: artifact.platform, node_version: artifact.node_version }
    const fields = { prepared_artifact: artifact, prepared_artifacts: [{ ...artifact, task_ids: expected.taskIds, runtime_contract: runtime }] }
    const execution = buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: expected.revisionIdentity, artifactId: artifact.artifact_id,
      artifactAssignments: [{ taskIds: expected.taskIds, artifactId: artifact.artifact_id, runtimeContract: runtime }] }, tasks: expected.taskIds, maxParallelism: 1, provider: expected.provider, workItemMode: 'task-slots' })
    const result = { ...fields, schema_version: '1', eval_id: evalId, status: 'succeeded', candidate, dataset: expected.dataset, trials: [] }
    for (const [name, value] of Object.entries({ request, resolution: { identity: expected.revisionIdentity }, result, plan: { ...fields, controller_runtime: { runtime_id: expected.controllerRuntimeId } }, 'execution-plan': execution }))
      await writeFile(join(directory, name + '.json'), JSON.stringify(value))
    const inspect = () => hitchJson(executable, root, ['eval', 'inspect', evalId, '--json'], new AbortController().signal)
    const original = await inspect()
    assert.equal(assertHitchExecutionConditions(original, expected)[0].artifact.artifact_id, artifact.artifact_id)
    for (const key of ['harness_ref', 'requested_harness_ref', 'revision_identity']) {
      const changed = structuredClone(original)
      changed.result.candidate[key] += '-changed'
      assert.throws(() => assertHitchExecutionConditions(changed, expected), { code: 'hitch-result-identity' })
    }
    const wrongArtifact = structuredClone(original)
    wrongArtifact.execution_plan.work_items[0].artifact_id = 'sha256:' + '2'.repeat(64)
    assert.throws(() => assertHitchExecutionConditions(wrongArtifact, expected), { code: 'hitch-artifact-identity' })
    await writeFile(join(directory, 'request.json'), JSON.stringify({ ...request, agent_args: ['--patch', '/changed.yml'] }))
    const changed = await inspect()
    assert.throws(() => assertHitchExecutionConditions(changed, expected), { code: 'hitch-result-identity' })
  }
} finally { await rm(root, { recursive: true, force: true }) }
console.log(JSON.stringify({ realHitchInspect: true, adapters: ['dsh', 'pi'], localGit: true, realHitchLockedReference: true, changedRequestRejected: true, changedSourceOrCommitRejected: true, realHitchExecutionPlanner: true, changedArtifactRejected: true, syntheticRecords: true, modelCalls: 0 }))
