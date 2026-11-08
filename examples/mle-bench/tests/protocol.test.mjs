import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, seal, defaultBudget, initialCheckpoint, mergeCheckpoints, validateCheckpoint, zeroCost } from '../lib/contracts.mjs'
import { Store } from '../lib/store.mjs'
import { Budget } from '../lib/budget.mjs'
import { SequenceRunner, sequencePlan } from '../lib/sequence.mjs'
import { trajectoryReport } from '../lib/report.mjs'
import { ResearchProject } from '../lib/project.mjs'
import { HitchBackend, refitBinding } from '../lib/hitch-backend.mjs'
import { refit } from '../refit.mjs'
import { withinDeadline } from '../lib/deadline.mjs'
import { auditSequence } from '../report.mjs'

const runtimeDigest = digest('runtime')
const task = seal({ protocol: 'analysis-task@1', taskId: 'synthetic', taskFamilyId: 'synthetic', description: 'fixture',
  inputs: { trainDigest: digest('train'), predictDigest: digest('predict') }, predictIds: ['query'], validationPlanDigest: digest('five-folds'), runtimeDigest,
  prediction: { kind: 'binary-label', idColumn: 'row', targetColumn: 'label', allowedLabels: ['0', '1'] } })
const checkpoint = () => initialCheckpoint({ researchProjectId: 'test', taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
  dataScopeDigest: digest('visible-rows'), runtimeDigest, scorerDigest: digest('accuracy') })
const plan = (start, char = 'a') => sequencePlan({ task, checkpoint: start, harness: { commit: char.repeat(40), manifestDigest: digest(char) },
  model: 'fixture', budget: defaultBudget, runtimeDigest })

class Backend {
  constructor(store, { failAt = 0, stopAt = 0, outageAt = 0, resolved = false } = {}) { Object.assign(this, { store, failAt, stopAt, outageAt, resolved }); this.calls = []; this.saved = new Map(); this.deliveries = 0 }
  async admit() {}
  async rollout(request, history) {
    if (this.saved.has(request.digest)) return this.saved.get(request.digest)
    const k = request.slotIndex
    this.calls.push({ request, history })
    if (this.outageAt === k) throw new Error('infra unavailable')
    const runId = `run_${request.harness.commit.slice(0, 16)}${String(k).padStart(16, '0')}`
    const bytes = Buffer.from(`print(${k})`), source = await this.store.putBytes(bytes)
    const failed = this.failAt === k
    const oofDigest = failed ? null : await this.store.putBytes(Buffer.from(JSON.stringify({ [runId]: '1' })))
    const files = [{ path: 'solution.py', digest: source, bytes: bytes.length }]
    const config = { inputSchema: {}, preprocessing: {}, features: {}, model: 'fixture', hyperparameters: {}, prediction: { kind: 'label' }, seed: 42 }
    const parameters = this.resolved ? seal({ protocol: 'analysis-resolved-pipeline@1', experimentId: `${runId}/experiment`, variantId: 'fixture', entrypoint: 'solution.py', config, configDigest: digest(config), codeDigest: digest(files), runtimeDigest, trainingEntry: 'build_pipeline', fitCount: 1, actualParameters: {} }) : {}
    const solution = failed ? null : seal({ protocol: this.resolved ? 'analysis-solution@2' : 'analysis-solution@1', entrypoint: 'solution.py', files,
      parameters, trainingSeed: 42, runtimeDigest, authoredByRunId: runId })
    const used = { cpuSeconds: 1, requests: 1, tokens: 100, tools: 2 }
    const experiment = seal({ protocol: 'analysis-experiment@1', experimentId: `${runId}/experiment`, sequenceId: request.sequenceId,
      rolloutRunId: runId, slotIndex: k, parentExperimentId: history.history.at(-1)?.experimentId ?? null, operator: k === 1 ? 'draft' : 'improve',
      sourceDigest: solution?.digest ?? null, validationPlanDigest: digest('five-folds'), trainingSeed: 42,
      claim: { hypothesis: `test ${k}`, intendedChange: 'fixture' }, execution: { status: failed ? 'generation_failed' : 'completed',
        receiptDigest: digest(runId), physicalAttemptRefs: [runId], reusedEvidenceRefs: [], cost: used,
        foldMetrics: failed ? [] : Array.from({ length: 5 }, (_, fold) => ({ fold, rows: 10, correct: 5 + k, accuracy: (5 + k) / 10 })),
        pooledAccuracy: failed ? null : (5 + k) / 10, oofDigest },
      interpretation: { conclusion: 'fixture', limitations: [] } })
    const result = seal({ protocol: 'analysis-rollout-receipt@1', requestDigest: request.digest, runId, outputManifestDigest: digest([runId, 'outputs']),
      experiment, solutions: solution ? [solution] : [], selectedSolutionDigest: solution?.digest ?? history.currentSolutionDigest,
      availableEvidenceRefs: [experiment.digest], selectionPolicyDigest: digest('policy'), cost: used, stop: this.stopAt === k, sealedAt: `2026-11-06T00:00:0${k}Z` })
    this.saved.set(request.digest, result); return result
  }
  async deliver(request) {
    this.deliveries++
    return seal({ protocol: 'analysis-delivery@1', requestDigest: request.digest, status: 'completed', solutionDigest: request.solution.digest,
      quality: .8, accuracy: .8, runId: 'delivery', outputManifestDigest: digest('delivery'), modelRequests: 0, cost: { ...zeroCost(), cpuSeconds: 2 } })
  }
}
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'analysis-protocol-')); t.after(() => rm(root, { recursive: true, force: true })); return new Store(root) }

