import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineService } from '../../src/refine/service.js'
import { RefineStateStore } from '../../src/state/store.js'
import type {
  EvaluationPhase, EvaluationRequest, HarnessMutation, HitchEvaluationEvidence, MetaAttribution,
  RefineEvaluator, RefinementRound,
} from '../../src/types.js'
import { createGitHarnessFixture, type GitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakeMeta {
  wakes: string[] = []
  async wake(round: Readonly<RefinementRound>): Promise<string> { this.wakes.push(round.roundId); return 'meta-1' }
  async dispose(): Promise<void> {}
}

class FakeEvaluator implements RefineEvaluator {
  calls: EvaluationPhase[] = []

  constructor(
    private readonly candidateScore: number,
    private readonly heldOutDelta = 0,
    private readonly failPhase?: EvaluationPhase,
  ) {}

  async evaluate(_round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>): Promise<HitchEvaluationEvidence> {
    this.calls.push(request.phase)
    if (request.phase === this.failPhase) throw new Error(`infrastructure failed during ${request.phase}`)
    const baseline = request.phase.endsWith('baseline')
    const heldOut = request.phase.startsWith('held-out')
    const score = heldOut ? baseline ? 0.6 : 0.6 + this.heldOutDelta : baseline ? 0.5 : this.candidateScore
    const passed = Math.max(0, Math.min(10, Math.round(score * 10)))
    const serial = this.calls.length.toString(16).padStart(32, '0')
    return {
      evalId: `eval_${serial}`,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit: request.harnessRef,
      revisionIdentity: `sha256:${serial.padEnd(64, '0')}`,
      invocationFingerprint: `parity:${request.dataset}`,
      primaryReward: score,
      summary: { total: 10, passed, failed: 10 - passed, score },
      trials: Array.from({ length: 10 }, (_, index) => ({
        taskName: `task-${index}`,
        status: 'completed' as const,
        rewards: { reward: index < passed ? 1 : 0 },
      })),
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${serial.padEnd(64, '0')}`,
        commit: request.harnessRef, tree: 'f'.repeat(40),
        payloadSha256: `sha256:${'1'.repeat(64)}`, payloadBytes: 1,
      },
    }
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  } while (Date.now() < deadline)
  throw new Error('condition not reached')
}

async function fixture(score = 0.8, heldOutDelta = 0, failPhase?: EvaluationPhase) {
  const git = await createGitHarnessFixture()
  roots.push(git.root)
  const store = new RefineStateStore(`${git.root}/.dsh-refine`)
  await store.initialize()
  await store.writeChampion({
    schemaVersion: 2, ref: git.championRef, manifestDigest: git.manifest.digest, updatedAt: 'before',
  })
  await store.writeMeta({ sessionId: 'meta-1', metaHarnessRef: 'meta-v1' })
  const meta = new FakeMeta()
  const evaluator = new FakeEvaluator(score, heldOutDelta, failPhase)
  const builder = new HarnessBuilder({
    repositoryPath: git.repository,
    targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef,
    toolchainRef: 'node-22-tsc',
    sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler(),
  })
  await builder.initialize()
  const service = new RefineService(store, builder, meta as never, evaluator, {
    workspaceRoot: git.root,
    metaHarnessRef: 'meta-v1',
    sandboxProfileRef: 'sandbox-v1',
    promotion: {
      minimumCandidateScore: 0.7, minimumAbsoluteGain: 0.1, requireNoRegression: true,
      maxHeldOutRegression: 0, maxRequiredRegressions: 0,
    },
    seedTaskRef: 'seed-dataset', heldOutRef: 'held-out-dataset', taskBudgetMs: 60_000,
  })
  await service.initialize()
  return { git, store, service, meta, evaluator }
}

const attribution: MetaAttribution = {
  sessionId: 'meta-1', requestHeaderSeq: 10, proposalEventSeq: 12, provider: 'test', model: 'test',
}

function proposal(git: GitHarnessFixture, parentRef = git.championRef, parentDigest = git.manifest.digest, path = 'prompts/new.md'): HarnessMutation {
  return {
    parentRef, parentDigest, target: 'context',
    ops: [{ type: 'create', path, content: 'new context\n', expect: 'absent' }],
    rationale: 'better context', evidenceRefs: ['eval:baseline'], expectedOutcome: 'higher score',
  }
}

describe('RefineService', () => {
  it('runs four Hitch phases and atomically promotes an exact commit', async () => {
    const { git, service, store, meta, evaluator } = await fixture()
    const admission = await service.admit('api')
    expect(admission.status).toBe('queued')
    await expect(service.admit('api')).resolves.toEqual(admission)
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await eventually(async () => meta.wakes, wakes => wakes.includes(admission.roundId))
    await service.submitProposal(admission.roundId, proposal(git), attribution)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'accepted')
    expect(terminal).toMatchObject({ decision: 'accepted', meta: attribution })
    expect((await store.readChampion())?.ref).toMatch(/^[0-9a-f]{40}$/u)
    expect((await store.readChampion())?.ref).not.toBe(git.championRef)
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
    await service.dispose()
  })

  it('records a null proposal as an attributable no-change rejection', async () => {
    const { git, service, store } = await fixture()
    const admission = await service.admit('command')
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(admission.roundId, null, attribution)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'rejected')
    expect(terminal?.decision).toBe('no-change')
    expect((await store.readChampion())?.ref).toBe(git.championRef)
    await service.dispose()
  })

  it('rejects at the seed gate without spending held-out evaluations', async () => {
    const { git, service, store, evaluator } = await fixture(0.55)
    const admission = await service.admit('api')
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(admission.roundId, proposal(git), attribution)
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'rejected')
    expect(evaluator.calls).toEqual(['seed-baseline', 'seed-candidate'])
    expect((await store.readChampion())?.ref).toBe(git.championRef)
    await service.dispose()
  })

  it('classifies Hitch infrastructure errors as failed rather than rejected', async () => {
    const { service, store } = await fixture(0.8, 0, 'seed-baseline')
    const admission = await service.admit('api')
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'failed')
    expect(terminal?.failure?.message).toContain('infrastructure failed')
    expect(terminal?.decision).toBeUndefined()
    await service.dispose()
  })

  it('classifies attempts to expand fixed substrate separately from infrastructure failure', async () => {
    const { git, service, store } = await fixture()
    const admission = await service.admit('api')
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(admission.roundId, proposal(git, git.championRef, git.manifest.digest, 'packages/core.ts'), attribution)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'rejected-for-substrate')
    expect(terminal?.decision).toBe('rejected-for-substrate')
    expect(terminal?.failure?.message).toContain('fixed substrate')
    await service.dispose()
  })

  it('rolls back only to a commit accepted by a complete recorded evaluation', async () => {
    const { git, service, store } = await fixture()
    const first = await service.admit('api')
    await eventually(() => store.readRound(first.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(first.roundId, proposal(git), attribution)
    await eventually(() => store.readRound(first.roundId), round => round?.status === 'accepted')
    const firstChampion = (await store.readChampion())!
    await eventually(async () => {
      try { const lock = await store.acquireRoundLock('probe'); await lock.release(); return true } catch { return false }
    }, Boolean)

    const second = await service.admit('api')
    await eventually(() => store.readRound(second.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(second.roundId, proposal(
      git, firstChampion.ref, firstChampion.manifestDigest, 'prompts/second.md',
    ), { ...attribution, proposalEventSeq: 13 })
    await eventually(() => store.readRound(second.roundId), round => round?.status === 'accepted')
    await eventually(async () => {
      try { const lock = await store.acquireRoundLock('probe-2'); await lock.release(); return true } catch { return false }
    }, Boolean)
    await expect(service.rollback('f'.repeat(40))).rejects.toThrow(/not accepted/)
    await service.rollback(firstChampion.ref)
    expect((await store.readChampion())?.ref).toBe(firstChampion.ref)
    await service.dispose()
  })

  it('serializes a requested multi-round batch under one workspace owner', async () => {
    const { service, store } = await fixture()
    const first = await service.admit('command', {
      seedTaskRef: 'seed-override', rounds: 2, taskBudgetMs: 12_345, target: 'routing',
    })
    await eventually(() => store.readRound(first.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(first.roundId, null, attribution)
    const secondRound = await eventually(async () => {
      const rounds = await store.listRounds()
      return rounds.find(round => round.roundId !== first.roundId && round.status === 'waiting-proposal')
    }, round => round !== undefined)
    expect(secondRound).toMatchObject({ roundIndex: 2, roundCount: 2, seedTaskRef: 'seed-override', requestedTarget: 'routing' })
    await service.submitProposal(secondRound!.roundId, null, { ...attribution, proposalEventSeq: 14 })
    await eventually(() => store.readRound(secondRound!.roundId), round => round?.status === 'rejected')
    await service.dispose()
  })
})
