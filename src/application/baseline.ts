import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Evidence } from '../domain/algorithm-wire.js'
import type { BaselineReuse } from '../domain/baseline.js'
import type { RunJournal, RunSpec } from '../domain/run.js'
import type { ProjectConfig } from '../domain/project.js'
import { canonicalDigest } from '../domain/canonical.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import { bindRawMetrics } from '../domain/objective-evidence.js'
import { aggregateUsage } from '../domain/usage.js'
import { GearError } from '../domain/errors.js'
import { RunStore } from '../adapters/storage/run-store.js'
import { TargetStore } from '../adapters/storage/targets.js'
import { harnessAdapter } from './harness-adapters.js'
import { validateBaseline } from '../domain/baseline.js'
import { validateProjectionReceipt } from '../runtime/evidence-projection.js'

const evaluationIdentity = (spec: RunSpec) => spec.evaluationIdentity ?? spec.providerIdentity
const slot = (cell: Evidence) => JSON.stringify([cell.task_id, cell.repetition])

function conditions(spec: RunSpec) {
  return {
    benchmarkDigest: spec.benchmarkDigest,
    evaluationIdentity: evaluationIdentity(spec),
    seed: spec.seed,
    objectiveIdentity: spec.objectiveIdentity ?? null,
    metricContractsDigest: canonicalDigest(spec.objective?.metrics ?? []),
    assertionContractsDigest: canonicalDigest(spec.objective?.assertions ?? []),
  }
}

function compatible(source: RunSpec, current: RunSpec): boolean {
  return canonicalDigest(conditions(source)) === canonicalDigest(conditions(current))
}

function completeObservation(cell: Evidence, spec: RunSpec): boolean {
  if (!['valid', 'task_failed'].includes(cell.status) || cell.score === null) return false
  const objective = spec.objective
  if (!objective) return true
  const metrics = [
    ...objective.definition.terms.filter((term) => term.weight !== 0).map((term) => term.metric),
    ...objective.definition.constraints.map((rule) => rule.metric),
    ...objective.protection
      .filter((rule) => rule.partition === 'seed' && rule.task_id === cell.task_id)
      .map((rule) => rule.metric),
  ]
  return (
    metrics.every((id) => cell.raw_metrics?.[id]?.status === 'available') &&
    (objective.assertion_protection ?? [])
      .filter((rule) => rule.partition === 'seed' && rule.task_id === cell.task_id)
      .every((rule) =>
        ['passed', 'failed', 'excluded'].includes(
          cell.assertions?.find((value) => value.id === rule.assertion_id)?.status ?? 'missing',
        ),
      )
  )
}

export interface BaselineProof {
  version: 1
  runId: string
  journalDigest: string
  specDigest: string
  candidateId: string
  candidateDigest: string
  conditions: ReturnType<typeof conditions>
  operations: RunJournal['operations']
  evidence: Evidence[]
}
export interface BaselineSelection {
  reuse: BaselineReuse
  proof: BaselineProof
}

/** Recheck receipt bindings without consulting a mutable source run during resume/export. */
function sourceAccounting(proof: BaselineProof) {
  const ids = new Set<string>()
  let physicalAttempts = 0
  for (const operation of proof.operations) {
    const { request, receipt } = operation
    validateAlgorithmWire('OperationReceipt', receipt)
    if (
      operation.status !== 'complete' ||
      !receipt ||
      request.runId !== proof.runId ||
      request.partition !== 'seed' ||
      request.operation.kind !== 'evaluate_seed' ||
      request.operation.candidate_id !== proof.candidateId ||
      receipt.result.operation_id !== request.operationId ||
      receipt.result.kind !== 'evaluate_seed' ||
      receipt.result.candidate_id !== proof.candidateId ||
      receipt.candidate !== null ||
      ids.has(request.operationId) ||
      !Number.isSafeInteger(request.repetitions) ||
      request.repetitions < 1 ||
      operation.reservedAttempts !== (request.projection ? 0 : request.slots.length) ||
      !Number.isSafeInteger(receipt.physicalAttempts) ||
      receipt.physicalAttempts < 0 ||
      receipt.physicalAttempts > operation.reservedAttempts ||
      receipt.evidence.length !== request.slots.length ||
      (!request.projection &&
        receipt.physicalAttempts <
          receipt.evidence.filter((cell) => cell.status !== 'environment_failed').length)
    )
      throw new Error('Invalid source receipt binding or metering')
    ids.add(request.operationId)
    const slots = new Set(request.slots.map((value) => JSON.stringify([value.taskId, value.repetition])))
    const observed = new Set<string>()
    for (const cell of receipt.evidence) {
      if (
        cell.candidate_id !== proof.candidateId ||
        cell.scope !== request.operation.scope ||
        !request.operation.task_ids.includes(cell.task_id) ||
        cell.repetition >= request.repetitions ||
        !slots.has(slot(cell)) ||
        observed.has(slot(cell)) ||
        ['valid', 'task_failed'].includes(cell.status) !== (cell.score !== null)
      )
        throw new Error('Invalid source evidence slot')
      observed.add(slot(cell))
    }
    validateProjectionReceipt(request, receipt)
    physicalAttempts += receipt.physicalAttempts
    if (!Number.isSafeInteger(physicalAttempts)) throw new Error('Historical attempts overflow')
  }
  for (const cell of proof.evidence) {
    validateAlgorithmWire('Evidence', cell)
    if (
      cell.candidate_id !== proof.candidateId ||
      !proof.operations.some((operation) =>
        operation.receipt!.evidence.some((value) => canonicalDigest(value) === canonicalDigest(cell)),
      )
    )
      throw new Error('Source observation has no bound receipt')
  }
  return { usage: aggregateUsage(proof.operations), physicalAttempts }
}

