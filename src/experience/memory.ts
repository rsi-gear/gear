import { digestJson } from '../state/digest.js'
import type { RefineStateStore } from '../state/store.js'
import {
  enrichSeedExperienceUse,
  experienceCandidateRunIds,
  isReusableSeedExperienceUse,
  resolveExperienceChangedArtifacts,
  seedExperienceUseBaseDigest,
  type ExperienceArtifactReader,
  type ExperienceChangedArtifactInput,
  type ExperienceUsageReadResult,
  type ExperienceUsageReader,
} from './usage.js'
import type {
  CandidateDiffFile,
  CandidateRecord,
  EvaluationEvidence,
  RefinementRound,
  SeedExperienceCard,
  SeedExperienceContext,
  SeedExperienceEffect,
  SeedExperienceExcludedTaskResult,
  SeedExperiencePairedTaskResult,
  SeedExperienceRecord,
  SeedExperienceSnapshot,
  SemanticTarget,
  EvolutionSpec,
} from '../types.js'

export const EXPERIENCE_V1_MAX_SNAPSHOT_RECORDS = 4_096
export const EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES = 12 * 1024
export const EXPERIENCE_V1_MAX_CARD_BYTES = 2_048
export const EXPERIENCE_V1_MAX_QUERY_RESULTS = 10
export const EXPERIENCE_V1_MAX_QUERY_BYTES = 64 * 1024
export const EXPERIENCE_V1_MAX_READ_ITEMS = 50
export const EXPERIENCE_V1_MAX_READ_BYTES = 64 * 1024

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const EXPERIENCE_REF = /^experience_([0-9a-f]{64})$/u
const EFFECT_EPSILON = 1e-12

interface TrialCell {
  valid: boolean
  taskName: string
  trialName?: string
  runId?: string
  attempt?: number
  status: 'completed' | 'errored'
}

export interface SeedExperienceQuery {
  query?: string
  taskNames?: string[]
  semanticTargets?: SemanticTarget[]
  paths?: string[]
  effects?: SeedExperienceEffect[]
}

export interface RankedSeedExperience {
  record: SeedExperienceRecord
  score: number
  matchReasons: string[]
}

