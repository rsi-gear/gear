import type { ExperienceContext } from '../domain/experience.js'
import type { RunJournal } from '../domain/run.js'
import type { OperationRequest } from './operations.js'

export interface ExperiencePreparation {
  prepare(journal: RunJournal, request: OperationRequest, signal?: AbortSignal): Promise<ExperienceContext>
  verify(request: OperationRequest): Promise<void>
}
