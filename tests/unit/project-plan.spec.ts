import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { ProjectController } from '../../src/application/project-controller.js'
import { resolveProject } from '../../src/application/project-config.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { RunPlan } from '../../src/application/run-plan.js'
import type { OperationRequest, OperationReceipt } from '../../src/ports/operations.js'
import { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { fixtureRuntime } from '../helpers/hitch-runtime-fixture.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  vi.stubEnv('GEAR_PYTHON', process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3')
  const root = await mkdtemp(join(tmpdir(), 'gear-plan-'))
  roots.push(root)
  const project = join(root, 'project')
  await initProject(project)
  const calls: OperationRequest[] = [],
    receipts = new Map<string, OperationReceipt>()
  const state = {
    target: canonicalDigest('target-v1'),
    meta: canonicalDigest('meta-v1'),
    invalid: false,
    driverCalls: 0,
  }
  const app = new ProjectApplication(project, {
    async provider(context) {
      return {
        identity: context.kind === 'evaluate' ? state.target : canonicalDigest([state.target, state.meta]),
        evaluationIdentity: state.target,
        capabilities: {
          seeds: true,
          temperature: true,
          subsets: true,
          idempotentSubmission: true,
          inspect: true,
          cancel: true,
          physicalAttemptAccounting: true,
          generationBudget: false,
          hardDollarBudget: false,
          evidenceProjection: false,
        },
        async submit(request) {
          calls.push(structuredClone(request))
          expect(request.operation.kind).toBe('evaluate_seed')
          const invalid = state.invalid && !request.repair
          const receipt: OperationReceipt = {
            result: {
              operation_id: request.operationId,
              kind: 'evaluate_seed',
              status: 'complete',
              candidate_id: request.operation.candidate_id,
              data: null,
            },
            candidate: null,
            provenance: { seed_source: true },
            physicalAttempts: request.slots.length,
            usage: { model_requests: request.slots.length, tokens: 10 * request.slots.length, dollars: null },
            evidence: request.slots.map((slot) => ({
              candidate_id: request.operation.candidate_id!,
              task_id: slot.taskId,
              repetition: slot.repetition,
              score: invalid ? null : 0,
              status: invalid ? 'environment_failed' : 'valid',
              scope: request.operation.scope,
              feedback: 'seed feedback',
            })),
          }
          receipts.set(request.operationId, receipt)
          return receipt
        },
        async inspect(request) {
          const receipt = receipts.get(request.operationId)
          return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
        },
        async cancel() {},
      }
    },
    async driver() {
      return {
        async step(view, algorithmState) {
          state.driverCalls++
          return {
            state: algorithmState,
            reason: 'baseline then stop fixture',
            operations: [
              {
                kind: view.step_id === 0 ? ('evaluate_seed' as const) : ('stop' as const),
                candidate_id: view.step_id === 0 ? view.anchor_id : null,
                parent_id: null,
                task_ids: view.step_id === 0 ? view.tasks.map((task) => task.id) : [],
                scope: 'global',
                rationale: 'baseline fixture',
                payload: null,
              },
            ],
          }
        },
      }
    },
  })
  const configure = async (patch: Record<string, unknown>) => {
    const { config } = await resolveProject(project)
    await writeFile(join(project, 'gear.yaml'), JSON.stringify({ ...config, ...patch }))
  }
  await configure({ evaluation: { repair: { max_retries: 0, max_projections: 0, backoff_ms: [0] } } })
  return { app, project, calls, state, configure, controller: new ProjectController(app) }
}

