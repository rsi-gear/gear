import type { Json, Operation } from '../domain/algorithm-wire.js'
import type * as V2 from '../domain/algorithm-wire-v2.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type {
  OperatorArtifact,
  OperatorCallEntry,
  OperatorJournal,
  OperatorSample,
} from '../domain/operator-run.js'
import type { JournalOperation, RunJournal } from '../domain/run.js'
import type { OperatorEffects, ScreeningProjector } from '../ports/operator-effects.js'
import type { OperationProvider } from '../ports/operations.js'
import { generationLedger, reserveGeneration } from './generation-budget.js'
import { operatorArtifact, operatorHistory } from '../domain/operator-artifacts.js'
import { frozenComponent } from '../domain/algorithm-components.js'
import { validateTaskStream } from '../domain/task-stream.js'
import { operatorObjective } from '../domain/operator-objective.js'
import { operatorStorageLimits } from '../domain/operator-run.js'

function fail(code: string, message: string): never {
  throw new GearError(code, message)
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
// New admissions freeze this versioned capacity contract. Never truncate data.
const MAX_RESULT_BYTES = operatorStorageLimits.callBytes
const MAX_RESULTS_BYTES = operatorStorageLimits.resultsBytes
const MAX_OPERATOR_JOURNAL_BYTES = operatorStorageLimits.journalBytes
export const candidateRef = (journal: RunJournal, id: string): V2.CandidateRef => {
  const candidate = journal.candidates.find((item) => item.id === id)
  if (!candidate) return fail('unknown-candidate', 'Candidate is outside the admitted run')
  return { run_id: journal.id, candidate_id: id, digest: candidate.digest }
}

export function authorizeSource(journal: RunJournal, ref: V2.SourceRef): void {
  if (ref.run_id !== journal.id) {
    const imported = journal.spec.operatorPolicy?.imports?.find(
      (entry) => canonicalDigest(entry.ref) === canonicalDigest(ref),
    )
    if (!imported) fail('source-not-admitted', 'Cross-run material requires explicit import')
    if ('candidate_id' in ref) {
      if (
        !imported.candidate ||
        !journal.candidates.some(
          (candidate) => canonicalDigest(candidate) === canonicalDigest(imported.candidate),
        )
      )
        fail('source-not-admitted', 'Imported candidate copy is unavailable')
      return
    }
  }
  if ('candidate_id' in ref) {
    if (canonicalDigest(candidateRef(journal, ref.candidate_id)) !== canonicalDigest(ref))
      fail('candidate-identity-mismatch', 'Candidate reference differs from the sealed manifest')
  } else if (
    !journal.operators?.artifacts.some((item) => canonicalDigest(item.ref) === canonicalDigest(ref)) ||
    !['agent', 'optimization'].includes(ref.visibility)
  )
    fail('artifact-not-authorized', 'Artifact is absent or outside the optimizer visibility policy')
}

/** Validate references in author research/outcome records without trusting their asserted provenance. */
function authorizeRecord(journal: RunJournal, value: Json, depth = 0): void {
  if (depth > 64) fail('record-too-deep', 'Author record exceeds the nesting limit')
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value) && 'run_id' in value && ('candidate_id' in value || 'visibility' in value)) {
    validateAlgorithmWire('SourceRef', value, 2)
    authorizeSource(journal, value as V2.SourceRef)
  }
  for (const item of Object.values(value)) authorizeRecord(journal, item, depth + 1)
}

export function operatorCapabilities(provider: OperationProvider, effects: OperatorEffects): string[] {
  return [
    ...new Set([
      ...effects.capabilities,
      'evaluate',
      'task_stream',
      ...(provider.capabilities.targetAssets && effects.prepareTarget ? ['target_assets'] : []),
      ...(provider.capabilities.blindProjection &&
      provider.captureExecutions &&
      provider.readExecutionArtifact
        ? ['blind_projection', 'scored_private', 'target_artifacts']
        : []),
      ...(provider.capabilities.operatorMeta ? ['meta', 'candidate_generate'] : []),
    ]),
  ].sort()
}

/** The v2 interpreter authorizes finite effects; all algorithm semantics remain in Python. */
export class OperatorRuntime {
  constructor(
    readonly effects: OperatorEffects,
    readonly provider: OperationProvider,
    readonly screening?: ScreeningProjector,
  ) {}

