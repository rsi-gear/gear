import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { projectTrajectory } from '../../src/evaluator/trajectory-projection.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineStateStore } from '../../src/state/store.js'
import type {
  HitchEvaluationEvidence,
  HitchTrajectoryAnalysis,
  HitchTrajectoryReader,
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
    const service = { activeEntryForSession: () => ({
      evolutionId: 'evo-1', roundId: round.roundId, store, meta, baseline: seedBaseline,
      workspace: { workspaceId: 'workspace-1' },
    }) }
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