it('previews scope and both budgets without admitting a run, executing a provider, or calling an algorithm', async () => {
  const { app, controller, calls, state } = await fixture()
  const plan = (await controller.call('run.plan', { rounds: 3 })) as RunPlan
  expect(plan).toMatchObject({
    state: 'preview',
    run_id: null,
    limits: { rounds: 3, physical_trial_attempts: 40 },
    tasks: { seed: ['sum-01', 'sum-02'], held_out_count: 2 },
    baseline: { logical_slots: 2, reusable_slots: 0, new_physical_trials: 2 },
    final_gate: { physical_trials_for_anchor_and_nominee: 4 },
    ready_for_submission: true,
  })
  expect(calls).toHaveLength(0)
  expect(state.driverCalls).toBe(0)
  expect(plan.limits.timeouts.provider).toBeNull()
  expect(plan.limits.timeouts.task_declarations).toEqual({
    unit: 'seconds',
    runtime: 'harbor',
    groups: [
      {
        partition: 'seed',
        count: 2,
        deadlines: {
          agent_seconds: 600,
          verifier_seconds: 60,
          environment_build_seconds: 600,
          verifier_build_seconds: 600,
        },
      },
      {
        partition: 'held_out',
        count: 2,
        deadlines: {
          agent_seconds: 600,
          verifier_seconds: 60,
          environment_build_seconds: 600,
          verifier_build_seconds: 600,
        },
      },
    ],
  })
  expect(plan.limits.timeouts.run_deadline_configured).toBe(false)
  await expect(readdir(join(app.store.root, 'runs'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(plan)).not.toContain('expected')
  for (const params of [{ round: 1 }, { rounds: 0 }])
    await expect(controller.invoke('run.plan', params)).rejects.toBeInstanceOf(Error)
})

it('reuses only a smoke slot, retains its valid zero, separates historical usage, and emits the frozen plan before submission', async () => {
  const { app, controller, calls } = await fixture()
  const smoke = await app.evaluate({ split: 'seed', limit: 1 })
  let shown: RunPlan | undefined
  const result = (await controller.invoke(
    'run.refine',
    {},
    {
      onPlan: async (plan) => {
        shown = plan
        expect(calls).toHaveLength(1)
        const journal = await app.store.read(plan.run_id!)
        expect(journal.operations).toHaveLength(0)
        expect(journal.seedEvidence).toHaveLength(1)
        expect(plan.baseline).toMatchObject({
          reusable_slots: 1,
          new_physical_trials: 1,
          source: { run_id: smoke.run_id },
        })
      },
    },
  )) as Awaited<ReturnType<ProjectApplication['refine']>>
  expect(result.plan).toEqual(shown)
  expect(calls).toHaveLength(2)
  expect(calls[1]!.slots).toEqual([{ taskId: 'sum-02', repetition: 0 }])
  expect(result.coverage).toMatchObject({ logical_slots: 2, valid_zero: 2, physical_attempts: 1 })
  expect(result.usage).toMatchObject({ model_requests: 1, tokens: 10 })
  expect(result.baseline_reuse).toMatchObject({
    source_run_id: smoke.run_id,
    new_physical_attempts: 0,
    historical_usage: { physical_attempts: 1, usage: { model_requests: 1, tokens: 10 } },
  })
  expect((await app.store.read(result.run_id)).heldOutEvidence).toEqual([])
  const exported = await app.export(result.run_id)
  expect(JSON.parse(await readFile(join(exported.destination, 'baseline-source.json'), 'utf8')).runId).toBe(
    smoke.run_id,
  )
})

it('allows Meta changes without discarding Target evidence, and full reuse consumes no new physical budget', async () => {
  const { app, state, calls, configure } = await fixture()
  await app.evaluate({ split: 'seed' })
  state.meta = canonicalDigest('different-meta')
  await configure({ budget: { rounds: 1, max_evaluations: 1, max_candidates: 1, repetitions: 1 } })
  const plan = await app.previewRefine()
  expect(plan.baseline.reusable_slots).toBe(2)
  const result = await app.refine()
  expect(result.coverage.physical_attempts).toBe(0)
  expect(result.usage).toMatchObject({ model_requests: 0, tokens: 0 })
  expect(calls).toHaveLength(1)
})

it.each([
  'target-runtime',
  'target-content',
  'benchmark',
  'invalid',
  'held-out',
  'unfinished',
  'corrupt-source',
])('does not reuse incompatible or unverified evidence: %s', async (change) => {
  const { app, state, project } = await fixture()
  if (change === 'invalid') state.invalid = true
  const previous = await app.evaluate({ split: change === 'held-out' ? 'held_out' : 'seed', limit: 1 })
  if (change === 'target-runtime') state.target = canonicalDigest('other-target')
  if (change === 'target-content')
    await writeFile(join(project, 'target/prompts/system.md'), 'new target policy')
  if (change === 'benchmark') {
    const path = join(project, 'tasks.csv')
    const previous = await readFile(path, 'utf8'),
      changed = previous.replace('2 plus 3', '1 plus 4')
    expect(changed).not.toBe(previous)
    await writeFile(path, changed)
  }
  if (change === 'unfinished') {
    const journal = await app.store.read(previous.run_id)
    journal.status = 'needs_recovery'
    await app.store.write(journal)
  }
  if (change === 'corrupt-source')
    await writeFile(join(app.store.root, 'runs', previous.run_id, 'journal.json'), '{}')
  const plan = await app.previewRefine()
  expect(plan.baseline.reusable_slots).toBe(0)
  expect(plan.baseline.new_physical_trials).toBe(2)
})

it('keeps raw identity independent of objective weights and caps reuse to the requested repetitions', async () => {
  const { app, configure } = await fixture()
  await app.evaluate({ split: 'seed', limit: 1 })
  await configure({
    objective: { terms: [{ metric: 'pass_rate', weight: 2 }] },
    budget: { rounds: 1, max_evaluations: 40, max_candidates: 2, repetitions: 2 },
  })
  expect((await app.previewRefine()).baseline).toMatchObject({
    reusable_slots: 1,
    logical_slots: 4,
    new_physical_trials: 3,
  })
})

it('freezes reused observations/provenance before execution and does not depend on mutable history at resume', async () => {
  const { app, project, calls } = await fixture()
  const smoke = await app.evaluate({ split: 'seed', limit: 1 })
  const { runId } = await app.admitRefine()
  await rm(join(app.store.root, 'runs', smoke.run_id), { recursive: true })
  await writeFile(join(project, 'gear.yaml'), 'changed after admission')
  const result = await app.resume(runId)
  expect(result.plan?.baseline.reusable_slots).toBe(1)
  expect(result.coverage.physical_attempts).toBe(1)
  expect(calls).toHaveLength(2)
})

it('refuses damaged frozen provenance before provider submission', async () => {
  const { app, calls } = await fixture()
  await app.evaluate({ split: 'seed', limit: 1 })
  const { runId } = await app.admitRefine()
  await writeFile(join(app.store.root, 'runs', runId, 'baseline-source.json'), '{}')
  await expect(app.resume(runId)).rejects.toMatchObject({ code: 'baseline-source-unavailable' })
  expect(calls).toHaveLength(1)
})

it('reports an unaffordable baseline without execution and rejects its admission', async () => {
  const { app, configure, calls } = await fixture()
  await configure({ budget: { rounds: 1, max_evaluations: 1, max_candidates: 1, repetitions: 1 } })
  expect(await app.previewRefine()).toMatchObject({
    ready_for_submission: false,
    warnings: ['baseline-unaffordable'],
  })
  await expect(app.admitRefine()).rejects.toMatchObject({ code: 'budget-baseline-unaffordable' })
  expect(calls).toHaveLength(0)
})

it('reuses repaired observations with the original and repair attempts retained as historical cost', async () => {
  const { app, state, configure, calls } = await fixture()
  state.invalid = true
  await configure({ evaluation: { repair: { max_retries: 1, max_projections: 0, backoff_ms: [0] } } })
  const smoke = await app.evaluate({ split: 'seed', limit: 1 })
  expect(smoke.coverage.physical_attempts).toBe(2)
  state.invalid = false
  const refined = await app.refine()
  expect(refined.baseline_reuse).toMatchObject({
    source_run_id: smoke.run_id,
    historical_usage: { physical_attempts: 2, usage: { tokens: 20 } },
  })
  expect(refined.coverage.physical_attempts).toBe(1)
  expect(calls).toHaveLength(3)
})

it.each(['unmetered', 'receipt-binding', 'receipt-slot', 'missing-receipt'])(
  'rejects damaged source receipts even when a journal checksum is recomputed: %s',
  async (change) => {
    const { app } = await fixture()
    const source = await app.evaluate({ split: 'seed', limit: 1 })
    const journal = await app.store.read(source.run_id)
    const receipt = journal.operations[0]!.receipt!
    if (change === 'unmetered') receipt.physicalAttempts = 0
    if (change === 'receipt-binding') receipt.result.kind = 'generate_candidate'
    if (change === 'receipt-slot') journal.operations[0]!.request.slots[0]!.repetition = 5
    if (change === 'missing-receipt') delete journal.operations[0]!.receipt
    await app.store.write(journal)
    expect((await app.previewRefine()).baseline.reusable_slots).toBe(0)
  },
)

it('binds frozen proof to execution conditions and historical accounting even if file digests are recomputed', async () => {
  const { app, calls } = await fixture()
  await app.evaluate({ split: 'seed', limit: 1 })
  const { runId } = await app.admitRefine()
  const path = join(app.store.root, 'runs', runId, 'baseline-source.json')
  const proof = JSON.parse(await readFile(path, 'utf8'))
  proof.conditions.seed = 'different execution seed'
  await writeFile(path, JSON.stringify(proof))
  const journal = await app.store.read(runId)
  journal.spec.baseline!.sourceDigest = canonicalDigest(proof)
  journal.specDigest = canonicalDigest(journal.spec)
  await app.store.write(journal)
  await expect(app.resume(runId)).rejects.toMatchObject({ code: 'baseline-source-unavailable' })
  expect(calls).toHaveLength(1)
})

it.each(['artifact', 'environment'])('reuses a baseline only while the pre-admission Hitch %s binding remains identical', async (changed) => {
  const { app, state } = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'gear-baseline-artifact-')); roots.push(root)
  const executable = join(root, 'hitch.mjs'), remote = join(root, 'remote.json')
  await writeFile(executable, `#!${process.execPath}\nimport {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};runOrderedHitchFixture('${canonicalDigest('revision')}');`, { mode: 0o700 })
  const profile = { kind: 'hitch' as const, executable, root, harnessRef: 'deepseek@version:0.1.1-rc.2', model: 'unused', baseImage: 'image@' + canonicalDigest('image'), passEnv: [], timeoutMs: 1000 }
  const context = { directory: join(root, 'submissions'), targets: join(root, 'targets'), adapter: new DshHarnessAdapter(), implementationIdentity: canonicalDigest('adapter'), taskIds: ['sum-01', 'sum-02'], runtime: fixtureRuntime, async compile() {} }
  state.target = (await HitchOperationProvider.connect(profile, context)).identity
  await app.evaluate({ split: 'seed', limit: 1 })
  state.target = (await HitchOperationProvider.connect(profile, context)).identity
  expect((await app.previewRefine()).baseline.reusable_slots).toBe(1)
  await writeFile(remote, JSON.stringify(changed === 'artifact'
    ? { preparedArtifactId: canonicalDigest('new-dependency-closure') }
    : { environmentBinding: 'hmac-sha256:' + 'e'.repeat(64) }))
  state.target = (await HitchOperationProvider.connect(profile, context)).identity
  expect((await app.previewRefine()).baseline.reusable_slots).toBe(0)
}, 60_000)
