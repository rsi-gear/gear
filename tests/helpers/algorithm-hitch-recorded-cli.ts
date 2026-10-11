import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js';
import { createGitHarnessFixture } from './git-fixture.js';
import type { HitchConfig } from '../../src/config.js';

interface InspectFixture {
  controlStateWithoutResult?: string;
  attempts?: number;
  tasks?: string[];
  trials?: Array<{ taskId: string; attempt: number }>;
  dataset?: string;
  planDataset?: string;
  planCommit?: string;
  planBenchmarkRevision?: string;
  attemptExecution?: string | null;
  invalidTrials?: Array<{ taskId: string; attempt: number }>;
  executionProvider?: string;
  processScore?: number;
}
interface SetupOptions {
  followSubmission?: boolean;
  controlPlane?: HitchConfig['controlPlane'];
  daemonStatus?: 'running' | 'stopped';
  fault?: 'submit-reply-lost' | 'submit-replay-rejected' | 'submit-wait' | 'watch-invalid-json' | 'watch-overflow' | 'watch-exit' | 'inspect-failure' | 'rerun-invalid-json';
  cancelFails?: boolean;
}
export async function createRecordedHitchCliFixture(version = '0.2.8', inspectFixture: InspectFixture = {}, setupOptions: SetupOptions = {},
  existingFixture?: Awaited<ReturnType<typeof createGitHarnessFixture>>) {
  const fixture = existingFixture ?? await createGitHarnessFixture()

  const executable = join(fixture.root, 'fake-hitch.mjs')
  const invocationLog = join(fixture.root, 'fake-hitch-invocations.jsonl')
  const environmentLog = join(fixture.root, 'fake-hitch-environments.jsonl')
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
appendFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({
  args,
  pythonDontWriteBytecode: process.env.PYTHONDONTWRITEBYTECODE ?? null,
  sentinel: process.env.GEAR_HITCH_ENV_SENTINEL ?? null,
}) + '\\n')
const fault = ${JSON.stringify(setupOptions.fault ?? '')}
if (args[0] === 'eval' && (
  (args[1] === 'watch' && fault === 'watch-invalid-json') ||
  (args[1] === 'rerun' && fault === 'rerun-invalid-json')
)) { process.stdout.write('bad-json'); process.exit(0) }
if (args[0] === 'eval' && args[1] === 'watch' && fault === 'watch-overflow') {
  process.on('SIGTERM', () => {})
  process.stdout.write('x'.repeat(100000))
  await new Promise(resolve => setTimeout(resolve, 30000))
}
if (args[0] === 'eval' && (
  (args[1] === 'watch' && fault === 'watch-exit') ||
  (args[1] === 'inspect' && fault === 'inspect-failure') ||
  (['cancel', 'rerun-cancel'].includes(args[1]) && ${JSON.stringify(setupOptions.cancelFails ?? false)})
)) { process.stderr.write('injected CLI failure'); process.exit(9) }
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
const processScore = ${JSON.stringify(inspectFixture.processScore)}
const isInvalidTrial = trial => inspectedInvalidTrials.some(slot => slot.taskId === trial.taskId && slot.attempt === trial.attempt)
const remainingInvalidTasks = [...new Set(inspectedInvalidTrials.map(slot => slot.taskId))]
const inspectionRequest = {
  schema_version: '1', backend: 'harbor', dataset: ${JSON.stringify(inspectedDataset)},
  harness_ref: ${JSON.stringify(requestedHarnessRef)}, model: 'deepseek-chat', attempts: ${JSON.stringify(inspectedAttempts)},
  max_concurrent: 2, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0,
  timeout_ms: 30000, setup_timeout_ms: 10000, agent_args: [], pass_env: [],
  benchmark_id: 'benchmark-1', benchmark_revision: 'revision-1',
  ...(${JSON.stringify(setupOptions.followSubmission ?? false)} && submitted ? {
    dataset: submitted.dataset, harness_ref: submitted.harness, setup_timeout_ms: submitted.setupTimeoutMs,
  } : {}),
}
const inspectionExecution = {
  provider: submitted?.executionProvider ?? ${JSON.stringify(inspectFixture.executionProvider ?? 'local-docker')}, max_parallelism: 2,
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
  if (submitted && fault === 'submit-replay-rejected') { process.stderr.write('idempotency_conflict'); process.exit(9) }
  const acceptedEvalId = 'eval_' + '6'.repeat(32)
  const idempotencyKey = value('--idempotency-key')
  writeFileSync(statePath, JSON.stringify({
    evalId: acceptedEvalId, dataset, harness,
    setupTimeoutMs: Number(value('--setup-timeout')?.replace('ms', '')),
    idempotencyKeyHash: 'sha256:' + createHash('sha256').update(idempotencyKey).digest('hex'),
  }))
  if (!submitted && fault === 'submit-reply-lost') { process.stderr.write('lost submission reply'); process.exit(9) }
  if (!submitted && fault === 'submit-wait') await new Promise(resolve => setTimeout(resolve, 30000))
  process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: acceptedEvalId, status: 'queued' }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'cancel') {
  if (submitted) writeFileSync(statePath, JSON.stringify({ ...submitted, cancelled: true }))
  process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: args[2], status: 'cancelling' }) + '\\n')
}
else if (args[0] === 'eval' && args[1] === 'rerun-cancel') {
  process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: args[2], rerun_id: args[3], status: 'cancelled' }))
}
else if (args[0] === 'capabilities') {
  process.stdout.write(JSON.stringify({
    schema_version: '1', trajectory_analysis: '1', trajectory_events_page: '1', verifier_evidence: '1',
    verifier_diagnostic_pages: '1',
  }) + '\\n')
} else if (args[0] === 'trajectory' && args[1] === 'project') {
  const runId = args[2]
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'trajectory-analysis', run_id: runId,
    source: {
      fidelity: 'provider_native', provider: 'deepseek', session_id: 'session-1',
      canonical_sha256: 'sha256:' + 'a'.repeat(64), canonical_bytes: 300, event_count: 3,
      event_types: { 'tool/result': 1, 'assistant/message': 1, 'turn/end': 1 },
    },
    header: { type: 'session', version: 1, id: 'session-1', createdAt: 1, delegationDepth: 0 },
    surface: {
      fidelity: 'exact',
      nodes: [
        { seq: 0, event_type: 'tool/result', surface_op: 'append', message: { content: [{ isError: true }] } },
        { seq: 1, event_type: 'assistant/message', surface_op: 'append', message: { content: [{ type: 'text', text: 'done' }] } },
      ],
      current_node_seqs: [0, 1], replacements: [], request_boundaries: [], request_headers: [],
    },
    events: [
      { type: 'tool/result', seq: 0, time: 10, data: { surface_node_seq: 0 } },
      { type: 'assistant/message', seq: 1, time: 11, data: { surface_node_seq: 1 } },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1 } },
    ],
    chunk_summaries: [], omitted_event_types: {},
    coverage: { surface: 'complete', chunks: 'omitted', content: 'complete', child_sessions: 'unavailable' },
  }) + '\\n')
} else if (args[0] === 'trajectory' && args[1] === 'events') {
  const runId = args[2]
  const all = [
    { type: 'tool/result', seq: 0, time: 10, data: { message: { content: [{ isError: true }] } } },
    { type: 'assistant/message', seq: 1, time: 11, data: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1 } },
  ]
  const types = args.includes('--types') ? value('--types').split(',') : undefined
  const start = args.includes('--seq-start') ? Number(value('--seq-start')) : 0
  const end = args.includes('--seq-end') ? Number(value('--seq-end')) : Number.MAX_SAFE_INTEGER
  const matches = all.filter(event => (!types || types.includes(event.type)) && event.seq >= start && event.seq <= end)
  const limit = Number(value('--limit'))
  const page = matches.slice(0, limit)
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'trajectory-events-page', run_id: runId,
    canonical_sha256: 'sha256:' + 'a'.repeat(64),
    filter: { ...(types ? { types } : {}), ...(args.includes('--seq-start') ? { seq_start: start } : {}),
      ...(args.includes('--seq-end') ? { seq_end: end } : {}) },
    events: page, total_matches: matches.length,
    ...(page.length < matches.length ? { next_cursor: 'cursor-1' } : {}), eof: page.length >= matches.length,
  }) + '\\n')
} else if (args[0] === 'verifier' && args[1] === 'artifact') {
  const runId = args[2]
  const name = args[3]
  const offset = Number(value('--offset'))
  const limit = Number(value('--limit'))
  const content = '\\u0000'.repeat(65536)
  const text = content.slice(offset, offset + limit)
  const sha256 = 'sha256:' + createHash('sha256').update(content).digest('hex')
  process.stdout.write(JSON.stringify({
    schema_version: '1', kind: 'verifier-diagnostic-page', run_id: runId,
    artifact: { name, media_type: name === 'ctrf.json' ? 'application/json' : 'text/plain',
      bytes: Buffer.byteLength(content), sha256, source_complete: name !== 'test-stderr.txt',
      ...(name === 'test-stderr.txt' ? { loss_reason: 'legacy_truncated' } : {}) },
    page: name === 'test-stderr.txt'
      ? { offset: 0, bytes: 0, text: '', eof: true }
      : { offset, bytes: Buffer.byteLength(text), text, eof: offset + Buffer.byteLength(text) === Buffer.byteLength(content),
          ...(offset + Buffer.byteLength(text) === Buffer.byteLength(content) ? {} : { next_offset: offset + Buffer.byteLength(text) }) },
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
    schema_version: '1', kind: 'eval-rerun', rerun_id: value('--rerun-id') ?? 'rerun_' + '9'.repeat(32), eval_id: args[2], status: 'completed',
    selected_tasks: args.includes('--invalid') ? ['task-1'] : args.flatMap((arg, index) => arg === '--task' ? [args[index + 1]] : []),
    repaired_tasks: inspectedInvalidTrials.length === 0 ? ['task-1'] : [],
    remaining_invalid_tasks: remainingInvalidTasks,
    eval_status: inspectedInvalidTrials.length === 0 ? 'succeeded' : 'failed',
    selected_trials: [{ task_id: 'task-1', attempt: 1 }],
    repaired_trials: inspectedInvalidTrials.length === 0 ? [{ task_id: 'task-1', attempt: 1 }] : [],
    remaining_invalid_trials: inspectedInvalidTrials.map(slot => ({ task_id: slot.taskId, attempt: slot.attempt })),
  }) + '\\n')
} else if (args[0] === 'eval' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ schema_version: '1', evals: submitted ? [{ eval_id: submitted.evalId }] : [] }))
} else if (args[0] === 'eval' && args[1] === 'inspect') {
  const inspectedEvalId = args[2]
  if (submitted?.cancelled) {
    process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: inspectedEvalId,
      request: inspectionRequest,
      submission: { schema_version: '1', eval_id: inspectedEvalId, request: inspectionRequest,
        execution: inspectionExecution, submission_digest: submissionDigest,
        idempotency_key_hash: submitted.idempotencyKeyHash, submitted_at: new Date().toISOString() },
      control: { schema_version: '1', eval_id: inspectedEvalId, state: 'cancelled' }, result: null }) + '\\n')
    process.exit(0)
  }
  if (${JSON.stringify(inspectFixture.controlStateWithoutResult ?? null)} !== null) {
    process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: inspectedEvalId,
      control: { schema_version: '1', eval_id: inspectedEvalId, state: ${JSON.stringify(inspectFixture.controlStateWithoutResult ?? null)} }, result: null }))
    process.exit(0)
  }
  const actual = ${JSON.stringify(setupOptions.followSubmission ?? false)} ? commit : ${JSON.stringify(fixture.championRef)}
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
      backend: 'harbor', dataset: ${JSON.stringify(setupOptions.followSubmission ?? false)} ? inspectionRequest.dataset : ${JSON.stringify(planDataset)}, benchmark_id: 'benchmark-1',
      benchmark_revision: ${JSON.stringify(planBenchmarkRevision)}, attempts: ${JSON.stringify(inspectedAttempts)},
      ${attemptExecution} tasks: ${JSON.stringify(inspectedTasks)},
      candidate: { requested_harness_ref: ${JSON.stringify(setupOptions.followSubmission ?? false)} ? inspectionRequest.harness_ref : ${JSON.stringify(requestedHarnessRef)},
        harness_ref: 'deepseek@commit:' + (${JSON.stringify(setupOptions.followSubmission ?? false)} ? actual : ${JSON.stringify(planCommit)}), harness_id: 'deepseek',
        revision_identity: 'sha256:' + '2'.repeat(64) } },
    result: {
      schema_version: '1', eval_id: inspectedEvalId,
      status: inspectedInvalidTrials.length === 0 ? 'succeeded' : 'failed',
      exit_code: inspectedInvalidTrials.length === 0 ? 0 : 1,
      candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
      dataset: ${JSON.stringify(setupOptions.followSubmission ?? false)} ? inspectionRequest.dataset : ${JSON.stringify(inspectedDataset)},
      trials: inspectedTrials.map((trial, index) => ({
        trial_id: 'trial-' + (index + 1), run_id: 'run_' + String(index + 5).repeat(32).slice(0, 32),
        task_id: trial.taskId, attempt: trial.attempt,
        observation_status: isInvalidTrial(trial) ? 'invalid' : 'valid',
        ...(isInvalidTrial(trial) ? { invalid_reason: 'infrastructure_failure' } : {
          reward: 1,
          scores: { total_score: 1, ...(processScore === undefined ? {} : { process_score: processScore }), normalization: 'standard' },
        }),
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
        ...(isInvalidTrial(trial) ? { invalid_reason: 'infrastructure_failure' } : {
          reward: 1,
          scores: { total_score: 1, ...(processScore === undefined ? {} : { process_score: processScore }), normalization: 'standard' },
        }),
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
  return { fixture, evaluator, invocationLog, environmentLog, submissionState }
}
