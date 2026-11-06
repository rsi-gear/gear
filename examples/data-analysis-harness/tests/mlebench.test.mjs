import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { command } from '../lib/common.mjs'
import { inspectMlebench, importMlebench } from '../lib/mlebench.mjs'
import { validateTabularSubmission } from '../lib/submission.mjs'
import { fixture, competitions } from './mlebench-fixture.mjs'
import { metrics, objective } from '../lib/operation-provider.mjs'
import { defaultBudget, seal } from '../lib/contracts.mjs'
import { decodeOof } from '../target-carrier/fixed/oof.mjs'
import { internalScore, internalQuality } from '../lib/metrics.mjs'
const python = process.env.GEAR_MLEBENCH_PYTHON ?? 'python3'

for (const competition of competitions) test(`${competition}: canonical prepared/public import and locked five-fold scope`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mlebench-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = await fixture(root, competition), out = join(root, 'imported')
  const result = await importMlebench({ ...input, python }, out)
  assert.equal(result.benchmark.verification, 'fixture')
  assert.deepEqual(result.rows, { train: 20, predict: 4, refitTrain: 20, refitPredict: 4 })
  assert.deepEqual(await readFile(result.train), await readFile(join(input.publicDir, 'train.csv')))
  assert.deepEqual(await readFile(result.predict), await readFile(join(input.publicDir, 'test.csv')))
  const plan = JSON.parse(await readFile(join(out, 'validation.json')))
  assert.equal(plan.foldAssignments.length, 20); assert.deepEqual([...new Set(plan.foldAssignments)].sort(), [0, 1, 2, 3, 4])
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
  const result = await command(python, ['examples/data-analysis-harness/tests/mlebench-parity.py'], {
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
  const script = "import sys,json,random; from pathlib import Path; sys.path.insert(0,'examples/data-analysis-harness/target-carrier/fixed'); from worker import write_oof; r=random.Random(0); values={str(i):[r.random()] for i in range(800000)}; p=write_oof(Path(sys.argv[1]),values); a=p.read_bytes(); write_oof(Path(sys.argv[1]),values); assert p.read_bytes()==a; print(json.dumps({'last':values['799999'][0]}))"
  const expected = JSON.parse(await command(python, ['-c', script, root]))
  const bytes = await readFile(join(root, 'oof.json.gz')), decoded = decodeOof(bytes)
  assert.ok(bytes.length < 16 * 1024 ** 2); assert.equal(Object.keys(decoded).length, 800000)
  assert.equal(decoded['799999'][0], expected.last)
  assert.deepEqual(decodeOof(Buffer.from('{"old":"1"}')), { old: '1' })
})
