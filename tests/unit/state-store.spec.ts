import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinComponentRef } from '../../src/evolution/components.js'
import { digestJson } from '../../src/state/evolution.js'
import { RefineStateStore, RoundAlreadyRunningError } from '../../src/state/store.js'
import type { RefinementRound } from '../../src/types.js'
import { evidence, roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => new RefineStateStore(root).resetForTests()))
})

async function store(): Promise<RefineStateStore> {
  const root = await mkdtemp(join(tmpdir(), 'refine-state-'))
  roots.push(root)
  return new RefineStateStore(root)
}

function championParentRound(): RefinementRound {
  const round = roundFixture()
  const candidate = round.candidatePool[0]!
  round.championParent = {
    candidateId: candidate.parentCandidateIds[0]!,
    harnessRef: round.targetHarnessRef,
    harnessDigest: round.targetHarnessDigest,
    parentCandidateIds: [],
    lineageRootId: candidate.parentCandidateIds[0]!,
    metrics: { quality: 0.4, taskSuccessRate: 0.4 },
    selectedAt: 'before',
    metaSessionId: 'champion-meta',
    metaCheckpoint: { sourceSessionId: 'champion-meta', eventCount: 4, prefixDigest: `sha256:${'1'.repeat(64)}` },
  }
  round.parentAllocations = [{
    candidateId: candidate.candidateId,
    parentCandidateId: round.championParent.candidateId,
    parentHarnessRef: round.championParent.harnessRef,
    parentHarnessDigest: round.championParent.harnessDigest,
  }]
  return round
}

