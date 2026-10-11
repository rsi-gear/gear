import { FileArtifactStore } from '../artifacts.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { implementationClosureDigest } from '../data/identity.js'
import { ProviderReconcileError } from '../provider-errors.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { digestJson } from '../../state/digest.js'
import { invariant, safeId, seal, sorted, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { objectiveProfile } from '../../search/objective.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'

export type GepaObjectiveReferenceInput =
  | { roundId: string; mode: 'anchor'; snapshotRef: ArtifactRef }
  | { roundId: string; mode: 'lookup'; universe: TaskUniverse; plan: StageEvaluationPlan }
  | { roundId: string; mode: 'baseline'; universe: TaskUniverse; plan: StageEvaluationPlan;
      referencePlan: StageEvaluationPlan; resultRef: ArtifactRef }

type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; stage: 'intent' | 'complete' | 'cancelled-before-start';
  completion?: CompletionEnvelope }
type Prepared = { input: GepaObjectiveReferenceInput; name: string; value: { digest: string } | null;
  result?: StageResult; referencePlan?: StageEvaluationPlan; lookup?: boolean }

/** Publishes the old evolution-wide no-regression reference without hiding its physical evaluation. */
export class GepaObjectiveReferenceProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly manifest: ProviderManifest
  constructor(root: string, readonly artifacts: FileArtifactStore, readonly journal: SearchJournal,
    records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.manifest = { kind: 'gepa.objective-reference',
      implementationDigest: implementationClosureDigest(['providers/gepa-objective-reference'], {
        recordBackend: ('identityDigest' in this.records ? this.records.identityDigest : null) ?? null }),
      inputSchema: { type: 'object', required: ['roundId', 'mode'], properties: {
        roundId: { type: 'string' }, mode: { type: 'string', enum: ['anchor', 'lookup', 'baseline'] },
        snapshotRef: { type: 'any' }, universe: { type: 'any' }, plan: { type: 'any' },
        referencePlan: { type: 'any' }, resultRef: { type: 'any' },
      }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { ref: { type: 'any' }, found: { type: 'boolean' } },
        additionalProperties: false }, meteredDimensions: [], execution: 'trusted-local',
      supportsInspect: true, supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private async currentResult(input: Extract<GepaObjectiveReferenceInput, { mode: 'baseline' }>,
    original: StageResult): Promise<StageResult> {
    const pointer = await this.journal.read<{ ref: string }>(`rounds/${input.roundId}/repair-${original.digest.slice(7)}`)
    const ref = pointer?.ref ?? original.digest
    if (ref === original.digest) return original
    const current = await this.journal.object<StageResult>(ref)
    verifyDigest(current); validateSearchSchema('StageResult', current)
    const seen = new Set<string>()
    let cursor: StageResult | undefined = current
    while (cursor?.digest !== original.digest) {
      if (!cursor || seen.has(cursor.digest) || cursor.stagePlanDigest !== input.referencePlan.digest
        || cursor.snapshotDigest !== original.snapshotDigest || !cursor.settled)
        throw new Error('GEPA objective reference repair chain drift')
      seen.add(cursor.digest)
      cursor = cursor.supersedesEvidenceDigest
        ? await this.journal.object<StageResult>(cursor.supersedesEvidenceDigest) : undefined
      if (cursor) { verifyDigest(cursor); validateSearchSchema('StageResult', cursor) }
    }
    const active = await this.journal.read<{ id: string }>(`rounds/${input.roundId}/active-repair`)
    if (active && !await this.journal.read(`rounds/${input.roundId}/repair-result-${digestJson(active.id).slice(7)}`))
      return original
    return current
  }
  private async prepare(envelope: OperationEnvelope): Promise<Prepared> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.operationId !== envelope.idempotencyKey
      || Object.keys(envelope.limits).length) throw new Error('GEPA objective reference identity drift')
    const input = envelope.input as unknown as GepaObjectiveReferenceInput
    safeId(input.roundId)
    if (input.mode === 'anchor') {
      if (Object.keys(input).sort().join(',') !== 'mode,roundId,snapshotRef'
        || input.snapshotRef?.schemaId !== 'gepa.objective-initial-snapshot.v1')
        throw new Error('GEPA objective initial snapshot input invalid')
      const snapshot = this.artifacts.getJson(input.snapshotRef) as unknown as Snapshot
      validateSnapshot(snapshot)
      return { input, name: 'objective-initial-harness', value: snapshot }
    }
    if (input.mode === 'lookup') {
      if (Object.keys(input).sort().join(',') !== 'mode,plan,roundId,universe')
        throw new Error('GEPA objective baseline lookup input invalid')
      verifyDigest(input.universe); verifyDigest(input.plan)
      if (input.plan.universeDigest !== input.universe.digest
        || input.plan.partition !== input.universe.partition
        || !input.universe.objective?.constraints.some(constraint => constraint.rule === 'no_regression'))
        throw new Error('GEPA objective baseline lookup plan drift')
      const name = `objective-initial-${digestJson([input.universe.digest, sorted(input.plan.taskIds)]).slice(7)}`
      const pointer = await this.journal.read<{ ref: string }>('evolution/objective-initial-harness')
      if (!pointer) throw new Error('GEPA objective initial harness is not frozen')
      const initial = await this.journal.object<Snapshot>(pointer.ref)
      validateSnapshot(initial)
      const frozen = await this.journal.read<{ ref: string }>(`evolution/${name}`)
      const value = frozen ? await this.journal.object<{ digest: string; initialSnapshotDigest: string }>(frozen.ref) : null
      if (value && value.initialSnapshotDigest !== initial.digest)
        throw new Error('GEPA objective baseline lookup changed its initial harness')
      if (value) verifyDigest(value)
      return { input, name, value, lookup: true }
    }
    if (input.mode !== 'baseline' || Object.keys(input).sort().join(',') !== 'mode,plan,referencePlan,resultRef,roundId,universe'
      || input.resultRef?.schemaId !== 'gepa.stage-result.v1')
      throw new Error('GEPA objective baseline input invalid')
    const { universe, plan, referencePlan } = input
    verifyDigest(universe); verifyDigest(plan); verifyDigest(referencePlan)
    if (plan.universeDigest !== universe.digest || plan.partition !== universe.partition
      || !universe.objective?.constraints.some(constraint => constraint.rule === 'no_regression'))
      throw new Error('GEPA objective reference plan does not require an initial baseline')
    const pointer = await this.journal.read<{ ref: string }>('evolution/objective-initial-harness')
    if (!pointer) throw new Error('GEPA objective initial harness is not frozen')
    const initial = await this.journal.object<Snapshot>(pointer.ref)
    validateSnapshot(initial)
    const { digest: ignored, ...body } = plan
    const expectedPlan = seal({ ...body, participantIds: [initial.candidateId],
      prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('objective-initial-reference-v1') })
    if (expectedPlan.digest !== referencePlan.digest)
      throw new Error('GEPA objective reference plan drift')
    const original = this.artifacts.getJson(input.resultRef) as unknown as StageResult
    verifyDigest(original); validateSearchSchema('StageResult', original)
    if (original.stagePlanDigest !== referencePlan.digest || original.snapshotDigest !== initial.digest || !original.settled)
      throw new Error('GEPA objective reference evidence drift')
    const name = `objective-initial-${digestJson([universe.digest, sorted(plan.taskIds)]).slice(7)}`
    const frozen = await this.journal.read<{ ref: string }>(`evolution/${name}`)
    if (frozen) {
      const saved = await this.journal.object<{ digest: string; initialSnapshotDigest: string }>(frozen.ref)
      verifyDigest(saved)
      if (saved.initialSnapshotDigest !== initial.digest)
        throw new Error('GEPA objective initial baseline changed its harness')
      return { input, name, value: saved, result: original, referencePlan }
    }
    const result = await this.currentResult(input, original)
    const projected = objectiveProfile(universe, plan.taskIds, result.cells)
    const value = !result.failure && projected.objectiveComplete && projected.objectiveScore?.scopeDigest
      && projected.rawMetrics ? seal({ scopeDigest: projected.objectiveScore.scopeDigest,
        metrics: projected.rawMetrics, initialSnapshotDigest: initial.digest, resultDigest: result.digest }) : null
    return { input, name, value, result, referencePlan }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { await this.prepare(envelope) }
  private async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const record = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (record && (record.schemaVersion !== 1 || record.operationId !== envelope.operationId
      || record.inputDigest !== envelope.inputDigest || record.implementationDigest !== envelope.implementationDigest
      || record.bindingDigest !== envelope.bindingSetRef.digest
      || !['intent', 'complete', 'cancelled-before-start'].includes(record.stage)))
      throw new Error('GEPA objective reference record drift')
    return record ?? null
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage']): Promise<RecordValue> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, stage }
    const { record } = await this.records.create(this.manifest.kind, envelope.operationId, value)
    return record
  }
  private async published(prepared: Prepared): Promise<boolean> {
    if (prepared.lookup) return true
    const pointer = await this.journal.read<{ ref: string }>(`evolution/${prepared.name}`)
    if (!pointer) return false
    if (!prepared.value || pointer.ref !== prepared.value.digest)
      throw new Error('GEPA objective reference pointer drift')
    const saved = await this.journal.object<{ digest: string }>(pointer.ref)
    if (canonicalJson(saved as unknown as JsonValue) !== canonicalJson(prepared.value as unknown as JsonValue))
      throw new Error('GEPA objective reference object drift')
    return true
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const prepared = await this.prepare(envelope), record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.stage === 'complete') {
      if (!await this.published(prepared)) throw new Error('Completed GEPA objective reference is missing')
      return { status: 'completed', completion: record.completion! }
    }
    return prepared.value ? { status: 'replay-safe' } : { status: 'running' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const prepared = await this.prepare(envelope)
    let record: RecordValue
    try { record = await this.create(envelope, 'intent') }
    catch (error) { throw new ProviderReconcileError('GEPA objective reference intent persistence failed', { cause: error }) }
    if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA objective reference cannot publish')
    try {
      if (record.stage === 'complete') return { status: 'completed', completion: record.completion! }
      if (prepared.lookup) {
        const ref = prepared.value ? this.artifacts.putJson(prepared.value as unknown as JsonValue,
          'gepa.objective-baseline.v1') : null
        await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
        const completion: CompletionEnvelope = { operationId: envelope.operationId,
          idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
          implementationDigest: envelope.implementationDigest,
          outcome: { kind: 'result', value: ref ? { found: true, ref } as unknown as JsonValue
            : { found: false } } }
        await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
        return { status: 'completed', completion }
      }
      if (!prepared.value) {
        invariant(prepared.referencePlan && prepared.result, 'GEPA objective reference evidence is missing')
        await this.journal.write(`rounds/${prepared.input.roundId}/pending-evidence`, {
          planDigest: prepared.referencePlan.digest, resultRefs: [prepared.result.digest] })
        return { status: 'running' }
      }
      const frozen = await this.journal.freezeEvolution(prepared.name, () => prepared.value!)
      if (canonicalJson(frozen as unknown as JsonValue) !== canonicalJson(prepared.value as unknown as JsonValue))
        throw new Error('GEPA objective reference frozen value drift')
      const ref = this.artifacts.putJson(prepared.value as unknown as JsonValue,
        prepared.input.mode === 'anchor' ? 'gepa.objective-initial-snapshot.v1' : 'gepa.objective-baseline.v1')
      await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
      const completion: CompletionEnvelope = { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: { ref } as unknown as JsonValue } }
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return { status: 'completed', completion }
    } catch (error) { throw new ProviderReconcileError('GEPA objective reference publication failed', { cause: error }) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.prepare(envelope)
    const record = await this.create(envelope, 'cancelled-before-start')
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    return this.inspect(envelope)
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const result = await this.inspect(envelope)
    if (result.status !== 'completed') throw new Error('GEPA objective reference has not completed')
    return result.completion
  }
}
