import { prepareEnvironmentBinding, type HitchEnvironmentBinding } from './binding.js'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json, TrialArtifact } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type {
  OperationProvider,
  OperationRequest,
  OperationReceipt,
  OperationInspection,
  OperationCancellation,
} from '../../ports/operations.js'
import { publishFile } from '../storage/atomic.js'
import { datasetDigest } from './dataset.js'
import { hitchJson } from './transport.js'
import { decodeHitchTrials } from './evidence.js'
import { failureData, hitchEvaluationFailure, type HitchEvaluationFailure } from './failure.js'
import { OrderedHitchControl, hitchOperationPath } from './control.js'
import { findExecutable } from '../process/executable.js'
import { HitchArtifactReader } from './trajectory.js'
import { captureVerifiers, verifyVerifierExtension, type VerifierCapture } from './verifier.js'
import { assertHitchExecutionConditions } from './conditions.js'
import {
  assertStablePreparedArtifacts,
  assertPreparedArtifactsMatch,
  artifactPins,
  type TaskArtifact,
} from './artifacts.js'
import { inspectHitchConnection, hitchCapabilities } from './connection.js'
import { HitchPreparedRuntime, type HitchRuntimeAccess } from './preparation.js'
import {
  evaluationWatchTimeoutMs,
  hitchControlTimeoutMs,
  hitchEnvironmentTimeoutMs,
  hitchSettings,
  type HitchSettings,
} from './settings.js'
import {
  type observeEvaluationEnvironment,
  assertEvaluationEnvironment,
  evaluationProvider,
} from './observation.js'

export interface HitchProfile extends Partial<HitchSettings> {
  kind: 'hitch'
  executable: string
  root: string
  harnessRef: string
  model: string
  baseImage: string
  passEnv: string[]
  timeoutMs: number
}
interface Group {
  key: string
  dataset: string
  digest: string
  taskIds: string[]
  repetition: number
  agentArgs: string[]
  evalId: string | null
  submissionStarted: boolean
}
interface Plan {
  operationDigest: string
  providerIdentity: string
  groups: Group[]
}
export interface HitchProviderContext {
  directory: string
  taskIds: string[]
  runtime?: HitchRuntimeAccess
  targets: string
  adapter: HarnessAdapter
  compile(destination: string, taskIds: string[], baseImage: string, signal?: AbortSignal): Promise<unknown>
  seal?(destination: string, taskIds: string[]): Promise<unknown>
  implementationIdentity: string
}

