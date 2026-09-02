import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import type { EvaluationRequest, RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { evaluationCondition, roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, commit: string, digest: string): RefinementRound {
  return roundFixture({ workspaceRoot: root, status: 'baseline-running', targetHarnessRef: commit, targetHarnessDigest: digest })
}

function request(dataset: string, harnessRef: string): EvaluationRequest {
  return { phase: 'seed-baseline', dataset, harnessRef, condition: evaluationCondition('seed', dataset) }
}

interface InspectFixture {
  attempts?: number
  tasks?: string[]
  trials?: Array<{ taskId: string; attempt: number }>
  dataset?: string
  planDataset?: string
  planCommit?: string
  planBenchmarkRevision?: string
  attemptExecution?: string | null
  invalidTrials?: Array<{ taskId: string; attempt: number }>
}

async function setup(version = '0.2.5', inspectFixture: InspectFixture = {}) {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const executable = join(fixture.root, 'fake-hitch.mjs')
  const inspectedAttempts = inspectFixture.attempts ?? 1
  const inspectedTasks = inspectFixture.tasks ?? ['task-1']
  const inspectedTrials = inspectFixture.trials ?? [{ taskId: 'task-1', attempt: 1 }]
  const inspectedInvalidTrials = inspectFixture.invalidTrials ?? []
  const inspectedDataset = inspectFixture.dataset ?? 'seed'
  const planDataset = inspectFixture.planDataset ?? inspectedDataset
  const planCommit = inspectFixture.planCommit ?? fixture.championRef
  const planBenchmarkRevision = inspectFixture.planBenchmarkRevision ?? 'revision-1'
  const attemptExecution = inspectFixture.attemptExecution === undefined
    ? "attempt_execution: 'harbor-attempt-shards-v1',"
    : inspectFixture.attemptExecution === null ? '' : `attempt_execution: ${JSON.stringify(inspectFixture.attemptExecution)},`
  const requestedHarnessRef = `deepseek@git+${pathToFileURL(fixture.repository).href}#${fixture.championRef}`
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const dataset = value('--dataset')
const harness = value('--harness')
const evalId = args.includes('--eval-id') ? value('--eval-id') : 'eval_' + '1'.repeat(32)
const commit = harness?.match(/#([0-9a-f]{40,64})$/)?.[1]
const inspectedTrials = ${JSON.stringify(inspectedTrials)}
const inspectedInvalidTrials = ${JSON.stringify(inspectedInvalidTrials)}
const isInvalidTrial = trial => inspectedInvalidTrials.some(slot => slot.taskId === trial.taskId && slot.attempt === trial.attempt)
const remainingInvalidTasks = [...new Set(inspectedInvalidTrials.map(slot => slot.taskId))]
if (args[0] === '--version') process.stdout.write(${JSON.stringify(version)} + '\\n')
else if (args[0] === 'trajectory' && args[1] === 'inspect') {
  const runId = args[2]
  process.stdout.write(JSON.stringify({
    schema_version: '1', run_id: runId,
    ref: { schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek', files: [] },
    header: { type: 'session', version: 1, id: 'session-1', createdAt: 1, delegationDepth: 0 },
    events: [
      { type: 'tool/result', seq: 0, time: 10, data: { message: { content: [{ isError: true }] } } },
      { type: 'assistant/message', seq: 1, time: 11, data: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1 } },
    ],
  }) + '\\n')
} else if (args[0] === 'verifier' && args[1] === 'inspect') {
  const runId = args[2]
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'verifier-evidence', run_id: runId,
    parent: { eval_id: 'eval_' + '1'.repeat(32), trial_id: 'trial-1', attempt: 1 },
    observation: { status: 'valid', reward: 0, verifier_result_ref: 'verifier/result.json' },
    verifier: {
      status: 'complete', result: { rewards: { reward: 0 } }, result_sha256: 'sha256:' + '8'.repeat(64),
      diagnostics: { stdout: [{
        name: 'test-stdout.txt', media_type: 'text/plain', bytes: 16,
        sha256: 'sha256:' + '9'.repeat(64), truncated: false, text: 'assertion failed',
      }] },
    },
    redactions: [{ rule_id: 'absolute-path-v1', count: 2 }],
  }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'rerun') {
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'eval-rerun', rerun_id: 'rerun_' + '9'.repeat(32), eval_id: args[2], status: 'completed',
    selected_tasks: args.includes('--invalid') ? ['task-1'] : args.flatMap((arg, index) => arg === '--task' ? [args[index + 1]] : []),
    repaired_tasks: inspectedInvalidTrials.length === 0 ? ['task-1'] : [],
    remaining_invalid_tasks: remainingInvalidTasks,
    eval_status: inspectedInvalidTrials.length === 0 ? 'succeeded' : 'failed',
    selected_trials: [{ task_id: 'task-1', attempt: 1 }],
    repaired_trials: inspectedInvalidTrials.length === 0 ? [{ task_id: 'task-1', attempt: 1 }] : [],
    remaining_invalid_trials: inspectedInvalidTrials.map(slot => ({ task_id: slot.taskId, attempt: slot.attempt })),
  }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'inspect') {
  const inspectedEvalId = args[2]
  const actual = ${JSON.stringify(fixture.championRef)}
  process.stdout.write(JSON.stringify({
    schema_version: '1', eval_id: inspectedEvalId,
    request: { schema_version: '1', backend: 'harbor', dataset: ${JSON.stringify(inspectedDataset)},
      harness_ref: ${JSON.stringify(requestedHarnessRef)}, model: 'deepseek-chat', attempts: ${JSON.stringify(inspectedAttempts)},
      benchmark_id: 'benchmark-1', benchmark_revision: 'revision-1' },
    plan: { schema_version: '1', eval_id: inspectedEvalId,
      backend: 'harbor', dataset: ${JSON.stringify(planDataset)}, benchmark_id: 'benchmark-1',
      benchmark_revision: ${JSON.stringify(planBenchmarkRevision)}, attempts: ${JSON.stringify(inspectedAttempts)},
      ${attemptExecution} tasks: ${JSON.stringify(inspectedTasks)},
      candidate: { requested_harness_ref: ${JSON.stringify(requestedHarnessRef)},
        harness_ref: 'deepseek@commit:' + ${JSON.stringify(planCommit)}, harness_id: 'deepseek',
        revision_identity: 'sha256:' + '2'.repeat(64) } },
    result: {
      schema_version: '1', eval_id: inspectedEvalId,
      status: inspectedInvalidTrials.length === 0 ? 'succeeded' : 'failed',
      exit_code: inspectedInvalidTrials.length === 0 ? 0 : 1,
      candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
      dataset: ${JSON.stringify(inspectedDataset)},
      trials: inspectedTrials.map((trial, index) => ({
        trial_id: 'trial-' + (index + 1), run_id: 'run_' + String(index + 5).repeat(32).slice(0, 32),
        task_id: trial.taskId, attempt: trial.attempt,
        observation_status: isInvalidTrial(trial) ? 'invalid' : 'valid',
        ...(isInvalidTrial(trial) ? { invalid_reason: 'infrastructure_failure' } : { reward: 1 }),
        verifier_result_ref: 'verifier/result.json',
      })),
      summary: { n_trials: inspectedTrials.length,
        n_completed: inspectedTrials.length - inspectedInvalidTrials.length,
        n_invalid: inspectedInvalidTrials.length,
        primary_reward: inspectedTrials.length === inspectedInvalidTrials.length ? null : 1,
        rewards: { reward: { count: inspectedTrials.length - inspectedInvalidTrials.length, mean: 1 } } },
      local_source_transport: { kind: 'local-git-commit', resolution_identity: 'sha256:' + '2'.repeat(64),
        commit: actual, tree: '3'.repeat(40), payload_sha256: 'sha256:' + '4'.repeat(64), payload_bytes: 100 },
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    },
  }) + '\\n')
} else if (dataset === 'slow') setTimeout(() => {}, 30000)
else if (dataset === 'invalid-json') process.stdout.write('not-json\\n')
else {
  const actual = dataset === 'mismatch' ? 'f'.repeat(40) : commit
  const legacy = dataset === 'legacy'
  const invalidRun = dataset === 'invalid-run' || inspectedInvalidTrials.length > 0
  const failedCompleteRun = dataset === 'failed-complete-run'
  const runTrials = dataset === 'invalid-run'
    ? [{ trial_id: 'trial-1', run_id: 'run_' + '5'.repeat(32), task_id: 'task-1',
        attempt: 1, observation_status: 'invalid', invalid_reason: 'infrastructure_failure',
        verifier_result_ref: 'verifier/result.json' }]
    : inspectedTrials.map((trial, index) => ({
        trial_id: 'trial-' + (index + 1), run_id: 'run_' + String(index + 5).repeat(32).slice(0, 32),
        task_id: trial.taskId, attempt: trial.attempt,
        observation_status: isInvalidTrial(trial) ? 'invalid' : 'valid',
        ...(isInvalidTrial(trial) ? { invalid_reason: 'infrastructure_failure' } : { reward: 1 }),
        verifier_result_ref: 'verifier/result.json',
      }))
  const validCount = runTrials.filter(trial => trial.observation_status === 'valid').length
  const invalidCount = runTrials.length - validCount
  process.stdout.write(JSON.stringify({
    schema_version: '1', eval_id: evalId,
    status: invalidRun || failedCompleteRun ? 'failed' : 'succeeded',
    exit_code: invalidRun || failedCompleteRun ? 13 : 0,
    candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
    dataset,
    ...(legacy ? {} : { trials: runTrials }),
    summary: legacy
      ? { n_trials: 1, n_completed: 1, n_errored: 0, n_cancelled: 0, primary_reward: 1,
          trials: [{ task_name: 'task-1', trial_name: 'trial-1', status: 'completed', rewards: { reward: 1 } }] }
      : { n_trials: runTrials.length, n_completed: validCount, n_invalid: invalidCount,
          primary_reward: validCount === 0 ? null : 1, rewards: { reward: { count: validCount, mean: validCount === 0 ? null : 1 } } },
    local_source_transport: { kind: 'local-git-commit', resolution_identity: 'sha256:' + '2'.repeat(64),
      commit: actual, tree: '3'.repeat(40), payload_sha256: 'sha256:' + '4'.repeat(64), payload_bytes: 100 },
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  }) + '\\n')
  if (invalidRun || failedCompleteRun) process.exitCode = 13
}
`)
  await chmod(executable, 0o755)
  const evaluator = new HitchCliEvaluator({
    executable,
    harnessId: 'deepseek',
    root: '',
    model: 'deepseek-chat',
    attempts: 1,
    maxConcurrent: 2,
    setupTimeoutMs: 10_000,
    terminationGraceMs: 100,
    maxOutputBytes: 1024 * 1024,
    maxTrajectoryOutputBytes: 1024 * 1024,
    sampling: {},
    agentArgs: [],
    passEnv: [],
    repositoryPath: fixture.repository,
  })
  return { fixture, evaluator }
}

describe('HitchCliEvaluator', () => {
  it('requires stable eval identity support from agent-hitch 0.2.5 or newer', async () => {
    const supported = await setup('0.2.5')
    const state = round(supported.fixture.root, supported.fixture.championRef, supported.fixture.manifest.digest)
    const input = request('seed', supported.fixture.championRef)
    const identity = await supported.evaluator.evaluationIdentity(state, input)
    await expect(supported.evaluator.preflight()).resolves.toBeUndefined()
    expect(await supported.evaluator.evaluationIdentity(state, input)).toEqual(identity)
    const old = await setup('0.2.4')
    await expect(old.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const prerelease = await setup('0.2.5-rc.1')
    await expect(prerelease.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const laterPrerelease = await setup('0.2.6-rc.1')
    await expect(laterPrerelease.evaluator.preflight()).resolves.toBeUndefined()
    const malformed = await setup('not-a-version')
    await expect(malformed.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
  })

  it('keeps semantic identity independent of environment, workspace, and executable location', async () => {
    const { fixture, evaluator } = await setup('0.2.5')
    const environmentName = `GEAR_HITCH_IDENTITY_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
    evaluator.options.passEnv.push(environmentName)
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    process.env[environmentName] = 'first-value'
    try {
      await evaluator.preflight()
      const first = await evaluator.evaluationIdentity(state, input)

      process.env[environmentName] = 'second-value'
      expect(await evaluator.evaluationIdentity(state, input)).toEqual(first)

      process.env[environmentName] = 'first-value'
      expect(await evaluator.evaluationIdentity(
        { ...state, workspaceRoot: join(fixture.root, 'other-workspace') }, input,
      )).toEqual(first)

      const relocatedExecutable = join(fixture.root, 'relocated-hitch.mjs')
      await copyFile(evaluator.options.executable, relocatedExecutable)
      await chmod(relocatedExecutable, 0o755)
      const relocated = new HitchCliEvaluator({
        ...evaluator.options,
        executable: relocatedExecutable,
        passEnv: [...evaluator.options.passEnv],
      })
      expect(await relocated.evaluationIdentity(state, input)).toEqual(first)

      await appendFile(evaluator.options.executable, '\n// same semver, different build\n')
      expect((await evaluator.evaluationIdentity(state, input)).effectiveConfigDigest).not.toBe(first.effectiveConfigDigest)
    } finally {
      delete process.env[environmentName]
    }
  })

  it('revalidates the Hitch version after same-instance executable replacement', async () => {
    const { fixture, evaluator } = await setup('0.2.5')
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    await expect(evaluator.evaluationIdentity(state, input)).resolves.toBeDefined()

    await writeFile(evaluator.options.executable, '#!/usr/bin/env node\nprocess.stdout.write("0.2.4\\n")\n')
    await expect(evaluator.evaluationIdentity(state, input))
      .rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    await expect(evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
  })

  it('runs the absolute executable resolved during preflight when the evaluation cwd differs', async () => {
    const { fixture, evaluator } = await setup()
    const evaluationWorkspace = join(fixture.root, 'workspace', 'nested')
    await mkdir(evaluationWorkspace, { recursive: true })
    const relativeEvaluator = new HitchCliEvaluator({
      ...evaluator.options,
      executable: '../fake-hitch.mjs',
      passEnv: [...evaluator.options.passEnv],
    })
    const state = round(evaluationWorkspace, fixture.championRef, fixture.manifest.digest)
    await expect(relativeEvaluator.evaluate(
      state,
      request('seed', fixture.championRef),
      new AbortController().signal,
    )).resolves.toMatchObject({ requestedCommit: fixture.championRef, actualCommit: fixture.championRef })
  })

  it('invokes Hitch CLI and validates exact local commit transport evidence', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const evidence = await evaluator.evaluate(
      state,
      input,
      new AbortController().signal,
    )
    const identity = await evaluator.evaluationIdentity(state, input)
    expect(evidence).toMatchObject({
      provider: identity.provider,
      effectiveConfigDigest: identity.effectiveConfigDigest,
      invocationFingerprint: identity.invocationFingerprint,
      dataset: 'seed', requestedCommit: fixture.championRef, actualCommit: fixture.championRef,
      primaryReward: 1, summary: { total: 1, passed: 1, failed: 0 },
      trials: [{ runId: `run_${'5'.repeat(32)}`, attempt: 1 }],
      localSourceTransport: { commit: fixture.championRef },
    })
  })

  it('reserves a Hitch eval id and binds the invocation/result to it', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    expect(reservation).toMatchObject({ provider: 'hitch-cli', evalId: expect.stringMatching(/^eval_[0-9a-f]{32}$/u) })
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).resolves.toMatchObject({
      provider: reservation.provider,
      evalId: reservation.evalId,
    })
  })

  it.each([
    ['missing', [{ taskId: 'task-1', attempt: 1 }], /missing frozen logical slots: task-1#2/u],
    ['duplicate', [{ taskId: 'task-1', attempt: 1 }, { taskId: 'task-1', attempt: 1 }], /duplicate logical slot: task-1#1/u],
    ['out-of-range', [{ taskId: 'task-1', attempt: 1 }, { taskId: 'task-1', attempt: 3 }], /outside frozen range 1\.\.2: task-1#3/u],
  ] as Array<[string, Array<{ taskId: string; attempt: number }>, RegExp]>)(
    'rejects succeeded multi-attempt evidence with %s slots',
    async (_case, trials, message) => {
      const { fixture, evaluator } = await setup('0.2.5', { attempts: 2, tasks: ['task-1'], trials })
      const input = request('seed', fixture.championRef)
      input.condition = { ...input.condition, repetitions: 2 }
      await expect(evaluator.evaluate(
        round(fixture.root, fixture.championRef, fixture.manifest.digest),
        input,
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'invalid_hitch_result', message: expect.stringMatching(message) })
    },
  )

  it.each([
    ['missing', ['task-1', 'task-2'], [{ taskId: 'task-1', attempt: 1 }], /missing frozen logical slots: task-2#1/u],
    ['duplicate', ['task-1'], [{ taskId: 'task-1', attempt: 1 }, { taskId: 'task-1', attempt: 1 }], /duplicate logical slot: task-1#1/u],
    ['out-of-range', ['task-1'], [{ taskId: 'task-1', attempt: 2 }], /outside frozen range 1\.\.1: task-1#2/u],
  ] as Array<[string, string[], Array<{ taskId: string; attempt: number }>, RegExp]>)(
    'rejects succeeded single-attempt evidence with %s slots',
    async (_case, tasks, trials, message) => {
      const { fixture, evaluator } = await setup('0.2.5', { attempts: 1, tasks, trials })
      await expect(evaluator.evaluate(
        round(fixture.root, fixture.championRef, fixture.manifest.digest),
        request('seed', fixture.championRef),
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'invalid_hitch_result', message: expect.stringMatching(message) })
    },
  )

  it.each([
    ['dataset', { planDataset: 'another-dataset' }, /request and plan dataset identity differ/u],
    ['benchmark revision', { planBenchmarkRevision: 'another-revision' }, /request and plan dataset identity differ/u],
    ['candidate commit', { planCommit: 'f'.repeat(40) }, /plan candidate commit differs/u],
  ] as Array<[string, InspectFixture, RegExp]>)('rejects a frozen plan with mismatched %s identity', async (_case, inspect, message) => {
    const { fixture, evaluator } = await setup('0.2.5', inspect)
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'invalid_hitch_result', message: expect.stringMatching(message) })
  })

  it('rejects multi-attempt evidence without an explicit execution identity', async () => {
    const { fixture, evaluator } = await setup('0.2.5', {
      attempts: 2,
      tasks: ['task-1'],
      trials: [{ taskId: 'task-1', attempt: 1 }, { taskId: 'task-1', attempt: 2 }],
      attemptExecution: null,
    })
    const input = request('seed', fixture.championRef)
    input.condition = { ...input.condition, repetitions: 2 }
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      input,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'invalid_hitch_result',
      message: expect.stringMatching(/no stable logical-attempt identity/u),
    })
  })

  it('reruns invalid tasks under the original eval id and loads repaired evidence', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const evalId = `eval_${'7'.repeat(32)}`
    await expect(evaluator.rerun(state, input, {
      provider: 'hitch-cli', evalId, phase: 'seed-baseline',
      owner: { candidateId: `champion-${fixture.championRef}`, role: 'baseline', harnessRef: fixture.championRef },
      conditionId: input.condition.conditionId, dataset: input.dataset,
      requestedModelId: input.condition.model, requestedCommit: fixture.championRef,
      status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      failure: { code: 'hitch_infrastructure_failure', message: 'invalid task' },
    }, { mode: 'invalid' }, new AbortController().signal)).resolves.toMatchObject({
      provider: 'hitch-cli', evalId, selectedTasks: ['task-1'], repairedTasks: ['task-1'],
      selectedTrials: [{ taskId: 'task-1', attempt: 1 }],
      repairedTrials: [{ taskId: 'task-1', attempt: 1 }], remainingInvalidTrials: [],
      remainingInvalidTasks: [], evalStatus: 'succeeded', evidence: { evalId, primaryReward: 1 },
    })
  })

  it('returns inspectable partial evidence when rerun leaves invalid slots', async () => {
    const { fixture, evaluator } = await setup('0.2.5', {
      invalidTrials: [{ taskId: 'task-1', attempt: 1 }],
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const evalId = `eval_${'8'.repeat(32)}`
    await expect(evaluator.rerun(state, input, {
      provider: 'hitch-cli', evalId, phase: 'seed-baseline',
      owner: { candidateId: `champion-${fixture.championRef}`, role: 'baseline', harnessRef: fixture.championRef },
      conditionId: input.condition.conditionId, dataset: input.dataset,
      requestedModelId: input.condition.model, requestedCommit: fixture.championRef,
      status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      failure: { code: 'hitch_infrastructure_failure', message: 'invalid task' },
    }, { mode: 'invalid' }, new AbortController().signal)).resolves.toMatchObject({
      provider: 'hitch-cli', evalId, selectedTasks: ['task-1'], repairedTasks: [],
      remainingInvalidTasks: ['task-1'], evalStatus: 'failed',
      remainingInvalidTrials: [{ taskId: 'task-1', attempt: 1 }],
      evidence: {
        evalId, completeness: 'partial', plannedTrialCount: 1, trials: [],
        invalidTrials: [{ taskName: 'task-1', attempt: 1, invalidReason: 'infrastructure_failure' }],
      },
    })
  })

  it('keeps compatibility with the legacy Harbor-shaped summary', async () => {
    const { fixture, evaluator } = await setup('0.2.5', { dataset: 'legacy' })
    const evidence = await evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('legacy', fixture.championRef),
      new AbortController().signal,
    )
    expect(evidence).toMatchObject({ primaryReward: 1, trials: [{ taskName: 'task-1' }] })
  })

  it('reads a bounded page from Hitch canonical trajectory JSON', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    await expect(evaluator.inspectTrajectory(runId, 1, 1, new AbortController().signal)).resolves.toMatchObject({
      runId,
      fidelity: 'provider_native',
      sessionId: 'session-1',
      offset: 1,
      limit: 1,
      total: 3,
      eof: false,
      events: [{ type: 'assistant/message', seq: 1 }],
      diagnostics: {
        totalEvents: 3,
        eventTypes: { 'tool/result': 1, 'assistant/message': 1, 'turn/end': 1 },
        toolResults: 1,
        toolErrors: 1,
        errorExcerpts: [{ seq: 0, type: 'tool/result' }],
        finalAssistantExcerpts: [{ seq: 1 }],
      },
    })
  })

  it('reads and validates run-centered Hitch verifier evidence', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    await expect(evaluator.inspectVerifierEvidence(runId, new AbortController().signal)).resolves.toEqual({
      runId,
      parent: { evalId: `eval_${'1'.repeat(32)}`, trialId: 'trial-1', attempt: 1 },
      observation: { status: 'valid', reward: 0, verifierResultRef: 'verifier/result.json' },
      verifier: {
        status: 'complete',
        result: { rewards: { reward: 0 } },
        resultSha256: `sha256:${'8'.repeat(64)}`,
        diagnostics: { stdout: [{
          name: 'test-stdout.txt', media_type: 'text/plain', bytes: 16,
          sha256: `sha256:${'9'.repeat(64)}`, truncated: false, text: 'assertion failed',
        }] },
      },
      redactions: [{ ruleId: 'absolute-path-v1', count: 2 }],
    })
  })

  it('reports verifier evidence as unavailable when an older Hitch lacks the command', async () => {
    const { evaluator } = await setup()
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('0.2.6\\n')
else { process.stderr.write('hitch: unknown command: verifier\\n'); process.exitCode = 2 }
`)
    await chmod(evaluator.options.executable, 0o755)
    const runId = `run_${'5'.repeat(32)}`
    await expect(evaluator.inspectVerifierEvidence(runId, new AbortController().signal)).resolves.toMatchObject({
      runId,
      verifier: { status: 'unavailable', issues: [expect.stringContaining('unknown command: verifier')] },
    })
  })

  it('fails closed when verifier inspection fails for reasons other than an unsupported command', async () => {
    const { evaluator } = await setup()
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stderr.write('run evidence cannot be read: permission denied\\n')
process.exitCode = 1
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectVerifierEvidence(
      `run_${'5'.repeat(32)}`,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'hitch_verifier_inspect_failed',
      message: expect.stringContaining('permission denied'),
    })
  })

  it.each([
    ['null CTRF', 'complete', { ctrf: null }],
    ['null stdout entry', 'complete', { stdout: [null] }],
    ['non-array stdout', 'result_only', { stdout: 'bad' }],
  ])('rejects malformed verifier diagnostics: %s', async (_label, status, diagnostics) => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const payload = {
      schema_version: '1',
      kind: 'verifier-evidence',
      run_id: runId,
      verifier: {
        status,
        result: {},
        result_sha256: `sha256:${'8'.repeat(64)}`,
        diagnostics,
      },
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload))})
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectVerifierEvidence(
      runId,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'invalid_hitch_result' })
  })

  it('loads and caches the complete canonical trajectory once per run', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const loaded = await evaluator.loadTrajectory(runId, new AbortController().signal)
    expect(loaded).toMatchObject({
      runId,
      trajectoryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
      diagnostics: { totalEvents: 3 },
    })
    await writeFile(evaluator.options.executable, '#!/usr/bin/env node\nprocess.stdout.write("invalid-json\\n")\n')
    await expect(evaluator.inspectTrajectory(runId, 2, 1, new AbortController().signal)).resolves.toMatchObject({
      events: [{ seq: 2 }],
      total: 3,
      eof: true,
      trajectoryDigest: loaded.trajectoryDigest,
    })
  })

  it('keeps a shared trajectory load alive when only one waiter aborts', async () => {
    const { fixture, evaluator } = await setup()
    const counter = join(fixture.root, 'trajectory-invocations.txt')
    const runId = `run_${'7'.repeat(32)}`
    const payload = {
      schema_version: '1', run_id: runId,
      ref: { schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek', files: [] },
      header: { type: 'session', version: 1, id: 'session-delayed', createdAt: 1, delegationDepth: 0 },
      events: [{
        type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] },
      }],
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(counter)}, 'inspect\\n')
setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')}), 100)
`)
    await chmod(evaluator.options.executable, 0o755)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = evaluator.loadTrajectory(runId, firstController.signal)
    const second = evaluator.loadTrajectory(runId, secondController.signal)
    firstController.abort(new Error('first waiter cancelled'))
    await expect(first).rejects.toThrow(/first waiter cancelled/)
    await expect(second).resolves.toMatchObject({ runId, sessionId: 'session-delayed' })
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('does not retain a trajectory that exceeds the configured cache byte budget', async () => {
    const { fixture, evaluator } = await setup()
    const counter = join(fixture.root, 'trajectory-evictions.txt')
    const runId = `run_${'8'.repeat(32)}`
    const payload = {
      schema_version: '1', run_id: runId,
      ref: { schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek', files: [] },
      header: { type: 'session', version: 1, id: 'session-uncached', createdAt: 1, delegationDepth: 0 },
      events: [],
    }
    evaluator.options.trajectoryCacheBytes = 1
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(counter)}, 'inspect\\n')
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    await chmod(evaluator.options.executable, 0o755)
    await evaluator.loadTrajectory(runId, new AbortController().signal)
    await evaluator.loadTrajectory(runId, new AbortController().signal)
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('fails closed on invalid JSON and actual commit mismatch', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    await expect(evaluator.evaluate(state, request('invalid-json', fixture.championRef), new AbortController().signal)).rejects.toThrow(/invalid JSON/)
    await expect(evaluator.evaluate(state, request('mismatch', fixture.championRef), new AbortController().signal)).rejects.toThrow(/resolved .* expected/)
  })

  it('rejects failed status when the run evidence is nevertheless complete', async () => {
    const { fixture, evaluator } = await setup('0.2.5', {
      dataset: 'failed-complete-run', planDataset: 'failed-complete-run',
    })
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('failed-complete-run', fixture.championRef),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'invalid_hitch_result',
      message: 'Hitch result status does not match run evidence completeness',
    })
  })

  it('returns partial evidence for an invalid run without scoring it as zero', async () => {
    const { fixture, evaluator } = await setup('0.2.5', { dataset: 'invalid-run', planDataset: 'invalid-run' })
    const evidence = await evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('invalid-run', fixture.championRef),
      new AbortController().signal,
    )
    expect(evidence).toMatchObject({
      completeness: 'partial',
      plannedTrialCount: 1,
      primaryReward: 0,
      summary: { total: 0, passed: 0, failed: 0 },
      trials: [],
      invalidTrials: [{
        runId: `run_${'5'.repeat(32)}`,
        status: 'errored',
        invalidReason: 'infrastructure_failure',
      }],
    })
  })

  it('preserves valid rewards when a failed eval contains both valid and invalid trials', async () => {
    const trials = [
      { taskId: 'distribution-search', attempt: 1 },
      { taskId: 'prove-plus-comm', attempt: 1 },
      { taskId: 'pytorch-model-recovery', attempt: 1 },
    ]
    const invalidTrials = trials.slice(1)
    const { fixture, evaluator } = await setup('0.2.5', {
      dataset: 'partial-run', planDataset: 'partial-run',
      tasks: trials.map(trial => trial.taskId), trials, invalidTrials,
    })
    const evidence = await evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('partial-run', fixture.championRef),
      new AbortController().signal,
    )
    expect(evidence).toMatchObject({
      completeness: 'partial',
      plannedTrialCount: 3,
      primaryReward: 1,
      summary: { total: 1, passed: 1, failed: 0, score: 1 },
      trials: [{ taskName: 'distribution-search', rewards: { reward: 1 } }],
      invalidTrials: [
        { taskName: 'prove-plus-comm', invalidReason: 'infrastructure_failure' },
        { taskName: 'pytorch-model-recovery', invalidReason: 'infrastructure_failure' },
      ],
    })
  })

  it('terminates Hitch when the round is aborted', async () => {
    const { fixture, evaluator } = await setup()
    const controller = new AbortController()
    const evaluation = evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('slow', fixture.championRef),
      controller.signal,
    )
    setTimeout(() => controller.abort(new Error('test abort')), 50)
    await expect(evaluation).rejects.toThrow(/test abort/)
  })
})
