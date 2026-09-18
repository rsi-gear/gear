import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentExcerpt, projectTrajectory } from '../../src/evaluator/trajectory-projection.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'
import type { HitchTrajectoryAnalysis } from '../../src/types.js'

function trajectory(
  events: readonly unknown[],
  fidelity: HitchTrajectoryAnalysis['source']['fidelity'] = 'provider_native',
): HitchTrajectoryAnalysis {
  return trajectoryAnalysis(`run_${'1'.repeat(32)}`, events, fidelity)
}

describe('trajectory projection', () => {
  it('truncates excerpts on valid UTF-8 character boundaries', () => {
    const result = contentExcerpt('run-1', '甲乙丙丁戊己庚辛', 'message', 1, 11)
    expect(result.truncated).toBe(true)
    expect(result.preview).not.toContain('\uFFFD')
    expect(result.tail).not.toContain('\uFFFD')
  })

  it('redacts sensitive keys inside structured values and JSON strings before excerpting', () => {
    const structured = contentExcerpt('run-1', {
      command: 'ok', authorization: 'Bearer leaked', nested: { password: 'also-leaked' },
    }, 'arguments', 1)
    const encoded = contentExcerpt('run-1', JSON.stringify({ token: 'leaked-token', path: '/safe' }), 'arguments', 2)
    expect(structured.preview).toContain('"authorization":"[REDACTED]"')
    expect(structured.preview).toContain('"password":"[REDACTED]"')
    expect(structured.preview).not.toContain('Bearer leaked')
    expect(encoded.preview).toContain('"token":"[REDACTED]"')
    expect(encoded.preview).not.toContain('leaked-token')
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
      { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 1, step: 2, chunk: '...' } },
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

  it('preserves task, final-answer, and tool pairing when complete surface messages are excerpts', () => {
    const analysis = trajectory([
      {
        type: 'user/message', surfaceOp: 'append',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'very long task' }] },
      },
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' },
      },
      {
        type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [1],
        data: {
          turn: 1, step: 1,
          message: {
            role: 'user', source: { kind: 'tool', callId: 'call-1' },
            content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'long result' }] }],
          },
        },
      },
      {
        type: 'assistant/message', surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'very long final answer' }] },
        },
      },
    ])
    analysis.surface.nodes[0]!.message = contentExcerpt(analysis.runId, 'very long task', 'message', 0, 4) as never
    analysis.surface.nodes[1]!.message = contentExcerpt(analysis.runId, 'very long result', 'message', 2, 4) as never
    analysis.surface.nodes[2]!.message = contentExcerpt(analysis.runId, 'very long final answer', 'message', 3, 4) as never
    const result = projectTrajectory(analysis)
    expect(result.messages).toMatchObject([
      { seq: 0, eventType: 'user/message', role: 'user' },
      { seq: 2, eventType: 'tool/result', role: 'tool' },
      { seq: 3, eventType: 'assistant/message', role: 'assistant' },
    ])
    expect(result.semanticSteps).toMatchObject([{ toolActions: [{
      callId: 'call-1', callSeq: 1, resultSeq: 2, status: 'unknown',
    }] }])
    expect(result.errors).toContainEqual(expect.objectContaining({ seq: 2, type: 'tool/result-status-unknown' }))
    expect(result.finalAnswer).toMatchObject({ seq: 3, role: 'assistant' })
  })

  it('does not expose wrapper metadata or sensitive JSON from source-provided excerpts', () => {
    const analysis = trajectory([{
      type: 'assistant/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    }])
    analysis.surface.nodes[0]!.message = {
      preview: '{"type":"assistant/message","seq":0,"data":{"message":{"authorization":"Bearer leaked',
      tail: '","source":{"run_id":"internal","field":"event"}}}',
      bytes: 10_000,
      sha256: `sha256:${'a'.repeat(64)}`,
      truncated: true,
      source: { runId: analysis.runId, seq: 0, field: 'event' },
    }
    const result = projectTrajectory(analysis)
    expect(result.messages[0]?.message).toMatchObject({
      preview: '[Long data.message; open its detailRef to inspect the content.]',
      truncated: true,
      source: { seq: 0, field: 'data.message' },
    })
    expect(JSON.stringify(result.messages[0])).not.toMatch(/Bearer leaked|run_id|"field":"event"/u)
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

  it('keeps incomplete reasoning and parallel tool argument streams separate after a timeout', () => {
    const analysis = trajectory([])
    const streams = [
      {
        blockIndex: 0, blockStartSeq: 18, kind: 'reasoning' as const, sourceSeqCount: 2,
        value: 'Locate the contact before updating the phone.',
      },
      {
        blockIndex: 1, blockStartSeq: 37, kind: 'tool_arguments' as const, sourceSeqCount: 2,
        value: '{"query":"SELECT id FROM contacts WHERE name = \\"Avery',
      },
      {
        blockIndex: 2, blockStartSeq: 43, kind: 'tool_arguments' as const, sourceSeqCount: 1,
        value: '{"phone":"+1-555-014',
      },
    ].map(({ value, ...stream }) => ({
      ...stream,
      content: {
        ...contentExcerpt(analysis.runId, value, 'data.chunk.delta', stream.blockStartSeq),
        source: { runId: analysis.runId, seq: stream.blockStartSeq, field: 'data.chunk.delta' },
      },
    }))
    analysis.chunkSummaries = [{
      turn: 1, step: 1, attempt: 0, modelBoundarySeq: 17,
      firstSeq: 17, lastSeq: 46, count: 8,
      types: { 'block-start': 3, 'block-delta': 5 },
      partial: { status: 'incomplete', sourceSeqCount: 5, streams },
    }]

    const request = projectTrajectory(analysis).semanticSteps[0]?.modelRequests?.[0]
    expect(request?.partial).toEqual({ status: 'incomplete', sourceSeqCount: 5, streams })
    expect(request?.partial).not.toHaveProperty('content')
    expect(request?.partial?.streams?.map(stream => stream.content.source.seq)).toEqual([18, 37, 43])
    expect(request?.partial?.streams?.map(stream => stream.content.preview)).toEqual([
      'Locate the contact before updating the phone.',
      '{"query":"SELECT id FROM contacts WHERE name = \\"Avery',
      '{"phone":"+1-555-014',
    ])
  })

  it('preserves the legacy incomplete request content format', () => {
    const analysis = trajectory([])
    const content = {
      ...contentExcerpt(analysis.runId, 'Unfinished answer', 'data.chunk.delta', 4),
      source: { runId: analysis.runId, seq: 4, field: 'data.chunk.delta' },
    }
    analysis.chunkSummaries = [{
      turn: 1, step: 1, attempt: 0, modelBoundarySeq: 4,
      firstSeq: 4, lastSeq: 6, count: 3, types: { 'text-delta': 3 },
      partial: { status: 'incomplete', sourceSeqCount: 3, content },
    }]

    const partial = projectTrajectory(analysis).semanticSteps[0]?.modelRequests?.[0]?.partial
    expect(partial).toEqual({ status: 'incomplete', sourceSeqCount: 3, content })
    expect(partial).not.toHaveProperty('streams')
  })

  it('keeps oversized message and tool content bounded with correct internal source fields', () => {
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
    expect(result.messages.find(message => message.role === 'assistant')?.message).toMatchObject({
      truncated: true,
      source: { seq: 4, field: 'data.message' },
    })
    expect(result.semanticSteps[0]?.toolActions[0]?.arguments).toMatchObject({
      truncated: true,
      source: { seq: 5, field: 'data.arguments' },
    })
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(5_000)
  })

  const tb21Path = resolve('.debug/fixtures/tb21-eval-b716/trajectory-inspect-write-compressor.json')
  it.skipIf(!existsSync(tb21Path))('projects the tb21 write-compressor fixture without chunk noise', () => {
    const source = JSON.parse(readFileSync(tb21Path, 'utf8')) as {
      run_id: string
      ref: { fidelity: HitchTrajectoryAnalysis['source']['fidelity']; provider?: string; sha256: string }
      header: { id: string }
      events: unknown[]
    }
    const result = projectTrajectory(trajectoryAnalysis(source.run_id, source.events, source.ref.fidelity))
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
    expect(result.fidelity).toBe('exact-surface')
    expect(JSON.stringify(result.messages)).not.toContain('assistant/chunk')
  })
})
