import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { HitchConfig } from '../config.js'
import { digestJson } from '../state/digest.js'
import type {
  EvaluationRequest,
  EvaluationRerunResult,
  EvaluationRerunSelector,
  EvaluationReservation,
  EvaluationSubmissionIntent,
  EvaluationTrialSlot,
  FailedEvaluationEvidence,
  HitchEvaluationEvidence,
  HitchTrajectoryPage,
  HitchTrajectoryReader,
  HitchTrialSummary,
  InvalidEvaluationTrialSummary,
  LocalSourceTransportSummary,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
  ScoreSummary,
  TrajectoryDiagnostics,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { EvaluationCleanupError } from './cleanup.js'
import type { EvaluationRerunReservation } from '../types.js'

export interface HitchCliEvaluatorOptions extends HitchConfig {
  repositoryPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface HitchEvaluationIdentity {
  provider: 'hitch-cli'
  effectiveConfigDigest: string
  invocationFingerprint: string
}

type JsonRecord = Record<string, unknown>
type HitchControlPlaneOptions = NonNullable<HitchConfig['controlPlane']>

interface ParsedRunTrial {
  taskName: string
  trialName: string
  runId: string
  attempt: number
  observationStatus: 'valid' | 'invalid'
  reward?: number
  invalidReason?: string
}

export class HitchEvaluationError extends Error {
  constructor(
    message: string,
    readonly code = 'hitch_evaluation_failed',
    readonly failedEvidence?: FailedEvaluationEvidence,
  ) {
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

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function memorySizeBytes(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/iu)
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const multiplier = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'kib' ? 1024 : 1
  const bytes = amount * multiplier
  return Number.isSafeInteger(bytes) && bytes >= 1024 ** 2 && bytes % (1024 ** 2) === 0 ? bytes : undefined
}

function validMemorySize(value: string): boolean {
  return memorySizeBytes(value) !== undefined
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
  private executablePathPromise?: Promise<string>

  private get controlPlane(): HitchControlPlaneOptions {
    return { mode: 'direct', requireModelCapture: false, ...this.options.controlPlane }
  }

  private get daemonMode(): boolean {
    return this.controlPlane.mode === 'daemon'
  }

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
    const controlPlane = this.controlPlane
    if (controlPlane.mode !== 'direct' && controlPlane.mode !== 'daemon') throw new TypeError('hitch.controlPlane.mode is invalid')
    if (controlPlane.provider !== undefined && (!controlPlane.provider.trim() || /[\0\r\n]/u.test(controlPlane.provider))) {
      throw new TypeError('hitch.controlPlane.provider is invalid')
    }
    if (controlPlane.cpuPerTrial !== undefined
      && (!Number.isSafeInteger(controlPlane.cpuPerTrial) || controlPlane.cpuPerTrial <= 0)) {
      throw new TypeError('hitch.controlPlane.cpuPerTrial must be a positive integer')
    }
    if (controlPlane.memoryPerTrial !== undefined && !validMemorySize(controlPlane.memoryPerTrial)) {
      throw new TypeError('hitch.controlPlane.memoryPerTrial must be a positive whole number of MiB using B, KiB, MiB, or GiB')
    }
    if (controlPlane.buildMode !== undefined
      && !new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(controlPlane.buildMode)) {
      throw new TypeError('hitch.controlPlane.buildMode is invalid')
    }
    if (controlPlane.modelCapture !== undefined
      && !new Set(['off', 'native', 'proxy', 'hybrid']).has(controlPlane.modelCapture)) {
      throw new TypeError('hitch.controlPlane.modelCapture is invalid')
    }
    if (controlPlane.modelCapture === 'off' && controlPlane.requireModelCapture) {
      throw new TypeError('hitch.controlPlane.modelCapture=off cannot be required')
    }
    if (controlPlane.mode === 'direct' && this.controlPlanePolicyIsExplicit()) {
      throw new TypeError('hitch.controlPlane execution policy requires mode=daemon')
    }
  }

  async preflight(): Promise<void> {
    await this.checkVersion()
    if (this.daemonMode) await this.checkDaemon()
  }

  private async checkVersion(signal?: AbortSignal): Promise<string> {
    await this.executablePath()
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(signal?.reason)
    if (signal?.aborted === true) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new HitchEvaluationError(
        `Hitch version check timed out for ${this.options.executable}; Gear requires agent-hitch >= 0.2.5`,
        'hitch_version_check_failed',
      )),
      5_000,
    )
    let result: ProcessResult
    try { result = await this.run(['--version'], this.repositoryPath, controller.signal, 16_384) }
    finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch version check failed: ${output.slice(-4000)}`, 'hitch_version_check_failed')
    }
    const match = output.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\D|$)/u)
    if (match === null) {
      throw new HitchEvaluationError(`unsupported Hitch CLI version output: ${output}`, 'unsupported_hitch_version')
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number]
    const minimumPatch = this.daemonMode ? 6 : 5
    const coreAboveMinimum = major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch > minimumPatch)))
    const coreAtMinimum = major === 0 && minor === 2 && patch === minimumPatch
    const supported = coreAboveMinimum || (coreAtMinimum && match[4] === undefined)
    if (!supported) {
      const minimum = `0.2.${minimumPatch}`
      throw new HitchEvaluationError(
        `unsupported Hitch CLI ${match[0].trim()}; Gear requires agent-hitch >= ${minimum}${this.daemonMode ? ' for daemon eval control-plane support' : ' for stable eval identity and multi-attempt rerun'}`,
        'unsupported_hitch_version',
      )
    }
    return sha256(output)
  }

  private async checkDaemon(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new HitchEvaluationError(
        `Hitch daemon status check timed out for root ${this.options.root || '<default>'}`,
        'hitch_daemon_check_failed',
      )),
      5_000,
    )
    let result: ProcessResult
    try {
      result = await this.run([
        ...this.rootArgs(), 'daemon', 'status', '--json',
      ], this.repositoryPath, controller.signal, 64 * 1024)
    } finally {
      clearTimeout(timeout)
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid daemon status JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const health = record(parsed, 'Hitch daemon health')
    if (result.exitCode !== 0 || health.schema_version !== '1' || health.status !== 'running') {
      throw new HitchEvaluationError(
        `Hitch daemon is not running for root ${this.options.root || '<default>'}: ${result.stderr.slice(-4000)}`,
        'hitch_daemon_unavailable',
      )
    }
    const policy = record(health.resource_policy, 'Hitch daemon resource policy')
    this.parseResourceVector(policy.eval_trial, 'Hitch daemon eval trial policy')
  }

  prepareSubmission(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): EvaluationSubmissionIntent | undefined {
    if (!this.daemonMode) return undefined
    this.assertEvaluationRequest(round, request)
    return {
      provider: 'hitch-cli',
      idempotencyKey: this.daemonIdempotencyKey(round, request),
      parameters: {
        root: this.options.root,
        args: [...this.controlPlaneArgs(), ...this.evalRequestArgs(round, request)],
      },
    }
  }

  async reserve(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    signal?.throwIfAborted()
    // A stored intent must remain recoverable even if the configured mode changed.
    if (intent !== undefined) return this.reserveDaemonEvaluation(round, intent, signal)
    if (this.daemonMode) throw new TypeError('Hitch daemon submission requires a persisted submission intent')
    return { provider: 'hitch-cli', evalId: `eval_${randomUUID().replaceAll('-', '')}` }
  }

  private async reserveDaemonEvaluation(
    round: Readonly<RefinementRound>,
    intent: Readonly<EvaluationSubmissionIntent>,
    signal?: AbortSignal,
  ): Promise<EvaluationReservation> {
    const parameters = this.submissionParameters(intent)
    const args = [
      ...(parameters.root.length === 0 ? [] : ['--root', parameters.root]),
      'eval', 'submit',
      '--idempotency-key', intent.idempotencyKey,
      ...parameters.args,
    ]
    const timeout = AbortSignal.timeout(30_000)
    const result = await this.run(args, round.workspaceRoot,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]), 64 * 1024)
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch daemon eval submission failed: ${result.stderr.slice(-4000)}`, 'hitch_eval_submit_failed')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid eval submission JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const accepted = record(parsed, 'Hitch eval submission')
    const evalId = string(accepted.eval_id, 'eval submission eval_id')
    if (accepted.schema_version !== '1' || !/^eval_[0-9a-f]{32}$/u.test(evalId)
      || !new Set(['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed']).has(accepted.status as string)) {
      throw new HitchEvaluationError('Hitch eval submission identity/status is invalid', 'invalid_hitch_result')
    }
    return { provider: 'hitch-cli', evalId }
  }

  private submissionParameters(intent: Readonly<EvaluationSubmissionIntent>): { root: string; args: string[] } {
    if (intent.provider !== 'hitch-cli' || !/^gear-eval-v1-[0-9a-f]{64}$/u.test(intent.idempotencyKey)) {
      throw new TypeError('Hitch submission intent identity is invalid')
    }
    const parameters = record(intent.parameters, 'Hitch submission parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch submission root is invalid')
    return { root: parameters.root, args: stringArray(parameters.args, 'Hitch submission arguments') }
  }

  async recoverReservation(
    round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    intent: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    const parameters = this.submissionParameters(intent)
    try { return await this.reserveDaemonEvaluation(round, intent, signal) }
    catch (submissionError) {
      // Hitch resolves daemon defaults before checking the idempotency index.
      // Changed defaults or unavailable execution capacity can reject a replay
      // even though the original evaluation still exists. Locate its frozen key
      // through the public read-only CLI so it can still be cancelled.
      signal.throwIfAborted()
      const rootArgs = parameters.root.length === 0 ? [] : ['--root', parameters.root]
      const listed = await this.run([...rootArgs, 'eval', 'list', '--json'], this.repositoryPath, signal)
      if (listed.exitCode !== 0) throw submissionError
      const list = record(JSON.parse(listed.stdout), 'Hitch evaluation list')
      if (list.schema_version !== '1' || !Array.isArray(list.evals)) throw submissionError
      for (const value of list.evals) {
        const entry = record(value, 'Hitch listed evaluation')
        const evalId = string(entry.eval_id, 'Hitch listed eval_id')
        if (!/^eval_[0-9a-f]{32}$/u.test(evalId)) throw submissionError
        const inspection = await this.inspectEvaluation(evalId, this.repositoryPath, signal,
          'hitch_eval_recovery_inspect_failed', parameters.root)
        if (inspection.submission === undefined) continue
        const submission = record(inspection.submission, 'Hitch persisted submission')
        if (submission.schema_version === '1' && submission.eval_id === evalId
          && submission.idempotency_key_hash === sha256(intent.idempotencyKey)) {
          return { provider: 'hitch-cli', evalId }
        }
      }
      throw submissionError
    }
  }

  async cancelReservation(
    reservation: Readonly<EvaluationReservation>,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<void> {
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)) {
      throw new TypeError('Hitch cancellation reservation is invalid')
    }
    const root = intent === undefined ? this.options.root : this.submissionParameters(intent).root
    await this.cancelDaemonEvaluation(reservation.evalId, this.repositoryPath, root)
  }

  private controlPlanePolicyIsExplicit(): boolean {
    const policy = this.controlPlane
    return policy.provider !== undefined || policy.cpuPerTrial !== undefined || policy.memoryPerTrial !== undefined
      || policy.buildMode !== undefined || policy.modelCapture !== undefined || policy.requireModelCapture
  }

  private rootArgs(): string[] {
    return this.options.root.length === 0 ? [] : ['--root', this.options.root]
  }

  private controlPlaneArgs(): string[] {
    const policy = this.controlPlane
    return [
      ...(policy.provider === undefined ? [] : ['--provider', policy.provider]),
      ...(policy.cpuPerTrial === undefined ? [] : ['--cpu-per-trial', String(policy.cpuPerTrial)]),
      ...(policy.memoryPerTrial === undefined ? [] : ['--memory-per-trial', policy.memoryPerTrial]),
      ...(policy.buildMode === undefined ? [] : ['--build-mode', policy.buildMode]),
      ...(policy.modelCapture === undefined ? [] : ['--model-capture', policy.modelCapture]),
      ...(policy.requireModelCapture ? ['--require-model-capture'] : []),
    ]
  }

  private evalRequestArgs(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): string[] {
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    return [
      '--backend', 'harbor',
      '--dataset', request.dataset,
      '--harness', `${this.options.harnessId}@${source}`,
      ...(request.condition.model.length === 0 ? [] : ['--model', request.condition.model]),
      '--attempts', String(request.condition.repetitions),
      '--max-concurrent', String(this.options.maxConcurrent),
      '--timeout', `${round.taskBudgetMs}ms`,
      '--setup-timeout', `${this.options.setupTimeoutMs}ms`,
      ...this.options.agentArgs.flatMap(value => ['--agent-arg', value]),
      ...this.options.passEnv.flatMap(value => ['--pass-env', value]),
    ]
  }

  private assertEvaluationRequest(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): void {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    if (request.condition.dataset.ref !== request.dataset || request.condition.timeoutMs !== round.taskBudgetMs) {
      throw new TypeError('Hitch evaluation request does not match its resolved condition')
    }
    if (request.condition.seeds !== undefined) throw new TypeError('Hitch CLI adapter does not support typed rollout seeds')
    if (request.condition.sampling.temperature !== undefined) {
      throw new TypeError('Hitch CLI adapter does not support typed rollout temperature')
    }
  }

  private daemonIdempotencyKey(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): string {
    return `gear-eval-v1-${sha256(JSON.stringify({
      evolutionId: round.evolutionId,
      roundId: round.roundId,
      phase: request.phase,
      conditionId: request.condition.conditionId,
      dataset: request.dataset,
      harnessRef: request.harnessRef,
      model: request.condition.model,
      repetitions: request.condition.repetitions,
      invocation: this.baseParity(round, request),
    })).slice('sha256:'.length)}`
  }

  private baseParity(round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): JsonRecord {
    return {
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
      ...(this.daemonMode ? { executionMode: 'daemon' } : {}),
    }
  }

  private parseResourceVector(value: unknown, label: string): JsonRecord {
    const resources = record(value, label)
    for (const field of ['cpu_millis', 'memory_bytes', 'container_slots', 'build_slots']) {
      integer(resources[field], `${label}.${field}`)
    }
    for (const field of ['gpu_count', 'ephemeral_disk_bytes']) {
      if (resources[field] !== undefined) integer(resources[field], `${label}.${field}`)
    }
    return resources
  }

  async evaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity | undefined> {
    signal?.throwIfAborted()
    // Daemon defaults are frozen at submission; prior evidence cannot be reused
    // until the current execution policy can be resolved before submission.
    if (this.daemonMode) return undefined
    return this.resolveEvaluationIdentity(round, request, signal)
  }

  private async resolveEvaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity> {
    signal?.throwIfAborted()
    const hitchRuntimeIdentity = await this.runtimeIdentity(signal)
    signal?.throwIfAborted()
    const effectiveConfigDigest = this.effectiveConfigDigest(round, request, hitchRuntimeIdentity)
    const invocationFingerprint = this.invocationFingerprint(effectiveConfigDigest)
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint,
    }
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
    try {
      this.assertEvaluationRequest(round, request)
      if (reservation !== undefined
        && (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))) {
        throw new TypeError('Hitch evaluation reservation is invalid')
      }
      if (this.daemonMode && reservation === undefined) {
        throw new TypeError('Hitch daemon evaluation requires a durable reservation')
      }
      const args = [
        ...this.rootArgs(),
        ...(this.daemonMode
          ? ['eval', 'watch', (reservation as EvaluationReservation).evalId]
          : ['eval', 'run', ...(reservation === undefined ? [] : ['--eval-id', reservation.evalId]), ...this.evalRequestArgs(round, request)]),
        '--output', 'json',
      ]
      let identity = await this.resolveEvaluationIdentity(round, request, signal)
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
      let inspection: JsonRecord | undefined
      if (this.daemonMode) {
        inspection = await this.inspectEvaluation(
          (reservation as EvaluationReservation).evalId,
          round.workspaceRoot,
          signal,
          'hitch_eval_inspect_failed',
        )
        identity = this.daemonEvaluationIdentity(round, request, inspection, identity)
      }
      const evidence = this.parseResult(parsed, processResult, request, identity, true)
      if (reservation !== undefined
        && (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)) {
        throw new HitchEvaluationError('Hitch result does not match the reserved evaluation identity', 'hitch_eval_identity_mismatch')
      }
      inspection ??= await this.inspectEvaluation(
        evidence.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_inspect_failed',
      )
      this.assertCompleteTrialSlots(inspection, evidence, request)
      return evidence
    } catch (error) {
      if (this.daemonMode && reservation !== undefined) {
        try {
          await this.cancelReservation(reservation)
        } catch (cancelError) {
          throw new EvaluationCleanupError(error, cancelError)
        }
      }
      throw error
    }
  }

  prepareRerun(
    _round: Readonly<RefinementRound>,
    _request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    _selector: Readonly<EvaluationRerunSelector>,
  ): EvaluationRerunReservation | undefined {
    if (!this.daemonMode) return undefined
    return {
      provider: 'hitch-cli', evalId: attempt.evalId,
      rerunId: `rerun_${randomUUID().replaceAll('-', '')}`,
      parameters: { root: attempt.submissionIntent === undefined ? this.options.root : this.submissionParameters(attempt.submissionIntent).root },
    }
  }

  private rerunRoot(reservation: Readonly<EvaluationRerunReservation>): string {
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)
      || !/^rerun_[0-9a-f]{32}$/u.test(reservation.rerunId)) throw new TypeError('Hitch rerun reservation is invalid')
    const parameters = record(reservation.parameters, 'Hitch rerun parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch rerun root is invalid')
    return parameters.root
  }

  async cancelRerun(reservation: Readonly<EvaluationRerunReservation>): Promise<void> {
    const root = this.rerunRoot(reservation)
    const result = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]),
      'eval', 'rerun-cancel', reservation.evalId, reservation.rerunId,
    ], this.repositoryPath, AbortSignal.timeout(30_000), 64 * 1024)
    if (result.exitCode !== 0) throw new HitchEvaluationError(`Hitch rerun cancellation failed: ${result.stderr.slice(-4000)}`, 'hitch_rerun_cancel_failed')
    const cancelled = record(JSON.parse(result.stdout), 'Hitch rerun cancellation')
    if (cancelled.schema_version !== '1' || cancelled.eval_id !== reservation.evalId || cancelled.rerun_id !== reservation.rerunId
      || !['cancelled', 'completed', 'failed'].includes(cancelled.status as string)) {
      throw new HitchEvaluationError('Hitch rerun cancellation did not confirm a stopped operation', 'hitch_rerun_cancel_failed')
    }
  }

  async rerun(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationRerunReservation>,
  ): Promise<EvaluationRerunResult> {
    if (attempt.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId)) {
      throw new TypeError('Hitch evaluation rerun requires an owned Hitch eval id')
    }
    if (attempt.phase !== request.phase || attempt.dataset !== request.dataset
      || attempt.conditionId !== request.condition.conditionId || attempt.requestedCommit !== request.harnessRef
      || attempt.requestedModelId !== request.condition.model) {
      throw new TypeError('Hitch evaluation rerun request does not match the original attempt')
    }
    if (this.daemonMode && reservation === undefined) throw new TypeError('Hitch daemon rerun requires a persisted rerun reservation')
    const root = reservation === undefined ? this.options.root : this.rerunRoot(reservation)
    if (reservation !== undefined && reservation.evalId !== attempt.evalId) throw new TypeError('Hitch rerun reservation does not match its source eval')
    try {
      const identity = await this.resolveEvaluationIdentity(round, request, signal)
      const args = [
        ...(root.length === 0 ? [] : ['--root', root]),
        'eval', 'rerun', attempt.evalId,
        ...(selector.mode === 'invalid'
          ? ['--invalid']
          : selector.taskNames.flatMap(task => ['--task', task])),
        '--type', 'candidate-restart',
        ...(reservation === undefined ? [] : ['--daemon', '--rerun-id', reservation.rerunId]),
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
        || (reservation !== undefined && envelope.rerun_id !== reservation.rerunId)
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
      const inspection = await this.inspectEvaluation(
        attempt.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_rerun_inspect_failed',
        root,
      )
      const result = record(inspection.result, 'Hitch repaired eval result')
      const evidence = this.parseResult(
        result,
        { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
        request,
        this.daemonMode ? this.daemonEvaluationIdentity(round, request, inspection, identity) : identity,
        true,
      )
      if (evidence.evalId !== attempt.evalId) throw new HitchEvaluationError('repaired evidence eval id changed', 'hitch_eval_identity_mismatch')
      if ((envelope.eval_status === 'succeeded') !== (evidence.completeness === 'complete')) {
        throw new HitchEvaluationError('Hitch rerun status does not match repaired evidence completeness', 'invalid_hitch_result')
      }
      this.assertCompleteTrialSlots(inspection, evidence, request)
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
        evidence,
      }
    } catch (error) {
      if (reservation !== undefined) {
        try { await this.cancelRerun(reservation) }
        catch (cleanupError) { throw new EvaluationCleanupError(error, cleanupError) }
      }
      throw error
    }
  }

  private async inspectEvaluation(
    evalId: string,
    cwd: string,
    signal: AbortSignal,
    failureCode: string,
    root = this.options.root,
  ): Promise<JsonRecord> {
    const inspect = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]),
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

  private async cancelDaemonEvaluation(evalId: string, cwd: string, root: string): Promise<void> {
    const result = await this.run([
      ...(root.length === 0 ? [] : ['--root', root]), 'eval', 'cancel', evalId,
    ], cwd, AbortSignal.timeout(Math.max(5_000, this.options.terminationGraceMs)), 64 * 1024)
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch could not cancel daemon eval ${evalId}: ${result.stderr.slice(-4000)}`, 'hitch_eval_cancel_failed')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid eval cancellation JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const cancelled = record(parsed, 'Hitch eval cancellation')
    if (cancelled.schema_version !== '1' || cancelled.eval_id !== evalId
      || !new Set(['cancelling', 'cancelled', 'succeeded', 'failed']).has(cancelled.status as string)) {
      throw new HitchEvaluationError('Hitch eval cancellation identity/status is invalid', 'invalid_hitch_result')
    }
  }

  private daemonEvaluationIdentity(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    inspection: JsonRecord,
    identity: HitchEvaluationIdentity,
  ): HitchEvaluationIdentity {
    const evalId = string(inspection.eval_id, 'Hitch eval inspection eval_id')
    const submission = record(inspection.submission, 'Hitch eval submission record')
    if (submission.schema_version !== '1' || submission.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch eval submission identity is invalid', 'invalid_hitch_result')
    }
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    const submittedRequest = record(submission.request, 'Hitch eval submitted request')
    if (!isDeepStrictEqual(submittedRequest, inspectedRequest)) {
      throw new HitchEvaluationError('Hitch submitted request differs from the eval request', 'invalid_hitch_result')
    }
    const idempotencyKeyHash = string(submission.idempotency_key_hash, 'Hitch eval idempotency key hash')
    if (idempotencyKeyHash !== sha256(this.daemonIdempotencyKey(round, request))) {
      throw new HitchEvaluationError('Hitch eval idempotency identity differs from the Gear reservation', 'invalid_hitch_result')
    }
    const execution = this.assertDaemonExecutionPolicy(submission.execution)
    const submissionDigest = string(submission.submission_digest, 'Hitch eval submission digest')
    if (submissionDigest !== digestJson({ request: submittedRequest, execution })) {
      throw new HitchEvaluationError('Hitch eval submission digest does not match its frozen request and execution policy', 'invalid_hitch_result')
    }
    const submittedAt = string(submission.submitted_at, 'Hitch eval submission timestamp')
    if (!Number.isFinite(Date.parse(submittedAt))) {
      throw new HitchEvaluationError('Hitch eval submission timestamp is invalid', 'invalid_hitch_result')
    }
    const effectiveConfigDigest = digestJson({
      effectiveConfigDigest: identity.effectiveConfigDigest,
      executionMode: 'daemon',
      execution,
    })
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint: this.invocationFingerprint(effectiveConfigDigest),
    }
  }

  private assertDaemonExecutionPolicy(value: unknown): JsonRecord {
    const execution = record(value, 'Hitch eval execution policy')
    const provider = string(execution.provider, 'Hitch eval execution policy provider')
    const maxParallelism = integer(execution.max_parallelism, 'Hitch eval execution policy max_parallelism')
    if (maxParallelism !== this.options.maxConcurrent) {
      throw new HitchEvaluationError('Hitch eval execution parallelism differs from the Gear condition', 'invalid_hitch_result')
    }
    if (this.controlPlane.provider !== undefined && provider !== this.controlPlane.provider) {
      throw new HitchEvaluationError('Hitch eval execution provider differs from Gear configuration', 'invalid_hitch_result')
    }
    const resources = record(execution.resources, 'Hitch eval execution resources')
    const trial = this.parseResourceVector(resources.default_trial, 'Hitch eval default trial resources')
    if (this.controlPlane.cpuPerTrial !== undefined
      && trial.cpu_millis !== this.controlPlane.cpuPerTrial * 1_000) {
      throw new HitchEvaluationError('Hitch eval CPU reservation differs from Gear configuration', 'invalid_hitch_result')
    }
    if (this.controlPlane.memoryPerTrial !== undefined
      && trial.memory_bytes !== memorySizeBytes(this.controlPlane.memoryPerTrial)) {
      throw new HitchEvaluationError('Hitch eval memory reservation differs from Gear configuration', 'invalid_hitch_result')
    }
    if (resources.setup !== undefined) this.parseResourceVector(resources.setup, 'Hitch eval setup resources')
    const build = record(execution.build, 'Hitch eval build policy')
    const buildMode = string(build.mode, 'Hitch eval build mode')
    if (!new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(buildMode)
      || (this.controlPlane.buildMode !== undefined && buildMode !== this.controlPlane.buildMode)) {
      throw new HitchEvaluationError('Hitch eval build policy differs from Gear configuration', 'invalid_hitch_result')
    }
    const capture = record(execution.model_capture, 'Hitch eval model capture policy')
    const captureMode = string(capture.mode, 'Hitch eval model capture mode')
    if (!new Set(['off', 'native', 'proxy', 'hybrid']).has(captureMode)
      || typeof capture.required !== 'boolean'
      || (this.controlPlane.modelCapture !== undefined && captureMode !== this.controlPlane.modelCapture)
      || capture.required !== this.controlPlane.requireModelCapture) {
      throw new HitchEvaluationError('Hitch eval model capture policy differs from Gear configuration', 'invalid_hitch_result')
    }
    return execution
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
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    if (inspectedRequest.schema_version !== '1' || inspectedRequest.backend !== 'harbor'
      || inspectedRequest.dataset !== request.dataset
      || inspectedRequest.model !== request.condition.model) {
      throw new HitchEvaluationError('Hitch eval request does not match the frozen Gear condition', 'invalid_hitch_result')
    }
    const attempts = integer(plan.attempts, 'plan.attempts')
    const requestedAttempts = integer(inspectedRequest.attempts, 'request.attempts')
    if (attempts <= 0 || attempts !== request.condition.repetitions || requestedAttempts !== attempts) {
      throw new HitchEvaluationError('Hitch eval plan attempts do not match the frozen condition', 'invalid_hitch_result')
    }
    const attemptExecution = plan.attempt_execution
    const stableAttemptExecution = attemptExecution === 'harbor-attempt-shards-v1'
      || (this.daemonMode && attemptExecution === 'harbor-task-slots-v1')
    if ((attemptExecution !== undefined && !stableAttemptExecution)
      || (attempts > 1 && !stableAttemptExecution)) {
      throw new HitchEvaluationError('Hitch eval plan has no stable logical-attempt identity', 'invalid_hitch_result')
    }
    const benchmarkId = string(inspectedRequest.benchmark_id, 'request.benchmark_id')
    const benchmarkRevision = string(inspectedRequest.benchmark_revision, 'request.benchmark_revision')
    if (plan.backend !== 'harbor' || plan.dataset !== inspectedRequest.dataset
      || plan.benchmark_id !== benchmarkId || plan.benchmark_revision !== benchmarkRevision) {
      throw new HitchEvaluationError('Hitch eval request and plan dataset identity differ', 'invalid_hitch_result')
    }
    const candidate = record(plan.candidate, 'plan.candidate')
    const requestedHarnessRef = string(inspectedRequest.harness_ref, 'request.harness_ref')
    if (candidate.requested_harness_ref !== requestedHarnessRef
      || candidate.harness_id !== this.options.harnessId
      || candidate.revision_identity !== evidence.revisionIdentity) {
      throw new HitchEvaluationError('Hitch eval plan candidate identity differs from the result', 'invalid_hitch_result')
    }
    const lockedHarnessRef = string(candidate.harness_ref, 'plan.candidate.harness_ref')
    const lockedCommit = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)?.[1]
    if (lockedCommit !== request.harnessRef || lockedCommit !== evidence.actualCommit
      || lockedHarnessRef !== `${this.options.harnessId}@commit:${lockedCommit}`) {
      throw new HitchEvaluationError('Hitch eval plan candidate commit differs from the request', 'invalid_hitch_result')
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
    for (const trial of [...evidence.trials, ...evidence.invalidTrials]) {
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

  private effectiveConfigDigest(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    hitchRuntimeIdentity: string,
  ): string {
    return sha256(JSON.stringify({
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      hitchRuntimeIdentity,
      backend: 'harbor',
      harnessId: this.options.harnessId,
      sandboxProfileRef: round.sandboxProfileRef,
    }))
  }

  private invocationFingerprint(effectiveConfigDigest: string): string {
    return sha256(JSON.stringify({
      effectiveConfigDigest,
      maxConcurrent: this.options.maxConcurrent,
      setupTimeoutMs: this.options.setupTimeoutMs,
      terminationGraceMs: this.options.terminationGraceMs,
      maxOutputBytes: this.options.maxOutputBytes,
      maxTrajectoryOutputBytes: this.options.maxTrajectoryOutputBytes,
    }))
  }

  private executablePath(): Promise<string> {
    this.executablePathPromise ??= this.resolveExecutablePath()
    return this.executablePathPromise
  }

  private async runtimeIdentity(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const executablePath = await this.executablePath()
    const readExecutable = async (): Promise<Uint8Array> => readFile(executablePath).catch(error => {
      throw new HitchEvaluationError(
        `cannot fingerprint Hitch executable ${executablePath}: ${String(error)}`,
        'hitch_version_check_failed',
      )
    })
    const executableDigestBefore = sha256(await readExecutable())
    signal?.throwIfAborted()
    const versionOutputDigest = await this.checkVersion(signal)
    signal?.throwIfAborted()
    const executableDigest = sha256(await readExecutable())
    if (executableDigest !== executableDigestBefore) {
      throw new HitchEvaluationError(
        `Hitch executable changed while its runtime identity was being validated: ${executablePath}`,
        'hitch_version_check_failed',
      )
    }
    return sha256(JSON.stringify({
      versionOutputDigest,
      executableDigest,
    }))
  }

  private async resolveExecutablePath(): Promise<string> {
    const candidates = this.options.executable.includes('/')
      ? [resolve(this.repositoryPath, this.options.executable)]
      : (process.env.PATH ?? '').split(delimiter)
        .filter(path => path.length > 0)
        .map(path => resolve(path, this.options.executable))
    for (const candidate of candidates) {
      try { return await realpath(candidate) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new HitchEvaluationError(
            `cannot resolve Hitch executable ${candidate}: ${String(error)}`,
            'hitch_version_check_failed',
          )
        }
      }
    }
    throw new HitchEvaluationError(
      `cannot resolve Hitch executable for runtime fingerprint: ${this.options.executable}`,
      'hitch_version_check_failed',
    )
  }

  private parseResult(
    value: unknown,
    processResult: ProcessResult,
    request: Readonly<EvaluationRequest>,
    identity: HitchEvaluationIdentity,
    allowFailedRunEvidence = false,
  ): HitchEvaluationEvidence {
    const result = record(value, 'Hitch result')
    if (result.schema_version !== '1') throw new HitchEvaluationError('unsupported Hitch eval schema', 'unsupported_hitch_schema')
    const evalId = string(result.eval_id, 'eval_id')
    if (!/^eval_[0-9a-f]{32}$/u.test(evalId)) throw new HitchEvaluationError('invalid Hitch eval_id', 'invalid_hitch_result')
    const exitCode = integer(result.exit_code, 'exit_code')
    if (processResult.exitCode !== exitCode) {
      throw new HitchEvaluationError(`Hitch process/result exit mismatch: ${processResult.exitCode} != ${exitCode}`)
    }
    const failedRunEvidence = allowFailedRunEvidence
      && result.status === 'failed'
      && exitCode !== 0
      && Array.isArray(result.trials)
    if ((result.status !== 'succeeded' || exitCode !== 0) && !failedRunEvidence) {
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
    if (lockedHarnessRef !== `${this.options.harnessId}@commit:${actualCommit}`) {
      throw new HitchEvaluationError('Hitch candidate harness id does not match the configured adapter', 'hitch_commit_mismatch')
    }
    if (actualCommit !== request.harnessRef) {
      throw new HitchEvaluationError(`Hitch resolved ${actualCommit}, expected ${request.harnessRef}`, 'hitch_commit_mismatch')
    }
    const transport = this.parseTransport(result.local_source_transport)
    if (transport.commit !== request.harnessRef || transport.resolutionIdentity !== revisionIdentity) {
      throw new HitchEvaluationError('Hitch local source transport identity does not match the locked candidate', 'hitch_transport_mismatch')
    }
    const summaryValue = record(result.summary, 'summary')
    if (Array.isArray(result.trials)) {
      const evidence = this.parseRunCenteredResult(
        result,
        summaryValue,
        evalId,
        request,
        actualCommit,
        revisionIdentity,
        identity,
        transport,
      )
      if ((result.status === 'succeeded') !== (evidence.completeness === 'complete')) {
        throw new HitchEvaluationError(
          'Hitch result status does not match run evidence completeness',
          'invalid_hitch_result',
        )
      }
      return evidence
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
      effectiveConfigDigest: identity.effectiveConfigDigest,
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint: identity.invocationFingerprint,
      completeness: 'complete',
      plannedTrialCount: total,
      primaryReward,
      summary,
      trials,
      invalidTrials: [],
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
    identity: HitchEvaluationIdentity,
    transport: LocalSourceTransportSummary,
  ): HitchEvaluationEvidence {
    const total = integer(summaryValue.n_trials, 'summary.n_trials')
    const completed = integer(summaryValue.n_completed, 'summary.n_completed')
    const invalid = integer(summaryValue.n_invalid, 'summary.n_invalid')
    const parsed = this.parseRunTrials(result.trials)
    if (total === 0 && parsed.length === 0 && result.status === 'failed') {
      const error = typeof result.error === 'object' && result.error !== null ? result.error as JsonRecord : {}
      throw new HitchEvaluationError(
        `Hitch eval ${evalId} failed before producing canonical trial evidence (${String(error.code ?? 'hitch_eval_failed')}): ${String(error.message ?? 'no trial observations')}`,
        typeof error.code === 'string' ? error.code : 'hitch_eval_failed',
      )
    }
    if (total <= 0 || parsed.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
    const valid = parsed.filter(trial => trial.observationStatus === 'valid')
    const invalidObservations = parsed.filter(trial => trial.observationStatus === 'invalid')
    if (completed !== valid.length || invalid !== invalidObservations.length || completed + invalid !== total) {
      throw new HitchEvaluationError(
        `Hitch observation counts are inconsistent: total=${total}, completed=${completed}, invalid=${invalid}`,
        'invalid_hitch_result',
      )
    }
    const trials: HitchTrialSummary[] = valid.map(trial => ({
      taskName: trial.taskName,
      trialName: trial.trialName,
      runId: trial.runId,
      attempt: trial.attempt,
      status: 'completed',
      rewards: { reward: trial.reward! },
    }))
    const invalidTrials: InvalidEvaluationTrialSummary[] = invalidObservations.map(trial => ({
      taskName: trial.taskName,
      trialName: trial.trialName,
      runId: trial.runId,
      attempt: trial.attempt,
      status: 'errored',
      invalidReason: trial.invalidReason!,
    }))
    const primaryReward = trials.length === 0
      ? 0
      : trials.reduce((sum, trial) => sum + trial.rewards.reward!, 0) / trials.length
    if (trials.length > 0) {
      const reportedPrimaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
      if (Math.abs(reportedPrimaryReward - primaryReward) > 1e-12) {
        throw new HitchEvaluationError('Hitch primary reward does not match valid run observations', 'invalid_hitch_result')
      }
    }
    const passed = trials.filter(trial => (rewardForTrial(trial.rewards) ?? 0) > 0).length
    const summary: ScoreSummary = {
      total: trials.length,
      passed,
      failed: trials.length - passed,
      score: primaryReward,
      metrics: { primaryReward },
    }
    return {
      provider: 'hitch-cli',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: identity.effectiveConfigDigest,
      evalId,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit,
      revisionIdentity,
      invocationFingerprint: identity.invocationFingerprint,
      completeness: invalidTrials.length === 0 ? 'complete' : 'partial',
      plannedTrialCount: total,
      primaryReward,
      summary,
      trials,
      invalidTrials,
      localSourceTransport: transport,
    }
  }

  private parseRunTrials(value: unknown): ParsedRunTrial[] {
    if (!Array.isArray(value)) throw new HitchEvaluationError('trials must be an array', 'invalid_hitch_result')
    return value.map((item, index) => {
      const trial = record(item, `trials[${index}]`)
      const runId = string(trial.run_id, `trials[${index}].run_id`)
      if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new HitchEvaluationError(`trials[${index}].run_id is invalid`, 'invalid_hitch_result')
      const observation = string(trial.observation_status, `trials[${index}].observation_status`)
      if (observation !== 'valid' && observation !== 'invalid') {
        throw new HitchEvaluationError(`trials[${index}].observation_status is invalid`, 'invalid_hitch_result')
      }
      const reward = observation === 'valid' ? finite(trial.reward, `trials[${index}].reward`) : undefined
      const invalidReason = observation === 'invalid'
        ? string(trial.invalid_reason, `trials[${index}].invalid_reason`)
        : undefined
      const attempt = integer(trial.attempt, `trials[${index}].attempt`)
      if (attempt <= 0) throw new HitchEvaluationError(`trials[${index}].attempt must be positive`, 'invalid_hitch_result')
      return {
        taskName: string(trial.task_id, `trials[${index}].task_id`),
        trialName: string(trial.trial_id, `trials[${index}].trial_id`),
        runId,
        attempt,
        observationStatus: observation,
        ...(reward === undefined ? {} : { reward }),
        ...(invalidReason === undefined ? {} : { invalidReason }),
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

  private async run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    maxOutputBytes = this.options.maxOutputBytes,
  ): Promise<ProcessResult> {
    signal.throwIfAborted()
    const executablePath = await this.executablePath()
    signal.throwIfAborted()
    return new Promise<ProcessResult>((resolvePromise, reject) => {
      const child = spawn(executablePath, args, {
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
          terminate()
          return next.slice(0, maxOutputBytes)
        }
        return next
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = append('stdout', stdout, chunk) })
      child.stderr.on('data', (chunk: string) => { stderr = append('stderr', stderr, chunk) })
      const terminate = (): void => {
        if (killTimer !== undefined) return
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