test('exactly five sequential experiments inherit only their own history; complete result is idempotent', async t => {
  const store = await temporary(t), start = checkpoint(), backend = new Backend(store, { failAt: 2 }), runner = new SequenceRunner(store, backend)
  const p = plan(start), result = await runner.run(p, start)
  assert.deepEqual(backend.calls.map(c => c.history.history.length), [0, 1, 2, 3, 4])
  assert.equal(result.attempted, 5); assert.equal(result.validCandidates, 4); assert.equal(result.selections[1].carryForward, true)
  assert.equal(result.total_score, .8); assert.equal(result.cost.used.cpuSeconds, 7)
  assert.deepEqual(await runner.run(p, start), result); assert.equal(backend.calls.length, 5); assert.equal(backend.deliveries, 1)
  const other = new Backend(store)
  const b = await new SequenceRunner(store, other).run(plan(start, 'b'), start)
  assert.equal(other.calls[0].history.history.length, 0)
  const aHistory = await store.get(result.checkpointRef), bHistory = await store.get(b.checkpointRef)
  const merged = mergeCheckpoints(start, [aHistory, bHistory], bHistory)
  assert.equal(merged.history.length, 10); assert.equal(merged.history.filter(e => e.execution.status === 'generation_failed').length, 1)
  assert.equal(merged.costEvents.length, 10)
  assert.notEqual(plan(merged).digest, p.digest)
})

test('early stop carries five selections without inventing experiments', async t => {
  const store = await temporary(t), backend = new Backend(store, { stopAt: 2 }), start = checkpoint()
  const result = await new SequenceRunner(store, backend).run(plan(start), start)
  assert.equal(result.attempted, 2); assert.equal(result.unused, 3)
  assert.deepEqual(result.selections.map(s => s.status), ['attempted', 'attempted', 'not_started', 'not_started', 'not_started'])
  assert.equal(new Set(result.selections.slice(1).map(s => s.incumbentSolutionDigest)).size, 1)
})

