import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js';
import type { HitchConfig } from '../../src/config.js';
import type { createGitHarnessFixture } from './git-fixture.js';

type GitFixture = Awaited<ReturnType<typeof createGitHarnessFixture>>;
export type RecordedHitchScoreFile = { path: string;
  rules: Array<{ contains: string; rewardByTask: Record<string, number> }> };

/** Recorded daemon CLI with one durable eval/run identity per original idempotency key. */
export async function createMultiRecordedHitchCliFixture(fixture: GitFixture, rewardsByTask: Record<string, number> = {},
  controlPlane: HitchConfig['controlPlane'] = { mode: 'daemon', requireModelCapture: false },
  scoreFile?: RecordedHitchScoreFile) {
  if (scoreFile && (!/^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/u.test(scoreFile.path)
    || scoreFile.path.split('/').includes('..') || scoreFile.rules.length === 0
    || scoreFile.rules.some(rule => !rule.contains))) throw new Error('Invalid recorded Hitch Git scoring rule');
  const executable = join(fixture.root, 'multi-hitch.mjs');
  const stateDir = join(fixture.root, 'multi-hitch-evals');
  const invocationLog = join(fixture.root, 'multi-hitch-invocations.jsonl');
  await mkdir(stateDir, { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, openSync, closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const stateDir = ${JSON.stringify(stateDir)}
const log = ${JSON.stringify(invocationLog)}
const rewardMap = ${JSON.stringify(rewardsByTask)}
const scoreFile = ${JSON.stringify(scoreFile ?? null)}
const repository = ${JSON.stringify(fixture.repository)}
appendFileSync(log, JSON.stringify(args) + '\\n')
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const sha = text => createHash('sha256').update(text).digest('hex')
const canonical = input => Array.isArray(input) ? '[' + input.map(canonical).join(',') + ']'
  : input && typeof input === 'object' ? '{' + Object.keys(input).sort().map(key => JSON.stringify(key) + ':' + canonical(input[key])).join(',') + '}'
  : JSON.stringify(input)
const saved = () => readdirSync(stateDir).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join(stateDir, name), 'utf8')))
const byEval = evalId => saved().find(item => item.evalId === evalId)
const rewardFor = (commit, taskId) => {
  if (scoreFile) {
    const file = spawnSync('git', ['-C', repository, 'show', commit + ':' + scoreFile.path], { encoding: 'utf8' })
    if (file.status !== 0) throw Error('recorded scoring file unavailable in submitted Git commit')
    for (const rule of scoreFile.rules) if (file.stdout.includes(rule.contains)
      && Object.hasOwn(rule.rewardByTask, taskId)) return Number(rule.rewardByTask[taskId])
  }
  return Number(rewardMap[taskId] ?? 0)
}
const write = item => {
  const path = join(stateDir, sha(item.key) + '.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  const fd = openSync(path, 'wx', 0o600)
  try { const bytes = Buffer.from(JSON.stringify(item)); let at = 0
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at) }
  finally { closeSync(fd) }
  return item
}
const taskOf = dataset => {
  const manifest = JSON.parse(readFileSync(join(dataset, 'benchmark.adapter.json'), 'utf8'))
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== 1) throw Error('expected one projected task')
  return manifest.tasks[0].task_id
}
const execution = { provider: 'local-docker', max_parallelism: 2,
  resources: { default_trial: { cpu_millis: 1000, memory_bytes: 1073741824, container_slots: 1, build_slots: 0 } },
  build: { mode: 'prebuild-preferred' }, model_capture: { mode: 'native', required: false } }
