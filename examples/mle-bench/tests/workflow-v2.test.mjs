import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { bootstrap } from '../prepare.mjs'
import { digest, seal, sha, advance, validateExperiment, validateSolution, initialCheckpoint, defaultBudget } from '../lib/contracts.mjs'
import { restoreWorkflow, updateStage, currentStage, stageUpdateParameter } from '../lib/workflow.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recordView, pageRecords, filterRecords, compareRecords } from '../lib/records.mjs'
import { validateSearchPlan, resolvePipeline } from '../lib/pipeline.mjs'
import { Store } from '../lib/store.mjs'
import { ResearchProject } from '../lib/project.mjs'
import { HitchBackend } from '../lib/hitch-backend.mjs'
import { prepare } from '../prepare.mjs'
import { fixture, competitions } from './mlebench-fixture.mjs'
import { mutable } from '../target-carrier/fixed/integrity.mjs'

const workflow = JSON.parse(await readFile(new URL('../target-carrier/harness/workflow.yaml', import.meta.url)))
const replay = JSON.parse(await readFile(new URL('../fixtures/titanic-25-replay.json', import.meta.url)))
const config = { inputSchema: {}, preprocessing: {}, features: {}, model: 'dummy', hyperparameters: { constant: 0 }, prediction: { kind: 'label' }, seed: 42 }
const plan = { version: 1, entrypoint: 'solution.py', variants: [{ id: 'base', config }, { id: 'alternative', config: { ...config, hyperparameters: { constant: 1 } } }],
  validation: { kind: 'stratified', folds: 2 }, selection: 'best_mean_utility', seed: 42, maxFits: 5, refitReserve: 1 }

test('workflow resumes compatible stages and invalidates dependencies without forcing a nine-stage rerun', () => {
  const state = restoreWorkflow(workflow, [], 'scope'), refs = new Set(['brief','profile','validation','processing','model'])
  assert.equal(currentStage(workflow, state).id, 'task')
  for (const [stage, ref] of [['task','brief'], ['eda','profile'], ['validation','validation'], ['processing','processing'], ['models','model']])
    updateStage(workflow, state, { stage, status: 'completed', artifacts: [ref] }, refs)
  const restored = restoreWorkflow(workflow, [{ analysis: { workflow: state } }], 'scope')
  assert.equal(restored.states.eda.status, 'completed'); assert.equal(restored.states.models.status, 'completed')
  updateStage(workflow, restored, { stage: 'features', status: 'skipped', reason: 'simple baseline first' }, refs)
  assert.equal(restored.states.eda.status, 'completed'); assert.equal(restored.states.models.status, 'completed')
  assert.equal(restored.states.tuning.status, 'not_started')
  assert.throws(() => updateStage(workflow, restored, { stage: 'eda', status: 'completed', artifacts: ['invented'] }, refs), /outside/)
  updateStage(workflow, restored, { stage: 'eda', status: 'completed', artifacts: ['profile'], inputs: { version: 2 } }, refs)
  assert.equal(restored.states.models.status, 'not_started')
  assert.equal(restoreWorkflow(workflow, [{ analysis: { workflow: state } }], 'other-data').states.eda.status, 'not_started')
})

test('workflow restoration follows snapshot time after checkpoint history is sorted by experiment ID', () => {
  const first = restoreWorkflow(workflow, [], 'scope'), latest = structuredClone(first)
  updateStage(workflow, latest, { stage: 'eda', status: 'completed', artifacts: ['profile'], conclusion: 'Observed profile' }, new Set(['profile']))
  const older = { experimentId: 'z', analysis: { timestamp: '2026-11-07T00:00:00Z', workflow: first } }
  const newer = { experimentId: 'a', analysis: { timestamp: '2026-11-07T01:00:00Z', workflow: latest } }
  const incompatible = { experimentId: 'b', analysis: { timestamp: '2026-11-07T02:00:00Z', workflow: { ...first, scope: 'other' } } }
  for (const history of [[newer, incompatible, older], [older, newer, incompatible]]) {
    assert.deepEqual(restoreWorkflow(workflow, history, 'scope'), latest)
    assert.equal(history.find(e => e.experimentId === 'z').analysis.workflow.states.eda.status, 'not_started')
  }
})