test('infrastructure failure remains unavailable and retains its reservation', async t => {
  const store = await temporary(t), backend = new Backend(store, { outageAt: 3 }), start = checkpoint(), p = plan(start)
  await assert.rejects(new SequenceRunner(store, backend).run(p, start), /infra unavailable/)
  const state = await store.load('sequences', p.digest.slice(7))
  assert.equal(state.steps.length, 2); assert.equal(state.pending.request.slotIndex, 3)
  assert.ok(state.budget.reservations['rollout-3']); assert.equal(state.delivery, null)
  backend.outageAt = 0
  const result = await new SequenceRunner(store, backend).run(p, start)
  assert.equal(result.attempted, 5); assert.equal(result.selections[2].status, 'attempted')
})

test('checkpoints reject external fields, incompatible scopes and missing sources', async t => {
  const store = await temporary(t), start = checkpoint()
  const { digest: _, ...body } = start
  assert.throws(() => validateCheckpoint(seal({ ...body, externalAccuracy: 1 })), /fields/)
  const other = seal({ ...body, dataScopeDigest: digest('other') })
  assert.throws(() => mergeCheckpoints(start, [other], other), /scope mismatch/)
  const backend = new Backend(store), r = await new SequenceRunner(store, backend).run(plan(start), start)
  const output = await store.get(r.checkpointRef)
  await rm(store.objectPath(output.solutions[0].files[0].digest))
  await assert.rejects(store.verifySources(output), /ENOENT/)
})

test('budget reserves complete input, output, retries and concurrent requests; missing usage remains charged', () => {
  const b = new Budget({ ...defaultBudget, tokens: 1000, requests: 60 })
  b.request('a', 400, 100)
  assert.throws(() => b.request('b', 450, 100), /exhausted/)
  b.settle('a')
  assert.equal(b.state.used.tokens, 500)
  b.request('retry', 300, 100); b.settle('retry', { ...zeroCost(), requests: 1, tokens: 350 })
  assert.equal(b.state.used.tokens, 850); assert.equal(b.state.used.requests, 2)
  assert.throws(() => b.request('a', 1, 1), /duplicate/)
})

test('curve and oracle have independent coverage; final score is never the best observed candidate', async t => {
  const store = await temporary(t), start = checkpoint(), backend = new Backend(store)
  const result = await new SequenceRunner(store, backend).run(plan(start), start)
  const state = await store.load('sequences', plan(start).digest.slice(7))
  const solutions = Object.fromEntries(state.steps.map((s, i) => [s.experiment.sourceDigest, { status: 'completed', accuracy: [ .9, .7, .85, .95, .8 ][i] }]))
  const audit = { sequenceReceiptDigest: result.digest, selectionDigest: digest(result.selections), solutions, cost: zeroCost() }
  const report = trajectoryReport(result, start, state.steps.map(s => s.experiment), audit)
  assert.deepEqual(report.points.map(p => p.value), [.9, .7, .85, .95, .8])
  assert.equal(report.final_quality, .8); assert.equal(report.oracle_best, .95); assert.equal(report.final_gain_from_start, null)
  assert.ok(Math.abs(report.selection_loss - .15) < 1e-12)
  delete solutions[state.steps[1].experiment.sourceDigest]
  const incomplete = trajectoryReport(result, start, state.steps.map(s => s.experiment), audit)
  assert.equal(incomplete.incumbent_slot_mean, null); assert.equal(incomplete.oracle_best, null); assert.equal(incomplete.final_quality, .8)
})