const inspect = item => {
  const request = item.request, evalId = item.evalId, commit = item.commit, taskId = item.taskId
  const score = item.reward, started = '2026-01-01T00:00:00.000Z'
  const submission = { schema_version: '1', eval_id: evalId, request, execution,
    submission_digest: 'sha256:' + sha(canonical({ request, execution })),
    idempotency_key_hash: 'sha256:' + sha(item.key), submitted_at: started }
  const result = { schema_version: '1', eval_id: evalId, status: 'succeeded', exit_code: 0,
    candidate: { harness_ref: 'deepseek@commit:' + commit, revision_identity: 'sha256:' + '2'.repeat(64) },
    dataset: request.dataset,
    trials: [{ trial_id: 'trial-1', run_id: item.runId, task_id: taskId, attempt: 1,
      observation_status: 'valid', reward: score,
      scores: { total_score: score, process_score: score, normalization: 'standard' },
      verifier_result_ref: 'verifier/result.json' }],
    summary: { n_trials: 1, n_completed: 1, n_invalid: 0, primary_reward: score,
      rewards: { reward: { count: 1, mean: score } } },
    local_source_transport: { kind: 'local-git-commit', resolution_identity: 'sha256:' + '2'.repeat(64),
      commit, tree: '3'.repeat(40), payload_sha256: 'sha256:' + '4'.repeat(64), payload_bytes: 100 },
    started_at: started, completed_at: started }
  const plan = { schema_version: '1', eval_id: evalId, backend: 'harbor', dataset: request.dataset,
    benchmark_id: 'benchmark-1', benchmark_revision: 'revision-1', attempts: 1,
    attempt_execution: 'harbor-attempt-shards-v1', tasks: [taskId],
    candidate: { requested_harness_ref: request.harness_ref, harness_ref: 'deepseek@commit:' + commit,
      harness_id: 'deepseek', revision_identity: 'sha256:' + '2'.repeat(64) } }
  return { schema_version: '1', eval_id: evalId, request, submission, plan,
    control: { schema_version: '1', eval_id: evalId, state: 'succeeded' }, result }
}
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
if (args[0] === '--version') process.stdout.write('0.2.8\\n')
else if (args[0] === 'daemon' && args[1] === 'status') emit({ schema_version: '1', status: 'running',
  resource_policy: { eval_trial: { cpu_millis: 1000, memory_bytes: 1073741824, container_slots: 1, build_slots: 0 } } })
else if (args[0] === 'capabilities') emit({ schema_version: '1', trajectory_analysis: '1',
  trajectory_events_page: '1', verifier_evidence: '1', verifier_diagnostic_pages: '1' })