test('all 25 original receipts remain byte-identical and queryable; failed scores and unknown variants stay null', () => {
  assert.equal(replay.experiments.length, 25)
  for (const e of replay.experiments) validateExperiment(e)
  const original = JSON.stringify(replay), records = replay.experiments.map(recordView)
  assert.equal(filterRecords(records, { filters: { status: ['completed'] } }).length, 24)
  assert.equal(filterRecords(records, { filters: { status: ['candidate_failed'] } }).length, 1)
  assert.equal(records.find(r => r.execution.status === 'candidate_failed').formal_evaluation.score, null)
  assert.equal(records[0].variants, null)
  const ids = []; let cursor
  do { const page = pageRecords(records, { limit: 3, ...(cursor ? { cursor } : {}) }); ids.push(...page.records.map(r => r.identity.experimentId)); cursor = page.nextCursor } while (cursor)
  assert.equal(new Set(ids).size, 25); assert.equal(ids.length, 25)
  assert.equal(JSON.stringify(replay), original)
  assert.equal(compareRecords(records.slice(0,2)).comparable, false) // legacy data scope is unknown
  const cursor1 = pageRecords(records, { limit: 3 }).nextCursor
  assert.throws(() => pageRecords(records, { limit: 4, cursor: cursor1 }), /stale/)
})

test('explicit variants support several model families, and only compatible evaluation scopes compare', () => {
  validateSearchPlan(plan)
  validateSearchPlan({ ...plan, variants: [plan.variants[0], { id: 'tree', config: { ...config, model: 'tree', hyperparameters: { max_depth: 4 } } }] })
  assert.throws(() => validateSearchPlan({ ...plan, maxFits: 4 }), /fit budget/)
  assert.throws(() => validateSearchPlan({ ...plan, validation: { kind: 'group', folds: 3 } }), /column/)
  const records = replay.experiments.slice(0, 2).map(recordView)
  records.forEach(r => { r.scope.dataset = 'same' })
  assert.equal(compareRecords(records).comparable, true)
  records[1].scope.validation = 'different'
  assert.equal(compareRecords(records).comparable, false)
})

test('sealing covers editable workflow/plugin while the executor remains fixed', () => {
  for (const name of ['workflow.yaml', 'tools/experiment/query.py', 'tools/experiment/migrations/v2.py', 'tools/experiment/interface.json', 'prompts/stages/models.md']) assert.equal(mutable(name), true)
  for (const name of ['fixed/worker.py', '../workflow.yaml', 'tools/experiment/../../worker.py', 'tools/experiment/a.sh']) assert.equal(mutable(name), false)
})

async function setup(t, previous = {}) {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v2-')); t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'target'), built = await bootstrap(repo)
  const data = join(root, 'data'); await mkdir(data)
  const train = 'id,x,target\n1,1,0\n2,2,1\n', predict = 'id,x\n3,3\n'
  const validation = { protocol: 'analysis-holdout-plan@1', trainDigest: sha(train), metric: 'accuracy', assignments: [0,1], seed: 42, validationFraction: .5 }
  const task = seal({ protocol: 'analysis-task@4', taskId: 'test', taskFamilyId: 'test', description: 'workflow regression',
    inputs: { trainDigest: sha(train), predictDigest: sha(predict) }, prediction: { kind: 'tabular', idColumn: 'id', targetColumns: ['target'], metric: 'accuracy', labels: ['0','1'] },
    predictIds: ['3'], publicFiles: [], validationPlanDigest: digest(validation), runtimeDigest: digest('runtime') })
  const checkpoint = previous.checkpoint ?? initialCheckpoint({ researchProjectId: 'test', taskFamilyId: 'test', baseTaskDigest: task.digest,
    dataScopeDigest: digest(task.inputs), runtimeDigest: task.runtimeDigest, scorerDigest: digest('metric'), validationPlanDigest: digest(validation) })
  const request = seal({ protocol: 'analysis-rollout-request@1', sequenceId: 'sequence', slotIndex: 1, planDigest: digest('plan'), task,
    harness: built.harness, model: 'fixture', runtimeDigest: task.runtimeDigest, checkpointDigest: checkpoint.digest, checkpointRef: checkpoint.digest,
    previousRolloutReceiptDigest: null, eligibleSolutionDigests: [], allowance: { wallSeconds: 300, cpuSeconds: 300, tools: 150, tokens: null, requests: null }, experimentWallSeconds: 240, experimentCpuSeconds: 240 })
  for (const [name, value] of [['request', request], ['checkpoint', checkpoint], ['validation', validation]]) await writeFile(join(data, name+'.json'), JSON.stringify(value))
  if (previous.objects) await cp(previous.objects, join(data, 'objects'), { recursive: true })
  await writeFile(join(data, 'train.csv'), train); await writeFile(join(data, 'predict.csv'), predict)
  const { Driver } = await import(pathToFileURL(join(repo, 'fixed/driver.mjs')))
  const driver = new Driver(repo, { data, work: join(root, 'work'), output: join(root, 'output') })
  process.env.HITCH_RUN_ID = previous.runId ?? 'run_'+'1'.repeat(32); await driver.initialize()
  return { driver, root, repo }
}