test('stage admission is atomic; merge requires every distinct sealed branch and preserves all costs', async t => {
  const store = await temporary(t), start = checkpoint(), initialRef = await store.put(start)
  await store.save('projects', 'test', { checkpoint: initialRef })
  const project = { projectId: 'test', task, model: 'fixture', budget: defaultBudget,
    projectLimits: { maxSequences: 4, cpuSeconds: defaultBudget.cpuSeconds, wallSeconds: 4 * defaultBudget.wallSeconds } }
  const controller = new ResearchProject(store, project), harnesses = [plan(start).harness, plan(start, 'b').harness]
  await assert.rejects(controller.stage('one', harnesses), /total budget/)
  assert.equal(await store.load('ledgers', 'test'), null)
  assert.equal(await store.load('stages', 'one'), null)
  project.projectLimits.cpuSeconds = 4 * defaultBudget.cpuSeconds
  await controller.stage('one', harnesses)
  assert.equal(Object.keys((await store.load('ledgers', 'test')).sequences).length, 2)
  const receipts = []
  for (const char of ['a', 'b']) {
    const p = plan(start, char), receipt = await new SequenceRunner(store, new Backend(store, { failAt: 2 })).run(p, start)
    await controller.settleSequence(p, receipt); receipts.push(receipt)
  }
  const decision = await store.put({ adoptedCommit: harnesses[1].commit, evidence: receipts.map(r => r.digest) })
  await assert.rejects(controller.merge('one', [receipts[0], receipts[0]], harnesses[1].commit, decision), /missing or foreign/)
  await assert.rejects(controller.merge('one', receipts, harnesses[0].commit, decision), /does not nominate/)
  const next = await controller.merge('one', receipts, harnesses[1].commit, decision)
  assert.equal(await controller.merge('one', receipts, harnesses[1].commit, decision), next)
  await assert.rejects(controller.merge('one', receipts, harnesses[1].commit, digest('another decision')), /decision changed/)
  const history = await store.get(next)
  assert.equal(history.history.length, 10); assert.equal(history.costEvents.length, 10)
  assert.equal(history.history.filter(e => e.execution.status === 'generation_failed').length, 2)
  for (const receipt of receipts) {
    const branch = await store.get(receipt.checkpointRef)
    for (const e of branch.history) assert.deepEqual(history.history.find(merged => merged.experimentId === e.experimentId), e)
    for (const s of branch.solutions) assert.deepEqual(history.solutions.find(merged => merged.digest === s.digest), s)
  }
  assert.equal(history.currentSolutionDigest, (await store.get(receipts[1].checkpointRef)).currentSolutionDigest)
  const nextStage = await controller.stage('two', [harnesses[1]])
  assert.equal(nextStage.checkpointRef, next); assert.notEqual(plan(history, 'b').digest, plan(start, 'b').digest)
})

test('wall deadline aborts the physical operation and retains its unknown cost', async t => {
  const store = await temporary(t), start = checkpoint(), original = plan(start)
  const { digest: _, ...body } = original
  const p = seal({ ...body, budget: { ...defaultBudget, wallSeconds: .15, reserveSeconds: .05 } })
  let cancelled = 0
  const backend = { admit: async () => {}, rollout: (_r, _k, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }), cancel: async () => { cancelled++ } }
  await assert.rejects(new SequenceRunner(store, backend).run(p, start), /wall budget/)
  const state = await store.load('sequences', p.digest.slice(7))
  assert.equal(cancelled, 1); assert.equal(state.steps.length, 0); assert.ok(state.budget.reservations['rollout-1'])
})

test('an expired sequence collects a completed delivery without renewing its budget or executing again', async t => {
  const store = await temporary(t), start = checkpoint(), p = plan(start), backend = new Backend(store)
  let now = Date.now(), completed, recovered = 0
  const deliver = backend.deliver.bind(backend)
  backend.deliver = async request => {
    completed = await deliver(request)
    throw new Error('delivery completed but reply was lost')
  }
  backend.recover = async (request, history) => {
    recovered++
    assert.equal(history, null)
    assert.equal(request.digest, completed.requestDigest)
    return completed
  }
  const runner = new SequenceRunner(store, backend, { now: () => now })
  await assert.rejects(runner.run(p, start), /reply was lost/)
  const pending = await store.load('sequences', p.digest.slice(7))
  assert.equal(pending.status, 'selected'); assert.ok(pending.budget.reservations.delivery)
  now += (p.budget.wallSeconds + 1) * 1000
  const receipt = await runner.run(p, start)
  assert.equal(receipt.delivery.digest, completed.digest)
  assert.equal(receipt.cost.startedAt, pending.budget.startedAt)
  assert.equal(receipt.cost.events.filter(e => e.id === 'delivery').length, 1)
  assert.deepEqual(receipt.cost.reservations, {})
  assert.equal(backend.deliveries, 1); assert.equal(backend.calls.length, p.experiments); assert.equal(recovered, 1)
  assert.deepEqual(await runner.run(p, start), receipt)
  assert.equal(backend.deliveries, 1); assert.equal(recovered, 1)
})

