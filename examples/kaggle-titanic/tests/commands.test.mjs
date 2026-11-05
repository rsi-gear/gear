import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullFoldSettings, hash, parseCsv, validateSubmission } from '../common.mjs'
import { submissionMatch, main as submit } from '../submit.mjs'

test('submission validation aligns IDs rather than trusting order or row count alone', () => {
  const schema = { id_column: 'PassengerId', target_column: 'Survived', expected_ids: ['892', '893'], rows: 2, allowed_labels: [0, 1] }
  validateSubmission(Buffer.from('PassengerId,Survived\n893,1\n892,0\n'), schema)
  for (const text of ['PassengerId,Survived\n892,1\n892,0\n', 'PassengerId,Survived\n892,2\n893,0\n',
    'PassengerId,Survived,index\n892,1,0\n893,0,1\n', 'PassengerId,Survived\n892,1\n']) {
    assert.throws(() => validateSubmission(Buffer.from(text), schema))
  }
})
test('CSV parsing supports quoted commas and status matching refuses ambiguity', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,y","a""b"\r\n'), [['a', 'b'], ['x,y', 'a"b']])
  assert.equal(submissionMatch('ref,description,status\n1,gear-test,complete\n', 'gear-test').ref, '1')
  assert.throws(() => submissionMatch('ref,description\n1,gear-test\n2,gear-test\n', 'gear-test'), /ambiguous/)
  assert.equal(submissionMatch('No submissions found', 'gear-test'), undefined)
  assert.throws(() => submissionMatch('ref,description,description\n1,gear-test,gear-test\n', 'gear-test'), /unsupported/)
  assert.throws(() => submissionMatch('ref,description\n,gear-test\n', 'gear-test'), /unsupported/)
})
test('full-fold preset keeps all folds in the shared core', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => `titanic-dev-fold-${i}`)
  const preset = fullFoldSettings(tasks)
  assert.deepEqual(preset.scopeSampling.sharedCoreTaskIds, tasks)
  assert.equal(preset.taskSetSizing.shared.minTasks, 5)
  assert.throws(() => fullFoldSettings(tasks.slice(1)))
})
test('single-fold diagnosis still evaluates all five folds equally through existing search', async () => {
  const { universe } = await import('../../../lib/search/testing.js')
  const { defaultSearchConfig } = await import('../../../lib/search/config.js')
  const { resolveSizing } = await import('../../../lib/search/contracts.js')
  const { createScope, sharedTasks, bridgeSelection } = await import('../../../lib/search/scopes.js')
  const u = universe(5), ids = u.tasks.map(t => t.id)
  const config = { ...structuredClone(defaultSearchConfig), ...fullFoldSettings(ids) }
  const sizing = resolveSizing(u, config.taskSetSizing)
  const scope = createScope(u, sizing, config, { familyId: 'one-fold-failure', taskIds: [ids[0]] }, sharedTasks(u, sizing, config, []))
  assert.deepEqual(scope.taskIds, ids)
  assert.deepEqual(Object.values(scope.weights), [.2, .2, .2, .2, .2])
  const bridge = await bridgeSelection(u, sizing, config, 0, [{ candidateId: 'candidate', scope }], 'parent', [], () => true)
  assert.deepEqual(bridge.plan.taskIds, ids)
})
test('lost Kaggle reply reserves the submission and retry never sends another POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kaggle-submit-'))
  try {
    const file = join(root, 'submission.csv'), log = join(root, 'calls'), exe = join(root, 'kaggle')
    await writeFile(file, 'PassengerId,Survived\n892,1\n')
    await writeFile(join(root, 'finalization.json'), JSON.stringify({ status: 'complete', synthetic: false, competition: 'titanic',
      runId: 'run_123', submissionFile: file, submissionDigest: hash(await readFile(file)), inputs: { candidateCommit: 'a'.repeat(40) } }))
    await writeFile(exe, `#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(log)},process.argv[3]+'\\n');if(process.argv[3]==='submit')process.exit(1);console.log('ref,description,status');\n`, { mode: 0o755 })
    await assert.rejects(submit(['--finalization', root, '--kaggle', exe]))
    await submit(['--finalization', root, '--kaggle', exe])
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(x => x === 'submit').length, 1)
    assert.equal(JSON.parse(await readFile(join(root, 'kaggle-submission.json'), 'utf8')).status, 'unknown')
  } finally { await rm(root, { recursive: true, force: true }) }
})
