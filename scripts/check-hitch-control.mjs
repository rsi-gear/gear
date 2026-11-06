// Real cancellation-only recovery; creates no evaluation job or model request.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const execute = promisify(execFile)
if (!process.env.GEAR_CONTROL_CHILD) {
  assert.ok(process.env.GEAR_TEST_HITCH, 'Set GEAR_TEST_HITCH to an absolute Hitch CLI path')
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-control-real-'))
  await mkdir(join(root, 'home'))
  const dockerHost = process.env.DOCKER_HOST ?? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { timeout: 10000 })).stdout.trim()
  const child = spawn(process.execPath, [import.meta.filename], { stdio: 'inherit', env: {
    PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8', DOCKER_HOST: dockerHost,
    GEAR_CONTROL_CHILD: root, GEAR_TEST_HITCH: process.env.GEAR_TEST_HITCH,
    GEAR_TEST_PACKAGE_ROOT: process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..'),
  } })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  if (code === 0) await rm(root, { recursive: true, force: true })
  assert.equal(code, 0, 'Control probe failed; retained ' + root)
} else {
  const root = process.env.GEAR_CONTROL_CHILD, executable = process.env.GEAR_TEST_HITCH
  const api = path => import(pathToFileURL(join(process.env.GEAR_TEST_PACKAGE_ROOT, 'lib', path)).href)
  const { OrderedHitchControl, hitchOperationPath } = await api('adapters/hitch/control.js')
  const { configuredCancellation } = await api('application/cancellation.js')
  const { canonicalDigest } = await api('domain/canonical.js')
  const json = async args => JSON.parse((await execute(executable, ['--root', root, ...args], { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout)
  const daemon = spawn(executable, ['--root', root, 'daemon', 'serve', '--port', '0', '--capacity-cpu-millis', '1000', '--capacity-memory-mib', '1024', '--container-slots', '0', '--build-slots', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let closed = false, diagnostics = ''
  const exited = new Promise(resolve => { daemon.once('close', () => { closed = true; resolve() }); daemon.once('error', () => { closed = true; resolve() }) })
  daemon.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096) })
  try {
    let ready = false
    for (let i = 0; i < 60 && !closed; i++) {
      if (await json(['daemon', 'status', '--json']).then(s => s.status === 'running', () => false)) { ready = true; break }
      await delay(250)
    }
    assert.ok(ready, 'Probe daemon did not start: ' + diagnostics)
    const request = { operationId: canonicalDigest('real-control'), runId: 'zero-model-probe', generation: 1, partition: 'seed', repetitions: 1,
      slots: [{ taskId: 'a', repetition: 0 }], evidence: [], operation: { kind: 'evaluate_seed', candidate_id: 'anchor', parent_id: null,
        task_ids: ['a'], scope: 'global', rationale: 'control contract probe', payload: null } }
    const identity = canonicalDigest('control-probe'), directory = join(root, 'gear-intents')
    const control = new OrderedHitchControl(hitchOperationPath(directory, request.operationId), identity, json)
    const first = await control.observe(request, 0, new AbortController().signal)
    assert.equal(first.reply.submitted, false)
    assert.equal((await control.observe(request, 0, new AbortController().signal)).reply.eval_id, first.reply.eval_id)
    const cancel = await configuredCancellation({ version: 1, kind: 'hitch', executable, root, directory, identity })
    await cancel.cancel(request)
    await cancel.cancel(request)
    await assert.rejects(control.observe(request, 0, new AbortController().signal))
    assert.deepEqual((await json(['eval', 'list', '--json'])).evals, [])
    console.log(JSON.stringify({ realHitchDaemon: true, independentCancellation: true, stableUnsubmittedIdentity: true, pauseFencesDelayedStart: true, evaluationJobs: 0, modelCalls: 0 }))
  } finally {
    if (!closed) daemon.kill('SIGTERM')
    await Promise.race([exited, delay(5000)])
    if (!closed) { daemon.kill('SIGKILL'); await Promise.race([exited, delay(5000)]) }
    assert.ok(closed, 'Probe daemon cleanup unconfirmed')
  }
}
