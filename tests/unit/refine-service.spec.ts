import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineService } from '../../src/refine/service.js'
import { RefineStateStore } from '../../src/state/store.js'
import type {
  CandidateEvaluation, EvaluationEvidence, HarnessMutation, MetaAttribution, RefineEvaluator, RefinementRound,
} from '../../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakeMeta {
  wakes: string[] = []
  async wake(round: Readonly<RefinementRound>): Promise<string> { this.wakes.push(round.roundId); return 'meta-1' }
  async dispose(): Promise<void> {}
}

class FakeEvaluator implements RefineEvaluator {
  constructor(private readonly candidateScore: number) {}
  async evaluateBaseline(): Promise<EvaluationEvidence> {
    return {
      ref: 'evidence:baseline', trajectoryRefs: ['trajectory:base'], runtimeFingerprint: 'parity-v1',
      summary: { total: 10, passed: 5, failed: 5, score: 0.5 },
    }
  }
  async evaluateCandidate(): Promise<CandidateEvaluation> {
    const passed = Math.round(this.candidateScore * 10)
    return {
      baseline: { total: 10, passed: 5, failed: 5, score: 0.5 },
      candidate: { total: 10, passed, failed: 10 - passed, score: this.candidateScore },
      heldOutDelta: 0, requiredRegressions: 0, infrastructureOk: true,
      parityFingerprint: 'parity-v1', evidenceRefs: ['evidence:candidate'],
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

async function fixture(score = 0.8, evaluatorPresent = true) {
  const root = await mkdtemp(join(tmpdir(), 'refine-service-'))
  roots.push(root)
  const parent = join(root, 'harnesses', 'parent')
  await mkdir(join(parent, 'preset'), { recursive: true })
  await mkdir(join(parent, 'plugins'), { recursive: true })
  await writeFile(join(parent, 'preset', 'agent.cordis.yml'), '- name: ./plugins/context.js\n')
  await writeFile(join(parent, 'plugins', 'context.ts'), 'export const value = 1\n')
  await writeFile(join(parent, 'manifest.json'), JSON.stringify({ schemaVersion: 1, digest: 'sha256:parent', artifacts: [] }))
  const store = new RefineStateStore(join(root, '.dsh-refine'))
  await store.initialize()
  await store.writeChampion({ ref: 'parent', digest: 'sha256:parent', artifactPath: parent, updatedAt: 'before' })
  await store.writeMeta({ sessionId: 'meta-1', metaHarnessRef: 'meta-v1' })
  const meta = new FakeMeta()
  const evaluator = new FakeEvaluator(score)
  const service = new RefineService(
    store,
    new HarnessBuilder({
      harnessRoot: join(root, 'harnesses'), artifactRoot: join(root, 'artifacts'),
      dshRevision: 'rc8', toolchainRef: 'tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
    }),
    meta as never,
    () => evaluatorPresent ? evaluator : undefined,
    {
      workspaceRoot: root, metaHarnessRef: 'meta-v1', sandboxProfileRef: 'sandbox-v1',
      promotion: {
        minimumCandidateScore: 0.7, minimumAbsoluteGain: 0.1, requireNoRegression: true,
        maxHeldOutRegression: 0, maxRequiredRegressions: 0,
      },
      seedTaskRef: 'seed-commit', heldOutRef: 'held-out-commit', taskBudgetMs: 60_000,
    },
  )
  await service.initialize()
  return { root, store, service, meta }
}

const attribution: MetaAttribution = {
  sessionId: 'meta-1', requestHeaderSeq: 10, proposalEventSeq: 12, provider: 'test', model: 'test',
}

function proposal(parentRef = 'parent', parentDigest = 'sha256:parent', path = 'prompts/new.md'): HarnessMutation {
  return {
    parentRef, parentDigest, target: 'context',
    ops: [{ type: 'create', path, content: 'new context\n', expect: 'absent' }],
    rationale: 'better context', evidenceRefs: ['evidence:baseline'], expectedOutcome: 'higher score',
  }
}

describe('RefineService', () => {
  it('returns queued immediately, awaits one proposal, evaluates, and atomically promotes', async () => {
    const { service, store, meta } = await fixture()
    const admission = await service.admit('api')
    expect(admission.status).toBe('queued')
    await expect(service.admit('api')).resolves.toEqual(admission)
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await eventually(async () => meta.wakes, wakes => wakes.includes(admission.roundId))
    expect(meta.wakes).toEqual([admission.roundId])
    await service.submitProposal(admission.roundId, proposal(), attribution)
    await expect(service.submitProposal(admission.roundId, proposal(), attribution)).rejects.toThrow(/already received|not waiting/)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'accepted')
    expect(terminal).toMatchObject({ decision: 'accepted', meta: attribution })
    expect((await store.readChampion())?.ref).toMatch(/^sha256:/)
    await service.dispose()
  })

  it('records a null proposal as an attributable no-change rejection', async () => {
    const { service, store } = await fixture()
    const admission = await service.admit('command')
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(admission.roundId, null, attribution)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'rejected')
    expect(terminal?.decision).toBe('no-change')
    expect((await store.readChampion())?.ref).toBe('parent')
    await service.dispose()
  })

  it('fails closed before admission when the evaluator provider is absent', async () => {
    const { service, store } = await fixture(0.8, false)
    await expect(service.admit('target')).rejects.toThrow(/no refineEvaluator/)
    const lock = await store.acquireRoundLock()
    await lock.release()
    await service.dispose()
  })

  it('rejects a non-improving candidate without changing champion', async () => {
    const { service, store } = await fixture(0.55)
    const admission = await service.admit('api')
    await eventually(() => store.readRound(admission.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(admission.roundId, proposal(), attribution)
    const terminal = await eventually(() => store.readRound(admission.roundId), round => round?.status === 'rejected')
    expect(terminal?.decision).toBe('rejected')
    expect((await store.readChampion())?.ref).toBe('parent')
    await service.dispose()
  })

  it('rolls back only to a harness accepted by a recorded round', async () => {
    const { service, store } = await fixture()
    const first = await service.admit('api')
    await eventually(() => store.readRound(first.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(first.roundId, proposal(), attribution)
    await eventually(() => store.readRound(first.roundId), round => round?.status === 'accepted')
    const firstChampion = (await store.readChampion())!
    await eventually(async () => {
      try {
        const lock = await store.acquireRoundLock('between-rounds')
        await lock.release()
        return true
      } catch {
        return false
      }
    }, value => value)

    const second = await service.admit('api')
    await eventually(() => store.readRound(second.roundId), round => round?.status === 'waiting-proposal')
    await service.submitProposal(second.roundId, proposal(
      firstChampion.ref, firstChampion.digest, 'prompts/second.md',
    ), { ...attribution, proposalEventSeq: 13 })
    await eventually(() => store.readRound(second.roundId), round => round?.status === 'accepted')
    expect((await store.readChampion())?.ref).not.toBe(firstChampion.ref)
    await eventually(async () => {
      try {
        const lock = await store.acquireRoundLock('test-probe')
        await lock.release()
        return true
      } catch {
        return false
      }
    }, value => value)
    await expect(service.rollback('sha256:not-verified')).rejects.toThrow(/not accepted/)
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
    expect(secondRound).toMatchObject({
      batchId: (await store.readRound(first.roundId))?.batchId,
      roundIndex: 2,
      roundCount: 2,
      seedTaskRef: 'seed-override',
      taskBudgetMs: 12_345,
      requestedTarget: 'routing',
    })
    await service.submitProposal(secondRound!.roundId, null, { ...attribution, proposalEventSeq: 14 })
    await eventually(() => store.readRound(secondRound!.roundId), round => round?.status === 'rejected')
    await service.dispose()
  })
})
