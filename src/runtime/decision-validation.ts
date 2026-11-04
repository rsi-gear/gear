import { isArtifactOperation, validateArtifactReferences } from '../domain/artifacts.js'
import { trialPlan } from '../domain/research-trials.js'
import { isWorkspace, workspaceCommand, workspaceResult } from '../domain/workspaces.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { Decision, SearchView } from '../domain/algorithm-wire.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import { GearError } from '../domain/errors.js'
import { candidateReferences } from '../domain/candidate-references.js'

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
  const workspaceOutputs = new Set<string>(),
    workspaceRoots = new Set<string>()
  for (const operation of decision.operations) {
    if (isArtifactOperation(operation.kind)) validateArtifactReferences(view, operation)
    const research = trialPlan(operation)
    for (const reference of Object.values(candidateReferences(operation))) {
      const candidate = view.candidates.find((item) => item.id === reference.candidate_id)
      if (!candidate || candidate.digest !== reference.digest)
        fail('Candidate references must identify existing candidates with their frozen digest')
    }
    if (
      new Set(operation.task_ids).size !== operation.task_ids.length ||
      operation.task_ids.some((task) => !tasks.has(task))
    )
      fail('Algorithm requested tasks outside its seed scope')
    if (operation.kind === 'evaluate_seed' && !research)
      for (const task of operation.task_ids) {
        const key = JSON.stringify([operation.candidate_id, task])
        if (evaluations.has(key)) fail('Evaluation operations overlap within one decision batch')
        evaluations.add(key)
      }
    if (isWorkspace(operation.kind)) {
      const command = workspaceCommand(operation)
      if (command.output_id) {
        if (workspaceOutputs.has(command.output_id))
          fail('Workspace output revisions overlap within a decision')
        workspaceOutputs.add(command.output_id)
      }
      if (command.source) {
        if (workspaceRoots.has(command.source.root_id)) fail('Workspace mutations overlap within a decision')
        workspaceRoots.add(command.source.root_id)
      }
      const parent = view.candidates.find((item) => item.id === operation.parent_id)
      if (!parent || (operation.kind === 'workspace_open' && parent.digest !== command.base_digest))
        fail('Workspace base must identify an existing frozen candidate')
      if (command.source) {
        const source = command.source
        if (
          source.base_candidate_id !== parent!.id ||
          source.base_digest !== parent!.digest ||
          !view.completed.some(
            (result) =>
              ['workspace_open', 'workspace_edit', 'workspace_apply'].includes(result.kind) &&
              canonicalDigest(workspaceResult(result)) === canonicalDigest(source),
          )
        )
          fail('Workspace source must be a completed revision in this run')
        if (
          view.completed.some(
            (result) =>
              ['workspace_seal', 'workspace_discard'].includes(result.kind) &&
              workspaceResult(result)?.root_id === source.root_id,
          )
        )
          fail('Workspace was already sealed or discarded')
      }
      if (
        command.output_id &&
        view.completed.some((result) => workspaceResult(result)?.id === command.output_id)
      )
        fail('Workspace output revision already exists')
      if (operation.kind !== 'workspace_seal' && operation.candidate_id !== null)
        fail('Only sealing a workspace can register a candidate')
    }
    if (['generate_candidate', 'workspace_seal'].includes(operation.kind)) {
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
    const payload = operation.payload
    const result =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.gear_result_v1 : undefined
    if (result !== undefined) {
      if (
        !['nominate', 'stop'].includes(operation.kind) ||
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).some((key) => !['selected', 'candidates', 'data'].includes(key)) ||
        (result.selected !== null &&
          (typeof result.selected !== 'string' || !candidateIds.has(result.selected))) ||
        !Array.isArray(result.candidates) ||
        result.candidates.some((id) => typeof id !== 'string' || !candidateIds.has(id))
      )
        fail('Algorithm result must reference admitted candidates in a terminal decision')
    }
    if (operation.kind === 'nominate' || operation.kind === 'stop') terminal++
  }
  if (generated.size > view.budget.candidates_remaining) fail('Decision exceeds candidate quota')
  if (terminal && (terminal !== 1 || decision.operations.length !== 1))
    fail('Nomination/stop must be an exclusive terminal decision')
}
