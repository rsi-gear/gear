import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import type { HitchConfig } from '../../src/config.js'
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
  executionProvider?: string
}

interface SetupOptions {
  controlPlane?: HitchConfig['controlPlane']
  daemonStatus?: 'running' | 'stopped'
}

async function setup(version = '0.2.5', inspectFixture: InspectFixture = {}, setupOptions: SetupOptions = {}) {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const executable = join(fixture.root, 'fake-hitch.mjs')
  const invocationLog = join(fixture.root, 'fake-hitch-invocations.jsonl')
  const submissionState = join(fixture.root, 'fake-hitch-submission.json')
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n')
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const statePath = ${JSON.stringify(submissionState)}
const submitted = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined
const dataset = value('--dataset') ?? submitted?.dataset
const harness = value('--harness') ?? submitted?.harness
const evalId = args.includes('--eval-id') ? value('--eval-id')
  : args[0] === 'eval' && ['watch', 'cancel'].includes(args[1]) ? args[2]
  : submitted?.evalId ?? 'eval_' + '1'.repeat(32)
const commit = harness?.match(/#([0-9a-f]{40,64})$/)?.[1]
const inspectedTrials = ${JSON.stringify(inspectedTrials)}
const inspectedInvalidTrials = ${JSON.stringify(inspectedInvalidTrials)}
const isInvalidTrial = trial => inspectedInvalidTrials.some(slot => slot.taskId === trial.taskId && slot.attempt === trial.attempt)
const remainingInvalidTasks = [...new Set(inspectedInvalidTrials.map(slot => slot.taskId))]
const inspectionRequest = {
  schema_version: '1', backend: 'harbor', dataset: ${JSON.stringify(inspectedDataset)},
  harness_ref: ${JSON.stringify(requestedHarnessRef)}, model: 'deepseek-chat', attempts: ${JSON.stringify(inspectedAttempts)},
  max_concurrent: 2, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0,
  timeout_ms: 30000, setup_timeout_ms: 10000, agent_args: [], pass_env: [],
  benchmark_id: 'benchmark-1', benchmark_revision: 'revision-1',
}
const inspectionExecution = {
  provider: ${JSON.stringify(inspectFixture.executionProvider ?? 'local-docker')}, max_parallelism: 2,
  resources: { default_trial: { cpu_millis: 1000, memory_bytes: 1073741824, container_slots: 1, build_slots: 0 } },
  build: { mode: 'prebuild-preferred' }, model_capture: { mode: 'native', required: false },
}
const canonicalJson = input => Array.isArray(input) ? '[' + input.map(canonicalJson).join(',') + ']'
  : input && typeof input === 'object'
    ? '{' + Object.keys(input).filter(key => input[key] !== undefined).sort()
        .map(key => JSON.stringify(key) + ':' + canonicalJson(input[key])).join(',') + '}'
    : JSON.stringify(input)
const submissionDigest = 'sha256:' + createHash('sha256')
  .update(canonicalJson({ request: inspectionRequest, execution: inspectionExecution })).digest('hex')
if (args[0] === '--version') process.stdout.write(${JSON.stringify(version)} + '\\n')
else if (args[0] === 'daemon' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({
    schema_version: '1', status: ${JSON.stringify(setupOptions.daemonStatus ?? 'running')},
    resource_policy: { eval_trial: { cpu_millis: 1000, memory_bytes: 1073741824, container_slots: 1, build_slots: 0 } },
  }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'submit') {
  const acceptedEvalId = 'eval_' + '6'.repeat(32)
  const idempotencyKey = value('--idempotency-key')
  writeFileSync(statePath, JSON.stringify({
    evalId: acceptedEvalId, dataset, harness,
    idempotencyKeyHash: 'sha256:' + createHash('sha256').update(idempotencyKey).digest('hex'),
  }))
  process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: acceptedEvalId, status: 'queued' }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'cancel') {
  process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: args[2], status: 'cancelling' }) + '\\n')
}
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
    request: inspectionRequest,
    ...(submitted ? { submission: {
      schema_version: '1', eval_id: inspectedEvalId, request: inspectionRequest,
      execution: inspectionExecution,
      submission_digest: submissionDigest, idempotency_key_hash: submitted.idempotencyKeyHash,
      submitted_at: new Date().toISOString(),
    } } : {}),
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
  const zeroRunFailed = dataset === 'zero-run-failed'
  const runTrials = zeroRunFailed ? [] : dataset === 'invalid-run'
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
    status: invalidRun || failedCompleteRun || zeroRunFailed ? 'failed' : 'succeeded',
    exit_code: invalidRun || failedCompleteRun || zeroRunFailed ? 13 : 0,
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
    ...(zeroRunFailed ? { error: { code: 'harbor_failed', message: 'Harbor work items completed 2/5' } } : {}),
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  }) + '\\n')
  if (invalidRun || failedCompleteRun || zeroRunFailed) process.exitCode = 13
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
    ...(setupOptions.controlPlane === undefined ? {} : { controlPlane: setupOptions.controlPlane }),
    repositoryPath: fixture.repository,
  })
  return { fixture, evaluator, invocationLog }
}

