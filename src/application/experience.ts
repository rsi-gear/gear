import { join, resolve } from 'node:path'
import type { Json } from '../domain/algorithm-wire.js'
import type {
  ExperienceContext,
  ExperienceIndexEntry,
  ExperienceIndexSnapshot,
  ExperienceRecord,
  ExperienceView,
} from '../domain/experience.js'
import type { RunJournal } from '../domain/run.js'
import type { OperationRequest } from '../ports/operations.js'
import type { ExperiencePreparation } from '../ports/experience.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import { ExperienceStore } from '../adapters/storage/experience.js'
import { ResearchStore } from '../adapters/storage/research.js'
import type { TargetStore } from '../adapters/storage/targets.js'
import { targetDiff } from '../adapters/storage/target-diff.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../adapters/python/builtin-policy.js'
import { pythonObjective } from '../adapters/python/objective.js'
import { SeedTrajectoryArchive } from './trajectory.js'
import { verifyBaseline } from './baseline.js'
import { modificationUse, modificationUseIdentity, type ModificationUseBudget } from './modification-use.js'

/** Builds factual inputs; Python owns outcome classification, retrieval and card selection. */
export class ProjectExperience implements ExperiencePreparation {
  readonly store: ExperienceStore
  constructor(
    readonly runRoot: string,
    readonly targets: TargetStore,
  ) {
    this.store = new ExperienceStore(join(runRoot, 'experience'))
  }
  async capture(
    journal: RunJournal,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExperienceIndexSnapshot> {
    if (journal.spec.objectiveIdentity !== pythonObjective.identity)
      throw new GearError(
        'experience-implementation-mismatch',
        'Cannot reinterpret historical outcomes with changed Python code',
      )
    const { archive } = await new ResearchStore(join(this.runRoot, 'research')).load(journal)
    const seed = new Set(journal.spec.seedTasks.map((task) => task.id))
    const records: ExperienceIndexEntry[] = []
    const baseline = await verifyBaseline(resolve(this.runRoot, '../../..'), journal.id, journal.spec)
    const trajectories = new SeedTrajectoryArchive(this.runRoot, journal, baseline)
    const observationBudget: ModificationUseBudget = {}
    for (const candidate of journal.candidates) {
      if (!candidate.parent_id) continue
      const generation = journal.operations.find(
        (entry) =>
          entry.status === 'complete' &&
          entry.request.partition === 'seed' &&
          entry.request.operation.kind === 'generate_candidate' &&
          entry.receipt?.candidate?.id === candidate.id,
      )
      // An imported run anchor has no generation operation in this run.
      if (!generation && candidate.id === journal.spec.anchor.id) continue
      const taskIds = [
        ...new Set(
          journal.operations
            .filter(
              (entry) =>
                entry.request.partition === 'seed' &&
                entry.request.operation.kind === 'evaluate_seed' &&
                entry.request.operation.candidate_id === candidate.id,
            )
            .flatMap((entry) => entry.request.slots.map((slot) => slot.taskId)),
        ),
      ].sort()
      // A code edit without even a reserved seed evaluation has no outcome scope yet.
      if (!taskIds.length) continue
      const parent = journal.candidates.find((item) => item.id === candidate.parent_id)
      if (
        !generation ||
        !parent ||
        canonicalDigest(generation.receipt!.candidate) !== canonicalDigest(candidate) ||
        generation.request.operation.parent_id !== parent.id
      )
        throw new GearError(
          'experience-lineage-mismatch',
          'Experience requires the accepted actual generation parent',
        )
      if (taskIds.some((id) => !seed.has(id)))
        throw new GearError('experience-outside-seed', 'Experience scope must be admitted seed tasks')
      const evidence = journal.seedEvidence.filter(
        (cell) => taskIds.includes(cell.task_id) && [candidate.id, parent.id].includes(cell.candidate_id),
      )
      signal.throwIfAborted()
      const change = await targetDiff(this.targets, parent, candidate)
      const sourceFiles: Json[] = []
      for (const sourceCandidate of [parent, candidate]) {
        const resources = await this.targets.readResources(sourceCandidate.id)
        for (const resource of resources) {
          signal.throwIfAborted()
          const encoded = resource.bytes.toString('base64')
          const parts = Math.max(1, Math.ceil(encoded.length / 32_768))
          for (let part = 0; part < parts; part++)
            sourceFiles.push({
              candidate_id: sourceCandidate.id,
              path: resource.path,
              content_digest: resource.digest,
              encoding: 'base64',
              part,
              parts,
              content: encoded.slice(part * 32_768, (part + 1) * 32_768),
            })
        }
      }
      const references = await trajectories.references([candidate.id, parent.id], taskIds)
      const observations = await modificationUse(
        this.runRoot,
        this.targets.adapter.describe().adapterRef.id,
        candidate,
        change.files,
        references,
        journal.spec.artifactReader,
        signal,
        observationBudget,
      )
      const record = builtinPolicy<ExperienceRecord>('experience_record', {
        source: {
          run_id: journal.id,
          benchmark_digest: journal.spec.benchmarkDigest,
          evaluation_identity: journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
          objective_identity: journal.spec.objectiveIdentity,
          objective_digest: canonicalDigest(journal.spec.objective ?? null),
          generation_operation_id: generation.request.operationId,
          evidence_digest: canonicalDigest(evidence),
          modification_use_implementation: modificationUseIdentity,
        },
        candidate,
        parent,
        task_ids: taskIds,
        repetitions: journal.spec.budget.repetitions,
        objective: journal.spec.objective ?? null,
        evidence,
        operation: generation.request.operation,
        change,
        trajectory_refs: references,
        modification_trials: observations,
      })
      records.push(await this.store.persistRecord(record, sourceFiles))
    }
    const body = {
      version: 3 as const,
      run_id: journal.id,
      source_archive_digest: archive.digest,
      implementation_identity: builtinPolicyImplementationDigest,
      records,
    }
    const snapshot = { ...body, digest: canonicalDigest(body) }
    await this.store.save(snapshot)
    return snapshot
  }
  async prepare(
    journal: RunJournal,
    request: OperationRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExperienceContext> {
    const snapshot = await this.capture(journal, signal)
    const context = builtinPolicy<Omit<ExperienceContext, 'digest' | 'implementation_identity'>>(
      'experience_context',
      {
        records: snapshot.records,
        snapshot_digest: snapshot.digest,
        parent_id: request.operation.parent_id ?? request.operation.candidate_id,
        evidence: request.evidence,
        operation: request.operation,
      },
    )
    const body = { ...context, implementation_identity: snapshot.implementation_identity }
    const baselineEvidence = request.evidence.filter(
      (cell) =>
        cell.candidate_id === journal.spec.anchor.id &&
        journal.spec.seedTasks.some((task) => task.id === cell.task_id),
    )
    if (
      !baselineEvidence.length ||
      request.operation.kind !== 'diagnose_seed' ||
      request.operation.candidate_id !== journal.spec.anchor.id
    )
      return { ...body, digest: canonicalDigest(body) }
    const baselineProof = await verifyBaseline(resolve(this.runRoot, '../../..'), journal.id, journal.spec)
    const baselineReferences = await new SeedTrajectoryArchive(
      this.runRoot,
      journal,
      baselineProof,
    ).references([journal.spec.anchor.id], [...new Set(baselineEvidence.map((cell) => cell.task_id))])
    const withBaseline = {
      ...body,
      baseline: {
        candidate_id: journal.spec.anchor.id,
        candidate_digest: journal.spec.anchor.digest,
        evidence: baselineEvidence,
        trajectory_refs: baselineReferences,
      },
    }
    return { ...withBaseline, digest: canonicalDigest(withBaseline) }
  }
  async verify(request: OperationRequest): Promise<void> {
    if (!request.experience) return
    const { digest, ...body } = request.experience
    const snapshot = await this.store.read(request.experience.snapshot_digest)
    if (
      canonicalDigest(body) !== digest ||
      snapshot.run_id !== request.runId ||
      snapshot.implementation_identity !== request.experience.implementation_identity ||
      snapshot.records.length !== request.experience.available_records
    )
      throw new GearError(
        'experience-context-mismatch',
        'Meta experience context differs from its reservation',
      )
    if (request.experience.baseline) {
      const baseline = request.experience.baseline
      const candidateId = request.operation.candidate_id
      const expectedEvidence = request.evidence.filter(
        (cell) => cell.candidate_id === candidateId && request.operation.task_ids.includes(cell.task_id),
      )
      const evidenceSlots = new Set(expectedEvidence.map((cell) => `${cell.task_id}\0${cell.repetition}`))
      const referenceSlots = new Set<string>()
      if (
        request.operation.kind !== 'diagnose_seed' ||
        !candidateId ||
        baseline.candidate_id !== candidateId ||
        !/^sha256:[a-f0-9]{64}$/u.test(baseline.candidate_digest) ||
        !expectedEvidence.length ||
        canonicalDigest(baseline.evidence) !== canonicalDigest(expectedEvidence) ||
        baseline.trajectory_refs.some((reference) => {
          const slot = `${reference.task_id}\0${reference.repetition}`
          const valid =
            reference.candidate_id === baseline.candidate_id &&
            Number.isSafeInteger(reference.repetition) &&
            reference.repetition >= 0 &&
            evidenceSlots.has(slot) &&
            !referenceSlots.has(slot) &&
            /^trajectory:[a-f0-9]{64}$/u.test(reference.ref) &&
            (reference.status === 'available' || reference.status === 'unavailable') &&
            (reference.status === 'available'
              ? typeof reference.content_digest === 'string' &&
                /^sha256:[a-f0-9]{64}$/u.test(reference.content_digest)
              : reference.content_digest === null) &&
            (reference.reason === null || typeof reference.reason === 'string')
          referenceSlots.add(slot)
          return !valid
        })
      )
        throw new GearError('experience-context-mismatch', 'Baseline evidence is outside its diagnosis')
    }
  }
  async access(journal: RunJournal, params: Record<string, unknown>): Promise<Json> {
    const snapshot =
      typeof params.snapshot_digest === 'string'
        ? await this.store.read(params.snapshot_digest)
        : await this.capture(journal)
    if (
      snapshot.run_id !== journal.id ||
      snapshot.implementation_identity !== builtinPolicyImplementationDigest ||
      snapshot.records.some((record) =>
        record.scope.task_ids.some(
          (task) => !journal.spec.seedTasks.some((admitted) => admitted.id === task),
        ),
      )
    )
      throw new GearError(
        'experience-implementation-mismatch',
        'Experience query requires the frozen Python implementation',
      )
    const input: Record<string, unknown> = {
      ...params,
      records: snapshot.records,
      snapshot_digest: snapshot.digest,
    }
    if (params.ref !== undefined && snapshot.version === 3) {
      const record = snapshot.records.find((item) => 'experience:' + item.digest.slice(7) === params.ref)
      if (!record) throw new TypeError('experience ref is outside the frozen snapshot')
      const view = params.view ?? 'card'
      if (view !== 'card') input.descriptor = await this.store.descriptor(snapshot, record)
      // Python owns cursor binding and view/page decisions; storage resolves only that window.
      const plan = builtinPolicy<{ start: number; limit: number }>('experience_read_plan', input)
      if (view !== 'card')
        input.page_items = await this.store.readItems(
          snapshot,
          record,
          view as ExperienceView,
          plan.start,
          plan.limit,
        )
    }
    return builtinPolicy<Json>(params.ref === undefined ? 'experience_query' : 'experience_read', input)
  }
}