test('expired recovery cannot replace an unavailable execution or release its reservation', async t => {
  const store = await temporary(t), start = checkpoint(), p = plan(start), backend = new Backend(store, { outageAt: 1 })
  let now = Date.now()
  const runner = new SequenceRunner(store, backend, { now: () => now })
  await assert.rejects(runner.run(p, start), /infra unavailable/)
  const pending = await store.load('sequences', p.digest.slice(7))
  backend.recover = async request => {
    assert.equal(request.digest, pending.pending.request.digest)
    throw new Error('original execution is not complete')
  }
  now += (p.budget.wallSeconds + 1) * 1000
  await assert.rejects(runner.run(p, start), /not complete/)
  const after = await store.load('sequences', p.digest.slice(7))
  assert.deepEqual(after.pending, pending.pending); assert.deepEqual(after.budget, pending.budget)
  assert.equal(backend.calls.length, 1); assert.equal(backend.deliveries, 0)
})

test('recovering an expired research slot preserves the final delivery reserve without starting more research', async t => {
  const store = await temporary(t), start = checkpoint(), p = plan(start), backend = new Backend(store)
  let now = Date.now(), completed
  const rollout = backend.rollout.bind(backend)
  backend.rollout = async (request, history) => {
    completed = await rollout(request, history)
    throw new Error('rollout completed but reply was lost')
  }
  backend.recover = async (request, history) => {
    assert.equal(history.digest, start.digest); assert.equal(request.digest, completed.requestDigest)
    return completed
  }
  const runner = new SequenceRunner(store, backend, { now: () => now })
  await assert.rejects(runner.run(p, start), /reply was lost/)
  now += (p.budget.wallSeconds - p.budget.reserveSeconds + 1) * 1000
  const receipt = await runner.run(p, start)
  assert.equal(backend.calls.length, 1); assert.equal(backend.deliveries, 1)
  assert.equal(receipt.attempted, 1); assert.equal(receipt.unused, p.experiments - 1)
  assert.ok(receipt.selections.slice(1).every(s => s.status === 'not_started' && s.stopReason === 'research_budget_exhausted'))
  assert.equal(receipt.delivery.status, 'completed'); assert.equal(receipt.cost.used.cpuSeconds, 3)
})

test('auxiliary deadlines include setup and cancel the same physical request', async () => {
  const request = { digest: digest('auxiliary') }, cancelled = []
  const backend = { cancel: async value => { cancelled.push(value.digest) } }
  const wait = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  await assert.rejects(withinDeadline(backend, request, Date.now() + 20, wait), /wall budget exhausted/)
  assert.deepEqual(cancelled, [request.digest])
  let started = false
  await assert.rejects(withinDeadline(backend, request, Date.now() - 1, async () => { started = true }), /wall budget expired/)
  assert.equal(started, false)
})

