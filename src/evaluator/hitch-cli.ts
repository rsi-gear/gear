import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HitchConfig } from '../config.js'
import type {
  EvaluationRequest,
  HitchEvaluationEvidence,
  HitchTrajectoryPage,
  HitchTrajectoryReader,
  HitchTrialSummary,
  LocalSourceTransportSummary,
  RefineEvaluator,
  RefinementRound,
  ScoreSummary,
} from '../types.js'
import { isExactGitCommit } from '../types.js'

export interface HitchCliEvaluatorOptions extends HitchConfig {
  repositoryPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

type JsonRecord = Record<string, unknown>

export class HitchEvaluationError extends Error {
  constructor(message: string, readonly code = 'hitch_evaluation_failed') {
    super(message)
    this.name = 'HitchEvaluationError'
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HitchEvaluationError(`${label} must be an object`, 'invalid_hitch_result')
  }
  return value as JsonRecord
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HitchEvaluationError(`${label} must be a non-empty string`, 'invalid_hitch_result')
  }
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HitchEvaluationError(`${label} must be a finite number`, 'invalid_hitch_result')
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HitchEvaluationError(`${label} must be a non-negative integer`, 'invalid_hitch_result')
  }
  return value as number
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function rewardForTrial(rewards: Record<string, number>): number | undefined {
  if (rewards.reward !== undefined) return rewards.reward
  return Object.values(rewards)[0]
}

export class HitchCliEvaluator implements RefineEvaluator, HitchTrajectoryReader {
  readonly repositoryPath: string

