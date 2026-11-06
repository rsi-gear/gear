import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type { ModelTrainingSpec, ModelVersion, TrainerCheckpoint, TrainingProposal } from './types.js'
import type { TrainingContentStore } from './store.js'

/** Resolve only frozen fields. Connection/profile data never enter training. */
export function proposalSpec(spec: ModelTrainingSpec, proposalIndex?: number): ModelTrainingSpec {
  if (proposalIndex === undefined) return spec
  const proposal = spec.iteration?.proposals[proposalIndex]
  requireContract(proposal, 'unknown-training-proposal', 'round references an undeclared training proposal')
  const selected = structuredClone(spec)
  if (proposal.updatesPerCandidate !== undefined) selected.trainer.updatesPerCandidate = proposal.updatesPerCandidate
  if (proposal.rolloutSampling) selected.rollout.sampling = structuredClone(proposal.rolloutSampling)
  if (proposal.trainTaskIds) {
    // Preserve declared selection order and all original provenance refs.
    selected.datasets.train.tasks = proposal.trainTaskIds.map(id => spec.datasets.train.tasks.find(task => task.id === id)!)
  }
  return selected
}

/** Equal provenance labels do not make equal inputs into a new proposal. */
export function proposalInputsDigest(spec: ModelTrainingSpec, proposalIndex: number): string {
  const selected = proposalSpec(spec, proposalIndex)
  return digestJson({ trainer: selected.trainer, rollout: selected.rollout, trainDataset: selected.datasets.train,
    offlineTraining: selected.offlineTraining ?? null, stages: selected.stages ?? null })
}

/** Slime derives its default decay horizon from one candidate's num_rollout. */
export async function validateIterationTrainingSchedule(store: TrainingContentStore, spec: ModelTrainingSpec, initial: ModelVersion): Promise<void> {
  if (!spec.iteration) return
  const hyperparameters = await store.readJson<{ schemaVersion?: number; slimeArgs?: unknown }>(spec.trainer.hyperparametersRef)
  requireContract(hyperparameters.schemaVersion === 1 && Array.isArray(hyperparameters.slimeArgs)
    && hyperparameters.slimeArgs.every(value => typeof value === 'string'), 'iteration-schedule-unsealed', 'automatic rounds require a sealed explicit Slime training schedule')
  const args = hyperparameters.slimeArgs as string[]
  const option = (flag: string): string | undefined => {
    const matches = args.flatMap((value, index) => value === flag ? [args[index + 1]] : value.startsWith(flag + '=') ? [value.slice(flag.length + 1)] : [])
    requireContract(matches.length <= 1, 'iteration-schedule-unsealed', 'training schedule flags cannot be duplicated')
    return matches[0]
  }
  const lr = Number(option('--lr'))
  requireContract(Number.isFinite(lr) && lr > 0, 'iteration-schedule-unsealed', 'automatic rounds require an explicit positive learning rate')
  const samplesPerRollout = spec.trainer.rolloutBatchSize * (spec.offlineTraining ? 1 : spec.rollout.groupSize)
  const stepsPerRollout = Number(option('--num-steps-per-rollout'))
  requireContract(Number.isSafeInteger(stepsPerRollout) && stepsPerRollout > 0 && stepsPerRollout === samplesPerRollout / spec.trainer.globalBatchSize,
    'iteration-schedule-layout-drift', 'sealed num-steps-per-rollout must equal B × G / globalBatchSize (G=1 for SFT)')
  const style = option('--lr-decay-style'), decay = option('--lr-decay-iters')
  if (style === 'constant') return
  const baseUpdate = initial.trainerCheckpointRef ? (await store.readJson<TrainerCheckpoint>(initial.trainerCheckpointRef)).committedUpdate : 0
  const updates = baseUpdate + spec.iteration.maxRounds * Math.max(spec.trainer.updatesPerCandidate,
    ...spec.iteration.proposals.map(proposal => proposal.updatesPerCandidate ?? spec.trainer.updatesPerCandidate))
  const steps = updates * stepsPerRollout
  const decayIterations = Number(decay)
  requireContract(Number.isSafeInteger(steps) && Number.isSafeInteger(decayIterations) && decayIterations >= steps,
    'iteration-schedule-too-short', `freeze --lr-decay-style constant or --lr-decay-iters >= ${steps} for the entire declared experiment; a one-round decay cannot be extended after checkpoint acceptance`)
}

export function iterationPolicy(proposals: TrainingProposal[], limits: { maxRounds: number; maxWallClockSeconds: number; maxConsecutiveRejected?: number }) {
  return { schemaVersion: 1 as const, ...limits, maxConsecutiveRejected: limits.maxConsecutiveRejected ?? 2,
    onRejected: 'next-declared-proposal-or-stop' as const, onInconclusive: 'bounded-repair-or-stop' as const,
    autoPublish: false as const, recovery: { maxRunRecoveries: 0, maxEvaluationAttempts: 1 }, proposals }
}
