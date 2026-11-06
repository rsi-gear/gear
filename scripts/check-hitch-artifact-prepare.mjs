// Public Hitch preparation API, native Docker platform, no eval or model request.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const executable = process.env.GEAR_TEST_HITCH
const output = process.env.GEAR_TEST_ARTIFACT_OUTPUT
if (!executable || !output) throw new Error('Set GEAR_TEST_HITCH and a fresh GEAR_TEST_ARTIFACT_OUTPUT directory')
let packageRoot = dirname(await realpath(executable)), metadata
for (;;) {
  metadata = await readFile(join(packageRoot, 'package.json'), 'utf8').then(JSON.parse, () => null)
  if (metadata?.name === 'agent-hitch') break
  if (dirname(packageRoot) === packageRoot) throw new Error('Hitch package not found')
  packageRoot = dirname(packageRoot)
}
const api = async name => {
  const entry = metadata.exports?.[name]
  assert.equal(typeof entry, 'string', 'Missing public Hitch export ' + name)
  return import(pathToFileURL(join(packageRoot, entry)).href)
}
const { resolveHarness } = await api('./revisions')
const { ensureControllerRuntime } = await api('./controller-runtime')
const { prepareHarborArtifact, loadHarborArtifact, buildEvalExecutionPlan } = await api('./evals')
const { harborTrialRuntimeContract } = await api('./backends')
const { hitchPreparedArtifacts } = await import('../lib/adapters/hitch/artifacts.js')
const { runtimeMatrix } = await import('../lib/application/runtime-matrix.js')
const execute = promisify(execFile)
const dockerHost = process.env.DOCKER_HOST ?? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 10000 })).stdout.trim()
await mkdir(output)
await mkdir(join(output, 'home'))
const root = join(output, 'hitch')
const env = { PATH: process.env.PATH, HOME: join(output, 'home'), LANG: 'C.UTF-8', DOCKER_HOST: dockerHost }
const platform = process.env.GEAR_TEST_ARTIFACT_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')
const controller = await ensureControllerRuntime({ root, payloadRoot: packageRoot })
const runtime = harborTrialRuntimeContract(platform)
const report = { hitch: metadata.version, platform, controllerRuntimeId: controller.runtime_id, artifacts: [], evaluationJobs: 0, modelCalls: 0 }
for (const harness of Object.values(runtimeMatrix.harnesses)) {
  console.log('Preparing ' + harness + ' for ' + platform)
  const resolved = await resolveHarness(harness, { root, env })
  const input = { root, resolvedRevision: resolved, runtimeDirectory: controller.directory, runtimeId: controller.runtime_id, runtimeContract: runtime, env }
  const first = await prepareHarborArtifact(input), again = await prepareHarborArtifact(input)
  assert.equal(again.cacheHit, true)
  assert.equal(again.artifact.artifact_id, first.artifact.artifact_id)
  const artifact = await loadHarborArtifact(root, first.artifact)
  const manifest = JSON.parse(await readFile(join(artifact.directory, 'artifact.json'), 'utf8'))
  const entrypoint = resolve(artifact.directory, manifest.entrypoint)
  assert.ok(entrypoint.startsWith(artifact.directory + '/'))
  const bytes = await readFile(entrypoint)
  try {
    await writeFile(entrypoint, Buffer.concat([bytes, Buffer.from('\n// altered artifact probe\n')]))
    await assert.rejects(loadHarborArtifact(root, artifact))
  } finally { await writeFile(entrypoint, bytes) }
  await loadHarborArtifact(root, artifact)
  const fields = { prepared_artifact: artifact, prepared_artifacts: [{ ...artifact, task_ids: ['a'], runtime_contract: {
    docker_platform: runtime.dockerPlatform, artifact_platform: runtime.artifactPlatform, node_version: runtime.nodeVersion } }] }
  const evalId = 'eval_' + 'a'.repeat(32)
  const request = { model: 'unused', attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0,
    benchmark_id: 'artifact-probe', benchmark_revision: '1', agent_args: [], timeout_ms: 3000, setup_timeout_ms: 30000 }
  const execution = buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: resolved.identity, artifactId: artifact.artifact_id,
    artifactAssignments: [{ taskIds: ['a'], artifactId: artifact.artifact_id, runtimeContract: fields.prepared_artifacts[0].runtime_contract }] }, tasks: ['a'], maxParallelism: 1, workItemMode: 'task-slots' })
  const bindings = hitchPreparedArtifacts({ plan: fields, result: fields, execution_plan: execution }, {
    evalId, taskIds: ['a'], harnessRef: harness, revisionIdentity: resolved.identity, provider: 'local-docker' })
  report.artifacts.push({ harness, ...bindings[0], dependencyLock: manifest.dependency_lock, cacheIdentityStable: true, modifiedBytesRejected: true })
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
