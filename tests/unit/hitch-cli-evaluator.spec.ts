import { chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
}

async function setup(version = '0.2.5', inspectFixture: InspectFixture = {}) {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const executable = join(fixture.root, 'fake-hitch.mjs')
  const inspectedAttempts = inspectFixture.attempts ?? 1
  const inspectedTasks = inspectFixture.tasks ?? ['task-1']
  const inspectedTrials = inspectFixture.trials ?? [{ taskId: 'task-1', attempt: 1 }]
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const dataset = value('--dataset')
const harness = value('--harness')
const evalId = args.includes('--eval-id') ? value('--eval-id') : 'eval_' + '1'.repeat(32)
const commit = harness?.match(/#([0-9a-f]{40,64})$/)?.[1]
const inspectedTrials = ${JSON.stringify(inspectedTrials)}
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
} else if (args[0] === 'eval' && args[1] === 'rerun') {
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'eval-rerun', rerun_id: 'rerun_' + '9'.repeat(32), eval_id: args[2], status: 'completed',
    selected_tasks: args.includes('--invalid') ? ['task-1'] : args.flatMap((arg, index) => arg === '--task' ? [args[index + 1]] : []),
    repaired_tasks: ['task-1'], remaining_invalid_tasks: [], eval_status: 'succeeded',
    selected_trials: [{ task_id: 'task-1', attempt: 1 }],
    repaired_trials: [{ task_id: 'task-1', attempt: 1 }], remaining_invalid_trials: [],
  }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'inspect') {
  const inspectedEvalId = args[2]
  const actual = ${JSON.stringify(fixture.championRef)}
  process.stdout.write(JSON.stringify({
    schema_version: '1', eval_id: inspectedEvalId,
    plan: { schema_version: '1', eval_id: inspectedEvalId,
      attempts: ${JSON.stringify(inspectedAttempts)}, tasks: ${JSON.stringify(inspectedTasks)} },
    result: {
      schema_version: '1', eval_id: inspectedEvalId, status: 'succeeded', exit_code: 0,
      candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
      dataset: 'seed',
      trials: inspectedTrials.map((trial, index) => ({
        trial_id: 'trial-' + (index + 1), run_id: 'run_' + String(index + 5).repeat(32).slice(0, 32),
        task_id: trial.taskId, attempt: trial.attempt, observation_status: 'valid', reward: 1,
        verifier_result_ref: 'verifier/result.json',
      })),
      summary: { n_trials: inspectedTrials.length, n_completed: inspectedTrials.length,
        n_invalid: 0, primary_reward: 1, rewards: { reward: { count: inspectedTrials.length, mean: 1 } } },
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
  const invalidRun = dataset === 'invalid-run'
  const runTrials = invalidRun
    ? [{ trial_id: 'trial-1', run_id: 'run_' + '5'.repeat(32), task_id: 'task-1',
        attempt: 1, observation_status: 'invalid', invalid_reason: 'infrastructure_failure',
        verifier_result_ref: 'verifier/result.json' }]
    : inspectedTrials.map((trial, index) => ({
        trial_id: 'trial-' + (index + 1), run_id: 'run_' + String(index + 5).repeat(32).slice(0, 32),
        task_id: trial.taskId, attempt: trial.attempt, observation_status: 'valid', reward: 1,
        verifier_result_ref: 'verifier/result.json',
      }))
  process.stdout.write(JSON.stringify({
    schema_version: '1', eval_id: evalId, status: 'succeeded', exit_code: 0,
    candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
    dataset,
    ...(legacy ? {} : { trials: runTrials }),
    summary: legacy
      ? { n_trials: 1, n_completed: 1, n_errored: 0, n_cancelled: 0, primary_reward: 1,
          trials: [{ task_name: 'task-1', trial_name: 'trial-1', status: 'completed', rewards: { reward: 1 } }] }
      : { n_trials: runTrials.length, n_completed: invalidRun ? 0 : runTrials.length, n_invalid: invalidRun ? 1 : 0,
          primary_reward: invalidRun ? null : 1, rewards: { reward: { count: 1, mean: 1 } } },
    local_source_transport: { kind: 'local-git-commit', resolution_identity: 'sha256:' + '2'.repeat(64),
      commit: actual, tree: '3'.repeat(40), payload_sha256: 'sha256:' + '4'.repeat(64), payload_bytes: 100 },
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  }) + '\\n')
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
    await expect(supported.evaluator.preflight()).resolves.toBeUndefined()
    const old = await setup('0.2.4')
    await expect(old.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const prerelease = await setup('0.2.5-rc.1')
    await expect(prerelease.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    const malformed = await setup('not-a-version')
    await expect(malformed.evaluator.preflight()).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
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

  it('keeps compatibility with the legacy Harbor-shaped summary', async () => {
    const { fixture, evaluator } = await setup()
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

  it('classifies an invalid run observation as infrastructure failure', async () => {
    const { fixture, evaluator } = await setup()
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('invalid-run', fixture.championRef),
      new AbortController().signal,
    )).rejects.toThrow(/invalid run observations.*infrastructure_failure/)
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