describe('RefineStateStore', () => {
  it('persists an admitted champion parent without requiring it in the research population', async () => {
    const state = await store()
    const round = championParentRound()
    await state.writeRound(round)
    expect((await state.readRound(round.roundId))?.championParent).toEqual(round.championParent)
    expect(await state.readPopulation()).toBeUndefined()
  })

  it('rejects malformed or substituted champion parent snapshots', async () => {
    const state = await store()
    const round = championParentRound()
    const parent = round.championParent!
    for (const championParent of [
      { ...parent, candidateId: '' },
      { ...parent, lineageRootId: '' },
      { ...parent, metrics: { quality: Number.NaN, taskSuccessRate: 0.4 } },
      { ...parent, harnessRef: 'b'.repeat(40) },
      { ...parent, harnessDigest: `sha256:${'2'.repeat(64)}` },
      { ...parent, metaCheckpoint: { ...parent.metaCheckpoint!, sourceSessionId: 'rejected-candidate-meta' } },
    ]) {
      await expect(state.writeRound({ ...round, championParent })).rejects.toThrow(/population member|champion parent/u)
    }
    await state.writeRound(round)
    await writeFile(join(state.roundsPath, `${round.roundId}.json`), JSON.stringify({ ...round,
      championParent: { ...parent, harnessDigest: `sha256:${'2'.repeat(64)}` },
    }))
    await expect(state.readRound(round.roundId)).rejects.toThrow(/champion parent/u)
  })

  it('binds every new candidate allocation to the single admitted champion parent', async () => {
    const state = await store()
    const original = championParentRound()
    const alternate = structuredClone(original)
    alternate.parentAllocations![0]!.parentCandidateId = 'unpromoted-candidate'
    alternate.candidatePool[0]!.parentCandidateIds = ['unpromoted-candidate']
    await expect(state.writeRound(alternate)).rejects.toThrow(/champion parent allocation/u)

    const changedRef = structuredClone(original)
    changedRef.parentAllocations![0]!.parentHarnessRef = 'b'.repeat(40)
    changedRef.candidatePool[0]!.parentHarnessRef = 'b'.repeat(40)
    await expect(state.writeRound(changedRef)).rejects.toThrow(/champion parent allocation/u)

    const changedDigest = structuredClone(original)
    changedDigest.parentAllocations![0]!.parentHarnessDigest = `sha256:${'2'.repeat(64)}`
    await expect(state.writeRound(changedDigest)).rejects.toThrow(/champion parent allocation/u)
    const missingAllocations = structuredClone(original)
    delete missingAllocations.parentAllocations
    await expect(state.writeRound(missingAllocations)).rejects.toThrow(/champion parent allocation/u)

    const duplicated = structuredClone(original)
    duplicated.candidatePool.push({ ...duplicated.candidatePool[0]!, candidateId: 'round-1-candidate-2' })
    duplicated.parentAllocations!.push({ ...duplicated.parentAllocations![0]! })
    await expect(state.writeRound(duplicated)).rejects.toThrow(/champion parent allocation/u)
  })

  it('keeps historical rounds with a non-champion research parent readable', async () => {
    const state = await store()
    const round = championParentRound()
    delete round.championParent
    round.candidatePool[0]!.parentCandidateIds = ['historical-research-parent']
    round.candidatePool[0]!.parentHarnessRef = 'b'.repeat(40)
    round.parentAllocations![0] = { ...round.parentAllocations![0]!,
      parentCandidateId: 'historical-research-parent', parentHarnessRef: 'b'.repeat(40),
      parentHarnessDigest: `sha256:${'2'.repeat(64)}`,
    }
    await state.writeRound(round)
    expect(await state.readRound(round.roundId)).toEqual(round)
  })

  it('validates durable evaluation starts without requiring a provider eval ID', async () => {
    const state = await store()
    const round = roundFixture({ status: 'baseline-running' })
    const start = { phase: 'seed-baseline' as const, harnessRef: round.targetHarnessRef,
      conditionId: round.plan.seed.conditionId, startedAt: 'now' }
    await state.writeRound({ ...round, evaluationStarts: [start] })
    expect((await state.readRound(round.roundId))?.evaluationStarts).toEqual([start])
    await expect(state.writeRound({ ...round, evaluationStarts: [{ ...start, conditionId: round.plan.heldOut.conditionId }] })).rejects.toThrow(/evaluation start/u)
  })

  it('persists explicit baseline blockers only on failed rounds', async () => {
    const state = await store()
    const round = roundFixture({ status: 'failed' })
    const baselineReuseBlocker = {
      code: 'BASELINE_IDENTITY_UNRESOLVED' as const,
      reason: 'Existing baseline identity could not be verified.',
      requiredAction: 'Restore evaluator identity resolution.',
    }
    await state.writeRound({ ...round, baselineReuseBlocker })
    expect((await state.readRound(round.roundId))?.baselineReuseBlocker).toEqual(baselineReuseBlocker)
    await expect(state.writeRound({ ...round, status: 'baseline-running', baselineReuseBlocker })).rejects.toThrow(/baselineReuseBlocker/u)
    await expect(state.writeRound({ ...round, baselineReuseBlocker: { ...baselineReuseBlocker, requiredAction: '' } })).rejects.toThrow(/baselineReuseBlocker/u)
  })

  it('persists unresolved submission ownership and rejects mismatched or duplicated intents', async () => {
    const state = await store()
    const round = roundFixture({ status: 'baseline-running' })
    const pending = {
      intent: { provider: 'hitch-cli', idempotencyKey: `gear-eval-v1-${'1'.repeat(64)}`, parameters: { root: '', args: ['--dataset', 'seed'] } },
      request: { phase: 'seed-baseline' as const, dataset: round.seedTaskRef,
        harnessRef: round.targetHarnessRef, condition: round.plan.seed },
      owner: { candidateId: `champion-${round.targetHarnessRef}`, role: 'baseline' as const, harnessRef: round.targetHarnessRef },
      startedAt: new Date().toISOString(),
    }
    await state.writeRound({ ...round, pendingEvaluationSubmissions: [pending] })
    expect((await state.readRound(round.roundId))?.pendingEvaluationSubmissions).toEqual([pending])
    await expect(state.writeRound({ ...round, pendingEvaluationSubmissions: [pending, pending] })).rejects.toThrow(/duplicated/u)
    await expect(state.writeRound({ ...round, pendingEvaluationSubmissions: [{ ...pending,
      request: { ...pending.request, condition: { ...round.plan.seed, model: 'changed' } },
    }] })).rejects.toThrow(/condition/u)
    await expect(state.writeRound({ ...round, pendingEvaluationSubmissions: [{ ...pending,
      owner: { ...pending.owner, harnessRef: 'f'.repeat(40) },
    }] })).rejects.toThrow(/owner/u)
  })

  it('persists rerun identity only for its owned failed or rerunning attempt', async () => {
    const state = await store()
    const round = roundFixture({ status: 'repairing-evaluation' })
    const evalId = `eval_${'a'.repeat(32)}`
    const reservation = { provider: 'hitch-cli', evalId, rerunId: `rerun_${'b'.repeat(32)}`, parameters: { root: 'original-root' } }
    round.evaluationAttempts = [{
      provider: 'hitch-cli', evalId, phase: 'seed-baseline',
      owner: { candidateId: `champion-${round.targetHarnessRef}`, role: 'baseline', harnessRef: round.targetHarnessRef },
      conditionId: round.plan.seed.conditionId, dataset: round.seedTaskRef,
      requestedModelId: round.plan.seed.model, requestedCommit: round.targetHarnessRef,
      status: 'rerunning', startedAt: 'before',
    }]
    await state.writeRound({ ...round, pendingEvaluationRerun: { reservation } })
    expect((await state.readRound(round.roundId))?.pendingEvaluationRerun).toEqual({ reservation })
    for (const changed of [{ evalId: `eval_${'c'.repeat(32)}` }, { rerunId: '../other' }, { provider: 'other' }]) {
      await expect(state.writeRound({ ...round, pendingEvaluationRerun: { reservation: { ...reservation, ...changed } } })).rejects.toThrow()
    }
  })

  it('atomically persists state and enforces champion CAS', async () => {
    const state = await store()
    await state.initialize()
    const parent = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    await state.writeChampion({ schemaVersion: 2, ref: parent, manifestDigest: `sha256:${'1'.repeat(64)}`, updatedAt: 'now' })
    await state.compareAndSwapChampion(parent, {
      schemaVersion: 2, ref: candidate, manifestDigest: `sha256:${'2'.repeat(64)}`, updatedAt: 'later', roundId: 'round-1',
    })
    expect((await state.readChampion())?.ref).toBe(candidate)
    await expect(state.compareAndSwapChampion(parent, {
      schemaVersion: 2, ref: 'c'.repeat(40), manifestDigest: `sha256:${'3'.repeat(64)}`, updatedAt: 'never',
    })).rejects.toThrow(/CAS failed/)
    expect(JSON.parse(await readFile(join(state.root, 'champion.json'), 'utf8'))).toMatchObject({ ref: candidate })
  })

  it('admits one cross-process owner and release is idempotent', async () => {
    const state = await store()
    const lock = await state.acquireRoundLock()
    await expect(state.acquireRoundLock()).rejects.toBeInstanceOf(RoundAlreadyRunningError)
    await lock.release()
    await lock.release()
    const next = await state.acquireRoundLock()
    await next.release()
  })

  it('reclaims a dead process lock', async () => {
    const state = await store()
    await state.initialize()
    await writeFile(join(state.locksPath, 'round.lock'), JSON.stringify({
      pid: 2_147_483_647, token: 'dead', acquiredAt: 'before',
    }))
    const lock = await state.acquireRoundLock()
    await lock.release()
  })

  it('rejects persisted artifact-era state instead of confusing sha256 identities with commits', async () => {
    const state = await store()
    await state.initialize()
    await writeFile(join(state.root, 'champion.json'), JSON.stringify({
      ref: `sha256:${'a'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}`, artifactPath: '/old', updatedAt: 'old',
    }))
    await expect(state.readChampion()).rejects.toThrow(/unsupported champion state schema/)
  })

  it('persists provider-neutral evaluation evidence without Hitch-only transport fields', async () => {
    const state = await store()
    const round = roundFixture({ status: 'preparing-candidate' })
    const hitch = evidence(round.plan.seed, round.targetHarnessRef)
    const { invocationFingerprint: _fingerprint, localSourceTransport: _transport, ...generic } = hitch
    round.baseline = { ...generic, provider: 'custom-runner', evalId: 'custom-eval-1' }
    await state.writeRound(round)
    await expect(state.readRound(round.roundId)).resolves.toMatchObject({
      baseline: { provider: 'custom-runner', evalId: 'custom-eval-1' },
    })
  })

  it('requires a unique non-terminal resume intent for durable repair evidence', async () => {
    const state = await store()
    const round = roundFixture({ status: 'baseline-running' })
    const repaired = { ...evidence(round.plan.seed, round.targetHarnessRef), provider: 'hitch-cli' }
    const completedAt = 'repair-completed-at'
    round.baseline = repaired
    round.parentBaselines = [{
      parentCandidateId: `champion-${round.targetHarnessRef}`,
      parentHarnessRef: round.targetHarnessRef,
      evidence: repaired,
    }]
    round.evaluationAttempts = [{
      provider: repaired.provider,
      evalId: repaired.evalId,
      phase: 'seed-baseline',
      owner: {
        candidateId: `champion-${round.targetHarnessRef}`,
        role: 'baseline',
        harnessRef: round.targetHarnessRef,
      },
      conditionId: round.plan.seed.conditionId,
      dataset: round.seedTaskRef,
      requestedModelId: round.plan.seed.model,
      requestedCommit: round.targetHarnessRef,
      status: 'repair-completed',
      startedAt: 'repair-started-at',
      completedAt,
    }]
    round.evaluationRepairResume = { provider: repaired.provider, evalId: repaired.evalId, completedAt }

    await expect(state.writeRound(round)).resolves.toBeUndefined()
    await expect(state.writeRound({ ...round, status: 'failed' })).rejects.toThrow(/repair resume intent is invalid/u)
    const { evaluationRepairResume: _intent, ...withoutIntent } = round
    await expect(state.writeRound(withoutIntent)).rejects.toThrow(/durable attempt ownership/u)
  })

  it('persists partial evidence while rejecting inconsistent completeness metadata', async () => {
    const state = await store()
    const round = roundFixture({ status: 'preparing-candidate' })
    const partial = evidence(round.plan.seed, round.targetHarnessRef)
    partial.completeness = 'partial'
    partial.plannedTrialCount = 2
    partial.invalidTrials = [{
      taskName: 'task-2', trialName: 'trial-2', runId: `run_${'2'.repeat(32)}`,
      attempt: 1, status: 'errored', invalidReason: 'infrastructure_failure',
    }]
    round.baseline = partial
    await state.writeRound(round)
    await expect(state.readRound(round.roundId)).resolves.toMatchObject({
      baseline: {
        completeness: 'partial', plannedTrialCount: 2,
        summary: { total: 1 }, invalidTrials: [{ taskName: 'task-2' }],
      },
    })
    round.baseline = { ...partial, completeness: 'complete' }
    await expect(state.writeRound(round)).rejects.toThrow(/invalid trials are invalid/)
  })

  it('binds persisted pairs, rewards, deltas, and planned identities to raw evidence', async () => {
    const state = await store()
    const round = roundFixture({ status: 'candidate-seed-running' })
    const baseline = evidence(round.plan.seed, round.targetHarnessRef, 0.4, '1')
    const candidate = evidence(round.plan.seed, 'b'.repeat(40), 0.8, '2')
    baseline.processScore = 0.25
    baseline.summary = { ...baseline.summary, process: { score: 0.25 }, metrics: { ...baseline.summary.metrics, processScore: 0.25 } }
    baseline.trials[0] = { ...baseline.trials[0]!, rewards: { reward: 0.4, total_score: 0.4, process_score: 0.25 }, scores: { totalScore: 0.4, processScore: 0.25, normalization: 'standard' } }
    candidate.processScore = 0.75
    candidate.summary = { ...candidate.summary, process: { score: 0.75 }, metrics: { ...candidate.summary.metrics, processScore: 0.75 } }
    candidate.trials[0] = { ...candidate.trials[0]!, rewards: { reward: 0.8, total_score: 0.8, process_score: 0.75 }, scores: { totalScore: 0.8, processScore: 0.75, normalization: 'standard' } }
    candidate.invocationFingerprint = `sha256:${'d'.repeat(64)}`
    round.candidatePool = [{
      ...round.candidatePool[0]!,
      status: 'evaluating',
      sealedVersion: {
        commitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40),
        manifestDigest: `sha256:${'3'.repeat(64)}`, patchDigest: `sha256:${'4'.repeat(64)}`,
        immutableRef: `refs/dsh-refine/evolutions/evo-1/candidates/${round.candidatePool[0]!.candidateId}`,
      },
    }]
    const pair = {
      conditionId: round.plan.seed.conditionId,
      trialKey: JSON.stringify(['task-1', null]),
      taskName: 'task-1',
      baselineRunId: baseline.trials[0]!.runId!,
      candidateRunId: candidate.trials[0]!.runId!,
      baselineReward: 0.4,
      candidateReward: 0.8,
      rewardDelta: 0.4,
      baselineProcessScore: 0.25,
      candidateProcessScore: 0.75,
      processScoreDelta: 0.5,
    }
    round.evaluation = {
      seedBaseline: baseline,
      seedCandidate: candidate,
      seedPairedTrials: [pair],
      seedPairing: { planned: 1, paired: 1, excluded: 0, baselineInvalid: 0, candidateInvalid: 0 },
      scoreDelta: 0.4,
      processScoreDelta: 0.5,
      requiredRegressions: 0,
    }
    await state.writeRound(round)
    round.promotionPolicy = { ...round.promotionPolicy, requiredTaskIds: ['task-1'] }
    await state.writeRound(round)
    round.evaluation.requiredRegressions = 1
    await expect(state.writeRound(round)).rejects.toThrow(/required regressions do not match/)
    round.evaluation.requiredRegressions = 0
    round.evaluation.seedPairedTrials = [{ ...pair, candidateReward: 0.9, rewardDelta: 0.5 }]
    round.evaluation.scoreDelta = 0.5
    await expect(state.writeRound(round)).rejects.toThrow(/pairing audit is invalid/)
    round.evaluation.seedPairedTrials = [pair]
    round.evaluation.scoreDelta = 0.3
    await expect(state.writeRound(round)).rejects.toThrow(/score delta does not match/)
    round.evaluation.scoreDelta = 0.4
    round.evaluation.processScoreDelta = 0.4
    await expect(state.writeRound(round)).rejects.toThrow(/process score delta does not match/)
    round.evaluation.processScoreDelta = 0.5
    round.evaluation.seedBaseline = { ...baseline, benchmark: { id: 'benchmark-1', revision: 'revision-1' } }
    round.evaluation.seedCandidate = { ...candidate, benchmark: { id: 'benchmark-1', revision: 'revision-2' } }
    await expect(state.writeRound(round)).rejects.toThrow(/pairing audit is invalid/)
    round.evaluation.seedBaseline = baseline
    round.evaluation.seedCandidate = candidate
    round.evaluation.seedCandidate = {
      ...candidate,
      trials: [{ ...candidate.trials[0]!, taskName: 'task-other' }],
    }
    await expect(state.writeRound(round)).rejects.toThrow(/pairing audit is invalid/)
  })

  it('rejects assessment evidence that is detached from candidate metrics or selector input', async () => {
    const state = await store()
    const round = roundFixture({ status: 'selection-running' })
    const candidateId = round.candidatePool[0]!.candidateId
    const candidateCommit = 'b'.repeat(40)
    const baseline = evidence(round.plan.seed, round.targetHarnessRef, 0.4, '1')
    const evaluated = evidence(round.plan.seed, candidateCommit, 0.8, '2')
    const metrics = { quality: 0.8, taskSuccessRate: 1, descriptors: { llmVerifierScore: 0.8 } }
    round.baseline = baseline
    round.parentBaselines = [{
      parentCandidateId: round.candidatePool[0]!.parentCandidateIds[0]!,
      parentHarnessRef: round.targetHarnessRef,
      evidence: baseline,
    }]
    round.candidatePool = [{
      ...round.candidatePool[0]!,
      status: 'selected',
      sealedVersion: {
        commitOid: candidateCommit,
        treeOid: 'c'.repeat(40),
        manifestDigest: `sha256:${'3'.repeat(64)}`,
        patchDigest: `sha256:${'4'.repeat(64)}`,
        immutableRef: `refs/dsh-refine/evolutions/evo-1/candidates/${candidateId}`,
      },
      seedEvaluation: evaluated,
      seedComparison: {
        parentBaselineEvalId: baseline.evalId,
        pairedTrials: [{
          conditionId: round.plan.seed.conditionId,
          trialKey: JSON.stringify(['task-1', null]),
          taskName: 'task-1',
          baselineRunId: baseline.trials[0]!.runId!,
          candidateRunId: evaluated.trials[0]!.runId!,
          baselineReward: 0.4,
          candidateReward: 0.8,
          rewardDelta: 0.4,
        }],
        pairing: { planned: 1, paired: 1, excluded: 0, baselineInvalid: 0, candidateInvalid: 0 },
        scoreDelta: 0.4,
        requiredRegressions: 0,
      },
      metrics,
    }]
    const component = builtinComponentRef('candidate-assessor', 'evaluation-metrics', {})
    const assessmentIdentity = {
      component,
      candidateMetrics: { [candidateId]: metrics },
      rankingCandidateIds: [candidateId],
      reason: 'test assessment',
      evidence: { kind: 'test' },
      usage: { modelRequests: 0, inputTokens: 0, outputTokens: 0 },
    }
    round.selectionAssessment = { ...assessmentIdentity, digest: digestJson(assessmentIdentity) }
    round.selection = {
      selectedCandidateIds: [candidateId],
      promotionCandidateId: candidateId,
      reason: 'highest quality',
      component: builtinComponentRef('candidate-selector', 'highest-quality', {}),
      assessmentDigest: round.selectionAssessment.digest,
      metrics: { [candidateId]: 0.8 },
    }
    round.promotionCandidateId = candidateId
    await state.writeRound(round)

    const path = join(state.roundsPath, `${round.roundId}.json`)
    const detached = JSON.parse(await readFile(path, 'utf8')) as typeof round
    detached.candidatePool[0]!.metrics!.quality = 0.1
    await writeFile(path, JSON.stringify(detached))
    await expect(state.readRound(round.roundId)).rejects.toThrow(/assessment metrics do not match/)

    await state.writeRound(round)
    const changedSelection = JSON.parse(await readFile(path, 'utf8')) as typeof round
    changedSelection.selection!.metrics = { unexpected: 1 }
    await writeFile(path, JSON.stringify(changedSelection))
    await expect(state.readRound(round.roundId)).rejects.toThrow(/selection decision is invalid/)
  })
})
