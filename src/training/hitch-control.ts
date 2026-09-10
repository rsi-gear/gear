import { join } from 'node:path'
import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import { atomicWrite } from './store.js'
import type { ModelEvaluationRequest, TrainingControlIntent } from './types.js'

export interface OrderedEvaluationControl {
  file: string
  state: { eval_id: string; submitted: boolean; pending_reruns: boolean }
}
export async function controlEvaluation(workspace: string, request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent,
  call: (args: string[]) => Promise<unknown>): Promise<OrderedEvaluationControl> {
  requireContract(intent.schemaVersion === 2 && Number.isSafeInteger(intent.sequence) && intent.sequence >= 0
    && ['start', 'pause'].includes(intent.action), 'invalid-evaluation-control', 'evaluation requires an ordered intent')
  const capabilities = await call(['capabilities', '--json']) as Record<string, unknown>
  requireContract(capabilities?.ordered_eval_control === '2', 'evaluation-control-unavailable', 'Hitch must support durable ordered evaluation control')
  const command = { schema_version: '2', key, subject_digest: digestJson(request), sequence: intent.sequence, action: intent.action }
  // Each immutable file identifies one command. A delayed CLI must never read
  // a later resume command from a shared mutable --file path.
  const file = join(workspace, 'evaluation-controls', `${digestJson(command).slice(7)}.json`)
  await atomicWrite(file, command)
  const state = await call(['eval', 'control', '--file', file]) as Record<string, unknown>
  requireContract(state?.schema_version === '2' && state.subject_digest === command.subject_digest && state.sequence === intent.sequence
    && state.action === intent.action && typeof state.eval_id === 'string' && /^eval_[a-f0-9]{32}$/.test(state.eval_id)
    && typeof state.submitted === 'boolean' && typeof state.pending_reruns === 'boolean',
  'evaluation-control-drift', 'Hitch returned another evaluation control identity')
  return { file, state: state as unknown as OrderedEvaluationControl['state'] }
}
