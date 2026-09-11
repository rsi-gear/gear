import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import {
  EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES,
  EXPERIENCE_V1_MAX_CARD_BYTES,
  EXPERIENCE_V1_MAX_QUERY_BYTES,
  EXPERIENCE_V1_MAX_READ_BYTES,
  buildSeedExperienceContext,
  extractSeedExperienceRecord,
  prepareSeedExperienceSnapshot,
  renderSeedExperienceCard,
} from '../../src/experience/memory.js'
import { enrichSeedExperienceUse, type ExperienceUsageReadResult } from '../../src/experience/usage.js'
import { SkillMetaCoordinator, SkillMetaSessionManager, type SkillHarnessIdentity } from '../../src/meta/skill.js'
import { RefineSkillGateway } from '../../src/skill/gateway.js'
import { digestJson } from '../../src/state/digest.js'
import { RefineStateStore } from '../../src/state/store.js'
import type {
  CandidateRecord,
  EvaluationCondition,
  EvaluationEvidence,
  HitchTrajectoryReader,
  PairedTrial,
  RefinementRound,
} from '../../src/types.js'
import { evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js'
import { trajectoryAnalysis, trajectoryEventsPage } from '../helpers/trajectory-fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const PARENT = 'b'.repeat(40)
const WINNER = 'c'.repeat(40)
const LOSER = 'd'.repeat(40)

interface Cell {
  taskName: string
  reward?: number
  invalid?: true
  serial: string
}

function seedEvidence(
  condition: EvaluationCondition,
  commit: string,
  evalSerial: string,
  cells: readonly Cell[],
): EvaluationEvidence {
  const valid = cells.filter(cell => cell.invalid !== true)
  const score = valid.length === 0 ? 0 : valid.reduce((sum, cell) => sum + cell.reward!, 0) / valid.length
  return {
    provider: 'fake',
    conditionId: condition.conditionId,
    effectiveConfigDigest: condition.rolloutProviderDigest,
    evalId: `eval_${evalSerial.repeat(32).slice(0, 32)}`,
    dataset: condition.dataset.ref,
    requestedCommit: commit,
    actualCommit: commit,
    revisionIdentity: SHA(evalSerial),
    completeness: cells.some(cell => cell.invalid === true) ? 'partial' : 'complete',
    plannedTrialCount: cells.length,
    primaryReward: score,
    summary: {
      total: valid.length,
      passed: valid.filter(cell => cell.reward! > 0).length,
      failed: valid.filter(cell => cell.reward! <= 0).length,
      score,
    },
    trials: valid.map(cell => ({
      taskName: cell.taskName,
      trialName: `${cell.taskName}-trial`,
      runId: `run_${cell.serial.repeat(32).slice(0, 32)}`,
      attempt: 1,
      status: 'completed' as const,
      rewards: { reward: cell.reward! },
    })),
    invalidTrials: cells.filter(cell => cell.invalid === true).map(cell => ({
      taskName: cell.taskName,
      trialName: `${cell.taskName}-trial`,
      runId: `run_${cell.serial.repeat(32).slice(0, 32)}`,
      attempt: 1,
      status: 'errored' as const,
      invalidReason: 'seed infrastructure evidence unavailable',
    })),
  }
}

function paired(
  condition: EvaluationCondition,
  baseline: EvaluationEvidence,
  candidate: EvaluationEvidence,
): PairedTrial[] {
  const before = new Map(baseline.trials.map(trial => [trial.taskName, trial]))
  return candidate.trials.flatMap(trial => {
    const parent = before.get(trial.taskName)
    if (parent === undefined) return []
    const baselineReward = parent.rewards.reward!
    const candidateReward = trial.rewards.reward!
    return [{
      conditionId: condition.conditionId,
      trialKey: JSON.stringify([trial.taskName, 1]),
      taskName: trial.taskName,
      ...(parent.trialName === undefined ? {} : { baselineTrialName: parent.trialName }),
      ...(trial.trialName === undefined ? {} : { candidateTrialName: trial.trialName }),
      attempt: 1,
      ...(parent.runId === undefined ? {} : { baselineRunId: parent.runId }),
      ...(trial.runId === undefined ? {} : { candidateRunId: trial.runId }),
      baselineReward,
      candidateReward,
      rewardDelta: candidateReward - baselineReward,
    }]
  }).sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

function candidate(
  round: RefinementRound,
  candidateId: string,
  commit: string,
  baseline: EvaluationEvidence,
  evaluation: EvaluationEvidence,
  status: CandidateRecord['status'],
  path: string,
  semanticTarget: 'context' | 'tool',
  longClaim = '',
): CandidateRecord {
  const pairs = paired(round.plan.seed, baseline, evaluation)
  return {
    candidateId,
    roundId: round.roundId,
    parentHarnessRef: PARENT,
    parentCandidateIds: ['parent-candidate'],
    sealedVersion: {
      commitOid: commit,
      treeOid: 'e'.repeat(40),
      manifestDigest: SHA(commit[0]!),
      patchDigest: SHA(commit[0]!),
      immutableRef: `refs/dsh-refine/evolutions/evo-1/candidates/${commit}`,
    },
    proposal: {
      rationale: `${candidateId} rationale ${longClaim}`,
      expectedOutcome: `${candidateId} expected ${longClaim}`,
      evidenceRefs: [baseline.evalId],
      semanticTargets: [semanticTarget],
    },
    diff: {
      parentRef: PARENT,
      files: [{ path, change: 'modified', additions: 1, deletions: 1 }],
      totalBytes: 20,
      patchDigest: SHA(commit[0]!),
    },
    seedEvaluation: evaluation,
    seedComparison: {
      parentBaselineEvalId: baseline.evalId,
      pairedTrials: pairs,
      pairing: {
        planned: baseline.plannedTrialCount,
        paired: pairs.length,
        excluded: baseline.plannedTrialCount - pairs.length,
        baselineInvalid: baseline.invalidTrials.length,
        candidateInvalid: evaluation.invalidTrials.length,
      },
      scoreDelta: pairs.length === 0 ? 0 : pairs.reduce((sum, pair) => sum + pair.rewardDelta, 0) / pairs.length,
      requiredRegressions: 0,
    },
    ...(pairs.length === 0 ? {} : { metrics: { quality: -999, taskSuccessRate: 0 } }),
    status,
  }
}

function outcomeRound(longClaim = ''): RefinementRound {
  const base = roundFixture({
    roundId: 'source-round',
    status: 'rejected',
    decision: 'rejected',
    targetHarnessRef: 'a'.repeat(40),
  })
  const baseline = seedEvidence(base.plan.seed, PARENT, '1', [
    { taskName: 'shared-failure', reward: 0, serial: '1' },
    { taskName: 'mixed-loss', reward: 1, serial: '2' },
    { taskName: 'invalid-cell', invalid: true, serial: '3' },
  ])
  const winnerSeed = seedEvidence(base.plan.seed, WINNER, '4', [
    { taskName: 'shared-failure', reward: 1, serial: '4' },
    { taskName: 'mixed-loss', reward: 0.5, serial: '5' },
    { taskName: 'invalid-cell', reward: 1, serial: '6' },
  ])
  const loserSeed = seedEvidence(base.plan.seed, LOSER, '7', [
    { taskName: 'shared-failure', reward: 0, serial: '7' },
    { taskName: 'mixed-loss', reward: 0, serial: '8' },
    { taskName: 'invalid-cell', reward: 1, serial: '9' },
  ])
  const provisional = {
    ...base,
    parentBaselines: [{ parentCandidateId: 'parent-candidate', parentHarnessRef: PARENT, evidence: baseline }],
  }
  const winner = candidate(provisional, 'winner-candidate', WINNER, baseline, winnerSeed, 'selected', 'plugins/context.ts', 'context', longClaim)
  const loser = candidate(provisional, 'losing-candidate', LOSER, baseline, loserSeed, 'discarded', 'plugins/tool.ts', 'tool', longClaim)
  return {
    ...provisional,
    parentAllocations: [winner, loser].map(value => ({
      candidateId: value.candidateId,
      parentCandidateId: 'parent-candidate',
      parentHarnessRef: PARENT,
      parentHarnessDigest: SHA('b'),
    })),
    candidatePool: [winner, loser],
    failure: { phase: 'held-out-running', message: 'private later held-out failure' },
  }
}

function currentRound(snapshot: NonNullable<RefinementRound['experienceSnapshot']>): { round: RefinementRound; baseline: EvaluationEvidence } {
  const base = roundFixture({
    roundId: 'current-round',
    status: 'candidate-editing',
    advisoryFocus: ['tool'],
    experienceSnapshot: snapshot,
    targetHarnessRef: WINNER,
    targetHarnessDigest: SHA('c'),
  })
  const baseline = seedEvidence(base.plan.seed, WINNER, 'a', [
    { taskName: 'shared-failure', reward: 0, serial: 'a' },
  ])
  const candidateRecord: CandidateRecord = {
    candidateId: 'current-candidate',
    roundId: base.roundId,
    parentHarnessRef: WINNER,
    parentCandidateIds: ['winner-candidate'],
    workspaceId: 'workspace-current',
    status: 'generating',
  }
  return {
    round: {
      ...base,
      baseline,
      parentBaselines: [{ parentCandidateId: 'winner-candidate', parentHarnessRef: WINNER, evidence: baseline }],
      parentAllocations: [{
        candidateId: candidateRecord.candidateId,
        parentCandidateId: 'winner-candidate',
        parentHarnessRef: WINNER,
        parentHarnessDigest: SHA('c'),
      }],
      candidatePool: [candidateRecord],
    },
    baseline,
  }
}

function memorySpec() {
  return { ...evolutionSpec(), experienceMemory: { schemaVersion: 1 as const, enabled: true } }
}

describe('seed outcome experience memory', () => {
  it('uses actual candidate-vs-own-parent pairs and keeps mixed, partial, and invalid coverage seed-only', () => {
    const round = outcomeRound()
    const record = extractSeedExperienceRecord(memorySpec(), round, round.candidatePool[0]!)!
    expect(record.source).toMatchObject({
      parentHarnessRef: PARENT,
      candidateHarnessRef: WINNER,
      parentBaselineEvalId: round.parentBaselines![0]!.evidence.evalId,
    })
    expect(record.classification).toMatchObject({
      effect: 'mixed',
      coverage: 'partial',
      gainedTasks: ['shared-failure'],
      regressedTasks: ['mixed-loss'],
    })
    expect(record.observation).toMatchObject({
      planned: 3,
      valid: 2,
      excluded: 1,
      baselineInvalid: 1,
      candidateInvalid: 0,
      meanRewardDelta: 0.25,
      excludedTaskResults: [{ taskName: 'invalid-cell', reasons: ['baseline-invalid'] }],
    })
    expect(record.proposal.rationale).toContain('rationale')
    expect(JSON.stringify(record)).not.toContain('private later held-out failure')
    expect(JSON.stringify(record)).not.toContain('quality')

    const changed = structuredClone(round)
    changed.failure = { phase: 'held-out-running', message: 'a different private held-out message' }
    changed.candidatePool[0]!.metrics = { quality: 12345, taskSuccessRate: 1 }
    changed.candidatePool[0]!.status = 'discarded'
    expect(extractSeedExperienceRecord(memorySpec(), changed, changed.candidatePool[0]!)?.recordDigest)
      .toBe(record.recordDigest)
  })

  it('classifies no valid parent pairs as insufficient without inventing a zero outcome', () => {
    const round = outcomeRound()
    const baseline = seedEvidence(round.plan.seed, PARENT, 'f', [
      { taskName: 'unavailable', invalid: true, serial: 'e' },
    ])
    const evaluated = seedEvidence(round.plan.seed, LOSER, 'e', [
      { taskName: 'unavailable', invalid: true, serial: 'f' },
    ])
    const value = candidate(round, 'insufficient-candidate', LOSER, baseline, evaluated, 'failed', 'plugins/tool.ts', 'tool')
    const adjusted: RefinementRound = {
      ...round,
      parentBaselines: [{ parentCandidateId: 'parent-candidate', parentHarnessRef: PARENT, evidence: baseline }],
    }
    const record = extractSeedExperienceRecord(memorySpec(), adjusted, value)!
    expect(record.classification).toMatchObject({ effect: 'insufficient', coverage: 'none' })
    expect(record.observation).not.toHaveProperty('baselineMean')
    expect(record.observation).not.toHaveProperty('candidateMean')
    expect(record.observation).not.toHaveProperty('meanRewardDelta')
  })

  it('freezes losing revisions in round snapshots and preserves old content across held-out edits and seed reruns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    const source = outcomeRound()
    await store.writeRound(source)
    const first = await prepareSeedExperienceSnapshot(memorySpec(), store, 'future-round-1')
    const losingFirst = first.members.find(member => member.candidateId === 'losing-candidate')!
    expect(losingFirst).toBeDefined()
    expect((await store.readExperienceRecord(losingFirst.recordDigest))?.classification.effect).toBe('regressed')

    const heldOutOnly = structuredClone(source)
    heldOutOnly.failure = { phase: 'held-out-running', message: 'changed after seed persistence' }
    await store.writeRound(heldOutOnly)
    const heldOutSnapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'future-round-held-out')
    expect(heldOutSnapshot.digest).toBe(first.digest)

    const rerun = structuredClone(source)
    const losing = rerun.candidatePool.find(item => item.candidateId === 'losing-candidate')!
    const rerunSeed = seedEvidence(rerun.plan.seed, LOSER, '0', [
      { taskName: 'shared-failure', reward: 1, serial: '0' },
      { taskName: 'mixed-loss', reward: 1, serial: 'b' },
      { taskName: 'invalid-cell', reward: 1, serial: 'c' },
    ])
    losing.seedEvaluation = rerunSeed
    const pairs = paired(rerun.plan.seed, rerun.parentBaselines![0]!.evidence, rerunSeed)
    losing.seedComparison = {
      parentBaselineEvalId: rerun.parentBaselines![0]!.evidence.evalId,
      pairedTrials: pairs,
      pairing: { planned: 3, paired: 2, excluded: 1, baselineInvalid: 1, candidateInvalid: 0 },
      scoreDelta: 0.5,
      requiredRegressions: 0,
    }
    await store.writeRound(rerun)
    const second = await prepareSeedExperienceSnapshot(memorySpec(), store, 'future-round-2')
    const losingSecond = second.members.find(member => member.candidateId === 'losing-candidate')!
    expect(losingSecond.recordId).toBe(losingFirst.recordId)
    expect(losingSecond.recordDigest).not.toBe(losingFirst.recordDigest)
    expect((await store.readExperienceRecord(losingFirst.recordDigest))?.classification.effect).toBe('regressed')
    expect((await store.readExperienceRecord(losingSecond.recordDigest))?.classification.effect).toBe('improved')
  })

  it('enriches one shared historical scan and reuses complete frozen use evidence without IO', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-use-snapshot-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    await store.writeRound(outcomeRound())
    const contents = new Map([
      [`${WINNER}:plugins/context.ts`, 'winner context'],
      [`${LOSER}:plugins/tool.ts`, 'loser tool'],
    ])
    const artifact = (path: string, marker: string, content?: string) => ({
      path,
      digest: SHA(marker),
      bytes: Buffer.byteLength(content ?? marker),
    })
    const manifests = new Map([
      [PARENT, {
        schemaVersion: 1 as const, dshBaseRef: 'dsh', toolchainRef: 'toolchain', sandboxProfileRef: 'sandbox',
        artifacts: [artifact('plugins/context.ts', '1'), artifact('plugins/tool.ts', '2')], digest: SHA('a'),
      }],
      [WINNER, {
        schemaVersion: 1 as const, dshBaseRef: 'dsh', toolchainRef: 'toolchain', sandboxProfileRef: 'sandbox',
        artifacts: [artifact('plugins/context.ts', '3', 'winner context'), artifact('plugins/tool.ts', '2')], digest: SHA('b'),
      }],
      [LOSER, {
        schemaVersion: 1 as const, dshBaseRef: 'dsh', toolchainRef: 'toolchain', sandboxProfileRef: 'sandbox',
        artifacts: [artifact('plugins/context.ts', '1'), artifact('plugins/tool.ts', '4', 'loser tool')], digest: SHA('c'),
      }],
    ])
    const artifactReader = {
      readManifest: vi.fn(async (ref: string) => manifests.get(ref)!),
      readHarnessFile: vi.fn(async (ref: string, path: string) => {
        const content = contents.get(`${ref}:${path}`)!
        const entry = manifests.get(ref)!.artifacts.find(item => item.path === path)!
        return { content, digest: entry.digest, bytes: entry.bytes }
      }),
    }
    const usageReader = {
      readRuns: vi.fn(async (runIds: readonly string[]) => new Map(runIds.map(runId => {
        const winner = ['4', '5', '6'].includes(runId.slice(4, 5))
        const path = winner ? 'plugins/context.ts' : 'plugins/tool.ts'
        const content = winner ? 'winner context' : 'loser tool'
        const callId = `call-${runId}`
        return [runId, { available: true as const, trace: {
          schemaVersion: 1 as const,
          kind: 'dsh-native-events' as const,
          runId,
          trajectoryManifestDigest: SHA('d'),
          listedFiles: 1,
          mainSessionFiles: 1,
          childSessionFiles: 0,
          coverage: 'listed-files-complete' as const,
          files: [{
            sourcePath: 'trajectory/provider/deepseek-session.jsonl',
            sourceDigest: SHA('e'),
            bytes: 10,
            sessionId: 'session-main',
            delegationDepth: 0,
            events: [
              { type: 'tool/call', seq: 1, data: { callId, name: 'read', arguments: { path } } },
              { type: 'tool/result', seq: 2, data: { message: {
                source: { kind: 'tool', callId },
                content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: content }] }],
              } } },
            ],
          }],
        } }]
      }))),
    }
    const first = await prepareSeedExperienceSnapshot(memorySpec(), store, 'first-future', {
      artifactReader,
      usageReader,
    })
    expect(usageReader.readRuns).toHaveBeenCalledTimes(1)
    expect(usageReader.readRuns.mock.calls[0]![0]).toHaveLength(6)
    for (const member of first.members) {
      expect((await store.readExperienceRecord(member.recordDigest))?.observation.modificationUse?.statusCounts.observed).toBe(3)
    }

    const prior = currentRound(first).round
    await store.writeRound(prior)
    const unavailableArtifacts = {
      readManifest: vi.fn(async () => { throw new Error('must reuse') }),
      readHarnessFile: vi.fn(async () => { throw new Error('must reuse') }),
    }
    const unavailableUsage = { readRuns: vi.fn(async () => { throw new Error('must reuse') }) }
    const second = await prepareSeedExperienceSnapshot(memorySpec(), store, 'second-future', {
      artifactReader: unavailableArtifacts,
      usageReader: unavailableUsage,
    })
    expect(second).toEqual(first)
    expect(unavailableArtifacts.readManifest).not.toHaveBeenCalled()
    expect(unavailableUsage.readRuns).not.toHaveBeenCalled()
  })

  it('injects the direct parent plus only relevant losing cards under the hard assignment cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-context-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    const history = outcomeRound('x'.repeat(100_000))
    const baseline = history.parentBaselines![0]!.evidence
    for (const [index, serial] of ['e', 'f'].entries()) {
      const commit = serial.repeat(40)
      const evaluation = seedEvidence(history.plan.seed, commit, serial, [
        { taskName: 'shared-failure', reward: 0, serial },
        { taskName: 'mixed-loss', reward: 0, serial: String(index + 4) },
        { taskName: 'invalid-cell', reward: 1, serial: String(index + 6) },
      ])
      const extra = candidate(
        history, `losing-extra-${index}`, commit, baseline, evaluation, 'discarded',
        `plugins/extra-${index}.ts`, 'tool',
      )
      history.candidatePool.push(extra)
      history.parentAllocations!.push({
        candidateId: extra.candidateId,
        parentCandidateId: 'parent-candidate',
        parentHarnessRef: PARENT,
        parentHarnessDigest: SHA('b'),
      })
    }
    await store.writeRound(history)
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    const left = await buildSeedExperienceContext(store, current.round, current.round.candidatePool[0]!, current.baseline)
    const right = await buildSeedExperienceContext(store, current.round, {
      ...current.round.candidatePool[0]!, candidateId: 'sibling', workspaceId: 'workspace-sibling',
    }, current.baseline)
    expect(left?.snapshotDigest).toBe(snapshot.digest)
    expect(right?.snapshotDigest).toBe(snapshot.digest)
    expect(left?.directParent?.source.candidateId).toBe('winner-candidate')
    expect(left?.relevantCards).toHaveLength(2)
    expect(1 + left!.relevantCards.length).toBe(3)
    expect(left?.relevantCards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effect: 'regressed',
        matchReasons: expect.arrayContaining(['current failed task: shared-failure', 'advisory semantic target: tool']),
      }),
    ]))
    expect(Buffer.byteLength(left!.directParent!.markdown)).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_CARD_BYTES)
    expect(Buffer.byteLength(JSON.stringify(left))).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES)

    const unrelatedBaseline = seedEvidence(current.round.plan.seed, WINNER, 'd', [
      { taskName: 'never-seen-task', reward: 0, serial: 'd' },
    ])
    const { advisoryFocus: _advisoryFocus, ...unrelatedRound } = current.round
    const unrelated = await buildSeedExperienceContext(store, unrelatedRound, unrelatedRound.candidatePool[0]!, unrelatedBaseline)
    expect(unrelated?.relevantCards).toEqual([])
  })

  it('fails assignment and frozen query pagination when a sealed snapshot record becomes unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-incomplete-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    await store.writeRound(outcomeRound())
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    await store.writeRound(current.round)
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', spec: memorySpec(), roundId: current.round.roundId, store,
      meta: {}, workspace: { workspaceId: 'workspace-current' },
      parentHarnessRef: WINNER, parentHarnessDigest: SHA('c'), baseline: current.baseline,
    }) }
    const capabilities = new RefineCapabilities(service as never, {} as never)
    const first = await capabilities.call('refine-meta', 'meta', 'experience.query', { limit: 1 }) as {
      nextCursor: string
    }
    expect(first.nextCursor).toMatch(/^experience_cursor_/u)

    const missing = snapshot.members[1]!
    await writeFile(join(store.experienceRecordsPath, `${missing.recordDigest.slice('sha256:'.length)}.json`), '{"corrupt":true}\n')
    await expect(buildSeedExperienceContext(
      store, current.round, current.round.candidatePool[0]!, current.baseline,
    )).rejects.toThrow(new RegExp(`incomplete.*${missing.recordId}`, 'u'))
    await expect(capabilities.call('refine-meta', 'meta', 'experience.query', { cursor: first.nextCursor }))
      .rejects.toThrow(new RegExp(`incomplete.*${missing.recordId}`, 'u'))
  })

  it('does not publish a lease when an experience-backed wake is cancelled during snapshot reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-cancelled-wake-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    await store.writeRound(outcomeRound())
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    const coordinator = new SkillMetaCoordinator()
    const manager = new SkillMetaSessionManager(store, coordinator, {
      evolutionId: 'evo-1',
      specDigest: digestJson(memorySpec()),
      metaAgent: {
        runtime: { type: 'codex', version: 'test', integrity: SHA('1') },
        preset: { id: 'refine', digest: SHA('2'), resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: SHA('2') }] },
        model: { provider: 'openai', model: 'gpt-test' },
        sampling: {},
      },
    })
    const child = await manager.fork(await manager.checkpoint((await manager.agent()).id))
    const originalRead = store.readExperienceRecord.bind(store)
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
    vi.spyOn(store, 'readExperienceRecord').mockImplementation(async digest => {
      markReadStarted()
      await readReleased
      return originalRead(digest)
    })

    const wake = manager.wakeCandidate(current.round, current.round.candidatePool[0], current.baseline, child)
    await readStarted
    await manager.cancel(child.id, 'generation attempt expired')
    releaseRead()

    await expect(wake).rejects.toThrow(/cancelled before publication/u)
    expect(coordinator.pending()).toEqual([])
  })

  it('binds query/read/cursors to the claimed lease snapshot and historical reads do not satisfy diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-api-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    await store.writeRound(outcomeRound())
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    await store.writeRound(current.round)

    const identity: SkillHarnessIdentity = {
      runtime: { type: 'codex', version: 'test', integrity: SHA('1') },
      preset: { id: 'refine', digest: SHA('2') },
      model: { provider: 'openai', model: 'gpt-test' },
      sampling: {},
    }
    const metaAgent = {
      runtime: identity.runtime,
      preset: { ...identity.preset, resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: identity.preset.digest }] },
      model: identity.model,
      sampling: {},
    }
    const coordinator = new SkillMetaCoordinator()
    const manager = new SkillMetaSessionManager(store, coordinator, {
      evolutionId: 'evo-1', specDigest: digestJson(memorySpec()), metaAgent,
    })
    const child = await manager.fork(await manager.checkpoint((await manager.agent()).id))
    await manager.wakeCandidate(current.round, current.round.candidatePool[0], current.baseline, child)
    const claim = coordinator.claim('client-1', identity, 'evo-1')!
    expect(claim.experienceContext).toMatchObject({
      snapshotDigest: snapshot.digest,
      directParent: { source: { candidateId: 'winner-candidate' } },
      relevantCards: [{ source: { candidateId: 'losing-candidate' } }],
    })

    const omittedMarker = 'HISTORICAL_MARKER_BEYOND_32K'
    const tailMarker = 'FINAL_FAILURE_TAIL_MARKER'
    const longTranscript = `${'a'.repeat(40 * 1024)}${omittedMarker}${'b'.repeat(24 * 1024)}${tailMarker}`
    let longRunId: string | undefined
    const reader: HitchTrajectoryReader = {
      async inspectCapabilities() { return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 } },
      async inspectTrajectoryAnalysis(runId) {
        const analysis = trajectoryAnalysis(runId, [{
          type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
          data: { role: 'user', id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'seed task prompt' }] },
        }])
        if (runId === longRunId) analysis.surface.nodes[0]!.message = {
          preview: longTranscript,
          bytes: Buffer.byteLength(longTranscript),
          sha256: SHA('8'),
          truncated: false,
          source: { runId, seq: 0, field: 'data' },
        }
        return analysis
      },
      async inspectTrajectoryEvents(runId, query, signal) {
        return trajectoryEventsPage(await this.inspectTrajectoryAnalysis(runId, signal), query)
      },
    }
    const spec = memorySpec()
    const service = {
      activeEntryForSession: (sessionId: string) => sessionId !== child.id ? undefined : ({
        evolutionId: 'evo-1', spec, roundId: current.round.roundId, store, meta: manager,
        workspace: { workspaceId: 'workspace-current', parentRef: WINNER, parentDigest: SHA('c') },
        parentHarnessRef: WINNER, parentHarnessDigest: SHA('c'), baseline: current.baseline,
      }),
    }
    const builder = {
      readHarnessDiff: vi.fn(async () => ({
        parentRef: PARENT, candidateRef: LOSER, paths: ['plugins/tool.ts'],
        patch: 'bounded historical patch', patchBytes: 24, contentDigest: SHA('f'), truncated: false,
      })),
    }
    const capabilities = new RefineCapabilities(service as never, builder as never, { trajectoryReader: reader })
    const gateway = new RefineSkillGateway(service as never, coordinator, capabilities, {} as never)
    const lease = { clientId: 'client-1', leaseId: claim.leaseId, leaseToken: claim.leaseToken }
    const first = await gateway.call('meta.call', {
      ...lease, capability: 'experience.query', arguments: { limit: 1 },
    }) as { results: Array<{ experienceRef: string }>; nextCursor: string }
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_QUERY_BYTES)
    expect(first.nextCursor).toMatch(/^experience_cursor_/u)
    await expect(gateway.call('meta.call', {
      ...lease, capability: 'experience.query', arguments: { cursor: 'experience_cursor_forged' },
    })).rejects.toThrow(/cursor.*unknown|unknown.*cursor/u)
    await expect(gateway.call('meta.call', {
      ...lease, capability: 'experience.query', arguments: { cursor: first.nextCursor },
    })).resolves.toMatchObject({ results: [expect.any(Object)] })
    await expect(gateway.call('meta.call', {
      ...lease, capability: 'experience.read', arguments: {
        ref: `experience_${'0'.repeat(64)}`, view: 'record',
      },
    })).rejects.toThrow(/not authorized/u)

    const losingRef = claim.experienceContext!.relevantCards[0]!.experienceRef
    await expect(gateway.call('meta.call', {
      ...lease, capability: 'experience.read', arguments: { ref: losingRef, view: 'task-results', limit: 1 },
    })).resolves.toMatchObject({
      available: true,
      snapshotDigest: snapshot.digest,
      results: [expect.objectContaining({ taskName: expect.any(String) })],
      nextOffset: expect.any(Number),
    })
    const losingRecord = await store.readExperienceRecord(snapshot.members.find(member => member.candidateId === 'losing-candidate')!.recordDigest)
    const historicalRun = losingRecord!.observation.taskResults[0]!.candidate.runId!
    longRunId = historicalRun
    const historical = await gateway.call('meta.call', {
      ...lease, capability: 'experience.read', arguments: {
        ref: losingRef, view: 'trajectory', runId: historicalRun,
      },
    }) as {
      available: true
      runId: string
      card: { runId: string; transcript: { text: string; earlierRef: string } }
    }
    expect(historical).toMatchObject({ available: true, runId: historicalRun, card: { runId: historicalRun } })
    expect(historical.card.transcript.text).toContain(tailMarker)
    expect(historical.card.transcript.earlierRef).toMatch(/^detail_/u)
    await expect(gateway.call('meta.call', {
      ...lease, capability: 'experience.read', arguments: {
        ref: losingRef, view: 'trajectory', detailRef: historical.card.transcript.earlierRef, find: omittedMarker,
      },
    })).resolves.toMatchObject({
      available: true,
      runId: historicalRun,
      detail: { matches: [expect.stringContaining(omittedMarker)] },
    })
    expect(manager.proposalEvidenceAudit(current.round.roundId, child.id, []).diagnosedRunRefs).toEqual([])

    const currentFailedRun = current.baseline.trials[0]!.runId!
    await capabilities.call('refine-meta', child.id, 'trajectory.query', { refs: [currentFailedRun] })
    expect(manager.proposalEvidenceAudit(current.round.roundId, child.id, []).diagnosedRunRefs).toEqual([currentFailedRun])
    await expect(gateway.call('meta.call', {
      clientId: 'client-2', leaseId: claim.leaseId, leaseToken: claim.leaseToken,
      capability: 'experience.query', arguments: {},
    })).rejects.toThrow(/lease/u)
  })

  it('sanitizes and re-budgets automatic experience cards before the real skill claim boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-claim-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    const secret = 'zz'
    const source = outcomeRound()
    const heldOut = source.heldOutRef
    for (const item of source.candidatePool) {
      if (item.proposal !== undefined) {
        item.proposal.rationale += ` ${heldOut} ${secret.repeat(800)}`
        item.proposal.expectedOutcome += ` ${heldOut} ${secret.repeat(800)}`
      }
    }
    await store.writeRound(source)
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    const identity: SkillHarnessIdentity = {
      runtime: { type: 'codex', version: 'test', integrity: SHA('1') },
      preset: { id: 'refine', digest: SHA('2') },
      model: { provider: 'openai', model: 'gpt-test' },
      sampling: {},
    }
    const coordinator = new SkillMetaCoordinator()
    const manager = new SkillMetaSessionManager(store, coordinator, {
      evolutionId: 'evo-1',
      specDigest: digestJson(memorySpec()),
      metaAgent: {
        runtime: identity.runtime,
        preset: { ...identity.preset, resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: identity.preset.digest }] },
        model: identity.model,
        sampling: {},
      },
    }, [secret])
    const child = await manager.fork(await manager.checkpoint((await manager.agent()).id))
    await manager.wakeCandidate(current.round, current.round.candidatePool[0], current.baseline, child)
    const claim = coordinator.claim('client', identity, 'evo-1')!
    const serialized = JSON.stringify(claim.experienceContext)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(heldOut)
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('[REDACTED_HELD_OUT]')
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_ASSIGNMENT_BYTES)
    const cards = [claim.experienceContext!.directParent!, ...claim.experienceContext!.relevantCards]
    expect(cards).toHaveLength(2)
    expect(cards.every(card => Buffer.byteLength(card.markdown) <= EXPERIENCE_V1_MAX_CARD_BYTES)).toBe(true)
  })

  it('sanitizes every public experience field and budgets adversarial diff JSON and history detail pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-boundary-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    const secret = 'configured-secret-needle'
    const original = outcomeRound()
    const heldOut = original.heldOutRef
    const source = JSON.parse(JSON.stringify(original)
      .split('shared-failure').join(`shared-${secret}-${heldOut}`)
      .split('mixed-loss').join(`mixed-${secret}-${heldOut}`)) as RefinementRound
    for (const item of source.candidatePool) {
      if (item.proposal !== undefined) {
        item.proposal.rationale += ` ${secret} ${heldOut}`
        item.proposal.expectedOutcome += ` ${secret} ${heldOut}`
      }
    }
    const losing = source.candidatePool.find(item => item.candidateId === 'losing-candidate')!
    losing.proposal!.rationale += 'r'.repeat(20 * 1024)
    losing.proposal!.expectedOutcome += 'e'.repeat(20 * 1024)
    losing.diff!.files = Array.from({ length: 80 }, (_, index) => ({
      path: `plugins/"quoted-${index}-${secret}-${heldOut}-${'q'.repeat(410)}.ts`,
      change: 'modified' as const,
      additions: 1,
      deletions: 1,
    }))
    losing.diff!.totalBytes = 100_000
    await store.writeRound(source)
    const snapshot = await prepareSeedExperienceSnapshot(memorySpec(), store, 'current-round')
    const current = currentRound(snapshot)
    await store.writeRound(current.round)
    const member = snapshot.members.find(item => item.candidateId === losing.candidateId)!
    const record = (await store.readExperienceRecord(member.recordDigest))!
    const artifacts = record.change.files.map((file, index) => ({
      identity: { path: file.path, change: file.change, candidateDigest: SHA((index % 10).toString()) },
      candidateContent: `content-${index}`,
    }))
    const useReads = new Map<string, ExperienceUsageReadResult>()
    for (const row of [...record.observation.taskResults, ...record.observation.excludedTaskResults]) {
      const runId = row.candidate.runId
      if (runId === undefined) continue
      const events = artifacts.flatMap((artifact, index) => {
        const callId = `call-${index}-${secret}`
        return [
          { type: 'tool/call', seq: index * 2 + 1, data: { callId, name: 'read', arguments: { path: artifact.identity.path } } },
          { type: 'tool/result', seq: index * 2 + 2, data: { message: {
            source: { kind: 'tool', callId },
            content: [{
              type: 'tool-result', toolCallId: callId, isError: false,
              content: [{ type: 'text', text: artifact.candidateContent }],
            }],
          } } },
        ]
      })
      useReads.set(runId, { available: true, trace: {
        schemaVersion: 1,
        kind: 'dsh-native-events',
        runId,
        trajectoryManifestDigest: SHA('8'),
        listedFiles: 1,
        mainSessionFiles: 1,
        childSessionFiles: 0,
        coverage: 'listed-files-complete',
        files: [{
          sourcePath: `trajectory/provider/${secret}-${heldOut}.jsonl`,
          sourceDigest: SHA('9'),
          bytes: 100,
          sessionId: 'session-main',
          delegationDepth: 0,
          events: events as never,
        }],
      } })
    }
    const enriched = enrichSeedExperienceUse(record, artifacts, useReads)
    await store.writeExperienceRecord(enriched)
    member.recordDigest = enriched.recordDigest
    snapshot.digest = digestJson({ schemaVersion: snapshot.schemaVersion, members: snapshot.members })
    current.round.experienceSnapshot = snapshot
    await store.writeRound(current.round)
    const ref = `experience_${member.recordDigest.slice('sha256:'.length)}`
    const historicalRun = enriched.observation.taskResults[0]!.candidate.runId!
    const historyMarker = 'HISTORY_DETAIL_MARKER'
    const tailMarker = 'HISTORY_FAILURE_TAIL'
    const longTranscript = `${'x'.repeat(20 * 1024)}${historyMarker}-${secret}-${heldOut}${'y'.repeat(20 * 1024)}${tailMarker}`
    const analysis = trajectoryAnalysis(historicalRun, [{
      type: 'user/message', time: 1, surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'placeholder' }] },
    }])
    analysis.surface.nodes[0]!.message = {
      preview: longTranscript,
      bytes: Buffer.byteLength(longTranscript),
      sha256: SHA('9'),
      truncated: false,
      source: { runId: historicalRun, seq: 0, field: 'data' },
    }
    const reader: HitchTrajectoryReader = {
      async inspectCapabilities() { return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 } },
      async inspectTrajectoryAnalysis(runId) {
        if (runId !== historicalRun) throw new Error('unexpected historical run')
        return analysis
      },
      async inspectTrajectoryEvents(runId, query) {
        if (runId !== historicalRun) throw new Error('unexpected historical run')
        return trajectoryEventsPage(analysis, query)
      },
    }
    const adversarialPatch = (`"\\${secret}${heldOut}\n`).repeat(10_000)
    const builder = {
      readHarnessDiff: vi.fn(async (parentRef: string, candidateRef: string, paths: readonly string[]) => ({
        parentRef,
        candidateRef,
        paths: [...paths],
        patch: adversarialPatch,
        patchBytes: Buffer.byteLength(adversarialPatch),
        contentDigest: SHA('7'),
        truncated: false,
      })),
    }
    const recordEvidenceAccess = vi.fn()
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', spec: memorySpec(), roundId: current.round.roundId, store,
      meta: { recordEvidenceAccess }, workspace: { workspaceId: 'workspace-current' },
      parentHarnessRef: WINNER, parentHarnessDigest: SHA('c'), baseline: current.baseline,
    }) }
    const capabilities = new RefineCapabilities(service as never, builder as never, {
      trajectoryReader: reader,
      secretValues: [secret],
    })
    const assertPublic = (value: unknown): string => {
      const serialized = JSON.stringify(value)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(heldOut)
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_READ_BYTES)
      return serialized
    }

    const query = await capabilities.call('refine-meta', 'meta', 'experience.query', { limit: 10 })
    expect(assertPublic(query)).toContain('[REDACTED]')
    const visibleRecord = await capabilities.call('refine-meta', 'meta', 'experience.read', {
      ref, view: 'record', limit: 50,
    }) as { record: { classification: { regressedTasks: string[] }; change: { files: unknown[] } }; nextOffset: number }
    expect(assertPublic(visibleRecord)).toContain('[REDACTED_HELD_OUT]')
    expect(visibleRecord.record.classification.regressedTasks[0]).toContain('[REDACTED]')
    expect(visibleRecord.record.change.files.length).toBeGreaterThan(0)
    expect(visibleRecord.record.change.files.length).toBeLessThan(50)
    expect(visibleRecord.nextOffset).toBe(visibleRecord.record.change.files.length)
    const taskResults = await capabilities.call('refine-meta', 'meta', 'experience.read', {
      ref, view: 'task-results', limit: 50,
    }) as { results: Array<{ trialKey: string; candidate: { modificationUse: {
      artifactCount: number
      artifacts: Array<{ observedActionCount: number; actionExamplesOmitted?: number }>
      artifactsOmitted: number
    } } }> }
    assertPublic(taskResults)
    expect(taskResults.results.some(item => item.trialKey.includes('[REDACTED]'))).toBe(true)
    expect(taskResults.results[0]!.candidate.modificationUse).toMatchObject({
      artifactCount: 80,
      artifactsOmitted: 68,
    })
    expect(taskResults.results[0]!.candidate.modificationUse.artifacts
      .reduce((sum, artifact) => sum + (artifact.actionExamplesOmitted ?? 0), 0)).toBeGreaterThan(0)

    const firstDiff = await capabilities.call('refine-meta', 'meta', 'experience.read', {
      ref, view: 'diff', limit: 50,
    }) as { change: { files: unknown[] }; diff: { paths: string[]; patch: string; truncated: boolean }; nextOffset: number }
    assertPublic(firstDiff)
    expect(firstDiff.change.files).toHaveLength(50)
    expect(firstDiff.diff.paths).toHaveLength(50)
    expect(firstDiff.diff.truncated).toBe(true)
    expect(firstDiff.nextOffset).toBe(50)
    const secondDiff = await capabilities.call('refine-meta', 'meta', 'experience.read', {
      ref, view: 'diff', offset: firstDiff.nextOffset, limit: 50,
    }) as { change: { files: unknown[] }; diff: { paths: string[] } }
    assertPublic(secondDiff)
    expect(secondDiff.change.files).toHaveLength(30)
    expect(secondDiff.diff.paths).toHaveLength(30)

    const history = await capabilities.call('refine-meta', 'meta', 'experience.read', {
      ref, view: 'trajectory', runId: historicalRun,
    }) as { card: { transcript: { text: string; earlierRef: string } } }
    assertPublic(history)
    expect(history.card.transcript.text).toContain(tailMarker)
    let detailRef: string | undefined = history.card.transcript.earlierRef
    let recovered = ''
    while (detailRef !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'experience.read', {
        ref, view: 'trajectory', detailRef,
      }) as { detail: { text: string }; nextRef?: string }
      assertPublic(page)
      recovered += page.detail.text
      detailRef = page.nextRef
    }
    expect(recovered).toContain(historyMarker)
    expect(recovered).toContain('[REDACTED]')
    expect(recovered).toContain('[REDACTED_HELD_OUT]')
    expect(recordEvidenceAccess).not.toHaveBeenCalled()
  })

  it('keeps legacy evolutions disabled and validates fixed query/snapshot bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-legacy-'))
    roots.push(root)
    const store = new RefineStateStore(root, 'evo-1')
    await store.initialize()
    const round = currentRound({ schemaVersion: 1, members: [], digest: digestJson({ schemaVersion: 1, members: [] }) }).round
    const legacy = evolutionSpec()
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', spec: legacy, roundId: round.roundId, store,
      meta: {}, workspace: { workspaceId: 'workspace' }, baseline: round.baseline,
    }) }
    const capabilities = new RefineCapabilities(service as never, {} as never)
    await expect(capabilities.call('refine-meta', 'meta', 'experience.query', {})).rejects.toThrow(/not enabled/u)

    const oversized = {
      ...round,
      experienceSnapshot: {
        schemaVersion: 1 as const,
        members: Array.from({ length: 4_097 }, (_, index) => ({
          recordId: `record-${index}`,
          recordDigest: SHA(index.toString(16)),
          sourceRoundId: `source-${index}`,
          candidateId: `candidate-${index}`,
          candidateHarnessRef: 'f'.repeat(40),
        })),
        digest: SHA('1'),
      },
    }
    await expect(store.writeRound(oversized)).rejects.toThrow(/snapshot is invalid/u)
    const longRound = outcomeRound('z'.repeat(100_000))
    const longRecord = extractSeedExperienceRecord(memorySpec(), longRound, longRound.candidatePool[0]!)!
    longRecord.change.files[0]!.path = `plugins/${'p'.repeat(100_000)}.ts`
    const markdown = renderSeedExperienceCard(longRecord).markdown
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(EXPERIENCE_V1_MAX_CARD_BYTES)
    expect(markdown).toContain('mean paired reward delta 0.250000')
    expect(markdown).toContain('regressions: mixed-loss')
  })
})
