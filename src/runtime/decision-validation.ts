import type { Decision, SearchView } from '../domain/algorithm-wire.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import { GearError } from '../domain/errors.js'

/** Author helpers never grant authority. Runtime independently checks the complete batch. */
export function validateDecision(view: SearchView, decision: Decision): void {
  validateAlgorithmWire('Decision', decision)
  const fail = (message: string): never => {
    throw new GearError('invalid-algorithm-decision', message, { run_id: view.run_id })
  }
  if (!decision.reason.trim() || !decision.operations.length)
    fail('Decision needs a reason and at least one operation')
  const candidateIds = new Set(view.candidates.map((candidate) => candidate.id)),
    generated = new Set<string>()
  const tasks = new Set(view.tasks.map((task) => task.id))
  if (Buffer.byteLength(JSON.stringify(decision.research ?? [])) > 2 * 1024 * 1024)
    fail('Research traces exceed the per-decision limit')
  for (const record of decision.research ?? []) {
    if (
      !record.scope.trim() ||
      !record.task_ids.length ||
      new Set(record.task_ids).size !== record.task_ids.length ||
      record.task_ids.some((id) => !tasks.has(id)) ||
      new Set(record.candidate_ids).size !== record.candidate_ids.length ||
      record.candidate_ids.some((id) => !candidateIds.has(id))
    )
      fail('Research traces must reference admitted seed tasks and existing candidates')
  }
  const evaluations = new Set<string>()
  let terminal = 0
  for (const operation of decision.operations) {
    if (
      new Set(operation.task_ids).size !== operation.task_ids.length ||
      operation.task_ids.some((task) => !tasks.has(task))
    )
      fail('Algorithm requested tasks outside its seed scope')
    if (operation.kind === 'evaluate_seed')
      for (const task of operation.task_ids) {
        const key = JSON.stringify([operation.candidate_id, task])
        if (evaluations.has(key)) fail('Evaluation operations overlap within one decision batch')
        evaluations.add(key)
      }
    if (operation.kind === 'generate_candidate') {
      if (
        !operation.parent_id ||
        !candidateIds.has(operation.parent_id) ||
        !operation.candidate_id ||
        !/^[a-zA-Z0-9_-]+$/u.test(operation.candidate_id) ||
        candidateIds.has(operation.candidate_id) ||
        generated.has(operation.candidate_id)
      )
        fail('Invalid candidate generation identity')
      generated.add(operation.candidate_id!)
    } else if (
      ['evaluate_seed', 'diagnose_seed', 'nominate'].includes(operation.kind) &&
      (!operation.candidate_id || !candidateIds.has(operation.candidate_id))
    )
      fail('Operation refers to an unknown candidate')
    if (['evaluate_seed', 'diagnose_seed'].includes(operation.kind) && !operation.task_ids.length)
      fail('Evaluation and diagnosis require an explicit nonempty seed scope')
    if (operation.kind === 'nominate' || operation.kind === 'stop') terminal++
  }
  if (generated.size > view.budget.candidates_remaining) fail('Decision exceeds candidate quota')
  if (terminal && (terminal !== 1 || decision.operations.length !== 1))
    fail('Nomination/stop must be an exclusive terminal decision')
}
