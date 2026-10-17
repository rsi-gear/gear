import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { ProjectExperience } from '../../src/application/experience.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { Candidate, Evidence, Json } from '../../src/domain/algorithm-wire.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { algorithmCapacityFixture } from './algorithm-capacity.js'

/** Synthetic production journal: every child compares all 100 tasks with the same anchor. */
export async function experienceCapacityFixture(root: string, candidateCount: 8 | 12) {
  const fixture = algorithmCapacityFixture(1300)
  const runId = `capacity-${candidateCount}`
  const runRoot = join(root, '.gear', 'runs', runId)
  const store = new RunStore(join(root, '.gear'))
  const targets = new TargetStore(runRoot, new PiHarnessAdapter(), canonicalDigest('capacity-provider'))
  const candidates: Candidate[] = []
  for (const candidate of fixture.view.candidates.slice(0, candidateCount + 1)) {
    await targets.adapter.prepare(targets.path(candidate.id))
    if (candidate.parent_id) {
      // Multiple UTF-8 diff parts exercise byte-safe pagination as well as verifier pages.
      const content = Array.from(
        { length: 320 },
        (_, index) => `Preserve exact output formatting 测🙂 for ${candidate.id}, rule ${index}.\n`,
      ).join('')
      await writeFile(join(targets.path(candidate.id), 'AGENTS.md'), content)
    }
    const manifest = await targets.seal(candidate.id, 'synthetic-capacity', candidate.parent_id ?? undefined)
    candidates.push({ ...candidate, digest: manifest.digest })
  }
  const anchor = candidates[0]!
  const config = { target: { adapter: 'pi' } }
  await writeFile(join(runRoot, 'project.json'), JSON.stringify(config))
  const spec: RunSpec = {
    version: 1,
    kind: 'refine',
    benchmarkDigest: canonicalDigest('synthetic-experience-tasks'),
    configDigest: canonicalDigest(config),
    implementationIdentity: canonicalDigest('synthetic-algorithm'),
    providerIdentity: targets.runtimeIdentity,
    championRevision: null,
    targetSourceDigest: anchor.digest,
    lineage: null,
    algorithm: { name: 'gepa', options: {} },
    validationMode: 'research',
    seed: 'fixed-capacity-seed',
    seedTasks: fixture.view.tasks,
    heldOutTaskIds: ['HELD_OUT_CAPACITY_CANARY'],
    anchor,
    budget: { rounds: 3, maxEvaluations: 1300, maxCandidates: 12, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    objectiveIdentity: pythonObjective.identity,
    generationBudget: { version: 1, total: {}, perOperation: {} },
    evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    artifactReader: {
      format: 'synthetic-capacity-trajectory',
      implementation_identity: canonicalDigest('synthetic-capacity-reader'),
      configuration: { root: 'PRIVATE_PROVIDER_ROOT' },
    },
  }
  const journal = await store.create(runId, spec)
  journal.createdAt = '2026-01-01T00:00:00.000Z'
  journal.candidates = candidates
  const ids = new Set(candidates.map((candidate) => candidate.id))
  journal.seedEvidence = fixture.view.evidence.filter((cell) => ids.has(cell.candidate_id))
  const taskIds = spec.seedTasks.map((task) => task.id)
  for (const candidate of candidates) {
    if (candidate.parent_id) {
      const request: OperationRequest = {
        runId,
        operationId: canonicalDigest(['capacity-generate', candidate.id]),
        generation: 0,
        partition: 'seed',
        repetitions: 1,
        slots: [],
        evidence: [],
        operation: {
          kind: 'generate_candidate',
          candidate_id: candidate.id,
          parent_id: anchor.id,
          task_ids: taskIds,
          scope: 'global',
          rationale: `Preserve exact output formatting for ${candidate.id}.`,
          payload: {
            hypothesis: `Capacity formatting hypothesis 测🙂 for ${candidate.id}.`,
            semantic_targets: ['formatting', candidate.id],
            unrelated: 'PRIVATE_GENERATION_PAYLOAD',
          },
        },
      }
      const result = {
        operation_id: request.operationId,
        kind: request.operation.kind,
        candidate_id: candidate.id,
        status: 'complete' as const,
        data: { raw: 'PRIVATE_GENERATION_RESULT' },
      }
      journal.operations.push({
        request,
        status: 'complete',
        reservedAttempts: 0,
        receipt: {
          result,
          candidate,
          evidence: [],
          physicalAttempts: 0,
          usage: {},
          provenance: { raw: 'PRIVATE_GENERATION_PROVENANCE' },
        },
      })
      journal.completed.push(result)
    }
    const evidence = journal.seedEvidence.filter((cell) => cell.candidate_id === candidate.id)
    const request: OperationRequest = {
      runId,
      operationId: canonicalDigest(['capacity-evaluate', candidate.id]),
      generation: 0,
      partition: 'seed',
      repetitions: 1,
      slots: taskIds.map((taskId) => ({ taskId, repetition: 0 })),
      evidence: [],
      operation: {
        kind: 'evaluate_seed',
        candidate_id: candidate.id,
        parent_id: null,
        task_ids: taskIds,
        scope: 'global',
        rationale: '',
        payload: null,
      },
    }
    const result = {
      operation_id: request.operationId,
      kind: request.operation.kind,
      candidate_id: candidate.id,
      status: 'complete' as const,
      data: { raw: 'PRIVATE_EVALUATION_RESULT' },
    }
    journal.operations.push({
      request,
      status: 'complete',
      reservedAttempts: evidence.length,
      receipt: {
        result,
        candidate: null,
        evidence,
        physicalAttempts: evidence.length,
        usage: {},
        provenance: { raw: 'PRIVATE_EVALUATION_PROVENANCE' },
        artifacts: evidence.map((cell) => ({
          kind: 'trajectory',
          format: spec.artifactReader!.format,
          task_id: cell.task_id,
          repetition: cell.repetition,
          status: 'unavailable',
          content_digest: null,
          locator: { provider_root: 'PRIVATE_PROVIDER_ROOT', trial: cell.task_id },
          reason: 'synthetic-source-unavailable',
        })),
      },
    })
    journal.completed.push(result)
  }
  journal.heldOutEvidence = [
    {
      ...journal.seedEvidence[0]!,
      task_id: 'HELD_OUT_CAPACITY_CANARY',
      feedback: 'PRIVATE_HELD_OUT_EVIDENCE',
    },
  ]
  journal.physicalAttempts = journal.seedEvidence.length
  await store.write(journal)
  const last = candidates.at(-1)!
  const meta: OperationRequest = {
    runId,
    operationId: canonicalDigest(['capacity-next-meta', candidateCount]),
    generation: 1,
    partition: 'seed',
    repetitions: 1,
    slots: [],
    evidence: journal.seedEvidence.filter((cell) => cell.candidate_id === last.id),
    operation: {
      kind: 'diagnose_seed',
      candidate_id: last.id,
      parent_id: null,
      task_ids: taskIds,
      scope: 'global',
      rationale: 'Review formatting outcomes',
      payload: { semantic_targets: ['formatting'] },
    },
  }
  return {
    root,
    runRoot,
    store,
    targets,
    journal,
    meta,
    experience: new ProjectExperience(runRoot, targets),
    expectedScores: fixture.scores.filter(([id]) => ids.has(id)),
  }
}

export async function experienceFiles(root: string): Promise<Array<{ path: string; bytes: number }>> {
  const files: Array<{ path: string; bytes: number }> = []
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else files.push({ path, bytes: (await readFile(join(directory, entry.name))).byteLength })
    }
  }
  await walk(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function capacityScores(evidence: Evidence[], candidates: Candidate[]): Array<[string, number]> {
  return candidates
    .map((candidate) => {
      const cells = evidence.filter((cell) => cell.candidate_id === candidate.id)
      return [candidate.id, cells.reduce((sum, cell) => sum + cell.score!, 0) / cells.length] as [
        string,
        number,
      ]
    })
    .sort((a, b) => b[1] - a[1])
}

export function jsonObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value
}
