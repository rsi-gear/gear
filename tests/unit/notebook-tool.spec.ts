import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mountMetaCapabilityTools, renderNotebookResult } from '../../src/notebook/tool.js'

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
    mountMetaCapabilityTools(context, call)
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
    expect(sections[0]?.text).toContain('failure bundle for every failed baseline run')
    expect(sections[0]?.text).toContain('accepted=false and recoverable=true')
    expect(sections[0]?.text).toContain('TRAJECTORY_EVIDENCE_UNAVAILABLE')
    const trajectory = tools.find(tool => tool.name === 'trajectory_query')!
    await trajectory.execute({ refs: ['run_1'], offset: 0 }, {
      agent: { id: 'meta-1' },
      signal: new AbortController().signal,
    } as never)
    expect(call).toHaveBeenCalledWith(
      'meta-1',
      'trajectory.query',
      { refs: ['run_1'], offset: 0 },
      expect.any(AbortSignal),
    )
  })

  it('rejects identity and operation fields on metadata-only finalization', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({ accepted: true }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call)
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
    mountMetaCapabilityTools(context, call)
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
      nextAction: { tool: 'trajectory_query', arguments: { refs: ['run-1'], view: 'bundle' } },
    }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call)
    const submit = tools.find(tool => tool.name === 'finalize_candidate')!
    const concludeTurn = vi.fn()
    await expect(submit.execute({
      rationale: 'fix failure', evidenceRefs: ['run-1'], expectedOutcome: 'pass',
    }, { agent: { id: 'meta-1' }, signal: new AbortController().signal, concludeTurn } as never))
      .resolves.toMatchObject({ accepted: false, recoverable: true })
    expect(concludeTurn).not.toHaveBeenCalled()
  })
})
