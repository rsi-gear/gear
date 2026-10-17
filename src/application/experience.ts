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

const object = (value: Json): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const boundedText = (value: Json | undefined): string =>
  typeof value === 'string' ? value.slice(0, 8192) : ''

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
      const payload = object(generation.request.operation.payload)
      const proposal = {
        rationale: boundedText(generation.request.operation.rationale),
        hypothesis: boundedText(payload.hypothesis),
        semantic_targets: Array.isArray(payload.semantic_targets)
          ? payload.semantic_targets
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 50)
              .map((item) => item.slice(0, 4096))
          : [],
      }
      signal.throwIfAborted()
      const change = await targetDiff(this.targets, parent, candidate)
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
        proposal,
        change,
        trajectory_refs: references,
        modification_trials: observations,
      })
      records.push(await this.store.persistRecord(record))
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
    const focus = object(request.operation.payload).semantic_targets
    const context = builtinPolicy<Omit<ExperienceContext, 'digest' | 'implementation_identity'>>(
      'experience_context',
      {
        records: snapshot.records,
        snapshot_digest: snapshot.digest,
        parent_id: request.operation.parent_id ?? request.operation.candidate_id,
        evidence: request.evidence,
        semantic_targets: Array.isArray(focus)
          ? focus.filter((item): item is string => typeof item === 'string')
          : [],
      },
    )
    const body = { ...context, implementation_identity: snapshot.implementation_identity }
    return { ...body, digest: canonicalDigest(body) }
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
