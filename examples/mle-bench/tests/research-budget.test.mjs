import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Backend, checkpoint, task } from './project-fixture.mjs'
import { sequencePlan, SequenceRunner } from '../lib/sequence.mjs'
import { Store } from '../lib/store.mjs'
import { defaultBudget, digest, researchBudget, seal, validateCheckpoint, validateExperiment } from '../lib/contracts.mjs'
import { validateSchema } from '../lib/schemas.mjs'
import { researchConfig } from '../lib/research-config.mjs'
import { Budget } from '../lib/budget.mjs'
import { bootstrap } from '../prepare.mjs'
import { verifyHarness } from '../target-carrier/fixed/integrity.mjs'
import { trajectoryReport } from '../lib/report.mjs'
import { command } from '../lib/common.mjs'

for (const count of [1, 3, 7]) test(`${count} full 30-minute experiments fit the admitted budget and leave time for final delivery`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-budget-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), start = checkpoint(), backend = new Backend(store)
  let now = Date.now()
  const originalRollout = backend.rollout.bind(backend), originalDeliver = backend.deliver.bind(backend)
  backend.rollout = async (request, history) => {
    assert.equal(request.experimentWallSeconds, 1800); assert.equal(request.experimentCpuSeconds, 3600)
    assert.ok(request.allowance.wallSeconds >= 1800); assert.ok(request.allowance.cpuSeconds >= 3600)
    const result = await originalRollout(request, history)
    now += (1800 + 120) * 1000 // A full training run plus model/data-analysis time, without a real wait.
    const { digest: _receipt, ...body } = result, { digest: _experiment, ...experiment } = result.experiment
    const cost = { ...result.cost, cpuSeconds: 3600 + 30 }
    const recorded = seal({ ...experiment, execution: { ...experiment.execution, cost } })
    return seal({ ...body, cost, experiment: recorded, availableEvidenceRefs: [recorded.digest] })
  }
  backend.deliver = async request => {
    assert.ok(request.allowance.wallSeconds >= 1800); assert.ok(request.allowance.cpuSeconds >= 3600)
    const { digest: _, ...body } = await originalDeliver(request)
    now += 1800 * 1000
    return seal({ ...body, cost: { ...body.cost, cpuSeconds: 3600 } })
  }
  const plan = sequencePlan({ task, checkpoint: start, harness: { commit: 'a'.repeat(40), manifestDigest: digest('harness') },
    model: 'fixture', budget: researchBudget({ maxExperiments: count }), runtimeDigest: task.runtimeDigest, research: { maxExperiments: count } })
  const runner = new SequenceRunner(store, backend, { now: () => now })
  const result = await runner.run(plan, start)
  assert.equal(result.cost.used.cpuSeconds, count * 3630 + 3600)
  assert.equal(result.planned, count); assert.equal(result.attempted, count); assert.equal(result.unused, 0)
  assert.equal(result.selections.length, count); assert.equal(backend.deliveries, 1)
  assert.ok(backend.calls.every(c => c.request.maxExperiments === count && c.request.task.validationPlanDigest === task.validationPlanDigest))
  const state = await store.load('sequences', plan.digest.slice(7))
  assert.equal(result.delivery.solutionDigest, state.steps.at(-1).experiment.sourceDigest)
  const report = trajectoryReport(result, start, state.steps.map(s => s.experiment))
  assert.equal(report.points.at(-1).evidenceRole, 'actual_delivery'); assert.equal(report.final_quality, result.total_score)
  await runner.run(plan, start)
  assert.equal(backend.calls.length, count); assert.equal(backend.deliveries, 1)
})

