import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap } from '../prepare.mjs'
import { verifyHarness } from '../target-carrier/fixed/integrity.mjs'
import { checkCandidate } from '../target-carrier/fixed/check.mjs'
import { Store } from '../lib/store.mjs'
import { digest, defaultBudget, seal, sha, zeroCost } from '../lib/contracts.mjs'
import { Budget } from '../lib/budget.mjs'
import { schema, validateSchema } from '../lib/schemas.mjs'
import { HitchBackend, executionBinding } from '../lib/hitch-backend.mjs'
import { command } from '../lib/common.mjs'

test('bootstrap manifest keeps the legacy Gear byte identity and fixed closure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-carrier-')); t.after(() => rm(root, { recursive: true, force: true }))
  const result = await bootstrap(join(root, 'target'))
  const actual = await verifyHarness(result.targetRepository)
  assert.equal(actual.manifest.digest, result.harness.manifestDigest)
  assert.equal((await checkCandidate(result.targetRepository, { checkManifest: true })).ok, true)
  assert.ok(await readFile(join(result.targetRepository, 'fixed/lib/schemas.mjs')))
  const { Driver } = await import(pathToFileURL(join(result.targetRepository, 'fixed/driver.mjs')))
  const driver = new Driver(result.targetRepository)
  driver.runId = 'run_' + '1'.repeat(32)
  driver.checkpoint = { history: [], currentSolutionDigest: null }; driver.trace = []
  let attempts = 0
  driver.policyOnce = async () => { attempts++; return { action: { action: 'invented' }, memory: {} } }
  let failure
  try { await driver.policy('research') } catch (error) { failure = error }
  assert.equal(failure.code, 'POLICY_ERROR'); assert.equal(attempts, 2)
  driver.publish = async () => {}
  const stopped = await driver.failPolicy(failure)
  assert.equal(stopped.stopped, true); assert.equal(driver.evaluation.status, 'candidate_failed')
  assert.equal(driver.selection, null); assert.equal(driver.trace.filter(e => e.status === 'policy_error').length, 2)
  // The one correction is actually offered the previous error, not an
  // undisclosed fallback policy.
  attempts = 0
  driver.policyOnce = async () => { attempts++; return { action: { action: attempts === 1 ? 'invalid' : 'draft', parentExperimentId: null }, memory: {} } }
  assert.equal((await driver.policy('research')).action.action, 'draft'); assert.equal(attempts, 2)
})

test('Gear and Hitch publish byte-identical schemas and golden fixtures', { skip: !process.env.GEAR_ANALYSIS_HITCH_REPOSITORY }, async () => {
  for (const [local, remote] of [['fixtures/analysis.schema.json', 'analysis.schema.json'], ['fixtures/golden.json', 'golden.json'], ['lib/schemas.mjs', 'schemas.mjs']])
    assert.deepEqual(await readFile(new URL('../' + local, import.meta.url)), await readFile(join(process.env.GEAR_ANALYSIS_HITCH_REPOSITORY, 'benchmark-packages/kaggle/analysis-contracts', remote)))
})

test('private labels and scorer changes invalidate admission without exposing them to Target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-binding-')); t.after(() => rm(root, { recursive: true, force: true }))
  const paths = ['train.csv', 'predict.csv', 'expected.csv', 'benchmark-packages/kaggle/analysis.mjs',
    'benchmark-packages/kaggle/runtime/analysis-verify.py', 'benchmark-packages/kaggle/analysis-contracts/schemas.mjs']
  for (const path of paths) { const full = join(root, path); await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, path) }
  const config = { train: join(root, paths[0]), predict: join(root, paths[1]), expected: join(root, paths[2]), hitchRepository: root,
    executorCommit: 'a'.repeat(40), runtimeDigest: digest('runtime'), model: 'fixture', platform: 'linux/arm64', baseImage: 'fixture@sha256:' + '1'.repeat(64) }
  const store = new Store(join(root, 'state')), frozen = await executionBinding(config)
  await store.save('bindings', 'execution', frozen)
  const backend = new HitchBackend(store, config); backend.hitch = async () => ({ run_output_artifacts: '1', sealed_source_execution: '1' })
  const plan = { runtimeDigest: config.runtimeDigest, model: 'fixture', budget: defaultBudget, task: { inputs: {} } }
  await backend.admit(plan); assert.equal(backend.bindingDigest, frozen.digest)
  await writeFile(config.expected, 'different labels')
  await assert.rejects(backend.admit(plan), /execution contract/)
})
test('published golden schema rejects unknown research fields', async () => {
  const golden = JSON.parse(await readFile(new URL('../fixtures/golden.json', import.meta.url)))
  validateSchema('Task', golden.task); validateSchema('Checkpoint', golden.checkpoint)
  assert.deepEqual(JSON.parse(await readFile(new URL('../fixtures/analysis.schema.json', import.meta.url))), schema)
  assert.throws(() => validateSchema('Checkpoint', { ...golden.checkpoint, externalReward: .9 }), /fields/)
  assert.throws(() => validateSchema('Task', { ...golden.task, prediction: { ...golden.task.prediction, targetColumn: 7 } }), /string/)
})
test('observational model usage is explicitly unbounded and keeps uncertainty', () => {
  const b = new Budget({ ...defaultBudget, tokens: null, requests: null })
  b.observeModel('call-1', 200000, true); b.observeModel('call-2', 0, false)
  assert.equal(b.available().tokens, null); assert.equal(b.state.used.tokens, 200000)
  assert.equal(b.state.events[1].measured, false); assert.equal(b.state.events[1].price, 'unknown')
  b.reserve('step', zeroCost()); b.settle('step', { ...zeroCost(), tokens: 300000, requests: 2 })
  assert.equal(b.state.used.tokens, 500000)
})

