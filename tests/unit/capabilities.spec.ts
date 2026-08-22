import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { HitchEvaluationEvidence, HitchTrajectoryReader, RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('RefineCapabilities Git projection', () => {
  it('reads only manifest-indexed files from the exact champion commit', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const store = new RefineStateStore(`${fixture.root}/state`)
    await store.initialize()
    await store.writeChampion({
      schemaVersion: 2, ref: fixture.championRef, manifestDigest: fixture.manifest.digest, updatedAt: 'now',
    })
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository,
      targetRoot: fixture.targetRoot,
      dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    const capabilities = new RefineCapabilities({} as never, store, {} as never, builder, () => undefined)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.current', {})).resolves.toMatchObject({
      ref: fixture.championRef,
      digest: fixture.manifest.digest,
    })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: 'plugins/context.ts',
    })).resolves.toMatchObject({ text: 'export const value = 1\n', eof: true })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: '../package.json',
    })).rejects.toThrow(/escapes|not normalized/)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: 'plugins/not-in-manifest.ts',
    })).rejects.toThrow(/not in the target manifest/)
  })

  it('indexes and pages only recorded seed trajectories through Hitch', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const store = new RefineStateStore(`${fixture.root}/state`)
    await store.initialize()
    const evidence = (evalId: string, dataset: string, runId: string): HitchEvaluationEvidence => ({
      evalId,
      dataset,
      requestedCommit: fixture.championRef,
      actualCommit: fixture.championRef,
      revisionIdentity: `sha256:${'2'.repeat(64)}`,
      invocationFingerprint: `parity:${dataset}`,
      primaryReward: 1,
      summary: { total: 1, passed: 1, failed: 0, score: 1 },
      trials: [{ taskName: 'task-1', trialName: 'trial-1', runId, attempt: 1, status: 'completed', rewards: { reward: 1 } }],
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${'2'.repeat(64)}`,
        commit: fixture.championRef, tree: '3'.repeat(40), payloadSha256: `sha256:${'4'.repeat(64)}`, payloadBytes: 1,
      },
    })
    const seedRun = `run_${'1'.repeat(32)}`
    const candidateRun = `run_${'2'.repeat(32)}`
    const heldRun = `run_${'3'.repeat(32)}`
    const seedBaseline = evidence(`eval_${'1'.repeat(32)}`, 'seed', seedRun)
    const seedCandidate = evidence(`eval_${'2'.repeat(32)}`, 'seed', candidateRun)
    const heldBaseline = evidence(`eval_${'3'.repeat(32)}`, 'held-out-secret', heldRun)
    const round: RefinementRound = {
      schemaVersion: 2,
      roundId: 'round-trajectory',
      workspaceRoot: fixture.root,
      status: 'rejected',
      source: 'api',
      createdAt: 'now',
      updatedAt: 'now',
      metaHarnessRef: 'meta-v1',
      targetHarnessRef: fixture.championRef,
      targetHarnessDigest: fixture.manifest.digest,
      sandboxProfileRef: 'sandbox-v1',
      seedTaskRef: 'seed',
      heldOutRef: 'held-out-secret',
      taskBudgetMs: 60_000,
      promotionPolicy: {
        minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true,
        maxHeldOutRegression: 0, maxRequiredRegressions: 0,
      },
      batchId: 'batch-1',
      roundIndex: 1,
      roundCount: 1,
      baseline: seedBaseline,
      candidateRef: fixture.championRef,
      candidateDigest: fixture.manifest.digest,
      evaluation: {
        seedBaseline,
        seedCandidate,
        heldOutBaseline: heldBaseline,
        scoreDelta: 0,
        requiredRegressions: 0,
      },
      decision: 'rejected',
    }
    await store.writeRound(round)
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository,
      targetRoot: fixture.targetRoot,
      dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler(),
    })
    const reader: HitchTrajectoryReader = {
      async inspectTrajectory(runId, offset, limit) {
        return {
          runId,
          fidelity: 'provider_native',
          provider: 'deepseek',
          sessionId: 'target-session',
          header: { type: 'session', id: 'target-session', authorization: 'top-secret' },
          events: [{
            type: 'tool/result', seq: offset, time: 1,
            data: { text: 'top-secret held-out-secret', token: 'top-secret' },
          }],
          offset,
          limit,
          total: 1,
          eof: true,
        }
      },
    }
    const capabilities = new RefineCapabilities({} as never, store, {} as never, builder, () => undefined, {
      trajectoryReader: reader,
      secretValues: ['top-secret'],
    })
    const index = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {})
    expect(index).toMatchObject({
      rounds: [{ seedEvidence: [
        { phase: 'seed-baseline', evalId: seedBaseline.evalId, trials: [{ runId: seedRun }] },
        { phase: 'seed-candidate', evalId: seedCandidate.evalId, trials: [{ runId: candidateRun }] },
      ] }],
    })
    expect(JSON.stringify(index)).not.toContain(heldRun)
    expect(JSON.stringify(index)).not.toContain('held-out-secret')

    const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedBaseline.evalId] })
    expect(page).toMatchObject({ trajectories: [{
      runId: seedRun,
      header: { authorization: '[REDACTED]' },
      events: [{ data: { text: '[REDACTED] [REDACTED_HELD_OUT]', token: '[REDACTED]' } }],
      nextOffset: 1,
      eof: true,
    }] })
    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [heldRun] }))
      .rejects.toThrow(/not recorded seed evidence/)
  })
})
