import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { contentExcerpt, projectTrajectory } from '../../src/evaluator/trajectory-projection.js'
import type {
  DiagnosisReceipt,
  GearFailureBundle,
  HitchTrajectory,
  TrajectoryDiagnostics,
  TrajectoryProjection,
} from '../../src/types.js'

function diagnostics(events: HitchTrajectory['events']): TrajectoryDiagnostics {
  const eventTypes: Record<string, number> = {}
  for (const value of events) {
    const event = value as { type?: string }
    const type = event.type ?? 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }
  return {
    totalEvents: events.length,
    eventTypes,
    toolCalls: eventTypes['tool/call'] ?? 0,
    toolResults: eventTypes['tool/result'] ?? 0,
    toolErrors: 0,
    errorExcerpts: [],
    finalAssistantExcerpts: [],
  }
}

function trajectory(
  events: HitchTrajectory['events'],
  fidelity: HitchTrajectory['fidelity'] = 'provider_native',
): HitchTrajectory {
  return {
    runId: `run_${'1'.repeat(32)}`,
    fidelity,
    provider: 'deepseek',
    sessionId: 'session-1',
    trajectoryDigest: `sha256:${'a'.repeat(64)}`,
    bytes: Buffer.byteLength(JSON.stringify(events)),
    ref: {},
    header: { version: 0, id: 'session-1', createdAt: 1 },
    events,
    diagnostics: diagnostics(events),
  }
}

