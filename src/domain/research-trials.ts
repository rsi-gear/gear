import type { Operation, ResearchTrial } from './algorithm-wire.js'
import type { RunJournal, ResearchDataPolicy } from './run.js'
import type { CompiledBenchmark } from './project.js'
import type { OperationRequest, OperationReceipt } from '../ports/operations.js'
import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'

export interface TrialInstance {
  id: string
  task_id: string
  question?: string
}
export interface TrialPlan {
  group: string
  repetitions: number
  instances: TrialInstance[]
}
const invalid = (): never => {
  throw new GearError('invalid-research-trials', 'Invalid research trial group or task instances')
}
export function trialPlan(operation: Operation): TrialPlan | null {
  const payload = operation.payload
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, 'gear_trials_v1')
  )
    return null
  const value = payload.gear_trials_v1 as unknown as TrialPlan
  if (
    operation.kind !== 'evaluate_seed' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['group', 'repetitions', 'instances'].includes(key)) ||
    typeof value.group !== 'string' ||
    !value.group.trim() ||
    value.group.length > 256 ||
    !Number.isSafeInteger(value.repetitions) ||
    value.repetitions < 1 ||
    value.repetitions > 128 ||
    !Array.isArray(value.instances) ||
    !value.instances.length ||
    value.instances.length * value.repetitions > 16384
  )
    invalid()
  const ids = new Set<string>()
  for (const instance of value.instances) {
    if (
      !instance ||
      typeof instance !== 'object' ||
      Array.isArray(instance) ||
      Object.keys(instance).some((key) => !['id', 'task_id', 'question'].includes(key)) ||
      typeof instance.id !== 'string' ||
      !instance.id ||
      instance.id.length > 256 ||
      ids.has(instance.id) ||
      typeof instance.task_id !== 'string' ||
      !operation.task_ids.includes(instance.task_id) ||
      (instance.question !== undefined &&
        (typeof instance.question !== 'string' ||
          !instance.question.trim() ||
          instance.question.length > 65536))
    )
      invalid()
    ids.add(instance.id)
  }
  if (operation.task_ids.some((id) => !value.instances.some((instance) => instance.task_id === id))) invalid()
  return value
}
export function trialSlots(plan: TrialPlan) {
  const counts = new Map<string, number>()
  return plan.instances.flatMap((instance) => {
    const ordinal = counts.get(instance.task_id) ?? 0
    counts.set(instance.task_id, ordinal + 1)
    return Array.from({ length: plan.repetitions }, (_, sample) => ({
      taskId: instance.task_id,
      repetition: ordinal * plan.repetitions + sample,
      instance,
      sample,
    }))
  })
}
export function trialInstructionGroups(request: OperationRequest): Map<number, Record<string, string>> {
  const groups = new Map<number, Record<string, string>>()
  if (!request.trials) return groups
  for (const slot of trialSlots(request.trials)) {
    if (slot.instance.question === undefined) continue
    const inputs = groups.get(slot.repetition) ?? (Object.create(null) as Record<string, string>)
    inputs[slot.taskId] = slot.instance.question
    groups.set(slot.repetition, inputs)
  }
  return groups
}
export function trialIdentity(
  run: string,
  candidate: string,
  group: string,
  instance: string,
  sample: number,
): string {
  return canonicalDigest([run, candidate, group, instance, sample])
}
export function admitTrials(journal: RunJournal, operation: Operation, plan: TrialPlan): void {
  const policy = journal.spec.researchData
  if (!policy)
    throw new GearError(
      'research-data-required',
      'Declare research_data at run admission before running independent trials',
    )
  const allowed = new Set([...policy.train, ...policy.dev])
  if (plan.instances.some((instance) => !allowed.has(instance.task_id)))
    throw new GearError('research-task-forbidden', 'Research trials must use the admitted train/dev tasks')
  if (!policy.allowDerivedInputs && plan.instances.some((instance) => instance.question !== undefined))
    throw new GearError(
      'derived-input-forbidden',
      'Derived question inputs are disabled by the frozen data policy',
    )
  const digest = canonicalDigest(plan)
  if (
    journal.operations.some(
      (entry) =>
        entry.request.trials &&
        entry.request.operation.candidate_id === operation.candidate_id &&
        entry.request.trials.group === plan.group &&
        canonicalDigest(entry.request.trials) !== digest,
    )
  )
    throw new GearError(
      'research-group-conflict',
      'A trial group cannot change its task instances or repetitions',
    )
}
export function collectTrials(
  journal: RunJournal,
  request: OperationRequest,
  receipt: OperationReceipt,
): ResearchTrial[] {
  const plan = request.trials!
  const slots = new Map(
    trialSlots(plan).map((slot) => [JSON.stringify([slot.taskId, slot.repetition]), slot]),
  )
  const detailsBySlot = new Map(
    (receipt.trial_details ?? []).map((value) => [JSON.stringify([value.task_id, value.repetition]), value]),
  )
  const tasks = new Map(journal.spec.researchData!.tasks.map((task) => [task.id, task]))
  const artifactsBySlot = new Map<string, typeof receipt.artifacts>()
  for (const artifact of receipt.artifacts ?? []) {
    const key = JSON.stringify([artifact.task_id, artifact.repetition])
    artifactsBySlot.set(key, [...(artifactsBySlot.get(key) ?? []), artifact])
  }
  return receipt.evidence.map((cell) => {
    const slot = slots.get(JSON.stringify([cell.task_id, cell.repetition]))!
    const details = detailsBySlot.get(JSON.stringify([cell.task_id, cell.repetition]))
    const original = tasks.get(cell.task_id)!
    return {
      id: trialIdentity(journal.id, cell.candidate_id, plan.group, slot.instance.id, slot.sample),
      operation_id: request.operationId,
      group: plan.group,
      instance_id: slot.instance.id,
      task_id: cell.task_id,
      repetition: slot.sample,
      candidate_id: cell.candidate_id,
      input_digest: canonicalDigest([original.digest, slot.instance.question ?? original.instruction]),
      evidence: cell,
      output: details?.output ?? null,
      usage: details?.usage ?? null,
      execution_status: details?.execution_status ?? null,
      artifacts:
        artifactsBySlot.get(JSON.stringify([cell.task_id, cell.repetition]))?.map((artifact) => ({
          ...artifact,
          locator: {
            trial_id: trialIdentity(journal.id, cell.candidate_id, plan.group, slot.instance.id, slot.sample),
          },
        })) ?? [],
    }
  })
}

