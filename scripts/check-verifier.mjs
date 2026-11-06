// Frozen Python verifier policy, optionally fed by the real read-only Hitch CLI.
// All run records are synthetic; no model, daemon, or remote service is used.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { verifierFixture } from '../tests/fixtures/verifier-evidence.mjs'

const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const { builtinPolicy } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/python/builtin-policy.js')).href)
const { captureVerifiers } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/verifier.js')).href)
const { validateVerifierEvidence } = await import(pathToFileURL(join(packageRoot, 'lib/domain/verifier-evidence.js')).href)
const { validateAlgorithmWire } = await import(pathToFileURL(join(packageRoot, 'lib/domain/algorithm-schema.js')).href)
const trial = { run_id: 'run_' + 'a'.repeat(32), trial_id: 'seed__1', task_id: 'seed', attempt: 1, observation_status: 'valid', reward: 0, verifier_result_ref: 'verifier/result.json' }
const evalId = 'eval_' + 'b'.repeat(32), source = verifierFixture(trial, evalId)
const project = source => builtinPolicy('verifier_project', { source, trial, eval_id: evalId })
const value = project(source)
validateAlgorithmWire('VerifierObservation', value)
validateVerifierEvidence({ candidate_id: 'c', task_id: 'seed', repetition: 0, status: 'valid', score: 0, verifier: value })
assert.equal(value.primary_score, 0)
assert.equal(value.process.score, 0.5)
assert.deepEqual(value.failure_codes, ['missing-check'])
assert(!JSON.stringify(value).includes('PRIVATE_VERIFIER'))
assert.equal(project({ ...source, run_id: 'run_' + 'c'.repeat(32) }).status, 'invalid')
const summary = builtinPolicy('objective_project', {
  candidate_id: 'c', task_ids: ['seed'], repetitions: 1,
  evidence: [{ candidate_id: 'c', task_id: 'seed', repetition: 0, status: 'valid', score: 0, verifier: value }],
  objective: null,
})
assert.equal(summary.verifier.process_metrics[0].value, 0.5)
assert.equal(summary.score, 0)

if (process.env.GEAR_TEST_HITCH) {
  const root = await mkdtemp(join(tmpdir(), 'gear-verifier-real-'))
  const directory = join(root, 'runs', trial.run_id)
  const write = async (path, value) => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }
  try {
    const now = new Date().toISOString(), digest = 'sha256:' + 'a'.repeat(64)
    await write(join(directory, 'request.json'), {})
    await write(join(directory, 'resolution.json'), {})
    await write(join(directory, 'result.json'), { run_id: trial.run_id, status: 'succeeded' })
    await write(join(directory, 'manifest.json'), {
      schema_version: '1', run_id: trial.run_id,
      context: { kind: 'benchmark_task', benchmark_id: 'synthetic', benchmark_revision: '1', task_id: 'seed', task_digest: digest, verifier_identity: digest },
      parent: { kind: 'eval', ...source.parent }, status: 'succeeded',
      harness: { harness_id: 'deepseek', requested_ref: 'deepseek@version:0.1.1-rc.2', revision_identity: digest },
      model: { requested_id: 'synthetic', effective_id: 'synthetic', identity_resolved: false },
      protocol: { timeout_ms: 1000, workspace_mode: 'shared' }, observation: source.observation,
      request_ref: 'request.json', resolution_ref: 'resolution.json', result_ref: 'result.json', created_at: now, completed_at: now, sealed: true,
    })
    for (const name of ['result', 'process', 'feedback']) await write(join(directory, 'verifier', name + '.json'), source.verifier[name])
    await write(join(root, 'evals', evalId, 'result.json'), { schema_version: '1', eval_id: evalId, trials: [trial] })
    const capture = async () => (await captureVerifiers(process.env.GEAR_TEST_HITCH, root, true, { eval_id: evalId, trials: [trial] }, 0, new AbortController().signal))[0]
    const real = await capture()
    assert.equal(real.observation.status, 'available', JSON.stringify(real))
    assert.equal(real.observation.process.score, 0.5)
    assert.equal(real.observation.primary_score, 0)
    assert.deepEqual(real.observation.failure_codes, ['missing-check'])
    await write(join(directory, 'verifier/process.json'), { ...source.verifier.process, score: 1 })
    const corrupt = await capture()
    assert.equal(corrupt.observation.status, 'invalid')
    assert.equal(corrupt.observation.process, null)
  } finally { await rm(root, { recursive: true, force: true }) }
}
console.log(JSON.stringify({ installedPythonProjection: true, independentProcessScore: true, validPrimaryZero: true, boundedPublicDiagnosis: true, wrongRunRejected: true, realHitch: Boolean(process.env.GEAR_TEST_HITCH), modelCalls: 0 }))
