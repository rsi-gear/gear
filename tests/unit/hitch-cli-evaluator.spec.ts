import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import { RefineStateStore } from '../../src/state/store.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { renderTrajectoryResult } from '../../src/notebook/tool.js'
import type { HitchConfig } from '../../src/config.js'
import type { DiagnosisReceipt, EvaluationRequest, MetaFailureCard, RefinementRound, RoundEvaluationAttempt } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { evaluationCondition, evidence as evidenceFixture, roundFixture } from '../helpers/research-fixture.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'
import { EvaluationSearchAdapter } from '../../src/search/evaluation-adapter.js'
import { cellIdentity } from '../../src/search/evidence.js'
import { stagePlan } from '../../src/search/scopes.js'
import { digestJson } from '../../src/state/digest.js'
import { seal } from '../../src/search/contracts.js'
import { fixtures } from '../helpers/search-fixture.js'
import { evolutionSpec } from '../helpers/research-fixture.js'
import { standardSearchDataset } from '../helpers/standard-search-dataset.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, commit: string, digest: string): RefinementRound {
  return roundFixture({ workspaceRoot: root, status: 'baseline-running', targetHarnessRef: commit, targetHarnessDigest: digest })
}

function request(dataset: string, harnessRef: string): EvaluationRequest {
  return { phase: 'seed-baseline', dataset, harnessRef, condition: evaluationCondition('seed', dataset) }
}

interface InspectFixture {
  controlStateWithoutResult?: string
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
  processScore?: number
}

interface SetupOptions {
  followSubmission?: boolean
  controlPlane?: HitchConfig['controlPlane']
  daemonStatus?: 'running' | 'stopped'
  fault?: 'submit-reply-lost' | 'submit-replay-rejected' | 'submit-wait' | 'watch-invalid-json' | 'watch-overflow' | 'watch-exit' | 'inspect-failure' | 'rerun-invalid-json'
  cancelFails?: boolean
}

function trajectoryAnalysisPayload(runId: string, sessionId: string): unknown {
  return {
    schema_version: '1', kind: 'trajectory-analysis', run_id: runId,
    source: {
      fidelity: 'provider_native', provider: 'deepseek', session_id: sessionId,
      canonical_sha256: `sha256:${'b'.repeat(64)}`, canonical_bytes: 120, event_count: 1,
      event_types: { 'user/message': 1 },
    },
    header: { type: 'session', version: 1, id: sessionId, createdAt: 1, delegationDepth: 0 },
    surface: {
      fidelity: 'exact',
      nodes: [{
        seq: 0, event_type: 'user/message', surface_op: 'append',
        message: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] },
      }],
      current_node_seqs: [0], replacements: [], request_boundaries: [], request_headers: [],
    },
    events: [{ type: 'user/message', seq: 0, time: 1, data: { surface_node_seq: 0 } }],
    chunk_summaries: [], omitted_event_types: {},
    coverage: { surface: 'complete', chunks: 'omitted', content: 'complete', child_sessions: 'unavailable' },
  }
}

function partialTrajectoryAnalysisPayload(runId: string) {
  return {
    schema_version: '1', kind: 'trajectory-analysis', run_id: runId,
    source: {
      fidelity: 'provider_native', provider: 'deepseek', session_id: 'session-partial',
      canonical_sha256: `sha256:${'c'.repeat(64)}`, canonical_bytes: 200, event_count: 2,
      event_types: { 'user/message': 1, 'assistant/chunk': 1 },
    },
    header: null,
    surface: {
      fidelity: 'exact',
      nodes: [{
        seq: 0, event_type: 'user/message', surface_op: 'append',
        message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      }],
      current_node_seqs: [0], replacements: [],
      request_boundaries: [{ turn: 1, step: 1, attempt: 0, boundary_seq: 1, surface_revision: 1 }],
      request_headers: [],
    },
    events: [{ type: 'user/message', seq: 0, time: 1, data: { surface_node_seq: 0 } }],
    chunk_summaries: [{
      turn: 1, step: 1, attempt: 0, first_seq: 1, last_seq: 1, count: 1,
      types: { 'text-delta': 1 }, model_boundary_seq: 1,
      partial: {
        status: 'incomplete', source_seq_count: 1,
        content: {
          preview: 'incomplete answer', bytes: 17, sha256: `sha256:${'d'.repeat(64)}`, truncated: false,
          source: { run_id: runId, seq: 1, field: 'data.chunk.delta' },
        },
      },
    }],
    omitted_event_types: { 'assistant/chunk': 1 },
    coverage: { surface: 'complete', chunks: 'partial', content: 'complete', child_sessions: 'unavailable' },
  }
}

function multiStreamTrajectoryAnalysisPayload(runId: string) {
  const payload = partialTrajectoryAnalysisPayload(runId)
  // Reduced from the real AutomationBench timeout: one unfinished request
  // contains reasoning and two independently addressed tool argument streams.
  const streams = [
    { block_index: 0, block_start_seq: 1, kind: 'reasoning', text: 'Checking the contact', source_seq_count: 2 },
    { block_index: 1, block_start_seq: 4, kind: 'tool_arguments', text: '{"contact_id":7}', source_seq_count: 1 },
    { block_index: 2, block_start_seq: 6, kind: 'tool_arguments', text: '{"phone":"123', source_seq_count: 2 },
  ].map(({ text, ...stream }) => ({
    ...stream,
    content: {
      preview: text, bytes: Buffer.byteLength(text), sha256: `sha256:${'d'.repeat(64)}`, truncated: false,
      source: { run_id: runId, seq: stream.block_start_seq, field: 'data.chunk.delta' },
    },
  }))
  return {
    ...payload,
    source: { ...payload.source, event_count: 9, event_types: { 'user/message': 1, 'assistant/chunk': 8 } },
    chunk_summaries: [{
      turn: 1, step: 1, attempt: 0, first_seq: 1, last_seq: 8, count: 8,
      types: { 'block-start': 3, 'reasoning-delta': 2, 'tool-call-delta': 3 }, model_boundary_seq: 1,
      partial: { status: 'incomplete', streams, source_seq_count: 5 },
    }],
    omitted_event_types: { 'assistant/chunk': 8 },
  }
}

