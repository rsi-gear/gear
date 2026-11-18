import type { Json } from '../domain/algorithm-wire.js'
import type { ArtifactRef, Call, CandidateRef, SourceRef } from '../domain/algorithm-wire-v2.js'
import type { LocalEffectReceipt, OperatorCallEntry, OperatorMaterial } from '../domain/operator-run.js'
import type { RunJournal } from '../domain/run.js'
import type { ScreeningProjection, ScreeningVerdict } from '../domain/operator-run.js'
import type { ExecutionTarget } from '../domain/operator-run.js'

/** Must use a separate restricted process, never the algorithm's mutable interpreter. */
export interface ScreeningProjector {
  screen(input: ScreeningProjection, signal: AbortSignal): Promise<ScreeningVerdict>
}

/** File/model-independent authority stays in runtime; these are bounded storage and pure projections. */
export interface OperatorEffects {
  readonly capabilities: string[]
  validateSchema(schema: Record<string, Json>, value?: Json): void
  materials(journal: RunJournal, refs: SourceRef[], signal?: AbortSignal): Promise<OperatorMaterial[]>
  prepareTarget?(
    journal: RunJournal,
    candidate: CandidateRef,
    assets: ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<ExecutionTarget>
  validateLocal(call: Call): void
  execute(journal: RunJournal, entry: OperatorCallEntry, signal: AbortSignal): Promise<LocalEffectReceipt>
}