export interface PrepareSeedExperienceSnapshotOptions {
  artifactReader: ExperienceArtifactReader
  usageReader?: ExperienceUsageReader
  signal?: AbortSignal
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  const prefix = Buffer.from(value).subarray(0, budget).toString('utf8').replace(/\uFFFD+$/u, '')
  return `${prefix}${suffix}`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function trialKey(value: { taskName: string; attempt?: number }): string {
  return JSON.stringify([value.taskName, value.attempt ?? null])
}

function trialCells(evidence: EvaluationEvidence): Map<string, TrialCell> {
  const cells = new Map<string, TrialCell>()
  for (const trial of evidence.trials) cells.set(trialKey(trial), {
    valid: true,
    taskName: trial.taskName,
    ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
    ...(trial.runId === undefined ? {} : { runId: trial.runId }),
    ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
    status: trial.status,
  })
  for (const trial of evidence.invalidTrials) cells.set(trialKey(trial), {
    valid: false,
    taskName: trial.taskName,
    trialName: trial.trialName,
    runId: trial.runId,
    attempt: trial.attempt,
    status: trial.status,
  })
  return cells
}

function projectedDiffFile(file: CandidateDiffFile): CandidateDiffFile {
  return {
    path: file.path,
    change: file.change,
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
    ...(file.bytesBefore === undefined ? {} : { bytesBefore: file.bytesBefore }),
    ...(file.bytesAfter === undefined ? {} : { bytesAfter: file.bytesAfter }),
  }
}

function excludedSide(cell: TrialCell | undefined): SeedExperienceExcludedTaskResult['baseline'] {
  if (cell === undefined) return { status: 'missing' }
  return {
    ...(cell.trialName === undefined ? {} : { trialName: cell.trialName }),
    ...(cell.runId === undefined ? {} : { runId: cell.runId }),
    ...(cell.attempt === undefined ? {} : { attempt: cell.attempt }),
    status: cell.status,
  }
}

function recordId(source: Pick<SeedExperienceRecord['source'], 'evolutionId' | 'roundId' | 'candidateId'>): string {
  return `seed_experience_${digestJson({
    evolutionId: source.evolutionId,
    roundId: source.roundId,
    candidateId: source.candidateId,
  }).slice('sha256:'.length)}`
}

function projectionOf(record: Omit<SeedExperienceRecord, 'recordDigest'>): Record<string, unknown> {
  return {
    source: record.source,
    applicability: record.applicability,
    proposal: record.proposal,
    change: record.change,
    observation: record.observation,
  }
}

/** Extracts only paired seed facts for the candidate and its own allocated parent. */
export function extractSeedExperienceRecord(
  spec: Readonly<EvolutionSpec>,
  round: Readonly<RefinementRound>,
  candidate: Readonly<CandidateRecord>,
): SeedExperienceRecord | undefined {
  const proposal = candidate.proposal
  const change = candidate.diff
  const sealed = candidate.sealedVersion
  const seed = candidate.seedEvaluation
  const comparison = candidate.seedComparison
  if (proposal === undefined || change === undefined || sealed === undefined || seed === undefined || comparison === undefined) {
    return undefined
  }
  const parentCandidateId = candidate.parentCandidateIds[0]
  const parent = round.parentBaselines?.find(item => item.parentCandidateId === parentCandidateId
    && item.evidence.evalId === comparison.parentBaselineEvalId)
  if (parentCandidateId === undefined || parent === undefined) {
    throw new Error(`candidate ${candidate.candidateId} has no matching paired seed parent`)
  }
  const baseline = parent.evidence
  if (round.evolutionId !== spec.evolutionId
    || comparison.parentBaselineEvalId !== baseline.evalId
    || baseline.actualCommit !== candidate.parentHarnessRef
    || seed.actualCommit !== sealed.commitOid
    || baseline.conditionId !== round.plan.seed.conditionId
    || seed.conditionId !== round.plan.seed.conditionId) {
    throw new Error(`candidate ${candidate.candidateId} seed experience identity is inconsistent`)
  }

  const baselineCells = trialCells(baseline)
  const candidateCells = trialCells(seed)
  const pairedKeys = new Set(comparison.pairedTrials.map(pair => pair.trialKey))
  const taskResults: SeedExperiencePairedTaskResult[] = comparison.pairedTrials.map(pair => {
    const before = baselineCells.get(pair.trialKey)
    const after = candidateCells.get(pair.trialKey)
    if (before?.valid !== true || after?.valid !== true) {
      throw new Error(`candidate ${candidate.candidateId} paired seed cell is unavailable: ${pair.trialKey}`)
    }
    return {
      valid: true as const,
      trialKey: pair.trialKey,
      taskName: pair.taskName,
      ...(pair.attempt === undefined ? {} : { attempt: pair.attempt }),
      baseline: {
        ...(pair.baselineTrialName === undefined ? {} : { trialName: pair.baselineTrialName }),
        ...(pair.baselineRunId === undefined ? {} : { runId: pair.baselineRunId }),
        ...(pair.attempt === undefined ? {} : { attempt: pair.attempt }),
        status: before.status,
        reward: pair.baselineReward,
      },
      candidate: {
        ...(pair.candidateTrialName === undefined ? {} : { trialName: pair.candidateTrialName }),
        ...(pair.candidateRunId === undefined ? {} : { runId: pair.candidateRunId }),
        ...(pair.attempt === undefined ? {} : { attempt: pair.attempt }),
        status: after.status,
        reward: pair.candidateReward,
      },
      rewardDelta: pair.candidateReward - pair.baselineReward,
    }
  }).sort((left, right) => left.trialKey.localeCompare(right.trialKey))

  const excludedTaskResults: SeedExperienceExcludedTaskResult[] = uniqueSorted([
    ...baselineCells.keys(), ...candidateCells.keys(),
  ]).filter(key => !pairedKeys.has(key)).map(key => {
    const before = baselineCells.get(key)
    const after = candidateCells.get(key)
    const identity = before ?? after
    if (identity === undefined) throw new Error(`seed trial identity disappeared: ${key}`)
    const reasons: SeedExperienceExcludedTaskResult['reasons'] = []
    if (before === undefined) reasons.push('baseline-missing')
    else if (!before.valid) reasons.push('baseline-invalid')
    if (after === undefined) reasons.push('candidate-missing')
    else if (!after.valid) reasons.push('candidate-invalid')
    if (reasons.length === 0) throw new Error(`unpaired valid seed cell has no exclusion reason: ${key}`)
    return {
      valid: false,
      trialKey: key,
      taskName: identity.taskName,
      ...(identity.attempt === undefined ? {} : { attempt: identity.attempt }),
      baseline: excludedSide(before),
      candidate: excludedSide(after),
      reasons,
    }
  })

  if (taskResults.length !== comparison.pairing.paired
    || excludedTaskResults.length !== comparison.pairing.excluded) {
    throw new Error(`candidate ${candidate.candidateId} seed coverage does not match its pairing audit`)
  }
  const gains = taskResults.filter(item => item.rewardDelta > EFFECT_EPSILON)
  const losses = taskResults.filter(item => item.rewardDelta < -EFFECT_EPSILON)
  const unchanged = taskResults.filter(item => Math.abs(item.rewardDelta) <= EFFECT_EPSILON)
  const effect: SeedExperienceEffect = taskResults.length === 0
    ? 'insufficient'
    : gains.length > 0 && losses.length > 0
      ? 'mixed'
      : gains.length > 0
        ? 'improved'
        : losses.length > 0
          ? 'regressed'
          : 'unchanged'
  const mean = (side: 'baseline' | 'candidate'): number => taskResults.reduce(
    (sum, item) => sum + item[side].reward, 0,
  ) / taskResults.length
  const source: SeedExperienceRecord['source'] = {
    evolutionId: round.evolutionId,
    roundId: round.roundId,
    candidateId: candidate.candidateId,
    parentCandidateId,
    parentHarnessRef: candidate.parentHarnessRef,
    candidateHarnessRef: sealed.commitOid,
    parentBaselineEvalId: baseline.evalId,
    candidateEvalId: seed.evalId,
    parentRevisionIdentity: baseline.revisionIdentity,
    candidateRevisionIdentity: seed.revisionIdentity,
    seedConditionId: round.plan.seed.conditionId,
  }
  const observation: SeedExperienceRecord['observation'] = {
    comparison: 'candidate-vs-its-parent-seed',
    planned: comparison.pairing.planned,
    valid: comparison.pairing.paired,
    excluded: comparison.pairing.excluded,
    baselineInvalid: comparison.pairing.baselineInvalid,
    candidateInvalid: comparison.pairing.candidateInvalid,
    taskResults,
    excludedTaskResults,
    ...(taskResults.length === 0 ? {} : {
      baselineMean: mean('baseline'),
      candidateMean: mean('candidate'),
      meanRewardDelta: taskResults.reduce((sum, item) => sum + item.rewardDelta, 0) / taskResults.length,
    }),
  }
  const base: Omit<SeedExperienceRecord, 'recordDigest'> = {
    schemaVersion: 1,
    recordId: recordId(source),
    seedProjectionDigest: '',
    source,
    applicability: {
      model: round.plan.seed.model,
      provider: seed.provider,
      datasetDigest: spec.datasets.seed.digest,
      rolloutProviderDigest: round.plan.seed.rolloutProviderDigest,
      toolchainDigest: digestJson(spec.toolchainRef),
    },
    proposal: {
      rationale: proposal.rationale,
      expectedOutcome: proposal.expectedOutcome,
      semanticTargets: uniqueSorted(proposal.semanticTargets ?? []) as SemanticTarget[],
    },
    change: {
      patchDigest: change.patchDigest,
      totalBytes: change.totalBytes,
      files: change.files.map(projectedDiffFile).sort((left, right) => left.path.localeCompare(right.path)),
    },
    observation,
    classification: {
      execution: 'evaluated',
      effect,
      coverage: taskResults.length === 0
        ? 'none'
        : comparison.pairing.excluded === 0 && comparison.pairing.paired === comparison.pairing.planned
          ? 'complete'
          : 'partial',
      gainedTasks: uniqueSorted(gains.map(item => item.taskName)),
      regressedTasks: uniqueSorted(losses.map(item => item.taskName)),
      unchangedTasks: uniqueSorted(unchanged.map(item => item.taskName)),
    },
  }
  base.seedProjectionDigest = digestJson(projectionOf(base))
  return { ...base, recordDigest: digestJson(base) }
}

export function validateSeedExperienceRecord(value: SeedExperienceRecord): SeedExperienceRecord {
  if (value.schemaVersion !== 1 || typeof value.recordId !== 'string' || value.recordId.length === 0
    || !SHA256.test(value.seedProjectionDigest) || !SHA256.test(value.recordDigest)
    || value.recordId !== recordId(value.source)
    || value.seedProjectionDigest !== digestJson(projectionOf(value))) {
    throw new TypeError('seed experience record identity is invalid')
  }
  const { recordDigest, ...base } = value
  if (digestJson(base) !== recordDigest) throw new TypeError('seed experience record digest is invalid')
  if (value.observation.taskResults.length !== value.observation.valid
    || value.observation.excludedTaskResults.length !== value.observation.excluded
    || value.observation.valid === 0 && value.classification.effect !== 'insufficient'
    || value.observation.valid > 0 && value.classification.effect === 'insufficient') {
    throw new TypeError('seed experience record coverage is invalid')
  }
  return value
}

export async function prepareSeedExperienceSnapshot(
  spec: Readonly<EvolutionSpec>,
  store: RefineStateStore,
  currentRoundId: string,
  options?: PrepareSeedExperienceSnapshotOptions,
): Promise<SeedExperienceSnapshot> {
  const rounds = (await store.listRounds())
    .filter(round => round.evolutionId === spec.evolutionId && round.roundId !== currentRoundId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.roundId.localeCompare(right.roundId))
  let records: SeedExperienceRecord[] = []
  for (const round of rounds) {
    for (const candidate of round.candidatePool) {
      const record = extractSeedExperienceRecord(spec, round, candidate)
      if (record !== undefined) records.push(record)
    }
  }
  if (records.length > EXPERIENCE_V1_MAX_SNAPSHOT_RECORDS) {
    throw new Error(`seed experience snapshot exceeds the V1 limit of ${EXPERIENCE_V1_MAX_SNAPSHOT_RECORDS} records`)
  }
  if (options !== undefined && records.length > 0) {
    const signal = options.signal ?? new AbortController().signal
    const reused = new Array<boolean>(records.length).fill(false)
    const priorSnapshot = [...rounds].reverse().find(round => round.experienceSnapshot !== undefined)?.experienceSnapshot
    if (priorSnapshot !== undefined) {
      signal.throwIfAborted()
      try {
        const prior = await loadSeedExperienceSnapshot(store, priorSnapshot)
        const byRecordId = new Map(prior.records.map(record => [record.recordId, record]))
        records = records.map((record, index) => {
          const candidate = byRecordId.get(record.recordId)
          if (candidate === undefined || !isReusableSeedExperienceUse(candidate)
            || seedExperienceUseBaseDigest(candidate) !== record.seedProjectionDigest) return record
          reused[index] = true
          return candidate
        })
      } catch {
        // A prior frozen snapshot remains independently readable; retry derivation for this new snapshot.
      }
      signal.throwIfAborted()
    }
    const resolved = new Array<ExperienceChangedArtifactInput[] | undefined>(records.length)
    let next = 0
    const resolveWorker = async (): Promise<void> => {
      while (true) {
        signal.throwIfAborted()
        const index = next++
        if (index >= records.length) return
        if (reused[index]) continue
        try { resolved[index] = await resolveExperienceChangedArtifacts(records[index]!, options.artifactReader) }
        catch {
          signal.throwIfAborted()
          resolved[index] = undefined
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, resolveWorker))
    const runIds = uniqueSorted(records.flatMap((record, index) => reused[index] || resolved[index] === undefined
      ? []
      : experienceCandidateRunIds(record)))
    let reads = new Map<string, ExperienceUsageReadResult>()
    if (runIds.length > 0 && options.usageReader !== undefined && spec.rollout.provider.id === 'hitch-cli') {
      try { reads = await options.usageReader.readRuns(runIds, signal) }
      catch (error) {
        signal.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
      }
    }
    records = records.map((record, index) => reused[index]
      ? record
      : enrichSeedExperienceUse(
          record,
          resolved[index] ?? record.change.files.map(file => ({
            identity: { path: file.path, change: file.change },
          })),
          reads,
        ))
    signal.throwIfAborted()
  }
  for (const record of records) await store.writeExperienceRecord(record)
  const members = records.map(record => ({
    recordId: record.recordId,
    recordDigest: record.recordDigest,
    sourceRoundId: record.source.roundId,
    candidateId: record.source.candidateId,
    candidateHarnessRef: record.source.candidateHarnessRef,
  })).sort((left, right) => left.recordId.localeCompare(right.recordId))
  const identity = { schemaVersion: 1 as const, members }
  return { ...identity, digest: digestJson(identity) }
}

export async function loadSeedExperienceSnapshot(
  store: RefineStateStore,
  snapshot: Readonly<SeedExperienceSnapshot>,
): Promise<{ records: SeedExperienceRecord[]; unavailableRecordIds: string[] }> {
  const records: SeedExperienceRecord[] = []
  const unavailableRecordIds: string[] = []
  for (const member of snapshot.members) {
    try {
      const record = await store.readExperienceRecord(member.recordDigest)
      if (record === undefined || record.recordId !== member.recordId
        || record.source.roundId !== member.sourceRoundId
        || record.source.candidateId !== member.candidateId
        || record.source.candidateHarnessRef !== member.candidateHarnessRef) {
        unavailableRecordIds.push(member.recordId)
      } else records.push(record)
    } catch {
      unavailableRecordIds.push(member.recordId)
    }
  }
  return { records, unavailableRecordIds }
}

export function experienceRef(recordDigest: string): string {
  if (!SHA256.test(recordDigest)) throw new TypeError('experience record digest is invalid')
  return `experience_${recordDigest.slice('sha256:'.length)}`
}

export function experienceDigestFromRef(ref: string): string | undefined {
  const match = ref.match(EXPERIENCE_REF)
  return match?.[1] === undefined ? undefined : `sha256:${match[1]}`
}

function compactList(values: readonly string[], maxItems = 6): string {
  if (values.length === 0) return 'none'
  return `${values.slice(0, maxItems).map(value => boundedUtf8(value, 160)).join(', ')}${values.length > maxItems ? ` (+${values.length - maxItems} more)` : ''}`
}

function quantitativeUseLines(record: Readonly<SeedExperienceRecord>): string[] {
  const use = record.observation.modificationUse
  if (use === undefined) return []
  const counts = use.statusCounts
  const conditionedObserved = use.conditionedResults.find(item => item.status === 'observed')
  const lines = [
    `Modified-resource use: exact use of any changed artifact was observed in ${counts.observed}/${use.candidateTrials} candidate trials; only failed attempts ${counts['attempted-failure']}; no exact match in fully verified listed files ${counts['not-observed']}; unknown ${counts.unknown}.`,
  ]
  if (conditionedObserved !== undefined && conditionedObserved.validPairs > 0) {
    lines.push(`Observed-use paired results: ${conditionedObserved.validPairs} valid pairs across ${conditionedObserved.taskCount} tasks; parent mean ${conditionedObserved.baselineMean!.toFixed(6)} → candidate mean ${conditionedObserved.candidateMean!.toFixed(6)} (delta ${conditionedObserved.meanRewardDelta!.toFixed(6)}).`)
  }
  const groups = new Map<string, {
    taskName: string
    valid: SeedExperiencePairedTaskResult[]
    excluded: SeedExperienceExcludedTaskResult[]
  }>()
  for (const item of record.observation.taskResults) {
    const group = groups.get(item.taskName) ?? { taskName: item.taskName, valid: [], excluded: [] }
    group.valid.push(item)
    groups.set(item.taskName, group)
  }
  for (const item of record.observation.excludedTaskResults) {
    const group = groups.get(item.taskName) ?? { taskName: item.taskName, valid: [], excluded: [] }
    group.excluded.push(item)
    groups.set(item.taskName, group)
  }
  const facts = [...groups.values()].filter(group => group.valid.length > 0).map(group => {
    const all = [...group.valid, ...group.excluded]
    const statusCounts = { observed: 0, failed: 0, noMatch: 0, unknown: 0 }
    for (const item of all) {
      const status = item.candidate.modificationUse?.status ?? 'unknown'
      if (status === 'observed') statusCounts.observed += 1
      else if (status === 'attempted-failure') statusCounts.failed += 1
      else if (status === 'not-observed') statusCounts.noMatch += 1
      else statusCounts.unknown += 1
    }
    const binary = group.valid.every(item => [0, 1].includes(item.baseline.reward)
      && [0, 1].includes(item.candidate.reward))
    const baselineMean = group.valid.reduce((sum, item) => sum + item.baseline.reward, 0) / group.valid.length
    const candidateMean = group.valid.reduce((sum, item) => sum + item.candidate.reward, 0) / group.valid.length
    return {
      ...group,
      statusCounts,
      binary,
      baselineMean,
      candidateMean,
      delta: candidateMean - baselineMean,
      total: all.length,
    }
  })
  const selected: typeof facts = []
  const seen = new Set<string>()
  const add = (items: readonly (typeof facts)[number][]): void => {
    for (const item of items) {
      if (selected.length >= 4) return
      if (seen.has(item.taskName)) continue
      seen.add(item.taskName)
      selected.push(item)
    }
  }
  const observed = facts.filter(item => item.statusCounts.observed > 0)
  add([...observed].filter(item => item.delta > 0)
    .sort((left, right) => right.delta - left.delta || left.taskName.localeCompare(right.taskName)).slice(0, 1))
  add([...facts].filter(item => item.delta < 0)
    .sort((left, right) => left.delta - right.delta || left.taskName.localeCompare(right.taskName)).slice(0, 1))
  add([...observed].sort((left, right) => right.statusCounts.observed - left.statusCounts.observed
    || Math.abs(right.delta) - Math.abs(left.delta) || left.taskName.localeCompare(right.taskName)))
  add([...facts].sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta)
    || left.taskName.localeCompare(right.taskName)))
  if (selected.length > 0) {
    lines.push(`Paired task facts: ${selected.map(item => {
      const outcome = item.binary
        ? `successes ${item.valid.filter(row => row.baseline.reward === 1).length}/${item.valid.length}→${item.valid.filter(row => row.candidate.reward === 1).length}/${item.valid.length}`
        : `mean ${item.baselineMean.toFixed(6)}→${item.candidateMean.toFixed(6)}`
      const useFacts = [`use ${item.statusCounts.observed}/${item.total}`]
      if (item.statusCounts.failed > 0) useFacts.push(`failed ${item.statusCounts.failed}`)
      if (item.statusCounts.noMatch > 0) useFacts.push(`no-match ${item.statusCounts.noMatch}`)
      if (item.statusCounts.unknown > 0) useFacts.push(`unknown ${item.statusCounts.unknown}`)
      return `${boundedUtf8(item.taskName, 100)}: ${item.valid.length} valid, ${item.excluded.length} excluded; ${outcome}; ${useFacts.join(', ')}`
    }).join('; ')}.`)
  }
  lines.push('Interpretation: exact recorded use is descriptive and does not prove that the changed branch or resource caused an outcome.')
  return lines
}