export function researchDataPolicy(
  raw: unknown,
  benchmark: CompiledBenchmark,
): ResearchDataPolicy | undefined {
  const value = raw as
    | {
        train?: unknown
        dev?: unknown
        allow_derived_inputs?: unknown
        include_train_labels?: unknown
        report_only?: unknown
      }
    | undefined
  if (value === undefined) return undefined
  const allowed = new Set(benchmark.splits.seed)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['train', 'dev', 'allow_derived_inputs', 'include_train_labels', 'report_only'].includes(key),
    ) ||
    !Array.isArray(value.train) ||
    !Array.isArray(value.dev) ||
    [...value.train, ...value.dev].some((id) => typeof id !== 'string' || !allowed.has(id)) ||
    new Set([...value.train, ...value.dev]).size !== value.train.length + value.dev.length ||
    (value.allow_derived_inputs !== undefined && typeof value.allow_derived_inputs !== 'boolean') ||
    (value.include_train_labels !== undefined && typeof value.include_train_labels !== 'boolean') ||
    (value.report_only !== undefined && typeof value.report_only !== 'boolean')
  )
    throw new GearError(
      'invalid-research-data',
      'research_data requires disjoint train/dev subsets of admitted seed tasks',
    )
  const train = value.train as string[],
    dev = value.dev as string[]
  return {
    train,
    dev,
    reportOnly: value.report_only === true,
    allowDerivedInputs: value.allow_derived_inputs === true,
    tasks: benchmark.tasks
      .filter((task) => train.includes(task.id) || dev.includes(task.id))
      .map((task) => ({
        id: task.id,
        instruction: task.instruction,
        digest: task.digest,
        family: task.family,
        ...(train.includes(task.id) && value.include_train_labels
          ? { expected: benchmark.verifiers[task.id]!.expected }
          : {}),
      })),
  }
}
