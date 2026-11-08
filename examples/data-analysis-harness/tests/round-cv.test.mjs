import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { digest, seal, sha, defaultBudget, initialCheckpoint, mergeCheckpoints, validateExperiment, validateCheckpoint, zeroCost } from '../lib/contracts.mjs'
import { Store } from '../lib/store.mjs'
import { sequencePlan, SequenceRunner, validateRollout } from '../lib/sequence.mjs'
import { roundValidation, experimentValidationDigest, cvSelection } from '../lib/validation.mjs'
import { validateSearchPlan } from '../lib/pipeline.mjs'
import { recordView, compareRecords } from '../lib/records.mjs'
import { HitchBackend, refitBinding } from '../lib/hitch-backend.mjs'
import { refit } from '../refit.mjs'
import { prepare, bootstrap } from '../prepare.mjs'
import { trajectoryReport } from '../lib/report.mjs'
import { auditSequence } from '../report.mjs'
import { bootstrapCheckpoint } from '../research.mjs'

const config = { inputSchema: {}, preprocessing: {}, features: {}, model: 'dummy', hyperparameters: { constant: 0 }, prediction: { kind: 'label' }, seed: 42 }
const task = seal({ protocol: 'analysis-task@6', taskId: 'cv', taskFamilyId: 'cv', description: 'All training rows; no local test.',
  inputs: { trainDigest: digest('train'), predictDigest: digest('query') }, prediction: { kind: 'tabular', idColumn: 'id', targetColumns: ['target'], metric: 'accuracy', labels: ['0','1'] },
  predictIds: ['100', '101'], publicFiles: [], validationPlanDigest: digest('round-policy'), runtimeDigest: digest('runtime') })
const initial = () => initialCheckpoint({ researchProjectId: 'cv-test', taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
  dataScopeDigest: digest(task.inputs), validationPlanDigest: task.validationPlanDigest, runtimeDigest: task.runtimeDigest, scorerDigest: digest('cv-mean') })
const plan = (checkpoint, char = 'a') => sequencePlan({ task, checkpoint, harness: { commit: char.repeat(40), manifestDigest: digest(char) }, model: 'fixture', budget: defaultBudget, runtimeDigest: task.runtimeDigest })
const search = validation => ({ version: 1, entrypoint: 'solution.py', variants: [{ id: 'base', config }],
  validation: { kind: validation.kind, folds: 5, shuffle: true, seed: validation.seed }, selection: 'best_mean_utility', seed: 42, maxFits: 6, refitReserve: 1 })
const reseal = (value, patch) => { const { digest: _, ...body } = value; return seal({ ...body, ...patch }) }
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'round-cv-')); t.after(() => rm(root, { recursive: true, force: true })); return new Store(root)
}