test('cold start loads one stage, unified run is idempotent, selection binds the actual variant', async t => {
  const { driver: d, root } = await setup(t)
  const brief = await d.inspect()
  assert.equal(brief.stage, 'task'); assert.ok(brief.guidance.path.endsWith('/task.md')); assert.ok(JSON.stringify(brief).length < 7000)
  assert.equal(brief.history.total, 0)
  await d.write('solution.py', 'def build_pipeline(config): pass\n', null)
  let calls = 0
  d.worker = async job => {
    calls++; assert.equal(job.operation, 'research')
    const predictionPath = join(root, 'predictions.json'); await writeFile(predictionPath, '{"2":[1]}')
    return { status: 'completed', metric: 'accuracy', validationScore: 1, validationUtility: 1, validationRows: 1,
      cpuSeconds: 1, wallSeconds: 1, predictionsPath: predictionPath, logs: [], fits: 5, fitCalls: 5,
      variants: plan.variants.map(v => ({ ...v, status: 'completed', folds: [], meanUtility: .5 })), formalVariantId: 'base',
      formalFit: { config, fits: 1, fitCalls: 1, searchCalls: 0, parametersBefore: { model: 'dummy' }, parametersAfter: { model: 'dummy' } } }
  }
  const args = { action: 'run', plan, hypothesis: 'compare two configurations', intendedChange: 'bounded model comparison' }
  const result = await d.experiments(args); assert.equal(result.variantId, 'base')
  assert.equal(result.artifacts[0].source, 'runtime')
  assert.deepEqual((await d.inspectPredictions(result.experimentId, 0)).predictions, [{ id: '2', prediction: [1] }])
  assert.equal((await d.experiments(args)).reusedRequest, true); assert.equal(calls, 1)
  await assert.rejects(d.experiments({ ...args, hypothesis: 'different' }), /already started/)
  await assert.rejects(d.experiments({ action: 'select', experimentId: result.experimentId, variantId: 'alternative' }), /evaluated resolved/)
  await d.experiments({ action: 'select', experimentId: result.experimentId, variantId: 'base', reason: 'formal evidence' })
  validateSolution(d.solution); validateExperiment(d.experiment())
  assert.equal(d.experiment().protocol, 'analysis-experiment@4')
  assert.equal(d.solution.parameters.config.hyperparameters.constant, 0)
  let text = '', cursor
  do { const page = await d.experiments({ action: 'get', experimentId: result.experimentId, ...(cursor ? { cursor } : {}) }); text += page.content; cursor = page.nextCursor } while (cursor)
  assert.equal(JSON.parse(text).decision.variantId, 'base')
  await d.finish('selected frozen pipeline', [])
  assert.equal(JSON.parse(await readFile(join(root, 'output/receipt.json'))).selectedSolutionDigest, d.solution.digest)
})

