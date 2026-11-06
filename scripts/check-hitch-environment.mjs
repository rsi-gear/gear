// Real resident observation and drift check; no evaluation job or model request.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const { observeEvaluationEnvironment, assertEvaluationEnvironment } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/observation.js')).href)
const { canonicalDigest } = await import(pathToFileURL(join(packageRoot, 'lib/domain/canonical.js')).href)
const execute = promisify(execFile)
const executable = process.env.GEAR_TEST_HITCH
if (!executable) throw new Error('Set GEAR_TEST_HITCH to the Hitch CLI executable')
const dockerHost = process.env.DOCKER_HOST ?? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 10000 })).stdout.trim()
const root = await mkdtemp(join(tmpdir(), 'gear-hitch-environment-real-'))
await mkdir(join(root, 'home'))
const referencedFile = join(root, 'provider-config.json')
await writeFile(referencedFile, '{"endpoint":"first"}')
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8', DOCKER_HOST: dockerHost,
  ...(process.env.GEAR_TEST_HITCH_BINDING ? { GEAR_PROBE_TOKEN: 'resident-probe-only', GEAR_PROBE_ENDPOINT: 'https://resident.invalid',
    GEAR_PROBE_CONFIG: referencedFile, HITCH_EVALUATION_FILE_ENV_JSON: '["GEAR_PROBE_CONFIG"]' } : {}),
  ...(process.env.HITCH_HARBOR_PATH ? { HITCH_HARBOR_PATH: process.env.HITCH_HARBOR_PATH } : {}) }
const json = async args => JSON.parse((await execute(executable, ['--root', root, ...args], { env, encoding: 'utf8', timeout: 55000 })).stdout)
const daemon = spawn(executable, ['--root', root, 'daemon', 'serve', '--port', '0',
  '--capacity-cpu-millis', '1000', '--capacity-memory-mib', '1024', '--container-slots', '0', '--build-slots', '0'],
  { env, stdio: ['ignore', 'ignore', 'pipe'] })
let diagnostics = '', closed = false
const exited = new Promise(resolve => { daemon.once('close', () => { closed = true; resolve() }); daemon.once('error', () => { closed = true; resolve() }) })
daemon.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096) })
try {
  let ready = false
  for (let i = 0; i < 60 && !closed; i++) {
    if (await json(['daemon', 'status', '--json']).then(s => s.status === 'running', () => false)) { ready = true; break }
    await delay(250)
  }
  assert.ok(ready, 'Probe daemon did not start: ' + diagnostics)
  const signal = new AbortController().signal
  const observed = await observeEvaluationEnvironment(json, signal)
  await assertEvaluationEnvironment(json, signal, observed)
  const changed = structuredClone(observed)
  changed.environment.docker.engine_id = 'deliberately-wrong-engine'
  await assert.rejects(assertEvaluationEnvironment(json, signal, changed), { code: 'hitch-environment-drift' })
  let residentBinding = false, referencedFileDrift = false
  if (process.env.GEAR_TEST_HITCH_BINDING) {
    const { prepareEnvironmentBinding } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/binding.js')).href)
    assert.equal((await json(['capabilities', '--json'])).evaluation_environment_binding, '3')
    const profile = { executable, root, model: 'probe/no-model-call', passEnv: ['GEAR_PROBE_TOKEN', 'GEAR_PROBE_ENDPOINT'], timeoutMs: 1000 }
    const first = await prepareEnvironmentBinding(profile, json, signal)
    const caller = async args => JSON.parse((await execute(executable, ['--root', root, ...args], {
      env: { ...env, GEAR_PROBE_TOKEN: 'caller-probe-only', GEAR_PROBE_ENDPOINT: 'https://caller.invalid' },
      encoding: 'utf8', timeout: 55000,
    })).stdout)
    assert.deepEqual(await prepareEnvironmentBinding(profile, caller, signal), first)
    assert.ok(!JSON.stringify(first).includes(env.GEAR_PROBE_TOKEN))
    assert.ok(!JSON.stringify(first).includes(env.GEAR_PROBE_ENDPOINT))
    await writeFile(referencedFile, '{"endpoint":"changed"}')
    assert.notDeepEqual(await prepareEnvironmentBinding(profile, json, signal), first)
    await writeFile(referencedFile, '{"endpoint":"first"}')
    assert.deepEqual(await prepareEnvironmentBinding(profile, json, signal), first)
    referencedFileDrift = true
    residentBinding = true
  }
  assert.deepEqual((await json(['eval', 'list', '--json'])).evals, [])
  console.log(JSON.stringify({ realHitchDaemon: true, freshWorkerObservation: true, stableIdentity: canonicalDigest(observed),
    harbor: observed.environment.harbor.version, docker: observed.environment.docker.version,
    changedIdentityRejected: true, residentBinding, referencedFileDrift, evaluationJobs: 0, modelCalls: 0 }))
} finally {
  if (!closed) daemon.kill('SIGTERM')
  await Promise.race([exited, delay(5000)])
  if (!closed) { daemon.kill('SIGKILL'); await Promise.race([exited, delay(5000)]) }
  if (closed) await rm(root, { recursive: true, force: true })
  else throw new Error('Probe daemon cleanup unconfirmed; retained ' + root)
}