class CvBackend {
  constructor(store) { this.store = store; this.calls = []; this.deliveries = 0; this.saved = new Map() }
  async admit() {}
  async verifyReceipt() { return true }
  async rollout(request, checkpoint) {
    if (this.saved.has(request.digest)) return this.saved.get(request.digest)
    this.calls.push(request)
    const runId = 'run_' + request.digest.slice(7, 39), bytes = Buffer.from('def build_pipeline(config): pass\n')
    const file = await this.store.putBytes(bytes), predictions = await this.store.putBytes(Buffer.from('{}'))
    const files = [{ path: 'solution.py', digest: file, bytes: bytes.length }]
    const parameters = seal({ protocol: 'analysis-resolved-pipeline@1', experimentId: runId+'/experiment', variantId: 'base', entrypoint: 'solution.py',
      config, configDigest: digest(config), codeDigest: digest(files), runtimeDigest: task.runtimeDigest, trainingEntry: 'build_pipeline', fitCount: 1, actualParameters: {} })
    const solution = seal({ protocol: 'analysis-solution@2', files, entrypoint: 'solution.py', parameters, trainingSeed: 42, runtimeDigest: task.runtimeDigest, authoredByRunId: runId })
    const score = .6 + request.slotIndex / 100, foldMetrics = Array.from({ length: 5 }, (_, fold) => ({ fold, rows: 4, score, utility: score }))
    const cost = { ...zeroCost(), tools: 1, requests: 1 }
    const experiment = seal({ protocol: 'analysis-experiment@5', experimentId: runId+'/experiment', sequenceId: request.sequenceId,
      rolloutRunId: runId, slotIndex: request.slotIndex, parentExperimentId: null, operator: 'improve', sourceDigest: solution.digest,
      validationPlanDigest: task.validationPlanDigest, trainingSeed: 42, claim: { hypothesis: 'fixture', intendedChange: 'fixture' },
      execution: { status: 'completed', receiptDigest: digest([runId,'cv']), physicalAttemptRefs: [runId], reusedEvidenceRefs: [], cost,
        metric: 'accuracy', foldMetrics, pooledScore: score, pooledUtility: score, meanScore: score, meanUtility: score, stdScore: 0, oofDigest: predictions },
      interpretation: { conclusion: 'CV fixture', limitations: [] }, analysis: { timestamp: '2026-11-08T00:00:00Z',
        harness: request.harness.manifestDigest, checkpoint: checkpoint.digest, dataset: task.inputs.trainDigest, toolVersion: digest('tools'),
        workflow: { states: {} }, artifacts: [], notes: [], trials: 1, fits: 5, fitCalls: 5, plan: search(request.roundValidation),
        formalVariantId: 'base', variants: [{ id: 'base', config, status: 'completed', meanUtility: score, folds: foldMetrics }],
        validation: { plan: request.roundValidation, digest: digest(request.roundValidation), rowIds: Array.from({ length: 20 }, (_, i) => String(i)), foldAssignments: Array.from({ length: 20 }, (_, i) => i % 5) } } })
    const result = seal({ protocol: 'analysis-rollout-receipt@1', requestDigest: request.digest, runId, outputManifestDigest: digest([runId,'manifest']), experiment,
      solutions: [solution], selectedSolutionDigest: solution.digest, availableEvidenceRefs: [experiment.digest], selectionPolicyDigest: digest('policy'), sealedAt: '2026-11-08T00:00:00Z', cost, stop: false })
    this.saved.set(request.digest, result); return result
  }
  async deliver(request) {
    assert.equal(request.protocol, 'analysis-refit-request@1', 'CV comparison must never fit or score a local test')
    this.deliveries++
    const destination = join(this.store.root, 'refit-output'); await mkdir(join(destination, 'output'), { recursive: true })
    await writeFile(join(destination, 'output/predictions.csv'), 'id,target\n100,0\n101,0\n')
    await this.store.save('executions', request.digest.slice(7), { destination, status: 'complete' })
    return seal({ protocol: 'analysis-delivery@1', requestDigest: request.digest, solutionDigest: request.solution.digest,
      resolvedPipelineDigest: request.solution.parameters.digest, modelRequests: 0, searchCalls: 0, fits: 1,
      status: 'completed', cost: zeroCost(), runId: 'run_'+'f'.repeat(32), outputManifestDigest: digest('refit-output') })
  }
}