for (const expired of [false, true]) test(`the fifth pending audit keeps its attempt and cost on resume; expired=${expired}`, async t => {
  const store = await temporary(t), backend = new Backend(store), origin = checkpoint()
  const first = await new SequenceRunner(store, backend).run(plan(origin), origin), start = await store.get(first.checkpointRef)
  const p = plan(start, 'b'), receipt = await new SequenceRunner(store, backend).run(p, start)
  const state = await store.load('sequences', p.digest.slice(7)), checkpointAfter = await store.get(receipt.checkpointRef)
  const sourceDigest = state.steps[3].experiment.sourceDigest
  const request = seal({ protocol: 'analysis-audit-request@1', sequenceId: p.digest.slice(7), planDigest: p.digest,
    task, harness: p.harness, runtimeDigest, solution: checkpointAfter.solutions.find(s => s.digest === sourceDigest),
    selectionsDigest: digest(receipt.selections),
    allowance: { cpuSeconds: p.budget.reserveCpuSeconds, wallSeconds: p.budget.reserveSeconds, tokens: 0, requests: 0, tools: 0 } })
  const solutions = Object.fromEntries([start.currentSolutionDigest, ...state.steps.slice(0, 3).map(s => s.experiment.sourceDigest)]
    .map(id => [id, { status: 'completed', accuracy: .7 }]))
  const now = Date.now()
  await store.save('audits', p.digest.slice(7), { status: 'running', startedAt: now - (expired ? (p.experiments * p.budget.reserveSeconds + 1) * 1000 : 1000),
    attempts: 5, cost: { ...zeroCost(), cpuSeconds: 4 }, solutions,
    pending: { request, startedAt: now - (expired ? (request.allowance.wallSeconds + 1) * 1000 : 1000) } })
  const project = { projectId: 'test', projectLimits: {
    cpuSeconds: p.experiments * p.budget.reserveCpuSeconds, wallSeconds: p.experiments * p.budget.reserveSeconds } }
  const before = backend.deliveries, cancelled = []
  backend.cancel = async r => { cancelled.push(r.digest) }
  const result = await auditSequence(store, backend, project, receipt)
  assert.equal(backend.deliveries - before, expired ? 0 : 1)
  assert.equal(result.solutions[sourceDigest].status, expired ? 'unavailable' : 'completed')
  assert.equal(result.cost.cpuSeconds, expired ? request.allowance.cpuSeconds + 4 : 6)
  assert.deepEqual(cancelled, expired ? [request.digest] : [])
  assert.equal((await store.load('ledgers', project.projectId)).audit[p.digest.slice(7)].status, 'complete')
})

test('fixed execution recovery refuses valid low scores, consumes one allowance and preserves prior run identity', async t => {
  const store = await temporary(t), backend = new HitchBackend(store, {})
  const request = seal({ protocol: 'analysis-delivery-request@1', allowance: { cpuSeconds: 7200 } }), id = request.digest.slice(7)
  await store.save('executions', id, { status: 'reserved', evalId: 'failed-eval', task: { taskId: 'fixed' } })
  backend.hitch = async () => ({ result: { status: 'failed', trials: [{ observation_status: 'valid', scores: { total_score: 0 } }] } })
  await assert.rejects(backend.repairSealed(request, 'fixture'), /certified infrastructure/)
  backend.hitch = async () => ({ result: { status: 'failed', trials: [{ observation_status: 'invalid', invalid_reason: 'infrastructure_failure', run_id: 'original' }] } })
  const previous = await backend.repairSealed(request, 'fixed infrastructure')
  assert.equal(previous.runId, 'original'); assert.equal(previous.reservedCpuSeconds, 3600)
  await assert.rejects(backend.repairSealed(request, 'retry'), /allowance is spent/)
})

test('deployment rejects a source from a different research budget before executing', async t => {
  const store = await temporary(t), start = checkpoint(), backend = new Backend(store), p = plan(start)
  const receipt = await new SequenceRunner(store, backend).run(p, start)
  const calls = backend.deliveries
  await assert.rejects(refit(store, backend, { task, budget: { ...defaultBudget, tools: 151 } }, receipt, join(store.root, 'submission')), /registered task, budget/)
  await assert.rejects(refit(store, backend, { task, budget: defaultBudget, research: { maxExperiments: 3 } }, receipt, join(store.root, 'submission')), /registered task, budget/)
  assert.equal(backend.deliveries, calls)
})

