import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineService } from '../../src/refine/service.js'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import type { EvaluationPhase, EvaluationRequest, HitchEvaluationEvidence, MetaAttribution, RefineEvaluator, RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { builtinComponentRef } from '../../src/evolution/components.js'
import { evolutionSpec } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakeMeta {
  wakes: string[] = []
  constructor(private readonly evolutionId: string, private readonly store: import('../../src/state/store.js').RefineStateStore, private readonly specDigest: string) {}
  async agent() {
    await this.store.writeMeta({ evolutionId: this.evolutionId, sessionId: `meta-${this.evolutionId}`, metaHarnessRef: 'meta-v1', specDigest: this.specDigest })
    return { id: `meta-${this.evolutionId}` }
  }
  async wake(round: Readonly<RefinementRound>): Promise<string> { this.wakes.push(round.roundId); return `meta-${this.evolutionId}` }
  async dispose(): Promise<void> {}
}

class FakeEvaluator implements RefineEvaluator {
  calls: EvaluationPhase[] = []
  constructor(
    private readonly candidateScore = 0.8,
    private readonly heldOutDelta = 0,
    private readonly mismatchSeedCondition = false,
  ) {}
  async evaluate(_round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): Promise<HitchEvaluationEvidence> {
    this.calls.push(request.phase)
    const baseline = request.phase.endsWith('baseline')
    const heldOut = request.phase.startsWith('held-out')
    const score = heldOut ? (baseline ? 0.6 : 0.6 + this.heldOutDelta) : (baseline ? 0.5 : this.candidateScore)
    const passed = Math.round(score * 10)
    const serial = this.calls.length.toString(16).padStart(32, '0')
    return {
      provider: 'fake',
      conditionId: this.mismatchSeedCondition && request.phase === 'seed-candidate'
        ? `sha256:${'f'.repeat(64)}` : request.condition.conditionId,
      effectiveConfigDigest: request.condition.rolloutProviderDigest,
      evalId: `eval_${serial}`, dataset: request.dataset,
      requestedCommit: request.harnessRef, actualCommit: request.harnessRef,
      revisionIdentity: `sha256:${serial.padEnd(64, '0')}`,
      invocationFingerprint: request.condition.rolloutProviderDigest,
      primaryReward: score, summary: { total: 10, passed, failed: 10 - passed, score },
      trials: Array.from({ length: 10 }, (_, index) => ({
        taskName: `task-${index}`, trialName: `${request.phase}-trial-${index}`, attempt: 1,
        runId: `run_${`${serial}${index}`.slice(-32).padStart(32, '0')}`,
        status: 'completed' as const, rewards: { reward: index < passed ? 1 : 0 },
      })),
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${serial.padEnd(64, '0')}`,
        commit: request.harnessRef, tree: 'f'.repeat(40), payloadSha256: `sha256:${'1'.repeat(64)}`, payloadBytes: 1,
      },
    }
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  } while (Date.now() < deadline)
  throw new Error('condition not reached')
}

async function setup(
  candidateScore = 0.8,
  mismatchSeedCondition = false,
  maxCandidates = 1,
  generationTimeoutMs = 300_000,
) {
  const git = await createGitHarnessFixture()
  roots.push(git.root)
  const registry = new EvolutionRegistryStore(join(git.root, 'state'))
  const builder = new HarnessBuilder({
    repositoryPath: git.repository, targetRoot: git.targetRoot, dshBaseRef: git.baseRef,
    toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
  })
  const workspaces = new CandidateWorkspaceManager({
    repositoryPath: git.repository, targetRoot: git.targetRoot,
    rootForEvolution: id => join(registry.evolutionRoot(id), 'candidate-worktrees'),
    maxFiles: 64, maxBytes: 2_000_000, maxDiffBytes: 1_000_000,
  })
  const evaluator = new FakeEvaluator(candidateScore, 0, mismatchSeedCondition)
  const defaults = evolutionSpec()
  const promotionPolicy = {
    minimumCandidateScore: 0.7, minimumAbsoluteGain: 0.1, requireNoRegression: true,
    maxHeldOutRegression: 0, maxRequiredRegressions: 0,
  }
  const metas = new Map<string, FakeMeta>()
  const service = new RefineService(registry, builder, workspaces, (spec, digest, store) => {
    const meta = new FakeMeta(spec.evolutionId, store, digest)
    metas.set(spec.evolutionId, meta)
    return meta as never
  }, evaluator, {
    workspaceRoot: git.root, metaAgent: defaults.metaAgent,
    candidateGeneration: {
      ...defaults.candidateGeneration,
      maxCandidates,
      budget: { ...defaults.candidateGeneration.budget, timeoutMs: generationTimeoutMs },
    },
    rollout: defaults.rollout,
    evaluation: defaults.evaluation, selection: defaults.selection,
    toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', promotionPolicy) },
    seedTaskRef: 'seed', heldOutRef: 'held-out', taskBudgetMs: 60_000,
    initialChampion: { schemaVersion: 2, ref: git.championRef, manifestDigest: git.manifest.digest, updatedAt: 'initial' },
    publishedPointer: true, maxLiveMetaSessions: 4,
  })
  await builder.initialize()
  await service.initialize()
  return { git, registry, service, evaluator, metas }
}

async function editing(service: RefineService, evolutionId: string, roundId: string): Promise<RefinementRound> {
  const store = service.registry.stateStore(evolutionId)
  return eventually(() => store.readRound(roundId) as Promise<RefinementRound>, round => round?.status === 'candidate-editing')
}

async function finalize(service: RefineService, round: RefinementRound): Promise<void> {
  const active = service.activeEntry(round.roundId)
  if (active?.workspace === undefined || round.baseline === undefined) throw new Error('round is not editable')
  await eventually(() => active.store.readMeta(), value => value?.sessionId === `meta-${round.evolutionId}`)
  await eventually(async () => {
    try { return service.workspaceManager.resolve(`meta-${round.evolutionId}`).workspaceId }
    catch { return undefined }
  }, value => value === active.workspace!.workspaceId)
  await mkdir(join(active.workspace.targetPath, 'prompts'), { recursive: true })
  await writeFile(join(active.workspace.targetPath, 'prompts', `round-${round.roundIndex}.md`), 'improved context\n')
  const sessionId = `meta-${round.evolutionId}`
  const meta: MetaAttribution = { evolutionId: round.evolutionId, sessionId, requestHeaderSeq: 1, proposalEventSeq: 2 }
  const runRefs = round.baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId])
  const failed = round.baseline.trials.flatMap(trial => (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : [])
  await service.submitFinalization(round.evolutionId, round.roundId, {
    rationale: 'fix observed failures', expectedOutcome: 'higher reward', evidenceRefs: [round.baseline.evalId], semanticTargets: ['context', 'routing'],
  }, undefined, meta, {
    evolutionId: round.evolutionId, roundId: round.roundId, baselineEvalId: round.baseline.evalId,
    summaryAccessed: true, accessedRefs: [round.baseline.evalId, ...runRefs], diagnosedRunRefs: failed, citedRefs: [round.baseline.evalId],
  })
}

describe('RefineService evolution workspaces', () => {
  it('creates a fresh isolated evolution for every admission', async () => {
    const { service } = await setup()
    const first = await service.admit('api', { name: 'first' })
    const second = await service.admit('api', { name: 'second', focus: ['context', 'routing'] })
    expect(first.evolutionId).not.toBe(second.evolutionId)
    const [left, right] = await Promise.all([editing(service, first.evolutionId, first.roundId), editing(service, second.evolutionId, second.roundId)])
    expect(left.advisoryFocus).toBeUndefined()
    expect(right.advisoryFocus).toEqual(['context', 'routing'])
    expect(service.activeEntry(first.roundId)?.workspace?.worktreePath).not.toBe(service.activeEntry(second.roundId)?.workspace?.worktreePath)
    await service.dispose()
  })

  it('commits the sealed tree and promotes only its evolution champion', async () => {
    const { service, evaluator, git } = await setup()
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const store = service.registry.stateStore(admission.evolutionId)
    const terminal = await eventually(() => store.readRound(admission.roundId), value => value?.status === 'accepted')
    expect(terminal?.candidatePool[0]?.diff?.files).toContainEqual(expect.objectContaining({ path: 'prompts/round-1.md', change: 'created' }))
    expect(terminal?.candidatePool[0]?.sealedVersion).toMatchObject({
      commitOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
      treeOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    })
    expect((await store.readChampion())?.ref).not.toBe(git.championRef)
    expect(await store.readPopulation()).toMatchObject({
      generation: 1,
      members: [{
        candidateId: terminal?.promotedCandidateId,
        parentCandidateIds: [`initial-${git.championRef}`],
      }],
    })
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
    await service.dispose()
  })

  it('continues a multi-round batch with a fresh workspace and persistent evolution', async () => {
    const { service } = await setup()
    const admission = await service.admit('command', { rounds: 2, focus: ['workflow'] })
    const first = await editing(service, admission.evolutionId, admission.roundId)
    const active = service.activeEntry(first.roundId)!
    const sessionId = `meta-${first.evolutionId}`
    await eventually(() => active.store.readMeta(), value => value?.sessionId === sessionId)
    await eventually(async () => {
      try { return service.workspaceManager.resolve(sessionId).workspaceId }
      catch { return undefined }
    }, value => value === active.workspace?.workspaceId)
    const failed = first.baseline!.trials.flatMap(trial => (trial.rewards.reward ?? 0) <= 0 && trial.runId !== undefined ? [trial.runId] : [])
    await service.submitFinalization(first.evolutionId, first.roundId, null, {
      rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [],
    }, {
      evolutionId: first.evolutionId, sessionId, requestHeaderSeq: 1, proposalEventSeq: 2,
    }, {
      evolutionId: first.evolutionId, roundId: first.roundId, baselineEvalId: first.baseline!.evalId,
      summaryAccessed: true, accessedRefs: [first.baseline!.evalId, ...failed], diagnosedRunRefs: failed, citedRefs: [],
    })
    expect(active.workspace).toBeDefined()
    const store = service.registry.stateStore(admission.evolutionId)
    const second = await eventually(async () => (await store.listRounds()).find(value => value.roundIndex === 2), value => value?.status === 'candidate-editing')
    expect(await store.readRound(first.roundId)).toMatchObject({
      decision: 'no-change',
      decline: { rationale: 'No evidence-grounded improvement is safe this round.', evidenceRefs: [] },
    })
    expect(second).toMatchObject({ batchId: admission.batchId, advisoryFocus: ['workflow'], roundCount: 2 })
    expect(service.activeEntry(second!.roundId)?.workspace?.workspaceId).not.toBe(active.workspace?.workspaceId)
    await service.dispose()
  })

  it('continues from the immutable EvolutionSpec after global defaults change', async () => {
    const { service } = await setup()
    const admission = await service.admit('api')
    const first = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, first)
    await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    service.options.metaAgent.preset.id = 'changed-global-preset'
    service.options.rollout.model = 'changed-global-model'
    const continued = await service.continueEvolution('api', admission.evolutionId)
    const second = await editing(service, admission.evolutionId, continued.roundId)
    expect(second.metaHarnessRef).toBe('meta-v1')
    expect(second.plan.seed.model).toBe('deepseek-chat')
    await service.dispose()
  })

  it('revalidates the resolved Meta runtime before every continue', async () => {
    const { service } = await setup()
    const admission = await service.admit('api')
    const first = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, first)
    await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'accepted',
    )
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    service.options.validateRuntime = async () => { throw new Error('preset digest mismatch') }
    await expect(service.continueEvolution('api', admission.evolutionId)).rejects.toThrow(/preset digest mismatch/)
    await service.dispose()
  })

  it('rejects below the seed gate without spending held-out evaluations', async () => {
    const { service, evaluator } = await setup(0.55)
    const admission = await service.admit('api')
    const round = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, round)
    const store = service.registry.stateStore(admission.evolutionId)
    await eventually(() => store.readRound(admission.roundId), value => value?.status === 'rejected')
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    await service.dispose()
  })

  it('fails closed when baseline and candidate do not share the same evaluation condition identity', async () => {
    const { service, evaluator } = await setup(0.8, true)
    const admission = await service.admit('api')
    const state = await editing(service, admission.evolutionId, admission.roundId)
    await finalize(service, state)
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'failed',
    )
    expect(terminal?.failure?.message).toMatch(/condition identity mismatch/)
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    await service.dispose()
  })

  it('rejects unsupported best-of-N before creating partial evolution state', async () => {
    const { service } = await setup(0.8, false, 2)
    await expect(service.admit('api')).rejects.toThrow(/durable session fork/)
    expect(await service.listEvolutions()).toEqual([])
    await service.dispose()
  })

  it('rejects proposal usage budgets that DSH cannot verify instead of recording them as effective', async () => {
    const { service } = await setup()
    service.options.candidateGeneration.budget.maxModelRequests = 2
    await expect(service.admit('api')).rejects.toThrow(/aggregate proposal usage/)
    expect(await service.listEvolutions()).toEqual([])
    await service.dispose()
  })

  it('enforces the immutable candidate generation timeout and cleans up the workspace', async () => {
    const { service } = await setup(0.8, false, 1, 50)
    const admission = await service.admit('api')
    const terminal = await eventually(
      () => service.registry.stateStore(admission.evolutionId).readRound(admission.roundId),
      value => value?.status === 'failed',
    )
    expect(terminal?.failure?.message).toMatch(/candidate generation exceeded its 50ms budget/)
    await eventually(async () => service.activeEntry(admission.roundId), value => value === undefined)
    await service.dispose()
  })
})
