import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advance, digest, initialCheckpoint, seal, sha, zeroCost } from '../lib/contracts.mjs'
import { HitchBackend } from '../lib/hitch-backend.mjs'
import { Store } from '../lib/store.mjs'

test('research child lookup verifies the seed aggregate and excludes foreign or missing receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-seed-child-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root), backend = new HitchBackend(store, {}), signal = new AbortController().signal
  for (const run of ['anchor', 'child']) await store.save('seed-runs', run, { cellKey: 'cell' })
  await store.save('seed-runs', 'foreign', { cellKey: 'different' })
  const step = { runId: 'child', digest: digest('receipt'), requestDigest: digest('request') }
  const cell = { partition: 'seed', cell: { evidenceRef: 'anchor', identity: {} },
    plan: { digest: digest('plan'), task: { taskId: 'task' } }, receipt: { steps: [{ runId: 'child', receiptDigest: step.digest }] } }
  await store.save('cells', 'cell', cell)
  await store.save('sequences', cell.plan.digest.slice(7), { steps: [step] })
  await store.save('executions', step.requestDigest.slice(7), { status: 'complete', runId: 'child', evalId: 'physical', rewards: { valid_output: 1 }, trial: { trial_name: 'trial' } })
  const provider = { verifyCell: async () => true }
  assert.deepEqual(await backend.resolveSeedChild('anchor', 'child', provider, signal), {
    evalId: 'physical', trial: { taskName: 'task', runId: 'child', status: 'completed', rewards: { valid_output: 1 }, attempt: 1, trialName: 'trial' } })
  assert.equal(await backend.resolveSeedChild('anchor', 'foreign', provider, signal), undefined)
  assert.equal(await backend.resolveSeedChild('anchor', 'missing', provider, signal), undefined)
  assert.equal(await backend.resolveSeedChild('child', 'anchor', provider, signal), undefined)
  assert.equal(await backend.resolveSeedChild('anchor', 'child', { verifyCell: async () => false }, signal), undefined)
  cell.receipt.steps[0].receiptDigest = digest('changed')
  await store.save('cells', 'cell', cell)
  assert.equal(await backend.resolveSeedChild('anchor', 'child', provider, signal), undefined)
})

test('materialization reuses shared artifact/source bytes and safely resumes a producer failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-materialize-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'research')), runtimeDigest = digest('runtime')
  const source = Buffer.from('def predict(): return 0\n'), sourceDigest = await store.putBytes(source)
  const publicBytes = Buffer.from('Public task description\n')
  const publicDirectory = join(root, 'public'); await mkdir(publicDirectory)
  await writeFile(join(publicDirectory, 'description.md'), publicBytes)
  const task = seal({ protocol: 'analysis-task@4', taskId: 'fixture', taskFamilyId: 'fixture', description: 'fixture',
    inputs: { trainDigest: sha('train'), predictDigest: sha('predict') }, predictIds: ['1'], runtimeDigest,
    validationPlanDigest: digest('validation'), publicFiles: [{ path: 'description.md', digest: sha(publicBytes), bytes: publicBytes.length, role: 'shared', rowId: null }],
    prediction: { kind: 'tabular', idColumn: 'id', targetColumns: ['label'], labels: ['0','1'], metric: 'accuracy' } })
  const solution = seal({ protocol: 'analysis-solution@1', entrypoint: 'pipeline.py',
    files: [{ path: 'pipeline.py', digest: sourceDigest, bytes: source.length }], parameters: {}, trainingSeed: 42, runtimeDigest, authoredByRunId: 'run_fixture' })
  const predictions = await store.putBytes(Buffer.from('0'))
  const experiment = seal({ protocol: 'analysis-experiment@4', experimentId: 'experiment', sequenceId: 'sequence', rolloutRunId: 'run_fixture',
    slotIndex: 1, parentExperimentId: null, operator: 'draft', sourceDigest: solution.digest, validationPlanDigest: task.validationPlanDigest, trainingSeed: 42,
    claim: { hypothesis: 'fixture', intendedChange: 'fixture' }, interpretation: { conclusion: 'fixture', limitations: [] },
    execution: { status: 'completed', receiptDigest: digest('receipt'), physicalAttemptRefs: ['run_fixture'], reusedEvidenceRefs: [], cost: zeroCost(),
      metric: 'accuracy', validationScore: 1, validationUtility: 1, validationRows: 1, predictionsDigest: predictions },
    analysis: { artifacts: [{ path: 'pipeline.py', digest: sourceDigest, bytes: source.length, source: 'analysis_code' }],
      variants: [{ id: 'base', status: 'completed' }], formalVariantId: 'base', notes: [], workflow: { states: {} },
      harness: {}, checkpoint: digest('start'), dataset: digest('data'), toolVersion: '1', trials: 1, fits: 1, fitCalls: 1, plan: {} } })
  const start = initialCheckpoint({ researchProjectId: 'fixture', taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
    dataScopeDigest: digest('scope'), runtimeDigest, scorerDigest: digest('scorer'), validationPlanDigest: task.validationPlanDigest })
  const checkpoint = advance(start, experiment, [solution], solution.digest, digest('manifest'))
  const request = seal({ protocol: 'analysis-rollout-request@1', sequenceId: 'sequence', slotIndex: 2, planDigest: digest('plan'), task,
    harness: { commit: 'a'.repeat(40), manifestDigest: digest('harness') }, model: 'fixture', runtimeDigest,
    checkpointDigest: checkpoint.digest, checkpointRef: await store.put(checkpoint), previousRolloutReceiptDigest: digest('previous'),
    eligibleSolutionDigests: [solution.digest], allowance: { wallSeconds: 300, cpuSeconds: 300, tools: 20, tokens: null, requests: null },
    experimentWallSeconds: 100, experimentCpuSeconds: 100 })
  const producer = join(root, 'benchmark-packages/kaggle/analysis.mjs'); await mkdir(join(producer, '..'), { recursive: true })
  await writeFile(producer, `let calls = 0; export async function produceAnalysisTask({ out }) {
    if (++calls === 1) throw new Error('producer unavailable'); return { path: out, calls }; }`)
  const config = { train: join(root, 'train.csv'), predict: join(root, 'predict.csv'), publicDirectory,
    hitchRepository: root, validationPlan: {}, root, platform: 'linux/arm64', baseImage: 'fixture' }
  await writeFile(config.train, 'train'); await writeFile(config.predict, 'predict')
  const backend = new HitchBackend(store, config)
  await assert.rejects(backend.materialize(request, checkpoint), /producer unavailable/)
  const materialized = await backend.materialize(request, checkpoint)
  assert.equal(materialized.calls, 2)
  assert.deepEqual(await backend.materialize(request, checkpoint), materialized)
  const object = join(store.root, 'task-inputs', request.digest.slice(7), 'objects', sourceDigest.slice(7))
  assert.deepEqual(await readFile(object), source)
  await rm(store.path('tasks', request.digest.slice(7)))
  await chmod(object, 0o600); await writeFile(object, 'tampered')
  await assert.rejects(backend.materialize(request, checkpoint), /materialized input changed/)
})
