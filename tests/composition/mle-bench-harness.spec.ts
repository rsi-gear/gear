import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'

it('loads the analysis guidance and skill while preserving ordinary Agent tools', async () => {
  const root = resolve(import.meta.dirname, '../../examples/mle-bench/harness')
  const ctx = new Context()
  try {
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(skillFilesystem, {
      providerName: 'filesystem', includeDefaultRoots: false, customSkillDirs: [resolve(root, 'skills')],
    })
    ctx.tools.register(defineTool({
      name: 'bash', description: 'Existing terminal tool',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async ({ command }) => command,
    }))
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: './preset/agent.cordis.yml' } })
    await ctx.loader.await()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Complete the task in this session')
    expect(prompt).not.toMatch(/task_inspect|rollout_finish|build_pipeline/)
    expect(await ctx.skills.get('data-analysis', { cwd: root })).toMatchObject({
      content: expect.stringContaining('Use normal sklearn estimators'),
    })
    const result = await ctx.tools.execute({ name: 'bash', arguments: { command: 'python train.py' },
      callId: CallId('ordinary-training'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.value).toBe('python train.py')
  } finally {
    await ctx.fiber.dispose()
  }
})
