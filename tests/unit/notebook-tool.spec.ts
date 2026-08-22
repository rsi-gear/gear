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
})
