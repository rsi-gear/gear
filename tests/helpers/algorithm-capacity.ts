import type { AlgorithmState, SearchView, VerifierObservation } from '../../src/domain/algorithm-wire.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { validateAlgorithmWire } from '../../src/domain/algorithm-schema.js'
import { validateVerifierEvidence } from '../../src/domain/verifier-evidence.js'

const digest = canonicalDigest('synthetic-capacity-fixture-v1')
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** Synthetic public observations at the valid 16 KiB verifier bound, without production logs. */
function verifierAtLimit(): VerifierObservation {
  const value: VerifierObservation = {
    version: 1,
    status: 'available',
    reason: null,
    source_digest: digest,
    result_digest: digest,
    primary_score: 0,
    detail_status: 'complete',
    process: {
      metric: 'checks',
      score: 1,
      detail_status: 'components',
      passed: 32,
      total: 32,
      excluded: 0,
      components: Array.from({ length: 32 }, (_, index) => ({
        id: `check-${index}`,
        category: 'synthetic',
        status: 'passed',
        weight: 1,
        code: null,
        public_details: { note: 'safe synthetic detail'.repeat(8) },
        details_omitted: false,
      })),
      omitted_components: 0,
      artifact_digest: digest,
    },
    feedback: Array.from({ length: 16 }, (_, index) => ({
      code: `feedback-${index}`,
      severity: 'info',
      message: '',
      message_truncated: false,
      component_ids: [`check-${index}`],
      omitted_component_ids: 0,
    })),
    omitted_feedback: 0,
    failure_codes: [],
    omitted_failure_codes: 0,
  }
  let remaining = 16 * 1024 - jsonBytes(value)
  for (const feedback of value.feedback) {
    const size = Math.min(512, remaining)
    feedback.message = 'f'.repeat(size)
    remaining -= size
  }
  if (remaining !== 0 || jsonBytes(value) !== 16 * 1024)
    throw new Error('Synthetic verifier cannot reach the certified byte bound')
  return value
}

/** 100 tasks × unique candidates, including the baseline; 1800 is a capacity envelope only. */
export function algorithmCapacityFixture(records: 600 | 1300 | 1800): {
  view: SearchView
  state: AlgorithmState
  candidateIds: string[]
  scores: Array<[string, number]>
} {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: `task-${index}`,
    family: `family-${index % 5}`,
    estimated_cost: 1,
  }))
  const candidates = Array.from({ length: records / tasks.length }, (_, index) => ({
    id: index === 0 ? 'anchor' : `candidate-${index}`,
    digest: canonicalDigest(['synthetic', index]),
    parent_id: index === 0 ? null : 'anchor',
  }))
  const verifier = verifierAtLimit()
  const view: SearchView = {
    run_id: 'synthetic-capacity',
    step_id: 42,
    seed: 'fixed-capacity-seed',
    tasks,
    candidates,
    evidence: candidates.flatMap((candidate, candidateIndex) =>
      tasks.map((task, taskIndex) => {
        const score = taskIndex < 11 + candidateIndex * 3 ? 1 : 0
        return {
          candidate_id: candidate.id,
          task_id: task.id,
          repetition: 0,
          score,
          status: 'valid' as const,
          scope: 'global',
          feedback: 'Synthetic 完整 evidence\n',
          raw_metrics: {
            pass_rate: {
              contractDigest: digest,
              unit: 'fraction',
              status: 'available' as const,
              value: score,
              evidenceRefs: [digest],
            },
          },
          assertions: [
            {
              id: 'synthetic-check',
              schemaDigest: digest,
              status: score ? ('passed' as const) : ('failed' as const),
              evidenceRefs: [digest],
            },
          ],
          verifier: { ...verifier, primary_score: score },
        }
      }),
    ),
    completed: candidates.flatMap((candidate, index) => [
      {
        operation_id: `diagnose-${index}`,
        kind: 'diagnose_seed' as const,
        status: 'complete' as const,
        candidate_id: candidate.id,
        data: { hypotheses: ['Synthetic diagnosis\n'.repeat(100)] },
      },
      {
        operation_id: `generate-${index}`,
        kind: 'generate_candidate' as const,
        status: 'complete' as const,
        candidate_id: candidate.id,
        data: { summary: 'Synthetic proposal\n'.repeat(100) },
      },
      {
        operation_id: `evaluate-${index}`,
        kind: 'evaluate_seed' as const,
        status: 'complete' as const,
        candidate_id: candidate.id,
        data: { tasks: tasks.map((task) => task.id), summary: 'Scored 全部\n'.repeat(100) },
      },
    ]),
    budget: {
      evaluations_remaining: 1800 - records,
      candidates_remaining: 0,
      rounds: 3,
      repetitions: 1,
      generation_requests_remaining: null,
      generation_tokens_remaining: null,
      generation_batch_capacity: null,
    },
    anchor_id: 'anchor',
    objective: null,
  }
  const state: AlgorithmState = {
    version: 1,
    data: {
      phase: 'parents',
      round: 2,
      diagnostics: Array.from({ length: 32 }, (_, index) => ({
        index,
        hypothesis: 'Preserve synthetic state 测🙂\n'.repeat(80),
      })),
    },
  }
  validateAlgorithmWire('SearchView', view)
  view.evidence.forEach(validateVerifierEvidence)
  const ranked = [...candidates].reverse()
  return {
    view,
    state,
    candidateIds: ranked.map((candidate) => candidate.id),
    scores: ranked.map((candidate) => [
      candidate.id,
      (11 + candidates.indexOf(candidate) * 3) / tasks.length,
    ]),
  }
}
