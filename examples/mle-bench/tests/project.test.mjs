import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectApplication } from '../../../lib/index.js'
import { bootstrap, sealHarness } from '../prepare.mjs'
import { buildProject, retainedHarness } from '../start.mjs'
import { AnalysisOperationProvider } from '../lib/operation-provider.mjs'
import { carrierForTarget, copyRegisteredTarget } from '../lib/target-source.mjs'
import { digest, defaultBudget } from '../lib/contracts.mjs'
import { Store, atomicJson } from '../lib/store.mjs'
import { command } from '../lib/common.mjs'
import { ResearchProject } from '../lib/project.mjs'
import { Backend, checkpoint, task } from './project-fixture.mjs'

test('Project + Python GEPA compares five experiments per harness, promotes and resumes without resampling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.GEAR_PROFILE_ROOT
  process.env.GEAR_PROFILE_ROOT = join(root, 'profiles')
  t.after(() => { if (previous === undefined) delete process.env.GEAR_PROFILE_ROOT; else process.env.GEAR_PROFILE_ROOT = previous })
  const target = await bootstrap(join(root, 'target-carrier'))
  const original = target.harness
  await writeFile(join(target.targetRepository, 'harness/prompts/research.md'), 'Registered general research method B.\n')
  const manifest = await sealHarness(target.targetRepository, target.dshBaseRef, original.commit)
  await command('git', ['add', 'harness'], { cwd: target.targetRepository })
  await command('git', ['commit', '--no-gpg-sign', '-m', 'Registered method B'], { cwd: target.targetRepository })
  const candidate = { commit: await command('git', ['rev-parse', 'HEAD'], { cwd: target.targetRepository }), manifestDigest: manifest.digest }
  const store = new Store(join(root, 'research')), start = checkpoint(), checkpointRef = await store.put(start)
  const project = { projectId: 'test', ...target, harness: original, task, model: 'fixture', runtime: {},
    budget: defaultBudget, modelAccounting: { mode: 'usage-only' }, projectLimits: { maxSequences: 2, cpuSeconds: 20000, wallSeconds: 20000 } }
  await atomicJson(join(root, 'project.json'), project)
  await store.save('projects', 'test', { checkpoint: checkpointRef, stage: null })
  await new ResearchProject(store, project).stage('comparison', [original, candidate])
  const built = await buildProject(root, { checkpointRef, registered: [original, candidate], stageId: 'comparison' })
  assert.equal(built.config.generation, undefined)
  assert.deepEqual(built.config.budget, { rounds: 1, max_evaluations: 2, max_candidates: 1, repetitions: 1 })
  const backends = new Map()
  const bindings = { provider: async context => {
    let backend = backends.get(context.runId)
    if (!backend) {
      backend = new Backend(store)
      const originalDeliver = backend.deliver.bind(backend), originalRollout = backend.rollout.bind(backend)
      backend.deliver = async request => { backend.quality = request.harness.commit === original.commit ? .7 : .8; return originalDeliver(request) }
      backend.rollout = async (request, history) => {
        const result = await originalRollout(request, history)
        if (request.slotIndex === 3 && !backend.lostReply) { backend.lostReply = true; throw new Error('transport lost after completed slot 3') }
        return result
      }
      backends.set(context.runId, backend)
    }
    const provider = new AnalysisOperationProvider(store, backend, project, start, built.configuration,
      { runId: context.runId, targets: join(context.stateRoot, 'runs', context.runId, 'targets') })
    return { identity: (await provider.describe()).identity, capabilities: provider.capabilities,
      submit: (r, s) => provider.submit(r, s), inspect: r => provider.inspect(r), cancel: async r => {
        assert.equal((await provider.cancel(r)).cancelled, true)
      } }
  } }
  const application = new ProjectApplication(built.cohort, bindings)
  const { runId } = await application.admitRefine()
  await assert.rejects(application.resume(runId), /transport lost/)
  assert.equal((await application.store.read(runId)).status, 'needs_recovery')
  assert.equal(backends.get(runId).calls.length, 3)
  const report = await application.resume(runId)
  assert.equal(report.status, 'completed')
  assert.equal(report.validation_mode, 'shared-set-research')
  assert.notEqual(report.retained, 'anchor')
  assert.equal(report.scores.initial.seed.score, .7)
  assert.equal(report.scores.retained.seed.score, .8)
  assert.equal((await retainedHarness(built, report)).commit, candidate.commit)
  const backend = backends.get(runId)
  assert.equal(backend.calls.length, 10)
  assert.equal(backend.deliveries, 2)
  assert.ok(backend.calls.every(c => c.request.task.protocol === 'analysis-task@2'))
  assert.ok(backend.calls.flatMap(c => c.history.history).every(e => e.protocol === 'analysis-experiment@2'))
  for (const harness of [original, candidate]) {
    const calls = backend.calls.filter(c => c.request.harness.commit === harness.commit)
    assert.deepEqual(calls.map(c => c.request.slotIndex), [1, 2, 3, 4, 5])
    assert.deepEqual(calls.map(c => c.history.history.length), [0, 1, 2, 3, 4])
  }
  const journal = await application.store.read(runId)
  assert.equal(journal.heldOutEvidence.length, 0)
  assert.equal(journal.physicalAttempts, 2)
  assert.equal(journal.operations.filter(o => o.request.operation.kind === 'evaluate_seed' && o.reservedAttempts > 0).length, 2)
  assert.equal((await application.resume(runId)).retained, report.retained)
  assert.equal(backend.calls.length, 10)
  const archive = await application.archive(runId)
  assert.ok(JSON.stringify(archive).includes('analysis-operation@1'))

  // Import a genuinely edited Project target onto the fixed carrier; the checkout stays unchanged.
  const edited = join(root, 'edited')
  await copyRegisteredTarget(target.targetRepository, original, edited)
  await writeFile(join(edited, 'prompts/research.md'), 'New general method from a Project Meta provider.\n')
  const generated = await carrierForTarget(store, project, edited, [original, candidate])
  assert.notEqual(generated.commit, original.commit)
  assert.equal(await command('git', ['rev-parse', 'HEAD'], { cwd: target.targetRepository }), candidate.commit)
  assert.deepEqual(await carrierForTarget(store, project, edited, [original, candidate]), generated)

  // Receipts are bound to resources, not merely candidate IDs.
  const evaluation = journal.operations.find(o => o.request.operation.kind === 'evaluate_seed')
  const provider = new AnalysisOperationProvider(store, backend, project, start, built.configuration,
    { runId, targets: join(built.cohort, '.gear/runs', runId, 'targets') })
  assert.equal((await provider.inspect(evaluation.request)).state, 'complete')
  const frozen = join(provider.context.targets, 'anchor/prompts/research.md')
  await chmod(frozen, 0o600); await writeFile(frozen, 'changed after admission')
  await assert.rejects(provider.inspect(evaluation.request), /target resources changed/)
  await assert.rejects(provider.submit({ ...evaluation.request, partition: 'held_out' }), /held-out/)
  await assert.rejects(provider.submit({ ...evaluation.request, repetitions: 3 }), /one seed repetition/)

  const cancelled = { ...evaluation.request, operationId: digest('cancel before submission') }
  assert.equal((await provider.cancel(cancelled)).cancelled, true)
  await assert.rejects(provider.submit(cancelled), /cancelled/)
  assert.equal(backend.calls.length, 10)
})