test('paired harnesses share a round split; next round changes it, recovery cannot', async t => {
  const store = await temporary(t), start = initial(), a = plan(start), b = plan(start, 'b')
  assert.deepEqual(a.roundValidation, b.roundValidation)
  assert.deepEqual(a.roundValidation, plan(start).roundValidation)
  const backA = new CvBackend(store), backB = new CvBackend(store)
  const receiptA = await new SequenceRunner(store, backA).run(a, start)
  const receiptB = await new SequenceRunner(store, backB).run(b, start)
  assert.equal(backA.deliveries + backB.deliveries, 0)
  assert.equal(receiptA.delivery.protocol, 'analysis-cv-selection@1')
  assert.equal(receiptA.total_score, .65)
  assert.ok([...backA.calls, ...backB.calls].every(r => digest(r.roundValidation) === digest(a.roundValidation)))
  assert.deepEqual(await new SequenceRunner(store, backA).run(a, start), receiptA)
  assert.equal(backA.calls.length, 5)
  const ca = await store.get(receiptA.checkpointRef), cb = await store.get(receiptB.checkpointRef)
  const merged = mergeCheckpoints(start, [ca, cb], ca)
  assert.equal(merged.history.length, 10); validateCheckpoint(merged)
  assert.notEqual(plan(merged).roundValidation.seed, a.roundValidation.seed)
  const firstState = await store.load('sequences', a.digest.slice(7))
  assert.throws(() => cvSelection(plan(merged), firstState.steps, merged.currentSolutionDigest), /current-round/)
  const nextPlan = plan(merged), backend = new CvBackend(store)
  const next = await new SequenceRunner(store, backend).run(nextPlan, merged)
  const state = await store.load('sequences', nextPlan.digest.slice(7))
  assert.equal(compareRecords([recordView(ca.history[0]), recordView(state.steps[0].experiment)]).comparable, false)
  const forged = reseal(state.steps[0], { selectedSolutionDigest: merged.currentSolutionDigest })
  assert.throws(() => validateRollout(forged, backend.calls[0], merged, [], merged), /candidate pool/)
  assert.equal((await store.get(next.checkpointRef)).history.length, 15)
  const report = trajectoryReport(next, merged, state.steps.map(s => s.experiment))
  assert.equal(report.independentTest, false); assert.equal(report.points[0].evidenceRole, 'current_round_cv')
  await auditSequence(store, backend, { projectId: 'cv-test' }, next)
  assert.equal(backend.deliveries, 0)
})

test('fixed CV rejects split overrides before fitting and rejects invented aggregate scores', async t => {
  const store = await temporary(t), start = initial(), p = plan(start), cv = p.roundValidation
  assert.equal(validateSearchPlan(search(cv), { roundValidation: cv }).validation.seed, cv.seed)
  for (const patch of [{ folds: 2 }, { kind: 'group', column: 'Ticket' }, { seed: cv.seed + 1 }, { shuffle: false }])
    assert.throws(() => validateSearchPlan({ ...search(cv), validation: { ...search(cv).validation, ...patch } }, { roundValidation: cv }))
  const backend = new CvBackend(store); await new SequenceRunner(store, backend).run(p, start)
  const state = await store.load('sequences', p.digest.slice(7)), e = state.steps[0].experiment
  validateExperiment(e)
  assert.throws(() => validateExperiment(reseal(e, { execution: { ...e.execution, meanScore: .99 } })), /aggregate/)
  assert.throws(() => validateExperiment(reseal(e, { analysis: { ...e.analysis, validation: { ...e.analysis.validation, foldAssignments: Array(20).fill(0) } } })), /rows/)
  assert.equal(experimentValidationDigest(e), digest(cv))
})

test('CV receipt verification binds the reported score to the selected sealed experiment', async t => {
  const store = await temporary(t), start = initial(), p = plan(start), backend = new CvBackend(store)
  const receipt = await new SequenceRunner(store, backend).run(p, start)
  const verifier = new HitchBackend(store, {})
  verifier.hitch = async args => {
    const run = receipt.steps.find(s => s.runId === args[3]); assert.ok(run)
    return { run_id: run.runId, digest: run.outputManifestDigest }
  }
  await verifier.verifyReceipt(receipt)
  await assert.rejects(verifier.verifyReceipt(reseal(receipt, { total_score: .99 })), /score changed/)
  const forgedDelivery = reseal(receipt.delivery, { quality: .99, score: .99, accuracy: .99 })
  await assert.rejects(verifier.verifyReceipt(reseal(receipt, { delivery: forgedDelivery, total_score: .99 })), /sealed experiment/)
})

test('explicit bootstrap carries the frozen round CV plan and consumes exactly one slot', async t => {
  const store = await temporary(t), start = initial(), p = plan(start), checkpointRef = await store.put(start)
  await store.save('projects', 'cv-test', { checkpoint: checkpointRef, stage: null, previousStage: null })
  const project = { projectId: 'cv-test', checkpointRef, task, harness: p.harness, model: p.model, budget: defaultBudget,
    projectLimits: { maxSequences: 2, maxTargetExperiments: 10, cpuSeconds: 10000, wallSeconds: 10000 } }
  const backend = new CvBackend(store)
  const result = await bootstrapCheckpoint(store, backend, project)
  assert.deepEqual(result.request.roundValidation, p.roundValidation)
  assert.equal((await store.get(result.checkpointRef)).history.length, 1)
  assert.deepEqual(await bootstrapCheckpoint(store, backend, project), result)
  assert.equal(backend.calls.length, 1)
  assert.equal(Object.keys((await store.load('ledgers', 'cv-test')).bootstrap).length, 1)
})