else if (args[0] === 'eval' && args[1] === 'submit') {
  const key = value('--idempotency-key'), dataset = value('--dataset'), harness = value('--harness')
  if (!/^gear-eval-v1-[0-9a-f]{64}$/.test(key ?? '') || !dataset || !harness) throw Error('bad submission')
  const commit = harness.match(/#([0-9a-f]{40})$/)?.[1]
  if (!commit) throw Error('bad harness commit')
  const taskId = taskOf(dataset), keyHash = sha(key)
  const request = { schema_version: '1', backend: 'harbor', dataset, harness_ref: harness,
    model: value('--model') ?? '', attempts: Number(value('--attempts')),
    max_concurrent: Number(value('--max-concurrent')), infrastructure_retries: 0,
    infrastructure_retry_backoff_ms: 0, timeout_ms: Number(value('--timeout')?.replace('ms', '')),
    setup_timeout_ms: Number(value('--setup-timeout')?.replace('ms', '')),
    agent_args: args.flatMap((arg, i) => arg === '--agent-arg' ? [args[i + 1]] : []),
    pass_env: args.flatMap((arg, i) => arg === '--pass-env' ? [args[i + 1]] : []),
    benchmark_id: 'benchmark-1', benchmark_revision: 'revision-1' }
  const priorPath = join(stateDir, keyHash + '.json')
  const item = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : write({ key, evalId: 'eval_' + keyHash.slice(0, 32),
    runId: 'run_' + sha(key + ':run').slice(0, 32), taskId, commit, request,
    reward: rewardFor(commit, taskId) })
  if (canonical(item.request) !== canonical(request)) throw Error('idempotency key request drift')
  emit({ schema_version: '1', eval_id: item.evalId, status: 'queued' })
} else if (args[0] === 'eval' && args[1] === 'list') emit({ schema_version: '1',
  evals: saved().map(item => ({ eval_id: item.evalId })) })
else if (args[0] === 'eval' && args[1] === 'inspect') {
  const item = byEval(args[2]); if (!item) throw Error('unknown eval')
  emit(inspect(item))
} else if (args[0] === 'eval' && args[1] === 'watch') {
  const item = byEval(args[2]); if (!item) throw Error('unknown eval')
  emit(inspect(item).result)
} else if (args[0] === 'trajectory' && args[1] === 'project') {
  const runId = args[2]
  if (!saved().some(item => item.runId === runId)) throw Error('unknown run')
  emit({ schema_version: '1', kind: 'trajectory-analysis', run_id: runId,
    source: { fidelity: 'provider_native', provider: 'deepseek', session_id: 'session-1',
      canonical_sha256: 'sha256:' + 'a'.repeat(64), canonical_bytes: 300, event_count: 3,
      event_types: { 'tool/result': 1, 'assistant/message': 1, 'turn/end': 1 } },
    header: { type: 'session', version: 1, id: 'session-1', createdAt: 1, delegationDepth: 0 },
    surface: { fidelity: 'exact', nodes: [
      { seq: 0, event_type: 'tool/result', surface_op: 'append', message: { content: [{ isError: true }] } },
      { seq: 1, event_type: 'assistant/message', surface_op: 'append', message: { content: [{ type: 'text', text: 'done' }] } },
    ], current_node_seqs: [0, 1], replacements: [], request_boundaries: [], request_headers: [] },
    events: [ { type: 'tool/result', seq: 0, time: 10, data: { surface_node_seq: 0 } },
      { type: 'assistant/message', seq: 1, time: 11, data: { surface_node_seq: 1 } },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1 } } ],
    chunk_summaries: [], omitted_event_types: {},
    coverage: { surface: 'complete', chunks: 'omitted', content: 'complete', child_sessions: 'unavailable' } })
} else if (args[0] === 'trajectory' && args[1] === 'events') {
  const runId = args[2]
  if (!saved().some(item => item.runId === runId)) throw Error('unknown run')
  const all = [{ type: 'tool/result', seq: 0, time: 10, data: { message: { content: [{ isError: true }] } } },
    { type: 'assistant/message', seq: 1, time: 11, data: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1 } }]
  const types = args.includes('--types') ? value('--types').split(',') : undefined
  const start = args.includes('--seq-start') ? Number(value('--seq-start')) : 0
  const end = args.includes('--seq-end') ? Number(value('--seq-end')) : Number.MAX_SAFE_INTEGER
  const matches = all.filter(item => (!types || types.includes(item.type)) && item.seq >= start && item.seq <= end)
  const limit = Number(value('--limit')), page = matches.slice(0, limit)
  emit({ schema_version: '1', kind: 'trajectory-events-page', run_id: runId,
    canonical_sha256: 'sha256:' + 'a'.repeat(64), filter: {
      ...(types ? { types } : {}), ...(args.includes('--seq-start') ? { seq_start: start } : {}),
      ...(args.includes('--seq-end') ? { seq_end: end } : {}) },
    events: page, total_matches: matches.length, eof: page.length >= matches.length,
    ...(page.length < matches.length ? { next_cursor: 'cursor-1' } : {}) })
} else { process.stderr.write('unsupported recorded Hitch command: ' + JSON.stringify(args)); process.exitCode = 9 }
`);
  await chmod(executable, 0o755);
  const evaluator = new HitchCliEvaluator({ executable, harnessId: 'deepseek', root: '', model: 'deepseek-chat',
    attempts: 1, maxConcurrent: 2, setupTimeoutMs: 10_000, terminationGraceMs: 100,
    maxOutputBytes: 1024 * 1024, maxTrajectoryOutputBytes: 1024 * 1024, sampling: {},
    agentArgs: [], passEnv: [], controlPlane, repositoryPath: fixture.repository });
  return { evaluator, executable, stateDir, invocationLog };
}
