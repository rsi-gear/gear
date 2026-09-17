import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { projectTrajectory } from '../../src/evaluator/trajectory-projection.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { renderTrajectoryResult } from '../../src/notebook/tool.js'
import { RefineStateStore } from '../../src/state/store.js'
import type {
  HitchEvaluationEvidence,
  HitchTrajectoryAnalysis,
  HitchTrajectoryReader,
  HitchVerifierDiagnosticPageQuery,
  HitchVerifierEvidence,
  MetaFailureCard,
  RefinementRound,
  TrajectoryProjection,
} from '../../src/types.js'
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js'
import { evidence as evidenceFixture, roundFixture } from '../helpers/research-fixture.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('RefineCapabilities Git projection', () => {
  it('validates a resolved physical verifier parent without weakening default identity checks', async () => {
    const actual: HitchVerifierEvidence = { runId: 'run-a', parent: { evalId: 'physical-a', trialId: 'trial-a', attempt: 1 }, verifier: { status: 'complete' } }
    const item = { evalId: 'shared-a', trial: { runId: 'run-a', trialName: 'trial-a', attempt: 1 } }
    const check = async (resolveVerifierEvaluationId?: HitchTrajectoryReader['resolveVerifierEvaluationId']) => {
      const reader = { inspectVerifierEvidence: async () => actual, ...(resolveVerifierEvaluationId ? { resolveVerifierEvaluationId } : {}) } as unknown as HitchTrajectoryReader
      const capabilities = new RefineCapabilities({} as never, {} as never, { trajectoryReader: reader })
      return (capabilities as unknown as { loadVerifierEvidence(item: unknown, signal: AbortSignal): Promise<HitchVerifierEvidence> })
        .loadVerifierEvidence(item, new AbortController().signal)
    }
    expect((await check()).verifier.status).toBe('corrupt')
    const resolve = vi.fn(async () => 'physical-a')
    expect(await check(resolve)).toEqual(actual)
    expect(resolve).toHaveBeenCalledWith('shared-a', 'run-a', expect.any(AbortSignal))
    expect((await check(async () => 'wrong-parent')).verifier.status).toBe('corrupt')
    actual.parent!.trialId = 'foreign-trial'
    expect((await check(resolve)).verifier.status).toBe('corrupt')
  })

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
    const rawEvents = [
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
    ]
    const inspectTrajectoryAnalysis = vi.fn(async (runId: string): Promise<HitchTrajectoryAnalysis> =>
      trajectoryAnalysis(runId, rawEvents, runId === seedRun ? 'normalized' : 'provider_native'))
    const inspectTrajectoryEvents = vi.fn(async (runId: string, query: {
      eventTypes?: string[]; limit?: number; cursor?: string; seqStart?: number; seqEnd?: number
      field?: string; canonicalSha256?: string; maxBytes?: number
    }) => {
      const analysis = trajectoryAnalysis(runId, rawEvents)
      if (query.seqStart === 99 && query.seqEnd === 99 && query.field === 'data.message') {
        return {
          schemaVersion: 1 as const,
          kind: 'trajectory-events-page' as const,
          runId,
          canonicalSha256: analysis.source.canonicalSha256,
          filter: { seqStart: 99, seqEnd: 99, field: query.field },
          events: [{
            type: 'assistant/message', seq: 99,
            event_excerpt: {
              preview: '{"type":"assistant/message","seq":99,"data":{"authorization":"Bearer leaked',
              tail: `","bytes":5000000,"sha256":"sha256:${'a'.repeat(64)}","source":{"run_id":"${runId}","field":"event"}}`,
              truncated: true,
            },
          }],
          totalMatches: 1,
          eof: true,
        }
      }
      if (query.field !== undefined && query.seqStart === query.seqEnd) {
        const seq = query.seqStart!
        const event = rawEvents.find(item => item.seq === seq)!
        const data = event.data as Record<string, unknown>
        const value = JSON.parse(JSON.stringify(
          query.field === 'data' ? data : data[query.field.slice('data.'.length)],
        ))
        return {
          schemaVersion: 1 as const,
          kind: 'trajectory-events-page' as const,
          runId,
          canonicalSha256: analysis.source.canonicalSha256,
          filter: { seqStart: seq, seqEnd: seq, field: query.field },
          events: [{ type: event.type, seq: event.seq, event_excerpt: { value } }],
          totalMatches: 1,
          eof: true,
        }
      }
      if (query.eventTypes?.includes('retry-test') === true) {
        const all = Array.from({ length: 5 }, (_, seq) => ({
          type: 'retry-test', seq, data: { text: 'x'.repeat(1_500) },
        }))
        const start = query.cursor === undefined ? 0 : Number(query.cursor.slice('cursor-'.length))
        const page = all.slice(start, start + (query.limit ?? 100))
        const next = start + page.length
        return {
          schemaVersion: 1 as const,
          kind: 'trajectory-events-page' as const,
          runId,
          canonicalSha256: analysis.source.canonicalSha256,
          filter: { eventTypes: ['retry-test'] },
          events: page,
          totalMatches: all.length,
          ...(next < all.length ? { nextCursor: `cursor-${next}` } : {}),
          eof: next >= all.length,
        }
      }
      const filtered = query.eventTypes === undefined
        ? rawEvents
        : rawEvents.filter(event => query.eventTypes!.includes(event.type))
      return {
        schemaVersion: 1 as const,
        kind: 'trajectory-events-page' as const,
        runId,
        canonicalSha256: analysis.source.canonicalSha256,
        filter: query.eventTypes === undefined ? {} : { eventTypes: query.eventTypes },
        events: filtered.slice(0, query.limit ?? 100),
        totalMatches: filtered.length,
        eof: true,
      }
    })
    const verifierParents = new Map([
      [seedRun, { evalId: seedBaseline.evalId, trialId: 'trial-1', attempt: 1 }],
      [invalidSeedRun, { evalId: seedBaseline.evalId, trialId: 'trial-2', attempt: 1 }],
      [failedRun, { evalId: failedEvalId, trialId: 'trial-failed', attempt: 1 }],
    ])
    const inspectVerifierEvidence = vi.fn(async (runId: string): Promise<HitchVerifierEvidence> => {
      const common = {
        runId,
        parent: verifierParents.get(runId)!,
        observation: { status: 'valid' as const, reward: runId === seedRun ? 1 : 0 },
      }
      if (runId === failedRun) return { ...common, verifier: { status: 'missing' } }
      return {
        ...common,
        verifier: {
          status: runId === invalidSeedRun ? 'result_only' : 'complete',
          result: {
            rewards: { reward: runId === seedRun ? 1 : 0 },
            token: 'top-secret',
            held_out_metric: 'must not be exposed',
          },
          resultSha256: `sha256:${'7'.repeat(64)}`,
          ...(runId !== seedRun ? {} : {
            scores: { totalScore: 1, processScore: 0.5, normalization: 'standard' as const },
            process: {
              schemaVersion: 1 as const,
              metric: 'partial_credit',
              score: 0.5,
              detailStatus: 'components' as const,
              passed: 1,
              total: 1,
              excluded: 0,
              components: [{
                id: 'assertion-1', category: 'message-sent', status: 'passed' as const, weight: 1,
                publicDetails: { note: 'top-secret held-out-secret' },
                privateDetailsRef: 'private-only/assertion-1.json',
              }],
            },
            feedback: {
              schemaVersion: 1 as const,
              items: [{ code: 'done', severity: 'info' as const, message: 'top-secret held-out-secret feedback' }],
            },
          }),
          ...(runId === invalidSeedRun ? {} : {
            diagnostics: { stdout: [{ name: 'test-stdout.txt', text: 'top-secret held-out-secret assertion output' }] },
          }),
        },
        redactions: [{ ruleId: 'absolute-path-v1', count: 1 }],
      }
    })
    const reader: HitchTrajectoryReader = {
      async inspectCapabilities() { return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 } },
      inspectTrajectoryAnalysis,
      inspectTrajectoryEvents,
      inspectVerifierEvidence,
    }
    const accesses: unknown[] = []
    const meta = {
      activeRoundId: () => round.roundId,
      recordEvidenceAccess: (...args: unknown[]) => { accesses.push(args) },
      proposalEvidenceAudit: () => ({
        summaryAccessed: true,
        accessedRefs: [],
        diagnosedRunRefs: [],
        citedRefs: [],
        diagnosisReceipts: accesses.flatMap(value => {
          const access = (value as unknown[])[2] as { diagnosisReceipts?: unknown[] } | undefined
          return access?.diagnosisReceipts ?? []
        }),
      }),
    }
    const recordMetaPrerequisiteBlocker = vi.fn(async () => {})
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', roundId: round.roundId, store, meta, baseline: seedBaseline,
      workspace: { workspaceId: 'workspace-1' },
    }), recordMetaPrerequisiteBlocker }
    const capabilities = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: reader,
      secretValues: ['top-secret'],
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 128 * 1024,
      allowUnavailableVerifierDiagnosis: true,
    })
    const index = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {})
    expect(index).toMatchObject({
      baseline: {
        status: 'partial', score: 1,
        failedRuns: [{ task: 'task-2', runId: invalidSeedRun, invalidReason: 'infrastructure_failure' }],
      },
    })
    expect(JSON.stringify(index)).not.toContain(heldRun)
    expect(JSON.stringify(index)).not.toContain(candidateRun)
    expect(JSON.stringify(index)).not.toContain('held-out-secret')

    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      refs: [seedRun], view: 'events', seqStart: 0,
    })).rejects.toThrow(/unknown field/u)

    const result = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun] })
    expect(result).toMatchObject({ runs: [{
      task: 'task-1',
      runId: seedRun,
      outcome: { status: 'completed', reward: 1 },
      verifier: {
        status: 'complete', summary: 'Verifier diagnostics are available.', needsDetail: true,
        scores: { totalScore: 1, processScore: 0.5, normalization: 'standard' },
        process: {
          metric: 'partial_credit', score: 0.5,
          components: [{
            id: 'assertion-1', status: 'passed',
            publicDetails: { note: '[REDACTED] [REDACTED_HELD_OUT]' },
          }],
        },
        feedback: { items: [{ code: 'done', message: '[REDACTED] [REDACTED_HELD_OUT] feedback' }] },
        detailRef: expect.stringMatching(/^detail_/u),
      },
      transcript: {
        text: expect.stringContaining('answer contains [REDACTED] and [REDACTED_HELD_OUT]'),
      },
    }] })
    const serialized = JSON.stringify(result)
    for (const field of ['canonicalSha256', 'seqStart', 'seqEnd', 'field', 'bytes', 'sha256', 'offset', 'cursor']) {
      expect(serialized).not.toContain(field)
    }
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('held-out-secret')
    expect(serialized).not.toContain('held_out_metric')
    expect(serialized).not.toContain('private-only')
    expect(accesses).not.toContainEqual([
      round.roundId,
      'meta',
      expect.objectContaining({
        diagnosisReceipts: [expect.objectContaining({ runId: seedRun, projectionVersion: 1 })],
      }),
    ])
    expect(inspectTrajectoryAnalysis).toHaveBeenCalledTimes(1)
    const card = (result as {
      runs: Array<{
        verifier: { detailRef?: string }
        transcript: { text: string }
      }>
    }).runs[0]!
    const verifierDetail = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      detailRef: card.verifier.detailRef!,
    })
    expect(verifierDetail).toMatchObject({
      detail: { text: expect.stringContaining('STDOUT test-stdout.txt'), complete: true },
    })
    expect(JSON.stringify(verifierDetail)).not.toMatch(/media_type|sha256|bytes|truncated/u)
    expect(accesses).toContainEqual([
      round.roundId,
      'meta',
      expect.objectContaining({
        diagnosisReceipts: [expect.objectContaining({ runId: seedRun, projectionVersion: 1 })],
      }),
    ])
    const assistantRef = card.transcript.text.match(/ASSISTANT[\s\S]*?\[more: (detail_[a-f0-9]+)\]/u)?.[1]
    expect(assistantRef).toMatch(/^detail_/u)
    const detailPage = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: assistantRef })
    expect(detailPage).toMatchObject({
      detail: { text: expect.stringContaining('answer contains [REDACTED] and [REDACTED_HELD_OUT]'), complete: false },
      nextRef: expect.stringMatching(/^detail_/u),
    })
    expect(JSON.stringify(detailPage)).not.toContain('canonicalSha256')
    let continuation = (detailPage as { nextRef?: string }).nextRef
    let completed = false
    while (continuation !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: continuation }) as {
        detail: { text: string; complete: boolean }
        nextRef?: string
      }
      completed = page.detail.complete
      continuation = page.nextRef
    }
    expect(completed).toBe(true)
    const found = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      detailRef: assistantRef, find: 'answer contains',
    })
    expect(found).toMatchObject({ detail: { matches: [expect.stringContaining('answer contains')] } })
    const internals = capabilities as unknown as {
      failureCard(
        sessionId: string,
        item: never,
        projection: TrajectoryProjection,
        verifier: HitchVerifierEvidence,
        heldOutRef: string | undefined,
      ): MetaFailureCard
      registerDetailRef(value: {
        sessionId: string; roundId: string; runId: string; offset: number
        source: { seq: number; field: string; canonicalSha256: string; bytes: number }
      }): string
    }
    const windowProjection = projectTrajectory(trajectoryAnalysis(seedRun, rawEvents))
    const excerpt = (preview: string, field: string) => ({
      preview,
      bytes: Buffer.byteLength(preview),
      sha256: `sha256:${'a'.repeat(64)}`,
      truncated: false,
      source: { runId: seedRun, field },
    })
    windowProjection.messages = [
      {
        seq: 0, eventType: 'user/message', role: 'user',
        message: excerpt('window task', 'data'),
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        seq: index + 1,
        eventType: 'assistant/message',
        role: 'assistant',
        message: excerpt(`message-${index.toString().padStart(2, '0')} ${'a'.repeat(1_990)}`, 'data.message'),
      })),
    ]
    const fullToolResult = `${'r'.repeat(5_000)} TOOL-RESULT-END`
    windowProjection.semanticSteps = [{
      id: 'turn-1-step-1', turn: 1, step: 1, seqStart: 100, seqEnd: 101,
      assistantMessages: [],
      toolActions: [{
        callId: 'call-window', name: 'bash', callSeq: 100, resultSeq: 101,
        arguments: excerpt('{"command":"long-output"}', 'data.arguments'),
        result: excerpt(fullToolResult, 'data.message'),
        status: 'completed',
      }],
    }]
    const windowCard = internals.failureCard('meta', {
      evolutionId: 'evo-1', roundId: round.roundId, phase: 'seed-baseline', evalId: seedBaseline.evalId,
      trial: { taskName: 'window-task', runId: seedRun, status: 'completed', rewards: { reward: 0 } },
    } as never, windowProjection, {
      runId: seedRun, verifier: { status: 'result_only' },
    }, undefined)
    expect(Array.from(windowCard.transcript.text).length).toBeLessThanOrEqual(80_000)
    expect(windowCard.transcript.text).toContain('message-49')
    expect(windowCard.transcript.text).not.toContain('message-00')
    expect(windowCard.transcript.earlierRef).toMatch(/^detail_/u)
    const unicodeProjection = structuredClone(windowProjection)
    unicodeProjection.messages = [{
      seq: 0,
      eventType: 'user/message',
      role: 'user',
      message: excerpt(`PREFIX_MARKER${'界'.repeat(30_000)}`, 'data'),
    }]
    unicodeProjection.semanticSteps = []
    const unicodeCard = internals.failureCard('meta', {
      evolutionId: 'evo-1', roundId: round.roundId, phase: 'seed-baseline', evalId: seedBaseline.evalId,
      trial: { taskName: 'unicode-window', runId: seedRun, status: 'completed', rewards: { reward: 0 } },
    } as never, unicodeProjection, {
      runId: seedRun, verifier: { status: 'result_only' },
    }, undefined)
    expect(unicodeCard.transcript.text).toContain('PREFIX_MARKER')
    expect(unicodeCard.transcript.earlierRef).toBeUndefined()
    const toolOutput = windowCard.transcript.text.match(/output: ([\s\S]*?)\n\[more: (detail_[a-f0-9]+)\]/u)
    expect(toolOutput).toBeDefined()
    expect(Array.from(toolOutput![1]!)).toHaveLength(2_000)
    let earlierRef = windowCard.transcript.earlierRef
    let earlierText = ''
    while (earlierRef !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: earlierRef }) as {
        detail: { text: string }
        nextRef?: string
      }
      earlierText += page.detail.text
      earlierRef = page.nextRef
    }
    expect(earlierText).toContain('message-00')
    let toolDetailRef: string | undefined = toolOutput![2]!
    let fullToolText = ''
    while (toolDetailRef !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
        detailRef: toolDetailRef,
      }) as { detail: { text: string }; nextRef?: string }
      fullToolText += page.detail.text
      toolDetailRef = page.nextRef
    }
    expect(fullToolText).toContain('TOOL-RESULT-END')
    const unsafeExcerptRef = internals.registerDetailRef({
      sessionId: 'meta', roundId: round.roundId, runId: seedRun, offset: 0,
      source: {
        seq: 99, field: 'data.message',
        canonicalSha256: trajectoryAnalysis(seedRun, rawEvents).source.canonicalSha256,
        bytes: 5_000_000,
      },
    })
    const safeIncomplete = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      detailRef: unsafeExcerptRef,
    })
    expect(safeIncomplete).toEqual({
      detail: {
        text: 'The upstream source retained only an incomplete excerpt; its content cannot be safely reconstructed.',
        complete: false,
      },
    })
    expect(JSON.stringify(safeIncomplete)).not.toMatch(/Bearer leaked|seq|field|bytes|sha256|run_id/u)
    await expect(capabilities.call('refine-meta', 'another-meta', 'trajectory.query', {
      detailRef: assistantRef,
    })).rejects.toThrow(/unknown or no longer valid/u)
    expect(inspectTrajectoryEvents).toHaveBeenCalledTimes(2)
    expect(inspectTrajectoryEvents.mock.calls[0]?.[1]).toMatchObject({
      seqStart: 1, seqEnd: 1, field: 'data.message', canonicalSha256: expect.stringMatching(/^sha256:/),
    })
    expect(inspectVerifierEvidence).toHaveBeenCalledTimes(1)
    const tinyProjectionCache = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: reader,
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 128 * 1024,
      maxTrajectoryProjectionCacheBytes: 1,
      allowUnavailableVerifierDiagnosis: true,
    })
    await tinyProjectionCache.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun] })
    await tinyProjectionCache.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun] })
    expect(inspectTrajectoryAnalysis).toHaveBeenCalledTimes(3)

    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [invalidSeedRun] }))
      .resolves.toMatchObject({ runs: [{
      runId: invalidSeedRun,
      task: 'task-2',
      outcome: { status: 'errored', invalidReason: 'infrastructure_failure' },
      verifier: { status: 'result_only' },
      }] })
    await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [heldRun] }))
      .rejects.toThrow(/not a recorded seed run/)

    const blockedReader: HitchTrajectoryReader = {
      ...reader,
      async inspectTrajectoryAnalysis() {
        throw Object.assign(new Error('canonical digest mismatch'), { code: 'trajectory_integrity_mismatch' })
      },
    }
    const blockedCapabilities = new RefineCapabilities(service as never, builder, () => undefined, {
      trajectoryReader: blockedReader,
      maxFailureBundleBytes: 128 * 1024,
    })
    await expect(blockedCapabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [seedRun] }))
      .resolves.toMatchObject({
        runs: [],
        batchAccepted: false,
        recoverable: false,
        code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
        blockedRuns: [{ runId: seedRun, code: 'trajectory_integrity_mismatch' }],
        operatorAction: { runIds: [seedRun], reason: 'trajectory_integrity_mismatch' },
      })
    await expect(blockedCapabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [invalidSeedRun] }))
      .resolves.toMatchObject({
        code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
        blockedRuns: [{ runId: invalidSeedRun, code: 'trajectory_integrity_mismatch' }],
      })
    expect(recordMetaPrerequisiteBlocker).not.toHaveBeenCalled()
  })

  it.each(['scores', 'process', 'feedback', 'all'] as const)(
    'pages structured verifier %s through an opaque detail ref without legacy diagnostics',
    async channels => {
      const round = roundFixture({ roundId: 'round-structured', status: 'candidate-editing', heldOutRef: 'held-out-secret' })
      const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
      round.baseline = baseline
      const runId = baseline.trials[0]!.runId!
      const hasProcess = channels === 'process' || channels === 'all'
      const hasFeedback = channels === 'feedback' || channels === 'all'
      const verifier: HitchVerifierEvidence = { runId, verifier: {
        status: 'complete',
        scores: { totalScore: 0, ...(hasProcess ? { processScore: 0 } : {}), normalization: 'standard' },
        ...(hasProcess ? { process: {
          schemaVersion: 1, metric: 'assertions', score: 0, detailStatus: 'components', passed: 0, total: 1, excluded: 0,
          components: [{ id: 'step-1', category: 'assertion', status: 'failed', weight: 1, code: 'missing-output',
            publicDetails: { note: 'process clue top-secret held-out-secret', explanation: '过程🙂'.repeat(900),
              api_key: 'nested-credential', heldOutAnswer: 'hidden-answer', partitionRef: 'hidden-partition' },
            privateDetailsRef: 'private-only/step-1.json', trajectoryRefs: [{ runId, seqStart: 1, seqEnd: 1 }] }],
        } as const } : {}),
        ...(hasFeedback ? { feedback: { schemaVersion: 1, items: [{ code: 'repair', severity: 'error',
          message: `feedback clue top-secret held-out-secret ${'证据🙂'.repeat(1200)}`,
          ...(hasProcess ? { componentIds: ['step-1'] } : {}), trajectoryRefs: [{ runId, seqStart: 1, seqEnd: 1 }] }] } as const } : {}),
      } }
      const accesses: Array<{ diagnosisReceipts?: unknown[] }> = []
      const receipts = () => accesses.flatMap(access => access.diagnosisReceipts ?? [])
      const meta = {
        recordEvidenceAccess: (_roundId: string, _sessionId: string, access: typeof accesses[number]) => { accesses.push(access) },
        proposalEvidenceAudit: () => ({ summaryAccessed: true, accessedRefs: [baseline.evalId], diagnosedRunRefs: [],
          citedRefs: [], diagnosisReceipts: receipts() }),
      }
      const service = { activeEntryForSession: () => ({ evolutionId: round.evolutionId, roundId: round.roundId,
        parentHarnessRef: round.targetHarnessRef, workspace: {}, baseline, meta,
        store: { listRounds: async () => [round] } }) }
      const inspectTrajectoryEvents = vi.fn(async () => { throw new Error('structured details must not fetch trajectory events') })
      const capabilities = new RefineCapabilities(service as never, {} as HarnessBuilder, {
        trajectoryReader: {
          inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }),
          inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
            { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'task prompt' }] } },
            { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'candidate answer' }] } } },
          ]),
          inspectTrajectoryEvents,
          inspectVerifierEvidence: async () => verifier,
        },
        secretValues: ['top-secret'], maxTrajectoryPageBytes: 4096, maxFailureBundleBytes: 128 * 1024,
      })
      const result = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as { runs: MetaFailureCard[] }
      const card = result.runs[0]!
      expect(card.verifier).toMatchObject({ status: 'complete', needsDetail: true, detailRef: expect.stringMatching(/^detail_[a-f0-9]+$/u) })
      expect(receipts()).toHaveLength(0)
      const ref = card.verifier.detailRef!
      await expect(capabilities.call('refine-meta', 'other-meta', 'trajectory.query', { detailRef: ref })).rejects.toThrow(/unknown or no longer valid/u)
      const found = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: ref, find: 'totalScore' })
      expect(found).toMatchObject({ detail: { matches: [expect.stringContaining('totalScore')] } })
      expect(receipts()).toHaveLength(0)
      const pages: string[] = []
      let nextRef: string | undefined = ref
      while (nextRef !== undefined) {
        const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: nextRef }) as {
          detail: { text: string; complete: boolean }; nextRef?: string
        }
        expect(Buffer.byteLength(page.detail.text)).toBeLessThanOrEqual(4096)
        pages.push(page.detail.text)
        expect(page.detail.complete).toBe(page.nextRef === undefined)
        nextRef = page.nextRef
        if (nextRef !== undefined) expect(receipts()).toHaveLength(0)
      }
      const detail = pages.join('')
      expect(detail).toContain('SCORES\n')
      if (hasProcess) {
        expect(detail).toContain('PROCESS\n')
        expect(detail).toContain('process clue [REDACTED] [REDACTED_HELD_OUT]')
        expect(detail).toContain('过程🙂'.repeat(900))
      }
      if (hasFeedback) {
        expect(detail).toContain('FEEDBACK\n')
        expect(detail).toContain('feedback clue [REDACTED] [REDACTED_HELD_OUT]')
        expect(detail).toContain('证据🙂'.repeat(1200))
      }
      if (hasProcess || hasFeedback) expect(pages.length).toBeGreaterThan(1)
      for (const text of [JSON.stringify(result), detail, JSON.stringify(found)]) {
        expect(text).not.toMatch(/top-secret|held-out-secret|privateDetailsRef|private-only|nested-credential|heldOutAnswer|hidden-answer|partitionRef|hidden-partition/u)
      }
      expect(receipts()).toHaveLength(1)
      await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: ref })
      expect(receipts()).toHaveLength(1)
      expect(inspectTrajectoryEvents).not.toHaveBeenCalled()

      verifier.verifier.status = 'result_only'
      accesses.length = 0
      const resultOnly = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as { runs: MetaFailureCard[] }
      const resultOnlyCard = resultOnly.runs[0]!
      expect(resultOnlyCard.verifier.detailRef).toMatch(/^detail_/u)
      if (hasProcess || hasFeedback) {
        expect(resultOnlyCard.verifier).toMatchObject({ needsDetail: true })
        expect(resultOnly).toMatchObject({ diagnosisProgress: { ready: false, diagnosed: 0 } })
        expect(receipts()).toHaveLength(0)
        let resultOnlyRef: string | undefined = resultOnlyCard.verifier.detailRef!
        while (resultOnlyRef !== undefined) {
          const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: resultOnlyRef }) as {
            detail: { complete: boolean }; nextRef?: string
          }
          resultOnlyRef = page.nextRef
          expect(receipts()).toHaveLength(page.detail.complete ? 1 : 0)
        }
      } else {
        expect(resultOnlyCard.verifier).not.toHaveProperty('needsDetail')
        expect(resultOnly).toMatchObject({ diagnosisProgress: { ready: true, diagnosed: 1 } })
        expect(receipts()).toHaveLength(1)
      }
    },
  )

  it.each(['process', 'feedback'] as const)(
    'accepts untruncated result_only %s evidence directly from its card',
    async channel => {
      const round = roundFixture({ roundId: 'round-small-structured', status: 'candidate-editing' })
      const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
      round.baseline = baseline
      const runId = baseline.trials[0]!.runId!
      const accesses: Array<{ diagnosisReceipts?: unknown[] }> = []
      const receipts = () => accesses.flatMap(access => access.diagnosisReceipts ?? [])
      const meta = {
        recordEvidenceAccess: (_roundId: string, _sessionId: string, access: typeof accesses[number]) => { accesses.push(access) },
        proposalEvidenceAudit: () => ({ summaryAccessed: true, accessedRefs: [baseline.evalId], diagnosedRunRefs: [],
          citedRefs: [], diagnosisReceipts: receipts() }),
      }
      const service = { activeEntryForSession: () => ({ evolutionId: round.evolutionId, roundId: round.roundId,
        parentHarnessRef: round.targetHarnessRef, workspace: {}, baseline, meta,
        store: { listRounds: async () => [round] } }) }
      const capabilities = new RefineCapabilities(service as never, {} as HarnessBuilder, {
        trajectoryReader: {
          inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }),
          inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
            { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'task prompt' }] } },
            { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'candidate answer' }] } } },
          ]),
          inspectTrajectoryEvents: async () => { throw new Error('structured details must not fetch trajectory events') },
          inspectVerifierEvidence: async () => ({ runId, verifier: {
            status: 'result_only',
            scores: { totalScore: 0, ...(channel === 'process' ? { processScore: 0 } : {}), normalization: 'standard' },
            ...(channel === 'process' ? { process: {
              schemaVersion: 1, metric: 'assertions', score: 0, detailStatus: 'components', passed: 0, total: 1, excluded: 0,
              components: [{ id: 'step-1', category: 'assertion', status: 'failed', weight: 1, code: 'missing-output' }],
            } as const } : { feedback: {
              schemaVersion: 1, items: [{ code: 'repair', severity: 'error', message: 'Return the missing output.' }],
            } as const }),
          } }),
        },
      })
      const result = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as { runs: MetaFailureCard[] }
      expect(result.runs[0]!.verifier[channel]).toMatchObject(channel === 'process'
        ? { components: [{ id: 'step-1', status: 'failed', code: 'missing-output' }] }
        : { items: [{ code: 'repair', message: 'Return the missing output.' }] })
      expect(result.runs[0]!.verifier[channel]).not.toHaveProperty('truncated', true)
      expect(result.runs[0]!.verifier).not.toHaveProperty('needsDetail')
      expect(result).toMatchObject({ diagnosisProgress: { ready: true, diagnosed: 1, required: 1, remainingRunIds: [] } })
      expect(receipts()).toHaveLength(1)
    },
  )

  it.each([
    ['complete', 'process'], ['complete', 'feedback'],
    ['result_only', 'process'], ['result_only', 'feedback'],
  ] as const)(
    'bounds %s structured %s cards while preserving complete paged evidence and diagnosis requirements',
    async (status, channel) => {
      const round = roundFixture({ roundId: 'round-bounded-structured', status: 'candidate-editing', heldOutRef: 'held-out-secret' })
      const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
      round.baseline = baseline
      const runId = baseline.trials[0]!.runId!
      const longFeedback = `feedback start top-secret held-out-secret ${'反馈🙂'.repeat(23_040)} feedback tail`
      const longExplanation = `process start top-secret held-out-secret ${'过程🙂'.repeat(6_000)} process tail`
      const trajectoryRefs = Array.from({ length: 100 }, (_, seq) => ({ runId, seqStart: seq, seqEnd: seq }))
      const verifier: HitchVerifierEvidence = { runId, verifier: {
        status,
        scores: { totalScore: 0, ...(channel === 'process' ? { processScore: 0 } : {}), normalization: 'standard' },
        ...(channel === 'process' ? { process: {
          schemaVersion: 1, metric: `assertions-${'\u0000'.repeat(500)}`, score: 0,
          detailStatus: 'components', passed: 0, total: 20, excluded: 0,
          components: Array.from({ length: 20 }, (_, index) => ({
            id: index === 0 ? 'step-0' : `step-${index}-${'\u0000'.repeat(500)}`,
            category: `assertion-${'\u0000'.repeat(500)}`, status: 'failed' as const, weight: 1,
            code: index === 1 ? 'missing-output-\u0000'.repeat(2_000) : 'missing-output',
            publicDetails: index === 0 ? {
              explanation: longExplanation,
              nested: { api_key: 'nested-credential', heldOutAnswer: 'hidden-answer', partitionRef: 'hidden-partition' },
            } : { note: `component detail ${index}` },
            privateDetailsRef: `private-only/step-${index}.json`, trajectoryRefs,
          })),
        } as const } : { feedback: {
          schemaVersion: 1,
          items: Array.from({ length: 20 }, (_, index) => ({
            code: index === 1 ? 'repair-\u0000'.repeat(2_000) : `repair-${index}`, severity: 'error' as const,
            message: index === 0 ? longFeedback : `feedback item ${index} ${'\u0000'.repeat(1_000)}`,
            trajectoryRefs,
          })),
        } as const }),
        // A short legacy failure must not satisfy diagnosis when structured
        // evidence has been omitted from the same card.
        ...(status === 'complete' ? { diagnostics: { ctrf: { json: { results: {
          summary: { passed: 0, failed: 1, skipped: 0 },
          tests: [{ name: 'legacy assertion', status: 'failed', message: 'Legacy failure clue.' }],
        } } } } } : {}),
      } }
      expect(Buffer.byteLength(longFeedback)).toBeGreaterThan(225 * 1024)
      const accesses: Array<{ diagnosisReceipts?: unknown[] }> = []
      const receipts = () => accesses.flatMap(access => access.diagnosisReceipts ?? [])
      const meta = {
        recordEvidenceAccess: (_roundId: string, _sessionId: string, access: typeof accesses[number]) => { accesses.push(access) },
        proposalEvidenceAudit: () => ({ summaryAccessed: true, accessedRefs: [baseline.evalId], diagnosedRunRefs: [],
          citedRefs: [], diagnosisReceipts: receipts() }),
      }
      const service = { activeEntryForSession: () => ({ evolutionId: round.evolutionId, roundId: round.roundId,
        parentHarnessRef: round.targetHarnessRef, workspace: {}, baseline, meta,
        store: { listRounds: async () => [round] } }) }
      const inspectTrajectoryEvents = vi.fn(async () => { throw new Error('structured details must not fetch trajectory events') })
      const capabilities = new RefineCapabilities(service as never, {} as HarnessBuilder, {
        trajectoryReader: {
          inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }),
          inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
            { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'task prompt' }] } },
            { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'candidate answer' }] } } },
          ]),
          inspectTrajectoryEvents,
          inspectVerifierEvidence: async () => verifier,
        },
        secretValues: ['top-secret'], maxTrajectoryPageBytes: 4096,
      })
      const result = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] })
      const card = (result as unknown as { runs: MetaFailureCard[] }).runs[0]!
      const preview = card.verifier[channel]!
      expect(preview).toMatchObject({ truncated: true })
      expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(8_000)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(10_000)
      expect(result).toMatchObject({ diagnosisProgress: { ready: false, diagnosed: 0, required: 1, remainingRunIds: [runId] } })
      expect(card.verifier).toMatchObject({
        status,
        scores: { totalScore: 0, ...(channel === 'process' ? { processScore: 0 } : {}), normalization: 'standard' },
        ...(status === 'complete' ? { failures: [{ name: 'legacy assertion', detail: { text: 'Legacy failure clue.' } }] } : {}),
        needsDetail: true, detailRef: expect.stringMatching(/^detail_[a-f0-9]+$/u),
      })
      if (channel === 'process') {
        expect(card.verifier.process).toMatchObject({ score: 0, passed: 0, total: 20, excluded: 0 })
        const components = card.verifier.process!.components!
        expect(components.length).toBeGreaterThan(0)
        expect(components.length).toBeLessThanOrEqual(5)
        expect(components[0]).not.toHaveProperty('publicDetails')
        expect(components[0]).toHaveProperty('publicDetailsPreview', expect.stringContaining('process start'))
      } else {
        expect(card.verifier.feedback!.items.length).toBeGreaterThan(0)
        expect(card.verifier.feedback!.items.length).toBeLessThanOrEqual(5)
      }
      const rendered = renderTrajectoryResult(result as Parameters<typeof renderTrajectoryResult>[0])
      expect(Buffer.byteLength(rendered)).toBeLessThan(10_000)
      expect(rendered).toMatch(/preview|truncated|omitted/iu)
      expect(rendered).toContain(`[required verifier details: ${card.verifier.detailRef!}]`)
      expect(rendered).not.toContain(channel === 'process' ? 'process tail' : 'feedback tail')
      expect(receipts()).toHaveLength(0)

      const ref = card.verifier.detailRef!
      const tail = channel === 'process' ? 'process tail' : 'feedback tail'
      const found = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: ref, find: tail })
      expect(found).toMatchObject({ detail: { matches: [expect.stringContaining(tail)] } })
      expect(receipts()).toHaveLength(0)
      await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', {}))
        .resolves.toMatchObject({ diagnosisProgress: { ready: false, diagnosed: 0, remainingRunIds: [runId] } })
      const pages: string[] = []
      let nextRef: string | undefined = ref
      while (nextRef !== undefined) {
        const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: nextRef }) as {
          detail: { text: string; complete: boolean }; nextRef?: string
        }
        expect(Buffer.byteLength(page.detail.text)).toBeLessThanOrEqual(4096)
        pages.push(page.detail.text)
        expect(page.detail.complete).toBe(page.nextRef === undefined)
        nextRef = page.nextRef
        if (nextRef !== undefined) expect(receipts()).toHaveLength(0)
      }
      expect(pages.length).toBeGreaterThan(1)
      const detail = pages.join('')
      expect(detail).toContain(channel === 'process'
        ? longExplanation.replace('top-secret', '[REDACTED]').replace('held-out-secret', '[REDACTED_HELD_OUT]')
        : longFeedback.replace('top-secret', '[REDACTED]').replace('held-out-secret', '[REDACTED_HELD_OUT]'))
      expect(detail).toContain(channel === 'process' ? 'component detail 19' : 'feedback item 19')
      expect(detail).toContain('"seqStart": 99')
      if (status === 'complete') expect(detail).toContain('Legacy failure clue.')
      for (const visible of [JSON.stringify(result), rendered, detail, JSON.stringify(found)]) {
        expect(visible).not.toMatch(/top-secret|held-out-secret|privateDetailsRef|private-only|nested-credential|heldOutAnswer|hidden-answer|partitionRef|hidden-partition/u)
      }
      expect(receipts()).toHaveLength(1)
      await expect(capabilities.call('refine-meta', 'meta', 'trajectory.query', {}))
        .resolves.toMatchObject({ diagnosisProgress: { ready: true, diagnosed: 1, required: 1, remainingRunIds: [] } })
      expect(inspectTrajectoryEvents).not.toHaveBeenCalled()
    },
  )

  it('verifies and sanitizes every paged verifier artifact before issuing a diagnosis receipt', async () => {
    const round = roundFixture({ roundId: 'round-paged-verifier', status: 'candidate-editing', heldOutRef: 'held-out-secret' })
    const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
    round.baseline = baseline
    const runId = baseline.trials[0]!.runId!
    const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
    const ctrf = JSON.stringify({ results: {
      summary: { passed: 1, failed: 3, skipped: 0 },
      tests: [{ name: 'api starts', status: 'failed', message: 'connection refused', trace: 'z'.repeat(70_000) }],
      api_token: 'nested-credential',
    } })
    // The Gear-only secret crosses the upstream 64 KiB page boundary.
    const stdout = `${'x'.repeat(65_533)}top-secret held-out-secret tail`
    const sources = new Map([
      ['ctrf.json', { mediaType: 'application/json' as const, text: ctrf }],
      ['test-stdout.txt', { mediaType: 'text/plain' as const, text: stdout }],
    ])
    const accesses: Array<{ diagnosisReceipts?: unknown[] }> = []
    const receipts = () => accesses.flatMap(value => value.diagnosisReceipts ?? [])
    const meta = {
      recordEvidenceAccess: (_roundId: string, _sessionId: string, access: typeof accesses[number]) => { accesses.push(access) },
      proposalEvidenceAudit: () => ({ summaryAccessed: true, accessedRefs: [baseline.evalId], diagnosedRunRefs: [],
        citedRefs: [], diagnosisReceipts: receipts() }),
    }
    const service = { activeEntryForSession: () => ({ evolutionId: round.evolutionId, roundId: round.roundId,
      parentHarnessRef: round.targetHarnessRef, workspace: {}, baseline, meta,
      store: { listRounds: async () => [round] } }) }
    const inspectVerifierDiagnosticPage = vi.fn(async (_runId: string, query: Readonly<HitchVerifierDiagnosticPageQuery>) => {
      const source = sources.get(query.name)!
      const offset = query.offset ?? 0
      const limit = query.limit ?? 64 * 1024
      const text = source.text.slice(offset, offset + limit)
      const nextOffset = offset + Buffer.byteLength(text)
      return {
        schemaVersion: 1 as const,
        kind: 'verifier-diagnostic-page' as const,
        runId,
        artifact: {
          name: query.name,
          mediaType: source.mediaType,
          bytes: Buffer.byteLength(source.text),
          sha256: digest(source.text),
          sourceComplete: true,
        },
        page: {
          offset,
          bytes: Buffer.byteLength(text),
          text,
          eof: nextOffset === Buffer.byteLength(source.text),
          ...(nextOffset === Buffer.byteLength(source.text) ? {} : { nextOffset }),
        },
      }
    })
    const capabilities = new RefineCapabilities(service as never, {} as HarnessBuilder, {
      trajectoryReader: {
        inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1,
          verifierEvidence: 1 }),
        inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
          { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Start the API.' }] } },
        ]),
        inspectTrajectoryEvents: async () => { throw new Error('verifier details must not use trajectory events') },
        inspectVerifierEvidence: async () => ({ runId, verifier: {
          status: 'complete',
          result: { rewards: { reward: 0 } },
          resultSha256: `sha256:${'8'.repeat(64)}`,
          diagnostics: {
            ctrf: { name: 'ctrf.json', media_type: 'application/json', bytes: Buffer.byteLength(ctrf),
              sha256: digest(ctrf), truncated: true, text: 'clipped ctrf preview' },
            stdout: [{ name: 'test-stdout.txt', media_type: 'text/plain', bytes: Buffer.byteLength(stdout),
              sha256: digest(stdout), truncated: true, text: 'clipped stdout preview' }],
          },
        } }),
        inspectVerifierDiagnosticPage,
      },
      secretValues: ['top-secret', 'nested-credential'],
      maxTrajectoryPageBytes: 4096,
    })
    const result = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as { runs: MetaFailureCard[] }
    const detailRef = result.runs[0]!.verifier.detailRef!
    expect(result.runs[0]!.verifier).toMatchObject({ needsDetail: true })
    expect(receipts()).toHaveLength(0)

    const pages: string[] = []
    let nextRef: string | undefined = detailRef
    while (nextRef !== undefined) {
      const page = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { detailRef: nextRef }) as {
        detail: { text: string; complete: boolean }; nextRef?: string
      }
      pages.push(page.detail.text)
      nextRef = page.nextRef
      expect(receipts()).toHaveLength(page.detail.complete ? 1 : 0)
    }
    const detail = pages.join('')
    expect(inspectVerifierDiagnosticPage.mock.calls.map(call => call[1].name)).toEqual([
      'ctrf.json', 'ctrf.json', 'test-stdout.txt', 'test-stdout.txt',
    ])
    expect(detail).toContain('connection refused')
    expect(detail).toContain('tail')
    expect(detail).toContain('"api_token": "[REDACTED]"')
    expect(detail).not.toMatch(/top-secret|held-out-secret|nested-credential/u)
    expect(receipts()).toHaveLength(1)
  })

  it.each([
    ['missing paging capability', undefined, 'upgrade', 'verifier_diagnostic_pages_unsupported'],
    ['legacy truncated source', 'legacy_truncated', 'repair', 'legacy_truncated'],
  ] as const)('classifies %s without accepting incomplete verifier evidence', async (_label, lossReason, action, cause) => {
    const round = roundFixture({ roundId: `round-${action}-verifier`, status: 'candidate-editing' })
    const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
    round.baseline = baseline
    const runId = baseline.trials[0]!.runId!
    const text = 'persisted excerpt'
    const sha256 = `sha256:${createHash('sha256').update(text).digest('hex')}`
    const meta = { recordEvidenceAccess: () => {}, proposalEvidenceAudit: () => ({ summaryAccessed: true,
      accessedRefs: [baseline.evalId], diagnosedRunRefs: [], citedRefs: [], diagnosisReceipts: [] }) }
    const recordMetaPrerequisiteBlocker = vi.fn(async () => {})
    const service = { activeEntryForSession: () => ({ evolutionId: round.evolutionId, roundId: round.roundId,
      parentHarnessRef: round.targetHarnessRef, workspace: {}, baseline, meta,
      store: { listRounds: async () => [round] } }), recordMetaPrerequisiteBlocker }
    const pageReader = lossReason === undefined ? {} : {
      inspectVerifierDiagnosticPage: async () => ({
        schemaVersion: 1 as const, kind: 'verifier-diagnostic-page' as const, runId,
        artifact: { name: 'test-stdout.txt' as const, mediaType: 'text/plain' as const,
          bytes: Buffer.byteLength(text), sha256, sourceComplete: false, lossReason },
        page: { offset: 0, bytes: 0, text: '', eof: true },
      }),
    }
    const capabilities = new RefineCapabilities(service as never, {} as HarnessBuilder, {
      trajectoryReader: {
        inspectCapabilities: async () => ({ schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }),
        inspectTrajectoryAnalysis: async () => trajectoryAnalysis(runId, [
          { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
        ]),
        inspectTrajectoryEvents: async () => { throw new Error('unexpected trajectory event read') },
        inspectVerifierEvidence: async () => ({ runId, verifier: { status: 'complete', result: {},
          resultSha256: `sha256:${'8'.repeat(64)}`, diagnostics: { stdout: [{
            name: 'test-stdout.txt', media_type: 'text/plain', bytes: Buffer.byteLength(text), sha256,
            truncated: true, text,
          }] } } }),
        ...pageReader,
      },
    })
    const card = await capabilities.call('refine-meta', 'meta', 'trajectory.query', { refs: [runId] }) as { runs: MetaFailureCard[] }
    const blocked = await capabilities.call('refine-meta', 'meta', 'trajectory.query', {
      detailRef: card.runs[0]!.verifier.detailRef!,
    })
    const resolution = action === 'upgrade' ? 'upgrade-hitch' : 'repair-evidence'
    expect(blocked).toMatchObject({
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      blockedRuns: [{ runId, resolution, cause }],
      operatorAction: { [action]: expect.any(String), runIds: [runId], reason: cause },
    })
    expect(blocked).not.toMatchObject({ operatorAction: { [action === 'upgrade' ? 'repair' : 'upgrade']: expect.anything() } })
    await expect(capabilities.call('refine-meta', 'meta', 'candidate.decline', {
      rationale: 'The required verifier evidence cannot be diagnosed.', evidenceRefs: [baseline.evalId],
    })).resolves.toMatchObject({ accepted: false, recoverable: false, code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE' })
    expect(recordMetaPrerequisiteBlocker).toHaveBeenCalledWith('meta', {
      schemaVersion: 1,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      failedOperation: 'candidate.decline',
      blockedRuns: [{ runId, code: expect.any(String), cause, resolution }],
    })
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
        arguments: { refs: [baseline.trials[0]!.runId] },
      },
      retry: { tool: 'finalize_candidate', reusePreviousArguments: true },
    })
    expect(proposalAttribution).not.toHaveBeenCalled()
    expect(submitFinalization).not.toHaveBeenCalled()
  })
})