  admit(journal: RunJournal): void {
    const policy = journal.spec.operatorPolicy,
      component = journal.spec.algorithm.component
    if (
      journal.spec.algorithm.protocol_version !== 2 ||
      !policy ||
      policy.version !== 2 ||
      !journal.operators ||
      journal.operators.version !== 2 ||
      !component
    )
      fail('operator-protocol-mismatch', 'v2 requires a frozen policy and a separate v2 journal')
    validateAlgorithmWire('ModuleSpec', component, 2)
    if (journal.operators.state.version !== component.state_schema_version)
      fail('operator-state-version', 'Saved state does not match the frozen root component')
    validateTaskStream(journal)
    if (
      policy.storageLimits &&
      canonicalDigest(policy.storageLimits) !== canonicalDigest(operatorStorageLimits)
    )
      fail('operator-limits-version', 'Frozen operator capacity differs; use the matching runtime')
    for (const imported of policy.imports ?? []) authorizeSource(journal, imported.ref)
    const supported = operatorCapabilities(this.provider, this.effects)
    for (const capability of [...policy.capabilities, ...(journal.spec.algorithm.requirements ?? [])])
      if (!supported.includes(capability))
        fail('operator-capability-unsupported', `Unsupported capability: ${capability}`)
    for (const entry of journal.operators.calls) {
      if (entry.requestDigest !== canonicalDigest(entry.call))
        fail('call-identity-mismatch', 'Saved author request changed')
    }
    if (policy.screening) {
      if (!this.screening)
        fail('screening-projector-required', 'Mandatory screening requires a separate restricted projector')
      for (const ref of Object.values(policy.screening)) frozenComponent(component as V2.ComponentSpec, ref)
    }
  }

  view(journal: RunJournal): V2.SearchView {
    const runtime = journal.operators!,
      generation = generationLedger(journal)
    const access = journal.spec.operatorPolicy!.access
    const order = access?.task_order
    const visible = order ? new Set(order.slice(0, runtime.stream!.index + 1)) : null
    return structuredClone({
      run_id: journal.id,
      step_id: runtime.decisions.length,
      seed: journal.spec.seed,
      tasks: journal.spec.seedTasks
        .filter((task) => !visible || visible.has(task.id))
        .map((task) => ({ ...task, input: journal.spec.operatorPolicy!.taskInputs?.[task.id] ?? null })),
      candidates: journal.candidates.map((item) => candidateRef(journal, item.id)),
      results: runtime.calls.flatMap((entry) => (entry.result ? [entry.result] : [])),
      budget: {
        evaluations_remaining:
          journal.spec.budget.maxEvaluations -
          journal.operations.reduce(
            (sum, item) => sum + (item.receipt?.physicalAttempts ?? item.reservedAttempts),
            0,
          ),
        candidates_remaining:
          journal.spec.budget.maxCandidates -
          runtime.calls.filter((entry) => entry.candidateId !== null).length,
        generation_requests_remaining: generation.metrics.model_requests.remaining,
        generation_tokens_remaining: generation.metrics.tokens.remaining,
        read_calls_remaining:
          journal.spec.operatorPolicy!.readBudget.calls -
          runtime.calls.filter((entry) => entry.call.effect.kind === 'read').length,
        read_bytes_remaining:
          journal.spec.operatorPolicy!.readBudget.bytes -
          runtime.calls.reduce((sum, entry) => sum + entry.reservedReadBytes, 0),
        rounds: journal.spec.budget.rounds,
        repetitions: journal.spec.budget.repetitions,
      },
      anchor: candidateRef(journal, journal.spec.anchor.id),
      objective:
        access?.exposure === 'blind' ? null : (operatorObjective(journal.spec.objective) as unknown as Json),
      history: runtime.history,
      stream: order
        ? ({
            revision: runtime.stream!.revision,
            index: runtime.stream!.index,
            current_task: order[runtime.stream!.index] ?? null,
            complete: runtime.stream!.index === order.length,
            completed: runtime.stream!.completed,
          } as unknown as Json)
        : null,
      assets: runtime.artifacts
        .filter(
          (artifact) =>
            artifact.ref.kind === 'library' ||
            journal.spec.operatorPolicy!.imports?.some(
              (item) => canonicalDigest(item.ref) === canonicalDigest(artifact.ref),
            ),
        )
        .map((artifact) => artifact.ref),
      capabilities: journal.spec.operatorPolicy!.capabilities,
    })
  }

  async prepareView(journal: RunJournal, save: () => Promise<void>): Promise<void> {
    const history = operatorHistory(journal)
    if (journal.operators!.history?.digest === history.ref.digest) return
    if (bytes(journal.operators) + bytes(history) > MAX_OPERATOR_JOURNAL_BYTES)
      fail('operator-storage-budget', 'Frozen operator history exhausted its 128 MiB storage limit')
    if (!journal.operators!.artifacts.some((artifact) => artifact.ref.digest === history.ref.digest))
      journal.operators!.artifacts.push(history)
    journal.operators!.history = history.ref
    await save()
  }

