import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { command } from '../lib/common.mjs'
import { inspectMlebench, importMlebench } from '../lib/mlebench.mjs'
import { validateTabularSubmission } from '../lib/submission.mjs'
import { fixture, competitions } from './mlebench-fixture.mjs'
import { metrics, objective } from '../lib/operation-provider.mjs'
import { defaultBudget, researchBudget, seal } from '../lib/contracts.mjs'
import { decodeOof } from '../target-carrier/fixed/oof.mjs'
import { internalScore, internalQuality } from '../lib/metrics.mjs'
import { prepare } from '../prepare.mjs'
const python = process.env.GEAR_MLEBENCH_PYTHON ?? 'python3'

test('prepare freezes an MLE-bench project and requires its input contract before creating output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlebench-prepare-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = await fixture(root, competitions[1]), out = join(root, 'project')
  await assert.rejects(prepare({ out }), /MLE-bench repository, data root and competition/)
  assert.ok(!(await readdir(root)).includes('project'))
  const hitch = join(root, 'hitch')
  for (const name of ['analysis.mjs', 'runtime/analysis-verify.py', 'runtime/scoring.py', 'analysis-contracts/schemas.mjs']) {
    const file = join(hitch, 'benchmark-packages/kaggle', name)
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'fixture')
  }
  const result = await prepare({ out, mlebenchRepository: input.repository, mlebenchData: input.dataRoot,
    competition: input.competition, fixture: true, python, hitchRepository: hitch, hitchRoot: join(root, 'hitch-state'),
    hitchExecutable: process.execPath, executorExecutable: process.execPath, executorRepository: hitch,
    executorCommit: 'a'.repeat(40), baseImage: 'fixture@sha256:' + 'b'.repeat(64), platform: 'linux/arm64', model: 'fixture',
    research: { maxExperiments: 7, validation: { folds: 5, shuffle: true, scope: 'round', seed: 7 } } })
  assert.equal(result.task.protocol, 'analysis-task@5')
  assert.equal(result.task.benchmark.competitionId, input.competition)
  assert.equal(result.task.prediction.metric, 'auc-roc')
  assert.equal(result.backend.refit.scope, 'mle-bench-public')
  assert.deepEqual(await readFile(result.backend.train), await readFile(join(input.publicDir, 'train.csv')))
  assert.equal(result.rows.train, 20); assert.equal(result.validationPlan.folds, 5)
  assert.equal(result.research.maxExperiments, 7); assert.equal(result.validationPlan.seed, 7)
  assert.deepEqual(result.budget, researchBudget({ maxExperiments: 7 }))
  assert.ok(result.projectLimits.cpuSeconds >= 2 * result.budget.cpuSeconds)
  assert.ok(result.projectLimits.wallSeconds >= 2 * result.budget.wallSeconds)
  assert.equal(result.validationPlan.scope, 'round'); assert.equal(result.backend.expected, null)
  assert.ok(!(await readdir(result.backend.publicDirectory)).includes('private'))
  assert.deepEqual(JSON.parse(await readFile(join(out, 'project.json'))), result)
})

for (const competition of competitions) test(`${competition}: canonical prepared/public import and round CV policy`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlebench-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = await fixture(root, competition), out = join(root, 'imported')
  const result = await importMlebench({ ...input, python }, out)
  assert.equal(result.benchmark.verification, 'fixture')
  assert.deepEqual(result.rows, { train: 20, predict: 4, refitTrain: 20, refitPredict: 4 })
  assert.deepEqual(await readFile(result.train), await readFile(join(input.publicDir, 'train.csv')))
  assert.deepEqual(await readFile(result.predict), await readFile(join(input.publicDir, 'test.csv')))
  const plan = JSON.parse(await readFile(join(out, 'validation.json')))
  assert.equal(plan.protocol, 'analysis-round-cv-policy@1'); assert.equal(plan.folds, 5)
  assert.equal(plan.assignments, undefined); assert.equal(plan.shuffle, true); assert.equal(plan.scope, 'round')
  await importMlebench({ ...input, python }, join(root, 'again'))
  assert.deepEqual(JSON.parse(await readFile(join(root, 'again/validation.json'))), plan)
  assert.ok(!(await readdir(join(out, 'public'))).includes('private'))
  assert.equal(result.prediction.metric, competition === competitions[0] ? 'mean-column-wise-rmsle' : 'auc-roc')
  if (competition === competitions[0]) {
    assert.deepEqual(result.predictIds, ['1', '2', '3', '4'])
    assert.equal(result.publicFiles.filter(f => f.role === 'train').length, 20)
    assert.equal(result.publicFiles.filter(f => f.role === 'predict').length, 4)
    const before = (await inspectMlebench(input)).descriptor.publicTreeDigest
    await writeFile(join(input.publicDir, 'test/1/geometry.xyz'), 'modified public geometry')
    assert.notEqual((await inspectMlebench(input)).descriptor.publicTreeDigest, before)
    await rm(join(input.publicDir, 'test/1/geometry.xyz'))
    await assert.rejects(importMlebench({ ...input, python }, join(root, 'missing-geometry')), /geometry files/)
  }
  // Synthetic data cannot acquire the official-data verification marker.
  await assert.rejects(inspectMlebench({ ...input, fixture: false }), /checksum mismatch/)
  await writeFile(join(input.repository, 'mlebench/competitions', competition, 'grade.py'), 'def grade(a,b): return 1\n')
  await assert.rejects(inspectMlebench(input), /grader source/)
})

