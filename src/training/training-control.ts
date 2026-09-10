import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type { ModelTrainingRun, TrainingControlIntent } from './types.js'

export function trainingControlIntent(run: ModelTrainingRun): TrainingControlIntent {
  return run.trainingControl ?? { schemaVersion: 2, sequence: 0, action: 'start' }
}
export function setTrainingControl(run: ModelTrainingRun, action: TrainingControlIntent['action'], resume = false): TrainingControlIntent {
  const previous = trainingControlIntent(run)
  const intent: TrainingControlIntent = { schemaVersion: 2, sequence: previous.sequence + (previous.action !== action || resume ? 1 : 0), action }
  requireContract(Number.isSafeInteger(intent.sequence), 'training-control-overflow', 'training control sequence is exhausted')
  if (run.request.schemaVersion === 2) run.trainingControl = intent
  return intent
}
export function sameTrainingControl(run: ModelTrainingRun, expected: ModelTrainingRun): boolean {
  return run.request.schemaVersion !== 2 || digestJson(trainingControlIntent(run)) === digestJson(trainingControlIntent(expected))
}
export function evaluationControlIntent(run: ModelTrainingRun): TrainingControlIntent {
  return run.evaluationControl ?? { schemaVersion: 2, sequence: 0, action: 'start' }
}
export function setEvaluationControl(run: ModelTrainingRun, action: TrainingControlIntent['action'], resume = false): void {
  if (run.request.schemaVersion !== 2) return
  const previous = evaluationControlIntent(run)
  const sequence = previous.sequence + (previous.action !== action || resume ? 1 : 0)
  requireContract(Number.isSafeInteger(sequence), 'evaluation-control-overflow', 'evaluation control sequence is exhausted')
  run.evaluationControl = { schemaVersion: 2, sequence, action }
}