test('expired Hitch recovery authenticates the original delivery without materializing or submitting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), commit = 'c'.repeat(40), backend = new HitchBackend(store, { executorCommit: commit })
  const request = seal({ protocol: 'analysis-delivery-request@1', task: { protocol: 'analysis-task@3', prediction: { metric: 'accuracy' } },
    solution: { digest: digest('solution') } })
  const task = { taskId: 'analysis-recovery', taskDigest: digest('task'), datasetDigest: digest('dataset') }
  const runId = 'run_' + 'a'.repeat(32), evalId = 'eval_' + 'b'.repeat(32)
  const output = seal({ protocol: 'analysis-execution-receipt@1', requestDigest: request.digest, runId,
    solutionDigest: request.solution.digest, modelRequests: 0, predictionsDigest: digest('predictions'), cpuSeconds: 1 })
  const bytes = Buffer.from(JSON.stringify(output))
  const manifest = seal({ schema_version: '1', kind: 'run-output-artifacts', run_id: runId, eval_id: evalId,
    task_id: task.taskId, task_digest: task.taskDigest, attempt: 1, harness_commit: commit,
    entries: [{ name: 'receipt', path: 'output/receipt.json', media_type: 'application/json', bytes: bytes.length, sha256: sha(bytes) }] })
  const rewards = { total_score: .8, task_score: .8, valid_output: 1 }
  await store.save('executions', request.digest.slice(7), { requestDigest: request.digest, evalId, task, status: 'reserved' })
  backend.materialize = async () => { throw new Error('recovery must not prepare another task') }
  const calls = []
  backend.hitch = async args => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[0] === 'eval' && args[1] === 'inspect') return { schema_version: '1', eval_id: evalId,
      result: { trials: [{ task_id: task.taskId, run_id: runId, observation_status: 'valid', scores: rewards }] } }
    if (args[0] === 'runs' && args[2] === 'list') return manifest
    if (args[0] === 'runs' && args[2] === 'export') {
      const destination = args[args.indexOf('--out') + 1]
      await mkdir(join(destination, 'output'), { recursive: true }); await writeFile(join(destination, 'output/receipt.json'), bytes)
      return { schema_version: '1', kind: 'run-output-artifacts-export', run_id: runId, manifest_digest: manifest.digest, destination }
    }
    if (args[0] === 'verifier') return { run_id: runId, parent: { eval_id: evalId, attempt: 1 }, observation: { status: 'valid' },
      verifier: { status: 'complete', result: { rewards }, result_sha256: digest('verifier') } }
    throw new Error(`unexpected recovery command: ${args.join(' ')}`)
  }
  const delivery = await backend.recover(request, null)
  assert.equal(delivery.status, 'completed'); assert.equal(delivery.quality, .8)
  assert.equal(delivery.requestDigest, request.digest); assert.equal(delivery.runId, runId)
  assert.equal(delivery.outputManifestDigest, manifest.digest)
  assert.deepEqual(calls, ['eval inspect', 'runs artifacts', 'runs artifacts', 'verifier inspect'])
  assert.equal((await store.load('executions', request.digest.slice(7))).evalId, evalId)
})

test('expired Hitch recovery never submits missing or incomplete executions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-no-retry-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), backend = new HitchBackend(store, {})
  const request = seal({ protocol: 'analysis-delivery-request@1' }), id = request.digest.slice(7)
  backend.materialize = async () => { throw new Error('recovery must not prepare another task') }
  backend.hitch = async () => { throw new Error('missing execution must not call Hitch') }
  await assert.rejects(backend.recover(request, null), /no admitted execution/)
  const operation = { requestDigest: request.digest, evalId: 'original-eval', task: { datasetDigest: digest('dataset') }, status: 'reserved' }
  await store.save('executions', id, operation)
  for (const missing of [false, true]) {
    backend.hitch = async args => {
      assert.deepEqual(args, ['eval', 'inspect', operation.evalId, '--json'])
      if (missing) { const error = new Error('evaluation not found'); error.exitCode = 3; throw error }
      return { schema_version: '1', eval_id: operation.evalId, result: null }
    }
    await assert.rejects(backend.recover(request, null), missing ? /evaluation not found/ : /evaluation pending/)
    assert.deepEqual(await store.load('executions', id), operation)
  }
})

test('worker disk accounting tolerates disappearing temporary files and retains other errors', async () => {
  await command(process.env.GEAR_MLEBENCH_PYTHON ?? 'python3',
    ['-B', fileURLToPath(new URL('./worker-supervisor.py', import.meta.url))])
})