test('submission contract preserves ID order and probability/multi-target domains', () => {
  const task = { prediction: { kind: 'tabular', metric: 'auc-roc', idColumn: 'id', targetColumns: ['target'], labels: ['0', '1'] }, predictIds: ['8', '4'] }
  validateTabularSubmission(Buffer.from('id,target\n8,0.4\n4,0.8\n'), task)
  for (const csv of ['id,target\n4,.8\n8,.4\n', 'id,target\n8,NaN\n4,.5\n', 'id,target\n8,\n4,.5\n', 'id,target\n8,1.1\n4,.5\n'])
    assert.throws(() => validateTabularSubmission(Buffer.from(csv), task))
  const nomad = { ...task, prediction: { ...task.prediction, metric: 'mean-column-wise-rmsle', targetColumns: ['energy', 'gap'], labels: [] } }
  validateTabularSubmission(Buffer.from('id,energy,gap\n8,2.4,1\n4,1,7\n'), nomad)
  assert.throws(() => validateTabularSubmission(Buffer.from('id,energy,gap\n8,-1,1\n4,1,7\n'), nomad))
})

test('fixed scores and fold asset scopes match native MLE-bench graders', { skip: !process.env.GEAR_MLEBENCH_REPOSITORY }, async () => {
  const result = await command(python, ['examples/mle-bench/tests/mlebench-parity.py'], {
    env: { ...process.env, PYTHONPATH: process.env.GEAR_MLEBENCH_REPOSITORY } })
  assert.equal(JSON.parse(result).status, 'passed')
})

test('Gear objective maximizes utility while retaining minimizing unbounded RMSLE', async () => {
  // Failed V2 experiments must remain JSON-serializable diagnostic facts.
  const failed = { execution: { pooledScore: null, pooledUtility: null } }
  const facts = seal({ score: internalScore(failed), utility: internalQuality(failed) })
  assert.equal(facts.score, null); assert.equal(facts.utility, null)
  const golden = JSON.parse(await readFile(new URL('../fixtures/golden.json', import.meta.url)))
  const { digest: _, ...body } = golden.task
  const task = seal({ ...body, protocol: 'analysis-task@2', prediction: { kind: 'tabular', idColumn: 'id',
    targetColumns: ['a','b'], metric: 'mean-column-wise-rmsle', labels: [] }, publicFiles: [],
    benchmark: { format: 'mle-bench', competitionId: competitions[0], definitionDigest: golden.task.digest,
      publicTreeDigest: golden.task.digest, sourceRevision: 'fixture', verification: 'fixture' } })
  const raw = metrics(task).find(m => m.id === 'task_score')
  assert.equal(raw.unit, 'mean-column-wise-rmsle'); assert.equal(raw.direction, 'minimize'); assert.equal(raw.range, undefined)
  assert.deepEqual(objective.terms, [{ metric: 'total_score', weight: 1 }])
  assert.equal(metrics(task).find(m => m.id === 'total_score').direction, 'maximize')
})

test('800k-row May OOF evidence fits the artifact bound and retains IDs and precision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlebench-oof-')); t.after(() => rm(root, { recursive: true, force: true }))
  const script = "import sys,json,random; from pathlib import Path; sys.path.insert(0,'examples/mle-bench/target-carrier/fixed'); from worker import write_oof; r=random.Random(0); values={str(i):[r.random()] for i in range(800000)}; p=write_oof(Path(sys.argv[1]),values); a=p.read_bytes(); write_oof(Path(sys.argv[1]),values); assert p.read_bytes()==a; print(json.dumps({'last':values['799999'][0]}))"
  const expected = JSON.parse(await command(python, ['-c', script, root]))
  const bytes = await readFile(join(root, 'oof.json.gz')), decoded = decodeOof(bytes)
  assert.ok(bytes.length < 16 * 1024 ** 2); assert.equal(Object.keys(decoded).length, 800000)
  assert.equal(decoded['799999'][0], expected.last)
  assert.deepEqual(decodeOof(Buffer.from('{"old":"1"}')), { old: '1' })
})
