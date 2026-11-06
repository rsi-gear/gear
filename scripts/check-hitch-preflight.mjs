// Gear production pre-admission preparation against real Hitch/Docker. No model requests.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const execute = promisify(execFile)
if (!process.env.GEAR_PREFLIGHT_CHILD) {
  assert.ok(process.env.GEAR_TEST_HITCH, 'Set GEAR_TEST_HITCH')
  const output = await mkdtemp(join(tmpdir(), 'gear-preflight-proof-'))
  await mkdir(join(output, 'home'))
  const dockerHost = process.env.DOCKER_HOST ?? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { timeout: 10000 })).stdout.trim()
  const child = spawn(process.execPath, [import.meta.filename], { stdio: 'inherit', env: {
    PATH: process.env.PATH, HOME: join(output, 'home'), LANG: 'C.UTF-8', DOCKER_HOST: dockerHost,
    GEAR_PREFLIGHT_CHILD: output, GEAR_TEST_HITCH: process.env.GEAR_TEST_HITCH,
    GEAR_TEST_PACKAGE_ROOT: process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..'),
    GEAR_TEST_ARTIFACT_CACHE: process.env.GEAR_TEST_ARTIFACT_CACHE ?? join(output, 'hitch'),
    ...(process.env.HITCH_HARBOR_PATH ? { HITCH_HARBOR_PATH: process.env.HITCH_HARBOR_PATH } : {}),
  } })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Preflight proof failed; retained ' + output)
  console.log('Preflight evidence: ' + output)
} else {
  const output = process.env.GEAR_PREFLIGHT_CHILD, root = process.env.GEAR_TEST_ARTIFACT_CACHE
  const executable = process.env.GEAR_TEST_HITCH, packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT
  const api = path => import(pathToFileURL(join(packageRoot, 'lib', path)).href)
  const { HitchOperationProvider } = await api('adapters/hitch/provider.js')
  const { HitchPreparedRuntime } = await api('adapters/hitch/preparation.js')
  const { openHitchSdk } = await api('adapters/hitch/sdk.js')
  const { harnessAdapter } = await api('application/harness-adapters.js')
  const { canonicalDigest } = await api('domain/canonical.js')
  const { artifactPins } = await api('adapters/hitch/artifacts.js')
  const { runtimeMatrix } = await api('application/runtime-matrix.js')
  const json = async args => JSON.parse((await execute(executable, ['--root', root, ...args], { timeout: 55000, maxBuffer: 1024 * 1024 })).stdout)
  assert.notEqual(await json(['daemon', 'status', '--json']).then(s => s.status, () => 'stopped'), 'running', 'Use a cache without an active daemon')
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
    assert.deepEqual((await json(['eval', 'list', '--json'])).evals, [])
    const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
    const report = { platform, artifacts: [], evaluationJobs: 0, modelCalls: 0 }
    for (const [id, harness] of Object.entries(runtimeMatrix.harnesses)) {
      console.log('Freezing production provider: ' + harness)
      const profile = { kind: 'hitch', root, executable, harnessRef: harness, model: 'unused', passEnv: [], timeoutMs: 1000,
        baseImage: 'mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907' }
      const context = { directory: join(output, id, 'submissions'), targets: join(output, id, 'targets'), adapter: harnessAdapter(id),
        taskIds: ['a'], implementationIdentity: canonicalDigest('preflight-probe'),
        async compile(dataset) {
          await mkdir(join(dataset, 'a/environment'), { recursive: true })
          await writeFile(join(dataset, 'a/task.toml'), 'version = "1.0"\n')
          await writeFile(join(dataset, 'a/environment/docker-compose.yaml'), `services:\n  main:\n    image: ${profile.baseImage}\n    platform: ${platform}\n`)
        } }
      const first = await HitchOperationProvider.connect(profile, context)
      const second = await HitchOperationProvider.connect(profile, context)
      assert.equal(first.identity, second.identity)
      assert.deepEqual(first.preparedArtifacts, second.preparedArtifacts)
      assert.equal(first.preparedArtifacts[0].runtime_contract.docker_platform, platform)
      const runtime = new HitchPreparedRuntime(), signal = new AbortController().signal
      await runtime.verify(profile, first.preparedArtifacts, first.executionEnvironment, signal)
      const sdk = await openHitchSdk(profile, first.executionEnvironment)
      const artifact = await sdk.call('evals', 'loadHarborArtifact', root, first.preparedArtifacts[0].artifact)
      const manifest = JSON.parse(await readFile(join(artifact.directory, 'artifact.json'), 'utf8'))
      const entry = resolve(artifact.directory, manifest.entrypoint), bytes = await readFile(entry)
      assert.ok(entry.startsWith(artifact.directory + '/'))
      try {
        await writeFile(entry, Buffer.concat([bytes, Buffer.from('\n// preflight integrity probe\n')]))
        await assert.rejects(runtime.verify(profile, first.preparedArtifacts, first.executionEnvironment, signal), { code: 'hitch-preparation-failed' })
      } finally { await writeFile(entry, bytes) }
      await runtime.verify(profile, first.preparedArtifacts, first.executionEnvironment, signal)
      const pins = artifactPins(first.preparedArtifacts, ['a'])
      await sdk.call('backends', 'assertHarborArtifactPins', pins, [artifact])
      const pinDataset = join(output, id, 'pin-probe'), forbidden = join(output, id, 'forbidden-harbor'), marker = join(output, id, 'harbor-started')
      await mkdir(pinDataset, { recursive: true })
      await writeFile(forbidden, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected Harbor call');`, { mode: 0o700 })
      for (const field of ['artifact_id', 'artifact_integrity', 'entrypoint_integrity']) {
        await assert.rejects(sdk.call('backends', 'runHarborBackend', {
          root, evalId: 'eval_' + 'a'.repeat(32), evalDirectory: join(output, id, 'unsubmitted'),
          harborExecutable: forbidden, preparedArtifact: artifact,
          request: { dataset: pinDataset, artifact_pins: [{ ...pins[0], [field]: canonicalDigest('wrong-' + field) }] },
        }), { code: 'eval_artifact_pin_mismatch' })
        await assert.rejects(readFile(marker), { code: 'ENOENT' })
      }
      report.artifacts.push({ harness, providerIdentity: first.identity, ...first.preparedArtifacts[0], cacheStable: true, modifiedBytesRejected: true, submittedPins: pins, wrongPinsRejectedBeforeHarbor: true })
      await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    }
    assert.deepEqual((await json(['eval', 'list', '--json'])).evals, [])
    console.log(JSON.stringify(report))
  } finally {
    if (!closed) daemon.kill('SIGTERM')
    await Promise.race([exited, delay(5000)])
    if (!closed) { daemon.kill('SIGKILL'); await Promise.race([exited, delay(5000)]) }
    assert.ok(closed, 'Probe daemon cleanup unconfirmed')
    await rm(join(output, 'home'), { recursive: true, force: true })
  }
}
