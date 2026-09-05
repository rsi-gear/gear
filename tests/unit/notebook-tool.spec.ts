import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { mountMetaCapabilityTools, renderNotebookResult, renderTrajectoryResult } from '../../src/notebook/tool.js'

describe('Meta notebook tools', () => {
  it('renders Python None/null as normal no-output instead of throwing', () => {
    expect(renderNotebookResult('', '', null)).toBe('<no output>')
    expect(renderNotebookResult('hello\n', '', null)).toBe('hello\n')
  })

  it('mounts schema-rich typed tools alongside IPython', async () => {
    const tools: ToolDefinition[] = []
    const sections: Array<{ name: string; text: string }> = []
    const call = vi.fn(async (_sessionId: string, method: string, params: unknown) => ({ method, params }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section(value: { name: string; text: string }) { sections.push(value) } },
    } as unknown as Context
    mountMetaCapabilityTools(context, call, { shellEnabled: true })
    expect(tools.map(tool => tool.name)).toEqual([
      'harness_current',
      'harness_read',
      'seed_tasks_load',
      'trajectory_query',
      'hitch_status',
      'candidate_diff',
      'candidate_check',
      'finalize_candidate',
      'decline_candidate',
    ])
    expect(sections[0]?.text).toContain('diagnostic card for every failed baseline run')
    expect(sections[0]?.text).toContain('accepted=false and recoverable=true')
    expect(sections[0]?.text).toContain('TRAJECTORY_EVIDENCE_UNAVAILABLE')
    expect(sections[0]?.text).toContain('sandboxed bash')
    expect(sections[0]?.text).toContain('current candidate tree is a starting state')
    expect(sections[0]?.text).toContain('compare an executable hook or verifier with prompt guidance')
    const trajectory = tools.find(tool => tool.name === 'trajectory_query')!
    expect(Object.keys((trajectory.parameters as { properties: object }).properties)).toEqual(['refs', 'detailRef', 'find'])
    await trajectory.execute({ refs: ['run_1'] }, {
      agent: { id: 'meta-1' },
      signal: new AbortController().signal,
    } as never)
    expect(call).toHaveBeenCalledWith(
      'meta-1',
      'trajectory.query',
      { refs: ['run_1'] },
      expect.any(AbortSignal),
    )
  })

  it('renders diagnostic cards as a compact UI-like transcript', () => {
    const rendered = renderTrajectoryResult({
      runs: [{
        task: 'compile-extension',
        runId: 'run_1',
        outcome: { status: 'completed', reward: 0 },
        verifier: { status: 'complete', summary: '3 passed, 1 failed.' },
        transcript: {
          earlierRef: 'detail_0',
          text: 'TOOL bash · errored\ninput: pytest -q\noutput: one failure\n[more: detail_1]',
        },
      }],
    } as never)
    expect(rendered).toContain('TASK compile-extension')
    expect(rendered).toContain('[earlier messages: detail_0]')
    expect(rendered).toContain('TOOL bash · errored')
    expect(rendered).toContain('[more: detail_1]')
    expect(rendered).not.toContain('schemaVersion')
    expect(rendered).not.toMatch(/SCORES|PROCESS|COMPONENT|FEEDBACK/u)
  })

  it('renders structured verifier evidence through the default trajectory tool output', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({
      runs: [{
        task: 'send-message', runId: 'run_1',
        outcome: { status: 'completed', reward: 0 },
        verifier: {
          status: 'complete', summary: 'Verifier diagnostics are available.',
          scores: { totalScore: 0, processScore: 0.5, normalization: 'standard' },
          process: {
            schemaVersion: 1, metric: 'partial_credit', score: 0.5, detailStatus: 'components',
            passed: 1, total: 2, excluded: 1,
            components: [
              { id: 'setup', category: 'environment', status: 'passed', weight: 1 },
              {
                id: 'send', category: 'message-sent', status: 'failed', weight: 1, code: 'recipient-mismatch',
                publicDetails: { expected: 'team channel', actual: 'personal inbox' },
                trajectoryRefs: [{ runId: 'run_1', seqStart: 7, seqEnd: 9 }],
              },
              { id: 'cleanup', category: 'environment', status: 'excluded', weight: 1, code: 'not-applicable' },
            ],
          },
          feedback: {
            schemaVersion: 1,
            items: [{
              code: 'wrong-channel', severity: 'error', message: 'Send the message to the requested team channel.',
              componentIds: ['send'], trajectoryRefs: [{ runId: 'run_1', seqStart: 7, seqEnd: 9 }],
            }],
          },
          detailRef: 'detail_structured', needsDetail: true,
        },
        transcript: { text: 'ASSISTANT\nMessage sent.' },
      }],
    }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call)
    const trajectory = tools.find(tool => tool.name === 'trajectory_query')!
    const args = { refs: ['run_1'] }
    const result = await trajectory.execute(args, {
      agent: { id: 'meta-1' }, signal: new AbortController().signal,
    } as never)
    const blocks = trajectory.output!.render(args, result as JsonValue)
    expect(blocks).toEqual([{ type: 'text', text: expect.any(String) }])
    const rendered = (blocks[0] as { text: string }).text
    expect(rendered).toContain('SCORES · total 0 · process 0.5 · normalization standard')
    expect(rendered).toContain('PROCESS partial_credit · score 0.5 · components · 1 passed · 2 total · 1 excluded')
    expect(rendered).toContain('COMPONENT setup · passed · environment · weight 1')
    expect(rendered).toContain('COMPONENT send · failed · message-sent · weight 1 · code recipient-mismatch')
    expect(rendered).toContain('public details: {"expected":"team channel","actual":"personal inbox"}')
    expect(rendered).toContain('COMPONENT cleanup · excluded · environment · weight 1 · code not-applicable')
    expect(rendered).toContain('FEEDBACK error · wrong-channel\nSend the message to the requested team channel.')
    expect(rendered).toContain('components: ["send"]')
    expect(rendered).toContain('trajectory refs: [{"runId":"run_1","seqStart":7,"seqEnd":9}]')
    expect(rendered).toContain('[required verifier details: detail_structured]')
    expect(rendered).toContain('MESSAGES\nASSISTANT\nMessage sent.')
    expect(rendered).not.toContain('schemaVersion')
  })

  it.each(['standard', 'legacy-reward'])('renders %s total-only scores without inventing process evidence', normalization => {
    const rendered = renderTrajectoryResult({
      runs: [{
        verifier: { status: 'result_only', summary: 'Final score only.', scores: { totalScore: 1, normalization } },
      }],
    })
    expect(rendered).toContain(`SCORES · total 1 · normalization ${normalization}`)
    expect(rendered).not.toMatch(/ · process |PROCESS|COMPONENT|FEEDBACK|undefined/u)
  })

  it('renders aggregate-only process evidence without inventing component counts', () => {
    const rendered = renderTrajectoryResult({
      runs: [{
        verifier: {
          status: 'complete', summary: 'Aggregate process evidence.',
          process: { schemaVersion: 1, metric: 'partial_credit', score: 0, detailStatus: 'aggregate-only' },
          feedback: { schemaVersion: 1, items: [] },
          detailRef: 'detail_aggregate',
        },
      }],
    })
    expect(rendered).toContain('PROCESS partial_credit · score 0 · aggregate-only')
    expect(rendered).toContain('FEEDBACK · no items')
    expect(rendered).toContain('[verifier details: detail_aggregate]')
    expect(rendered).not.toMatch(/SCORES|COMPONENT|\d+ passed|\d+ total|\d+ excluded|undefined/u)
  })

  it('renders feedback even when process evidence is unavailable', () => {
    const rendered = renderTrajectoryResult({
      runs: [{
        verifier: {
          status: 'complete', summary: 'Feedback only.',
          feedback: {
            schemaVersion: 1,
            items: [{ code: 'timeout', severity: 'warning', message: 'Execution exceeded the task time limit.' }],
          },
        },
      }],
    })
    expect(rendered).toContain('FEEDBACK warning · timeout\nExecution exceeded the task time limit.')
    expect(rendered).not.toMatch(/SCORES|PROCESS|COMPONENT|undefined/u)
  })

  it('describes the restricted workspace when candidate bash is disabled', () => {
    const sections: Array<{ name: string; text: string }> = []
    const context = {
      tools: { register() {} },
      systemPrompt: { section(value: { name: string; text: string }) { sections.push(value) } },
    } as unknown as Context
    mountMetaCapabilityTools(context, vi.fn(), { shellEnabled: false })
    expect(sections[0]?.text).not.toContain('sandboxed bash')
    expect(sections[0]?.text).not.toMatch(/use [^.!?;\n]*bash/iu)
    expect(sections[0]?.text).toContain('Bash is unavailable')
    expect(sections[0]?.text).toContain('host absolute paths')
  })

  it('defaults legacy callers to the restricted workspace guide', () => {
    const sections: Array<{ name: string; text: string }> = []
    const context = {
      tools: { register() {} },
      systemPrompt: { section(value: { name: string; text: string }) { sections.push(value) } },
    } as unknown as Context
    mountMetaCapabilityTools(context, vi.fn())
    expect(sections[0]?.text).not.toMatch(/use [^.!?;\n]*bash/iu)
    expect(sections[0]?.text).toContain('Bash is unavailable')
  })

  it('rejects identity and operation fields on metadata-only finalization', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({ accepted: true }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call, { shellEnabled: true })
    const submit = tools.find(tool => tool.name === 'finalize_candidate')!
    const concludeTurn = vi.fn()
    await expect(submit.execute({
      roundId: 'round-1', rationale: 'fix failure', evidenceRefs: ['run-1'], expectedOutcome: 'pass',
    }, { agent: { id: 'meta-1' }, signal: new AbortController().signal, concludeTurn } as never))
      .rejects.toThrow(/unknown field.*roundId/iu)
    expect(call).not.toHaveBeenCalled()
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('accepts metadata-only finalization and concludes only after host acceptance', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({ accepted: true }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call, { shellEnabled: true })
    const submit = tools.find(tool => tool.name === 'finalize_candidate')!
    const finalization = { rationale: 'fix failure', evidenceRefs: ['run-1'], expectedOutcome: 'pass', semanticTargets: ['context', 'routing'] }
    const concludeTurn = vi.fn()
    await submit.execute(finalization, {
      agent: { id: 'meta-1' },
      signal: new AbortController().signal,
      concludeTurn,
    } as never)
    expect(call).toHaveBeenCalledWith(
      'meta-1',
      'candidate.finalize',
      finalization,
      expect.any(AbortSignal),
    )
    expect(concludeTurn).toHaveBeenCalledOnce()
  })

  it('keeps the Meta turn open when finalization returns a recoverable action', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({
      accepted: false,
      recoverable: true,
      code: 'MISSING_BASELINE_DIAGNOSIS',
      nextAction: { tool: 'trajectory_query', arguments: { refs: ['run-1'] } },
    }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call, { shellEnabled: true })
    const submit = tools.find(tool => tool.name === 'finalize_candidate')!
    const concludeTurn = vi.fn()
    await expect(submit.execute({
      rationale: 'fix failure', evidenceRefs: ['run-1'], expectedOutcome: 'pass',
    }, { agent: { id: 'meta-1' }, signal: new AbortController().signal, concludeTurn } as never))
      .resolves.toMatchObject({ accepted: false, recoverable: true })
    expect(concludeTurn).not.toHaveBeenCalled()
  })
})