  async reserve(
    journal: RunJournal,
    view: V2.SearchView,
    decision: V2.Decision,
    signal: AbortSignal,
  ): Promise<{ operators: OperatorJournal; operations: JournalOperation[] }> {
    validateAlgorithmWire('Decision', decision, 2)
    if (bytes(decision.state) > 2 * 1024 * 1024 || bytes(decision.records) > 2 * 1024 * 1024)
      fail('operator-state-budget', 'State and research records each have a 2 MiB limit per decision')
    if (decision.state.version !== journal.spec.algorithm.component!.state_schema_version)
      fail('operator-state-version', 'Decision state version differs from the frozen root component')
    if (
      (decision.terminal !== null) === decision.calls.length > 0 ||
      decision.calls.length > 256 ||
      new Set(decision.calls.map((call) => call.key)).size !== decision.calls.length ||
      decision.records.length > 64
    )
      fail('invalid-operator-decision', 'Decision requires independent unique calls or an exclusive terminal')
    if (decision.terminal?.kind === 'nominate') {
      authorizeSource(journal, decision.terminal.candidate)
      if (decision.terminal.candidate.run_id !== journal.id)
        fail('imported-candidate-alias-required', 'Nominate the imported candidate alias in the current run')
      if (
        journal.spec.operatorPolicy!.screening &&
        !journal.operators!.calls.some(
          (entry) =>
            entry.call.effect.kind === 'execute' &&
            entry.call.effect.input.assets.length === 0 &&
            canonicalDigest(entry.call.effect.input.candidate) ===
              canonicalDigest(decision.terminal!.candidate) &&
            entry.screening?.verdict.status === 'allow',
        )
      )
        fail('screening-required', 'The nominee has no independently accepted screening proof')
    }
    authorizeRecord(journal, decision.terminal?.outcome ?? null)
    decision.records.forEach((record) => authorizeRecord(journal, record))
    if (decision.calls.some((call) => call.effect.kind === 'stream') && decision.calls.length !== 1)
      fail('task-completion-exclusive', 'CompleteTask must be the sole call in its Decision')
    const membership = new Set<string>()
    const visit = (component: V2.ComponentSpec) => {
      membership.add(
        canonicalDigest({
          entrypoint: component.entrypoint,
          configuration_digest: canonicalDigest(component),
        }),
      )
      if (component.kind === 'module') Object.values(component.children).forEach(visit)
    }
    visit(journal.spec.algorithm.component as V2.ModuleSpec)
    const runtime = structuredClone(journal.operators!),
      operations: JournalOperation[] = [],
      callIds: string[] = []
    for (const call of decision.calls) {
      const requestDigest = canonicalDigest(call),
        previous = runtime.calls.find((entry) => entry.call.key === call.key)
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          fail('call-key-conflict', 'Call key was already bound to different inputs')
        callIds.push(previous.id)
        continue
      }
      if (!membership.has(canonicalDigest(call.operator_ref)))
        fail('operator-not-frozen', 'Call operator is outside the frozen component tree')
      if (
        bytes(call) > 2 * 1024 * 1024 ||
        canonicalDigest(call.output_schema_ref.schema) !== call.output_schema_ref.digest
      )
        fail('call-schema-identity', 'Call exceeds bounds or its output schema changed')
      this.effects.validateSchema(call.output_schema_ref.schema)
      const entry: OperatorCallEntry = {
        id: canonicalDigest([journal.id, 'operator-call-v2', requestDigest, journal.specDigest]),
        requestDigest,
        call: structuredClone(call),
        status: 'reserved',
        operationIds: [],
        candidateId: null,
        materials: [],
        reservedReadBytes: 0,
      }
      const scope = (tasks: string[]) => {
        if (
          !tasks.length ||
          new Set(tasks).size !== tasks.length ||
          tasks.some((id) => !view.tasks.some((task) => task.id === id))
        )
          fail('task-not-authorized', 'Call task scope is outside the visible admitted tasks')
      }
      const { effect } = call
      if (effect.kind === 'meta' || effect.kind === 'candidate') {
        const input = effect.input,
          base = 'base' in input ? input.base : input.candidate
        authorizeSource(journal, base)
        if (base.run_id !== journal.id)
          fail('imported-candidate-alias-required', 'Use the local imported candidate alias as the base')
        input.sources.forEach((ref) => authorizeSource(journal, ref))
        if (effect.kind === 'candidate' && effect.input.mode === 'edits') {
          for (const edit of effect.input.plan.edits)
            if (edit.blob) {
              authorizeSource(journal, edit.blob)
              if (!input.sources.some((source) => canonicalDigest(source) === canonicalDigest(edit.blob)))
                fail('edit-blob-not-granted', 'Edit blobs must be declared in the read-only sources')
            }
        }
        entry.materials = await this.effects.materials(journal, [base, ...input.sources], signal)
        if (effect.kind === 'candidate') entry.candidateId = `candidate_${entry.id.slice(7, 39)}`
        if (effect.kind === 'meta' || ('mode' in input && input.mode === 'model')) {
          if (
            !journal.spec.operatorPolicy!.capabilities.includes(
              effect.kind === 'meta' ? 'meta' : 'candidate_generate',
            )
          )
            fail('operator-capability-unsupported', 'Provider does not support v2 Meta effects')
          const model =
            effect.kind === 'meta' ? effect.input : effect.input.mode === 'model' ? effect.input : null
          if (!model) fail('invalid-meta-effect', 'Expected a model call')
          scope(model.task_ids)
          if (effect.kind === 'meta') {
            if (canonicalDigest(effect.input.schema) !== call.output_schema_ref.digest)
              fail('meta-schema-mismatch', 'Meta and Call output schemas must match')
          }
          const operation: Operation = {
            kind: effect.kind === 'meta' ? 'diagnose_seed' : 'generate_candidate',
            candidate_id: entry.candidateId ?? base.candidate_id,
            parent_id: entry.candidateId ? base.candidate_id : null,
            task_ids: model.task_ids,
            scope: 'global',
            rationale: decision.reason,
            payload: null,
          }
          let limits = reserveGeneration(journal)
          if (model.max_tokens !== null) {
            if (!this.provider.capabilities.generationBudget)
              fail('generation-budget-unsupported', 'Provider cannot enforce the per-call token limit')
            limits = { ...limits, tokens: Math.min(limits?.tokens ?? model.max_tokens, model.max_tokens) }
          }
          const request = {
            runId: journal.id,
            generation: journal.generation,
            operation,
            partition: 'seed' as const,
            repetitions: journal.spec.budget.repetitions,
            slots: [],
            evidence: [],
            ...(limits ? { generationLimits: limits } : {}),
            operatorCall: { version: 2 as const, callId: entry.id, effect, materials: entry.materials },
          }
          const operationId = canonicalDigest([entry.id, request])
          entry.operationIds.push(operationId)
          operations.push({ request: { ...request, operationId }, status: 'reserved', reservedAttempts: 0 })
        } else this.effects.validateLocal(call)
      } else if (effect.kind === 'execute') {
        const input = effect.input
        authorizeSource(journal, input.candidate)
        if (input.candidate.run_id !== journal.id)
          fail('imported-candidate-alias-required', 'Execute the local imported candidate alias')
        scope(input.plan.tasks.map((item) => item.task_id))
        const blind = journal.spec.operatorPolicy!.access?.exposure === 'blind'
        if (
          blind
            ? input.exposure !== 'blind' || input.mode !== 'scored_private'
            : input.exposure !== 'scored' || input.mode !== 'scored'
        )
          fail(
            'execution-exposure-denied',
            'Execution cannot expand the frozen feedback policy or silently change backend',
          )
        if (blind && (!this.provider.capabilities.blindProjection || !this.provider.captureExecutions))
          fail('operator-capability-unsupported', 'Provider has no independent target projection')
        if (input.plan.randomness !== 'provider' || input.plan.seed !== null || input.parameters !== null)
          fail('operator-capability-unsupported', 'Execution conditions require an unsupported capability')
        input.assets.forEach((ref) => authorizeSource(journal, ref))
        if (input.assets.length && (!this.provider.capabilities.targetAssets || !this.effects.prepareTarget))
          fail('operator-capability-unsupported', 'Provider cannot execute versioned target assets')
        const executionTarget = input.assets.length
          ? await this.effects.prepareTarget!(journal, input.candidate, input.assets, signal)
          : undefined
        if (input.screening !== null) {
          const screening = journal.operators!.calls.find(
            (item) =>
              item.call.key === input.screening!.key &&
              item.requestDigest === input.screening!.request_digest,
          )
          if (
            screening?.result?.status !== 'succeeded' ||
            screening.call.effect.kind !== 'meta' ||
            canonicalDigest(screening.call.effect.input.candidate) !== canonicalDigest(input.candidate) ||
            input.plan.tasks.some(
              (task) =>
                screening.call.effect.kind !== 'meta' ||
                !screening.call.effect.input.task_ids.includes(task.task_id),
            )
          )
            fail(
              'screening-receipt-mismatch',
              'Screening must reference a successful critic for the same candidate and task scope',
            )
        }
        const policy = journal.spec.operatorPolicy!.screening
        if (policy) {
          const critic = journal.operators!.calls.find(
            (item) =>
              item.call.key === input.screening?.key && item.requestDigest === input.screening.request_digest,
          )
          if (
            !critic ||
            critic.result?.status !== 'succeeded' ||
            canonicalDigest(critic.call.operator_ref) !== canonicalDigest(policy.critic) ||
            input.assets.some(
              (ref) =>
                critic.call.effect.kind !== 'meta' ||
                !critic.call.effect.input.sources.some(
                  (source) => canonicalDigest(source) === canonicalDigest(ref),
                ),
            )
          )
            fail('screening-required', 'Evaluation requires a receipt from the frozen critic')
          const candidate = journal.candidates.find((item) => item.id === input.candidate.candidate_id)!
          const base = candidateRef(journal, candidate.parent_id ?? candidate.id)
          const material = await this.effects.materials(journal, [base, input.candidate], signal)
          const projection = {
            algorithm: journal.spec.algorithm,
            policy,
            candidate: input.candidate,
            before: material.find((item) => canonicalDigest(item.ref) === canonicalDigest(base))!.files!,
            after:
              executionTarget?.files ??
              material.find((item) => canonicalDigest(item.ref) === canonicalDigest(input.candidate))!.files!,
            critic: critic.result.value,
          }
          const verdict = await this.screening!.screen(structuredClone(projection), signal)
          entry.screening = { inputDigest: canonicalDigest(projection), verdict }
          if (verdict.status !== 'allow') {
            entry.status = 'complete'
            entry.result = {
              ref: { key: call.key, request_digest: requestDigest },
              status: 'failed',
              value: null,
              error: { code: 'screening-rejected', status: verdict.status, message: verdict.reason },
              artifacts: [],
              usage: null,
            }
            callIds.push(entry.id)
            runtime.calls.push(entry)
            continue
          }
        }
        if (
          input.metrics.some((name) => !journal.spec.objective?.metrics.some((metric) => metric.id === name))
        )
          fail('metric-not-admitted', 'Execution requested an undeclared metric')
        if (
          blind &&
          input.metrics.some((name) => !journal.spec.operatorPolicy!.access!.usage_metrics.includes(name))
        )
          fail('metric-not-visible', 'Blind execution may only request admitted target usage metrics')
        const executionIdentity = canonicalDigest([
          input.candidate,
          journal.spec.benchmarkDigest,
          journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
          input.assets,
          input.parameters,
          input.plan.randomness,
          input.plan.seed,
          input.exposure,
          executionTarget?.digest ?? null,
        ])
        if (input.plan.mode === 'reuse') {
          if (input.plan.plan_id !== null || input.plan.evidence_set === null)
            fail('invalid-sample-plan', 'Reuse requires an explicit sealed evidence set')
          authorizeSource(journal, input.plan.evidence_set)
          const set = journal.operators!.artifacts.find(
            (item) => canonicalDigest(item.ref) === canonicalDigest(input.plan.evidence_set),
          )!
          if (set.ref.kind !== (blind ? 'execution_set' : 'evidence_set'))
            fail('invalid-sample-plan', 'Reuse requires a collection with the admitted exposure')
          const value = set.value as {
            spec?: V2.EvidenceSetSpec
            candidate?: V2.CandidateRef
            records: Array<{ sample_id: string }>
          }
          if (canonicalDigest(value.spec?.candidate ?? value.candidate) !== canonicalDigest(input.candidate))
            fail('sample-execution-mismatch', 'Evidence set belongs to another candidate')
          const selected = value.records
            .map((record) => runtime.samples.find((sample) => sample.id === record.sample_id)!)
            .filter(
              (sample) =>
                sample &&
                input.plan.tasks.some(
                  (task) => task.task_id === sample.taskId && task.slots.includes(sample.slot),
                ),
            )
          if (
            selected.length !== input.plan.tasks.reduce((sum, task) => sum + task.slots.length, 0) ||
            selected.some((sample) => sample.executionIdentity !== executionIdentity)
          )
            fail('sample-reuse-missing', 'Reuse cannot execute missing or incompatible samples')
          entry.sampleIds = selected.map((sample) => sample.id)
          entry.operationIds = [...new Set(selected.map((sample) => sample.operationId))]
          callIds.push(entry.id)
          runtime.calls.push(entry)
          continue
        }
        if (input.plan.mode === 'ensure') {
          const fixed = journal.spec.operatorPolicy!.fixedPlan
          if (
            input.plan.plan_id !== fixed.name ||
            input.plan.evidence_set !== null ||
            input.plan.tasks.some((task) =>
              task.slots.some(
                (slot) => !fixed.tasks.find((item) => item.task_id === task.task_id)?.slots.includes(slot),
              ),
            )
          )
            fail('sample-plan-not-admitted', 'Ensure must use slots of the frozen fixed plan')
        } else if (input.plan.plan_id !== null || input.plan.evidence_set !== null)
          fail('invalid-sample-plan', 'Fresh plans derive identity from the committed call')
        const planId = canonicalDigest([
          journal.id,
          input.plan.mode === 'fresh' ? entry.id : input.plan.plan_id,
          executionIdentity,
        ])
        const samples: OperatorSample[] = []
        for (const task of input.plan.tasks) {
          if (new Set(task.slots).size !== task.slots.length)
            fail('duplicate-sample-slot', 'Sample slots must be unique')
          for (const slot of task.slots) {
            const id = canonicalDigest([planId, task.task_id, slot])
            const previous = runtime.samples.find((sample) => sample.id === id)
            samples.push(
              previous ?? {
                id,
                planId,
                executionIdentity,
                exposure: input.exposure,
                candidateId: input.candidate.candidate_id,
                taskId: task.task_id,
                slot,
                operationId: '',
              },
            )
          }
        }
        const fresh = samples.filter((sample) => !sample.operationId)
        if (fresh.length) {
          const operationId = canonicalDigest([entry.id, executionIdentity, fresh.map((sample) => sample.id)])
          fresh.forEach((sample) => {
            sample.operationId = operationId
            runtime.samples.push(sample)
          })
          operations.push({
            status: 'reserved',
            reservedAttempts: fresh.length,
            request: {
              operationId,
              runId: journal.id,
              generation: journal.generation,
              partition: 'seed',
              evidence: [],
              operation: {
                kind: 'evaluate_seed',
                candidate_id: input.candidate.candidate_id,
                parent_id: null,
                task_ids: [...new Set(fresh.map((sample) => sample.taskId))],
                scope: 'global',
                rationale: decision.reason,
                payload: null,
              },
              slots: fresh.map((sample) => ({ taskId: sample.taskId, repetition: sample.slot })),
              repetitions: Math.max(...fresh.map((sample) => sample.slot)) + 1,
              ...(executionTarget ? { executionTarget } : {}),
              ...(journal.spec.objective
                ? {
                    metrics: journal.spec.objective.metrics,
                    ...(journal.spec.objective.assertions?.length
                      ? { assertions: journal.spec.objective.assertions }
                      : {}),
                  }
                : {}),
              operatorSamples: {
                callId: entry.id,
                sampleIds: fresh.map((sample) => sample.id),
                executionIdentity,
                exposure: input.exposure,
              },
            },
          })
        }
        entry.sampleIds = samples.map((sample) => sample.id)
        entry.operationIds = [...new Set(samples.map((sample) => sample.operationId))]
      } else if (effect.kind === 'read') {
        this.effects.validateLocal(call)
        if (effect.input.view === 'artifact') authorizeSource(journal, effect.input.ref)
        else if (effect.input.view === 'history') authorizeSource(journal, effect.input.snapshot)
        else {
          if (journal.spec.operatorPolicy!.access?.exposure === 'blind')
            fail('evidence-not-visible', 'Assessment reads are private under blind exposure')
          authorizeSource(journal, effect.input.spec.candidate)
          scope(effect.input.spec.tasks.map((task) => task.task_id))
          effect.input.spec.assessments.forEach((ref) => authorizeSource(journal, ref))
        }
        entry.reservedReadBytes = effect.input.view === 'artifact' ? effect.input.max_bytes : 1024 * 1024
      } else if (effect.kind === 'stream') {
        const progress = runtime.stream,
          order = journal.spec.operatorPolicy!.access?.task_order,
          input = effect.input
        if (
          !progress ||
          !order ||
          order[progress.index] !== input.task_id ||
          progress.revision !== input.expected_revision
        )
          fail('task-stream-conflict', 'Task completion differs from the current authorized task or revision')
        authorizeSource(journal, input.output)
        const output = runtime.artifacts.find(
          (artifact) => canonicalDigest(artifact.ref) === canonicalDigest(input.output),
        )!
        const sample = runtime.samples.find((sample) => sample.id === input.sample_id)
        const value = output.value as Record<string, Json>
        if (
          output.ref.kind !== 'task_output' ||
          !sample ||
          sample.taskId !== input.task_id ||
          value.sample_id !== input.sample_id ||
          value.task_id !== input.task_id
        )
          fail('task-output-mismatch', 'Selected output must be sealed for this task and sample')
        if (
          value.data &&
          typeof value.data === 'object' &&
          !Array.isArray(value.data) &&
          value.data.available === false
        )
          fail('task-output-unavailable', 'Task completion requires an available sealed output')
        for (const library of input.library_refs) {
          authorizeSource(journal, library)
          if (library.kind !== 'library')
            fail('invalid-library-snapshot', 'Task completion requires library snapshots')
        }
      } else if (effect.kind === 'library') {
        this.effects.validateLocal(call)
        const input = effect.input
        if (input.mode === 'commit') {
          if (input.base) {
            authorizeSource(journal, input.base)
            if (input.base.kind !== 'library')
              fail('invalid-library-base', 'Library base must be a sealed library snapshot')
          }
          Object.values(input.assets).forEach((ref) => authorizeSource(journal, ref))
          authorizeRecord(journal, input.data)
        } else {
          authorizeSource(journal, input.snapshot)
          if (input.snapshot.kind !== 'library')
            fail('invalid-library-snapshot', 'Publish requires a sealed library snapshot')
        }
      } else {
        this.effects.validateLocal(call)
      }
      callIds.push(entry.id)
      runtime.calls.push(entry)
    }
    if (
      runtime.calls.filter((entry) => entry.candidateId !== null).length > journal.spec.budget.maxCandidates
    )
      fail('candidate-budget-exhausted', 'Complete call batch exceeds candidate quota')
    const reads = runtime.calls.filter((entry) => entry.call.effect.kind === 'read')
    if (
      reads.length > journal.spec.operatorPolicy!.readBudget.calls ||
      reads.reduce((sum, entry) => sum + entry.reservedReadBytes, 0) >
        journal.spec.operatorPolicy!.readBudget.bytes
    )
      fail('read-budget-exhausted', 'Complete call batch exceeds material read quota')
    runtime.state = structuredClone(decision.state)
    runtime.decisions.push({
      stepId: view.step_id,
      inputDigest: canonicalDigest(view),
      decision: structuredClone(decision),
      callIds,
    })
    if (runtime.calls.length > operatorStorageLimits.calls || bytes(runtime) > MAX_OPERATOR_JOURNAL_BYTES)
      fail('operator-storage-budget', 'Call batch exceeds the frozen operator storage capacity')
    const resultReservation = runtime.calls.reduce(
      (total, entry) => total + (entry.result ? bytes(entry.result) : MAX_RESULT_BYTES),
      0,
    )
    if (resultReservation > MAX_RESULTS_BYTES)
      fail('operator-result-budget', 'Call batch exceeds the 32 MiB retained result capacity')
    return { operators: runtime, operations }
  }

  /** Runs only after the enclosing state, call keys and all external reservations are durable. */
  async settle(journal: RunJournal, save: () => Promise<void>, signal: AbortSignal): Promise<void> {
    for (const entry of journal.operators!.calls.filter((item) => item.status !== 'complete')) {
      signal.throwIfAborted()
      const operations = entry.operationIds.map((id) =>
        journal.operations.find((item) => item.request.operationId === id)!,
      )
      if (operations.some((item) => !item || item.status !== 'complete')) continue
      let value: Json,
        artifacts: OperatorArtifact[] = [],
        usage: Record<string, Json> | null = null,
        error: Record<string, Json> | null = null
      let streamCompletion: NonNullable<OperatorJournal['stream']>['completed'][number] | undefined
      if (entry.call.effect.kind === 'execute') {
        const executionRefs: Json[] = []
        if (this.provider.capabilities.blindProjection && this.provider.captureExecutions) {
          const projected = new Map<
            string,
            Awaited<ReturnType<NonNullable<OperationProvider['captureExecutions']>>>
          >()
          for (const id of entry.sampleIds!) {
            const sample = journal.operators!.samples.find((item) => item.id === id)!
            const attempts = journal.operations.filter(
              (item) =>
                item.request.operatorSamples?.sampleIds.includes(id) &&
                item.status === 'complete' &&
                item.receipt!.evidence.some(
                  (cell) => cell.task_id === sample.taskId && cell.repetition === sample.slot,
                ),
            )
            const latest = attempts.at(-1)!
            if (!projected.has(latest.request.operationId))
              projected.set(
                latest.request.operationId,
                await this.provider.captureExecutions(latest.request, latest.receipt!, signal),
              )
            const matches = projected
              .get(latest.request.operationId)!
              .filter((item) => item.taskId === sample.taskId && item.repetition === sample.slot)
            if (matches.length !== 1)
              fail('target-projection-mismatch', 'Target projection must match exactly one reserved sample')
            const target = matches[0]!,
              binding = {
                sample_id: id,
                attempt_id: latest.request.projection?.rootOperationId ?? latest.request.operationId,
                task_id: sample.taskId,
                status: target.status,
              }
            const output = operatorArtifact(
              journal,
              'task_output',
              { ...binding, data: target.output.value },
              [entry.call.effect.input.candidate],
            )
            if (target.output.external) output.external = target.output.external
            artifacts.push(output)
            let trajectory: OperatorArtifact | undefined
            if (target.trajectory) {
              trajectory = operatorArtifact(
                journal,
                'target_trajectory',
                { ...binding, data: target.trajectory.value },
                [entry.call.effect.input.candidate],
              )
              if (target.trajectory.external) trajectory.external = target.trajectory.external
              artifacts.push(trajectory)
            }
            executionRefs.push({ ...binding, output: output.ref, trajectory: trajectory?.ref ?? null })
          }
        }
        if (entry.call.effect.input.exposure === 'blind') {
          const set = operatorArtifact(
            journal,
            'execution_set',
            {
              candidate: entry.call.effect.input.candidate,
              tasks: entry.call.effect.input.plan.tasks,
              records: executionRefs,
            },
            [entry.call.effect.input.candidate],
          )
          artifacts.push(set)
          value = { ref: set.ref, records: executionRefs, loaded: true, cursor: null }
        } else {
          const records = entry.sampleIds!.map((id) => {
            const sample = journal.operators!.samples.find((item) => item.id === id)!
            const attempts = journal.operations.filter((item) =>
              item.request.operatorSamples?.sampleIds.includes(id),
            )
            const completed = attempts.filter(
              (item) =>
                item.status === 'complete' &&
                item.receipt!.evidence.some(
                  (cell) => cell.task_id === sample.taskId && cell.repetition === sample.slot,
                ),
            )
            const latest = completed.at(-1)!
            const evidence = latest.receipt!.evidence.find(
              (cell) => cell.task_id === sample.taskId && cell.repetition === sample.slot,
            )!
            const assessment = operatorArtifact(
              journal,
              'assessment',
              {
                sample_id: id,
                attempt_id: latest.request.projection?.rootOperationId ?? latest.request.operationId,
                execution_identity: sample.executionIdentity,
                evidence: evidence as unknown as Json,
              },
              [
                entry.call.effect.kind === 'execute'
                  ? entry.call.effect.input.candidate
                  : candidateRef(journal, sample.candidateId),
              ],
            )
            artifacts.push(assessment)
            return {
              sample_id: id,
              attempt_id: latest.request.projection?.rootOperationId ?? latest.request.operationId,
              task_id: sample.taskId,
              slot: sample.slot,
              assessment: assessment.ref,
              score: evidence.score,
              status: evidence.status,
              raw_metrics: evidence.raw_metrics ?? null,
            }
          })
          const set = operatorArtifact(
            journal,
            'evidence_set',
            {
              spec: {
                candidate: entry.call.effect.input.candidate,
                assessments: records.map((record) => record.assessment),
                tasks: entry.call.effect.input.plan.tasks,
                task_weights: entry.call.effect.input.plan.tasks.map((task) => [task.task_id, 1]),
                objective_ref: canonicalDigest(operatorObjective(journal.spec.objective)),
                reducer_ref: 'mean-v1',
                missing_policy: 'incomplete',
              },
              records,
            },
            [entry.call.effect.input.candidate],
          )
          artifacts.push(set)
          value = {
            ref: set.ref,
            ...(set.value as Record<string, Json>),
            executions: executionRefs,
            loaded: true,
            cursor: null,
          }
        }
      } else if (entry.operationIds.length) {
        const receipt = operations[0]!.receipt!
        usage = receipt.usage
        if (receipt.result.status !== 'complete') {
          value = null
          error = { code: 'operator-provider-failed', message: 'The provider did not produce a valid result' }
        } else if (receipt.candidate)
          value = {
            candidate: candidateRef(journal, receipt.candidate.id),
            change: receipt.result.candidate_change ?? null,
          }
        else
          value =
            receipt.result.data &&
            typeof receipt.result.data === 'object' &&
            !Array.isArray(receipt.result.data) &&
            'data' in receipt.result.data
              ? receipt.result.data.data!
              : receipt.result.data
      } else if (entry.call.effect.kind === 'stream') {
        const input = entry.call.effect.input,
          progress = journal.operators!.stream!
        const completion = {
          call_id: entry.id,
          task_id: input.task_id,
          sample_id: input.sample_id,
          output: input.output,
          library_refs: input.library_refs,
          previous_revision: input.expected_revision,
          revision: canonicalDigest([input.expected_revision, entry.id, input]),
        }
        if (progress.revision !== input.expected_revision)
          fail('task-stream-conflict', 'Task progress changed before atomic completion')
        streamCompletion = completion
        value = { status: 'completed', ...completion }
      } else {
        entry.status = 'submitted'
        await save()
        const receipt = await this.effects.execute(journal, entry, signal)
        if (receipt.candidate && !journal.candidates.some((item) => item.id === receipt.candidate!.id))
          journal.candidates.push(receipt.candidate)
        value = receipt.value
        artifacts = receipt.artifacts
        error = receipt.error ?? null
      }
      if (!error) {
        // Keep large collections addressable without sending the complete collection
        // through every subsequent SearchView. ReadArtifact can page the sealed value.
        if (entry.call.effect.kind === 'execute' && bytes(value) > 900 * 1024) {
          const collection = artifacts.find((artifact) =>
            ['evidence_set', 'execution_set'].includes(artifact.ref.kind),
          )!
          const body = collection.value as { spec?: Json; records: Json[] }
          value = {
            ref: collection.ref,
            spec: body.spec && bytes(body.spec) < 300 * 1024 ? body.spec : null,
            records: [],
            total_records: body.records.length,
            loaded: false,
            cursor: null,
            read_ref: collection.ref,
          }
        }
        try {
          this.effects.validateSchema(entry.call.output_schema_ref.schema, value)
        } catch {
          error = {
            code: 'operator-output-schema',
            message: 'Result does not satisfy the frozen output schema',
          }
          value = null
        }
      }
      for (const artifact of artifacts)
        if (
          !journal.operators!.artifacts.some(
            (item) => canonicalDigest(item.ref) === canonicalDigest(artifact.ref),
          )
        )
          journal.operators!.artifacts.push(artifact)
      entry.result = {
        ref: { key: entry.call.key, request_digest: entry.requestDigest },
        status: error ? 'failed' : 'succeeded',
        value,
        error,
        artifacts: artifacts
          .filter(
            (item) =>
              entry.call.effect.kind !== 'execute' ||
              ['evidence_set', 'execution_set'].includes(item.ref.kind),
          )
          .map((item) => item.ref),
        usage,
      }
      if (bytes(entry.result) > MAX_RESULT_BYTES) {
        entry.result = {
          ref: entry.result.ref,
          status: 'failed',
          value: null,
          error: { code: 'operator-result-too-large', message: 'Result exceeds the 2 MiB call result limit' },
          artifacts: [],
          usage: null,
        }
      }
      if (entry.result.status === 'succeeded' && streamCompletion) {
        const progress = journal.operators!.stream!
        progress.completed.push(streamCompletion)
        progress.index++
        progress.revision = streamCompletion.revision
      }
      entry.status = 'complete'
      await save()
    }
  }
}
