import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { documentedHarnessCandidate, documentedSkillCandidate } from '../helpers/documented-skill-candidate.js'

it.each(['skill', 'full harness'])('loads the documented %s with real DSH tools and resource loaders', async layout => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear skill loader ')))
  const ctx = new Context()
  try {
    const files = await (layout === 'skill' ? documentedSkillCandidate() : documentedHarnessCandidate())
    expect(Object.keys(files).sort()).toEqual(layout === 'skill' ? [
      'skills/verify-change/SKILL.md',
    ] : [
      'plugins/action-verifier.js', 'plugins/check-summary.js', 'plugins/policy.js', 'plugins/post-action.js', 'plugins/pre-action.js',
      'plugins/prompt-pack.js', 'plugins/task-context.js', 'plugins/workflow-guidance.js',
      'preset/agent.cordis.yml', 'prompts/verification.md', 'skills/verify-change/SKILL.md',
      'workflows/diagnose-and-verify.md',
    ])
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await symlink(resolve(import.meta.dirname, '../../node_modules'), join(root, 'node_modules'), 'dir')
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    expect(process.cwd()).not.toBe(root)
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    // The native skill tool declares agents but does not call the agent factory.
    ctx.provide('agents', {} as never)
    await ctx.plugin(toolSkill)
    await ctx.plugin(skillFilesystem, { providerName: 'filesystem', includeDefaultRoots: false,
      customSkillDirs: [join(root, 'skills')] })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    if (layout === 'full harness') await ctx.loader.create({ name: 'cordis:include', config: { path: './preset/agent.cordis.yml' } })
    await ctx.loader.await()

    const catalog = await ctx.skills.list({ cwd: process.cwd() })
    expect(catalog).toEqual([expect.objectContaining({ name: 'verify-change', provider: 'filesystem' })])
    const skill = await ctx.skills.get('verify-change', { cwd: process.cwd() })
    expect(skill?.resourceBase).toEqual({ kind: 'directory', path: join(root, 'skills/verify-change') })
    const result = await ctx.tools.execute({
      name: 'skill', arguments: { name: 'verify-change' },
      callId: CallId('load-documented-skill'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ name: 'verify-change', provider: 'filesystem', content: skill?.content })
    expect(result.content).toEqual([expect.objectContaining({
      type: 'text', text: expect.stringContaining('Treat zero selected tests as no verification.'),
    })])
    if (layout === 'full harness') {
      const prompt = renderPrompt(await ctx.systemPrompt.assemble())
      expect(prompt).toContain('Inspect the task environment before changing it.')
      expect(prompt).toContain('## Verification policy')
      expect(prompt).toContain('## Diagnose and verify workflow')
      let executions = 0
      ctx.tools.register(defineTool({
        name: 'bash', description: 'Return fixture output without running a shell.',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async ({ command }) => {
          executions += 1
          return command === 'pytest -q' ? 'no tests ran' : 'token sk-1234567890123456'
        },
      }))
      const run = (command: string) => ctx.tools.execute({
        name: 'bash', arguments: { command },
        callId: CallId(`hook-${executions}`), signal: new AbortController().signal,
      })
      expect((await run('git reset --hard')).isError).toBe(true)
      expect(executions).toBe(0)
      const redacted = await run('echo token')
      expect(redacted.isError).toBe(false)
      expect(redacted.content).toEqual([{ type: 'text', text: 'token [redacted]' }])
      const verified = await run('pytest -q')
      expect(verified.isError).toBe(true)
      expect(JSON.stringify(verified.content)).toContain('did not exercise any tests')
      expect(executions).toBe(2)
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