  constructor(readonly options: HitchCliEvaluatorOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    if (options.executable.length === 0) throw new TypeError('hitch.executable must not be empty')
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(options.harnessId)) throw new TypeError('hitch.harnessId is invalid')
    if (!Number.isSafeInteger(options.attempts) || options.attempts <= 0) throw new TypeError('hitch.attempts must be a positive integer')
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0) throw new TypeError('hitch.maxConcurrent must be a positive integer')
    if (!Number.isSafeInteger(options.setupTimeoutMs) || options.setupTimeoutMs < 0) throw new TypeError('hitch.setupTimeoutMs must be non-negative')
    if (!Number.isSafeInteger(options.terminationGraceMs) || options.terminationGraceMs < 0) throw new TypeError('hitch.terminationGraceMs must be non-negative')
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) throw new TypeError('hitch.maxOutputBytes must be positive')
    if (!Number.isSafeInteger(options.maxTrajectoryOutputBytes) || options.maxTrajectoryOutputBytes <= 0) {
      throw new TypeError('hitch.maxTrajectoryOutputBytes must be positive')
    }
    if (options.passEnv.some(name => !/^[A-Z_][A-Z0-9_]*$/u.test(name))) throw new TypeError('hitch.passEnv contains an invalid environment variable name')
  }

  async inspectTrajectory(
    runId: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryPage> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch trajectory requires a valid run ID')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('trajectory offset must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('trajectory limit must be a positive integer')
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'trajectory', 'inspect', runId, '--json',
    ]
    const processResult = await this.run(
      args,
      this.repositoryPath,
      signal,
      this.options.maxTrajectoryOutputBytes,
    )
    if (processResult.exitCode !== 0) {
      throw new HitchEvaluationError(
        `Hitch trajectory inspect failed for ${runId}: ${processResult.stderr.slice(-4000)}`,
        'hitch_trajectory_unavailable',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid trajectory JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const result = record(parsed, 'Hitch trajectory')
    if (result.schema_version !== '1' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch trajectory identity does not match the requested run', 'invalid_hitch_result')
    }
    const ref = record(result.ref, 'trajectory.ref')
    const fidelity = ref.fidelity
    if (fidelity !== 'provider_native' && fidelity !== 'normalized' && fidelity !== 'minimal') {
      throw new HitchEvaluationError('Hitch trajectory fidelity is invalid', 'invalid_hitch_result')
    }
    const header = record(result.header, 'trajectory.header')
    const sessionId = string(header.id, 'trajectory.header.id')
    if (!Array.isArray(result.events)) throw new HitchEvaluationError('trajectory.events must be an array', 'invalid_hitch_result')
    const events = result.events.map((event, index) => record(event, `trajectory.events[${index}]`))
    const page = events.slice(offset, offset + limit)
    return {
      runId,
      fidelity,
      ...(typeof ref.provider === 'string' && ref.provider.length > 0 ? { provider: ref.provider } : {}),
      sessionId,
      header: header as never,
      events: page as never[],
      offset,
      limit,
      total: events.length,
      eof: offset + page.length >= events.length,
    }
  }

  async evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
  ): Promise<HitchEvaluationEvidence> {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    const harness = `${this.options.harnessId}@${source}`
    const parity = {
      schemaVersion: 1,
      executable: this.options.executable,
      hitchRoot: this.options.root,
      repositoryPath: this.repositoryPath,
      backend: 'harbor',
      dataset: request.dataset,
      harnessId: this.options.harnessId,
      model: this.options.model,
      attempts: this.options.attempts,
      maxConcurrent: this.options.maxConcurrent,
      timeoutMs: round.taskBudgetMs,
      setupTimeoutMs: this.options.setupTimeoutMs,
      agentArgs: this.options.agentArgs,
      passEnv: this.options.passEnv,
      sandboxProfileRef: round.sandboxProfileRef,
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'run',
      '--backend', 'harbor',
      '--dataset', request.dataset,
      '--harness', harness,
      ...(this.options.model.length === 0 ? [] : ['--model', this.options.model]),
      '--attempts', String(this.options.attempts),
      '--max-concurrent', String(this.options.maxConcurrent),
      '--timeout', `${round.taskBudgetMs}ms`,
      '--setup-timeout', `${this.options.setupTimeoutMs}ms`,
      ...this.options.agentArgs.flatMap(value => ['--agent-arg', value]),
      ...this.options.passEnv.flatMap(value => ['--pass-env', value]),
      '--output', 'json',
    ]
    const processResult = await this.run(args, round.workspaceRoot, signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid JSON (${String(error)}); stderr: ${processResult.stderr.slice(-4000)}`,
        'invalid_hitch_json',
      )
    }
    return this.parseResult(parsed, processResult, request, sha256(JSON.stringify(parity)))
  }

  private parseResult(
    value: unknown,
    processResult: ProcessResult,
    request: Readonly<EvaluationRequest>,
    invocationFingerprint: string,
  ): HitchEvaluationEvidence {
    const result = record(value, 'Hitch result')
    if (result.schema_version !== '1') throw new HitchEvaluationError('unsupported Hitch eval schema', 'unsupported_hitch_schema')
    const evalId = string(result.eval_id, 'eval_id')
    if (!/^eval_[0-9a-f]{32}$/u.test(evalId)) throw new HitchEvaluationError('invalid Hitch eval_id', 'invalid_hitch_result')
    const exitCode = integer(result.exit_code, 'exit_code')
    if (processResult.exitCode !== exitCode) {
      throw new HitchEvaluationError(`Hitch process/result exit mismatch: ${processResult.exitCode} != ${exitCode}`)
    }
    if (result.status !== 'succeeded' || exitCode !== 0) {
      const error = typeof result.error === 'object' && result.error !== null ? result.error as JsonRecord : {}
      throw new HitchEvaluationError(
        `Hitch eval ${evalId} failed (${String(error.code ?? result.status)}): ${String(error.message ?? processResult.stderr).slice(-4000)}`,
        typeof error.code === 'string' ? error.code : 'hitch_eval_failed',
      )
    }
    if (result.dataset !== request.dataset) throw new HitchEvaluationError('Hitch result dataset does not match the request')
    const candidate = record(result.candidate, 'candidate')
    const revisionIdentity = string(candidate.revision_identity, 'candidate.revision_identity')
    const lockedHarnessRef = string(candidate.harness_ref, 'candidate.harness_ref')
    const match = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)
    if (match?.[1] === undefined) throw new HitchEvaluationError('Hitch candidate does not contain a locked commit')
    const actualCommit = match[1]
    if (actualCommit !== request.harnessRef) {
      throw new HitchEvaluationError(`Hitch resolved ${actualCommit}, expected ${request.harnessRef}`, 'hitch_commit_mismatch')
    }
    const transport = this.parseTransport(result.local_source_transport)
    if (transport.commit !== request.harnessRef || transport.resolutionIdentity !== revisionIdentity) {
      throw new HitchEvaluationError('Hitch local source transport identity does not match the locked candidate', 'hitch_transport_mismatch')
    }
    const summaryValue = record(result.summary, 'summary')
    if (Array.isArray(result.trials)) {
      return this.parseRunCenteredResult(
        result,
        summaryValue,
        evalId,
        request,
        actualCommit,
        revisionIdentity,
        invocationFingerprint,
        transport,
      )
    }
    const total = integer(summaryValue.n_trials, 'summary.n_trials')
    const completed = integer(summaryValue.n_completed, 'summary.n_completed')
    const errored = integer(summaryValue.n_errored, 'summary.n_errored')
    const cancelled = integer(summaryValue.n_cancelled, 'summary.n_cancelled')
    if (total <= 0 || completed !== total || errored !== 0 || cancelled !== 0) {
      throw new HitchEvaluationError(
        `Hitch eval has incomplete trials: total=${total}, completed=${completed}, errored=${errored}, cancelled=${cancelled}`,
        'hitch_infrastructure_failure',
      )
    }
    const primaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
    const trials = this.parseTrials(summaryValue.trials)
    if (trials.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const summary: ScoreSummary = {
      total,
      passed,
      failed: total - passed,
      score: primaryReward,
      metrics: { primaryReward },
    }
    return {
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint,
      primaryReward,
      summary,
      trials,
      localSourceTransport: transport,
    }
  }

  private parseRunCenteredResult(
    result: JsonRecord,
    summaryValue: JsonRecord,
    evalId: string,
    request: Readonly<EvaluationRequest>,
    actualCommit: string,
    revisionIdentity: string,
    invocationFingerprint: string,
    transport: LocalSourceTransportSummary,
  ): HitchEvaluationEvidence {
    const total = integer(summaryValue.n_trials, 'summary.n_trials')
    const completed = integer(summaryValue.n_completed, 'summary.n_completed')
    const invalid = integer(summaryValue.n_invalid, 'summary.n_invalid')
    const trials = this.parseRunTrials(result.trials)
    if (trials.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
    const invalidTrials = (result.trials as JsonRecord[]).filter(trial => trial.observation_status !== 'valid')
    if (total <= 0 || completed !== total || invalid !== 0 || invalidTrials.length > 0) {
      const reasons = invalidTrials.map(trial => `${String(trial.trial_id)}:${String(trial.invalid_reason ?? 'invalid')}`).join(', ')
      throw new HitchEvaluationError(
        `Hitch eval has invalid run observations: total=${total}, completed=${completed}, invalid=${invalid}${reasons.length === 0 ? '' : ` (${reasons})`}`,
        'hitch_infrastructure_failure',
      )
    }
    const primaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const summary: ScoreSummary = {
      total,
      passed,
      failed: total - passed,
      score: primaryReward,
      metrics: { primaryReward },
    }
    return {
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint,
      primaryReward,
      summary,
      trials,
      localSourceTransport: transport,
    }
  }

  private parseRunTrials(value: unknown): HitchTrialSummary[] {
    if (!Array.isArray(value)) throw new HitchEvaluationError('trials must be an array', 'invalid_hitch_result')
    return value.map((item, index) => {
      const trial = record(item, `trials[${index}]`)
      const runId = string(trial.run_id, `trials[${index}].run_id`)
      if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new HitchEvaluationError(`trials[${index}].run_id is invalid`, 'invalid_hitch_result')
      const observation = string(trial.observation_status, `trials[${index}].observation_status`)
      const reward = observation === 'valid' ? finite(trial.reward, `trials[${index}].reward`) : 0
      const attempt = integer(trial.attempt, `trials[${index}].attempt`)
      if (attempt <= 0) throw new HitchEvaluationError(`trials[${index}].attempt must be positive`, 'invalid_hitch_result')
      return {
        taskName: string(trial.task_id, `trials[${index}].task_id`),
        trialName: string(trial.trial_id, `trials[${index}].trial_id`),
        runId,
        attempt,
        status: observation === 'valid' ? 'completed' : 'errored',
        rewards: { reward },
      }
    })
  }

  private parseTrials(value: unknown): HitchTrialSummary[] {
    if (!Array.isArray(value)) throw new HitchEvaluationError('summary.trials must be an array', 'invalid_hitch_result')
    return value.map((item, index) => {
      const trial = record(item, `summary.trials[${index}]`)
      const status = trial.status
      if (status !== 'completed') {
        throw new HitchEvaluationError(`summary.trials[${index}].status is invalid`, 'invalid_hitch_result')
      }
      const rewardsValue = record(trial.rewards, `summary.trials[${index}].rewards`)
      const rewards: Record<string, number> = {}
      for (const [name, reward] of Object.entries(rewardsValue)) rewards[name] = finite(reward, `trial reward ${name}`)
      const taskName = string(trial.task_name, `summary.trials[${index}].task_name`)
      const trialName = typeof trial.trial_name === 'string' && trial.trial_name.length > 0 ? trial.trial_name : undefined
      return { taskName, ...(trialName === undefined ? {} : { trialName }), status: 'completed', rewards }
    })
  }

  private parseTransport(value: unknown): LocalSourceTransportSummary {
    const transport = record(value, 'local_source_transport')
    if (transport.kind !== 'local-git-commit') {
      throw new HitchEvaluationError('Hitch result is missing local exact commit transport evidence', 'missing_hitch_transport')
    }
    const commit = string(transport.commit, 'local_source_transport.commit')
    const tree = string(transport.tree, 'local_source_transport.tree')
    if (!isExactGitCommit(commit) || !isExactGitCommit(tree)) {
      throw new HitchEvaluationError('Hitch transport commit/tree is not an exact Git OID', 'invalid_hitch_result')
    }
    const payloadSha256 = string(transport.payload_sha256, 'local_source_transport.payload_sha256')
    if (!/^sha256:[0-9a-f]{64}$/u.test(payloadSha256)) {
      throw new HitchEvaluationError('Hitch transport payload digest is invalid', 'invalid_hitch_result')
    }
    return {
      kind: 'local-git-commit',
      resolutionIdentity: string(transport.resolution_identity, 'local_source_transport.resolution_identity'),
      commit,
      tree,
      payloadSha256,
      payloadBytes: integer(transport.payload_bytes, 'local_source_transport.payload_bytes'),
    }
  }

  private run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    maxOutputBytes = this.options.maxOutputBytes,
  ): Promise<ProcessResult> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<ProcessResult>((resolvePromise, reject) => {
      const child = spawn(this.options.executable, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let overflow: 'stdout' | 'stderr' | undefined
      let killTimer: NodeJS.Timeout | undefined
      const append = (stream: 'stdout' | 'stderr', current: string, chunk: string): string => {
        const next = current + chunk
        if (Buffer.byteLength(next) > maxOutputBytes) {
          overflow = stream
          child.kill('SIGTERM')
          return next.slice(0, maxOutputBytes)
        }
        return next
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = append('stdout', stdout, chunk) })
      child.stderr.on('data', (chunk: string) => { stderr = append('stderr', stderr, chunk) })
      const terminate = (): void => {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), this.options.terminationGraceMs)
      }
      signal.addEventListener('abort', terminate, { once: true })
      child.once('error', error => {
        signal.removeEventListener('abort', terminate)
        if (killTimer !== undefined) clearTimeout(killTimer)
        reject(new HitchEvaluationError(`failed to start Hitch CLI: ${error.message}`, 'hitch_unavailable'))
      })
      child.once('exit', (code, childSignal) => {
        signal.removeEventListener('abort', terminate)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (signal.aborted) return reject(signal.reason)
        if (overflow !== undefined) {
          return reject(new HitchEvaluationError(`Hitch ${overflow} exceeded ${maxOutputBytes} bytes`, 'hitch_output_overflow'))
        }
        if (code === null) return reject(new HitchEvaluationError(`Hitch exited from signal ${childSignal ?? 'unknown'}`))
        resolvePromise({ stdout, stderr, exitCode: code })
      })
    })
  }
}