describe('trajectory projection', () => {
  it('truncates excerpts on valid UTF-8 character boundaries', () => {
    const result = contentExcerpt('run-1', '甲乙丙丁戊己庚辛', 'message', 1, 11)
    expect(result.truncated).toBe(true)
    expect(result.preview).not.toContain('\uFFFD')
    expect(result.tail).not.toContain('\uFFFD')
  })

  it('uses DSH replacement semantics to reconstruct request context epochs', () => {
    const events = [
      {
        type: 'user/message', seq: 0, time: 1,
        data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'old prompt' }] },
        surfaceOp: 'append',
      },
      {
        type: 'request/header', seq: 1, time: 2,
        data: { reason: 'initial', header: { config: { provider: 'p', model: 'm' }, system: 'system-1' } },
      },
      {
        type: 'assistant/message', seq: 2, time: 3,
        data: {
          turn: 1, step: 1,
          message: {
            role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'text', text: 'old answer' }],
          },
        },
        surfaceOp: 'append',
      },
      {
        type: 'user/message', seq: 3, time: 4,
        data: {
          role: 'user', id: 'u2', source: { kind: 'plugin', plugin: 'compaction' },
          content: [{ type: 'text', text: 'compacted summary' }],
        },
        surfaceOp: { op: 'replace', start: 0, end: 2 },
        sourceEventSeqs: [0, 2],
      },
      {
        type: 'request/header', seq: 4, time: 5,
        data: { reason: 'change', header: { config: { provider: 'p', model: 'm2' }, system: 'system-2' } },
      },
    ]
    const result = projectTrajectory(trajectory(events))
    expect(result.fidelity).toBe('exact-surface')
    expect(result.replacements).toEqual([{ seq: 3, start: 0, end: 2, shadowedSeqs: [0, 2] }])
    expect(result.contextEpochs).toMatchObject([
      { requestSeq: 1, surfaceMessageSeqs: [0], replacementGeneration: 0 },
      { requestSeq: 4, surfaceMessageSeqs: [3], replacementGeneration: 1 },
    ])
  })

  it('captures the effective surface immediately before each step model request', () => {
    const message = (role: 'user' | 'assistant', id: string, value: string) => ({
      role, id, source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'text', text: value }],
    })
    const result = projectTrajectory(trajectory([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: message('user', 'u1', 'initial'), surfaceOp: 'append' },
      {
        type: 'request/header', seq: 3, time: 4,
        data: {
          reason: 'initial',
          header: {
            config: { provider: 'p', model: 'm', maxTokens: 1_000 },
            adapterDefaults: { maxTokens: true },
          },
        },
      },
      { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: '...' } },
      { type: 'assistant/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: message('assistant', 'a1', 'first') }, surfaceOp: 'append' },
      { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 1, step: 2 } },
      { type: 'user/message', seq: 8, time: 9, data: message('user', 'u2', 'tool result'), surfaceOp: 'append' },
      { type: 'assistant/chunk', seq: 9, time: 10, data: { turn: 1, step: 2, chunk: '...' } },
      { type: 'assistant/message', seq: 10, time: 11, data: { turn: 1, step: 2, message: message('assistant', 'a2', 'second') }, surfaceOp: 'append' },
    ]))
    expect(result.contextEpochs).toMatchObject([
      {
        turn: 1, step: 1, boundarySeq: 4, requestSeq: 3, surfaceMessageSeqs: [2],
        header: { adapterDefaults: { maxTokens: true } },
      },
      {
        turn: 1, step: 2, boundarySeq: 9, requestSeq: 3, surfaceMessageSeqs: [2, 5, 8],
        header: { adapterDefaults: { maxTokens: true } },
      },
    ])
  })

  it('pairs tool results and preserves structured tool errors', () => {
    const result = projectTrajectory(trajectory([
      {
        type: 'tool/call', seq: 0, time: 1,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'edit', arguments: '{"path":"/app/a.txt"}' },
      },
      {
        type: 'tool/result', seq: 1, time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'user', id: 'result-1', source: { kind: 'tool', callId: 'call-1' },
            content: [{
              type: 'tool-result', toolCallId: 'call-1', isError: true,
              content: [{ type: 'text', text: 'invalid edit arguments' }],
            }],
          },
        },
      },
    ]))
    expect(result.semanticSteps).toMatchObject([{ toolActions: [{
      callId: 'call-1',
      resultSeq: 1,
      status: 'errored',
      error: { name: 'ToolResultError', code: 'TOOL_RESULT_ERROR' },
    }] }])
    expect(result.errors).toContainEqual({
      seq: 1,
      type: 'tool/result',
      excerpt: 'ToolResultError: TOOL_RESULT_ERROR',
    })
    expect(result.pathsObservedThroughTools).toEqual(['/app/a.txt'])
  })

  it('does not issue exact-surface fidelity for normalized or minimal source evidence', () => {
    const events = [{
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] },
    }]
    expect(projectTrajectory(trajectory(events, 'normalized')).fidelity).toBe('normalized-surface')
    expect(projectTrajectory(trajectory(events, 'minimal')).fidelity).toBe('minimal')
  })

  it('condenses assembled-message chunk provenance into a bounded range', () => {
    const sourceEventSeqs = Array.from({ length: 10_000 }, (_, index) => index + 1)
    const result = projectTrajectory(trajectory([{
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', sourceEventSeqs,
      data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] },
    }]))
    expect(result.messages[0]?.sourceEventSeqs).toEqual({ count: 10_000, first: 1, last: 10_000 })
    expect(Buffer.byteLength(JSON.stringify(result.messages[0]))).toBeLessThan(1_000)
  })

  it('keeps an oversized single-run bundle actionable within the minimum output budget', () => {
    const result = projectTrajectory(trajectory([
      {
        type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix it' }] },
      },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'request/header', seq: 3, time: 4,
        data: { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } },
      },
      {
        type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'text', text: 'x'.repeat(50_000) }],
          },
        },
      },
      {
        type: 'tool/call', seq: 5, time: 6,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: { path: `/app/${'p'.repeat(10_000)}` } },
      },
      { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1, reason: { detail: 'z'.repeat(50_000) } } },
    ]))
    result.contextEpochs[0]!.header.config = { huge: 'c'.repeat(100_000) }
    result.contextEpochs[0]!.surfaceMessageSeqs = Array.from({ length: 100_000 }, (_, index) => index)
    result.pathsObservedThroughTools = Array.from({ length: 2_000 }, (_, index) => `/app/${index}-${'p'.repeat(1_000)}`)
    result.omittedEventTypes = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`event-${index}-${'e'.repeat(100)}`, 1]))
    result.semanticSteps[0]!.terminalReason = { detail: 'z'.repeat(100_000) }
    const bundleBuilder = new RefineCapabilities({} as never, {} as never, {
      maxTrajectoryPageBytes: 4 * 1024,
      maxFailureBundleBytes: 4 * 1024,
      allowUnavailableVerifierDiagnosis: true,
      secretValues: ['top-secret'],
    }) as unknown as {
      failureBundle(
        item: never,
        projection: TrajectoryProjection,
        verifier: never,
        heldOutRef: string | undefined,
        maxBytes: number,
      ): GearFailureBundle
      diagnosisReceipt(
        bundle: GearFailureBundle,
        trajectoryDigest: string,
        verifierStatus: 'corrupt',
      ): DiagnosisReceipt
    }
    const bundle = bundleBuilder.failureBundle({
      evolutionId: 'evolution', roundId: 'round', phase: 'seed-baseline', evalId: 'eval',
      trial: {
        taskName: `task-${'t'.repeat(100_000)}`,
        trialName: `trial-${'n'.repeat(100_000)}`,
        runId: result.runId,
        status: 'completed',
        rewards: { reward: 0 },
        invalidReason: `reason-${'r'.repeat(100_000)}`,
      },
    } as never, result, {
      runId: result.runId,
      verifier: {
        status: 'corrupt',
        result: {
          token: 'top-secret',
          held_out_metric: 'must-not-leak',
          payload: 'v'.repeat(20_000),
        },
      },
    } as never, 'private-partition', 4 * 1024)
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(4 * 1024)
    expect(bundle.trajectory.keySteps).toHaveLength(1)
    expect(bundle.trajectory.omittedEventTypeCount).toBeGreaterThan(0)
    expect(bundle.workspace.omittedPathCount).toBeGreaterThan(0)
    expect(bundle.identity.taskNameTruncated).toBe(true)
    expect(bundle.coverage.verifier).toBe('unavailable')
    expect(JSON.stringify(bundle)).not.toContain('top-secret')
    expect(JSON.stringify(bundle)).not.toContain('held_out_metric')
    expect(JSON.stringify(bundle)).not.toContain('must-not-leak')
    expect(bundleBuilder.diagnosisReceipt(bundle, result.trajectoryDigest, 'corrupt').compatibility).toBeUndefined()
  })

  const tb21Path = resolve('.debug/fixtures/tb21-eval-b716/trajectory-inspect-write-compressor.json')
  it.skipIf(!existsSync(tb21Path))('projects the tb21 write-compressor fixture without chunk noise', () => {
    const source = JSON.parse(readFileSync(tb21Path, 'utf8')) as {
      run_id: string
      ref: { fidelity: HitchTrajectory['fidelity']; provider?: string; sha256: string }
      header: HitchTrajectory['header'] & { id: string }
      events: HitchTrajectory['events']
    }
    const result = projectTrajectory({
      runId: source.run_id,
      fidelity: source.ref.fidelity,
      ...(source.ref.provider === undefined ? {} : { provider: source.ref.provider }),
      sessionId: source.header.id,
      trajectoryDigest: source.ref.sha256,
      bytes: readFileSync(tb21Path).byteLength,
      ref: source.ref,
      header: source.header,
      events: source.events,
      diagnostics: diagnostics(source.events),
    })
    expect(result.rawEventCount).toBe(103_479)
    expect(result.eventTypes['assistant/chunk']).toBe(103_321)
    expect(result.omittedEventTypes['assistant/chunk']).toBe(103_321)
    expect(result.messages).toHaveLength(59)
    expect(result.semanticSteps).toHaveLength(28)
    const toolActions = result.semanticSteps.flatMap(step => step.toolActions)
    expect(toolActions).toHaveLength(29)
    expect(toolActions.filter(action => action.status === 'errored')).toHaveLength(2)
    expect(result.contextEpochs).toHaveLength(28)
    expect(result.contextEpochs[0]).toMatchObject({
      boundarySeq: 13,
      requestSeq: 10,
      header: {
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        adapterDefaults: { reasoningEffort: true, maxTokens: true },
      },
      surfaceMessageSeqs: [7, 8],
    })
    expect(result.semanticSteps.every(step => step.contextEpochId !== undefined)).toBe(true)
    expect(result.contextEpochs[1]).toMatchObject({
      turn: 1,
      step: 2,
      requestSeq: 10,
    })
    expect(result.contextEpochs[1]!.surfaceMessageSeqs.length).toBeGreaterThan(2)
    expect(result.messages.some(message => (message.sourceEventSeqs?.count ?? 0) > 1_000)).toBe(true)
    expect(Math.max(...result.messages.map(message => Buffer.byteLength(JSON.stringify(message))))).toBeLessThan(5_000)
    const bundleBuilder = new RefineCapabilities({} as never, {} as never, {
      maxTrajectoryPageBytes: 128 * 1024,
      maxFailureBundleBytes: 128 * 1024,
      allowUnavailableVerifierDiagnosis: true,
    }) as unknown as {
      failureBundle(
        item: never,
        projection: TrajectoryProjection,
        verifier: never,
        heldOutRef: undefined,
        maxBytes: number,
      ): GearFailureBundle
    }
    const bundle = bundleBuilder.failureBundle({
      evolutionId: 'evolution-fixture', roundId: 'round-fixture', phase: 'seed-baseline', evalId: 'eval-fixture',
      trial: { taskName: 'write-compressor', runId: source.run_id, status: 'completed', rewards: { reward: 0 } },
    } as never, result, { runId: result.runId, verifier: { status: 'unavailable' } } as never,
    undefined, Math.floor(128 * 1024 / 5))
    expect(bundle.trajectory.keySteps.length).toBeGreaterThanOrEqual(1)
    expect(bundle.trajectory.contextEpochs[0]?.header.adapterDefaultsExcerpt?.preview)
      .toContain('reasoningEffort')
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(Math.floor(128 * 1024 / 5))
    expect(result.fidelity).toBe('exact-surface')
    expect(JSON.stringify(result.messages)).not.toContain('assistant/chunk')
  })
})