test('documented stage arguments persist EDA evidence through sealing, checkpointing and reuse', async t => {
  const { driver: d, root } = await setup(t), brief = await d.inspect(undefined, { stage: 'eda' })
  const tool = defineTool({ name: 'experiment', description: 'Stage recording regression',
    parameters: { action: { type: 'string', required: true, enum: ['record'] }, stage: stageUpdateParameter(workflow) },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => JSON.stringify(await d.experiments(args)) })
  assert.deepEqual(tool.parameters.properties.stage.required, ['stage', 'status'])
  assert.deepEqual(tool.parameters.properties.stage.properties.stage.enum, workflow.stages.map(s => s.id))
  assert.ok(tool.parameters.properties.stage.properties.artifacts.description.includes('digests'))
  await assert.rejects(tool.execute({ action: 'record', stage: { stage: 'eda', status: 'done' } }, {}), /invalid arguments/)
  await assert.rejects(tool.execute({ action: 'record', stage: { stage: 'eda' } }, {}), /invalid arguments/)
  await assert.rejects(tool.execute({ action: 'record', stage: { stage: 'eda', status: 'running', score: 1 } }, {}), /invalid arguments/)
  await d.write('profile.py', 'print("training profile")\n', null)
  d.worker = async job => {
    assert.equal(job.operation, 'script'); assert.equal(job.analysisOnly, true)
    await mkdir(job.outputDirectory, { recursive: true })
    await writeFile(join(job.outputDirectory, 'profile.json'), '{"rows":1,"findings":["one training row; insufficient for subgroup conclusions"]}')
    return { exitCode: 0, limit: null, cpuSeconds: .01, outputFiles: ['profile.json'] }
  }
  const result = await d.analyze('profile.py'), profile = result.artifacts.find(a => a.path === 'profile.json')
  assert.equal(d.analysis.workflow.states.eda.status, 'not_started')
  assert.equal(profile.executionStatus, 'completed')
  assert.ok(result.stageUpdate.includes('action="record"'))
  const args = structuredClone(brief.stageRecord.example)
  args.stage.artifacts = [profile.digest]; args.stage.conclusion = 'Only one training row; subgroup estimates are unavailable.'
  args.stage.inputs = { profileVersion: 1 }
  const recorded = JSON.parse(await tool.execute(args, {}))
  assert.equal(recorded.workflow.states.eda.status, 'completed')
  const onDisk = JSON.parse(await readFile(join(root, 'work/analysis-state.json')))
  assert.deepEqual(onDisk.analysis.workflow.states.eda, recorded.workflow.states.eda)
  // A failed model generation must still preserve completed analysis evidence.
  d.selection = null; d.selectedAt = new Date().toISOString()
  await d.finish('EDA complete; no candidate trained', ['No model evaluation'])
  const receipt = JSON.parse(await readFile(join(root, 'output/receipt.json')))
  assert.equal(receipt.experiment.execution.status, 'generation_failed')
  const checkpoint = advance(d.checkpoint, receipt.experiment, [], null, digest('output manifest'))
  const { driver: next } = await setup(t, { checkpoint, objects: join(root, 'output/objects'), runId: 'run_'+'2'.repeat(32) })
  const resumed = await next.inspect(undefined, { stage: 'eda' })
  assert.deepEqual(resumed.stageState, recorded.workflow.states.eda)
  const evidence = await next.experiments({ action: 'get', experimentId: receipt.experiment.experimentId, artifactDigest: profile.digest })
  assert.equal(JSON.parse(Buffer.from(evidence.content, 'base64')).rows, 1)
  await next.experiments({ action: 'record', stage: { stage: 'eda', status: 'reused', artifacts: resumed.stageState.artifacts,
    inputs: resumed.stageState.inputs, conclusion: resumed.stageState.conclusion, reason: 'Same data, dependencies and profile' } })
  assert.equal(next.analysis.workflow.states.eda.status, 'reused')
})

test('EDA completion rejects absent, code-only, note-only and failed-script evidence', async t => {
  const { driver: d } = await setup(t)
  await d.inspect(); await d.write('failed.py', 'raise ValueError("profile failed")\n', null)
  d.worker = async () => ({ exitCode: 1, limit: null, cpuSeconds: .01, outputFiles: [] })
  const result = await d.analyze('failed.py')
  const note = { source: 'agent_note', digest: digest('unobserved assertion') }; d.analysis.artifacts.push(note)
  for (const artifacts of [[], [digest('invented')], [note.digest], ...result.artifacts.map(a => [a.digest])])
    await assert.rejects(d.experiments({ action: 'record', stage: { stage: 'eda', status: 'completed', artifacts, conclusion: 'unsupported' } }), /EDA completion requires/)
  assert.equal(d.analysis.workflow.states.eda.status, 'not_started')
  const failure = await d.experiments({ action: 'record', stage: { stage: 'eda', status: 'failed',
    artifacts: [result.artifacts.at(-1).digest], reason: 'Profiling script failed', conclusion: 'No observed profile' } })
  assert.equal(failure.workflow.states.eda.status, 'failed')
})

