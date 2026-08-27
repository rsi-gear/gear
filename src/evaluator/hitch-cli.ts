import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HitchConfig } from '../config.js'
import type {
  EvaluationRequest,
  EvaluationRerunResult,
  EvaluationRerunSelector,
  EvaluationReservation,
  EvaluationTrialSlot,
  HitchEvaluationEvidence,
  HitchTrajectoryPage,
  HitchTrajectoryReader,
  HitchTrialSummary,
  LocalSourceTransportSummary,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
  ScoreSummary,
  TrajectoryDiagnostics,
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

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new HitchEvaluationError(`${label} must be an array of non-empty strings`, 'invalid_hitch_result')
  }
  return [...value as string[]]
}

function trialSlots(value: unknown, label: string): EvaluationTrialSlot[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  return value.map((item, index) => {
    const slot = record(item, `${label}[${index}]`)
    const attempt = integer(slot.attempt, `${label}[${index}].attempt`)
    if (attempt <= 0) throw new HitchEvaluationError(`${label}[${index}].attempt must be positive`, 'invalid_hitch_result')
    return { taskId: string(slot.task_id, `${label}[${index}].task_id`), attempt }
  })
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function rewardForTrial(rewards: Record<string, number>): number | undefined {
  if (rewards.reward !== undefined) return rewards.reward
  return Object.values(rewards)[0]
}

function excerpt(value: unknown, maxBytes = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}…`
}

function containsToolError(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false
  if (Array.isArray(value)) return value.some(item => containsToolError(item, depth + 1))
  if (typeof value !== 'object') return false
  const item = value as JsonRecord
  if (item.isError === true || item.is_error === true) return true
  if (item.error !== undefined && item.error !== null && item.error !== false) return true
  return Object.values(item).some(child => containsToolError(child, depth + 1))
}

function trajectoryDiagnostics(events: JsonRecord[]): TrajectoryDiagnostics {
  const eventTypes: Record<string, number> = {}
  const errorExcerpts: TrajectoryDiagnostics['errorExcerpts'] = []
  const finalAssistantExcerpts: TrajectoryDiagnostics['finalAssistantExcerpts'] = []
  let toolCalls = 0
  let toolResults = 0
  let toolErrors = 0
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
    if (type === 'tool/call' || type === 'tool/code-dispatch-start') toolCalls += 1
    if (type === 'tool/result' || type === 'tool/code-dispatch') {
      toolResults += 1
      const data = typeof event.data === 'object' && event.data !== null ? event.data as JsonRecord : {}
      if (containsToolError(data)) {
        toolErrors += 1
        if (errorExcerpts.length < 20) errorExcerpts.push({
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
          type,
          excerpt: excerpt(data),
        })
      }
    }
    if (/error|failed|exception/iu.test(type) && errorExcerpts.length < 20) {
      errorExcerpts.push({
        ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        type,
        excerpt: excerpt(event.data),
      })
    }
    if (type === 'assistant/message') {
      finalAssistantExcerpts.push({
        ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        excerpt: excerpt(event.data),
      })
      if (finalAssistantExcerpts.length > 3) finalAssistantExcerpts.shift()
    }
  }
  return { totalEvents: events.length, eventTypes, toolCalls, toolResults, toolErrors, errorExcerpts, finalAssistantExcerpts }
}

export class HitchCliEvaluator implements RefineEvaluator, HitchTrajectoryReader {
  readonly repositoryPath: string
  private preflightPromise?: Promise<void>

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

  preflight(): Promise<void> {
    this.preflightPromise ??= this.checkVersion()
    return this.preflightPromise
  }

  private async checkVersion(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new HitchEvaluationError('Hitch version check timed out', 'hitch_version_check_failed')),
      10_000,
    )
    let result: ProcessResult
    try { result = await this.run(['--version'], this.repositoryPath, controller.signal, 16_384) }
    finally { clearTimeout(timeout) }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch version check failed: ${output.slice(-4000)}`, 'hitch_version_check_failed')
    }
    const match = output.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\D|$)/u)
    if (match === null) {
      throw new HitchEvaluationError(`unsupported Hitch CLI version output: ${output}`, 'unsupported_hitch_version')
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number]
    const supported = match[4] === undefined && (major > 0 || minor > 2 || (minor === 2 && patch >= 5))
    if (!supported) {
      throw new HitchEvaluationError(
        `unsupported Hitch CLI ${match[0].trim()}; Gear requires agent-hitch >= 0.2.5 for stable eval identity and multi-attempt rerun`,
        'unsupported_hitch_version',
      )
    }
  }

  async reserve(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
  ): Promise<EvaluationReservation> {
    return { provider: 'hitch-cli', evalId: `eval_${randomUUID().replaceAll('-', '')}` }
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
      diagnostics: trajectoryDiagnostics(events),
    }
  }

  async evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    if (request.condition.dataset.ref !== request.dataset || request.condition.timeoutMs !== round.taskBudgetMs) {
      throw new TypeError('Hitch evaluation request does not match its resolved condition')
    }
    if (request.condition.seeds !== undefined) throw new TypeError('Hitch CLI adapter does not support typed rollout seeds')
    if (request.condition.sampling.temperature !== undefined) {
      throw new TypeError('Hitch CLI adapter does not support typed rollout temperature')
    }
    if (reservation !== undefined
      && (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))) {
      throw new TypeError('Hitch evaluation reservation is invalid')
    }
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    const harness = `${this.options.harnessId}@${source}`
    const parity = {
      conditionId: request.condition.conditionId,
      executable: this.options.executable,
      hitchRoot: this.options.root,
      repositoryPath: this.repositoryPath,
      backend: 'harbor',
      dataset: request.dataset,
      harnessId: this.options.harnessId,
      model: request.condition.model,
      attempts: request.condition.repetitions,
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
      ...(reservation === undefined ? [] : ['--eval-id', reservation.evalId]),
      '--dataset', request.dataset,
      '--harness', harness,
      ...(request.condition.model.length === 0 ? [] : ['--model', request.condition.model]),
      '--attempts', String(request.condition.repetitions),
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
    const evidence = this.parseResult(parsed, processResult, request, sha256(JSON.stringify(parity)))
    if (reservation !== undefined
      && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
      throw new HitchEvaluationError('Hitch result does not match the reserved evaluation identity', 'hitch_eval_identity_mismatch')
    }
    const inspection = await this.inspectEvaluation(
      evidence.evalId,
      round.workspaceRoot,
      signal,
      'hitch_eval_inspect_failed',
    )
    this.assertCompleteTrialSlots(inspection, evidence, request)
    return evidence
  }

  async rerun(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
  ): Promise<EvaluationRerunResult> {
    if (attempt.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId)) {
      throw new TypeError('Hitch evaluation rerun requires an owned Hitch eval id')
    }
    if (attempt.phase !== request.phase || attempt.dataset !== request.dataset
      || attempt.conditionId !== request.condition.conditionId || attempt.requestedCommit !== request.harnessRef
      || attempt.requestedModelId !== request.condition.model) {
      throw new TypeError('Hitch evaluation rerun request does not match the original attempt')
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'rerun', attempt.evalId,
      ...(selector.mode === 'invalid'
        ? ['--invalid']
        : selector.taskNames.flatMap(task => ['--task', task])),
      '--output', 'json',
    ]
    const processResult = await this.run(args, round.workspaceRoot, signal)
    if (processResult.exitCode !== 0) {
      throw new HitchEvaluationError(
        `Hitch eval rerun failed for ${attempt.evalId}: ${processResult.stderr.slice(-4000)}`,
        'hitch_eval_rerun_failed',
      )
    }
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid rerun JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const envelope = record(parsed, 'Hitch rerun result')
    if (envelope.schema_version !== '1' || envelope.kind !== 'eval-rerun' || envelope.eval_id !== attempt.evalId
      || envelope.status !== 'completed' || (envelope.eval_status !== 'succeeded' && envelope.eval_status !== 'failed')) {
      throw new HitchEvaluationError('Hitch rerun result identity/status is invalid', 'invalid_hitch_result')
    }
    const selectedTasks = stringArray(envelope.selected_tasks, 'selected_tasks')
    const repairedTasks = stringArray(envelope.repaired_tasks, 'repaired_tasks')
    const remainingInvalidTasks = stringArray(envelope.remaining_invalid_tasks, 'remaining_invalid_tasks')
    const selectedTrials = envelope.selected_trials === undefined ? undefined : trialSlots(envelope.selected_trials, 'selected_trials')
    const repairedTrials = envelope.repaired_trials === undefined ? undefined : trialSlots(envelope.repaired_trials, 'repaired_trials')
    const remainingInvalidTrials = envelope.remaining_invalid_trials === undefined
      ? undefined : trialSlots(envelope.remaining_invalid_trials, 'remaining_invalid_trials')
    if (envelope.eval_status === 'succeeded'
      && (remainingInvalidTasks.length > 0 || (remainingInvalidTrials?.length ?? 0) > 0)) {
      throw new HitchEvaluationError('Hitch rerun succeeded with remaining invalid slots', 'invalid_hitch_result')
    }
    let evidence: HitchEvaluationEvidence | undefined
    if (envelope.eval_status === 'succeeded') {
      const inspection = await this.inspectEvaluation(
        attempt.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_rerun_inspect_failed',
      )
      const result = record(inspection.result, 'Hitch repaired eval result')
      evidence = this.parseResult(
        result,
        { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
        request,
        this.invocationFingerprint(round, request),
      )
      if (evidence.evalId !== attempt.evalId) throw new HitchEvaluationError('repaired evidence eval id changed', 'hitch_eval_identity_mismatch')
      this.assertCompleteTrialSlots(inspection, evidence, request)
    }
    return {
      provider: 'hitch-cli',
      evalId: attempt.evalId,
      selectedTasks,
      repairedTasks,
      remainingInvalidTasks,
      ...(selectedTrials === undefined ? {} : { selectedTrials }),
      ...(repairedTrials === undefined ? {} : { repairedTrials }),
      ...(remainingInvalidTrials === undefined ? {} : { remainingInvalidTrials }),
      evalStatus: envelope.eval_status,
      ...(evidence === undefined ? {} : { evidence }),
    }
  }

  private async inspectEvaluation(
    evalId: string,
    cwd: string,
    signal: AbortSignal,
    failureCode: string,
  ): Promise<JsonRecord> {
    const inspect = await this.run([
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'eval', 'inspect', evalId, '--json',
    ], cwd, signal)
    if (inspect.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch could not inspect eval ${evalId}`, failureCode)
    }
    let inspectionValue: unknown
    try { inspectionValue = JSON.parse(inspect.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid inspect JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const inspection = record(inspectionValue, 'Hitch eval inspection')
    if (inspection.schema_version !== '1' || inspection.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch inspection identity is invalid', 'invalid_hitch_result')
    }
    return inspection
  }

  private assertCompleteTrialSlots(
    inspection: JsonRecord,
    evidence: HitchEvaluationEvidence,
    request: Readonly<EvaluationRequest>,
  ): void {
    const plan = record(inspection.plan, 'Hitch eval plan')
    if (plan.schema_version !== '1' || plan.eval_id !== evidence.evalId) {
      throw new HitchEvaluationError('Hitch eval plan identity is invalid', 'invalid_hitch_result')
    }
    const attempts = integer(plan.attempts, 'plan.attempts')
    if (attempts <= 0 || attempts !== request.condition.repetitions) {
      throw new HitchEvaluationError('Hitch eval plan attempts do not match the frozen condition', 'invalid_hitch_result')
    }
    const tasks = stringArray(plan.tasks, 'plan.tasks')
    const plannedTasks = new Set(tasks)
    if (tasks.length === 0 || plannedTasks.size !== tasks.length) {
      throw new HitchEvaluationError('Hitch eval plan tasks must be non-empty and unique', 'invalid_hitch_result')
    }
    const expectedTrials = tasks.length * attempts
    if (!Number.isSafeInteger(expectedTrials)) {
      throw new HitchEvaluationError('Hitch eval plan trial count exceeds the safe integer range', 'invalid_hitch_result')
    }
    const slots = new Set<string>()
    for (const trial of evidence.trials) {
      if (!plannedTasks.has(trial.taskName)) {
        throw new HitchEvaluationError(`Hitch evidence contains task outside the frozen plan: ${trial.taskName}`, 'invalid_hitch_result')
      }
      const logicalAttempt = trial.attempt ?? (attempts === 1 ? 1 : undefined)
      if (logicalAttempt === undefined || !Number.isSafeInteger(logicalAttempt)
        || logicalAttempt < 1 || logicalAttempt > attempts) {
        throw new HitchEvaluationError(
          `Hitch evidence attempt is outside frozen range 1..${attempts}: ${trial.taskName}#${String(trial.attempt)}`,
          'invalid_hitch_result',
        )
      }
      const slot = `${trial.taskName}\0${logicalAttempt}`
      if (slots.has(slot)) {
        throw new HitchEvaluationError(`Hitch evidence contains duplicate logical slot: ${trial.taskName}#${logicalAttempt}`, 'invalid_hitch_result')
      }
      slots.add(slot)
    }
    if (slots.size !== expectedTrials) {
      const missing: string[] = []
      for (const task of tasks) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!slots.has(`${task}\0${attempt}`)) missing.push(`${task}#${attempt}`)
        }
      }
      throw new HitchEvaluationError(
        `Hitch evidence is missing frozen logical slots: ${missing.join(', ')}`,
        'invalid_hitch_result',
      )
    }
  }

  private invocationFingerprint(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): string {
    return sha256(JSON.stringify({
      conditionId: request.condition.conditionId,
      executable: this.options.executable,
      hitchRoot: this.options.root,
      repositoryPath: this.repositoryPath,
      backend: 'harbor',
      dataset: request.dataset,
      harnessId: this.options.harnessId,
      model: request.condition.model,
      attempts: request.condition.repetitions,
      maxConcurrent: this.options.maxConcurrent,
      timeoutMs: round.taskBudgetMs,
      setupTimeoutMs: this.options.setupTimeoutMs,
      agentArgs: this.options.agentArgs,
      passEnv: this.options.passEnv,
      sandboxProfileRef: round.sandboxProfileRef,
    }))
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
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: invocationFingerprint,
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
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: invocationFingerprint,
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