test('production Driver seals CV folds, scores and OOF evidence through the experiment tool', async t => {
  const store = await temporary(t), root = store.root, repo = join(root, 'target'), built = await bootstrap(repo)
  const data = join(root, 'data'); await mkdir(data)
  const train = 'id,x,target\n'+Array.from({ length: 20 }, (_, i) => `${i},${i},${i%2}\n`).join(''), predict = 'id,x\n100,100\n101,101\n'
  const localTask = reseal(task, { inputs: { trainDigest: sha(train), predictDigest: sha(predict) } })
  const start = initialCheckpoint({ researchProjectId: 'driver-cv', taskFamilyId: localTask.taskFamilyId, baseTaskDigest: localTask.digest,
    dataScopeDigest: digest(localTask.inputs), validationPlanDigest: localTask.validationPlanDigest, runtimeDigest: localTask.runtimeDigest, scorerDigest: digest('cv') })
  const cv = roundValidation(localTask, start.digest)
  const request = seal({ protocol: 'analysis-rollout-request@1', sequenceId: 'driver-cv', slotIndex: 1, planDigest: digest('driver-plan'), task: localTask,
    harness: built.harness, model: 'fixture', runtimeDigest: localTask.runtimeDigest, checkpointDigest: start.digest, checkpointRef: start.digest,
    roundValidation: cv, previousRolloutReceiptDigest: null, eligibleSolutionDigests: [], allowance: { wallSeconds: 300, cpuSeconds: 300, tools: 100, tokens: null, requests: null }, experimentWallSeconds: 240, experimentCpuSeconds: 240 })
  for (const [name, value] of [['request',request], ['checkpoint',start], ['validation',cv]]) await writeFile(join(data, name+'.json'), JSON.stringify(value))
  await writeFile(join(data, 'train.csv'), train); await writeFile(join(data, 'predict.csv'), predict)
  const priorRunId = process.env.HITCH_RUN_ID; process.env.HITCH_RUN_ID = 'run_'+'7'.repeat(32)
  t.after(() => { if (priorRunId === undefined) delete process.env.HITCH_RUN_ID; else process.env.HITCH_RUN_ID = priorRunId })
  const { Driver } = await import(pathToFileURL(join(repo, 'fixed/driver.mjs')))
  const d = new Driver(repo, { data, work: join(root,'work'), output: join(root,'output') }); await d.initialize()
  const inspected = await d.inspect(undefined, { resource: 'skills/data-analysis/SKILL.md' })
  assert.equal(inspected.validation.separateHoldout, false); assert.equal(inspected.validation.seed, cv.seed)
  await d.write('solution.py', 'def build_pipeline(config): pass\n', null)
  let fits = 0
  d.worker = async job => {
    assert.equal(job.operation, 'research'); assert.deepEqual(job.validationPlan, cv); fits += 5
    const foldMetrics = Array.from({ length: 5 }, (_, fold) => ({ fold, rows: 4, score: .5, utility: .5 }))
    const out = join(root,'oof.json.gz'); await writeFile(out, gzipSync(JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i),'0'])))))
    return { status: 'completed', metric: 'accuracy', variants: [{ id: 'base', config, status: 'completed', meanUtility: .5,
      folds: foldMetrics.map(f => ({ ...f, fit: { parametersBefore: {} } })) }], formalVariantId: 'base', formalFit: null,
      foldMetrics, meanScore: .5, meanUtility: .5, stdScore: 0, pooledScore: .5, pooledUtility: .5, oofPath: out,
      cv: { rowIds: Array.from({ length: 20 }, (_, i) => String(i)), foldAssignments: Array.from({ length: 20 }, (_, i) => i%5) },
      fits: 5, fitAttempts: 5, fitCalls: 5, cpuSeconds: .01, wallSeconds: .01, logs: [] }
  }
  await assert.rejects(d.experiments({ action: 'run', hypothesis: 'override', intendedChange: 'invalid split', plan: { ...search(cv), validation: { kind: 'stratified', folds: 2 } } }), /five-fold/)
  assert.equal(fits, 0); assert.equal(d.started, undefined)
  const outcome = await d.experiments({ action: 'run', hypothesis: 'baseline', intendedChange: 'CV factory', plan: search(cv) })
  assert.equal(outcome.evaluation, 'round_five_fold_cv'); assert.equal(outcome.score, .5)
  await d.experiments({ action: 'select', experimentId: outcome.experimentId, variantId: 'base' })
  await d.finish('Selected by five-fold CV.', ['Development CV, not an independent test.'])
  const output = JSON.parse(await readFile(join(root,'output/receipt.json')))
  validateExperiment(output.experiment)
  assert.equal(output.experiment.protocol, 'analysis-experiment@5')
  assert.equal(output.experiment.analysis.validation.foldAssignments.length, 20)
  assert.ok(output.experiment.analysis.artifacts.some(a => a.path === 'cv-folds.json'))
  assert.ok(output.experiment.execution.oofDigest)
  await assert.rejects(readFile(join(root,'output/validation-receipt.json')), /ENOENT/)
  assert.equal(fits, 5)
})

