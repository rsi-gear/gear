import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap } from '../prepare.mjs'
import { verifyHarness } from '../target-carrier/fixed/integrity.mjs'
import { checkCandidate } from '../target-carrier/fixed/check.mjs'
import { Store } from '../lib/store.mjs'
import { ExposureLedger } from '../lib/exposure.mjs'
import { digest, defaultBudget, zeroCost } from '../lib/contracts.mjs'
import { Budget } from '../lib/budget.mjs'
import { schema, validateSchema } from '../lib/schemas.mjs'
import { HitchBackend, executionBinding } from '../lib/hitch-backend.mjs'

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
test('transfer disclosure survives new project aliases and never rewrites the first freeze', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-exposure-')); t.after(() => rm(root, { recursive: true, force: true }))
  const ledger = new ExposureLedger(new Store(root)), source = digest('same dataset bytes')
  const input = { suiteDigest: digest('suite'), sourceDigests: [source], taskFamilyIds: ['original'], finalist: 'a', reference: 'b', budgetDigest: digest('budget'), provenanceVerified: true }
  const first = await ledger.freeze(input); assert.equal(first.exposure, 'untouched')
  await ledger.disclose(first, digest('report'))
  const renamed = await new ExposureLedger(new Store(root)).freeze({ ...input, suiteDigest: digest('renamed'), taskFamilyIds: ['new-name'] })
  assert.equal(renamed.exposure, 'already_exposed'); assert.equal(first.exposure, 'untouched')
  assert.equal((await ledger.freeze({ ...input, provenanceVerified: false })).exposure, 'exposure_unknown')
})
