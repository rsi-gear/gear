import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digestJson } from './digest.js'
import { evaluationAttemptId, modelEvidenceKey } from './evaluation.js'
import { publicEndpointBinding } from './endpoint-binding.js'
import { atomicWrite } from './store.js'
import { requireContract } from './schema.js'
import type { EndpointModelEvaluationEvidence, ModelEvaluationRequest } from './types.js'

export interface HitchAttemptJournal {
  id: string; parentId?: string; request: ModelEvaluationRequest; requestDigest: string; startedAt: number
  evidence?: EndpointModelEvaluationEvidence; repairRounds?: number; repair?: { id: string; pending: boolean; cancelled?: boolean }
  retainedTrials?: EndpointModelEvaluationEvidence['trials']
}
export interface HitchEvalJournal {
  key: string; requestDigest: string; request?: ModelEvaluationRequest; startedAt: number; evalId?: string; submitted?: boolean
  evidence?: EndpointModelEvaluationEvidence; repairRounds?: number; repair?: { id: string; pending: boolean }
  retainedTrials?: EndpointModelEvaluationEvidence['trials']; attempts?: HitchAttemptJournal[]
}
export async function readHitchEvalJournal(directory: string): Promise<HitchEvalJournal | undefined> {
  try { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as HitchEvalJournal }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export function assertHitchAttempt(journal: HitchEvalJournal, request: ModelEvaluationRequest): HitchAttemptJournal | undefined {
  requireContract(journal.key === modelEvidenceKey({ subject: request.subject, condition: request.condition }),
    'evaluation-idempotency-conflict', 'evaluation request changed its frozen subject or common conditions')
  const attempt = journal.attempts?.find(value => value.requestDigest === digestJson(request))
  requireContract(attempt || journal.requestDigest === digestJson(request), 'evaluation-idempotency-conflict', 'new binding requires an explicit frozen evaluation attempt')
  return attempt
}
/** Persist separate immutable request files before daemon repair admission. */
export async function freezeHitchAttempt(directory: string, request: ModelEvaluationRequest,
  context?: { id: string; parentId?: string }): Promise<{ journal: HitchEvalJournal; attempt: HitchAttemptJournal }> {
  const key = modelEvidenceKey({ subject: request.subject, condition: request.condition })
  const journal = await readHitchEvalJournal(directory) ?? { key, requestDigest: digestJson(request), request, startedAt: Date.now() }
  requireContract(journal.key === key, 'evaluation-idempotency-conflict', 'evaluation attempt changed its frozen subject or common conditions')
  if (!journal.request) {
    requireContract(journal.requestDigest === digestJson(request), 'evaluation-idempotency-conflict', 'original journal request must be reconciled before cross-deployment recovery')
    journal.request = structuredClone(request)
  }
  requireContract(journal.requestDigest === digestJson(journal.request), 'evaluation-journal-drift', 'the original evaluation request changed')
  journal.attempts ??= [{ id: evaluationAttemptId(journal.request.endpointBinding), request: journal.request, requestDigest: journal.requestDigest,
    startedAt: journal.startedAt, ...(journal.evidence ? { evidence: journal.evidence } : {}), ...(journal.repairRounds !== undefined ? { repairRounds: journal.repairRounds } : {}),
    ...(journal.repair ? { repair: journal.repair } : {}), ...(journal.retainedTrials ? { retainedTrials: journal.retainedTrials } : {}) }]
  const ids = new Set<string>()
  for (let index = 0; index < journal.attempts.length; index++) {
    const previous = journal.attempts[index]!
    requireContract(previous.id === evaluationAttemptId(previous.request.endpointBinding) && previous.requestDigest === digestJson(previous.request)
      && previous.parentId === journal.attempts[index - 1]?.id && !ids.has(previous.id)
      && modelEvidenceKey({ subject: previous.request.subject, condition: previous.request.condition }) === key,
    'evaluation-journal-drift', 'evaluation attempt changed its frozen request, identity or lineage')
    ids.add(previous.id)
  }
  const id = context?.id ?? evaluationAttemptId(request.endpointBinding)
  requireContract(id === evaluationAttemptId(request.endpointBinding), 'evaluation-attempt-drift', 'physical attempt identity must identify its frozen endpoint binding')
  let attempt = journal.attempts.find(value => value.id === id)
  if (attempt) {
    requireContract(attempt.requestDigest === digestJson(request) && (!context || attempt.parentId === context.parentId),
      'evaluation-idempotency-conflict', 'evaluation attempt request or parent changed')
    requireContract(journal.attempts.at(-1) === attempt, 'evaluation-attempt-stale', 'an older evaluation attempt cannot admit more tasks')
  } else {
    requireContract(context?.parentId === journal.attempts.at(-1)!.id && journal.submitted,
      'evaluation-attempt-drift', 'new evaluation attempt requires the latest admitted parent')
    const common = (value: ModelEvaluationRequest) => ({ ...value, endpointBinding: undefined })
    requireContract(digestJson(common(request)) === digestJson(common(journal.request)), 'evaluation-attempt-drift', 'repair may change the deployment binding only')
    attempt = { id, parentId: context.parentId, request: structuredClone(request), requestDigest: digestJson(request), startedAt: Date.now(),
      repair: { id: `rerun_${digestJson([key, id]).slice(7, 39)}`, pending: true }, retainedTrials: journal.evidence?.trials.filter(trial => trial.valid) ?? [] }
    journal.attempts.push(attempt)
  }
  const immutablePath = join(directory, 'attempts', id, 'request.json')
  let saved: ModelEvaluationRequest | undefined
  try { saved = JSON.parse(await readFile(immutablePath, 'utf8')) as ModelEvaluationRequest }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  requireContract(!saved || digestJson(saved) === attempt.requestDigest, 'evaluation-idempotency-conflict', 'attempt request file was already frozen for another binding')
  if (!saved) await atomicWrite(immutablePath, attempt.request)
  await atomicWrite(join(directory, 'state.json'), journal)
  return { journal, attempt }
}
export const hitchEndpointAttempt = (attempt: HitchAttemptJournal) => ({ schema_version: '1', id: attempt.id,
  parent_id: attempt.parentId, endpoint_binding: attempt.request.endpointBinding })
export function publicHitchAttempts(journal: HitchEvalJournal, trials: EndpointModelEvaluationEvidence['trials'], bindings: Map<string, string>): NonNullable<EndpointModelEvaluationEvidence['endpointAttempts']> {
  return journal.attempts!.map(attempt => ({ id: attempt.id, ...(attempt.parentId ? { parentId: attempt.parentId } : {}), evalId: journal.evalId!,
    binding: publicEndpointBinding(attempt.request.endpointBinding), trials: trials.filter(trial => bindings.get(trial.runId) === attempt.id).map(trial => trial.runId) }))
}
