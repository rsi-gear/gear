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
      'submit_refinement_proposal',
    ])
    expect(sections[0]?.text).toContain('diagnostics for every failed baseline run')
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

  it('rejects guessed proposal operation fields before calling the capability', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({ accepted: true }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call)
    const submit = tools.find(tool => tool.name === 'submit_refinement_proposal')!
    const concludeTurn = vi.fn()
    const exec = {
      agent: { id: 'meta-1' },
      signal: new AbortController().signal,
      concludeTurn,
    } as never
    await expect(submit.execute({
      roundId: 'round-1',
      mutation: {
        parentRef: 'a'.repeat(40),
        parentDigest: `sha256:${'b'.repeat(64)}`,
        target: 'context',
        ops: [{ type: 'patch', path: 'plugins/policy.js', unifiedDiff: 'guessed field', expectedDigest: `sha256:${'c'.repeat(64)}` }],
        rationale: 'fix failure',
        evidenceRefs: ['run-1'],
        expectedOutcome: 'pass',
      },
    }, exec)).rejects.toThrow(/invalid arguments/iu)
    expect(call).not.toHaveBeenCalled()
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('accepts the exact proposal schema and concludes only after host acceptance', async () => {
    const tools: ToolDefinition[] = []
    const call = vi.fn(async () => ({ accepted: true }))
    const context = {
      tools: { register(definition: ToolDefinition) { tools.push(definition) } },
      systemPrompt: { section() {} },
    } as unknown as Context
    mountMetaCapabilityTools(context, call)
    const submit = tools.find(tool => tool.name === 'submit_refinement_proposal')!
    const mutation = {
      parentRef: 'a'.repeat(40),
      parentDigest: `sha256:${'b'.repeat(64)}`,
      target: 'context',
      ops: [{
        type: 'patch',
        path: 'plugins/policy.js',
        patch: '--- a/plugins/policy.js\n+++ b/plugins/policy.js\n',
        expectedDigest: `sha256:${'c'.repeat(64)}`,
      }],
      rationale: 'fix failure',
      evidenceRefs: ['run-1'],
      expectedOutcome: 'pass',
    }
    const concludeTurn = vi.fn()
    await submit.execute({ roundId: 'round-1', mutation }, {
      agent: { id: 'meta-1' },
      signal: new AbortController().signal,
      concludeTurn,
    } as never)
    expect(call).toHaveBeenCalledWith(
      'meta-1',
      'submit_refinement_proposal',
      { roundId: 'round-1', mutation },
      expect.any(AbortSignal),
    )
    expect(concludeTurn).toHaveBeenCalledOnce()
  })
})