export function renderSeedExperienceCard(
  record: Readonly<SeedExperienceRecord>,
  matchReasons: readonly string[] = [],
): SeedExperienceCard {
  const observed = record.observation.valid === 0
    ? `${record.observation.valid}/${record.observation.planned} valid pairs; no measured reward effect.`
    : `${record.observation.valid}/${record.observation.planned} valid pairs, ${record.observation.excluded} excluded; mean paired reward delta ${record.observation.meanRewardDelta!.toFixed(6)}.`
  const markdown = boundedUtf8([
    `Experience ${record.recordId}`,
    `Observed candidate-vs-parent seed result: ${record.classification.effect} (${record.classification.coverage} coverage); ${observed}`,
    `Changed paths: ${compactList(record.change.files.map(file => file.path))}`,
    ...quantitativeUseLines(record),
    `Task support — gains: ${compactList(record.classification.gainedTasks)}; regressions: ${compactList(record.classification.regressedTasks)}; unchanged: ${compactList(record.classification.unchangedTasks)}.`,
    ...(record.observation.modificationUse === undefined
      ? ['Interpretation: descriptive paired observations only; no causal or statistical-significance claim.']
      : []),
    `Claimed rationale: ${boundedUtf8(record.proposal.rationale, 420)}`,
    `Claimed expected outcome: ${boundedUtf8(record.proposal.expectedOutcome, 420)}`,
  ].join('\n'), EXPERIENCE_V1_MAX_CARD_BYTES)
  return {
    recordId: record.recordId,
    experienceRef: experienceRef(record.recordDigest),
    source: { roundId: record.source.roundId, candidateId: record.source.candidateId },
    effect: record.classification.effect,
    coverage: {
      planned: record.observation.planned,
      valid: record.observation.valid,
      excluded: record.observation.excluded,
    },
    matchReasons: uniqueSorted(matchReasons),
    markdown,
  }
}