test('failed deployment records and settles evidence once; restarting never reruns the failed source', async t => {
  const store = await temporary(t), start = checkpoint(), backend = new Backend(store, { resolved: true }), p = plan(start)
  const receipt = await new SequenceRunner(store, backend).run(p, start)
  const train = join(store.root, 'train.csv'), predict = join(store.root, 'test.csv'), out = join(store.root, 'submission')
  await writeFile(train, 'row,label\ntrain,1\n'); await writeFile(predict, 'row\nquery\n')
  const project = { projectId: 'test', task, budget: defaultBudget,
    projectLimits: { cpuSeconds: defaultBudget.reserveCpuSeconds, wallSeconds: defaultBudget.reserveSeconds },
    backend: { refit: { train, predict, predictIds: ['query'] } } }
  await store.save('bindings', 'refit', await refitBinding(project.backend))
  await writeFile(train, 'row,label\ntrain,0\n')
  await assert.rejects(refit(store, backend, project, receipt, out), /inputs changed/)
  await writeFile(train, 'row,label\ntrain,1\n')
  backend.verifyReceipt = async () => {}
  let executions = 0
  let enter, release
  const entered = new Promise(resolve => { enter = resolve }), pending = new Promise(resolve => { release = resolve })
  backend.deliver = async request => {
    executions++
    enter(); await pending
    return seal({ protocol: 'analysis-delivery@1', requestDigest: request.digest, status: 'candidate_failed',
      solutionDigest: request.solution.digest, resolvedPipelineDigest: request.solution.parameters.digest, fits: 0, searchCalls: 0, fitCalls: 0, runId: 'failed-refit', outputManifestDigest: digest('failure'),
      quality: 0, accuracy: null, modelRequests: 0, cost: { ...zeroCost(), cpuSeconds: .25 } })
  }
  const first = assert.rejects(refit(store, backend, project, receipt, out), /selected solution failed refit/)
  await entered
  await assert.rejects(refit(store, backend, project, receipt, out), /operation already locked/)
  release(); await first
  const result = JSON.parse(await readFile(join(out, 'refit.json'), 'utf8'))
  assert.equal(result.rows, 0); assert.equal(result.submissionDigest, null)
  const ledger = await store.load('ledgers', project.projectId)
  assert.equal(ledger.deployments[result.requestDigest].status, 'complete')
  assert.equal(ledger.deployments[result.requestDigest].cpuSeconds, .25)
  await assert.rejects(refit(store, backend, project, receipt, out), /selected solution failed refit/)
  assert.equal(executions, 1)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'refit.json'), 'utf8')), result)
  const { digest: ignored, ...resultBody } = result
  await writeFile(join(out, 'refit.json'), JSON.stringify(seal({ ...resultBody, requestDigest: digest('foreign') })))
  await assert.rejects(refit(store, backend, project, receipt, out), /another refit/)
  assert.equal(executions, 1)
  await assert.rejects(readFile(join(out, 'submission.csv')), /ENOENT/)
})

test('actual C5 failure does not erase successful start audit or become a selection-loss score', async t => {
  const store = await temporary(t), start = checkpoint(), backend = new Backend(store), p = plan(start)
  const receipt = await new SequenceRunner(store, backend).run(p, start), state = await store.load('sequences', p.digest.slice(7))
  const candidate = state.steps[0].experiment.sourceDigest
  const { digest: _, ...body } = receipt
  const failed = seal({ ...body, total_score: 0, valid_output: 0, completed: 0, delivery: { ...receipt.delivery, status: 'candidate_failed', accuracy: null, quality: 0 } })
  const report = trajectoryReport(failed, { currentSolutionDigest: candidate }, state.steps.map(s => s.experiment), {
    sequenceReceiptDigest: failed.digest, selectionDigest: digest(failed.selections), cost: zeroCost(),
    solutions: Object.fromEntries(state.steps.map(s => [s.experiment.sourceDigest, { status: 'completed', accuracy: .8 }])) })
  assert.equal(report.points[0].value, .8); assert.equal(report.points[4].value, 0)
  assert.equal(report.final_gain_from_start, -.8); assert.equal(report.selection_loss, null)
})