async function setup(version = '0.2.5', inspectFixture: InspectFixture = {}, setupOptions: SetupOptions = {}) {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
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
  if (${JSON.stringify(inspectFixture.controlStateWithoutResult ?? null)} !== null) {
    process.stdout.write(JSON.stringify({ schema_version: '1', eval_id: inspectedEvalId,
      control: { schema_version: '1', eval_id: inspectedEvalId, state: ${JSON.stringify(inspectFixture.controlStateWithoutResult ?? null)} }, result: null }))
    process.exit(0)
  }
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
      backend: 'harbor', dataset: ${JSON.stringify(setupOptions.followSubmission ?? false)} ? inspectionRequest.dataset : ${JSON.stringify(planDataset)}, benchmark_id: 'benchmark-1',
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

describe('HitchCliEvaluator', () => {
  it.each(['queued', 'planning', 'running', 'finalizing', 'cancelling', 'failed', 'cancelled', 'succeeded'])('reads existing control state %s without a new execution', async controlStateWithoutResult => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.5', { controlStateWithoutResult })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest), input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    const result = await evaluator.inspectResult(state, input, reservation, new AbortController().signal)
    expect(result.status).toBe(['failed', 'cancelled'].includes(controlStateWithoutResult) ? 'failed' : controlStateWithoutResult === 'succeeded' ? 'unknown' : 'running')
    const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(c => c[0] === 'eval')).toEqual([['eval', 'inspect', reservation.evalId, '--json']])
  })
  it('reads an existing evaluation through the existing inspect command without starting or rerunning it', async () => {
    const { fixture, evaluator, invocationLog } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest), input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input)
    const result = await evaluator.inspectResult(state, input, reservation, new AbortController().signal)
    expect(result.status).toBe('complete')
    if (result.status === 'complete') {
      expect(result.evidence.evalId).toBe(reservation.evalId)
      expect(result.evidence.actualCommit).toBe(fixture.championRef)
    }
    const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toContainEqual(['eval', 'inspect', reservation.evalId, '--json'])
    expect(calls.some(c => c[0] === 'eval' && ['run', 'submit', 'rerun', 'watch', 'cancel'].includes(c[1]!))).toBe(false)
  })
  it('recovers the owned eval by its stored key when changed daemon defaults reject replay', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false }, fault: 'submit-replay-rejected',
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const intent = evaluator.prepareSubmission(state, input)!
    const original = await evaluator.reserve(state, input, undefined, intent)
    evaluator.options.root = 'different-daemon-root'
    const recovered = await evaluator.recoverReservation(state, input, new AbortController().signal, intent)
    expect(recovered).toEqual(original)
    await evaluator.cancelReservation(recovered, intent)
    const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toContainEqual(['eval', 'list', '--json'])
    expect(calls).toContainEqual(['eval', 'cancel', original.evalId])
  })

  it('prepares without submitting and replays a lost acknowledgement using the frozen intent', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false }, fault: 'submit-reply-lost',
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const intent = evaluator.prepareSubmission(state, input)!
    await expect(readFile(invocationLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(evaluator.reserve(state, input)).rejects.toThrow(/persisted submission intent/u)
    await expect(evaluator.reserve(state, input, undefined, intent)).rejects.toThrow(/lost submission reply/u)
    evaluator.options.controlPlane = { mode: 'direct', requireModelCapture: false }
    const reserved = await evaluator.reserve(state, input, undefined, intent)
    await evaluator.cancelReservation(reserved, intent)
    const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const submissions = calls.filter(args => args[1] === 'submit')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).toEqual(submissions[1])
    expect(calls).toContainEqual(['eval', 'cancel', reserved.evalId])
  })

  it('propagates caller cancellation while submitting and can recover the accepted eval afterwards', async () => {
    const { fixture, evaluator, submissionState } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false }, fault: 'submit-wait',
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const intent = evaluator.prepareSubmission(state, input)!
    const controller = new AbortController()
    const submission = evaluator.reserve(state, input, controller.signal, intent)
    const rejected = expect(submission).rejects.toThrow('cancel during submission')
    await expect.poll(() => readFile(submissionState, 'utf8').catch(() => ''), { timeout: 5000 }).not.toBe('')
    controller.abort(new Error('cancel during submission'))
    await rejected
    const recovered = await evaluator.reserve(state, input, undefined, intent)
    await evaluator.cancelReservation(recovered, intent)
  })

  it.each(['watch-invalid-json', 'watch-overflow', 'watch-exit', 'inspect-failure', 'rerun-invalid-json'] as const)(
    'cancels daemon work after %s', async fault => {
      const { fixture, evaluator, invocationLog } = await setup('0.2.6', {}, {
        controlPlane: { mode: 'daemon', requireModelCapture: false }, fault,
      })
      const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
      const input = request('seed', fixture.championRef)
      const intent = evaluator.prepareSubmission(state, input)!
      const reservation = await evaluator.reserve(state, input, undefined, intent)
      if (fault === 'watch-overflow') evaluator.options.maxOutputBytes = 1024
      const rerunReservation = { ...reservation, rerunId: `rerun_${'8'.repeat(32)}`, parameters: { root: '' } }
      const result = fault === 'rerun-invalid-json' ? evaluator.rerun(state, input, {
        ...reservation, phase: input.phase, conditionId: input.condition.conditionId,
        dataset: input.dataset, requestedCommit: input.harnessRef, requestedModelId: input.condition.model,
        owner: { candidateId: `champion-${input.harnessRef}`, role: 'baseline', harnessRef: input.harnessRef },
        status: 'failed', startedAt: 'before', completedAt: 'after', submissionIntent: intent,
      }, { mode: 'invalid' }, new AbortController().signal, rerunReservation)
        : evaluator.evaluate(state, input, new AbortController().signal, reservation)
      await expect(result).rejects.toMatchObject({ code: fault === 'watch-overflow' ? 'hitch_output_overflow'
        : fault === 'inspect-failure' ? 'hitch_eval_inspect_failed' : 'invalid_hitch_json' })
      const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(calls).toContainEqual(fault === 'rerun-invalid-json'
        ? ['eval', 'rerun-cancel', reservation.evalId, rerunReservation.rerunId]
        : ['eval', 'cancel', reservation.evalId])
      if (fault === 'rerun-invalid-json') expect(calls).not.toContainEqual(['eval', 'cancel', reservation.evalId])
    },
  )

  it('preserves the observer error and reports cancellation failure separately', async () => {
    const { fixture, evaluator } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false }, fault: 'watch-invalid-json', cancelFails: true,
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).rejects.toMatchObject({
      code: 'invalid_hitch_json', message: expect.stringContaining('invalid JSON'),
      cause: { code: 'invalid_hitch_json' }, cleanupFailure: { code: 'hitch_eval_cancel_failed' },
    })
  })

  it('cancels an owned daemon evaluation when runtime validation fails', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false },
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    await writeFile(evaluator.options.executable, (await readFile(evaluator.options.executable, 'utf8')).replace('"0.2.6"', '"0.2.4"'))
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).rejects.toMatchObject({ code: 'unsupported_hitch_version' })
    expect(await readFile(invocationLog, 'utf8')).toContain(JSON.stringify(['eval', 'cancel', reservation.evalId]))
  })

  it('reports the original spawn failure even when the executable also prevents cancellation', async () => {
    const { fixture, evaluator } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false },
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    await chmod(evaluator.options.executable, 0o644)
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).rejects.toMatchObject({
      code: 'hitch_unavailable', message: expect.stringContaining('failed to start Hitch CLI'),
      cause: { code: 'hitch_unavailable' }, cleanupFailure: { code: 'hitch_unavailable' },
    })
  })

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

  it('leaves standard benchmark identity unresolved when the frozen dataset cannot be verified', async () => {
    const { fixture, evaluator } = await setup('0.2.8')
    await mkdir(join(fixture.root, 'seed'), { recursive: true })
    await writeFile(join(fixture.root, 'seed', 'benchmark.adapter.json'), '{}\n')
    await expect(evaluator.evaluationIdentity(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
    )).resolves.toBeUndefined()
  })

  it.each(['manifest', 'task'] as const)('resolves standard benchmark identity without executing trials and detects %s drift', async drift => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.8')
    const root = join(fixture.root, 'seed')
    await mkdir(root)
    await writeFile(join(root, 'benchmark.adapter.json'), '{}\n')
    await writeFile(join(root, 'task.txt'), 'frozen task')
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    input.condition.dataset.digest = await digestDatasetRef('seed', fixture.root)
    const identity = await evaluator.evaluationIdentity(state, input)
    expect(identity).toMatchObject({ provider: 'hitch-cli', effectiveConfigDigest: expect.stringMatching(/^sha256:/u) })
    expect(await readFile(invocationLog, 'utf8')).not.toMatch(/eval|run/u)
    await writeFile(join(root, drift === 'manifest' ? 'benchmark.adapter.json' : 'task.txt'), 'changed')
    expect(await evaluator.evaluationIdentity(state, input)).toBeUndefined()
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
    const first = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    const second = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
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

  it('rejects a new daemon batch after only setup timeout changes, while preserving old cells', async () => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane: { mode: 'daemon', requireModelCapture: false }, followSubmission: true })
    const spec = evolutionSpec()
    spec.datasets = { seed: await standardSearchDataset(fixture.root, 2, 'seed', false),
      heldOut: await standardSearchDataset(fixture.root, 2, 'held-out', false) }
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const { digest: ignored, ...anchor } = fixtures(2, false).anchor
    const snapshot = seal({ ...anchor, commit: fixture.championRef, manifestDigest: fixture.manifest.digest })
    const lock = await new RefineStateStore(fixture.root).acquireRoundLock()
    const options = { lock: async () => lock, spec, workspaceRoot: fixture.root, stateRoot: join(fixture.root, 'search'), identityRound: state,
      round: async () => state, manifest: async () => fixture.manifest }
    const provider = new EvaluationSearchAdapter(evaluator, options), universe = await provider.describe('seed')
    const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: universe.digest,
      taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: digestJson('scope'), taskIds: ['task-1'],
      participantIds: [snapshot.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
    const input = { plan, snapshot, cells: [cellIdentity(universe, 'task-1', 0, snapshot)],
      idempotencyKey: digestJson('baseline'), signal: new AbortController().signal }
    const [original] = await provider.evaluate(input)
    expect(await provider.verifyCell(original!, input.cells[0]!)).toBe(true)
    // A same-config batch still joins the cohort after restarting the adapter.
    const [cell] = await new EvaluationSearchAdapter(evaluator, options).evaluate({ ...input, idempotencyKey: digestJson('same-config') })
    const changed = new HitchCliEvaluator({ ...evaluator.options, setupTimeoutMs: evaluator.options.setupTimeoutMs + 12345 })
    const restarted = new EvaluationSearchAdapter(changed, options)
    expect(await restarted.verifyCell(cell!, input.cells[0]!)).toBe(true)
    const next = { ...input, idempotencyKey: digestJson('changed-setup-timeout') }
    await expect(restarted.evaluate(next)).rejects.toThrow('runtime cohort changed')
    await expect(restarted.inspectEvaluation(next)).rejects.toThrow('runtime cohort changed')
    expect(await restarted.verifyCell(cell!, input.cells[0]!)).toBe(true)
    const calls = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const submissions = calls.filter(args => args[0] === 'eval' && args[1] === 'submit')
    expect(submissions).toHaveLength(3)
    expect(submissions.at(-1)).toEqual(expect.arrayContaining(['--setup-timeout', '22345ms']))
    expect(calls.filter(args => args[0] === 'eval' && args[1] === 'watch')).toHaveLength(2)
    expect(calls.filter(args => args[0] === 'eval' && args[1] === 'cancel')).toHaveLength(1)
  })

  it('keeps the daemon cohort stable across task projections and candidate commits', async () => {
    const { fixture, evaluator } = await setup('0.2.6', {}, {
      controlPlane: { mode: 'daemon', requireModelCapture: false }, followSubmission: true,
    })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest), signal = new AbortController().signal
    const identity = async (input: EvaluationRequest) => {
      const reservation = await evaluator.reserve(state, input, signal, evaluator.prepareSubmission(state, input))
      return evaluator.submittedEvaluationIdentity(state, input, reservation, signal)
    }
    const baseline = await identity(request('seed', fixture.championRef))
    const candidate = request('projected-held-out', 'f'.repeat(40))
    candidate.phase = 'held-out-candidate'
    candidate.condition = evaluationCondition('held-out', candidate.dataset)
    const next = await identity(candidate)
    expect(next?.cohortDigest).toBe(baseline?.cohortDigest)
    expect(next?.effectiveConfigDigest).not.toBe(baseline?.effectiveConfigDigest)
  })

  it('rejects daemon execution policy drift from the submitted Gear condition', async () => {
    const { fixture, evaluator } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1', executionProvider: 'remote-worker',
    }, { controlPlane: { mode: 'daemon', provider: 'local-docker', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    await expect(evaluator.submittedEvaluationIdentity(state, input, reservation, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_hitch_result', message: expect.stringMatching(/provider differs/u),
    })
    await expect(evaluator.evaluate(state, input, new AbortController().signal, reservation)).rejects.toMatchObject({
      code: 'invalid_hitch_result', message: expect.stringMatching(/provider differs/u),
    })
  })

  it('includes frozen daemon policy in semantic identity and skips reuse lookup', async () => {
    const { fixture, evaluator, submissionState, invocationLog } = await setup('0.2.6', {
      attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane: { mode: 'daemon', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    await expect(evaluator.evaluationIdentity(state, input)).resolves.toBeUndefined()
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    const submitted = await evaluator.submittedEvaluationIdentity(state, input, reservation, new AbortController().signal)
    const baseline = await evaluator.evaluate(state, input, new AbortController().signal, reservation)
    expect(submitted).toMatchObject({ effectiveConfigDigest: baseline.effectiveConfigDigest, cohortDigest: expect.stringMatching(/^sha256:/u) })
    expect(await evaluator.submittedEvaluationIdentity(state, input, reservation, new AbortController().signal)).toEqual(submitted)
    const repeated = await evaluator.evaluate(state, input, new AbortController().signal, reservation)
    expect(repeated.effectiveConfigDigest).toBe(baseline.effectiveConfigDigest)
    await expect(evaluator.evaluationIdentity(state, input)).resolves.toBeUndefined()

    const direct = new HitchCliEvaluator({
      ...evaluator.options, controlPlane: { mode: 'direct', requireModelCapture: false },
    })
    const directIdentity = await direct.evaluationIdentity(state, input)
    if (directIdentity === undefined) throw new Error('direct Hitch evaluation identity is missing')
    expect(baseline.effectiveConfigDigest).not.toBe(directIdentity.effectiveConfigDigest)

    const submission = JSON.parse(await readFile(submissionState, 'utf8')) as Record<string, unknown>
    await writeFile(submissionState, JSON.stringify({ ...submission, executionProvider: 'remote-worker' }))
    const changed = await evaluator.evaluate(state, input, new AbortController().signal, reservation)
    expect(changed.effectiveConfigDigest).not.toBe(baseline.effectiveConfigDigest)
    const changedSubmission = await evaluator.submittedEvaluationIdentity(state, input, reservation, new AbortController().signal)
    expect(changedSubmission?.effectiveConfigDigest).toBe(changed.effectiveConfigDigest)
    expect(changedSubmission?.cohortDigest).not.toBe(submitted?.cohortDigest)
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(invocations.filter(args => args[0] === 'eval' && args[1] === 'submit')).toHaveLength(1)
    expect(invocations.filter(args => args[0] === 'eval').every(args => ['submit', 'watch', 'inspect'].includes(args[1]!))).toBe(true)
  })

  it.each(['before watching', 'while watching'])('cancels a submitted daemon eval aborted %s', async timing => {
    const { fixture, evaluator, invocationLog } = await setup('0.2.6', {
      dataset: 'slow', planDataset: 'slow', attemptExecution: 'harbor-task-slots-v1',
    }, { controlPlane: { mode: 'daemon', requireModelCapture: false } })
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('slow', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    const controller = new AbortController()
    if (timing === 'before watching') controller.abort(new Error('test daemon abort'))
    const evaluation = evaluator.evaluate(state, input, controller.signal, reservation)
    if (timing === 'while watching') setTimeout(() => controller.abort(new Error('test daemon abort')), 50)
    await expect(evaluation).rejects.toThrow(/test daemon abort/u)
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(invocations).toContainEqual(['eval', 'cancel', reservation.evalId])
  })

  it('keeps Hitch runtime changes diagnostic instead of invalidating semantic evidence reuse', async () => {
    const { fixture, evaluator } = await setup('0.2.5')
    const environmentName = `GEAR_HITCH_IDENTITY_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
    evaluator.options.passEnv.push(environmentName)
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    process.env[environmentName] = 'first-value'
    try {
      await evaluator.preflight()
      const first = await evaluator.evaluationIdentity(state, input)
      if (first === undefined) throw new Error('direct Hitch evaluation identity is missing')

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
      const changedRuntime = await evaluator.evaluationIdentity(state, input)
      if (changedRuntime === undefined) throw new Error('changed direct Hitch evaluation identity is missing')
      expect(changedRuntime.effectiveConfigDigest).toBe(first.effectiveConfigDigest)
      expect(changedRuntime.invocationFingerprint).not.toBe(first.invocationFingerprint)
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
    if (identity === undefined) throw new Error('direct Hitch evaluation identity is missing')
    expect(evidence).toMatchObject({
      provider: identity.provider,
      effectiveConfigDigest: identity.effectiveConfigDigest,
      invocationFingerprint: identity.invocationFingerprint,
      dataset: 'seed', requestedCommit: fixture.championRef, actualCommit: fixture.championRef,
      benchmark: { id: 'benchmark-1', revision: 'revision-1' },
      primaryReward: 1, summary: { total: 1, passed: 1, failed: 0 },
      trials: [{ runId: `run_${'5'.repeat(32)}`, attempt: 1 }],
      localSourceTransport: { commit: fixture.championRef },
    })
  })

  it('keeps process score optional and aggregates it only when the benchmark provides it', async () => {
    const withProcess = await setup('0.2.8', { processScore: 0.5 })
    const processEvidence = await withProcess.evaluator.evaluate(
      round(withProcess.fixture.root, withProcess.fixture.championRef, withProcess.fixture.manifest.digest),
      request('seed', withProcess.fixture.championRef),
      new AbortController().signal,
    )
    expect(processEvidence).toMatchObject({
      primaryReward: 1,
      processScore: 0.5,
      summary: { score: 1, process: { score: 0.5 }, metrics: { totalScore: 1, processScore: 0.5 } },
      trials: [{ scores: { totalScore: 1, processScore: 0.5, normalization: 'standard' },
        originalResult: { scores: { total_score: 1, process_score: 0.5 }, verifier_result_ref: 'verifier/result.json' } }],
    })

    const totalOnly = await setup('0.2.8')
    const totalOnlyEvidence = await totalOnly.evaluator.evaluate(
      round(totalOnly.fixture.root, totalOnly.fixture.championRef, totalOnly.fixture.manifest.digest),
      request('seed', totalOnly.fixture.championRef),
      new AbortController().signal,
    )
    expect(totalOnlyEvidence.processScore).toBeUndefined()
    expect(totalOnlyEvidence.summary.process).toBeUndefined()
    expect(totalOnlyEvidence.trials[0]?.scores?.processScore).toBeUndefined()
  })

  it('reserves a Hitch eval id and binds the invocation/result to it', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    const input = request('seed', fixture.championRef)
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
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

  it('accepts stable task-slot plans in direct CLI mode', async () => {
    const { fixture, evaluator } = await setup('0.2.5', { attemptExecution: 'harbor-task-slots-v1' })
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
      new AbortController().signal,
    )).resolves.toMatchObject({ provider: 'hitch-cli', completeness: 'complete' })
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['non-one', '0'],
  ] as const)('forces Python bytecode off for direct eval and invalid rerun when the parent value is %s', async (_case, inherited) => {
    const originalBytecodeSetting = process.env.PYTHONDONTWRITEBYTECODE
    const originalSentinel = process.env.GEAR_HITCH_ENV_SENTINEL
    const sentinel = `preserved-${_case}`
    try {
      if (inherited === undefined) delete process.env.PYTHONDONTWRITEBYTECODE
      else process.env.PYTHONDONTWRITEBYTECODE = inherited
      process.env.GEAR_HITCH_ENV_SENTINEL = sentinel

      const { fixture, evaluator, environmentLog } = await setup()
      const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
      const input = request('seed', fixture.championRef)
      const evidence = await evaluator.evaluate(state, input, new AbortController().signal)
      const attempt: RoundEvaluationAttempt = {
        provider: 'hitch-cli', evalId: evidence.evalId, phase: input.phase,
        owner: { candidateId: `champion-${fixture.championRef}`, role: 'baseline', harnessRef: fixture.championRef },
        conditionId: input.condition.conditionId, dataset: input.dataset,
        requestedModelId: input.condition.model, requestedCommit: fixture.championRef,
        status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        failure: { code: 'hitch_infrastructure_failure', message: 'invalid task' },
      }
      await evaluator.rerun(state, input, attempt, { mode: 'invalid' }, new AbortController().signal)

      const environments = (await readFile(environmentLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
        args: string[]
        pythonDontWriteBytecode: string | null
        sentinel: string | null
      })
      const launched = environments.filter(({ args }) => args[0] === 'eval' && ['run', 'rerun'].includes(args[1]!))
      expect(launched.map(({ args }) => args[1])).toEqual(['run', 'rerun'])
      expect(launched.every(environment => environment.pythonDontWriteBytecode === '1')).toBe(true)
      expect(launched.every(environment => environment.sentinel === sentinel)).toBe(true)
      expect(process.env.PYTHONDONTWRITEBYTECODE).toBe(inherited)
      expect(process.env.GEAR_HITCH_ENV_SENTINEL).toBe(sentinel)
    } finally {
      if (originalBytecodeSetting === undefined) delete process.env.PYTHONDONTWRITEBYTECODE
      else process.env.PYTHONDONTWRITEBYTECODE = originalBytecodeSetting
      if (originalSentinel === undefined) delete process.env.GEAR_HITCH_ENV_SENTINEL
      else process.env.GEAR_HITCH_ENV_SENTINEL = originalSentinel
    }
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
    const reservation = await evaluator.reserve(state, input, undefined, evaluator.prepareSubmission(state, input))
    const initial = await evaluator.evaluate(state, input, new AbortController().signal, reservation)
    const attempt: import('../../src/types.js').RoundEvaluationAttempt = {
      provider: 'hitch-cli', evalId: reservation.evalId, phase: 'seed-baseline',
      owner: { candidateId: `champion-${fixture.championRef}`, role: 'baseline', harnessRef: fixture.championRef },
      conditionId: input.condition.conditionId, dataset: input.dataset,
      requestedModelId: input.condition.model, requestedCommit: fixture.championRef,
      status: 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      failure: { code: 'hitch_infrastructure_failure', message: 'invalid task' },
    }
    const rerunReservation = evaluator.prepareRerun(state, input, attempt, { mode: 'invalid' })!
    await expect(evaluator.rerun(state, input, attempt, { mode: 'invalid' }, new AbortController().signal, rerunReservation)).resolves.toMatchObject({
      provider: 'hitch-cli', evalId: reservation.evalId, evalStatus: 'succeeded',
      evidence: {
        effectiveConfigDigest: initial.effectiveConfigDigest,
        invocationFingerprint: initial.invocationFingerprint,
      },
    })
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(invocations).toContainEqual([
      'eval', 'rerun', reservation.evalId, '--invalid', '--type', 'candidate-restart', '--daemon', '--rerun-id', rerunReservation.rerunId, '--output', 'json',
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
        invalidTrials: [{ taskName: 'task-1', attempt: 1, invalidReason: 'infrastructure_failure',
          originalResult: { observation_status: 'invalid', invalid_reason: 'infrastructure_failure', verifier_result_ref: 'verifier/result.json' } }],
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
    expect(evidence.trials[0]?.originalResult).toMatchObject({ task_name: 'task-1', rewards: { reward: 1 } })
  })

  it('reads bounded Hitch analysis and source-paged events', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    await expect(evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)).resolves.toMatchObject({
      runId,
      source: {
        fidelity: 'provider_native', sessionId: 'session-1', canonicalSha256: `sha256:${'a'.repeat(64)}`,
        eventCount: 3, eventTypes: { 'tool/result': 1, 'assistant/message': 1, 'turn/end': 1 },
      },
      surface: { currentNodeSeqs: [0, 1] },
      coverage: { surface: 'complete', chunks: 'omitted', content: 'complete' },
    })
    await expect(evaluator.inspectTrajectoryEvents(runId, {
      eventTypes: ['turn/end', 'assistant/message', 'assistant/message'], seqStart: 1, seqEnd: 2, limit: 2,
    }, new AbortController().signal)).resolves.toMatchObject({
      runId, canonicalSha256: `sha256:${'a'.repeat(64)}`,
      filter: { eventTypes: ['assistant/message', 'turn/end'], seqStart: 1, seqEnd: 2 },
      events: [{ type: 'assistant/message', seq: 1 }, { type: 'turn/end', seq: 2 }], totalMatches: 2, eof: true,
    })
  })

  it('preserves Hitch structured trajectory error codes for actionable blockers', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stderr.write(JSON.stringify({
  schema_version: '1', kind: 'error',
  error: { code: 'trajectory_integrity_mismatch', message: 'canonical digest mismatch', exit_code: 3 },
}) + '\\n')
process.exitCode = 3
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectTrajectoryAnalysis(
      runId,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'trajectory_integrity_mismatch',
      message: expect.stringContaining('canonical digest mismatch'),
    })
  })

  it('accepts attempt zero and complete bounded excerpts for interrupted requests', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'6'.repeat(32)}`
    const payload = partialTrajectoryAnalysisPayload(runId)
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectTrajectoryAnalysis(
      runId,
      new AbortController().signal,
    )).resolves.toMatchObject({
      surface: { requestBoundaries: [{ attempt: 0 }] },
      chunkSummaries: [{
        attempt: 0,
        partial: {
          status: 'incomplete',
          content: { preview: 'incomplete answer', truncated: false, source: { runId, seq: 1 } },
        },
      }],
    })
  })

  it('reads independent unfinished streams from a timed-out model request', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'6'.repeat(32)}`
    const payload = multiStreamTrajectoryAnalysisPayload(runId)
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    const analysis = await evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)
    const partial = analysis.chunkSummaries[0]!.partial!
    expect(partial.content).toBeUndefined()
    expect(partial).toMatchObject({
      status: 'incomplete', sourceSeqCount: 5,
      streams: [
        { blockIndex: 0, blockStartSeq: 1, kind: 'reasoning', sourceSeqCount: 2,
          content: { preview: 'Checking the contact', source: { runId, seq: 1, field: 'data.chunk.delta' } } },
        { blockIndex: 1, blockStartSeq: 4, kind: 'tool_arguments', sourceSeqCount: 1,
          content: { preview: '{"contact_id":7}', source: { runId, seq: 4, field: 'data.chunk.delta' } } },
        { blockIndex: 2, blockStartSeq: 6, kind: 'tool_arguments', sourceSeqCount: 2,
          content: { preview: '{"phone":"123', source: { runId, seq: 6, field: 'data.chunk.delta' } } },
      ],
    })
    expect(analysis.coverage).toMatchObject({ surface: 'complete', chunks: 'partial', content: 'complete' })
  })

  it.each(['content', 'streams'] as const)('accepts multiple source fragments per chunk in partial %s', async representation => {
    const { evaluator } = await setup()
    const runId = `run_${'6'.repeat(32)}`
    // Hitch counts text and argumentsDelta independently when a tool-call
    // delta contains both. Source fragments can outnumber chunk events.
    const streams = multiStreamTrajectoryAnalysisPayload(runId).chunk_summaries[0]!.partial.streams.slice(0, 2)
      .map(stream => ({ ...stream, kind: 'tool_arguments', source_seq_count: 4 }))
    const count = representation === 'content' ? 4 : 6
    const sourceCount = representation === 'content' ? 6 : 8
    const base = partialTrajectoryAnalysisPayload(runId)
    const payload = {
      ...base,
      source: { ...base.source, event_count: count + 1, event_types: { 'user/message': 1, 'assistant/chunk': count } },
      chunk_summaries: [{
        turn: 1, step: 1, attempt: 0, first_seq: 1, last_seq: count, count, model_boundary_seq: 1,
        types: { 'block-start': count - sourceCount / 2, 'tool-call-delta': sourceCount / 2 },
        partial: { status: 'incomplete', source_seq_count: sourceCount,
          ...(representation === 'content' ? { content: base.chunk_summaries[0]!.partial.content } : { streams }) },
      }],
      omitted_event_types: { 'assistant/chunk': count },
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    const analysis = await evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)
    expect(analysis.chunkSummaries[0]!.partial!.sourceSeqCount).toBe(sourceCount)
    expect(analysis.chunkSummaries[0]!.partial!.streams?.length).toBe(representation === 'content' ? undefined : 2)
  })

  it.each([
    ['both representations', (partial: ReturnType<typeof multiStreamTrajectoryAnalysisPayload>['chunk_summaries'][number]['partial']) => { Object.assign(partial, { content: partial.streams[0]!.content }) }],
    ['neither representation', (partial) => { Reflect.deleteProperty(partial, 'streams') }],
    ['only one stream', (partial) => { partial.streams.splice(1) }],
    ['unknown stream field', (partial) => { Object.assign(partial.streams[0]!, { unrecognized: true }) }],
    ['unknown partial field', (partial) => { Object.assign(partial, { unrecognized: true }) }],
    ['negative block index', (partial) => { partial.streams[0]!.block_index = -1 }],
    ['unknown stream kind', (partial) => { partial.streams[0]!.kind = 'audio' }],
    ['foreign run', (partial) => { partial.streams[0]!.content.source.run_id = `run_${'7'.repeat(32)}` }],
    ['mismatched source sequence', (partial) => { partial.streams[0]!.content.source.seq = 2 }],
    ['out-of-range block sequence', (partial) => { partial.streams[2]!.block_start_seq = 9; partial.streams[2]!.content.source.seq = 9 }],
    ['wrong source field', (partial) => { partial.streams[0]!.content.source.field = 'data.other' }],
    ['inconsistent total source count', (partial) => { partial.source_seq_count = 4 }],
    ['negative source count', (partial) => { partial.streams[0]!.source_seq_count = -1 }],
    ['unordered streams', (partial) => { partial.streams.reverse() }],
    ['duplicate stream source', (partial) => { partial.streams[1]!.block_start_seq = 1; partial.streams[1]!.content.source.seq = 1 }],
  ] satisfies Array<[string, (partial: ReturnType<typeof multiStreamTrajectoryAnalysisPayload>['chunk_summaries'][number]['partial']) => void]>)('rejects malformed unfinished streams: %s', async (_name, corrupt) => {
    const { evaluator } = await setup()
    const runId = `run_${'6'.repeat(32)}`
    const payload = multiStreamTrajectoryAnalysisPayload(runId)
    corrupt(payload.chunk_summaries[0]!.partial)
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    await expect(evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_hitch_result' })
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

  it('reads a maximally escaped bounded verifier diagnostic page', async () => {
    const { evaluator, invocationLog } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const page = await evaluator.inspectVerifierDiagnosticPage(runId, {
      name: 'test-stdout.txt', offset: 0, limit: 64 * 1024,
    }, new AbortController().signal)
    const content = '\u0000'.repeat(64 * 1024)
    expect(page).toEqual({
      schemaVersion: 1,
      kind: 'verifier-diagnostic-page',
      runId,
      artifact: {
        name: 'test-stdout.txt', mediaType: 'text/plain', bytes: Buffer.byteLength(content),
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        sourceComplete: true,
      },
      page: { offset: 0, bytes: Buffer.byteLength(content), text: content, eof: true },
    })
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(invocations).toContainEqual([
      'verifier', 'artifact', runId, 'test-stdout.txt', '--offset', '0', '--limit', '65536', '--json',
    ])
  })

  it('accepts a terminal empty page for a permanently incomplete verifier source', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const page = await evaluator.inspectVerifierDiagnosticPage(runId, {
      name: 'test-stderr.txt', offset: 0, limit: 64 * 1024,
    }, new AbortController().signal)
    expect(page).toMatchObject({
      runId,
      artifact: {
        name: 'test-stderr.txt', bytes: 64 * 1024,
        sourceComplete: false, lossReason: 'legacy_truncated',
      },
      page: { offset: 0, bytes: 0, text: '', eof: true },
    })
  })

  it('reads structured process evidence without inventing feedback', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const process = {
      schema_version: '1', metric: 'partial_credit', score: 0.5, detail_status: 'components',
      passed: 1, total: 2, excluded: 0,
      components: [
        { id: 'assertion-001', category: 'email.sent', status: 'passed', weight: 1 },
        { id: 'assertion-002', category: 'email.body', status: 'failed', weight: 1 },
      ],
    }
    const payload = {
      schema_version: '1', kind: 'verifier-evidence', run_id: runId,
      observation: { status: 'valid', reward: 0, verifier_result_ref: 'verifier/result.json' },
      verifier: {
        status: 'result_only',
        result: { rewards: { reward: 0, total_score: 0, process_score: 0.5 } },
        result_sha256: `sha256:${'8'.repeat(64)}`,
        scores: { total_score: 0, process_score: 0.5, normalization: 'standard' },
        process,
        structured_artifacts: {
          process: { ref: 'verifier/process.json', bytes: 512, sha256: `sha256:${'7'.repeat(64)}` },
        },
      },
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload))})
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectVerifierEvidence(runId, new AbortController().signal)).resolves.toMatchObject({
      verifier: {
        scores: { totalScore: 0, processScore: 0.5, normalization: 'standard' },
        process: {
          schemaVersion: 1, metric: 'partial_credit', score: 0.5, detailStatus: 'components',
          components: [{ id: 'assertion-001', status: 'passed' }, { id: 'assertion-002', status: 'failed' }],
        },
      },
    })
    const evidence = await evaluator.inspectVerifierEvidence(runId, new AbortController().signal)
    expect(evidence.verifier.feedback).toBeUndefined()
  })

  it('requires complete detail readback for parsed result_only feedback before diagnosing a failed run', async () => {
    const { evaluator } = await setup()
    const state = roundFixture({ status: 'candidate-editing' })
    const baseline = evidenceFixture(state.plan.seed, state.targetHarnessRef, 0)
    state.baseline = baseline
    const runId = baseline.trials[0]!.runId!
    const message = `${'Verifier context. '.repeat(1_200)}ACTION REQUIRED: notify the recipient.`
    const feedback = { schema_version: '1', items: [{ code: 'missing-notification', severity: 'error', message }] }
    const result = { rewards: { reward: 0, total_score: 0 } }
    const sha256 = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
    const payload = {
      schema_version: '1', kind: 'verifier-evidence', run_id: runId,
      observation: { status: 'valid', reward: 0, verifier_result_ref: 'verifier/result.json' },
      verifier: {
        status: 'result_only', result, result_sha256: sha256(result),
        scores: { total_score: 0, normalization: 'standard' }, feedback,
        structured_artifacts: { feedback: {
          ref: 'verifier/feedback.json', bytes: Buffer.byteLength(JSON.stringify(feedback)), sha256: sha256(feedback),
        } },
      },
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload))})
`)
    const receipts: DiagnosisReceipt[] = []
    const meta = {
      recordEvidenceAccess: (_roundId: string, _sessionId: string, access: { diagnosisReceipts?: DiagnosisReceipt[] }) => {
        receipts.push(...(access.diagnosisReceipts ?? []))
      },
      proposalEvidenceAudit: () => ({ summaryAccessed: true, accessedRefs: [baseline.evalId],
        diagnosedRunRefs: [], citedRefs: [], diagnosisReceipts: receipts }),
    }
    const service = { activeEntryForSession: () => ({ evolutionId: state.evolutionId, roundId: state.roundId,
      parentHarnessRef: state.targetHarnessRef, workspace: {}, baseline, meta,
      store: { listRounds: async () => [state] } }) }
    const capabilities = new RefineCapabilities(service as never, {} as never, {
      maxTrajectoryPageBytes: 4096,
      trajectoryReader: {
        inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }),
        inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
          { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Notify the recipient.' }] } },
        ]),
        inspectTrajectoryEvents: async () => { throw new Error('verifier detail must use the recorded artifact') },
        inspectVerifierEvidence: (id, signal) => evaluator.inspectVerifierEvidence(id, signal),
      },
    })
    const card = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as {
      runs: MetaFailureCard[]
    }
    expect(card).toMatchObject({
      runs: [{ verifier: { status: 'result_only', feedback: { truncated: true }, needsDetail: true } }],
      diagnosisProgress: { ready: false, diagnosed: 0 },
    })
    expect(renderTrajectoryResult(card as unknown as Parameters<typeof renderTrajectoryResult>[0])).not.toContain('ACTION REQUIRED')
    expect(receipts).toHaveLength(0)
    const detailRef = card.runs[0]!.verifier.detailRef!
    const found = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef, find: 'ACTION REQUIRED' })
    expect(found).toMatchObject({ detail: { matches: [expect.stringContaining('ACTION REQUIRED')] } })
    expect(receipts).toHaveLength(0)
    let nextRef: string | undefined = detailRef
    let text = ''
    while (nextRef !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: nextRef }) as {
        detail: { text: string }; nextRef?: string
      }
      text += page.detail.text
      nextRef = page.nextRef
      expect(receipts).toHaveLength(nextRef === undefined ? 1 : 0)
    }
    expect(text).toContain(message)
    expect(receipts[0]).toMatchObject({ runId, verifierStatus: 'result_only' })
    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', {})).resolves.toMatchObject({
      diagnosisProgress: { ready: true, diagnosed: 1 },
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

  it('turns Hitch verifier corruption envelopes into explicit corrupt evidence', async () => {
    const { evaluator } = await setup()
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
process.stderr.write(JSON.stringify({
  schema_version: '1', kind: 'error',
  error: { code: 'verifier_evidence_corrupt', message: 'run record is corrupt', exit_code: 3 },
}) + '\\n')
process.exitCode = 3
`)
    await chmod(evaluator.options.executable, 0o755)
    await expect(evaluator.inspectVerifierEvidence(
      `run_${'5'.repeat(32)}`,
      new AbortController().signal,
    )).resolves.toMatchObject({
      verifier: { status: 'corrupt', issues: [expect.stringContaining('run record is corrupt')] },
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

  it('loads and caches the bounded analysis once per run', async () => {
    const { evaluator } = await setup()
    const runId = `run_${'5'.repeat(32)}`
    const loaded = await evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)
    expect(loaded).toMatchObject({
      runId,
      source: { canonicalSha256: `sha256:${'a'.repeat(64)}`, eventCount: 3 },
      events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
    })
    await writeFile(evaluator.options.executable, '#!/usr/bin/env node\nprocess.stdout.write("invalid-json\\n")\n')
    await expect(evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)).resolves.toEqual(loaded)
  })

  it('keeps a shared trajectory load alive when only one waiter aborts', async () => {
    const { fixture, evaluator } = await setup()
    const counter = join(fixture.root, 'trajectory-invocations.txt')
    const runId = `run_${'7'.repeat(32)}`
    const payload = trajectoryAnalysisPayload(runId, 'session-delayed')
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(counter)}, 'inspect\\n')
setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')}), 100)
`)
    await chmod(evaluator.options.executable, 0o755)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = evaluator.inspectTrajectoryAnalysis(runId, firstController.signal)
    const second = evaluator.inspectTrajectoryAnalysis(runId, secondController.signal)
    firstController.abort(new Error('first waiter cancelled'))
    await expect(first).rejects.toThrow(/first waiter cancelled/)
    await expect(second).resolves.toMatchObject({ runId, source: { sessionId: 'session-delayed' } })
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('does not retain a trajectory that exceeds the configured cache byte budget', async () => {
    const { fixture, evaluator } = await setup()
    const counter = join(fixture.root, 'trajectory-evictions.txt')
    const runId = `run_${'8'.repeat(32)}`
    const payload = trajectoryAnalysisPayload(runId, 'session-uncached')
    evaluator.options.trajectoryCacheBytes = 1
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(counter)}, 'inspect\\n')
process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')})
`)
    await chmod(evaluator.options.executable, 0o755)
    await evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)
    await evaluator.inspectTrajectoryAnalysis(runId, new AbortController().signal)
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
      message: expect.stringMatching(/failed \(harbor_failed\).*2\/5/u),
    })
  })

  it.each([
    ['preparing failure without result identities', {}, 12, 'internal_error', /runtime payload rule is missing/u],
    ['unsupported schema', { schema_version: '999' }, 12, 'unsupported_hitch_schema', /unsupported Hitch eval schema/u],
    ['invalid eval identity', { eval_id: 'invalid' }, 12, 'invalid_hitch_result', /invalid Hitch eval_id/u],
    ['process exit mismatch', {}, 1, 'hitch_evaluation_failed', /process\/result exit mismatch/u],
    ['failed evidence for another dataset', { dataset: 'another-dataset', trials: [{}] }, 12, 'hitch_evaluation_failed', /dataset does not match/u],
    ['successful evidence for another dataset', { status: 'succeeded', exit_code: 0, dataset: 'another-dataset', trials: [{}] }, 0, 'hitch_evaluation_failed', /dataset does not match/u],
  ])('rejects %s without accepting unrelated evidence', async (_label, override, processExit, code, message) => {
    const { fixture, evaluator } = await setup()
    const payload = {
      schema_version: '1', eval_id: `eval_${'1'.repeat(32)}`,
      status: 'failed', exit_code: 12, failure_stage: 'preparing', trials: [],
      error: { code: 'internal_error', message: 'runtime payload rule is missing: node_modules/smol-toml' },
      ...override,
    }
    await writeFile(evaluator.options.executable, `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('0.2.8')
else {
  process.stdout.write(${JSON.stringify(JSON.stringify(payload))})
  process.exitCode = ${processExit}
}
`)
    await expect(evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      request('seed', fixture.championRef),
      new AbortController().signal,
    )).rejects.toMatchObject({ code, message: expect.stringMatching(message) })
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