test('failed plugin migration preserves raw receipts and can rebuild with the previous plugin', async t => {
  const { driver: d, repo, root } = await setup(t)
  d.checkpoint.history = replay.experiments
  const frozen = JSON.stringify(d.checkpoint.history)
  d.worker = async job => {
    const work = join(root, 'plugin-test'); await mkdir(work, { recursive: true })
    await mkdir(join(work, 'inputs'), { recursive: true }); await mkdir(join(work, 'scratch'), { recursive: true })
    for (const [name, path] of Object.entries(job.inputs)) { await mkdir(join(work, 'inputs', name, '..'), { recursive: true }); await writeFile(join(work, 'inputs', name), await readFile(path)) }
    for (const [name, path] of Object.entries(job.files)) { await mkdir(join(work, name, '..'), { recursive: true }); await writeFile(join(work, name), (await readFile(path, 'utf8')).replaceAll('/work/inputs', join(work, 'inputs')).replaceAll('/work/scratch', join(work, 'scratch'))) }
    let failed = false
    try { execFileSync('python3', [join(work, job.entrypoint)], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' }) } catch { failed = true }
    await mkdir(job.outputDirectory, { recursive: true })
    if (!failed) await writeFile(join(job.outputDirectory, 'result.json'), await readFile(join(work, 'scratch/result.json')))
    return { exitCode: failed ? 1 : 0, limit: null, cpuSeconds: .01, outputFiles: failed ? [] : ['result.json'] }
  }
  const before = await d.experiments({ action: 'search', limit: 5 })
  assert.equal(before.total, 25); assert.equal(before.records.length, 5)
  const path = join(repo, 'harness/tools/experiment/storage.py'), original = await readFile(path)
  await writeFile(path, 'def migrate(*args): raise ValueError("broken migration")\n')
  await assert.rejects(d.experiments({ action: 'search' }), /plugin failed/)
  assert.equal(JSON.stringify(d.checkpoint.history), frozen)
  await writeFile(path, original)
  assert.equal((await d.experiments({ action: 'search', order: 'newest' })).records[0].id, replay.experiments.at(-1).experimentId)
  assert.equal(JSON.stringify(d.checkpoint.history), frozen)
})

test('25-slot admission cannot silently admit 50 paired experiments or an extra bootstrap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-admission-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), project = new ResearchProject(store, { projectId: 'test', projectLimits: { maxSequences: 10, maxTargetExperiments: 25, cpuSeconds: defaultBudget.cpuSeconds * 10, wallSeconds: defaultBudget.wallSeconds * 10 } })
  const plans = Array.from({ length: 5 }, (_, i) => ({ digest: digest(i), experiments: 5, budget: defaultBudget }))
  await project.reserveSequences(plans); await project.reserveSequences(plans)
  await assert.rejects(project.reserveSequences([{ digest: digest('sixth'), experiments: 5, budget: defaultBudget }]), /Target experiment budget/)
  await assert.rejects(project.reserveAuxiliary('bootstrap', digest('extra'), { cpuSeconds: 10, wallSeconds: 10 }), /bootstrap also/)
  assert.equal(Object.keys((await store.load('ledgers', 'test')).sequences).length, 5)
})

test('prepared MLE task uses all training rows with round CV and an explicit project slot budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-prepare-v2-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = await fixture(join(root, 'fixture'), competitions[1]), hitch = join(root, 'hitch')
  for (const name of ['analysis.mjs','runtime/analysis-verify.py','runtime/scoring.py','analysis-contracts/schemas.mjs']) {
    const p = join(hitch, 'benchmark-packages/kaggle', name); await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, name)
  }
  const project = await prepare({ out: join(root, 'project'), competition: input.competition, fixture: true,
    mlebenchRepository: input.repository, mlebenchData: input.dataRoot, hitchRepository: hitch,
    hitchExecutable: '/fixture/hitch', executorExecutable: '/fixture/executor', hitchRoot: join(root, 'hitch-data'),
    executorCommit: 'a'.repeat(40), baseImage: 'fixture@sha256:'+'1'.repeat(64), platform: 'linux/arm64', model: 'fixture' })
  assert.equal(project.task.protocol, 'analysis-task@5')
  assert.equal(project.validationPlan.protocol, 'analysis-round-cv-policy@1')
  assert.equal(project.validationPlan.folds, 5)
  assert.equal(project.validationPlan.shuffle, true)
  assert.equal(project.rows.train, 20)
  assert.equal(project.backend.expected, null)
  assert.equal(project.projectLimits.maxTargetExperiments, project.projectLimits.maxSequences * project.research.maxExperiments)
  assert.equal(project.task.validationPlanDigest, digest(project.validationPlan))
})

test('Meta trajectory pages use public commands, exact canonical identity and observable fields only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-trace-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), backend = new HitchBackend(store, {}), runId = 'run_'+'2'.repeat(32), canonical = digest('trajectory')
  await store.save('seed-runs', runId, { childRuns: [runId] })
  const calls = []
  backend.hitch = async args => {
    calls.push(args)
    return args[1] === 'project' ? { source: { canonical_sha256: canonical } }
      : { run_id: runId, canonical_sha256: canonical, events: [{ seq: 21, type: 'tool/result', data: { content: 'EDA evidence' } }], next_cursor: 'page-2' }
  }
  const page = await backend.trajectoryPage(runId, { seqStart: 21, seqEnd: 21, field: 'data.content' })
  assert.equal(page.next_cursor, 'page-2'); assert.ok(calls[1].includes(canonical)); assert.ok(calls[1].includes('data.content'))
  await assert.rejects(backend.trajectoryPage(runId, { types: ['assistant/reasoning'] }), /observable/)
  await assert.rejects(backend.trajectoryPage('run_'+'3'.repeat(32)), /authorized/)
})