function terms(value: string): string[] {
  return uniqueSorted(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
}

function normalized(values: readonly string[] | undefined): string[] {
  return uniqueSorted((values ?? []).map(value => value.toLocaleLowerCase()))
}

export function rankSeedExperience(
  records: readonly SeedExperienceRecord[],
  query: Readonly<SeedExperienceQuery>,
  parentHarnessRef?: string,
): RankedSeedExperience[] {
  const taskFilter = normalized(query.taskNames)
  const targetFilter = normalized(query.semanticTargets)
  const pathFilter = normalized(query.paths)
  const effectFilter = new Set(query.effects ?? [])
  const queryTerms = terms(query.query ?? '')
  const values: RankedSeedExperience[] = []
  for (const record of records) {
    const tasks = normalized([
      ...record.observation.taskResults.map(item => item.taskName),
      ...record.observation.excludedTaskResults.map(item => item.taskName),
    ])
    const targets = normalized(record.proposal.semanticTargets)
    const paths = normalized(record.change.files.map(file => file.path))
    if (taskFilter.length > 0 && !taskFilter.some(value => tasks.includes(value))) continue
    if (targetFilter.length > 0 && !targetFilter.some(value => targets.includes(value))) continue
    if (pathFilter.length > 0 && !pathFilter.some(value => paths.includes(value))) continue
    if (effectFilter.size > 0 && !effectFilter.has(record.classification.effect)) continue

    let score = 0
    const reasons: string[] = []
    const weightedFields: Array<[string, number, string]> = [
      [tasks.join(' '), 6, 'task term'],
      [targets.join(' '), 5, 'semantic-target term'],
      [paths.join(' '), 4, 'path term'],
      [record.proposal.expectedOutcome.toLocaleLowerCase(), 2, 'expected-outcome term'],
      [record.proposal.rationale.toLocaleLowerCase(), 1, 'rationale term'],
    ]
    for (const term of queryTerms) {
      const match = weightedFields.find(([field]) => field.includes(term))
      if (match !== undefined) {
        score += match[1]
        reasons.push(`${match[2]}: ${term}`)
      }
    }
    if (queryTerms.length > 0 && score === 0) continue
    if (taskFilter.length > 0) { score += 6; reasons.push('task filter') }
    if (targetFilter.length > 0) { score += 5; reasons.push('semantic-target filter') }
    if (pathFilter.length > 0) { score += 4; reasons.push('path filter') }
    if (effectFilter.size > 0) { score += 2; reasons.push('effect filter') }
    if (record.source.candidateHarnessRef === parentHarnessRef) { score += 3; reasons.push('direct lineage parent') }
    if (record.classification.effect === 'regressed' || record.classification.effect === 'mixed') score += 1
    values.push({ record, score, matchReasons: uniqueSorted(reasons) })
  }
  return values.sort((left, right) => right.score - left.score
    || left.record.recordId.localeCompare(right.record.recordId)
    || left.record.recordDigest.localeCompare(right.record.recordDigest))
}

function automaticRank(
  records: readonly SeedExperienceRecord[],
  baseline: Readonly<EvaluationEvidence>,
  focus: readonly SemanticTarget[] | undefined,
  excludedDigest?: string,
): RankedSeedExperience[] {
  const failedTasks = new Set([
    ...baseline.trials.filter(trial => (trial.rewards.reward ?? Object.values(trial.rewards)[0] ?? 0) <= 0)
      .map(trial => trial.taskName.toLocaleLowerCase()),
    ...baseline.invalidTrials.map(trial => trial.taskName.toLocaleLowerCase()),
  ])
  const targets = new Set(normalized(focus))
  return records.flatMap(record => {
    if (record.recordDigest === excludedDigest) return []
    const recordTasks = normalized([
      ...record.observation.taskResults.map(item => item.taskName),
      ...record.observation.excludedTaskResults.map(item => item.taskName),
    ])
    const taskMatches = recordTasks.filter(task => failedTasks.has(task))
    const targetMatches = normalized(record.proposal.semanticTargets).filter(target => targets.has(target))
    if (taskMatches.length === 0 && targetMatches.length === 0) return []
    const score = taskMatches.length * 6 + targetMatches.length * 5
      + (record.classification.effect === 'regressed' || record.classification.effect === 'mixed' ? 1 : 0)
    return [{
      record,
      score,
      matchReasons: [
        ...taskMatches.map(task => `current failed task: ${task}`),
        ...targetMatches.map(target => `advisory semantic target: ${target}`),
      ],
    }]
  }).sort((left, right) => right.score - left.score
    || left.record.recordId.localeCompare(right.record.recordId)
    || left.record.recordDigest.localeCompare(right.record.recordDigest))
}

export async function buildSeedExperienceContext(
  store: RefineStateStore,
  round: Readonly<RefinementRound>,
  candidate: Readonly<CandidateRecord>,
  baseline: Readonly<EvaluationEvidence>,
): Promise<SeedExperienceContext | undefined> {
  const snapshot = round.experienceSnapshot
  if (snapshot === undefined) return undefined
  const loaded = await loadSeedExperienceSnapshot(store, snapshot)
  if (loaded.unavailableRecordIds.length > 0) {
    throw new Error(`seed experience snapshot is incomplete; unavailable record IDs: ${loaded.unavailableRecordIds.join(', ')}`)
  }
  const parentCandidateId = candidate.parentCandidateIds[0]
  const direct = loaded.records
    .filter(record => record.source.candidateId === parentCandidateId
      && record.source.candidateHarnessRef === candidate.parentHarnessRef)
    .sort((left, right) => left.recordDigest.localeCompare(right.recordDigest))[0]
  const context: SeedExperienceContext = {
    schemaVersion: 1,
    snapshotDigest: snapshot.digest,
    availableRecordCount: loaded.records.length,
    ...(direct === undefined ? {} : {
      directParent: renderSeedExperienceCard(direct, ['actual direct parent edit outcome']),
    }),
    relevantCards: [],
  }
  const ranked = automaticRank(loaded.records, baseline, round.advisoryFocus, direct?.recordDigest)
  const relevantLimit = direct === undefined ? 3 : 2
  for (const item of ranked.slice(0, relevantLimit)) {
    const card = renderSeedExperienceCard(item.record, item.matchReasons)
    const next = { ...context, relevantCards: [...context.relevantCards, card] }
    if (Buffer.byteLength(JSON.stringify(next)) > EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES) break
    context.relevantCards.push(card)
  }
  if (Buffer.byteLength(JSON.stringify(context)) > EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES) {
    throw new Error('direct parent seed experience exceeds the fixed assignment byte limit')
  }
  return context
}