describe('HitchCliEvaluator', () => {
  it('requires stable eval identity support from agent-hitch 0.2.5 or newer', async () => {
    const supported = await setup('0.2.5')
    await expect(supported.evaluator.preflight()).resolves.toBeUndefined()
    const old = await setup('0.2.4')
    await expect(old.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const prerelease = await setup('0.2.5-rc.1')
    await expect(prerelease.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const laterPrerelease = await setup('0.2.6-rc.1')
    await expect(laterPrerelease.evaluator.preflight()).resolves.toBeUndefined()
    const malformed = await setup('not-a-version')
    await expect(malformed.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
  })

  it('requires Hitch 0.2.6 and a running daemon in control-plane mode', async () => {
    const controlPlane = { mode: 'daemon', requireModelCapture: false } as const
    const supported = await setup('0.2.6', {}, { controlPlane })
    await expect(supported.evaluator.preflight()).resolves.toBeUndefined()
    const old = await setup('0.2.5', {}, { controlPlane })
    await expect(old.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const stopped = await setup('0.2.6', {}, { controlPlane, daemonStatus: 'stopped' })
    await expect(stopped.evaluator.preflight()).rejects.toMatchObject({ code: 'hitch_daemon_unavailable' })
  })

  it('submits daemon evals idempotently, watches them, and accepts task-slot plans', async () => {
    const controlPlane = {
      mode: 'daemon', provider: 'local-docker', cpuPerTrial: 1, memoryPerTrial: '1GiB',
      buildMode: 'prebuild-preferred', modelCapture: 'native', requireModelCapture: false,
    } as const
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    await evaluator.preflight()
    const first = await evaluator.reserve(state, input)
    const second = await evaluator.reserve(state, input)
    expect(second).toEqual(first)
    await expect(evaluator.evaluate(state, input, new AbortController().signal, first)).resolves.toMatchObject({
      provider: 'hitch-cli', evalId: first.evalId, completeness: 'complete',
    })
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const submissions = invocations.filter(args => args[0] === 'eval' && args[1] === 'submit')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]?.[submissions[0].indexOf('--idempotency-key') + 1]).toBe(
      submissions[1]?.[submissions[1].indexOf('--idempotency-key') + 1],
    )
    expect(submissions[0]).toEqual(expect.arrayContaining([
      '--provider', 'local-docker', '--cpu-per-trial', '1', '--memory-per-trial', '1GiB',
      '--build-mode', 'prebuild-preferred', '--model-capture', 'native',
    ]))
    expect(invocations).toContainEqual(['eval', 'watch', first.evalId, '--output', 'json'])
  })

  it('rejects daemon execution policy drift from the submitted Gear condition', async () => {
    const { fixture, evaluator } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1', executionProvider: 'remote-worker',
    }, { controlPlane: { mode: 'daemon', provider: 'local-docker', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).rejects.toMatchObject({
      code: 'invalid_hitch_result', message: expect.stringMatching(/provider differs/u),
    })
  })

  it('cancels a submitted daemon eval when the round is aborted', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {
      dataset: 'slow', planDataset: 'slow', attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane: { mode: 'daemon', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('slow', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    const controller = new AbortController()
    const evaluation = evaluator.evaluate(state, input, controller.signal, reservation)
    setTimeout(() => controller.abort(new Error('test daemon abort')), 50)
    await expect(evaluation).rejects.toThrow(/test daemon abort/u)
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(invocations).toContainEqual(['eval', 'cancel', reservation.evalId])
  })

  it('invokes Hitch CLI and validates exact local commit transport evidence', async () => {
    const { fixture, evaluator } = await setup()
    const evidence = await evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
      new AbortController().signal,
    )
    expect(evidence).toMatchObject({
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

  it('rejects daemon task-slot plans in direct CLI mode', async () => {
    const { fixture, evaluator } = await setup('0.2.5', { attemptExecution: 'harbor-task-slots-v1' })
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'invalid_hitch_result', message: expect.stringMatching(/no stable logical-attempt identity/u),
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

  it('submits daemon reruns explicitly and reloads their frozen policy', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane: { mode: 'daemon', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    await expect(evaluator.rerun(state, input, {
      provider: 'hitch-cli', evalId: reservation.evalId, phase: 'seed-baseline',
      owner: { candidateId: `champion-${fixture.championRef}`, role: 'baseline', harnessRef: fixture.championRef },
      conditionId: input.condition.conditionId, dataset: input.dataset,
      requestedModelId: input.condition.model, requestedCommit: fixture.championRef,
      status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      failure: { code: 'hitch_infrastructure_failure', message: 'invalid task' },
    }, { mode: 'invalid' }, new AbortController().signal)).resolves.toMatchObject({
      provider: 'hitch-cli', evalId: reservation.evalId, evalStatus: 'succeeded',
    })
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(invocations).toContainEqual([
      'eval', 'rerun', reservation.evalId, '--invalid', '--type', 'candidate-restart', '--daemon', '--output', 'json',
    ])
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

  it('preserves the Hitch infrastructure error when a failed eval has no canonical trials', async () => {
    const { fixture, evaluator } = await setup('0.2.5', {
      dataset: 'zero-run-failed', planDataset: 'zero-run-failed',
    })
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('zero-run-failed', fixture.championRef),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'harbor_failed',
      message: expect.stringMatching(/failed before producing canonical trial evidence.*2\/5/u),
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