test('CV-selected source is refit once on prepared full training inputs, with no new search', async t => {
  const store = await temporary(t), start = initial(), p = plan(start), backend = new CvBackend(store)
  const receipt = await new SequenceRunner(store, backend).run(p, start)
  const train = join(store.root, 'train.csv'), predict = join(store.root, 'predict.csv')
  await writeFile(train, 'id,x,target\n1,1,0\n2,2,1\n'); await writeFile(predict, 'id,x\n100,1\n101,2\n')
  const project = { projectId: 'cv-test', task, budget: defaultBudget, backend: { refit: { train, predict, predictIds: task.predictIds } },
    projectLimits: { maxSequences: 2, maxTargetExperiments: 10, cpuSeconds: 10000, wallSeconds: 10000 } }
  await store.save('bindings', 'refit', await refitBinding(project.backend))
  const result = await refit(store, backend, project, receipt, join(store.root, 'submission'))
  assert.equal(result.rows, 2); assert.equal(result.delivery.fits, 1); assert.equal(backend.deliveries, 1)
  assert.equal(result.selectionPlan.sourceRunId, receipt.delivery.runId)
  assert.equal(result.accuracy, null)
})

test('Titanic preparation retains all 891 labels and only the official 418 query rows', async t => {
  const store = await temporary(t), root = store.root, train = join(root, 'train.csv'), predict = join(root, 'test.csv')
  await writeFile(train, 'PassengerId,x,Survived\n'+Array.from({ length: 891 }, (_, i) => `${i+1},${i},${i%2}\n`).join(''))
  await writeFile(predict, 'PassengerId,x\n'+Array.from({ length: 418 }, (_, i) => `${i+892},${i}\n`).join(''))
  const hitch = join(root, 'hitch')
  for (const name of ['analysis.mjs','runtime/analysis-verify.py','analysis-contracts/schemas.mjs']) {
    const path = join(hitch, 'benchmark-packages/kaggle', name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, name)
  }
  const project = await prepare({ out: join(root, 'project'), competition: 'titanic', train, predict, hitchRepository: hitch,
    hitchExecutable: '/fixture/hitch', executorExecutable: '/fixture/executor', hitchRoot: join(root, 'hitch-data'), executorCommit: 'a'.repeat(40),
    baseImage: 'fixture@sha256:'+'1'.repeat(64), platform: 'linux/arm64', model: 'fixture' })
  assert.deepEqual(project.rows, { train: 891, predict: 418, refitTrain: 891, refitPredict: 418 })
  assert.equal(project.task.protocol, 'analysis-task@6'); assert.equal(project.backend.expected, null)
  assert.deepEqual(await readFile(project.backend.train), await readFile(train))
  assert.equal(project.backend.refit.train, project.backend.train)
  assert.equal(project.backend.refit.predict, project.backend.predict)
  await assert.rejects(readFile(join(root, 'project/data/private/expected.csv')), /ENOENT/)
})