/** Only verified terminal seed receipts are considered; rank coverage/recency, never scores. */
export async function selectBaseline(
  root: string,
  config: ProjectConfig,
  spec: RunSpec,
): Promise<BaselineSelection | null> {
  const store = new RunStore(join(root, '.gear'))
  const entries = await readdir(join(store.root, 'runs'), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  const sources: RunJournal[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run_[a-f0-9]{32}$/u.test(entry.name)) continue
    // An unreadable historical run cannot certify reusable evidence; it never authorizes replay.
    try {
      const source = await store.read(entry.name)
      if (source.status === 'completed' && compatible(source.spec, spec)) sources.push(source)
    } catch {
      /* No verified source. */
    }
  }
  sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  let best: BaselineSelection | null = null
  for (const source of sources) {
    const candidate = source.candidates.find((value) => value.digest === spec.anchor.digest)
    if (!candidate) continue
    try {
      const directory = join(store.root, 'runs', source.id)
      const savedConfig = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8')) as ProjectConfig
      if (
        canonicalDigest(savedConfig) !== source.spec.configDigest ||
        savedConfig.target.adapter !== config.target.adapter
      )
        continue
      const targets = new TargetStore(
        directory,
        harnessAdapter(config.target.adapter),
        evaluationIdentity(source.spec),
      )
      if ((await targets.verify(candidate.id)).digest !== spec.anchor.digest) continue
      const operations = source.operations.filter(
        (item) =>
          item.status === 'complete' &&
          item.request.partition === 'seed' &&
          item.request.operation.kind === 'evaluate_seed' &&
          item.request.operation.candidate_id === candidate.id,
      )
      const seen = new Set<string>()
      const evidence = source.seedEvidence.filter((cell) => {
        if (
          cell.candidate_id !== candidate.id ||
          !spec.seedTasks.some((task) => task.id === cell.task_id) ||
          cell.repetition < 0 ||
          cell.repetition >= spec.budget.repetitions ||
          !completeObservation(cell, spec)
        )
          return false
        validateAlgorithmWire('Evidence', cell)
        if (seen.has(slot(cell))) throw new Error('Duplicate historical slot')
        seen.add(slot(cell))
        // Synthetic zero-cost reuse receipts contain no observations and cannot become a new source.
        return operations.some(
          (item) =>
            item.request.slots.some(
              (value) => value.taskId === cell.task_id && value.repetition === cell.repetition,
            ) && item.receipt!.evidence.some((value) => canonicalDigest(value) === canonicalDigest(cell)),
        )
      })
      if (!evidence.length || evidence.length <= (best?.reuse.evidence.length ?? 0)) continue
      const rebound = evidence.map((cell) =>
        bindRawMetrics(
          { ...structuredClone(cell), candidate_id: spec.anchor.id, scope: 'global' },
          spec,
          spec.anchor.digest,
        ),
      )
      const proof: BaselineProof = {
        version: 1,
        runId: source.id,
        journalDigest: source.digest,
        specDigest: source.specDigest,
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        conditions: conditions(source.spec),
        operations: structuredClone(operations),
        evidence: structuredClone(evidence),
      }
      const historical = sourceAccounting(proof)
      best = {
        proof,
        reuse: {
          version: 1,
          sourceRunId: source.id,
          sourceCandidateId: candidate.id,
          sourceJournalDigest: source.digest,
          sourceDigest: canonicalDigest(proof),
          evidence: rebound,
          historicalUsage: historical.usage,
          historicalPhysicalAttempts: historical.physicalAttempts,
        },
      }
    } catch {
      /* Damaged or incomplete source evidence is never reused. */
    }
  }
  return best
}

export async function verifyBaseline(
  root: string,
  runId: string,
  spec: RunSpec,
): Promise<BaselineProof | null> {
  if (!spec.baseline) return null
  try {
    validateBaseline(spec)
    const proof = JSON.parse(
      await readFile(join(root, '.gear/runs', runId, 'baseline-source.json'), 'utf8'),
    ) as BaselineProof
    if (
      proof.version !== 1 ||
      canonicalDigest(proof) !== spec.baseline.sourceDigest ||
      proof.runId !== spec.baseline.sourceRunId ||
      proof.candidateId !== spec.baseline.sourceCandidateId ||
      proof.journalDigest !== spec.baseline.sourceJournalDigest ||
      proof.candidateDigest !== spec.anchor.digest ||
      canonicalDigest(proof.conditions) !== canonicalDigest(conditions(spec)) ||
      !proof.evidence.every((cell) => completeObservation(cell, spec)) ||
      canonicalDigest(
        proof.evidence.map((cell) =>
          bindRawMetrics(
            { ...cell, candidate_id: spec.anchor.id, scope: 'global' },
            spec,
            spec.anchor.digest,
          ),
        ),
      ) !== canonicalDigest(spec.baseline.evidence)
    )
      throw new Error('Source mismatch')
    const historical = sourceAccounting(proof)
    if (
      historical.physicalAttempts !== spec.baseline.historicalPhysicalAttempts ||
      canonicalDigest(historical.usage) !== canonicalDigest(spec.baseline.historicalUsage)
    )
      throw new Error('Historical accounting mismatch')
    return proof
  } catch {
    throw new GearError(
      'baseline-source-unavailable',
      'Frozen baseline provenance is unavailable or changed; restore it before resuming',
      { run_id: runId },
    )
  }
}
