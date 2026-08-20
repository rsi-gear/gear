import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { NotebookRuntime } from './runtime.js'
import type { SessionRole } from '../types.js'

function renderResult(stdout: string, stderr: string, result: string | undefined): string {
  return [stdout, stderr, result].filter(value => value !== undefined && value.length > 0).join('\n') || '<no output>'
}

export function mountNotebookTool(
  agentCtx: Context,
  runtime: NotebookRuntime,
  role: SessionRole,
  fallbackCwd: string,
): void {
  agentCtx.systemPrompt.section({
    name: `tool:ipython-input:${role}`,
    order: 106,
    text: 'The IPython namespace persists for this session. Host APIs are role-scoped; an unavailable API fails instead of widening authority.',
  })
  agentCtx.tools.register(defineTool({
    name: 'ipython_input',
    description: 'Execute Python in this session\'s persistent IPython namespace.',
    parameters: {
      code: { type: 'string', required: true, description: 'Python/IPython code to execute.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          executionCount: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ipython_input requires an agent session')
      const result = await runtime.execute({
        sessionId: String(exec.agent.id),
        cwd: exec.agent.session.header.cwd ?? fallbackCwd,
        role,
        code: args.code,
        signal: exec.signal,
      })
      if (result.concludesTurn === true) exec.concludeTurn()
      return { text: renderResult(result.stdout, result.stderr, result.result), executionCount: result.executionCount }
    },
  }))
}
