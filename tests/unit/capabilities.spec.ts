import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { HitchEvaluationEvidence, HitchTrajectoryPage, HitchTrajectoryReader, RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js'
import { evidence as evidenceFixture, roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('RefineCapabilities Git projection', () => {
  it('reads only manifest-indexed files from the candidate parent, not the deployment champion', async () => {
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
    gitOutput(fixture.repository, ['commit', '--allow-empty', '-m', 'research survivor'])
    const parentRef = gitOutput(fixture.repository, ['rev-parse', 'HEAD'])
    const meta = { recordEvidenceAccess: () => {}, proposalAttribution: () => ({}), proposalEvidenceAudit: () => ({}) }
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', roundId: 'round-1', store, meta,
      parentHarnessRef: parentRef, parentHarnessDigest: fixture.manifest.digest,
      workspace: { workspaceId: 'workspace-1', parentRef, parentDigest: fixture.manifest.digest },
    }) }
    const capabilities = new RefineCapabilities(service as never, builder, () => undefined)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.current', {})).resolves.toMatchObject({
      ref: parentRef,
      digest: fixture.manifest.digest,
    })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: parentRef, path: 'plugins/context.ts',
    })).resolves.toMatchObject({
      text: 'export const value = 1\n',
      digest: fixture.manifest.artifacts.find(artifact => artifact.path === 'plugins/context.ts')?.digest,
      bytes: Buffer.byteLength('export const value = 1\n'),
      eof: true,
    })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: parentRef, path: '../package.json',
    })).rejects.toThrow(/escapes|not normalized/)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: parentRef, path: 'plugins/not-in-manifest.ts',
    })).rejects.toThrow(/not in the target manifest/)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: 'plugins/context.ts',
    })).rejects.toThrow(/not the current candidate parent/)
    await expect(capabilities.call('refine-meta', 'meta', 'seed_tasks.load', { partition: 'held-out' }))
      .rejects.toThrow(/must be "seed"/)
  })

  it('indexes and pages only recorded seed trajectories through Hitch', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const store = new RefineStateStore(`${fixture.root}/state`)
    await store.initialize()
    const baseRound = roundFixture({
      roundId: 'round-trajectory', workspaceRoot: fixture.root, status: 'rejected',
      targetHarnessRef: fixture.championRef, targetHarnessDigest: fixture.manifest.digest,
      heldOutRef: 'held-out-secret', decision: 'rejected',
    })
    const evidence = (evalId: string, dataset: string, runId: string): HitchEvaluationEvidence => ({
      provider: 'fake',
      conditionId: dataset === 'seed' ? baseRound.plan.seed.conditionId : baseRound.plan.heldOut.conditionId,
      effectiveConfigDigest: `sha256:${'9'.repeat(64)}`,
      evalId,
      dataset,
      requestedCommit: fixture.championRef,
      actualCommit: fixture.championRef,
      revisionIdentity: `sha256:${'2'.repeat(64)}`,
      invocationFingerprint: `sha256:${'9'.repeat(64)}`,
      completeness: 'complete',
      plannedTrialCount: 1,
      primaryReward: 1,
      summary: { total: 1, passed: 1, failed: 0, score: 1 },
      trials: [{ taskName: 'task-1', trialName: 'trial-1', runId, attempt: 1, status: 'completed', rewards: { reward: 1 } }],
      invalidTrials: [],
      localSourceTransport: {
        kind: 'local-git-commit', resolutionIdentity: `sha256:${'2'.repeat(64)}`,
        commit: fixture.championRef, tree: '3'.repeat(40), payloadSha256: `sha256:${'4'.repeat(64)}`, payloadBytes: 1,
      },
    })
    const seedRun = `run_${'1'.repeat(32)}`
    const candidateRun = `run_${'2'.repeat(32)}`
    const heldRun = `run_${'3'.repeat(32)}`
    const failedRun = `run_${'4'.repeat(32)}`
    const invalidSeedRun = `run_${'5'.repeat(32)}`
    const invalidCandidateRun = `run_${'6'.repeat(32)}`
    const seedBaseline = evidence(`eval_${'1'.repeat(32)}`, 'seed', seedRun)
    const seedCandidate = evidence(`eval_${'2'.repeat(32)}`, 'seed', candidateRun)
    for (const [value, runId] of [[seedBaseline, invalidSeedRun], [seedCandidate, invalidCandidateRun]] as const) {
      value.completeness = 'partial'
      value.plannedTrialCount = 2
      value.invalidTrials = [{
        taskName: 'task-2', trialName: 'trial-2', runId, attempt: 1,
        status: 'errored', invalidReason: 'infrastructure_failure',
      }]
    }
    const heldBaseline = evidence(`eval_${'3'.repeat(32)}`, 'held-out-secret', heldRun)
    const failedEvalId = `eval_${'4'.repeat(32)}`
    const round: RefinementRound = {
      ...baseRound,
      baseline: seedBaseline,
      failedEvaluations: [{
        phase: 'seed-baseline',
        owner: {
          candidateId: baseRound.candidatePool[0]!.parentCandidateIds[0]!,
          harnessRef: fixture.championRef,
          role: 'baseline',
        },
        evidence: {
          provider: 'fake',
          conditionId: baseRound.plan.seed.conditionId,
          effectiveConfigDigest: `sha256:${'9'.repeat(64)}`,
          evalId: failedEvalId,
          dataset: 'seed',
          requestedCommit: fixture.championRef,
          actualCommit: fixture.championRef,
          revisionIdentity: `sha256:${'2'.repeat(64)}`,
          invocationFingerprint: `sha256:${'9'.repeat(64)}`,
          runSetComplete: true,
          trials: [{
            taskName: 'task-failed', trialName: 'trial-failed', runId: failedRun, attempt: 1,
            status: 'errored', invalidReason: 'infrastructure_failure',
          }],
        },
        failure: { code: 'hitch_infrastructure_failure', message: 'invalid observation' },
      }],
      candidatePool: [{
        ...baseRound.candidatePool[0]!,
        status: 'discarded',
        sealedVersion: {
          commitOid: fixture.championRef,
          treeOid: '3'.repeat(40),
          manifestDigest: fixture.manifest.digest,
          patchDigest: `sha256:${'8'.repeat(64)}`,
          immutableRef: `refs/dsh-refine/evolutions/evo-1/candidates/${fixture.championRef}`,
        },
        seedEvaluation: seedCandidate,
      }],
      evaluation: {
        seedBaseline,
        seedCandidate,
        seedPairedTrials: [{
          conditionId: baseRound.plan.seed.conditionId,
          trialKey: JSON.stringify(['task-1', 1]),
          taskName: 'task-1', baselineTrialName: 'trial-1', candidateTrialName: 'trial-1', attempt: 1,
          baselineRunId: seedRun, candidateRunId: candidateRun,
          baselineReward: 1, candidateReward: 1, rewardDelta: 0,
        }],
        seedPairing: { planned: 2, paired: 1, excluded: 1, baselineInvalid: 1, candidateInvalid: 1 },
        heldOutBaseline: heldBaseline,
        scoreDelta: 0,
        requiredRegressions: 0,
      },
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
    const inspectTrajectory = vi.fn(async (
      runId: string,
      offset: number,
      limit: number,
      _signal: AbortSignal,
    ): Promise<HitchTrajectoryPage> => {
        return {
          runId,
          fidelity: 'provider_native',
          provider: 'deepseek',
          sessionId: 'target-session',
          header: { type: 'session', id: 'target-session', authorization: 'top-secret' },
          events: [
            {
              type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
              data: {
                role: 'user', id: 'user-1', source: { kind: 'user' }, token: 'top-secret',
                'held-out-secret': 'must not leak through an object key',
                content: [{ type: 'text', text: 'top-secret held-out-secret' }],
              },
            },
            {
              type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append',
              data: {
                turn: 1,
                step: 1,
                message: {
                  role: 'assistant', id: 'assistant-1', source: { kind: 'model', provider: 'fake', model: 'fake' },
                  content: [{
                    type: 'text',
                    text: `answer contains top-secret and held-out-secret ${'x'.repeat(10_000)}`,
                  }],
                },
              },
            },
          ],
          offset,
          limit,
          total: 2,
          eof: true,
          diagnostics: {
            totalEvents: 2,
            eventTypes: { 'user/message': 1, 'assistant/message': 1 },
            toolCalls: 0,
            toolResults: 1,
            toolErrors: 1,
            errorExcerpts: [{ type: 'tool/result', excerpt: 'top-secret held-out-secret' }],
            finalAssistantExcerpts: [],
          },
        }
    })
    const reader: HitchTrajectoryReader = { inspectTrajectory }
    const accesses: unknown[] = []
    const meta = {
      activeRoundId: () => round.roundId,
      recordEvidenceAccess: (...args: unknown[]) => { accesses.push(args) },
    }
    const service = { activeEntryForSession: () => ({ evolutionId: 'evo-1', roundId: round.roundId, store, meta, workspace: { workspaceId: 'workspace-1' } }) }
    const capabilities = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: reader,
      secretValues: ['top-secret'],
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 128 * 1024,
      allowUnavailableVerifierDiagnosis: true,
    })
    const index = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {})
    expect(index).toMatchObject({
      rounds: [{ seedEvidence: [
        { phase: 'seed-baseline', evalId: seedBaseline.evalId, completeness: 'partial', plannedTrialCount: 2,
          trials: [{ runId: seedRun }, { runId: invalidSeedRun, invalidReason: 'infrastructure_failure' }] },
        { phase: 'seed-candidate', evalId: seedCandidate.evalId, completeness: 'partial', plannedTrialCount: 2,
          trials: [{ runId: candidateRun }, { runId: invalidCandidateRun, invalidReason: 'infrastructure_failure' }] },
        { phase: 'seed-baseline', outcome: 'failed', evalId: failedEvalId, trials: [{ runId: failedRun }] },
      ] }],
    })
    expect(JSON.stringify(index)).not.toContain(heldRun)
    expect(JSON.stringify(index)).not.toContain('held-out-secret')

    const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      refs: [seedRun], view: 'events', eventTypes: ['user/message'],
    })
    expect(page).toMatchObject({ trajectories: [{
      runId: seedRun,
      header: { authorization: '[REDACTED]' },
      events: [{ data: {
        content: [{ text: '[REDACTED] [REDACTED_HELD_OUT]' }],
        token: '[REDACTED]',
      } }],
      diagnostics: { errorExcerpts: [{ excerpt: '[REDACTED] [REDACTED_HELD_OUT]' }] },
      nextOffset: 1,
      eof: true,
    }] })
    expect(accesses).not.toContainEqual([
      round.roundId,
      'meta',
      expect.objectContaining({ diagnosedRunRefs: [seedRun] }),
    ])
    const largeEvent = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      refs: [seedRun], view: 'events', eventTypes: ['assistant/message'],
    })
    expect(largeEvent).toMatchObject({ trajectories: [{
      events: [{ seq: 1, data: { truncated: true } }],
      nextOffset: 1,
      eof: true,
    }] })
    expect(JSON.stringify(largeEvent)).not.toContain('top-secret')
    expect(JSON.stringify(largeEvent)).not.toContain('held-out-secret')
    const steps = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun], view: 'steps' })
    expect(JSON.stringify(steps)).not.toContain('top-secret')
    expect(JSON.stringify(steps)).not.toContain('held-out-secret')
    expect(steps).toMatchObject({ trajectories: [{ steps: [{ assistantMessages: [{ message: {
      preview: expect.stringContaining('answer contains [REDACTED] and [REDACTED_HELD_OUT]'),
    } }] }] }] })
    const bundle = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun] })
    expect(bundle).toMatchObject({ bundles: [{
      identity: { runId: seedRun, taskName: 'task-1' },
      trajectory: { rawEventCount: 2, keySteps: [{ turn: 1, step: 1 }] },
      coverage: { task: 'complete', trajectory: 'complete', verifier: 'unavailable' },
      bundleDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    }] })
    expect(accesses).toContainEqual([
      round.roundId,
      'meta',
      expect.objectContaining({
        diagnosisReceipts: [expect.objectContaining({ runId: seedRun, projectionVersion: 1 })],
      }),
    ])
    expect(inspectTrajectory).toHaveBeenCalledTimes(3)
    const tinyProjectionCache = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: reader,
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 128 * 1024,
      maxTrajectoryProjectionCacheBytes: 1,
      allowUnavailableVerifierDiagnosis: true,
    })
    await tinyProjectionCache.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun], view: 'steps' })
    await tinyProjectionCache.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun], view: 'steps' })
    expect(inspectTrajectory).toHaveBeenCalledTimes(5)

    const constrainedBundles = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: reader,
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 4 * 1024,
      allowUnavailableVerifierDiagnosis: true,
    })
    await expect(constrainedBundles.call('refine-meta', 'meta', 'trajectory.query', {
      refs: [seedRun, invalidSeedRun], view: 'bundle',
    })).resolves.toMatchObject({
      batchAccepted: false,
      recoverable: true,
      code: 'BUNDLE_BATCH_TOO_LARGE',
      bundles: [],
      nextAction: { tool: 'trajectory_query', arguments: { refs: [seedRun], view: 'bundle' } },
      remainingActions: [{ tool: 'trajectory_query', arguments: { refs: [invalidSeedRun], view: 'bundle' } }],
    })
    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [invalidSeedRun] }))
      .resolves.toMatchObject({ bundles: [{
        identity: { runId: invalidSeedRun, taskName: 'task-2' },
      }] })
    const failedPage = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [failedEvalId] })
    expect(failedPage).toMatchObject({ bundles: [{
      identity: { runId: failedRun },
      outcome: { trialStatus: 'errored', invalidReason: 'infrastructure_failure' },
    }] })
    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [heldRun] }))
      .rejects.toThrow(/not recorded seed evidence/)
  })

  it('returns an executable recovery action instead of consuming an incomplete finalization', async () => {
    const round = roundFixture({ roundId: 'round-recovery', status: 'candidate-editing' })
    const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
    baseline.trials[0]!.taskName = 'make-doom-for-mips'
    const submitFinalization = vi.fn()
    const proposalAttribution = vi.fn()
    const meta = {
      proposalEvidenceAudit: () => ({
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        candidateId: round.candidatePool[0]!.candidateId,
        baselineEvalId: baseline.evalId,
        summaryAccessed: true,
        accessedRefs: [baseline.evalId],
        diagnosedRunRefs: [],
        citedRefs: [baseline.evalId],
      }),
      proposalAttribution,
    }
    const service = {
      activeEntryForSession: () => ({
        evolutionId: round.evolutionId,
        spec: { datasets: { seed: { ref: 'seed' } } },
        roundId: round.roundId,
        store: {},
        meta,
        workspace: { workspaceId: 'workspace-1', parentRef: round.targetHarnessRef, parentDigest: round.targetHarnessDigest },
        baseline,
        parentHarnessRef: round.targetHarnessRef,
        parentHarnessDigest: round.targetHarnessDigest,
      }),
      submitFinalization,
    }
    const capabilities = new RefineCapabilities(service as never, {} as never)
    const result = await capabilities.call('refine-meta', 'meta', 'candidate.finalize', {
      rationale: 'fix the failed task',
      expectedOutcome: 'the task passes',
      evidenceRefs: [baseline.evalId],
    })
    expect(result).toMatchObject({
      accepted: false,
      recoverable: true,
      code: 'MISSING_BASELINE_DIAGNOSIS',
      readiness: {
        failedRunCount: 1,
        remainingRunCount: 1,
        missing: [{ taskName: 'make-doom-for-mips', runId: baseline.trials[0]!.runId }],
      },
      nextAction: {
        tool: 'trajectory_query',
        arguments: { refs: [baseline.trials[0]!.runId], view: 'bundle' },
      },
      retry: { tool: 'finalize_candidate', reusePreviousArguments: true },
    })
    expect(proposalAttribution).not.toHaveBeenCalled()
    expect(submitFinalization).not.toHaveBeenCalled()
  })
})