test('task_inspect exposes admitted experiment budget and the fixed holdout; prompts do not encode their size', async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-inspect-')); t.after(() => rm(root, { recursive: true, force: true }))
  const carrier = await bootstrap(join(root, 'target'))
  const { Driver } = await import(pathToFileURL(join(carrier.targetRepository, 'fixed/driver.mjs')))
  const driver = new Driver(carrier.targetRepository)
  Object.assign(driver, { harness: await verifyHarness(carrier.targetRepository), checkpoint: checkpoint(), holdout: true,
    request: { task, slotIndex: 2, maxExperiments: 7, experimentWallSeconds: 1800, experimentCpuSeconds: 3600,
      allowance: { tokens: null } }, budget: new Budget(defaultBudget), trace: [],
    plan: { protocol: 'analysis-holdout-plan@1', seed: 42, metric: 'accuracy', validationFraction: .25, assignments: [0, 0, 0, 1] },
    initialDecision: { action: { action: 'draft', parentExperimentId: null }, memory: {} } })
  const inspection = await driver.inspect()
  assert.deepEqual(inspection.experiments, { current: 2, total: 7, remaining: 5, includingCurrent: 6 })
  assert.equal(inspection.validation.trainingRows, 3); assert.equal(inspection.validation.validationRows, 1)
  assert.equal(inspection.validation.digest, task.validationPlanDigest); assert.equal(inspection.validation.folds, undefined)
  assert.deepEqual(inspection.training, { wallSeconds: 1800, cpuSeconds: 3600 })
  const prompt = await readFile(join(carrier.targetRepository, 'harness/prompts/research.md'), 'utf8')
  assert.doesNotMatch(prompt, /five[- ](?:fold|experiment)|C5/i)
  // Load the actual tool registration with only the external tool factory stubbed.
  const module = join(carrier.targetRepository, 'node_modules/@deepseek-ai/dsh-tools')
  await mkdir(module, { recursive: true })
  await writeFile(join(module, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  await writeFile(join(module, 'index.js'), 'export const defineTool = value => value\n')
  Driver.prototype.initialize = async function () {
    Object.assign(this, driver)
    this.workflowConfig = JSON.parse(await readFile(join(carrier.targetRepository, 'harness/workflow.yaml'), 'utf8'))
  }
  const { apply } = await import(pathToFileURL(join(carrier.targetRepository, 'fixed/target-loader.js')))
  await assert.rejects(apply({}, { reasoningEffort: 'high' }), /reasoningEffort=max/)
  await assert.rejects(apply({}, {}), /reasoningEffort=max/)
  const previousLoaderUrl = process.env.DSH_REFINE_TARGET_LOADER_URL
  process.env.DSH_REFINE_TARGET_LOADER_URL = pathToFileURL(join(carrier.targetRepository, 'fixed/target-loader.js')).href
  try {
    const shim = await import(pathToFileURL(join(carrier.targetRepository, 'fixed/target-loader-shim.js')))
    assert.ok(shim.inject.includes('agentDefaultModel'))
    assert.ok(shim.inject.includes('settings'))
  } finally {
    if (previousLoaderUrl === undefined) delete process.env.DSH_REFINE_TARGET_LOADER_URL
    else process.env.DSH_REFINE_TARGET_LOADER_URL = previousLoaderUrl
  }
  const registered = new Map()
  let selectedModel
  await apply({ on() {}, provide() {}, systemPrompt: { section() {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai-codex', model: 'gpt-6-astra' }),
      async saveSelection(value) { selectedModel = value } },
    tools: { guard() {}, register(tool) { registered.set(tool.name, tool) } } }, { repositoryRoot: carrier.targetRepository, reasoningEffort: 'max' })
  assert.deepEqual(selectedModel, { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'max' })
  assert.ok(registered.get('experiment_evaluate').timeoutMs > 1800 * 1000)
  assert.ok(registered.get('experiment').timeoutMs > 1800 * 1000)
  assert.equal(registered.get('analysis_execute').timeoutMs, 300000)
})

test('research configuration rejects ambiguous or invalid budgets and validation splits', () => {
  for (const value of [{ maxExperiments: 0 }, { maxExperiments: 1.5 }, { validation: { fraction: 1 } },
    { validation: { fraction: 0 } }, { validation: { folds: 3 } }, { validation: { seed: -1 } }])
    assert.throws(() => researchConfig(value))
})

test('fixed driver seals holdout evidence, enforces one formal evaluation and reuses the same split', async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-driver-')); t.after(() => rm(root, { recursive: true, force: true }))
  const carrier = await bootstrap(join(root, 'target'))
  const { Driver } = await import(pathToFileURL(join(carrier.targetRepository, 'fixed/driver.mjs')))
  const work = join(root, 'work'), output = join(root, 'output'), data = join(root, 'data')
  for (const p of [join(work, 'workspace'), join(output, 'objects'), data]) await mkdir(p, { recursive: true })
  await writeFile(join(work, 'workspace/solution.py'), 'print("training strategy is candidate-owned")\n')
  const predictions = join(root, 'predictions.json'); await writeFile(predictions, '{"heldout":["1"]}')
  const plan = { protocol: 'analysis-holdout-plan@1', seed: 42, assignments: [0, 0, 1], metric: 'accuracy', validationFraction: .3 }
  const { digest: _, ...body } = task
  const targetTask = seal({ ...body, validationPlanDigest: digest(plan) })
  const driver = new Driver(carrier.targetRepository, { work, output, data })
  Object.assign(driver, { harness: await verifyHarness(carrier.targetRepository), holdout: true, plan,
    runId: 'run_' + 'a'.repeat(32), checkpoint: checkpoint(), budget: new Budget(defaultBudget), trace: [],
    action: { action: 'draft', parentExperimentId: null },
    request: { digest: digest('request'), task: targetTask, slotIndex: 1, maxExperiments: 7, sequenceId: 'sequence',
      runtimeDigest: task.runtimeDigest, eligibleSolutionDigests: [], experimentWallSeconds: 1800, experimentCpuSeconds: 3600 } })
  let executions = 0
  driver.meteredWorker = async job => {
    executions++; assert.equal(job.operation, 'evaluate'); assert.deepEqual(job.validationPlan, plan)
    assert.equal(job.wallSeconds, 1800); assert.equal(job.cpuSeconds, 3600)
    return { status: 'completed', metric: 'accuracy', validationScore: 1, validationUtility: 1, validationRows: 1,
      predictionsPath: predictions, logs: [], cpuSeconds: 1 }
  }
  const args = { entrypoint: 'solution.py', hypothesis: 'fixture', intendedChange: 'fixture' }
  await driver.evaluate(args)
  await assert.rejects(driver.evaluate(args), /one formal experiment/)
  await assert.rejects(driver.write('solution.py', 'changed', null), /sealed after evaluation/)
  const experiment = validateExperiment(driver.experiment())
  assert.equal(experiment.execution.validationScore, 1); assert.equal(experiment.execution.foldMetrics, undefined)
  driver.policy = async () => {
    driver.trace.push({ phase: 'select', policyDigest: digest('fixture-policy') })
    return { action: { action: 'select', solutionDigest: driver.solution.digest } }
  }
  await driver.select(); await driver.finish('completed', [])
  validateSchema('RolloutOutput', JSON.parse(await readFile(join(output, 'receipt.json'))))
  const cached = new Driver(carrier.targetRepository)
  Object.assign(cached, { request: driver.request, holdout: true, plan, runId: 'run_' + 'b'.repeat(32),
    checkpoint: { history: [experiment], solutions: [driver.solution] }, budget: new Budget(defaultBudget), action: { action: 'reuse' } })
  const reused = validateExperiment(await cached.reuse(driver.solution.digest, 'same frozen validation'))
  assert.equal(reused.execution.predictionsDigest, experiment.execution.predictionsDigest)
  assert.equal(reused.execution.status, 'reused'); assert.equal(executions, 1)
})

test('fixed worker hides validation labels during both analysis and formal evaluation', async () => {
  const result = JSON.parse(await command(process.env.GEAR_MLEBENCH_PYTHON ?? 'python3',
    ['-B', 'examples/mle-bench/tests/holdout-worker.py']))
  assert.equal(result.status, 'passed'); assert.equal(result.validationLabels, 'hidden')
})

test('checkpoint example retains unsuccessful and unselected hypotheses alongside the chosen source', async () => {
  const checkpoint = validateCheckpoint(JSON.parse(await readFile(new URL('../fixtures/checkpoint-holdout.example.json', import.meta.url))))
  assert.equal(checkpoint.history.length, 4)
  assert.ok(checkpoint.history.every(e => e.claim.hypothesis && e.claim.intendedChange && e.interpretation.conclusion))
  assert.equal(checkpoint.history[2].execution.status, 'candidate_failed')
  assert.equal(checkpoint.history[2].execution.validationScore, null)
  assert.notEqual(checkpoint.history[1].sourceDigest, checkpoint.currentSolutionDigest)
  assert.equal(checkpoint.history[3].sourceDigest, checkpoint.currentSolutionDigest)
})