/** Only this adapter knows Hitch submission, trial decoding and task-container layout. */
export class HitchOperationProvider implements OperationProvider {
  get cancellation(): Json {
    return {
      version: 1,
      kind: 'hitch',
      executable: this.profile.executable,
      root: this.profile.root,
      directory: this.context.directory,
      identity: this.identity,
    }
  }
  static canceller(connection: {
    executable: string
    root: string
    directory: string
    identity: string
  }): OperationCancellation {
    return {
      async cancel(request) {
        if (request.projection) return
        const control = new OrderedHitchControl(
          hitchOperationPath(connection.directory, request.operationId),
          connection.identity,
          (args, signal) => hitchJson(connection.executable, connection.root, args, signal),
        )
        await control.cancel(request)
      },
    }
  }
  get artifactReader() {
    return this.trajectoryEnabled
      ? new HitchArtifactReader(this.profile.executable, this.profile.root).descriptor
      : undefined
  }
  get timeouts() {
    return {
      target: [
        { name: 'hitch-control', scope: 'provider-call' as const, milliseconds: hitchControlTimeoutMs },
        {
          name: 'hitch-environment',
          scope: 'provider-call' as const,
          milliseconds: hitchEnvironmentTimeoutMs,
        },
        {
          name: 'hitch-environment-binding',
          scope: 'provider-call' as const,
          milliseconds: this.profile.preparationTimeoutMs,
        },
        {
          name: 'hitch-artifact-preparation',
          scope: 'provider-call' as const,
          milliseconds: this.profile.preparationTimeoutMs,
        },
        {
          name: 'hitch-submission',
          scope: 'provider-call' as const,
          milliseconds: this.profile.preparationTimeoutMs,
        },
        {
          name: 'hitch-watch',
          scope: 'provider-call' as const,
          milliseconds: evaluationWatchTimeoutMs(this.profile, this.context.taskIds.length),
        },
        { name: 'hitch-evaluation', scope: 'evaluation' as const, milliseconds: this.profile.timeoutMs },
      ],
      meta: null,
      taskRuntime: 'harbor' as const,
    }
  }
  readonly capabilities = hitchCapabilities
  private constructor(
    readonly profile: HitchProfile & HitchSettings,
    readonly context: HitchProviderContext,
    readonly identity: string,
    readonly revisionIdentity: string,
    readonly preparedArtifacts: TaskArtifact[],
    readonly environmentBinding: HitchEnvironmentBinding,
    private readonly preparedRuntime: HitchRuntimeAccess,
    readonly executionEnvironment: Awaited<ReturnType<typeof observeEvaluationEnvironment>>,
    readonly trajectoryEnabled: boolean,
    readonly verifierEnabled: boolean,
  ) {}
  static async connect(
    input: HitchProfile,
    context: HitchProviderContext,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<HitchOperationProvider> {
    signal.throwIfAborted()
    let profile = { ...input, ...hitchSettings(input) }
    const connection = await inspectHitchConnection(profile, context.adapter, signal)
    const { capabilities, executionEnvironment, revisionIdentity } = connection
    profile = { ...profile, executable: await findExecutable(profile.executable) }
    const runtime = context.runtime ?? new HitchPreparedRuntime()
    const preparedArtifacts = await runtime.prepare(profile, context, connection, signal)
    await assertEvaluationEnvironment(
      (args, signal, timeout) => hitchJson(profile.executable, profile.root, args, signal, timeout),
      signal,
      executionEnvironment,
    )
    const environmentBinding = await prepareEnvironmentBinding(
      profile,
      (args, signal, timeout) => hitchJson(profile.executable, profile.root, args, signal, timeout),
      signal,
    )
    const identity = canonicalDigest({
      profile,
      environmentBinding,
      runtime: revisionIdentity,
      preparedArtifacts,
      capabilities,
      executionEnvironment,
      implementation: context.implementationIdentity,
    })
    return new HitchOperationProvider(
      profile,
      context,
      identity,
      revisionIdentity,
      preparedArtifacts,
      environmentBinding,
      runtime,
      executionEnvironment,
      capabilities.trajectory_events_page === '1',
      capabilities.verifier_evidence === '1',
    )
  }
  private call(args: string[], signal: AbortSignal, timeoutMs?: number) {
    return hitchJson(this.profile.executable, this.profile.root, args, signal, timeoutMs)
  }
  private path(request: Pick<OperationRequest, 'operationId'>) {
    return hitchOperationPath(this.context.directory, request.operationId)
  }
  private async plan(request: OperationRequest): Promise<Plan | null> {
    return this.planByIdentity(request.operationId, canonicalDigest(request))
  }
  private async planByIdentity(operationId: string, operationDigest: string): Promise<Plan | null> {
    let plan: Plan
    try {
      plan = JSON.parse(await readFile(join(this.path({ operationId }), 'plan.json'), 'utf8')) as Plan
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (plan.operationDigest !== operationDigest || plan.providerIdentity !== this.identity)
      throw new GearError('hitch-operation-identity', 'Frozen evaluation submission changed')
    for (const group of plan.groups) {
      const digest = await datasetDigest(group.dataset).catch(() => {
        throw new GearError('hitch-dataset-changed', 'Frozen executable benchmark is unavailable')
      })
      if (digest !== group.digest)
        throw new GearError('hitch-dataset-changed', 'Frozen executable benchmark changed')
    }
    return plan
  }
  private async receipt(operationId: string, operationDigest?: string): Promise<OperationReceipt | null> {
    let record: {
      operationDigest: string
      providerIdentity: string
      receipt: OperationReceipt
      digest: string
    }
    try {
      record = JSON.parse(await readFile(join(this.path({ operationId }), 'receipt.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const { digest, ...body } = record
    if (
      canonicalDigest(body) !== digest ||
      (operationDigest !== undefined && record.operationDigest !== operationDigest) ||
      record.receipt.result.operation_id !== operationId ||
      record.providerIdentity !== this.identity
    )
      throw new GearError(
        'hitch-receipt-identity',
        'Saved Hitch receipt changed its source or operation identity',
      )
    return record.receipt
  }
  private async saveReceipt(request: OperationRequest, receipt: OperationReceipt): Promise<OperationReceipt> {
    const body = { operationDigest: canonicalDigest(request), providerIdentity: this.identity, receipt }
    await publishFile(
      join(this.path(request), 'receipt.json'),
      JSON.stringify({ ...body, digest: canonicalDigest(body) }),
      { immutable: true },
    )
    return receipt
  }
  private async projectionSource(
    request: OperationRequest,
  ): Promise<{ plan: Plan; receipt: OperationReceipt; prior: OperationReceipt }> {
    const projection = request.projection
    if (!projection || request.repair || request.operation.kind !== 'evaluate_seed')
      throw new GearError('invalid-hitch-projection', 'Expected an original-artifact projection request')
    const plan = await this.planByIdentity(projection.rootOperationId, projection.rootRequestDigest)
    const receipt = await this.receipt(projection.rootOperationId, projection.rootRequestDigest)
    // Core verifies sourceReceiptDigest against its bound receipt. Its metric binding
    // changes that receipt, so the provider checks its own immutable source by operation ID.
    const prior = await this.receipt(projection.sourceOperationId)
    if (
      !plan ||
      !receipt ||
      !prior ||
      canonicalDigest(receipt.provenance) !== projection.rootProvenanceDigest ||
      receipt.result.candidate_id !== request.operation.candidate_id
    )
      throw new GearError(
        'hitch-projection-source',
        'Original completed evaluation receipt is unavailable or changed',
      )
    for (const cell of request.evidence) {
      const source = receipt.evidence.find(
        (value) => value.task_id === cell.task_id && value.repetition === cell.repetition,
      )
      if (
        !source ||
        source.candidate_id !== cell.candidate_id ||
        source.score !== cell.score ||
        source.status !== cell.status ||
        source.scope !== cell.scope
      )
        throw new GearError(
          'hitch-projection-source',
          'Projection observation does not match its original execution',
        )
    }
    return { plan, receipt, prior }
  }
  async completeEvidence(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    const source = await this.projectionSource(request)
    const cached = await this.receipt(request.operationId, canonicalDigest(request))
    if (cached) return cached
    const evidence = structuredClone(request.evidence)
    const bundle = source.receipt.provenance as unknown as {
      evaluations: Array<Record<string, unknown>>
      verifier_sources: VerifierCapture[]
      execution_environment: Json
      execution_artifacts: Json
    }
    const priorBundle = source.prior.provenance as unknown as typeof bundle
    const provenance = structuredClone(priorBundle.evaluations)
    const verifierSources = structuredClone(priorBundle.verifier_sources)
    for (const group of source.plan.groups) {
      if (
        !request.slots.some(
          (slot) => slot.repetition === group.repetition && group.taskIds.includes(slot.taskId),
        )
      )
        continue
      if (!group.evalId)
        throw new GearError('hitch-projection-source', 'Projection cannot submit or resume an execution')
      const inspection = await this.call(['eval', 'inspect', group.evalId, '--json'], signal)
      this.assertConditions(inspection, group)
      const fresh = inspection.result as Record<string, unknown> | undefined
      const original = bundle.evaluations.find((result) => result.eval_id === group.evalId)
      const prior = priorBundle.evaluations.find((result) => result.eval_id === group.evalId)
      if (!fresh || !original || !prior || !appendOnly(original, fresh) || !appendOnly(prior, fresh))
        throw new GearError(
          'hitch-projection-source-changed',
          'Original evaluation fields changed; projection only accepts additional artifact fields',
        )
      // Validate all native slots before any secondary reads.
      decodeHitchTrials(fresh, request, group.taskIds, group.repetition)
      const captures = await captureVerifiers(
        this.profile.executable,
        this.profile.root,
        this.verifierEnabled,
        fresh,
        group.repetition,
        signal,
      )
      for (const capture of captures) {
        for (const records of [bundle.verifier_sources, priorBundle.verifier_sources])
          verifyVerifierExtension(
            records.find(
              (value) => value.run_id === capture.run_id && value.repetition === capture.repetition,
            ),
            capture,
          )
        const index = verifierSources.findIndex(
          (value) => value.run_id === capture.run_id && value.repetition === capture.repetition,
        )
        if (index < 0) verifierSources.push(capture)
        else verifierSources[index] = capture
      }
      const decoded = decodeHitchTrials(fresh, request, group.taskIds, group.repetition, captures)
      for (const missing of request.projection!.missing.filter(
        (slot) => slot.repetition === group.repetition && group.taskIds.includes(slot.taskId),
      )) {
        const cell = evidence.find(
          (value) => value.task_id === missing.taskId && value.repetition === missing.repetition,
        )!
        const projected = decoded.evidence.find((value) => value.task_id === missing.taskId)!
        for (const id of missing.assertions ?? []) {
          const assertion = projected.assertions?.find((value) => value.id === id)
          if (assertion)
            cell.assertions = [...(cell.assertions ?? []).filter((value) => value.id !== id), assertion]
        }
        for (const id of missing.metrics) {
          const metric = projected.raw_metrics?.[id]
          if (metric) cell.raw_metrics = { ...cell.raw_metrics, [id]: metric }
        }
      }
      provenance[provenance.findIndex((result) => result.eval_id === group.evalId)] = fresh
    }
    signal.throwIfAborted()
    return this.saveReceipt(request, {
      result: {
        operation_id: request.operationId,
        kind: 'evaluate_seed',
        candidate_id: request.operation.candidate_id,
        status: 'complete',
        data: null,
      },
      evidence,
      candidate: null,
      physicalAttempts: 0,
      usage: { model_requests: 0, tokens: 0, dollars: 0 },
      provenance: {
        evaluations: provenance as Json,
        verifier_sources: verifierSources as unknown as Json,
        execution_environment: structuredClone(bundle.execution_environment),
        execution_artifacts: structuredClone(bundle.execution_artifacts),
      },
    })
  }
  private async save(request: OperationRequest, plan: Plan) {
    await publishFile(join(this.path(request), 'plan.json'), JSON.stringify(plan))
  }
  private async prepare(request: OperationRequest): Promise<Plan> {
    if (request.operation.kind !== 'evaluate_seed' || !request.operation.candidate_id)
      throw new GearError(
        'hitch-operation-unsupported',
        'Hitch evaluation accepts only reserved evaluation slots',
      )
    const prior = await this.plan(request)
    if (prior) return prior
    const root = this.path(request)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const groups: Group[] = []
    for (const repetition of [...new Set(request.slots.map((slot) => slot.repetition))]) {
      const taskIds = request.slots
        .filter((slot) => slot.repetition === repetition)
        .map((slot) => slot.taskId)
      const dataset = join(root, `dataset-${repetition}`)
      // No plan means no submission was allowed; an interrupted compile can be rebuilt.
      await rm(dataset, { recursive: true, force: true })
      const compiled = (await this.context.compile(dataset, taskIds, this.profile.baseImage)) as
        | {
            environments?: Record<string, { mains: { environment: { context: string; dockerfile: string } } }>
          }
        | undefined
      let agentArgs: string[] = []
      for (const taskId of taskIds) {
        const main = compiled?.environments?.[taskId]?.mains.environment ?? {
          context: 'environment',
          dockerfile: 'environment/Dockerfile',
        }
        for (const path of [main.context, main.dockerfile])
          if (
            (!path.startsWith('environment/') && path !== 'environment') ||
            path.split('/').some((part) => !part || part === '.' || part === '..') ||
            path.includes('\\')
          )
            throw new GearError(
              'invalid-build-context',
              'Target build inputs must stay within the task environment',
            )
        const environment = join(dataset, taskId, main.context)
        if (!this.context.adapter.materialize)
          throw new GearError('target-execution-unsupported', 'Target cannot materialize a task environment')
        const carrier = await this.context.adapter.materialize(
          join(this.context.targets, request.operation.candidate_id),
          environment,
        )
        await appendFile(join(dataset, taskId, main.dockerfile), `\n${carrier.dockerfile}`)
        agentArgs = carrier.agentArgs
      }
      await this.context.seal?.(dataset, taskIds)
      groups.push({
        key: canonicalDigest([request.operationId, repetition]),
        dataset,
        taskIds,
        repetition,
        agentArgs,
        digest: await datasetDigest(dataset),
        evalId: null,
        submissionStarted: false,
      })
    }
    const plan = { operationDigest: canonicalDigest(request), providerIdentity: this.identity, groups }
    await this.save(request, plan)
    return plan
  }
  private control(request: OperationRequest) {
    return new OrderedHitchControl(this.path(request), this.identity, (args, signal) =>
      this.call(args, signal),
    )
  }
  private assertConditions(inspection: Record<string, unknown>, group: Group) {
    const bindings = assertHitchExecutionConditions(inspection, {
      evalId: group.evalId!,
      taskIds: group.taskIds,
      controllerRuntimeId: this.executionEnvironment.controller.runtime_id,
      provider: evaluationProvider,
      dataset: group.dataset,
      harnessRef: this.profile.harnessRef,
      revisionIdentity: this.revisionIdentity,
      model: this.profile.model,
      timeoutMs: this.profile.timeoutMs,
      setupTimeoutMs: this.profile.setupTimeoutMs,
      maxConcurrent: this.profile.maxConcurrent,
      agentArgs: group.agentArgs,
      passEnv: this.profile.passEnv,
      environmentBinding: this.environmentBinding.binding_id,
      artifactPins: artifactPins(this.preparedArtifacts, group.taskIds),
    })
    assertPreparedArtifactsMatch(bindings, this.preparedArtifacts)
    return bindings
  }
  private async observeGroup(request: OperationRequest, plan: Plan, group: Group, signal: AbortSignal) {
    const observed = await this.control(request).observe(request, group.repetition, signal, group.evalId)
    if (!group.evalId) {
      group.evalId = observed.reply.eval_id
      await this.save(request, plan)
    }
    return observed
  }
  private async submitGroup(request: OperationRequest, plan: Plan, group: Group, signal: AbortSignal) {
    group.submissionStarted = true
    await this.save(request, plan)
    const observed = await this.observeGroup(request, plan, group, signal)
    if (observed.reply.submitted) return
    await assertEvaluationEnvironment(
      (args, signal, timeout) => this.call(args, signal, timeout),
      signal,
      this.executionEnvironment,
    )
    await this.preparedRuntime.verify(this.profile, this.preparedArtifacts, this.executionEnvironment, signal)
    // The external ID and start intent are durable before any billable submission.
    const result = await this.call(
      [
        'eval',
        'submit',
        '--provider',
        evaluationProvider,
        '--control-file',
        observed.path,
        '--dataset',
        group.dataset,
        '--harness',
        this.profile.harnessRef,
        '--model',
        this.profile.model,
        '--environment-binding',
        this.environmentBinding.binding_id,
        ...artifactPins(this.preparedArtifacts, group.taskIds).flatMap((pin) => [
          '--artifact-pin',
          JSON.stringify(pin),
        ]),
        '--attempts',
        '1',
        '--infrastructure-retries',
        '0',
        '--max-concurrent',
        String(this.profile.maxConcurrent),
        '--timeout',
        `${this.profile.timeoutMs}ms`,
        '--setup-timeout',
        `${this.profile.setupTimeoutMs}ms`,
        ...group.agentArgs.flatMap((arg) => ['--agent-arg', arg]),
        ...this.profile.passEnv.flatMap((name) => ['--pass-env', name]),
      ],
      signal,
      this.profile.preparationTimeoutMs,
    )
    const reply = this.control(request).validate(result, observed, group.evalId)
    if (!reply.submitted)
      throw new GearError('hitch-submission-invalid', 'Hitch did not confirm the ordered submission')
  }
  async submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    if (request.projection)
      throw new GearError(
        'projection-execution-forbidden',
        'Use original-artifact projection instead of target submission',
      )
    const plan = await this.prepare(request)
    for (const group of plan.groups) {
      await this.submitGroup(request, plan, group, signal)
      await this.call(
        ['eval', 'watch', group.evalId!, '--output', 'json'],
        signal,
        evaluationWatchTimeoutMs(this.profile, group.taskIds.length),
      ).catch(() => {})
    }
    const result = await this.inspect(request, signal)
    if (result.state !== 'complete')
      throw new GearError(
        'operation-needs-recovery',
        'Hitch evaluation is still running or needs inspection',
        { retryable: true },
      )
    return result.receipt
  }
  async inspect(request: OperationRequest, signal: AbortSignal): Promise<OperationInspection> {
    if (request.projection) {
      await this.projectionSource(request)
      const cached = await this.receipt(request.operationId, canonicalDigest(request))
      return cached ? { state: 'complete', receipt: cached } : { state: 'not_submitted' }
    }
    const plan = await this.plan(request)
    if (!plan) return { state: 'not_submitted' }
    const cached = await this.receipt(request.operationId, canonicalDigest(request))
    if (cached) return { state: 'complete', receipt: cached }
    const evidence = [],
      provenance: Json[] = []
    const verifierSources: VerifierCapture[] = []
    const artifactSources: Array<{ eval_id: string; repetition: number; assignments: TaskArtifact[] }> = []
    const artifacts: TrialArtifact[] = []
    const failures: HitchEvaluationFailure[] = []
    let missing = false,
      submitted = false,
      running = false
    for (const group of plan.groups) {
      if (!group.submissionStarted) {
        missing = true
        continue
      }
      const observed = await this.observeGroup(request, plan, group, signal)
      if (!observed.reply.submitted) {
        missing = true
        continue
      }
      submitted = true
      const inspection = await this.call(['eval', 'inspect', group.evalId!, '--json'], signal)
      if (!inspection.result) {
        running = true
        continue
      }
      const result = inspection.result as Record<string, unknown>
      const assignments = this.assertConditions(inspection, group)
      const failure = hitchEvaluationFailure(result)
      if (failure) failures.push(failure)
      artifactSources.push({ eval_id: group.evalId!, repetition: group.repetition, assignments })
      assertStablePreparedArtifacts(artifactSources.flatMap((source) => source.assignments))
      decodeHitchTrials(result, request, group.taskIds, group.repetition)
      const captures = await captureVerifiers(
        this.profile.executable,
        this.profile.root,
        this.verifierEnabled,
        result,
        group.repetition,
        signal,
      )
      verifierSources.push(...captures)
      const decoded = decodeHitchTrials(result, request, group.taskIds, group.repetition, captures)
      evidence.push(...decoded.evidence)
      provenance.push(decoded.provenance)
      if (this.trajectoryEnabled && request.partition === 'seed') {
        const reader = new HitchArtifactReader(this.profile.executable, this.profile.root)
        const trials = result.trials as Array<{ run_id: string; task_id: string }>
        for (let index = 0; index < trials.length; index += 8) {
          const results = await Promise.allSettled(
            trials
              .slice(index, index + 8)
              .map((trial) => reader.capture(trial.run_id, trial.task_id, group.repetition, signal)),
          )
          for (const value of results) {
            if (value.status === 'rejected') throw value.reason
            artifacts.push(value.value)
          }
        }
      }
    }
    if (running) return { state: 'running' }
    if (missing) return { state: submitted ? 'resumable' : 'not_submitted' }
    await assertEvaluationEnvironment(
      (args, signal, timeout) => this.call(args, signal, timeout),
      signal,
      this.executionEnvironment,
    )
    return {
      state: 'complete',
      receipt: await this.saveReceipt(request, {
        result: {
          operation_id: request.operationId,
          kind: 'evaluate_seed',
          status: failures.length ? 'failed' : 'complete',
          candidate_id: request.operation.candidate_id,
          data: failureData(failures),
        },
        candidate: null,
        evidence,
        // Missing terminal slots may already have executed; charge their reserved upper bound.
        physicalAttempts: evidence.length,
        usage: { model_requests: null, tokens: null, dollars: null },
        provenance: {
          evaluations: provenance,
          verifier_sources: verifierSources as unknown as Json,
          execution_environment: this.executionEnvironment as unknown as Json,
          execution_artifacts: artifactSources as unknown as Json,
        },
        ...(artifacts.length ? { artifacts } : {}),
      }),
    }
  }
  async cancel(request: OperationRequest): Promise<void> {
    if (request.projection) return
    await this.control(request).cancel(request)
  }
}

/** Enrichment can add fields, but cannot rewrite any originally observed artifact value. */
function appendOnly(original: unknown, next: unknown): boolean {
  if (original === null || typeof original !== 'object') return original === next
  if (Array.isArray(original))
    return (
      Array.isArray(next) &&
      next.length >= original.length &&
      original.every((value, index) => appendOnly(value, next[index]))
    )
  return (
    !!next &&
    typeof next === 'object' &&
    !Array.isArray(next) &&
    Object.entries(original).every(
      ([key, value]) => Object.hasOwn(next, key) && appendOnly(value, (next as Record<string, unknown>)[key]),
    )
  )
}
