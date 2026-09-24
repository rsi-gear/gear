import { resolve } from 'node:path';
import type { EvolutionSpec, RefinementRound } from '../../types.js';
import { digestJson } from '../../state/digest.js';
import { describeDataset } from '../../search/dataset-projection.js';
import { DatasetTaskSampler } from '../../evolution/builtin-algorithms.js';

export type FreshHitchRolloutContext = { schemaVersion: 1; spec: EvolutionSpec; round: RefinementRound;
  specDigest: string; roundDigest: string; datasetDigest: string };
export type FreshHitchContextOptions = { spec: EvolutionSpec; campaignId: string; workspaceRoot: string;
  minRepetitions: number };

/** Frozen evaluation identity only. No legacy round record, candidate lease, search, or model run is created. */
export async function createFreshHitchRolloutContext(options: FreshHitchContextOptions): Promise<FreshHitchRolloutContext> {
  const { spec, campaignId, workspaceRoot, minRepetitions } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(campaignId)
    || !Number.isSafeInteger(minRepetitions) || minRepetitions < 1) throw new Error('Fresh Hitch context identity invalid');
  if (spec.rollout.repetitions < minRepetitions || spec.rollout.seeds !== undefined
    || spec.rollout.sampling.temperature !== undefined) {
    throw new Error('Fresh Hitch rollout plan cannot supply requested unseeded repetitions');
  }
  const description = await describeDataset(spec, 'seed', workspaceRoot);
  if (description.sourceDigest !== spec.datasets.seed.digest
    || description.universe.repetitions.length < minRepetitions
    || description.universe.repetitions.some(item => item.seed !== null)) {
    throw new Error('Fresh Hitch compiled seed dataset or repetition plan mismatch');
  }
  const specDigest = digestJson(spec);
  const roundId = `algorithm-${digestJson({ campaignId, specDigest }).slice(7, 31)}`;
  const plan = new DatasetTaskSampler(spec.rollout.taskSampler)
    .resolve(roundId, spec.datasets, spec.rollout, spec.taskBudgetMs);
  const round: RefinementRound = { evolutionId: spec.evolutionId, roundId,
    workspaceRoot: resolve(workspaceRoot), status: 'queued', source: 'api',
    createdAt: spec.createdAt, updatedAt: spec.createdAt,
    metaHarnessRef: spec.metaAgent.preset.id,
    targetHarnessRef: spec.initialHarness.ref, targetHarnessDigest: spec.initialHarness.digest,
    sandboxProfileRef: spec.sandboxProfileRef, seedTaskRef: spec.datasets.seed.ref,
    heldOutRef: spec.datasets.heldOut.ref, taskBudgetMs: spec.taskBudgetMs,
    promotionPolicy: structuredClone(spec.promotion.policy.config),
    batchId: roundId, roundIndex: 0, roundCount: 1,
    plan, parentAllocations: [], candidatePool: [] };
  const roundDigest = digestJson(round);
  return { schemaVersion: 1, spec: structuredClone(spec), round: structuredClone(round),
    specDigest, roundDigest, datasetDigest: description.sourceDigest };
}
